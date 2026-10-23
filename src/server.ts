#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { version } from "./tools/version.js";
import { restart } from "./tools/restart.js";
import { setStartedAt, isTestMode } from "./tools/test-helpers.js";
import { ensureRuntimeDirs } from "./paths.js";
import { loadEnvFile } from "./env-file.js";
import { BRAND } from "./brand.js";
import { ansi } from "./ansi.js";
import { MARK } from "./marks.js";

/**
 * ⚠️ 这里的 import 是**故意不全**的：
 * `submit` / `status` / `cancel` / `doctor` 都在 `main()` 里动态 import。
 *
 * 原因：submit.js → store.js → node:sqlite 是**顶层**加载链，一旦静态 import，
 * 连 `agent-ex init`（根本不碰数据库）也会在启动时加载 SQLite ——
 * Node 的 "ExperimentalWarning: SQLite is an experimental feature" 是异步打印的，
 * 会插进 readline 的第一个提示符中间，把交互式 init 的界面搅乱。
 *
 * 保持动态 import 还有一个好处：`init` / `doctor` / `config` 三个子命令启动更快
 * （不必加载 SDK、SQLite、runner 相关的全部模块）。
 */
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

async function main(): Promise<void> {
  // 先灌 $AGENT_EX_HOME/.env（真实密钥所在）→ runner 子进程自动继承，任务期占位符可解析。
  loadEnvFile();
  ensureRuntimeDirs();
  const server = new McpServer({ name: BRAND, version: "0.1.0" });

  // 动态 import：避免把 SQLite / spawn 相关模块拖进每个子命令的启动路径（见上方注释）
  const { submit } = await import("./tools/submit.js");
  const { status } = await import("./tools/status.js");
  const { cancel } = await import("./tools/cancel.js");
  const { doctor } = await import("./doctor.js");

  server.tool(
    "agent_ex_submit",
    [
      "派发编码任务给外部 worker（detached runner），立即返回 task_id，不阻塞。",
      "prompt 需包含完整上下文、约束与验收标准——worker 不共享当前会话上下文。",
      "任务已提交，卡住/完成会推飞书，无需轮询。",
      "多个任务写同一 project_path 会互相踩文件——plan 负责串行派发或确保改动文件不重叠。",
      "对 needs_input 任务答疑续跑时传 continue_of=task_id，prompt 填答案，worker 将带着原上下文继续。",
    ].join("\n"),
    {
      prompt: z.string().describe("任务工单（首轮）或对 worker 问题的答复（续跑）"),
      project_path: z.string().optional().describe("工作目录，默认 MCP server cwd"),
      profile: z.string().optional().describe("运行 profile 名，默认取 config defaults.profile"),
      continue_of: z.string().optional().describe("续跑目标任务 id（该任务须为 needs_input）"),
      timeout_sec: z.number().int().positive().optional().describe("每轮超时秒数，默认取 config"),
    },
    async (args) => json(await submit(args))
  );

  server.tool(
    "agent_ex_status",
    ["查询任务状态。无参数调用返回全部活跃任务，用于一次性概览；", "needs_input 任务会返回 question 字段。"].join("\n"),
    { task_id: z.string().optional().describe("任务 id；缺省返回全部活跃任务") },
    async (args) => json(status(args))
  );

  server.tool(
    "agent_ex_cancel",
    [
      "取消任务（状态感知、幂等）：running 杀整个进程组；已终态则原样返回当前状态。",
      "若返回带warning，说明进程树快照不可用（ps 被拒），组外逃逸的 agent 子进程可能残留。",
    ].join("\n"),
    { task_id: z.string().describe("任务 id") },
    async (args) => json(cancel(args))
  );

  server.tool(
    "agent_ex_version",
    ["返回当前 MCP server 构建元数据（version / gitSha / buildTime），用于确认重启后新代码已生效。",
      "构建信息缺失时返回 unknown。"].join("\n"),
    {},
    async () => json(version()),
  );

  server.tool(
    "agent_ex_doctor",
    ["体检：把「通知到底通不通」的证据聚合成结论 + 病因 + 修复命令。",
      "查三类问题：config 本身（关键词/dry_run/webhook/默认profile）、executor 的 bin 是否可执行、",
      "历史通知失败（扫 runner 日志里的飞书拒收记录，按 code 聚合）。",
      "send=true 会额外实发一张正文不含产品名的自检卡——验证通知必须用它，",
      "因为飞书关键词闸门匹配整张卡片，拿真实任务报告当探针会假通过。"].join("\n"),
    {
      send: z.boolean().optional().describe("是否实发自检卡（默认 false，只读体检）"),
    },
    async (args) => json(await doctor({ send: args.send ?? false })),
  );

  server.tool(
    "agent_ex_restart",
    ["主动重启当前 MCP server 进程（process.exit，由 host 自动 respawn 并加载当前 dist）。",
      "server 无状态、in-flight worker 在独立进程组，重启安全；只重启调用方这条连接，不影响其他 live server 或在跑任务。"].join("\n"),
    {},
    async () => json(restart()),
  );

  if (isTestMode()) {
    server.tool(
      "agent_ex_set_started_at",
      ["TEST ONLY: 改写任务 started_at（unix 秒），用于 V5 孤儿收割验收快速触发 2×timeout_sec 判定。", "需在 MCP server 启动时设置环境变量 AGENT_EX_TEST_MODE=1。"].join("\n"),
      {
        task_id: z.string().describe("任务 id"),
        started_at: z.number().describe("新的 started_at（unix 秒）"),
      },
      async (args) => json(setStartedAt(args))
    );
  }

  await server.connect(new StdioServerTransport());
  console.error("[agent-ex] mcp server ready (stdio)");

  // stdin EOF = MCP client 断开（会话结束）。SDK 的 StdioServerTransport 在 stdin end 时
  // 只 close（off 掉 data listener）不强制退出；host 复用常驻进程 + 懒加载 spawn 新会话时，
  // 旧 server 的事件循环仍非空 → 永久挂起成残留（实测观察到多个跨日残留 server 的 fd0 仍连活 pipe）。
  // 显式退出让"客户端断管道"的 server 能自愈回收。server 无状态（状态全在 tasks.db），exit 安全。
  process.stdin.on("end", () => process.exit(0));
}

