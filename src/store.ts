import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

// vitest 2.1.x 的 vite resolver 会把 "node:sqlite" 的前缀剥掉，导致 "Failed to load url sqlite"。
// 用 createRequire 绕过 vite 转译；运行时无差别。
const require = createRequire(import.meta.url);

/**
 * 懒加载 node:sqlite。
 *
 * ⚠️ 为什么不能放在模块顶层：`require("node:sqlite")` 会让 Node 立刻打印
 * "ExperimentalWarning: SQLite is an experimental feature"——而这条警告是**异步**触发的，
 * 会插进 readline 的第一个提示符中间，把交互式 init 的界面搅乱：
 *
 *   Executor to configure (claude/opencode) [claude]: (node:71345) ExperimentalWarning: SQLite is an experimental feature…
 *
 * 根因是 `server.ts` 顶层静态 import 了 submit.js → store.js ⇒ 任何子命令（包括根本不碰
 * 数据库的 `init` / `doctor` / `config`）都在启动时加载了 SQLite。实测 init 全程
 * 一个字节的数据库都没写，那条警告纯属噪音。
 *
 * 改成"真正要开库时才 require"：警告只在真的要开库时出现，而不是每次启动都出现。
 */
type DatabaseSyncCtor = new (path: string) => DatabaseSync;
let ctor: DatabaseSyncCtor | null = null;
function databaseSyncCtor(): DatabaseSyncCtor {
  if (!ctor) {
    ctor = (require("node:sqlite") as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
  }
  return ctor;
}

export type TaskStatus = "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];

/** 字段名与 DB 列一致（snake_case），避免映射层。 */
export interface Task {
  id: string;
  status: TaskStatus;
  prompt: string;
  project_path: string;
  executor: string;
  profile: string;
  timeout_sec: number;
  session_id: string | null;
  rounds: number;
  result: string | null;
  question: string | null;
  progress: string | null;
  files_changed: string[];
  pid: number | null;
  error: string | null;
  log_path: string;
  role: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  notify_failed: boolean;
}

export type NewTask = Pick<Task, "id" | "prompt" | "project_path" | "executor" | "profile" | "timeout_sec" | "log_path" | "role" | "created_at">;
export type TaskPatch = Partial<Omit<Task, "id" | "status" | "created_at">>;

/**
 * 目标列定义 —— 建表与迁移共用同一份真相。
 *
 * 为什么不能只留 `CREATE TABLE IF NOT EXISTS`：表已存在时整句被跳过，**新增的列一个都不会出现**
 * （2026-10-16 实测：旧库只有 id/status，跑新版 SCHEMA 后 `note`/`score` 列仍然不存在，
 * 写它们时报 `table tasks has no column named ...`）。也就是说 `IF NOT EXISTS` 只防"表不存在"，
 * 不防"表存在但列过时"—— 而后者才是升级时真正会发生的事。
 *
 * 由此把列定义抽成数据，迁移时按 `pragma table_info` 求差集、用 `ALTER TABLE ADD COLUMN` 补齐。
 * 注意 SQLite 的三条限制（实测）：
 *   - 不能加 `PRIMARY KEY` 列 → 主键恒为 `id`，本就不该改；
 *   - 不能加无默认值的 `NOT NULL` 列（表非空时报错）→ 所以每个 NOT NULL 列都必须带 DEFAULT；
 *   - `ADD COLUMN` 不能改类型/约束，想改只能重建表 —— 见 docs/diagnostics 记录的取舍。
 */
const COLUMNS: Record<string, string> = {
  id: "id TEXT PRIMARY KEY",
  status: "status TEXT NOT NULL DEFAULT 'queued'",
  prompt: "prompt TEXT NOT NULL DEFAULT ''",
  project_path: "project_path TEXT NOT NULL DEFAULT ''",
  executor: "executor TEXT NOT NULL DEFAULT ''",
  profile: "profile TEXT NOT NULL DEFAULT ''",
  timeout_sec: "timeout_sec INTEGER NOT NULL DEFAULT 0",
  session_id: "session_id TEXT",
  rounds: "rounds INTEGER NOT NULL DEFAULT 1",
  result: "result TEXT",
  question: "question TEXT",
  progress: "progress TEXT",
  files_changed: "files_changed TEXT NOT NULL DEFAULT '[]'",
  pid: "pid INTEGER",
  error: "error TEXT",
  log_path: "log_path TEXT NOT NULL DEFAULT ''",
  role: "role TEXT NOT NULL DEFAULT 'worker'",
  created_at: "created_at INTEGER NOT NULL DEFAULT 0",
  started_at: "started_at INTEGER",
  ended_at: "ended_at INTEGER",
  notify_failed: "notify_failed INTEGER NOT NULL DEFAULT 0",
};

const TABLE = "tasks";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
${Object.values(COLUMNS).map((c) => `  ${c}`).join(",\n")}
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON ${TABLE}(status);`;

export class Store {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new (databaseSyncCtor())(dbPath);
    // busy_timeout 必须先设：下面的 journal_mode 切换要拿独占锁，撞上其他连接时靠它重试
    // （后设的话切换会直接 SQLITE_BUSY 失败，且没有任何等待）。
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.useRollbackJournal();
    this.db.exec(SCHEMA);
    this.migrateColumns();
  }
  /**
   * 补齐旧库缺失的列。
   *
   * 逐列一条 `ALTER TABLE ... ADD COLUMN`：SQLite 的 `ADD COLUMN` 只支持"追加一列"这种最小变更，
   * 恰好匹配"新版本只增列不改列"的演进方式；一条一执行，某列被占用/改过类型时只跳过它，
   * 不至于让整次迁移回滚（缺列会在后续查询处明确报 `no such column`，不会静默丢数据）。
   *
   * 只在真有缺口时才动表 —— 绝大多数 open 是 no-op，不产生写、不拿排他锁。
   * 刻意不做"重建表以改列类型/约束"：那要先搬 45 行数据、且失败窗口更大，
   * 收益只在真要改已有列时才出现（届时再说，别预先付这个复杂度）。
   */
  private migrateColumns(): void {
    const present = new Set(
      (this.db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (present.size === 0) return; // 表刚由 SCHEMA 建好，无需迁移
    const missing = Object.keys(COLUMNS).filter((c) => !present.has(c));
    if (missing.length === 0) return;
    for (const col of missing) {
      try {
        this.db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMNS[col]}`);
        console.error(`[store] migrated: added column "${col}" to ${TABLE}`);
      } catch (e) {
        console.error(`[store] could not add column "${col}": ${(e as Error).message}`);
      }
    }
  }
  /**
   * 刻意**不用 WAL**（2026-10-16 实测后改）。
   *
   * WAL 库对"只读打开者"要写权限 —— 不是写数据，而是 WAL recovery：最后一个连接 clean close 时
   * `-wal` 与 `-shm` 双双被删，此后任何只读连接都必须自建 wal-index（可能还要重写 `-wal`）才能读。
   * 在只读文件系统里（Trae shell sandbox：`filesystem.default="read_only"`）这一步必然失败，报
   * `unable to open database file` —— 于是「没有活写者」这个**静止态**下，沙箱里任何读都拿不到任务状态。
   * 实测对照：同一份库，`-shm` 有效时禁写整个目录也能正常读；`-shm` 缺失时立刻失败。
   *
   * TRUNCATE 让静止态只剩 `tasks.db` 一个文件（外加一个 0 字节 `-journal`，非热日志不需回滚），
   * 只读沙箱天然可读，且不依赖"恰好有写者活着"。
   * 代价：失去 WAL 的「一写多读」并发，写者之间互斥。本场景写入都是单条短 UPDATE + 已有
   * busy_timeout=5000 兜底，代价可忽略（见 docs/diagnostics/2026-10-16-readonly-sandbox.md）。
   *
   * 切换需要独占锁 ⇒ 其他连接正在读写时会失败。**绝不能因此阻断工具调用**（不能让一次 status
   * 把 server 打死），故容忍失败、保持当前模式继续跑，下一个空闲窗口再切。
   *
   * ⚠️ 只有 WAL 是**持久化**的（写在库头），DELETE/TRUNCATE/PERSIST/… 都是连接级设置。所以：
   *   - 一次成功切换就永久摆脱 WAL 文件格式，之后每个连接在构造时各自设 TRUNCATE；
   *   - 反过来说，**别的客户端**（sqlite3 CLI、临时脚本）不改 PRAGMA 时用的是 DELETE —— 没问题，
   *     两者同属 rollback journal 格式，静止态同样不留 `-wal`/`-shm`。
   * 真正要守住的是「库头不能再被置回 WAL」，这也是 store.test.ts 里那条断言的落点。
   */
  private useRollbackJournal(): void {
    try {
      const r = this.db.prepare("PRAGMA journal_mode=TRUNCATE").get() as { journal_mode?: string } | undefined;
      if (r?.journal_mode !== "truncate") {
        console.error(
          `[store] journal_mode is "${r?.journal_mode}", not "truncate" (another connection holds the db); ` +
            `retrying on a later open — restart the MCP server to convert while idle`,
        );
      }
    } catch (e) {
      console.error(`[store] journal_mode switch skipped: ${(e as Error).message}`);
    }
  }
  createTask(t: NewTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, prompt, project_path, executor, profile, timeout_sec, log_path, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(t.id, t.prompt, t.project_path, t.executor, t.profile, t.timeout_sec, t.log_path, t.role, t.created_at);
  }
  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }
  /** runner 启动时认领：queued|running → running（幂等刷新 pid；started_at 只记首次）。cancelled 后认领失败 → runner 直接退出。 */
  claimToRunning(id: string, pid: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `UPDATE tasks SET status='running', pid=?, started_at=COALESCE(started_at, ?) WHERE id=? AND status IN ('queued','running')`
      )
      .run(pid, now, id);
    return r.changes === 1;
  }
  /** 原子状态流转：仅当当前 status ∈ from 时更新为 to。返回是否成功。终态为吸收态，from 含终态直接拒绝。 */
  transition(id: string, from: TaskStatus[], to: TaskStatus, patch: TaskPatch = {}): boolean {
    if (from.length === 0) return false;
    if (from.some((s) => TERMINAL_STATUSES.includes(s))) return false;
    const [sql, args] = buildUpdate(patch, `status=?`, `id=? AND status IN (${from.map(() => "?").join(",")})`);
    const r = this.db.prepare(sql).run(...args, to, id, ...from);
    return r.changes === 1;
  }
  /** 非状态字段更新（progress/session_id/files_changed/result 等）。 */
  patch(id: string, patch: TaskPatch): void {
    if (Object.keys(patch).length === 0) return;
    const [sql, args] = buildUpdate(patch, "", `id=?`);
    this.db.prepare(sql).run(...args, id);
  }
  listActive(): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN ('queued','running','needs_input') ORDER BY created_at`)
      .all() as Record<string, unknown>[];
    return rows.map(fromRow);
  }
  close(): void {
    this.db.close();
  }
}

export function openStore(dbPath: string): Store {
  return new Store(dbPath);
}

function buildUpdate(patch: TaskPatch, setExtra: string, whereExtra: string): [string, (string | number | bigint | null)[]] {
  const sets: string[] = [];
  const args: (string | number | bigint | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k}=?`);
    if (k === "files_changed") args.push(JSON.stringify(v));
    else if (k === "notify_failed") args.push(v ? 1 : 0);
    else args.push(v as string | number | null);
  }
  if (setExtra) sets.push(setExtra);
  const where = whereExtra ? ` WHERE ${whereExtra}` : "";
  return [`UPDATE tasks SET ${sets.join(", ")}${where}`, args];
}

function fromRow(r: Record<string, unknown>): Task {
  return {
    ...(r as unknown as Task),
    files_changed: JSON.parse((r.files_changed as string) ?? "[]") as string[],
    notify_failed: Boolean(r.notify_failed),
  };
}