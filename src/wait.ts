import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openReadonlyStore } from "./store.js";
import { agentExHome } from "./paths.js";
import { extractReport, outlineOf, REPORT_TEXT_MAX, REPORT_HEAD_MAX, OUTLINE_MAX, OUTLINE_MAX_HEADS } from "./report.js";

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

// ---------------------------------------------------------------------------
// runWait：参数解析 → 只读轮询 → 按状态产出 stdout 字段 → 退出码
// ---------------------------------------------------------------------------

const DEFAULT_MAX_WAIT_SEC = 7200;
const DEFAULT_INTERVAL_SEC = 20;

const USAGE =
  "usage: agent-ex wait <task_id> [--interval-sec N] [--max-wait-sec N] " +
  "[--report-out PATH] [--copy-dir PATH] [--once] [--verbose] [--no-digest] [--home PATH]";

interface Options {
  taskId: string;
  intervalSec: number;
  maxWaitSec: number | null;   // null = 从任务推导；0 = 永不放弃
  reportOut: string | null;
  copyDir: string;
  once: boolean;
  verbose: boolean;
  noDigest: boolean;
  home: string;
}

export interface WaitResult { stdout: string; stderr: string; exitCode: number }

export interface WaitDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  writeStderr?: (s: string) => void;
  installSignals?: boolean;
}

interface ParseResult { opts?: Options; error?: string }

/** 解析失败返回 error（⇒ exit 4）。必须 return，不能抛——server.ts 的 CLI 兜底会把异常映射成 1。
 *  刻意**不**处理 `-h/--help`：`runWait` 在调它之前就返回了（同一份 argv），这里再分支是死代码。 */
