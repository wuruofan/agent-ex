# `agent-ex wait` CLI 子命令 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `skills/agent-ex-dispatch/scripts/wait-task.mjs` 的等待与报告提取能力收进产品，做成 `agent-ex wait <task_id>` 子命令，随 npm 包发布；skill 侧删除脚本，不再维护第二份实现。

**Architecture:** 新增 `src/report.ts`（纯函数：报告提取/outline/digest 阈值）与 `src/wait.ts`（`runWait(argv)`：参数解析 → 只读轮询 `tasks.db` → 按状态产出 stdout 字段 → 退出码）。只读路径**不复用 `Store` 类**（它的构造函数全是写/锁操作），改为 `src/store.ts` 里新增的 `openReadonlyStore()`；只读打开失败时降级为「复制 db(+wal) 到可写目录再读」，并**每轮按源签名重建副本**（修掉 D1：老实现盯着一份冻结快照，轮询期间看不到任何状态变化）。

**Tech Stack:** TypeScript（Node ≥ 22.5）、`node:sqlite`（`DatabaseSync`，只读连接）、vitest、tsx（dev 运行）。无新依赖。

**上游 spec：** [`docs/designs/2026-10-30-wait-as-cli-subcommand.md`](../designs/2026-10-30-wait-as-cli-subcommand.md) —— 本 plan 不重复 spec 的论证，只把它变成可执行的步骤。

**执行状态（2026-11-04 核对）**：Task 1–4 已实施并提交（`f7fcbd5` report → `3e09fee` reader/store → `b6bf945` 类型导入 → `f7d9b9e` runWait → `989a411` CLI 接线），
外加 `29f60a2`（顶层 import 懒加载，CLI 启动 6s→0.9s）与 `7c2fa17`（补 `--no-digest`/`--verbose`/`cancelled` 用例、超时文案对齐 spec、README 补 `agent-ex wait`）。
`tests/wait.test.ts` 现有 **42** 条用例（原计划的 43 条断言已按状态分组重写，数目不必对齐）。
**Task 5（版本提交 + publish）与 Task 6（skill 侧删脚本）尚未执行** —— Task 5 需要在电脑旁做（npm 登录 + publish），
Task 6 必须在 Task 5 之后（skill 不得先于包发布，否则新 skill 会调还不存在的 CLI）。

---

## 已定死的决策（spec 已定，plan 不得再改）

| # | 决策 | 依据 |
| :--- | :--- | :--- |
| C1 | **`report.ts` 自解析日志形状，不复用 executor 的 `parseEvent`** | `parseEvent` 服务 runner 的"最后一条消息"需求，与"找出报告"是两种需求；且与老脚本有三处语义差异（text+tool_use 丢文本 / 多块 join / 无 role 检查），复用要么补回差异、要么重写形状解析 ⇒ 净复杂度更高且行为会漂，直接顶到 §6.5 的金标准 diff |
| C2 | **`ELAPSED_SEC` 保名 + 定死语义，不改 DB、不改 `agent_ex_status`** | 改名会打破"逐行 diff 为空"的验收；改语义要动 `store.claimToRunning` 的 "started_at 只记首次" 不变量与 `tools/status.ts:29`，与"不顺手改 `agent_ex_status`"冲突 |
| C3 | **预算只看单轮上界**（`3×timeout_sec + 90 + 120`），**不**按 `rounds` 缩放 | 单次 wait 观察不到轮次推进（轮次推进必先显形为 `needs_input`，而 wait 在 `needs_input` 上 exit 5）；放大默认值会让 runner 真死时白等 5 倍 |
| C4 | **只读路径不复用 `Store` 类** | `Store` 构造函数 = `mkdirSync` + `busy_timeout` + `journal_mode` 切换 + `CREATE TABLE` + `ALTER TABLE` 迁移，全是写/锁操作，违反"绝不干扰 MCP server 与活着的 runner" |
| C5 | **copy 模式的源签名覆盖 `tasks.db` + `-wal` + `-journal` 整组** | 只签主库时，写者往 `-wal` 追加 ⇒ 永远判不新鲜 ⇒ 把 D1 原样种回去 |
| C6 | **`wait` 不加载 `.env`**、**绝不向任务或 runner 发信号** | wait 是观察者不是调度者；取消走 `agent_ex_cancel` |
| C7 | **`--help` exit 0**，兼作版本探针 | 老 CLI 收到 `agent-ex wait --help` 走 unknown command 分支 exit 2 ⇒ 新 0 / 老 2 可机器区分 |

---

## Global Constraints（每个 task 都隐含包含）

- **stdout 契约（逐状态，顺序即契约）**——实现必须与 spec §3.3 的表逐字一致：

  | WAIT | 字段顺序 |
  | :--- | :--- |
  | `terminal` | `TASK_ID` `STATUS` `WAIT` `MAX_WAIT_SEC` [`DB_SOURCE=copy`] [`ELAPSED_SEC`] [`PROJECT_PATH`] `FILES_CHANGED` [`ERROR`] [`QUESTION`] `LOG_PATH` `REPORT_PATH` `REPORT_CHARS` [`REPORT_OUTLINE`] [`REPORT_TEXT` \| `REPORT_HEAD`] |
  | `needs_input` | 同 `terminal`，但 digest 三件套（`REPORT_OUTLINE`/`REPORT_TEXT`/`REPORT_HEAD`）**全部不输出** |
  | `timeout` | 到 `FILES_CHANGED`（含可选 `ERROR`/`QUESTION`）为止，**无** `LOG_PATH`/`REPORT_*` |
  | `not_found` | `TASK_ID` `STATUS=unknown` `WAIT=not_found` —— **仅 3 行** |
  | `db_unreadable` | `TASK_ID` `STATUS=unknown` `WAIT=db_unreadable` —— **仅 3 行** |

- **退出码**：`terminal`=0 / `needs_input`=5 / `timeout`=2 / `not_found`=3 / `db_unreadable`=6 / **用法错=4**（必须 `return 4`，不得抛异常——`server.ts` 的 CLI 兜底会把异常映射成 1）/ **内部异常=1** / 信号=130·143（无 `WAIT=` 行，属表外）。
- **`MAX_WAIT_SEC` 在 `--max-wait-sec 0` 时输出字面量 `never`**（不是 `0`）。
- **digest 阈值**：`REPORT_TEXT` ≤1200 字符；否则 `REPORT_HEAD`=前 700 字符；`REPORT_OUTLINE`≤600 字符、≤20 个标题、`|` 分隔。
- **`ELAPSED_SEC` 语义** = `(ended_at ?? now) - started_at`；**终态行**含人工答复等待；**续跑后的 running 行
  卡在上一轮 finalize 的旧值不增长**（已知行为，公式不改——金标准要逐字一致，见 spec §3.3）。
- **stdout 只给机器可读的 `KEY=VALUE`**，不打印彩色/符号；人类信息一律 stderr。
- **stderr 允许有噪音**：每次开库必然有一条 `ExperimentalWarning: SQLite is an experimental feature` ⇒ **禁止写"stderr 只有一行"这类断言**。
- **用法错误与内部错误都要给出 stderr 说明**；任务相关错误（`not_found` / `db_unreadable`）的 stdout 保持上表形状
  （仅 `TASK_ID`/`STATUS`/`WAIT` 三行）；**用法错（exit 4）的 stdout 为空**（此时没有 task_id 可打）。
