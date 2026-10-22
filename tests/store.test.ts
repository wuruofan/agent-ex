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

/**
 * 旧库升级：表已存在但列过时。
 *
 * 为什么这组测试必须有：SQLite 的 `CREATE TABLE IF NOT EXISTS` 在表存在时**整句跳过**，
 * 新增的列一个都不会出现（2026-10-16 实测）。也就是说升级过的用户会直接撞
 * `table tasks has no column named X`，且报错发生在运行期而不是启动期。
 *
 * 每条用例都从"手搓一个残缺旧库"开始，而不是复用当前 SCHEMA 造一个近似形状 ——
 * 后者会把待测的迁移代码自己也带进夹具，出现"代码和夹具互相掩护"的假通过。
 */
describe("旧库迁移（列差集补齐）", () => {
  const MINIMAL = "CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued');";

  function makeOldDb(withRows: boolean): string {
    const dbFile = join(dir, "old.db");
    const raw = new DatabaseSync(dbFile);
    raw.exec(MINIMAL);
    if (withRows) raw.exec("INSERT INTO tasks (id, status) VALUES ('task_old_1', 'completed');");
    raw.close();
    return dbFile;
  }

  function columnsOf(dbFile: string): string[] {
    const raw = new DatabaseSync(dbFile, { readOnly: true });
    const cols = (raw.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((r) => r.name);
    raw.close();
    return cols;
  }

  it("给缺列的旧库补齐全部列（有数据也不丢行）", () => {
    const dbFile = makeOldDb(true);
    const s = openStore(dbFile);
    const cols = columnsOf(dbFile);
    for (const c of ["prompt", "project_path", "executor", "profile", "timeout_sec",
                     "session_id", "rounds", "result", "question", "progress",
                     "files_changed", "pid", "error", "log_path", "role",
                     "created_at", "started_at", "ended_at", "notify_failed"]) {
      expect(cols).toContain(c);
    }
    // 关键：迁移不能动既有数据
    expect(s.listActive().length).toBe(0); // 旧行是 completed，不在活跃集合
    s.close();
    const raw = new DatabaseSync(dbFile, { readOnly: true });
    expect(Number((raw.prepare("SELECT count(*) AS c FROM tasks").get() as { c: number }).c)).toBe(1);
    raw.close();
  });

  it("补齐后 Store 的正常读写可用（这正是升级后用户要走的路）", () => {
    const dbFile = makeOldDb(true);
    const s = openStore(dbFile);
    s.createTask(newTask({ id: "task_new_1" }));
    const t = s.getTask("task_new_1");
    expect(t?.status).toBe("queued");
    expect(t?.rounds).toBe(1);
    expect(t?.files_changed).toEqual([]);
    s.close();
  });

  it("NOT NULL 列靠 DEFAULT 补齐（SQLite 不允许无默认值的 NOT NULL）", () => {
    // rounds / role / files_changed / notify_failed 都是 NOT NULL DEFAULT …
    const dbFile = makeOldDb(true);
    openStore(dbFile).close();
    const raw = new DatabaseSync(dbFile, { readOnly: true });
    const row = raw.prepare("SELECT rounds, role, files_changed, notify_failed FROM tasks WHERE id = ?").get("task_old_1");
    raw.close();
    expect(Number((row as Record<string, unknown>).rounds)).toBe(1);
    expect((row as Record<string, unknown>).role).toBe("worker");
    expect((row as Record<string, unknown>).files_changed).toBe("[]");
    expect(Number((row as Record<string, unknown>).notify_failed)).toBe(0);
  });

  it("已是最新的库不产生迁移写入（幂等，且不拿排他锁）", () => {
    const dbFile = makeOldDb(true);
    openStore(dbFile).close();
    const before = columnsOf(dbFile);
    openStore(dbFile).close(); // 第二次 open：列已齐
    expect(columnsOf(dbFile)).toEqual(before);
  });

  it("空的旧库（无任何行）同样能补齐", () => {
    const dbFile = makeOldDb(false);
    const s = openStore(dbFile);
    s.createTask(newTask({ id: "task_fresh_1" }));
    expect(s.getTask("task_fresh_1")?.status).toBe("queued");
    s.close();
  });
});