const sub = process.argv[2];

const USAGE = [
  `usage: ${BRAND} [command]`,
  "",
  "commands:",
  "  init                            interactive onboarding (writes config.json)",
  "  doctor [--fix] [--send]         check the notification path",
  "  config [list|set]               global settings",
  "  profile [list|use|create|set]   profiles (executor + env a task runs with)",
  "",
  "no command: start the MCP server on stdio (how MCP clients launch it)",
].join("\n");

if (sub === "init") {
  // 交互式 onboarding：探测 CLI、生成 config.json。动态 import 避免正常 MCP 启动拉入 readline。
  const { runInit } = await import("./init.js");
  runInit()
    .then(() => process.exit(0))
    .catch((e) => { console.error("[agent-ex] init failed:", e); process.exit(1); });
} else if (sub === "doctor" || sub === "config" || sub === "profile") {
  // CLI 子命令：doctor（体检）/ config（改全局字段）/ profile（改 profile）。
  // 动态 import 避免 MCP 启动时拉入这些模块。
  //
  // ⚠️ 必须先加载 $AGENT_EX_HOME/.env：
  // MCP 路径的 loadEnvFile() 在 main() 里，而这个分支**根本不会走到 main()**（模块顶层直接分派）。
  // 于是 CLI 侧解析 {env:VAR} 占位符必然失败——2026-10-22 实测：同一轮体检里
  // 前半句说"✓ webhook 地址已配置（在 .env 里）"、后半句说"✗ env placeholder not found"，
  // 自相矛盾，且 `doctor --send` 在 init 默认产出的配置形态下**必然失败**。
  //
  // init 不在这里加载：它自己就是 .env 的写入方（writeEnvFile 负责合并），
  // 预先把 .env 灌进进程环境会让"检测到的值"与"本次采集的值"混为一谈。
  loadEnvFile();
  // 与 init 分支同一套兜底：未预期的异常不该漏一个裸 Node 栈。
  // ⚠️ CLI 与 MCP 侧的异常体验必须对等——MCP 侧由 SDK 捕获（返回 isError 结果，
  // agent 看到的是一句错误信息），CLI 侧没人接就变成一屏栈加 exit 1。
  //
  // 只打 message 不打栈：栈是给开发者看的，用户要的是"哪儿错了"。
  // （2026-10-23 实测：`console.error(msg, e)` 会连着打 3 行 `at ...` 栈帧。）
  try {
    const { runDoctor, runConfig, runProfile } = await import("./cli.js");
    const argv = process.argv.slice(3);
    const code = sub === "doctor" ? await runDoctor(argv) : sub === "config" ? runConfig(argv) : runProfile(argv);
    process.exit(code);
  } catch (e) {
    console.error(`[agent-ex] ${sub} failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else if (sub === "--help" || sub === "-h") {
  console.log(USAGE);
} else if (sub && !sub.startsWith("-")) {
  // 拼错的子命令曾经会**静默变成 MCP server**（挂在 stdio 上等输入），
  // 用户只看到一行 "mcp server ready" —— 比报错更难懂。
  // MCP 客户端是无参启动的，所以"有非选项参数但认不出"一定是手敲错了。
  console.error(`${ansi.red(MARK.error)} unknown command "${sub}"\n\n${USAGE}`);
  process.exit(2);
} else {
  main().catch((e) => { console.error("[agent-ex] fatal:", e); process.exit(1); });
}