import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openStore, type NewTask } from "../src/store.js";

// 同 src/store.ts：vitest 的 vite resolver 会剥掉 "node:" 前缀导致加载失败，用 createRequire 绕过。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> };
    close(): void;
  };
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "afex-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function newTask(p: Partial<NewTask> = {}): NewTask {
  return {
    id: "task_test_000001", prompt: "do it", project_path: "/tmp", executor: "claude",
    profile: "minimax-3", timeout_sec: 60, log_path: join(dir, "task_test_000001.jsonl"),
    role: "worker", created_at: 1000, ...p,
  };
}

describe("store", () => {
  it("creates and gets a task", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    const t = s.getTask("task_test_000001");
    expect(t?.status).toBe("queued");
    expect(t?.rounds).toBe(1);
    expect(t?.files_changed).toEqual([]);
  });

  it("claimToRunning: queued→running sets started_at+pid", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    expect(s.claimToRunning("task_test_000001", 4242)).toBe(true);
    const t = s.getTask("task_test_000001")!;
    expect(t.status).toBe("running");
    expect(t.started_at).toBeGreaterThan(0);
    expect(t.pid).toBe(4242);
  });

  it("transition is atomic: only from expected statuses", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    expect(s.transition("task_test_000001", ["running"], "completed", { result: "done", ended_at: 2000 })).toBe(false);
    expect(s.transition("task_test_000001", ["queued", "running"], "cancelled", { ended_at: 2000 })).toBe(true);
    expect(s.transition("task_test_000001", ["cancelled"], "completed", {})).toBe(false);
  });

  it("claimToRunning on cancelled task fails (防竞态)", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    s.transition("task_test_000001", ["queued"], "cancelled", { ended_at: 1500 });
    expect(s.claimToRunning("task_test_000001", 1)).toBe(false);
  });

  it("patch updates non-status fields; files_changed round-trips as array", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask());
    s.patch("task_test_000001", { progress: "Editing a.ts", files_changed: ["/x/a.ts", "/x/b.ts"], session_id: "sid-1" });
    const t = s.getTask("task_test_000001")!;
    expect(t.progress).toBe("Editing a.ts");
    expect(t.files_changed).toEqual(["/x/a.ts", "/x/b.ts"]);
    expect(t.session_id).toBe("sid-1");
  });

  it("listActive returns only queued/running/needs_input", () => {
    const s = openStore(join(dir, "t.db"));
    s.createTask(newTask({ id: "task_a" }));
    s.createTask(newTask({ id: "task_b" }));
    s.createTask(newTask({ id: "task_c" }));
    s.transition("task_a", ["queued"], "completed", { ended_at: 1 });
    s.transition("task_b", ["queued"], "failed", { error: "x", ended_at: 1 });
    expect(s.listActive().map((t) => t.id).sort()).toEqual(["task_c"]);
  });

  // 下面两条钉的是同一个不变量：**静止态必须能被一个没有写权限的读者读到**。
  // 背景（2026-10-16 实测）：WAL 库在最后一个连接 close 后会删掉 -wal/-shm，此后只读连接必须自己
  // 建 wal-index（写操作）才能读；Trae shell sandbox 是 filesystem.default="read_only"，于是
  // 「任务已完成但调度方读不到状态」。换成 TRUNCATE 后静止态没有 -wal/-shm，只读沙箱天然可读。
  it("uses a rollback journal: resting state has no -wal/-shm", () => {
    const dbFile = join(dir, "t.db");
    const s = openStore(dbFile);
    s.createTask(newTask());
    s.close();

    const raw = new DatabaseSync(dbFile, { readOnly: true });
    const mode = raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    raw.close();

    // 只读连接报 'delete' 本身就是结论：journal_mode 里**只有 WAL 是持久化在库头的**，
    // 其余模式是连接级设置 —— 只读连接改不了 PRAGMA，于是看到默认的 delete。
    // 若库头仍是 WAL，这里必然报 'wal' —— 那正是只读沙箱读不开的库。
    expect(mode.journal_mode).not.toBe("wal");
    // 静止态允许留 0 字节的 -journal（TRUNCATE 的正常形态，非热日志不需回滚），但不许有 -wal/-shm。
    expect(readdirSync(dir).filter((f) => f === "t.db-wal" || f === "t.db-shm")).toEqual([]);
  });

  it("a write-denied reader still reads the db (read-only sandbox)", () => {
    const dbFile = join(dir, "t.db");
    const s = openStore(dbFile);
    s.createTask(newTask());
    s.close();

    chmodSync(dir, 0o555); // 沙箱：读放行、写拒绝
    try {
      const raw = new DatabaseSync(dbFile, { readOnly: true });
      const row = raw.prepare("SELECT count(*) AS c FROM tasks").get();
      raw.close();
      expect(Number(row.c)).toBe(1);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});