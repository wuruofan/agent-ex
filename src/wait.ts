import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openReadonlyStore } from "./store.js";
// 别顶层 import "node:sqlite"：vitest 的 vite resolver 会剥掉前缀（Failed to load url sqlite），
// 与 src/store.ts:4-8 同一约定；tests/wait.test.ts 同理走 createRequire。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface TaskRow {
  id: string; status: string; project_path: string | null; log_path: string;
  files_changed: string | null; started_at: number | null; ended_at: number | null;
  error: string | null; question: string | null; timeout_sec: number;
}

export const SELECT_TASK =
  "SELECT id, status, project_path, log_path, files_changed, started_at, ended_at, error, question, timeout_sec " +
  "FROM tasks WHERE id = ?";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const ACTIONABLE = new Set(["needs_input"]);
export { TERMINAL };

/**
 * 源库及其附属文件的签名（大小 + mtime）。
 *
 * ⚠️ 必须覆盖 db + -wal + -journal **整组**：只签主库时，写者往 -wal 追加数据
 * （WAL 模式）主库 mtime 根本不变 ⇒ 永远判不新鲜 ⇒ 等待会盯着一份冻结快照
 * （这正是 D1）。老实现只签了 db + wal 两个文件。
 */
export function sourceSig(dbPath: string): string {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-journal`]
    .map((f) => {
      try {
        const s = statSync(f);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return "gone";
      }
    })
    .join("|");
}

export class TaskReader {
  private _dbSource: "direct" | "copy" = "direct";   // 不能标 readonly：read() 里会降级成 copy
  get dbSource(): "direct" | "copy" { return this._dbSource; }
  private db: DatabaseSync | null = null;
  private copyDir: string | null = null;
  private copiedSig: string | null = null;

  constructor(private readonly dbPath: string, private readonly copyDirBase: string) {}

  /** 只读打开并做一次真实读：wal-index 不可用要在这一步就抛出来（否则错误会伪装成"任务不存在"）。 */
  private openAndProbe(makePath: () => string): DatabaseSync {
    const d = openReadonlyStore(makePath());
    try {
      d.prepare(SELECT_TASK).get("__probe__");
    } catch (e) {
      d.close();          // 探测失败必须关：否则长跑 + 反复重建副本会一路漏句柄
      throw e;
    }
    return d;
  }

  /**
   * 降级副本：把 db(+wal)(+journal) 整组复制到可写目录。
   *
   * ⚠️ 逐文件复制**不是快照**：若在「拷主库 → 写者提交 → 拷 `-journal`」之间命中提交，
   * 会拿到半写主库 + 缺失 journal，SQLite 无从回滚 ⇒ 读到撕裂页（malformed 或静默返回旧行）。
   * 所以**复制前后各取一次源签名**：不一致就抛，由 read() 的 `attempt < 2` 重拷；
   * 两次都不一致 ⇒ 走 db_unreadable，**别硬报成功**（这是本次新增机制带来的窗口，不是老实现遗留）。
   * 返回的 sig 是复制完成时的源状态，供下一轮判新鲜。
   */
  private copyForRead(): { dstDb: string; sig: string } {
    const before = sourceSig(this.dbPath);
    if (!this.copyDir) {
      mkdirSync(this.copyDirBase, { recursive: true });
      this.copyDir = mkdtempSync(join(this.copyDirBase, "agent-ex-wait-"));
    }
    const dstDb = join(this.copyDir, "tasks.db");
    rmSync(`${dstDb}-shm`, { force: true });   // 上一轮连接留下的 wal-index 会让 SQLite 拿旧索引读新拷的主库
    for (const suffix of ["", "-wal", "-journal"]) {
      const src = `${this.dbPath}${suffix}`;
      const dst = `${dstDb}${suffix}`;
      if (existsSync(src)) copyFileSync(src, dst);
      else rmSync(dst, { force: true });   // 源侧已 checkpoint 时不能把过期帧留在副本里
    }
    const after = sourceSig(this.dbPath);
    if (before !== after) throw new Error("source database changed while copying (torn snapshot)");
    return { dstDb, sig: after };
  }

  /**
   * 取一行。返回 null = 库可读但没有这行；抛异常 = 库不可读（环境问题）。
   *
   * copy 模式的关键：**每次调用都重新比对源签名**，变了就重拷整组并重开连接
   * ⇒ 等待能看到源库的最新状态（D1 修复）。
   */
  read(taskId: string): TaskRow | null {
    const sig = sourceSig(this.dbPath);
    if (this.db && this._dbSource === "copy" && sig !== this.copiedSig) {
      // 源库变了 ⇒ 重建副本并重开连接（否则读的是冻结快照）
      try { this.db.close(); } catch { /* 已关 */ }
      this.db = null;
      this.copiedSig = null;
    }
    if (!this.db) {
      try {
        this.db = this.openAndProbe(() => this.dbPath);
        this._dbSource = "direct";
        this.copiedSig = null;
      } catch (directErr) {
        let copyErr: unknown = directErr;
        let opened: DatabaseSync | null = null;
        let copySig: string | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const copied = this.copyForRead();
            opened = this.openAndProbe(() => copied.dstDb);
            copySig = copied.sig;
            copyErr = directErr;
            break;
          } catch (e) {
            copyErr = e;
          }
        }
        if (!opened) {
          throw new Error(
            `cannot open ${this.dbPath}: ${(directErr as Error).message}; ` +
            `the copy fallback failed too: ${(copyErr as Error).message}`,
          );
        }
        this.db = opened;
        this._dbSource = "copy";
        this.copiedSig = copySig;
      }
    }
    const row = this.db.prepare(SELECT_TASK).get(taskId) as unknown as TaskRow | undefined;
    return row ?? null;
  }

  close(): void {
    try { this.db?.close(); } catch { /* 已关 */ }
    this.db = null;
    if (this.copyDir) {
      try { rmSync(this.copyDir, { recursive: true, force: true }); } catch { /* best effort */ }
      this.copyDir = null;
    }
  }
}
