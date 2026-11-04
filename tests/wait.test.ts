import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
// vitest 的 vite resolver 会剥掉 "node:sqlite" 前缀（Failed to load url sqlite）——
// 与 src/store.ts:4-8 / tests/store.test.ts 同一约定，别改成顶层 import
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskReader, sourceSig } from "../src/wait.js";

const SCHEMA = `CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, project_path TEXT,
  log_path TEXT, files_changed TEXT, started_at INTEGER, ended_at INTEGER, error TEXT,
  question TEXT, timeout_sec INTEGER)`;

/** 遗留 WAL 库：干净关闭后目录里只剩 tasks.db（无 -wal/-shm）⇒ 只读读者无法建 shm ⇒ 直读必失败。 */
function legacyWalHome(status = "running") {
  const root = mkdtempSync(join(tmpdir(), "af-wait-db-"));
  const home = join(root, "home");
  const copy = join(root, "copy");
  mkdirSync(home);
  mkdirSync(copy);
  const dbPath = join(home, "tasks.db");
  const d = new DatabaseSync(dbPath);
  d.exec(SCHEMA);
  d.exec("PRAGMA journal_mode=WAL");
  d.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("task_x", status, "/tmp/p", join(root, "r.jsonl"), "[]", 1000, null, null, null, 3600);
  d.close();
  return { root, home, copy, dbPath };
}

describe("sourceSig", () => {
  it("覆盖 db + -wal + -journal 三个文件", () => {
    const { dbPath, root } = legacyWalHome();
    const sig = sourceSig(dbPath);
    expect(sig.split("|")).toHaveLength(3);
    expect(sig).toContain("gone");          // -wal / -journal 不存在时记 gone
    rmSync(root, { recursive: true, force: true });
  });
});

describe("TaskReader", () => {
  it("直读成功时不产生副本", () => {
    const { root, home, copy, dbPath } = legacyWalHome("completed");
    const r = new TaskReader(dbPath, copy);
    expect(r.read("task_x")?.status).toBe("completed");
    expect(r.dbSource).toBe("direct");
    r.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("直读失败时降级为副本，并把 dbSource 标成 copy", () => {
    const { root, home, copy, dbPath } = legacyWalHome("completed");
    chmodSync(home, 0o555);            // 沙箱：目录禁写 ⇒ 只读读者建不了 -shm
    const r = new TaskReader(dbPath, copy);
    expect(r.read("task_x")?.status).toBe("completed");
    expect(r.dbSource).toBe("copy");
    r.close();
    chmodSync(home, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it("D1：副本模式下，源库变了之后 read() 必须看到新状态（老实现会一直返回旧值）", () => {
    const { root, home, copy, dbPath } = legacyWalHome("running");
    chmodSync(home, 0o555);
    const r = new TaskReader(dbPath, copy);
    expect(r.read("task_x")?.status).toBe("running");     // 第一次读：走 copy 路径
    expect(r.dbSource).toBe("copy");

    // 模拟"写者在沙箱外推进任务"：放开写权限 → 改源库 → 立刻恢复只读
    chmodSync(home, 0o755);
    const w = new DatabaseSync(dbPath);
    w.prepare("UPDATE tasks SET status='completed', ended_at=? WHERE id='task_x'")
      .run(Math.floor(Date.now() / 1000));
    w.close();
    // ⚠️ 必须恢复 0555 再读：不恢复的话直读会成功、dbSource 悄悄变回 "direct"，
    // 这条用例就退化成"直读恢复"、**根本没走重拷副本那段**（写完 -wal 会被 checkpoint 删掉）。
    chmodSync(home, 0o555);

    expect(r.read("task_x")?.status).toBe("completed");    // ← D1 修复点：老实现在这里仍是 "running"
    expect(r.dbSource).toBe("copy");                       // 证明这次确实走了"重建副本"而不是直读
    r.close();
    chmodSync(home, 0o755);   // home 还是 0555，先恢复再清 root，否则清理删不动目录内容
    rmSync(root, { recursive: true, force: true });
  });

  it("两处都读不了时抛异常（上层映射成 db_unreadable，绝不伪装成 not_found）", () => {
    const { root, home, copy, dbPath } = legacyWalHome("running");
    chmodSync(home, 0o555);
    chmodSync(copy, 0o555);
    const r = new TaskReader(dbPath, copy);
    expect(() => r.read("task_x")).toThrow();
    r.close();
    chmodSync(home, 0o755);
    chmodSync(copy, 0o755);
    rmSync(root, { recursive: true, force: true });
  });
});