function parseArgs(argv: string[]): ParseResult {
  const opts: Options = {
    taskId: "", intervalSec: DEFAULT_INTERVAL_SEC, maxWaitSec: null, reportOut: null,
    copyDir: tmpdir(), once: false, verbose: false, noDigest: false,
    home: agentExHome(),   // 单一真相源：src/paths.ts（目录名来自 HOME_DIR_NAME），别在这里硬编码 ".agent-ex"
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = (): { value: string } | { error: string } => {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} requires a value` };
      return { value: v };
    };
    if (a === "--interval-sec") {
      const r = takeValue(); if ("error" in r) return r; opts.intervalSec = Number(r.value);
    } else if (a === "--max-wait-sec") {
      const r = takeValue(); if ("error" in r) return r; opts.maxWaitSec = Number(r.value);
    } else if (a === "--report-out") {
      const r = takeValue(); if ("error" in r) return r; opts.reportOut = r.value;
    } else if (a === "--copy-dir") {
      const r = takeValue(); if ("error" in r) return r; opts.copyDir = r.value;
    } else if (a === "--home") {
      const r = takeValue(); if ("error" in r) return r; opts.home = r.value;
    } else if (a === "--once") {
      opts.once = true;
    } else if (a === "--verbose") {
      opts.verbose = true;
    } else if (a === "--no-digest") {
      opts.noDigest = true;
    } else if (a.startsWith("-")) {
      // 注意：`-h/--help` 到不了这里——runWait 在调 parseArgs 之前就返回了
      return { error: `unknown option ${a}` };
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) return { error: "exactly one task_id is required" };
  if (!Number.isFinite(opts.intervalSec) || opts.intervalSec <= 0) return { error: "--interval-sec must be > 0" };
  if (opts.maxWaitSec !== null && (!Number.isFinite(opts.maxWaitSec) || opts.maxWaitSec < 0)) {
    return { error: "--max-wait-sec must be >= 0" };
  }
  opts.taskId = positional[0];
  return { opts };
}

/** 预算推导：3 次 attempt 各吃满 timeout_sec + 30s/60s 退避 + 120s 收尾余量。
 *  **只看单轮上界**，不按 rounds 缩放（spec C3）。 */
export function deriveMaxWait(timeoutSec: number): number {
  const t = Number(timeoutSec);
  if (!Number.isFinite(t) || t <= 0) return DEFAULT_MAX_WAIT_SEC;
  return t * 3 + 90 + 120;
}

interface EmitCtx {
  opts: Options;
  dbSource: "direct" | "copy";
  effectiveMaxWait: number;   // 已推导的预算（0 = 永不放弃 ⇒ 输出 "never"）
  now: () => number;
}

const oneLine = (s: string, max = 300) => String(s).replace(/\s+/g, " ").trim().slice(0, max);
// 默认 300 沿用迁移前 skill 脚本（0.2.x）的口径——ERROR/QUESTION 的截断值改了金标准 diff 就会红

function emit(
  row: TaskRow, wait: "terminal" | "needs_input" | "timeout",
  ctx: EmitCtx, stdout: string[], note: (s: string) => void,
): void {
  stdout.push(`TASK_ID=${row.id}`, `STATUS=${row.status}`, `WAIT=${wait}`);
  stdout.push(`MAX_WAIT_SEC=${ctx.effectiveMaxWait === 0 ? "never" : String(ctx.effectiveMaxWait)}`);
  if (ctx.dbSource === "copy") stdout.push("DB_SOURCE=copy");

  const end = row.ended_at ?? Math.floor(ctx.now() / 1000);
  if (row.started_at) stdout.push(`ELAPSED_SEC=${end - row.started_at}`);
  if (row.project_path) stdout.push(`PROJECT_PATH=${row.project_path}`);

  let filesChanged = 0;
  try { filesChanged = JSON.parse(row.files_changed ?? "[]").length; } catch { /* keep 0 */ }
  stdout.push(`FILES_CHANGED=${filesChanged}`);
  if (row.error) stdout.push(`ERROR=${oneLine(row.error)}`);
  if (row.question) stdout.push(`QUESTION=${oneLine(row.question)}`);

  const isTerminal = wait === "terminal";
  const hasReport = isTerminal || wait === "needs_input";
  if (!hasReport) return;   // timeout：没有 LOG_PATH / REPORT_*，不写报告文件

  const text = extractReport(row.log_path);
  const reportPath = ctx.opts.reportOut ?? join(tmpdir(), `${row.id}.report.md`);
  // 写失败仍要输出 REPORT_PATH（老脚本行为，保住逐行 diff 一致）⇒ 该路径**可能不存在**：
  // 契约里已写明"读之前先 test -f"，别在这里改成"写失败就不打这一行"。
  try { writeFileSync(reportPath, text); } catch (e) {
    note(`agent-ex wait: could not write report: ${(e as Error).message}\n`);
  }
  stdout.push(`LOG_PATH=${row.log_path}`, `REPORT_PATH=${reportPath}`, `REPORT_CHARS=${text.length}`);

  if (isTerminal && !ctx.opts.noDigest && text.length > 0) {
    const heads = outlineOf(text);
    if (heads.length) stdout.push(`REPORT_OUTLINE=${oneLine(heads.join(" | "), OUTLINE_MAX)}`);
    if (text.length <= REPORT_TEXT_MAX) stdout.push(`REPORT_TEXT=${oneLine(text, REPORT_TEXT_MAX)}`);
    else stdout.push(`REPORT_HEAD=${oneLine(text.slice(0, REPORT_HEAD_MAX), REPORT_HEAD_MAX)}`);
  }
  if (isTerminal && text.length === 0) {
    note(
      "agent-ex wait: no assistant text block found; read LOG_PATH directly " +
      "(the run may have died before producing a report, or used an unknown event shape)\n",
    );
  }
}

export async function runWait(argv: string[], deps: WaitDeps = {}): Promise<WaitResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  // --help：exit 0，兼作版本探针（老 CLI 走 unknown command 分支 exit 2）
  if (argv.includes("-h") || argv.includes("--help")) {
    return { stdout: `${USAGE}\n`, stderr: "", exitCode: 0 };
  }

  const parsed = parseArgs(argv);
  if (!parsed.opts) {
    return { stdout: "", stderr: `agent-ex wait: ${parsed.error ?? "usage error"}\n${USAGE}\n`, exitCode: 4 };
  }
  const opts = parsed.opts;

  const stdout: string[] = [];
  const stderr: string[] = [];
  // 人类信息（copy 降级说明 / --verbose 进度 / 预算超限）必须**边跑边出**：
  // 全攒到返回才 flush 的话，CLI 下要等整个等待窗口结束才能看到一句进度，
  // 外部观察者（SIGINT 测试）也没有任何带内信号可等 ⇒ 死等到超时。
  // CLI 注入 writeStderr ⇒ 实时落盘且返回的 stderr 为空（cli.ts 不会再打一遍）；
  // 单测不注入 ⇒ 攒进数组，断言 r.stderr 的口径不变。
  const note = deps.writeStderr ?? ((s: string) => stderr.push(s));
  const reader = new TaskReader(join(opts.home, "tasks.db"), opts.copyDir);
  // 信号（spec §3.2）：**只在 deps.installSignals 为真时**安装——由 CLI 边界显式开启；
  // 单测默认 false。不设开关就是全局副作用：同进程反复调用会累积 listener（>10 触发
  // MaxListeners 警告），测试进程收到 SIGINT 还会被 handler 的 process.exit 直接杀掉。
  // 语义：只结束等待进程自己（exit 130/143、清理副本），**绝不**向任务/runner 发任何信号。
  const onSignal = (sig: "SIGINT" | "SIGTERM") => {
    try { reader.close(); } catch { /* 尚未开过连接 */ }
    process.stderr.write(`agent-ex wait: ${sig} received — exiting (copy dir cleaned)\n`);
    process.exit(sig === "SIGINT" ? 130 : 143);   // 跳过 finally ⇒ close 必须在这里手动做
  };
  if (deps.installSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  const t0 = now();
  let effectiveMaxWait: number | null = null;
  let copyNoteDone = false;   // copy 降级的 stderr 说明只发一次

  try {
    for (;;) {
      let row: TaskRow | null;
      try {
        row = reader.read(opts.taskId);
      } catch (e) {
        // 库读不了 ≠ 任务不存在：分开报，绝不伪装成 not_found
        note(`agent-ex wait: ${(e as Error).message}\n`);
        note(
          "agent-ex wait: this is an environment problem (sandbox / file permissions), not evidence about the task. " +
          "In a read-only sandbox, retry with --copy-dir <a writable dir>, or run the wait outside the sandbox.\n",
        );
        stdout.push(`TASK_ID=${opts.taskId}`, "STATUS=unknown", "WAIT=db_unreadable");
        return { stdout: stdout.join("\n") + "\n", stderr: stderr.join(""), exitCode: 6 };
      }

      if (row === null) {
        stdout.push(`TASK_ID=${opts.taskId}`, "STATUS=unknown", "WAIT=not_found");
        return { stdout: stdout.join("\n") + "\n", stderr: stderr.join(""), exitCode: 3 };
      }

      if (effectiveMaxWait === null) {
        effectiveMaxWait = opts.maxWaitSec ?? deriveMaxWait(row.timeout_sec);
      }
      const ctx: EmitCtx = { opts, dbSource: reader.dbSource, effectiveMaxWait, now };
      // 首次进 copy 模式时向 stderr 说明原因（验收表要求；文案沿用迁移前 skill 脚本的措辞）
      if (reader.dbSource === "copy" && !copyNoteDone) {
        copyNoteDone = true;
        note(
          `agent-ex wait: cannot read ${join(opts.home, "tasks.db")} in place ` +
          `— reading a copy under ${opts.copyDir}; pass --copy-dir to choose a different writable directory\n`,
        );
      }
      if (opts.verbose) {
        note(`[agent-ex wait] ${new Date(now()).toISOString()} status=${row.status}\n`);
      }

      if (TERMINAL.has(row.status)) {
        emit(row, "terminal", ctx, stdout, note);
        return { stdout: stdout.join("\n") + "\n", stderr: stderr.join(""), exitCode: 0 };
      }
      // needs_input 不是终态，但**可行动**：现在醒，别把整个等待窗口耗光
      if (ACTIONABLE.has(row.status)) {
        emit(row, "needs_input", ctx, stdout, note);
        return { stdout: stdout.join("\n") + "\n", stderr: stderr.join(""), exitCode: 5 };
      }
      // --once 只查一次；但 needs_input 的判断在上面已经走过了
      if (opts.once) {
        emit(row, "timeout", ctx, stdout, note);
        return { stdout: stdout.join("\n") + "\n", stderr: stderr.join(""), exitCode: 2 };
      }

      const waited = (now() - t0) / 1000;
      if (effectiveMaxWait > 0 && waited >= effectiveMaxWait) {
        // ⚠️ 措辞：**不**说"runner 可能死了"。预算是**单轮上界**（3×timeout_sec+90+120），
        // 过了它只说明"这一轮该结束了"，不能推断 runner 的死活——可能只是 timeout_sec 配得偏小，
        // 或任务正卡在 needs_input 前的某个环节。推断死活会把环境问题指向错误的方向
        // （见 docs/designs/2026-10-30-wait-as-cli-subcommand.md §1.2）。
        note(
          `agent-ex wait: task still ${row.status} after ${Math.round(waited)}s — past this round's ` +
          `upper bound (${effectiveMaxWait}s, derived from timeout_sec=${row.timeout_sec}); ` +
          `pass --max-wait-sec to widen the window.\n`,
        );
        emit(row, "timeout", ctx, stdout, note);
        return { stdout: stdout.join("\n") + "\n", stderr: stderr.join(""), exitCode: 2 };
      }

      await sleep(opts.intervalSec * 1000);
    }
  } finally {
    // 开关开着就必须卸载：同一进程反复调用 runWait（测试、容器内复跑）会把 listener 越积越多
    if (deps.installSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    reader.close();
  }
}
