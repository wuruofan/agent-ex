import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// === Mock spawnDetachedRunner 避免真 spawn；断言调用参数 ===
vi.mock("../src/spawn-runner.js", () => ({
  spawnDetachedRunner: vi.fn((_taskId: string) => ({
    child: { pid: 99999, unref: () => {}, on: () => {} },
  })),
  runnerCommand: () => ({ cmd: "ignored", args: (id: string) => [id] }),
}));

import { openStore } from "../src/store.js";
import { submit } from "../src/tools/submit.js";
import { status } from "../src/tools/status.js";
import { cancel } from "../src/tools/cancel.js";
import { spawnDetachedRunner } from "../src/spawn-runner.js";

const mockedSpawn = vi.mocked(spawnDetachedRunner);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "afex-"));
  process.env.AGENT_EX_HOME = home;
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executors: { fake: { bin: process.execPath, extra_flags: ["ignored"] } },
    profiles: { fake: { executor: "fake", env: {} } },
    notify: { feishu_webhook_url: "https://example.invalid/hook", dry_run: true },
    defaults: { profile: "fake", timeout_sec: 60 },
  }));
  mockedSpawn.mockClear();
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENT_EX_HOME; });

describe("submit", () => {
  it("creates queued task with generated id and spawns runner (pid recorded)", async () => {
    const r = await submit({ prompt: "hello", project_path: home });
    expect(r).toMatchObject({ status: "queued", rounds: 1 });
    const id = (r as { task_id: string }).task_id;
    const t = openStore(join(home, "tasks.db")).getTask(id)!;
    expect(t.pid).toBe(99999);
    expect(t.log_path).toContain(join(home, "logs"));
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(mockedSpawn).toHaveBeenCalledWith(id, expect.any(Function));
  });
  it("rejects unknown profile", async () => {
    expect(await submit({ prompt: "x", profile: "ghost", project_path: home })).toEqual({ error: 'unknown profile "ghost"' });
  });
  it("rejects bad project_path", async () => {
    expect(await submit({ prompt: "x", project_path: "/no/such/dir/xx" })).toEqual({ error: 'project_path "/no/such/dir/xx" not accessible' });
  });
  it("rejects empty prompt", async () => {
    expect(await submit({ prompt: "  ", project_path: home })).toEqual({ error: "prompt is required" });
  });
  it("rejects bad timeout_sec", async () => {
    expect(await submit({ prompt: "x", project_path: home, timeout_sec: -1 })).toEqual({ error: "timeout_sec must be a positive integer" });
    expect(await submit({ prompt: "x", project_path: home, timeout_sec: 1.5 })).toEqual({ error: "timeout_sec must be a positive integer" });
  });
  it("continue_of rejects non-needs_input task", async () => {
    const r = await submit({ prompt: "x", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await submit({ prompt: "answer", continue_of: id })).toEqual({ error: `task ${id} is "queued", expected "needs_input"` });
  });
  it("continue_of returns same task_id with rounds+1", async () => {
    const store = openStore(join(home, "tasks.db"));
    const id = "task_x";
    store.createTask({
      id, prompt: "p", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", `${id}.jsonl`), role: "worker",
      created_at: Math.floor(Date.now() / 1000),
    });
    store.transition(id, ["queued"], "needs_input", { question: "q" });
    const r = await submit({ prompt: "answer", continue_of: id });
    expect(r).toEqual({ task_id: id, status: "running", rounds: 2 });
    expect(store.getTask(id)?.rounds).toBe(2);
    expect(store.getTask(id)?.status).toBe("running");
  });
  it("warns when same project_path already has an active task", async () => {
    const first = await submit({ prompt: "a", project_path: home });
    const firstId = (first as { task_id: string }).task_id;
    const second = await submit({ prompt: "b", project_path: home });
    expect(second).toMatchObject({ status: "queued", rounds: 1 });
    const w = (second as { warning?: string }).warning;
    expect(w).toContain(firstId);
    expect(w).toContain("queued");
  });
  it("no warning when the project_path has no other active task", async () => {
    const other = mkdtempSync(join(tmpdir(), "afex-other-"));
    try {
      const r = await submit({ prompt: "a", project_path: other });
      expect(r).not.toHaveProperty("warning");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
  it("returns error and marks task failed when async spawn fails (P1-3)", async () => {
    // 让 mock 模拟"spawn 失败"：onSpawnError 立即被调用，传错信息
    mockedSpawn.mockImplementationOnce((_id: string, onSpawnError?: (e: Error) => void) => {
      onSpawnError?.(new Error("ENOENT: runner script gone"));
      return { child: { pid: null, unref: () => {}, on: () => {} } };
    });
    const r = await submit({ prompt: "hello", project_path: home });
    expect(r).toMatchObject({ error: expect.stringMatching(/failed to spawn runner/) });
    // 任务已经 transition 到 failed，不在活跃列表
    const store = openStore(join(home, "tasks.db"));
    expect(store.listActive().length).toBe(0);
  });
});

describe("status", () => {
  it("no-arg returns empty array when no active tasks", () => {
    expect(status({})).toEqual([]);
  });
  it("single task returns question when needs_input", () => {
    const store = openStore(join(home, "tasks.db"));
    store.createTask({
      id: "task_q", prompt: "x", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", "q.jsonl"), role: "worker", created_at: 1,
    });
    store.claimToRunning("task_q", process.pid);
    store.transition("task_q", ["running"], "needs_input", { question: "which db?" });
    const v = status({ task_id: "task_q" }) as { question?: string; status: string };
    expect(v.status).toBe("needs_input");
    expect(v.question).toBe("which db?");
  });
  it("returns error for unknown task_id", () => {
    expect(status({ task_id: "nope" })).toEqual({ error: "task nope not found" });
  });
  it("exposes timeout_sec in status view", () => {
    const store = openStore(join(home, "tasks.db"));
    store.createTask({
      id: "task_to", prompt: "x", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 120, log_path: join(home, "logs", "to.jsonl"), role: "worker", created_at: 1,
    });
    const v = status({ task_id: "task_to" }) as { timeout_sec?: number };
    expect(v.timeout_sec).toBe(120);
  });
  describe("include_finished", () => {
    // 宿主的兜底查询要在会话重启/上下文压缩后认回「上次派的任务」——
    // 那通常已经结束，而 listActive() 只列进行中的任务。这是这个开关存在的唯一理由。
    const seedFinished = (store: ReturnType<typeof openStore>, id: string, created_at: number) => {
      store.createTask({
        id, prompt: "x", project_path: home, executor: "fake", profile: "fake",
        timeout_sec: 60, log_path: join(home, "logs", `${id}.jsonl`), role: "worker", created_at,
      });
      store.claimToRunning(id, process.pid);
      store.transition(id, ["running"], "completed", { result: "done" });
    };
    it("no-arg still hides finished tasks (back-compat)", () => {
      const store = openStore(join(home, "tasks.db"));
      seedFinished(store, "task_done", 1);
      expect(status({})).toEqual([]);
    });
    it("include_finished lists finished tasks with their status", () => {
      const store = openStore(join(home, "tasks.db"));
      seedFinished(store, "task_done", 1);
      const v = status({ include_finished: true }) as { task_id: string; status: string }[];
      expect(v.map((t) => t.task_id)).toContain("task_done");
      expect(v.find((t) => t.task_id === "task_done")?.status).toBe("completed");
    });
    it("include_finished orders by created_at desc (newest first)", () => {
      const store = openStore(join(home, "tasks.db"));
      seedFinished(store, "task_old", 100);
      seedFinished(store, "task_new", 200);
      const v = status({ include_finished: true }) as { task_id: string }[];
      const ids = v.map((t) => t.task_id);
      expect(ids.indexOf("task_new")).toBeLessThan(ids.indexOf("task_old"));
    });
    it("limit caps the returned list", () => {
      const store = openStore(join(home, "tasks.db"));
      seedFinished(store, "task_a", 100);
      seedFinished(store, "task_b", 200);
      seedFinished(store, "task_c", 300);
      const v = status({ include_finished: true, limit: 2 }) as { task_id: string }[];
      // 只断言 length 会让「返回任意 2 条」「顺序反了」都通过；必须钉住最新两条的 id 与顺序。
      expect(v.map((t) => t.task_id)).toEqual(["task_c", "task_b"]);
    });
    it("active tasks are still included alongside finished ones", () => {
      const store = openStore(join(home, "tasks.db"));
      seedFinished(store, "task_done", 1);
      store.createTask({
        id: "task_live", prompt: "x", project_path: home, executor: "fake", profile: "fake",
        timeout_sec: 60, log_path: join(home, "logs", "live.jsonl"), role: "worker", created_at: 2,
      });
      const v = status({ include_finished: true }) as { task_id: string }[];
      const ids = v.map((t) => t.task_id);
      expect(ids).toContain("task_done");
      expect(ids).toContain("task_live");
    });
    // 认回「我上次派的那个任务」靠的就是这两个字段：库里一直有 project_path，
    // 但此前 status 不返回它 —— skill 的认领规则写了却执行不了。
    it("returns project_path and started_at so the host can identify its own task", () => {
      const store = openStore(join(home, "tasks.db"));
      seedFinished(store, "task_done", 1);
      const v = status({ include_finished: true }) as {
        task_id: string; project_path: string; started_at: number | null; created_at: number;
      }[];
      const t = v.find((x) => x.task_id === "task_done")!;
      expect(t.project_path).toBe(home);
      expect(t.started_at).not.toBeNull();
      expect(t.created_at).toBe(1);
    });
    it("started_at is null for a task that has not started yet", () => {
      const store = openStore(join(home, "tasks.db"));
      store.createTask({
        id: "task_queued", prompt: "x", project_path: home, executor: "fake", profile: "fake",
        timeout_sec: 60, log_path: join(home, "logs", "q.jsonl"), role: "worker", created_at: 5,
      });
      const v = status({ include_finished: true }) as {
        task_id: string; started_at: number | null;
      }[];
      expect(v.find((x) => x.task_id === "task_queued")?.started_at).toBeNull();
    });
  });
});

describe("cancel", () => {
  it("cancels needs_input task (no live process) and returns idempotent on second call", () => {
    const store = openStore(join(home, "tasks.db"));
    store.createTask({
      id: "task_c1", prompt: "x", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", "c1.jsonl"), role: "worker", created_at: 1,
    });
    store.claimToRunning("task_c1", process.pid);
    store.transition("task_c1", ["running"], "needs_input", { question: "q" });
    expect(cancel({ task_id: "task_c1" })).toEqual({ task_id: "task_c1", status: "cancelled" });
    expect(cancel({ task_id: "task_c1" })).toEqual({ task_id: "task_c1", status: "cancelled" });
  });
  it("returns error for unknown task", () => {
    expect(cancel({ task_id: "nope" })).toEqual({ error: "task nope not found" });
  });
  it("returns error for missing task_id", () => {
    expect(cancel({ task_id: "" })).toEqual({ error: "task_id is required" });
  });
});

describe("setStartedAt (test helper)", () => {
  beforeEach(() => { process.env.AGENT_EX_TEST_MODE = "1"; });
  afterEach(() => { delete process.env.AGENT_EX_TEST_MODE; });
  it("rewrites started_at when test mode enabled", async () => {
    const { setStartedAt } = await import("../src/tools/test-helpers.js");
    const store = openStore(join(home, "tasks.db"));
    store.createTask({
      id: "task_sa", prompt: "x", project_path: home, executor: "fake", profile: "fake",
      timeout_sec: 60, log_path: join(home, "logs", "sa.jsonl"), role: "worker", created_at: 1,
    });
    store.claimToRunning("task_sa", process.pid);
    expect(setStartedAt({ task_id: "task_sa", started_at: 1234 })).toEqual({ task_id: "task_sa", started_at: 1234 });
    const t = store.getTask("task_sa");
    expect(t?.started_at).toBe(1234);
  });
  it("rejects unknown task_id", async () => {
    const { setStartedAt } = await import("../src/tools/test-helpers.js");
    expect(setStartedAt({ task_id: "nope", started_at: 1 })).toEqual({ error: "task nope not found" });
  });
  it("rejects bad started_at", async () => {
    const { setStartedAt } = await import("../src/tools/test-helpers.js");
    expect(setStartedAt({ task_id: "x", started_at: NaN })).toEqual({ error: "started_at must be a finite number (unix seconds)" });
  });
  it("refuses when test mode disabled", async () => {
    delete process.env.AGENT_EX_TEST_MODE;
    const { setStartedAt } = await import("../src/tools/test-helpers.js");
    expect(setStartedAt({ task_id: "x", started_at: 1 })).toEqual({ error: "AGENT_EX_TEST_MODE not enabled" });
  });
});