- **不改 MCP 工具面**：`tests/server-tools.test.ts` 的 6 工具断言不受影响，`scripts/smoke-stdio.mjs` 的 `PRODUCTION_TOOLS` 不动。
- **commit 纪律**：Conventional Commits，英文正文，**不加 AI trailer**；本 plan 内的 commit 直接执行，**`npm publish` 与 `git push` 是对外动作，执行前必须向用户确认**。
- **联动规则（AGENTS.md）**：新增 CLI 子命令 ⇒ 同步 `src/server.ts` 的 `USAGE`、`src/cli.ts` 的 usage 文案、README「命令行工具」章节；新增 `src/*.ts` ⇒ 在 AGENTS.md 的 project layout 登记。

---

## 文件地图（动手前先锁定）

| 文件 | 动作 | 职责 |
| :--- | :--- | :--- |
| `src/report.ts` | **新建** | 纯函数：`extractReport(logPath)` / `outlineOf(text)` / digest 阈值常量。**只做提取，不碰 DB** |
| `src/wait.ts` | **新建** | `runWait(argv, deps?)`：参数解析 → 只读轮询 → 按状态产出 stdout → 退出码；copy 降级与源签名刷新在这里 |
| `src/store.ts` | **修改** | 加 `openReadonlyStore(dbPath)` + 放宽 `DatabaseSyncCtor` 类型（多一个可选 options 参数）。**不动 `Store` 类** |
| `src/cli.ts` | **修改** | 加 `runWait` 入口（与 `runDoctor`/`runConfig`/`runProfile` 平级） |
| `src/server.ts` | **修改** | 加 `wait` 子命令分支（动态 import，**不** `loadEnvFile()`）+ `USAGE` 一行 |
| `tests/report.test.ts` | **新建** | report.ts 的单测 |
| `tests/wait.test.ts` | **新建** | wait.ts 的单测（43 条断言按状态重写 + D1 回归 + 新增项） |
| `skills/agent-ex-dispatch/scripts/wait-task.mjs` | **删除** | Task 6（与测试文件、exclude 同一个提交） |
| `skills/agent-ex-dispatch/scripts/wait-task.test.mjs` | **删除** | Task 6 |
| `vitest.config.ts` | **修改** | Task 6：移除 `exclude: ["skills/**/*.test.mjs"]` |
| `skills/agent-ex-dispatch/SKILL.md` | **修改** | Task 6：调用方式 / 命令发现 / Resources / python recipe / 过期文案 |
| `README.md` | **修改** | Task 6：CLI 表加一行 + 删「路线 A 无需 npm i -g」承诺 |
| `AGENTS.md` | **修改** | Task 6：project layout 登记两个新文件 |
| `scripts/install-skill.sh` | **修改** | Task 6：收尾提示加一行（`agent-ex wait` 是 CLI 子命令；exit 2 ⇒ 先 `npm link`） |

**不新增任何其它文件**（不建 `wait-db.ts`/`wait-cmd.ts` 之类）——熵已经够高了。

---

## Task 1: `src/report.ts` —— 报告提取（纯函数）

**Files:**
- Create: `src/report.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Consumes: 无（只吃日志文件路径与文本）
- Produces:
  ```ts
  export const REPORT_TEXT_MAX = 1200;   // 内联阈值
  export const REPORT_HEAD_MAX = 700;    // 长报告只给头部
  export const OUTLINE_MAX = 600;        // outline 总长上限
  export const OUTLINE_MAX_HEADS = 20;   // outline 标题数上限
  export function extractReport(logPath: string): string;  // 最长 assistant 文本块；文件读不到返回 ""
  export function outlineOf(text: string): string[];       // 章节标题数组
  ```
  Task 3 会用 `extractReport` + `outlineOf` + 四个阈值常量。

- [ ] **Step 1: 写失败测试（claude 形状 + role 过滤 + 最长块）**

  在 `tests/report.test.ts` 建文件：

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { extractReport, outlineOf, REPORT_TEXT_MAX } from "../src/report.js";

  let DIR: string;   // 不能模块顶层建一次再 afterEach 删：第一个用例后目录就没了，后续写日志全 ENOENT
  beforeEach(() => { DIR = mkdtempSync(join(tmpdir(), "af-report-")); });
  const log = (name: string, lines: string[]) => {
    const p = join(DIR, name);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  };
  const asst = (text: string) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const compact = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  describe("extractReport", () => {
    it("取最长的 assistant 文本块，而不是最后一块", () => {
      const p = log("a.jsonl", [asst("short"), asst("这是正文".repeat(200)), asst("尾块")]);
      expect(extractReport(p)).toBe("这是正文".repeat(200));
    });

    it("排除挂在 role=user 上的 compaction 摘要（摘要比正文长十倍也不取）", () => {
      const p = log("b.jsonl", [asst("真报告"), compact("摘要".repeat(3000))]);
      expect(extractReport(p)).toBe("真报告");
    });

    it("claude 形状：一条消息里的多个 text 块各算一块，取最长的那块", () => {
      const p = log("c.jsonl", [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
          { type: "text", text: "短" }, { type: "text", text: "长".repeat(50) }] } }),
      ]);
      expect(extractReport(p)).toBe("长".repeat(50));
    });

    it("opencode 形状：扁平 {type:text,text}", () => {
      const p = log("d.jsonl", [JSON.stringify({ type: "text", text: "oc 报告" })]);
      expect(extractReport(p)).toBe("oc 报告");
    });

    it("opencode 形状：part.text 兜底", () => {
      const p = log("e.jsonl", [JSON.stringify({ type: "text", part: { type: "text", text: "嵌套" } })]);
      expect(extractReport(p)).toBe("嵌套");
    });

    it("日志文件不存在时返回空串，不抛", () => {
      expect(extractReport(join(DIR, "nope.jsonl"))).toBe("");
    });

    it("坏 JSON 行被跳过，不影响其它行", () => {
      const p = log("f.jsonl", ["{not json", asst("好块")]);
      expect(extractReport(p)).toBe("好块");
    });
  });

  describe("outlineOf", () => {
    it("取 1-4 级标题", () => {
      expect(outlineOf("## 摘要\n正文\n### 验收\n0 fail\n##### 五级不算")).toEqual(["摘要", "验收"]);
    });

    it("最多 20 条", () => {
      const text = Array.from({ length: 30 }, (_, i) => `## H${i}`).join("\n");
      expect(outlineOf(text)).toHaveLength(20);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run tests/report.test.ts`
  Expected: FAIL —— `Failed to resolve import "../src/report.js"`（模块还不存在）。

- [ ] **Step 3: 写最小实现 `src/report.ts`**

  ```ts
  import { readFileSync } from "node:fs";

  export const REPORT_TEXT_MAX = 1200;
  export const REPORT_HEAD_MAX = 700;
  export const OUTLINE_MAX = 600;
  export const OUTLINE_MAX_HEADS = 20;

  /**
   * 一条日志行里所有 assistant 撰写的文本块（跨两种 executor 形状）。
   *
   *   claude    {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":…}]}}
   *   opencode  {"type":"text","text":…} 或 {"type":"text","part":{"text":…}}
   *
   * 两道过滤都不能少：type==="assistant" 排除 compaction 摘要（摘要挂在 role:"user" 上），
   * role==="assistant" 是第二道防线。取**最长块**而不是最后一块——长任务里最后一条常常只是一句收尾。
   */
  function assistantTexts(ev: any): string[] {
    if (ev?.type === "assistant") {
      const msg = ev.message;
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
      return msg.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text);
    }
    if (ev?.type === "text") {
      const text = typeof ev.text === "string" ? ev.text : (typeof ev.part?.text === "string" ? ev.part.text : null);
      return typeof text === "string" ? [text] : [];
    }
    return [];
  }

  export function extractReport(logPath: string): string {
    let raw: string;
    try {
      raw = readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
    let longest = "";
    for (const line of raw.split("\n")) {
      if (!line || line.charCodeAt(0) !== 0x7b /* { */) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      for (const text of assistantTexts(ev)) {
        if (text.length > longest.length) longest = text;
      }
    }
    return longest;
  }

  export function outlineOf(text: string): string[] {
    const heads: string[] = [];
    for (const raw of text.split("\n")) {
      const m = /^#{1,4}\s+(.+?)\s*$/.exec(raw.trim());
      if (!m) continue;
      heads.push(m[1]);
      if (heads.length >= OUTLINE_MAX_HEADS) break;
    }
    return heads;
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run: `npx vitest run tests/report.test.ts`
  Expected: PASS（9 tests）。阈值三分支（`REPORT_TEXT`/`REPORT_HEAD` 的选择）不在这里测——它属于 `emit`，见 Task 3。

- [ ] **Step 5: 类型检查**

  Run: `npm run typecheck`
  Expected: 无错误。

- [ ] **Step 6: 提交**

  ```bash
  git add src/report.ts tests/report.test.ts
  git commit -m "feat: add report extraction module for wait subcommand"
  ```

---

## Task 2: 只读库层 —— `openReadonlyStore` + copy 降级 + **D1 修复**

> 本 task 交付的是 D1 的修复。**D1 是老实现里已确认的缺陷**：只读降级副本是"冻结快照"，轮询期间看不到任何状态变化，还会给出错误诊断 "the runner likely died without finalizing"。

**Files:**
- Modify: `src/store.ts`（加 `openReadonlyStore` + 放宽 `DatabaseSyncCtor`）
- Create: `src/wait.ts`（本 task 只落 DB 访问层；轮询/输出在 Task 3）
- Test: `tests/wait.test.ts`（本 task 只放 D1 与降级相关用例）

**Interfaces:**
- Consumes: Task 1 的 `extractReport`（Task 3 用）
- Produces:
  ```ts
  // src/store.ts
  export function openReadonlyStore(dbPath: string): DatabaseSync;

  // src/wait.ts（本 task 落地，后续 task 扩展）
  export interface TaskRow {
    id: string; status: string; project_path: string | null; log_path: string;
    files_changed: string | null; started_at: number | null; ended_at: number | null;
    error: string | null; question: string | null; timeout_sec: number;
  }
  export const SELECT_TASK =
    "SELECT id, status, project_path, log_path, files_changed, started_at, ended_at, error, question, timeout_sec " +
    "FROM tasks WHERE id = ?";
  export function sourceSig(dbPath: string): string;   // db + -wal + -journal 的 (size,mtime) 组合
  export class TaskReader {
    constructor(dbPath: string, copyDir: string);
    read(taskId: string): TaskRow | null;   // null = 无此任务；抛错 = 库不可读
    readonly dbSource: "direct" | "copy";
    close(): void;
  }
  ```
  `TaskReader` 的契约（Task 3 直接用）：
  - `read()` 返回 `null` **只**表示"库读得开、但没有这行"；库读不开时**抛异常**（由上层映射成 `db_unreadable`/exit 6），绝不伪装成 `not_found`。
  - 走 copy 模式时，`read()` **每次都重新比对源签名**：签名变了就重拷整组并重开连接 ⇒ **这是 D1 的修复点**。
  - 每次复制**前后各取一次签名**，不一致就重拷（`attempt < 2`）；两次都不一致 ⇒ 抛（映射成 `db_unreadable`），
    别把撕裂页当成功（copy 是逐文件复制，不是快照）。

- [ ] **Step 1: 写失败测试（D1：copy 模式下必须看到源库的状态变化）**

  在 `tests/wait.test.ts` 建文件（Task 3 会继续往这个文件加用例）：

  ```ts
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
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run tests/wait.test.ts`
  Expected: FAIL —— `Failed to resolve import "../src/wait.js"`。

- [ ] **Step 3: `src/store.ts` 加 `openReadonlyStore`**

  把 `src/store.ts` 的类型别名（第 25 行）与构造函数放宽，并新增导出：

  ```ts
  // 放宽：DatabaseSync 真实签名接受 (path, options)，只读连接需要 options.readOnly
  type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
  ```

  在 `openStore` 旁边加：

  ```ts
  /**
   * 只读打开任务库。
   *
   * ⚠️ 为什么不用 Store 类：它的构造函数会 mkdir、设 busy_timeout、**切 journal_mode**、
   * CREATE TABLE、ALTER TABLE 补列 —— 全是写/锁操作。wait 的定义是"绝不干扰 MCP server
   * 与活着的 runner"，所以只读路径必须绕开它，只留一条 SELECT 能用的连接。
   *
   * 只读打开失败（沙箱禁写目录 ⇒ SQLite 建不了 -shm）由调用方降级为"复制到可写目录再读"。
   */
  export function openReadonlyStore(dbPath: string): DatabaseSync {
    return new (databaseSyncCtor())(dbPath, { readOnly: true });
  }
  ```

- [ ] **Step 4: `src/wait.ts` 落 DB 访问层**

  新建 `src/wait.ts`（本 task 只写下面这些；Task 3 再加 `runWait`）：

  ```ts
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
  ```

- [ ] **Step 5: 跑测试确认通过**

  Run: `npx vitest run tests/wait.test.ts`
  Expected: PASS（5 tests）——**尤其 D1 那条**：老实现会在这里拿到 `"running"` 而失败。

- [ ] **Step 6: 跑全量测试确认没弄坏别的**

  Run: `npm test`
  Expected: 全绿（skill 里的 `wait-task.test.mjs` 仍被 `vitest.config.ts` 的 exclude 挡着）。

- [ ] **Step 7: 类型检查**

  Run: `npm run typecheck`
  Expected: 无错误。

- [ ] **Step 8: 提交**

  ```bash
  git add src/store.ts src/wait.ts tests/wait.test.ts
  git commit -m "feat: add read-only task reader with copy fallback and freshness check"
  ```

---

## Task 3: `runWait` —— 轮询、输出、退出码

**Files:**
- Modify: `src/wait.ts`（加参数解析与 `runWait`）
- Modify: `tests/wait.test.ts`（补齐 43 条断言的按状态重写）

**Interfaces:**
- Consumes: Task 1 的 `extractReport` / `outlineOf` / 四个阈值常量；Task 2 的 `TaskReader` / `SELECT_TASK` / `TERMINAL` / `ACTIONABLE`
- Produces:
  ```ts
  export interface WaitResult { stdout: string; stderr: string; exitCode: number }
  export interface WaitDeps {
    sleep?: (ms: number) => Promise<void>;   // 测试注入
    now?: () => number;                      // 测试注入（毫秒）
    installSignals?: boolean;                // 仅 CLI 边界置 true；单测默认 false（见 §3.2）
    writeStderr?: (s: string) => void;       // CLI 注入 ⇒ 人类信息实时落盘；不注入（单测）攒进返回值
  }
  export async function runWait(argv: string[], deps?: WaitDeps): Promise<WaitResult>;
  ```
  `runWait` **不**直接 `process.exit`、**不**直接写 stdout/stderr —— 返回值由 `src/cli.ts` 落盘（可测）；
  copy 降级说明 / `--verbose` 进度 / 预算超限这类**等待中途就该看见**的人类信息经 `deps.writeStderr`
  实时落盘（CLI 注入）。不注入就攒进返回的 `stderr`——断言 `r.stderr` 的单测口径不变。

- [ ] **Step 1: 写失败测试（参数校验与 `--help`）**

  追加到 `tests/wait.test.ts`：

  ```ts
  import { runWait } from "../src/wait.js";

  describe("runWait 参数与用法", () => {
    it("--help 打印用法并 exit 0", async () => {
      const r = await runWait(["--help"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("agent-ex wait");
    });

    it("缺 task_id ⇒ exit 4", async () => {
      const r = await runWait([]);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain("task_id");
    });

    it("未知选项 ⇒ exit 4", async () => {
      const r = await runWait(["task_x", "--bogus"]);
      expect(r.exitCode).toBe(4);
    });

    it("--interval-sec 必须 > 0 ⇒ exit 4", async () => {
      const r = await runWait(["task_x", "--interval-sec", "0"]);
      expect(r.exitCode).toBe(4);
    });

    it("--max-wait-sec 必须 >= 0 ⇒ exit 4", async () => {
      const r = await runWait(["task_x", "--max-wait-sec", "-1"]);
      expect(r.exitCode).toBe(4);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run tests/wait.test.ts`
  Expected: FAIL —— `runWait` 未导出。

- [ ] **Step 3: 写 `runWait` 的参数解析与骨架**

  在 `src/wait.ts` 顶部加常量与解析器：

  ```ts
  import { readFileSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { agentExHome } from "./paths.js";
  import { extractReport, outlineOf, REPORT_TEXT_MAX, REPORT_HEAD_MAX, OUTLINE_MAX, OUTLINE_MAX_HEADS } from "./report.js";

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
        const r = takeValue(); if (r.error) return r; opts.intervalSec = Number(r.value);
      } else if (a === "--max-wait-sec") {
        const r = takeValue(); if (r.error) return r; opts.maxWaitSec = Number(r.value);
      } else if (a === "--report-out") {
        const r = takeValue(); if (r.error) return r; opts.reportOut = r.value;
      } else if (a === "--copy-dir") {
        const r = takeValue(); if (r.error) return r; opts.copyDir = r.value;
      } else if (a === "--home") {
        const r = takeValue(); if (r.error) return r; opts.home = r.value;
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
  ```

- [ ] **Step 4: 写 `runWait` 主流程**

  ```ts
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
        // 首次进 copy 模式时向 stderr 说明原因（验收表要求；文案对齐老脚本 wait-task.mjs:329）
        if (reader.dbSource === "copy" && !copyNoteDone) {
          copyNoteDone = true;
          note(
            `agent-ex wait: cannot read ${join(opts.home, "tasks.db")} in place ` +
            `(read-only dir, or WAL recovery needs write access) — reading a copy under ${opts.copyDir}\n`,
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
          note(
            `agent-ex wait: task still ${row.status} after ${Math.round(waited)}s, past the ${effectiveMaxWait}s ` +
            `budget derived from timeout_sec=${row.timeout_sec} — 本轮上界已过。\n`,
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

  /**
   * 预算推导：3 次 attempt 各吃满 timeout_sec + 30s/60s 退避 + 120s 收尾余量。
   * **只看单轮上界**，不按 rounds 缩放（见 spec §1.2）。
   */
  export function deriveMaxWait(timeoutSec: number): number {
    const t = Number(timeoutSec);
    if (!Number.isFinite(t) || t <= 0) return DEFAULT_MAX_WAIT_SEC;
    return t * 3 + 90 + 120;
  }
  ```

- [ ] **Step 5: 写 `emit`（按状态产出 stdout 字段）**

  ```ts
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

  const oneLine = (s: string, max = 300) => String(s).replace(/\s+/g, " ").trim().slice(0, max);
  // 默认 300 与老脚本逐字一致（wait-task.mjs:421）——ERROR/QUESTION 的截断口径，改了金标准 diff 就会红
  ```

  `EmitCtx` 的定义（与 `runWait` 里构造它的那一行配套）：

  ```ts
  interface EmitCtx {
    opts: Options;
    dbSource: "direct" | "copy";
    effectiveMaxWait: number;   // 已推导的预算（0 = 永不放弃 ⇒ 输出 "never"）
    now: () => number;
  }
  ```

- [ ] **Step 6: 写按状态分组的测试（43 条断言的落点）**

  追加到 `tests/wait.test.ts`。用合成 `AGENT_EX_HOME`（自建 `tasks.db` + 日志），**不碰真实库**。下表是必须覆盖的用例清单（每条一行断言，对应老脚本 43 条断言）：

  | 组 | 用例 | 断言 |
  | :--- | :--- | :--- |
  | needs_input | running → needs_input 要**快醒** | exit 5、`WAIT=needs_input`、`STATUS=needs_input`、`QUESTION=` 有内容、**无** digest 三件套、`REPORT_PATH` 仍输出 |
  | needs_input | 启动时已是 needs_input | exit 5（不是 2） |
  | needs_input | `--once` 遇 needs_input | exit 5（**不是** timeout） |
  | terminal | 长报告 | `REPORT_OUTLINE` + `REPORT_HEAD`，**无** `REPORT_TEXT`；stdout 字节数 < 报告文件字节数 |
  | terminal | 短报告 | `REPORT_TEXT` 内联，**无** `REPORT_HEAD` |
  | terminal | 报告文件内容 | 等于最长 assistant 块，且不含 compaction 摘要 |
  | timeout | 仍 running | exit 2、`WAIT=timeout`、**无** `QUESTION`、**无** `LOG_PATH`/`REPORT_*` |
  | timeout | `--once` 查非终态 | exit 2 |
  | not_found | 无此任务 | exit 3、`WAIT=not_found`、**仅 3 行**（无 `MAX_WAIT_SEC`） |
  | db_unreadable | 两处都读不了 | exit 6、**绝不**报 `WAIT=not_found`、stderr 含 "environment problem" 与 `--copy-dir` |
  | 预算 | 推导 | `timeout_sec=120` ⇒ `MAX_WAIT_SEC=570` |
  | 预算 | 显式覆盖 | `--max-wait-sec 30` ⇒ `MAX_WAIT_SEC=30` |
  | 预算 | 永不放弃 | `--max-wait-sec 0` ⇒ `MAX_WAIT_SEC=never`（**字面量**） |
  | 预算 | 无 timeout_sec | ⇒ `MAX_WAIT_SEC=7200` |
  | 形状 | claude / opencode / opencode part.text | 三种都能取出报告 |
  | 只读 | copy 降级 | `DB_SOURCE=copy`、stderr 说明"为什么读副本"、退出时副本目录被清掉 |
  | 信号 | SIGINT / SIGTERM | **不在这里写**——handler 里是 `process.exit(130/143)`，任何在测试进程内触发的写法（`process.emit`、`kill(process.pid)`）都会直接杀掉 vitest worker；挪到 Task 4 的 spawn 组（`child.kill("SIGINT")` 后断言 exit 130、stderr 一行、副本被清） |
  | 只读 | **D1 可见性** | copy 模式下源库状态变了 ⇒ 下一次轮询必须看到（Task 2 的用例已覆盖，这里再补一条**经 `runWait` 的端到端**版本，见下） |
  | 续跑 | 同一 id 重起 | 第二次 wait 读到新状态并 exit 0，报告文件被新报告覆盖 |
  | 用法 | `--help` / 缺 id / 未知选项 / 非法数值 | 0 / 4 / 4 / 4 |
  | 输出 | `ELAPSED_SEC` 语义 | = `(ended_at ?? now) - started_at`（多轮含人工等待，**不改 DB**） |
  | 输出 | `QUESTION` 只绑 needs_input | 终态行仍可能带上一轮 question，但**退出码与 WAIT= 不受影响** |

  D1 的**端到端**用例（`runWait` 层，证明轮询循环真的会重看源库）：

  ```ts
  it("D1 端到端：copy 模式下，源库推进后 wait 必须醒来而不是 timeout", async () => {
    const { root, home, copy, dbPath } = legacyWalHome("running");
    // 先把目录改只读再启动 wait：fixture 已干净关闭，目录里只剩 tasks.db ⇒ 只读读者建不了 -shm ⇒ 直读必失败。
    // ⚠️ 写侧动作不能在只读目录里做：WAL 写连接要建 -shm，0o555 下 new DatabaseSync 直接抛
    // "unable to open database file"——所以放在 sleep 回调里：先恢复权限 → 改库 → 关闭 → 再恢复只读。
    chmodSync(home, 0o555);
    let polls = 0;
    const sleep = async () => {
      polls++;
      if (polls === 1) {
        chmodSync(home, 0o755);
        const w = new DatabaseSync(dbPath);
        w.prepare("UPDATE tasks SET status='completed', ended_at=? WHERE id='task_x'")
          .run(Math.floor(Date.now() / 1000));
        w.close();
        chmodSync(home, 0o555);   // 恢复只读：后续轮询继续走 copy 重拷路径
      }
    };
    const r = await runWait(["task_x", "--home", home, "--copy-dir", copy,
      "--interval-sec", "1", "--max-wait-sec", "30"], { sleep });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^STATUS=completed$/m);
    expect(r.stdout).toMatch(/^WAIT=terminal$/m);
    rmSync(root, { recursive: true, force: true });
  });
  ```

  合成 HOME 的 fixture（**所有**状态组用例都用它；绝不碰真实 `~/.agent-ex`）：

  ```ts
  interface Row {
    status: string;
    question?: string | null;
    error?: string | null;
    timeout_sec?: number;
    log?: string[];
    files?: string[];
    started_at?: number | null;
    ended_at?: number | null;
  }

  /** claude 形状的一行 assistant 日志（与老测试同款 mock）。 */
  const asst = (text: string) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

  function makeHome(row: Row): string {
    const home = mkdtempSync(join(tmpdir(), "af-wait-run-"));
    const db = new DatabaseSync(join(home, "tasks.db"));
    db.exec(SCHEMA);
    const logPath = join(home, "task.jsonl");
    writeFileSync(logPath, (row.log ?? []).join("\n") + "\n");
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      "task_t1", row.status, "/tmp/proj", logPath, JSON.stringify(row.files ?? []),
      row.started_at ?? 1000, row.ended_at ?? null, row.error ?? null,
      row.question ?? null, row.timeout_sec ?? 3600,
    );
    db.close();
    return home;
  }
  ```

  按状态组各写一条完整用例（其余按上表逐条展开，断言口径相同）：

  ```ts
  it("终态 + 短报告：内联 REPORT_TEXT，不给 REPORT_HEAD", async () => {
    const home = makeHome({ status: "completed", log: [asst("## 报告\n改完 2 个文件，0 fail。")] });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^WAIT=terminal$/m);
    expect(r.stdout).toMatch(/^REPORT_TEXT=.*0 fail/m);
    expect(r.stdout).not.toMatch(/^REPORT_HEAD=/m);
  });

  it("needs_input：exit 5 + QUESTION 带上问句，且 digest 三件套全部缺席", async () => {
    const home = makeHome({
      status: "needs_input", question: "timeout_sec 取哪个值？",
      log: [asst("## 进展\n已完成 3 处修复。")],
    });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toMatch(/^WAIT=needs_input$/m);
    expect(r.stdout).toMatch(/^QUESTION=timeout_sec 取哪个值/m);
    expect(r.stdout).not.toMatch(/^REPORT_(OUTLINE|TEXT|HEAD)=/m);
  });

  it("timeout：exit 2，无 QUESTION、无 LOG_PATH/REPORT_*", async () => {
    const home = makeHome({ status: "running", log: [asst("working")] });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/^WAIT=timeout$/m);
    expect(r.stdout).not.toMatch(/^QUESTION=/m);
    expect(r.stdout).not.toMatch(/^LOG_PATH=/m);
    expect(r.stdout).not.toMatch(/^REPORT_/m);
  });

  it("not_found：exit 3，只有 3 行且没有 MAX_WAIT_SEC", async () => {
    const home = makeHome({ status: "running" });
    const r = await runWait(["task_missing", "--home", home, "--once"]);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe("TASK_ID=task_missing\nSTATUS=unknown\nWAIT=not_found\n");
  });

  it("预算：timeout_sec=120 ⇒ MAX_WAIT_SEC=570；--max-wait-sec 0 ⇒ 字面量 never", async () => {
    const home = makeHome({ status: "running", timeout_sec: 120 });
    const a = await runWait(["task_t1", "--home", home, "--once"]);
    expect(a.stdout).toMatch(/^MAX_WAIT_SEC=570$/m);
    const b = await runWait(["task_t1", "--home", home, "--once", "--max-wait-sec", "0"]);
    expect(b.stdout).toMatch(/^MAX_WAIT_SEC=never$/m);
  });
  ```

- [ ] **Step 7: 跑测试确认通过**

  Run: `npx vitest run tests/wait.test.ts`
  Expected: PASS（全部用例绿）。

- [ ] **Step 8: 跑全量 + 类型检查**

  Run: `npm test && npm run typecheck`
  Expected: 全绿。

- [ ] **Step 9: 提交**

  ```bash
  git add src/wait.ts tests/wait.test.ts
  git commit -m "feat: add agent-ex wait subcommand implementation"
  ```

---

## Task 4: 接线 —— `src/cli.ts` + `src/server.ts`

**Files:**
- Modify: `src/cli.ts`（加 `runWait` 入口）
- Modify: `src/server.ts`（加 `wait` 分支 + `USAGE` 一行）

**Interfaces:**
- Consumes: Task 3 的 `runWait(argv)` → `{ stdout, stderr, exitCode }`
- Produces: `agent-ex wait <task_id>` 可执行；`agent-ex wait --help` exit 0

- [ ] **Step 1: 写失败测试（CLI 真的能跑）**

  在 `tests/wait.test.ts` 追加（用 `tsx` 跑真 CLI，与 `tests/cli-env.test.ts` 同一路子）：

  ```ts
  import { spawn } from "node:child_process";
  import { fileURLToPath } from "node:url";
  import { dirname, join } from "node:path";
  // chmodSync / mkdtempSync / rmSync 在 Task 2 Step 1 已从 node:fs 引入（同一个文件），这里只补 readdirSync
  import { readdirSync } from "node:fs";

  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

  function runCli(args: string[], env?: Record<string, string>) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      // 用仓库本地的 tsx，别走 npx：每个用例起一次进程，npx 会拖慢且可能触网
      const tsx = join(ROOT, "node_modules", ".bin", "tsx");
      // env 只用来盖 AGENT_EX_HOME（paths.ts:7）；其余继承当前进程
      const p = spawn(tsx, ["src/server.ts", ...args], { cwd: ROOT, env: { ...process.env, ...env } });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  }

  describe("agent-ex wait 子命令（真 CLI）", () => {
    // 这一组是**进程级**断言：老测试断言的就是进程退出码，而 skill 依赖的恰恰是退出码
    // （Task 3 的单测只看返回值，覆盖不到「return exitCode → process.exit」这一段）。
    // 用合成 home（makeHome，见 Task 3 Step 6）⇒ 绝不碰真实 ~/.agent-ex。
    // 走 AGENT_EX_HOME 而不是 --home：skill 侧就是靠这个环境变量定位数据目录，别只测一条它不走的路径。
    it("--help 打印用法并 exit 0", async () => {
      const r = await runCli(["wait", "--help"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("usage: agent-ex wait");
    });

    it("缺 task_id ⇒ exit 4（不是 unknown command 的 2，也不是异常的 1）", async () => {
      const r = await runCli(["wait"]);
      expect(r.code).toBe(4);
    });

    it("未知选项 ⇒ exit 4", async () => {
      const r = await runCli(["wait", "--bogus"]);
      expect(r.code).toBe(4);
    });

    it("terminal ⇒ 进程 exit 0", async () => {
      const home = makeHome({ status: "completed", log: [asst("## 报告\n改完。")] });
      const r = await runCli(["wait", "task_t1", "--once"], { AGENT_EX_HOME: home });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^WAIT=terminal$/m);
      rmSync(home, { recursive: true, force: true });
    });

    it("needs_input ⇒ 进程 exit 5", async () => {
      const home = makeHome({ status: "needs_input", question: "选哪个方案？" });
      const r = await runCli(["wait", "task_t1", "--once"], { AGENT_EX_HOME: home });
      expect(r.code).toBe(5);
      expect(r.out).toMatch(/^WAIT=needs_input$/m);
      rmSync(home, { recursive: true, force: true });
    });

    it("timeout ⇒ 进程 exit 2", async () => {
      const home = makeHome({ status: "running" });
      const r = await runCli(["wait", "task_t1", "--once"], { AGENT_EX_HOME: home });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/^WAIT=timeout$/m);
      rmSync(home, { recursive: true, force: true });
    });

    it("not_found ⇒ 进程 exit 3", async () => {
      const home = makeHome({ status: "running" });
      const r = await runCli(["wait", "task_missing", "--once"], { AGENT_EX_HOME: home });
      expect(r.code).toBe(3);
      expect(r.out).toBe("TASK_ID=task_missing\nSTATUS=unknown\nWAIT=not_found\n");
      rmSync(home, { recursive: true, force: true });
    });

    it("db_unreadable（库与副本目录都不可写）⇒ 进程 exit 6，不是 3", async () => {
      // 必须是**遗留 WAL 库**（目录里只剩 tasks.db）：这种库只读打开要做 WAL recovery ⇒ 需要写 ⇒ 0555 下必失败。
      // 普通库（journal_mode=delete，如 makeHome）在 0555 目录里**能**直读成功，构造不出这个场景。
      const { root, home, copy } = legacyWalHome("running");
      chmodSync(home, 0o555);
      chmodSync(copy, 0o555);
      const r = await runCli(["wait", "task_x", "--once", "--copy-dir", copy], { AGENT_EX_HOME: home });
      expect(r.code).toBe(6);
      expect(r.out).toMatch(/^WAIT=db_unreadable$/m);
      expect(r.out).not.toMatch(/WAIT=not_found/);
      chmodSync(home, 0o755);
      chmodSync(copy, 0o755);
      rmSync(root, { recursive: true, force: true });
    });

    it("SIGINT ⇒ 进程 exit 130、只结束自己、副本被清掉", async () => {
      // 进程级才能测：handler 里是 process.exit(130)，在 vitest 进程内触发会把 worker 一起带走
      const { root, home, copy } = legacyWalHome("running");   // 0555 + WAL ⇒ 必走 copy
      chmodSync(home, 0o555);
      const p = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["src/server.ts", "wait", "task_x",
        "--copy-dir", copy, "--interval-sec", "5"],
        { cwd: ROOT, env: { ...process.env, AGENT_EX_HOME: home } });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      // 等它真的进了 copy 模式（stderr 有降级说明）再发信号，别用固定 sleep 赌时序。
      // ⚠️ 这条能成立依赖 cli.ts 注入 writeStderr 的**实时**落盘——若 runWait 把 stderr
      // 攒到返回才 flush，这里永远等不到那一行 ⇒ 测试死锁到 30s 超时（review 实测过的坑）。
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (err.includes("reading a copy")) { clearInterval(t); resolve(); }
        }, 25);
        p.on("close", () => { clearInterval(t); resolve(); });   // 子进程提前挂了也别把测试挂死
      });
      p.kill("SIGINT");
      const code = await new Promise<number | null>((resolve) => p.on("close", (c) => resolve(c)));
      expect(code).toBe(130);
      expect(err).toContain("SIGINT received");
      expect(readdirSync(copy)).toHaveLength(0);   // mkdtemp 出来的副本目录已被删
      chmodSync(home, 0o755);
      rmSync(root, { recursive: true, force: true });
    });

    // exit 1（未预期异常 → server.ts 的 catch）**没有 wait 专属用例**：runWait 的每条路径都把错误
    // 收成 exit 6/4/3/2/0，走不到 catch；硬造只能加故障注入口子（为测试改产品面，不值）。
    // 这个分支与 config/doctor 共用同一段 catch，已被 tests/cli-env.test.ts 的 "config failed" 用例钉住。
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run tests/wait.test.ts`
  Expected: FAIL —— 老 CLI 没有 `wait` 子命令，会走 unknown command 分支 exit 2。

- [ ] **Step 3: `src/cli.ts` 加 `runWait`**

  ```ts
  /** `agent-ex wait <task_id>`：等任务到终态或 needs_input，并给出完整报告路径。 */
  export async function runWait(args: string[]): Promise<number> {
    // ⚠️ 必须**动态** import：wait.ts 顶层要加载 node:sqlite，静态 import 会把 SQLite 带进
    // doctor/config/profile（它们经 server.ts 动态 import cli.js）——违反 AGENTS 硬约束 7
    // 与 tests/cli-env.test.ts:189-219 的懒加载断言。
    const { runWait: runWaitImpl } = await import("./wait.js");
    // 信号监听由**本层显式开启**（deps.installSignals），实际安装/卸载在 wait.ts 内：
    // 库函数不主动装全局监听，单测默认 false（spec §3.2）。
    // writeStderr 同理由本层注入：copy 降级说明 / --verbose / 预算超限要**等待中途**就可见
    // （攒到返回才 flush 的话，SIGINT 测试没有任何带内信号可等，--verbose 也形同虚设）。
    // 注入后 r.stderr 恒为空 ⇒ 下面那道兜底不会重复打印。
    const r = await runWaitImpl(args, {
      installSignals: true,
      writeStderr: (s) => process.stderr.write(s),
    });
    if (r.stderr) process.stderr.write(r.stderr);   // r.stderr 自带换行；console.error 会多打一个空行
    if (r.stdout) process.stdout.write(r.stdout);
    return r.exitCode;
  }
  ```

- [ ] **Step 4: `src/server.ts` 加 `wait` 分支**

  在 `else if (sub === "doctor" || sub === "config" || sub === "profile")` **之后**、unknown-command 分支**之前**插入
  一个**独立分支**（不能并进上面那个：`wait` 刻意不加载 `.env`）：

  ```ts
  } else if (sub === "wait") {
    // wait **不**调用 loadEnvFile()：它不解析 {env:VAR}，也不需要密钥。
    // 但异常体验必须与其它 CLI 子命令对等（CLI 侧没人接异常 → 一屏栈 + exit 1）。
    try {
      const { runWait } = await import("./cli.js");
      process.exit(await runWait(process.argv.slice(3)));
    } catch (e) {
      console.error(`[agent-ex] wait failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }
  ```

  `USAGE` 加一行：

  ```
    "  wait <task_id>                   block until a task is terminal (or needs input)",
  ```

- [ ] **Step 5: 跑测试确认通过**

  Run: `npx vitest run tests/wait.test.ts`
  Expected: PASS。

- [ ] **Step 6: 冒烟（手工，三条命令）**

  ```bash
  npm run build
  node dist/server.js wait --help; echo "exit=$?"          # 期望 exit 0
  node dist/server.js wait; echo "exit=$?"                  # 期望 exit 4
  node dist/server.js wait task_does_not_exist --once; echo "exit=$?"   # 期望 exit 3
  ```

  Expected: exit 依次为 `0` / `4` / `3`。

- [ ] **Step 7: 跑全量 + 类型检查 + 冒烟脚本**

  Run: `npm test && npm run typecheck && node scripts/smoke-stdio.mjs`
  Expected: 全绿；smoke 断言 **6 个生产工具齐全**、TEST ONLY 未暴露（工具面未变）。

- [ ] **Step 8: 提交**

  ```bash
  git add src/cli.ts src/server.ts tests/wait.test.ts
  git commit -m "feat: wire agent-ex wait into the CLI dispatcher"
  ```

---

## Task 5: 金标准对照 + 冒烟 + **publish**（必须在删脚本之前）

> ⚠️ 顺序理由见 spec §6.8：AGENTS.md 是 **④ push+tag → ⑧ publish**，push 必然在 publish 之前。
> 真正的约束是**被 push 的那批不含 skill 改动**；若把 skill 改动混进去，会先上 GitHub、后上 npm
> ⇒ 用户处在"新 skill + 旧包"（skill 调不到 `wait`）的中间态。
> ⇒ 正确顺序：**commit A（代码 + 测试）→ 版本号提交 + push + tag → publish → commit B（删脚本 + 改文档）→ push**。
> 本 task 结束于 `npm publish`；Task 6 才动 skill。

**Files:** 无代码改动（只有验证与发布动作；发现差异时回到 Task 3 修）

- [ ] **Step 1: 金标准对照（先存档再 diff）**

  拿 3 份真实日志（一个超时单、一个 opencode 单、一个长报告单），在**同一份库**上：

  ```bash
  # ① 先用老脚本存档 stdout（老脚本此刻还在，直到 Task 6 删除）
  node skills/agent-ex-dispatch/scripts/wait-task.mjs <task_id> --once > /tmp/golden-<id>.txt 2>/tmp/golden-<id>.err
  # ② 新 CLI
  node dist/server.js wait <task_id> --once > /tmp/new-<id>.txt 2>/tmp/new-<id>.err
  # ③ 逐行 diff stdout（stderr 不比：前缀从 wait-task: 变成 agent-ex wait:）
  diff /tmp/golden-<id>.txt /tmp/new-<id>.txt && echo "DIFF EMPTY"
  ```

  Expected: 三份都 `DIFF EMPTY`。
  ⚠️ 若 diff 非空：**先看是不是 Task 3 的字段/阈值口径错了**，改代码并补测试，**不要**改这份基准去迁就实现。

- [ ] **Step 2: 手工冒烟（kill runner ⇒ 60s 内退出）**

  ```bash
  node dist/server.js wait <task_id> --max-wait-sec 60 &
  # 另开一个终端 kill 掉 runner 进程
  ```

  Expected: 60s 内 `WAIT=timeout` / exit 2，**不是挂死**。
  ⚠️ 必须显式 `--max-wait-sec 60`（默认推导预算 timeout_sec=3600 ⇒ 11010s ≈ 3 小时）。

- [ ] **Step 3: 确认 commit A 已就绪（skill 侧还没动）**

  ```bash
  git status --short
  git log --oneline -5
  ```

  Expected: Task 1–4 的提交都在；**skill 侧尚未删除**（那是 Task 6）。
  ⚠️ 若此时 skill 已被删（顺序做反了），**停下来**：先把 skill 侧改动 `git stash` 起来，
  走完 publish 再 `stash pop` 做成 commit B。

- [ ] **Step 4: 版本号提交 + push + tag + 干净目录装包冒烟（顺序不能换）**

  ⚠️ **版本号必须先 bump 再 `npm pack`**：否则打出来的 tgz 是旧版本号，publish 时要么被 registry
  拒绝（同版本已存在），要么发出去的不是"含新 CLI 的那一版"。

  ```bash
  # ① 版本号（Task 6 的版本门槛要写死这个 X）
  npm version X --no-git-tag-version
  git add package.json package-lock.json && git commit -m "chore(release): X"
  git push origin main
  git tag -a vX -m "X" && git push origin vX

  # ② 构建 + 打包 + 装包冒烟
  npm run build && npm test
  npm pack                                    # → agent-ex-mcp-X.tgz（版本号必须是 X）
  REPO=$(pwd); D=$(mktemp -d)
  ( cd "$D" && npm init -y \
    && npm install "$REPO"/agent-ex-mcp-X.tgz \
    && ./node_modules/.bin/agent-ex wait --help; echo "exit=$?" )   # 期望 exit 0（新 CLI），不是 2（老 CLI unknown command）
  node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js"
  ```

  预期：`wait --help` exit 0 且打印 usage；smoke 显示 6 个工具齐全。
  仓库里能跑 ≠ 包里能跑（0.1.0 的教训：CLI 层没进包、子命令被静默吞成 MCP server）——
  新 CLI 子命令正是最可能踩中的场景，必须**装出来测**。

- [ ] **Step 5: publish + 线上核验（对外动作，先向用户确认）**

  四步顺序回顾（Step 4 已完成前两步）：**commit A（代码 + 测试）→ 版本号提交 + push + tag → publish（本步）
  → commit B（删脚本 + 文档）+ push（Task 6）**。理由对齐 `AGENTS.md` 的 **④ push+tag → ⑧ publish**：

  ```bash
  npm publish agent-ex-mcp-X.tgz --access public --registry https://registry.npmjs.org
  npm view agent-ex-mcp versions --registry https://registry.npmjs.org --prefer-online
  ```

  **真正的约束是「被 push 的那批里不含 skill 改动」，不是「push 必须在 publish 之后」**：
  commit B 一旦在 publish 前推上去，远端就是"新 skill + 旧包"——用户照 skill 调 `agent-ex wait`
  会命中老 CLI 的 unknown command（exit 2）。同理，版本号提交必须单独成一步，否则它会被并进
  commit A 的语义里，tag 也指不到"含新 CLI 的那一版"。

  ⚠️ **publish 完成前，本机自测 skill 必须先 `npm link`**（或直接 `node dist/server.js wait`）：
  此时 `npm i -g agent-ex-mcp` 装回来的仍是旧版（本机实测 0.2.0），升级命令等于原地打转。
  ⚠️ push 与 publish 都需要用户确认；token 只在本机 `~/.npmrc`，**不贴进任何聊天**。
  ⚠️ 这一步**只发布 npm 包**（`files` 只有 dist / config.example.json / README.md）——
  skill 不在包里，所以"新包已上、旧 skill 还在"是**预期中间态**：旧 skill 仍用老脚本，
  新用户用新 CLI，两套并存直到 Task 6 把老脚本删掉。

---

## Task 6: skill 侧删除 + 文档同步 + commit B → push（**必须同一个提交**）

> ⚠️ 本 task 的三件事（删脚本 / 删测试 / 移除 vitest exclude）**必须同一个提交**：
> 先删 `exclude` 而文件还在，vitest 会把那个自带 runner 的 `.mjs` 收进来并因模块解析失败转红。
> ⚠️ 本 task 必须在 **Task 5 的 publish 之后**（否则会落进"新 skill + 旧包"的坑）。

**Files:**
- Delete: `skills/agent-ex-dispatch/scripts/wait-task.mjs`
- Delete: `skills/agent-ex-dispatch/scripts/wait-task.test.mjs`
- Modify: `vitest.config.ts`
- Modify: `skills/agent-ex-dispatch/SKILL.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `scripts/install-skill.sh`

- [ ] **Step 1: 改 `vitest.config.ts`（移除 `exclude`）**

  删掉整个 `exclude` 键（**连带解释它的注释**）：vitest 默认本来就排除 `**/node_modules/**`，
  这个键唯一的作用是挡 `skills/**/*.test.mjs`；脚本删掉后它就成了没有意义的死配置。

  ```ts
  export default defineConfig({
    test: {
      testTimeout: 30_000,
    },
  });
  ```

- [ ] **Step 2: 删两个脚本文件（用可恢复删除）**

  ```bash
  git rm skills/agent-ex-dispatch/scripts/wait-task.mjs \
         skills/agent-ex-dispatch/scripts/wait-task.test.mjs
  ```

- [ ] **Step 3: 改 `SKILL.md`（按 grep 全量清点，不按固定处数）**

  1. **调用方式**改成：
     ```bash
     agent-ex wait <task_id> --report-out /tmp/<task_id>.report.md
     ```
     （删掉 `$SKILL_DIR` 定位与 `node --disable-warning=ExperimentalWarning` 前缀——后者是 node 的 flag，CLI 不需要。）
  2. **命令发现**改成 `command -v agent-ex` → 找不到就报错并按场景给**三条路**
     （`npm i -g agent-ex-mcp`；免安装的 `npx -y agent-ex-mcp@latest wait <task_id>`；
     仓库开发路线 `npm link` 或 `node <repo>/dist/server.js wait`），**不**回退脚本。
     版本错配的兜底文案要写清：包尚未发布时前两条装回来的仍是旧版，本机自测先 `npm link`。
  3. **Resources 列表**：删掉 `scripts/wait-task.mjs` 与 `scripts/wait-task.test.mjs` 两行。
  4. **排错表「`agent_ex_status` 的 `result` 只给到一半」那条**：删掉末尾那段手写 python 提取 recipe，
     改成"用 `agent-ex wait <id> --once --report-out <path>` 拿完整报告"。
  5. **只读沙箱说明**与**两处过期文案**改成 CLI 说法：退出码清单里的"3 无此任务**或 DB 不可读**"
     要拆成 3 / 6；`WAIT=db_unreadable`（exit 6）是环境问题、不是任务不存在。
  6. **新增**：版本门槛——写死为 **Task 5 记录的发布版本 X**（`requires agent-ex >= X`，探针
     `agent-ex wait --help`：新 CLI exit 0 / 老 CLI exit 2）；运行期判据是"**有 `WAIT=` 行才认退出码**"。
  7. **Phase 2 标题**：「执行期自主推进 loop（可选；含会话内定时等待）」里的「含会话内定时等待」
     改成「含 `agent-ex wait` 等待」——该能力自本次迁移起是 CLI 子命令，不再是会话内脚本。

  > 覆盖面自检（10/30 外部评审实测）：除上面七类，`wait-task` 在 SKILL.md 里还有 `$SKILL_DIR`
  > 定位块（约 L250-269）、排错表的 recipe 与文案（约 L321/330/353/355）等**共 15 次 / 11 行**引用
  > （`grep -o "wait-task" skills/agent-ex-dispatch/SKILL.md | wc -l` 实测）——
  > 以 `grep -n "wait-task" skills/agent-ex-dispatch/SKILL.md` 的实时结果为准逐处清点收口；
  > 历史叙述里保留旧名的，加一句「（已迁移为 `agent-ex wait`）」标注，别静默留着两套事实。

- [ ] **Step 4: 改 `README.md`（四处）+ `install-skill.sh`（一条）**

  1. 「命令行工具」表加一行：
     `| \`agent-ex wait <task_id>\` | 等任务到终态（0）或 needs_input（5）；超时 2、无此任务 3、库不可读 6、用法错 4。 |`
     表后**必须**补一句判读（spec §3.2 的撞码提醒）：`exit 2 且 stdout 没有 WAIT= 行 ⇒ CLI 太旧
     （old CLI 的 unknown command 与超时撞码），不是超时——升级：npm i -g agent-ex-mcp`。
  2. **删掉「路线 A」里「无需 `npm i -g agent-ex-mcp`」那句承诺**——wait loop 现在必须有二进制。
  3. **顶部「派发实现」描述里的 `wait-task.mjs`**（README.md:16）改成 `agent-ex wait`——删脚本后它是死引用。
  4. 其余正文与「排错」章节若还引用 `wait-task.mjs`，以 `grep -n "wait-task" README.md` 为准一并改成 CLI 说法。
  5. `scripts/install-skill.sh` 的收尾提示（"Done. Verify:" 之后）补两行英文：
     `wait` 已是 CLI 子命令、本 skill 不再自带脚本；`agent-ex wait --help` exit 2 ⇒ 全局版本太旧，
     包未发布时升级命令装回旧版——仓库开发路线先 `npm link`。

- [ ] **Step 5: 改 `AGENTS.md`**

  在 project layout 的 `src/` 清单里加两行：

  ```
  - `report.ts` — 报告提取（claude/opencode 两种日志形状 → 最长 assistant 块 → outline/digest）
  - `wait.ts` — `agent-ex wait` 子命令：只读轮询 tasks.db + 报告提取 + 退出码契约
  ```

- [ ] **Step 6: 跑全量测试（确认 exclude 移除后没有把别的东西收进来）**

  Run: `npm test`
  Expected: 全绿。验收看**覆盖面**而不是数字：`tests/wait.test.ts` 覆盖 §3.3 按状态的每种字段集（terminal / needs_input / timeout / not_found / db_unreadable）
  + 预算三分支 + 真进程退出码 0/2/3/4/5/6/130。⚠️ 别再用"用例总数不减少"当口径：`wait-task.test.mjs` 一直在
  `vitest.config.ts` 的 exclude 里，从没进过 `npm test` 的计数，且 43 是**断言数**不是用例数。

- [ ] **Step 7: 冒烟（确认 skill 侧描述与真实 CLI 一致）**

  ```bash
  npm run build && node dist/server.js wait --help
  ```

  Expected: 打印 usage，exit 0；与 `SKILL.md` 里写的用法逐字对得上。

- [ ] **Step 8: 提交 B（一个提交含以上全部）→ push**

  ```bash
  git add -A skills/agent-ex-dispatch vitest.config.ts README.md AGENTS.md scripts/install-skill.sh
  git commit -m "refactor: move wait-task script into the agent-ex CLI"
  git push origin main
  ```

  ⚠️ `git push` 是对外动作，执行前向用户确认。

---

## 自检（写完后对着 spec 逐条核对）

| spec 条目 | 落在哪个 task |
| :--- | :--- |
| §1.1 D1 修复（copy 模式能看到状态变化） | Task 2（库层）+ Task 3（端到端） |
| §3.1 参数与预算口径（单轮上界） | Task 3 |
| §3.2 退出码 0/5/2/3/6/4/1 + 信号 130/143 | Task 3（实现）+ Task 4（CLI 层 4/1） |
| §3.3 逐状态字段表 + `MAX_WAIT_SEC=never` + `ELAPSED_SEC` 语义 | Task 3 |
| §4 `report.ts` 自解析 / `wait.ts` / `openReadonlyStore` / wait 单独分支 | Task 1 / 3 / 2 / 4 |
| §5 skill 侧改动（含命令发现与 `--help` 探针） | Task 6 |
| §6.1–6.2 单测 | Task 1 / 3 |
| §6.3 D1 回归用例 | Task 2 + Task 3 |
| §6.4 server 子命令 + USAGE + `--help` | Task 4 |
| §6.5 金标准对照 | Task 5 |
| §6.6 手工冒烟 | Task 5 |
| §6.7 skill 侧三件事同一提交 | Task 6 |
| §6.8 发布顺序（四步：commit A → 版本提交 + push + tag → publish → commit B + push） | Task 5 Step 4（版本提交 + push + tag）+ Step 5（publish）+ Task 6 Step 8（commit B + push） |

**缺口自查**：无。D2 已撤回（spec §1.2），本 plan 不含 rounds 缩放。

**执行顺序提示**：Task 1 → 2 → 3 → 4 → **5（publish）→ 6（删脚本 + commit B + push）**。
Task 5 与 Task 6 不可对调——对调就落进 spec §6.8 要避免的"新 skill + 旧包"中间态。
