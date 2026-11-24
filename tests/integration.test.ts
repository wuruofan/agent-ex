// 集成测试：端到端真实链路（submit → runner → agent → 终态）。
// 不走 mock，spawn 真实进程。覆盖 happy path + cancel 级联 + 超时 + 续跑。
//
// 实施要点：
// - 自定义 inline fake-agent 写到 /tmp/afex-int-*（macOS 上 /var/folders spawn .cjs 报 ENOEXEC）。
// - 模板字面量首字符直接是 #!：\n 会让 file/lspawn 看不到 shebang。
// - profile.env.PATH 必须注入：buildAgentEnv 显式构造 PATH 不继承 process.env，
//   而 `#!/usr/bin/env node` 需要 env 找到 node。
// - bin=可执行文件本身，args=[]。runner 会先 `slice(1)` 去掉 argv[0] 再 spawn（2026-10-08 修），
//   所以这里不必再为「bin 被重复夹带进 argv」做规避；仍用独立可执行文件而非 `node script.cjs`，
//   是为了避开 buildAgentEnv 自建 PATH 时对解释器查找的影响（见下一条）。
// - FAKE_MODE & FAKE_PIDFILE 通过 profile.env 传到 agent 子进程。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

// 集成测试直接跑预编译的 dist/runner.js（生产同款路径），避开 tsx 冷启动给每个 runner 进程加的延迟——
// 否则本机 spawn 延迟会把测试内部 timing 阈值（waitForTerminal 8s / pidfile 4s / 并发 8s）拖爆而误报失败。
// dist 缺失时整组优雅 skip，避免 `npm test` 因未构建而红；`npm run test:integration` 会先 build。
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtRunner = join(repoRoot, "dist", "runner.js");
const builtRunnerExists = existsSync(builtRunner);
if (!builtRunnerExists) {
  console.warn(`[integration] SKIP: ${builtRunner} not found. Run \`npm run build\` first.`);
}
const suite = builtRunnerExists ? describe : describe.skip;

import { submit } from "../src/tools/submit.js";
import { status } from "../src/tools/status.js";
import { cancel } from "../src/tools/cancel.js";
import { openStore } from "../src/store.js";
import { killTree, isPsAvailable } from "../src/proc-tree.js";
import { scanNotifyFailures } from "../src/doctor.js";

// 依赖 `ps` 才能发现「逃逸孙进程」的用例：ps 不可用时（如 WorkBuddy Bash 工具的 Seatbelt 沙箱
// 拒绝执行 setuid 的 /bin/ps）显式跳过，而不是以「假红」形式报错。详见 src/proc-tree.ts。
const hasPs = isPsAvailable();
const psRequired = hasPs ? it : it.skip;

let home: string;
let fakeAgent: string;

// inline fake-agent：模式由 FAKE_MODE 决定；可选 FAKE_PIDFILE 写入自身 pid 让 cancel 测试验证。
const AGENT_BODY = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_MODE ?? "ok";
if (process.env.FAKE_PIDFILE) {
  try { require("node:fs").writeFileSync(process.env.FAKE_PIDFILE, String(process.pid)); } catch {}
}
if (mode === "hang") {
  emit({ type: "system", subtype: "init", session_id: "sid-hang-" + process.pid });
  // 响应 SIGTERM/SIGKILL 才能让 runner 的 timeout 信号真正杀进程
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "silent") {
  // 首步看门狗场景（2026-11-24 回归）：复刻 opencode 免费档额度耗尽的挂死形态 ——
  // worker 进程活着、stdout 零输出、也不退出。旧实现只能等全局超时（默认 3600s）才落终态，
  // 任务在 running 上白躺一小时（实测那次挂了 40 分钟才发现）。
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "escape") {
  // P0-2 逃逸场景：agent 派生 detached 心跳子进程（脱离 runner 进程组，模拟 agent Bash 工具的
  // 逃逸长命令），自身 hang 等待 cancel。修复前 cancel 杀不掉该子进程，心跳文件持续增长。
  emit({ type: "system", subtype: "init", session_id: "sid-esc-" + process.pid });
  const { spawn } = require("node:child_process");
  const hbChild = spawn(process.execPath, ["-e", \`
    const fs = require("node:fs");
    let i = 0;
    const t = setInterval(() => { fs.appendFileSync(process.env.HB_PATH, i++ + "\\\\n"); }, 50);
    process.on("SIGTERM", () => process.exit(0));
  \`], { detached: true, env: { ...process.env, HB_PATH: process.env.FAKE_HB }, stdio: "ignore" });
  hbChild.unref();
  try { require("node:fs").writeFileSync(process.env.FAKE_HB_PIDFILE, String(hbChild.pid)); } catch {}
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "hold-pipe") {
  // 2026-11-16 复现：agent 自己退出，但一个 detached 孙进程**继承了 stdout** ⇒ 管道写端一直开着
  // ⇒ Node 的 child 'close' 事件（进程退出 + stdio 全关）永不触发。
  // 孙进程在 agent 退出后被 init 收养（ppid=1）⇒ killTree 的后代快照扫不到它 ⇒ 杀不掉、管道不关。
  // 旧实现把「落终态」挂在 close 上 ⇒ 任务永远停在 running（2026-11-15 真实任务 task_mwhlwihp_29b736
  // 挂了 16.5 小时，最后靠人工 cancel 收场）。
  emit({ type: "system", subtype: "init", session_id: "sid-hp-" + process.pid });
  const { spawn } = require("node:child_process");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],   // 继承 stdout/stderr ⇒ 管道不会 EOF
  });
  holder.unref();
  try { require("node:fs").writeFileSync(process.env.FAKE_HOLDER_PIDFILE, String(holder.pid)); } catch {}
  process.exit(0);
} else if (mode === "quota") {
  // 配额告警场景：吐一个 429 的 api_retry 事件（claude executor 转成 quotaWarning ⇒ runner 推配额卡），
  // 然后**保持进程活着**——这样 runner 不会落终态、不会推终态卡，
  // 测试才有「只有配额卡在飞」的干净窗口（终态卡会把通知槽占掉，测不出提示通知的处境）。
  emit({ type: "system", subtype: "init", session_id: "sid-qw-" + process.pid });
  emit({ type: "system", subtype: "api_retry", error_status: 429, error: "rate limit exceeded", attempt: 1 });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "needs_input") {
  emit({ type: "system", subtype: "init", session_id: "sid-ni-" + process.pid });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "❓NEEDS_INPUT: which database engine?" }] } });
  emit({ type: "result", subtype: "success", result: "❓NEEDS_INPUT: which database engine?", is_error: false });
} else if (mode === "transient") {
  // 瞬态重试验收：用计数器文件记录这是第几次运行（runner 每次重试都是全新进程）。
  // 前 FAKE_FAIL_TIMES 次吐 429 终态报错，之后成功——验证 runner 兜底重试能救回任务。
  emit({ type: "system", subtype: "init", session_id: "sid-tr-" + process.pid });
  const fs = require("node:fs");
  const cntFile = process.env.FAKE_ATTEMPT_FILE || "/tmp/afex-attempt.txt";
  let n = 0;
  try { n = Number(fs.readFileSync(cntFile, "utf8")) || 0; } catch {}
  n++;
  try { fs.writeFileSync(cntFile, String(n)); } catch {}
  const failTimes = Number(process.env.FAKE_FAIL_TIMES ?? "2");
  if (n <= failTimes) {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "API Error: Request rejected (429) · 当前已达到 Token Plan 用量上限" }] } });
    emit({ type: "result", subtype: "error", result: "API Error: Request rejected (429) · 当前已达到 Token Plan 用量上限", is_error: true });
  } else {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } });
    emit({ type: "result", subtype: "success", result: "all done", is_error: false });
  }
} else {
  emit({ type: "system", subtype: "init", session_id: "sid-ok-" + process.pid });
  // 真实 agent 每一步都会先 Read：这条只读事件不得进 files_changed（回归护栏）
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/fake-readonly.txt" } }] } });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/fake.txt" } }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } });
  emit({ type: "result", subtype: "success", result: "all done", is_error: false });
}
`;

function setupHome(extraProfileEnv: Record<string, string> = {}, timeoutSec = 30): void {
  fakeAgent = join(home, "fake-agent.cjs");
  writeFileSync(fakeAgent, AGENT_BODY);
  chmodSync(fakeAgent, 0o755);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executors: { fake: { bin: fakeAgent, extra_flags: [] } },
    profiles: { fake: { executor: "fake", env: { PATH: process.env.PATH ?? "", ...extraProfileEnv } } },
    notify: { feishu_webhook_url: "https://example.invalid/hook", dry_run: true },
    defaults: { profile: "fake", timeout_sec: timeoutSec },
  }));
}

beforeEach(() => {
  home = mkdtempSync("/tmp/afex-int-");
  process.env.AGENT_EX_HOME = home;
  process.env.AGENT_EX_RUNNER = builtRunner;
  mkdirSync(join(home, "logs"), { recursive: true });
  setupHome();
});

afterEach(() => {
  // 兜底清理：escape 测试若失败可能残留 detached 心跳子进程，按 pidfile 追杀
  const hbPidfile = join(home, "hb-child.pid");
  try {
    if (existsSync(hbPidfile)) {
      const pid = Number(readFileSync(hbPidfile, "utf8"));
      if (pid > 0) killTree(pid);
    }
  } catch { /* 清理失败不阻断 */ }
  // hold-pipe 用例的管道持有者：它刻意逃出 killTree 的快照范围，只能按 pidfile 单独杀
  const holderPidfile = join(home, "holder.pid");
  try {
    if (existsSync(holderPidfile)) {
      const pid = Number(readFileSync(holderPidfile, "utf8"));
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* 已死 */ } }
    }
  } catch { /* 清理失败不阻断 */ }
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_EX_HOME;
  delete process.env.AGENT_EX_RUNNER;
});

// 阈值说明：这些是"挂死"的上界，不是性能断言——条件一满足就立刻返回，所以放宽只影响
// 真失败时的耗时。取值依据：本机一次 node 进程启动要加载上百个模块，文件 open 慢的机器上
// （实测 25-50ms/次 open）光启动就是 10s 级；原来的 8s/4s/5s 会把它误判成"没完成"。
async function waitForTerminal(id: string, timeoutMs = 25_000): Promise<string> {
  const db = join(home, "tasks.db");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = openStore(db).getTask(id);
    if (t && (t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "needs_input")) {
      return t.status;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout (${timeoutMs}ms) waiting terminal state for ${id}`);
}

async function waitForPidfile(path: string, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(require("node:fs").readFileSync(path, "utf8"));
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting pidfile: ${path}`);
}

function hbLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

async function waitForHbLines(path: string, min: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hbLines(path) >= min) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting heartbeat lines >= ${min}: ${path}`);
}

suite("integration: full task lifecycle", () => {
  it("submit → runner → fake-agent (ok) → completed", async () => {
    const r = await submit({ prompt: "hello", project_path: home });
    expect(r).toMatchObject({ status: "queued", rounds: 1 });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id)).toBe("completed");
    const final = status({ task_id: id }) as { status: string; result?: string };
    expect(final.result).toContain("all done");
  }, 10_000);

  // files_changed 的语义是「改过什么」，不是「碰过什么」。fake-agent 每轮先 Read 一个它从不写的
  // 文件（/tmp/fake-readonly.txt），只 Write /tmp/fake.txt —— 旧实现把 Read 也塞进 Set，此断言必红。
  it("files_changed 只记改动过的文件，Read 过的文件不算", async () => {
    const r = await submit({ prompt: "hello", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id)).toBe("completed");
    const t = openStore(join(home, "tasks.db")).getTask(id) as { files_changed: string[] };
    expect(t.files_changed).toEqual(["/tmp/fake.txt"]);
  }, 10_000);
});

suite("integration: cancel cascades to agent process", () => {
  it("cancel kills the agent; no orphans (P0-2 regression)", async () => {
    const pidfile = join(home, "agent.pid");
    setupHome({ FAKE_MODE: "hang", FAKE_PIDFILE: pidfile });
    const r = await submit({ prompt: "hang", project_path: home });
    const id = (r as { task_id: string }).task_id;
    const agentPid = await waitForPidfile(pidfile);
    expect(agentPid).toBeGreaterThan(0);
    // 确认 agent 当前还活着
    expect(() => process.kill(agentPid, 0)).not.toThrow();
    // cancel
    expect(cancel({ task_id: id })).toMatchObject({ status: "cancelled" });
    // 给进程组信号传播时间
    await new Promise((r) => setTimeout(r, 800));
    // 核心断言：agent 进程已死，**没有孤儿**
    let agentAlive: "alive" | "dead" = "dead";
    try { process.kill(agentPid, 0); agentAlive = "alive"; } catch { /* dead */ }
    expect(agentAlive).toBe("dead");
    // 确认任务确实处于 cancelled 而非别的
    expect((openStore(join(home, "tasks.db")).getTask(id) as { status: string }).status).toBe("cancelled");
  }, 10_000);
});

suite("integration: cancel kills escaped descendant process", () => {
  psRequired("detached heartbeat spawned by agent stops after cancel (P0-2 regression)", async () => {
    const pidfile = join(home, "agent.pid");
    const hbChildPidfile = join(home, "hb-child.pid");
    const hb = join(home, "hb.txt");
    setupHome({
      FAKE_MODE: "escape", FAKE_PIDFILE: pidfile,
      FAKE_HB: hb, FAKE_HB_PIDFILE: hbChildPidfile,
    });
    const r = await submit({ prompt: "escape", project_path: home });
    const id = (r as { task_id: string }).task_id;
    await waitForPidfile(pidfile);
    const hbChildPid = await waitForPidfile(hbChildPidfile);
    // 心跳进程活着且正在写文件
    await waitForHbLines(hb, 1);
    expect(() => process.kill(hbChildPid, 0)).not.toThrow();

    // cancel → killTree：进程组 + 逃逸后代树都应被清
    expect(cancel({ task_id: id })).toMatchObject({ status: "cancelled" });
    await new Promise((res) => setTimeout(res, 500));

    // 修复核心断言：逃逸的 detached 心跳子进程必须死（旧实现会继续跑）
    let childAlive: "alive" | "dead" = "dead";
    try { process.kill(hbChildPid, 0); childAlive = "alive"; } catch { /* dead */ }
    expect(childAlive).toBe("dead");
    // 心跳文件停止增长
    const linesAtStop = hbLines(hb);
    await new Promise((res) => setTimeout(res, 700));
    expect(hbLines(hb)).toBe(linesAtStop);
    expect((openStore(join(home, "tasks.db")).getTask(id) as { status: string }).status).toBe("cancelled");
  }, 15_000);
});

suite("integration: timeout kills long-running agent", () => {
  it("hang mode > timeout_sec → failed(timeout) (P1 timeout regression)", async () => {
    setupHome({ FAKE_MODE: "hang" }, 2); // timeout_sec=2
    const r = await submit({ prompt: "hang slow", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 10_000)).toBe("failed");
    const t = openStore(join(home, "tasks.db")).getTask(id) as { error?: string };
    expect(t.error).toMatch(/timeout/i);
  }, 12_000);
});

suite("integration: 首步看门狗（worker 活着但零输出）", () => {
  // 2026-11-24 回归：opencode 免费档额度耗尽时，worker 进程活着但 stdout 一行都不出、
  // 也不退出 ⇒ 旧实现只能等全局超时（默认 3600s）才落终态 ⇒ 任务在 running 上白躺一小时。
  it("stdout 一直无输出 → 看门狗判 failed（先于全局超时），错误文案点名额度/限流", async () => {
    process.env.AGENT_EX_FIRST_OUTPUT_TIMEOUT_MS = "1500";
    try {
      setupHome({ FAKE_MODE: "silent" }, 60); // timeout_sec=60：看门狗必须**先于**全局超时到
      const r = await submit({ prompt: "silent worker", project_path: home });
      const id = (r as { task_id: string }).task_id;
      expect(await waitForTerminal(id, 25_000)).toBe("failed");
      const t = openStore(join(home, "tasks.db")).getTask(id) as { error?: string; log_path?: string };
      expect(t.error).toMatch(/no output/i);
      expect(t.error).toMatch(/quota/i);
      // 只跑一次：额度是账号级共享的，重试只是白等（省一次 10 分钟白等）
      const spawns = readFileSync(t.log_path!, "utf8")
        .split("\n").filter((l) => l.includes('"event":"spawn"')).length;
      expect(spawns).toBe(1);
    } finally {
      delete process.env.AGENT_EX_FIRST_OUTPUT_TIMEOUT_MS;
    }
  }, 40_000);
});

suite("integration: timeout still reaches a terminal state when the agent never closes", () => {
  // 2026-11-16 回归：2026-11-15 的真实任务 task_mwhlwihp_29b736 在 running 挂了 16.5 小时。
  // 机制：agent 进程退出，但逃逸孙进程持有 stdout ⇒ Node 的 child 'close' 永不触发 ⇒
  // 旧实现把「落终态」挂在 close 上 ⇒ 任务永远 running，只能靠人工 cancel 收场。
  it("agent 已退出且 stdout 被逃逸孙进程持有 → 超时后任务仍落 failed(timeout)", async () => {
    const holderPidfile = join(home, "holder.pid");
    setupHome({ FAKE_MODE: "hold-pipe", FAKE_HOLDER_PIDFILE: holderPidfile }, 2); // timeout_sec=2
    const r = await submit({ prompt: "hold pipe", project_path: home });
    const id = (r as { task_id: string }).task_id;
    try {
      await waitForPidfile(holderPidfile);
      // 关键断言：超时后任务必须自己走到终态，而不是永远 running
      expect(await waitForTerminal(id, 25_000)).toBe("failed");
      const t = openStore(join(home, "tasks.db")).getTask(id) as { error?: string; ended_at?: number };
      expect(t.error).toMatch(/timeout after 2s \(round 1\)/);
      expect(t.ended_at).toBeGreaterThan(0);
    } finally {
      // 清理：RED 阶段任务不会自己终态，runner 会一直挂着 ⇒ 手动 cancel 收掉
      try { cancel({ task_id: id }); } catch { /* 已终态 */ }
    }
  }, 45_000);
});

suite("integration: 通知在飞时收到 SIGTERM", () => {
  // 2026-11-16 回归：runner 的 SIGTERM handler 只是**启动**了 Promise.race 就 process.exit(0)
  // ⇒ 通知的「回执」随进程一起消失：飞书若拒收（关键词不匹配等），notify_failed 不会被标上、
  // runner 日志里也不会有 [notifier] feishu rejected ⇒ DB 说「通知正常」、doctor 也扫不到。
  // 这里用「黑洞 webhook」（收下请求但永不响应）把通知卡在飞行中，再给 runner 发 SIGTERM。
  it("通知还没落地就退出 ⇒ notify_failed 必须被标上（回执不随进程一起丢）", async () => {
    const server = createServer(() => { /* 故意不 respond：让通知一直 in-flight */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    // 让 runner 的通知宽限走短路径（生产默认要覆盖 notifier 最坏耗时 ~35s）
    process.env.AGENT_EX_NOTIFY_GRACE_MS = "800";
    try {
      setupHome({ FAKE_MODE: "ok" }, 30);
      // 真发（dry_run=false）到本地黑洞 webhook
      writeFileSync(join(home, "config.json"), JSON.stringify({
        executors: { fake: { bin: fakeAgent, extra_flags: [] } },
        profiles: { fake: { executor: "fake", env: { PATH: process.env.PATH ?? "" } } },
        notify: { feishu_webhook_url: `http://127.0.0.1:${port}/hook`, dry_run: false },
        defaults: { profile: "fake", timeout_sec: 30 },
      }));
      const r = await submit({ prompt: "notify in flight", project_path: home });
      const id = (r as { task_id: string }).task_id;
      const readTask = () => openStore(join(home, "tasks.db")).getTask(id) as
        { pid: number; notify_failed: boolean; status: string };
      // 任务已终态 ⇒ 卡片此刻正在飞
      expect(await waitForTerminal(id, 15_000)).toBe("completed");
      const pid = readTask().pid;
      expect(pid).toBeGreaterThan(0);
      // 模拟宿主拆进程树：给 runner 发 SIGTERM
      process.kill(pid, "SIGTERM");
      // runner 不该「静默退出」：等它把「通知没落地」标进 DB
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !readTask().notify_failed) {
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(readTask().notify_failed).toBe(true);
    } finally {
      delete process.env.AGENT_EX_NOTIFY_GRACE_MS;
      server.close();
    }
  }, 40_000);
});

suite("integration: 配额告警卡在飞时收到 SIGTERM", () => {
  // 2026-11-16 回归：配额告警卡是 fire-and-forget，**不进 pendingNotify**
  // ⇒ SIGTERM（cancel / 宿主拆进程树）时 runner 直接 process.exit(0)，
  // 在飞的飞书请求被掐断 ⇒「这个任务正在配额上要挂了」的早期告警**静默丢失**。
  // 本地 webhook 收下请求后延迟 2.5s 才响应 ⇒ 卡确定在飞；此时给 runner 发 SIGTERM。
  it("配额告警卡在飞时收到 SIGTERM ⇒ runner 得等它落地再退出，卡不能被掐断", async () => {
    const received: string[] = [];
    let truncated = false;   // 响应写完前连接就断了 ⇒ 进程退出把请求掐了
    let responded = false;   // 响应完整写回
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        received.push(body);
        // ⚠️ close/finish 必须在**收到请求时就挂上**：客户端提前断开时，
        // 'close' 早于响应定时器触发，那时再挂就收不到了。
        let finished = false;
        res.on("finish", () => { finished = true; responded = true; });
        res.on("close", () => { if (!finished) truncated = true; });
        res.on("error", () => { /* 客户端已断开：写响应失败属预期 */ });
        // 延迟响应 ⇒ 此刻这张卡还在飞
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 0, msg: "ok" }));
        }, 2500);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const pidfile = join(home, "agent.pid");
    try {
      setupHome({ FAKE_MODE: "quota", FAKE_PIDFILE: pidfile }, 30);
      writeFileSync(join(home, "config.json"), JSON.stringify({
        executors: { fake: { bin: fakeAgent, extra_flags: [] } },
        profiles: {
          fake: {
            executor: "fake",
            env: { PATH: process.env.PATH ?? "", FAKE_MODE: "quota", FAKE_PIDFILE: pidfile },
          },
        },
        notify: { feishu_webhook_url: `http://127.0.0.1:${port}/hook`, dry_run: false },
        defaults: { profile: "fake", timeout_sec: 30 },
      }));
      const r = await submit({ prompt: "quota warning", project_path: home });
      const id = (r as { task_id: string }).task_id;
      // 等配额卡到达本地 webhook ⇒ 它此刻正在飞
      const arrived = Date.now() + 10_000;
      while (Date.now() < arrived && received.length === 0) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(received.length).toBe(1);
      expect(received[0]).toContain("配额告警");
      const pid = (openStore(join(home, "tasks.db")).getTask(id) as { pid: number }).pid;
      expect(pid).toBeGreaterThan(0);
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };

      // 模拟宿主拆进程树：给 runner 发 SIGTERM
      process.kill(pid, "SIGTERM");
      // 卡还没落地（webhook 要 2.5s 才回）⇒ runner 不能此刻就退出
      await new Promise((res) => setTimeout(res, 700));
      expect(alive()).toBe(true);

      // 最终它得退出（SIGTERM 被处理了），而且退出前卡已送达
      const exited = Date.now() + 15_000;
      while (Date.now() < exited && alive()) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(alive()).toBe(false);
      expect({ truncated, responded }).toEqual({ truncated: false, responded: true });
      // runner 退了 ⇒ agent 必须跟着死。宿主只 SIGTERM 了 runner 本体（没杀组），
      // agent 若还活着就是**孤儿**：没人杀它、没人读它的输出，它会一直烧 token。
      const agentPid = Number(readFileSync(pidfile, "utf8"));
      expect(agentPid).toBeGreaterThan(0);
      const agentGone = await (async () => {
        const dl = Date.now() + 6000;
        while (Date.now() < dl) {
          try { process.kill(agentPid, 0); } catch { return true; }
          await new Promise((res) => setTimeout(res, 50));
        }
        return false;
      })();
      expect(agentGone).toBe(true);
    } finally {
      // agent 还在跑（runner 退出不等于 agent 被杀）——按 pidfile 收尾
      try {
        const apid = Number(readFileSync(pidfile, "utf8"));
        if (apid > 0) { try { process.kill(apid, "SIGKILL"); } catch { /* 已死 */ } }
      } catch { /* 无 pidfile */ }
      server.close();
    }
  }, 40_000);

  // 不变式：**只有终态卡**决定 notify_failed。配额告警卡被掐断（黑洞）⇒
  // 宽限耗尽时不能因为它而标 notify_failed——那是终态卡的账。
  // 这里让 webhook 对**第一张（配额卡）永不响应**、对第二张（终态卡）正常响应：
  // 两张卡命运不同，才能把「配额卡失败」和「终态卡失败」分开验。
  it("配额卡被掐断也不许标 notify_failed（那是终态卡的账）", async () => {
    let seen = 0;
    const server = createServer((req, res) => {
      seen++;
      const n = seen;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (n === 1) return; // 第一张（配额卡）：收下但永不响应 ⇒ 永远在飞
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, msg: "ok" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const pidfile = join(home, "agent.pid");
    // 宽限走短路径（生产默认 40s 是为了盖住 notifier 最坏耗时 ~35s）
    process.env.AGENT_EX_NOTIFY_GRACE_MS = "2000";
    try {
      setupHome({ FAKE_MODE: "quota", FAKE_PIDFILE: pidfile }, 30);
      writeFileSync(join(home, "config.json"), JSON.stringify({
        executors: { fake: { bin: fakeAgent, extra_flags: [] } },
        profiles: {
          fake: {
            executor: "fake",
            env: { PATH: process.env.PATH ?? "", FAKE_MODE: "quota", FAKE_PIDFILE: pidfile },
          },
        },
        notify: { feishu_webhook_url: `http://127.0.0.1:${port}/hook`, dry_run: false },
        defaults: { profile: "fake", timeout_sec: 30 },
      }));
      const r = await submit({ prompt: "quota warning black hole", project_path: home });
      const id = (r as { task_id: string }).task_id;
      const db = join(home, "tasks.db");
      const readTask = () => openStore(db).getTask(id) as { pid: number; notify_failed: boolean };
      // 等配额卡发出去（webhook 收到第一张）
      const arrived = Date.now() + 10_000;
      while (Date.now() < arrived && seen < 1) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(seen).toBe(1);
      const pid = readTask().pid;
      expect(pid).toBeGreaterThan(0);
      process.kill(pid, "SIGTERM");
      // 收尾会落一张终态卡（第二张）⇒ 它正常送达 ⇒ 终态通知已落地
      const second = Date.now() + 10_000;
      while (Date.now() < second && seen < 2) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(seen).toBe(2);
      // runner 最终退出（宽限耗尽 ⇒ 它不等那张永远不回的配额卡）
      const exited = Date.now() + 15_000;
      while (Date.now() < exited) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise((res) => setTimeout(res, 50));
      }
      // 终态卡已送达 ⇒ 不能标 notify_failed（配额卡被掐断不算终态通知失败）
      expect(readTask().notify_failed).toBe(false);
      // 宽限耗尽这件事要留下痕迹（否则「没人等」和「等了但没到」分不清）
      expect(readFileSync(join(home, "logs", `runner-${id}.log`), "utf8")).toContain("notify grace exhausted");
    } finally {
      delete process.env.AGENT_EX_NOTIFY_GRACE_MS;
      try {
        const apid = Number(readFileSync(pidfile, "utf8"));
        if (apid > 0) { try { process.kill(apid, "SIGKILL"); } catch { /* 已死 */ } }
      } catch { /* 无 pidfile */ }
      server.close();
    }
  }, 40_000);
});

suite("integration: 通知日志的卡片标签", () => {
  // 2026-11-17：doctor 要把「配额告警卡被拒收」与「终态卡被拒收」分桶——
  // 前者在 DB 里不写 notify_failed，后者写 ⇒ 两件事混在一起就是「口径矛盾」。
  // 桶靠日志里的 card= 标签区分 ⇒ runner 必须真的给每张卡打标签。
  it("配额卡与终态卡各带各的标签 ⇒ doctor 分桶后与 notify_failed 同一口径", async () => {
    let seen = 0;
    const server = createServer((req, res) => {
      seen++;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        // 一律拒收（HTTP 200 + code=19024）⇒ 两张卡都会留下 [notifier] feishu rejected
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 19024, msg: "Key Words Not Found" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const pidfile = join(home, "agent.pid");
    try {
      setupHome({ FAKE_MODE: "quota", FAKE_PIDFILE: pidfile }, 30);
      writeFileSync(join(home, "config.json"), JSON.stringify({
        executors: { fake: { bin: fakeAgent, extra_flags: [] } },
        profiles: {
          fake: {
            executor: "fake",
            env: { PATH: process.env.PATH ?? "", FAKE_MODE: "quota", FAKE_PIDFILE: pidfile },
          },
        },
        notify: { feishu_webhook_url: `http://127.0.0.1:${port}/hook`, dry_run: false },
        defaults: { profile: "fake", timeout_sec: 30 },
      }));
      const r = await submit({ prompt: "card labels", project_path: home });
      const id = (r as { task_id: string }).task_id;
      // 等配额卡发出去（webhook 收到请求）
      const arrived = Date.now() + 10_000;
      while (Date.now() < arrived && seen < 1) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(seen).toBeGreaterThanOrEqual(1);
      const pid = (openStore(join(home, "tasks.db")).getTask(id) as { pid: number }).pid;
      expect(pid).toBeGreaterThan(0);
      // 收尾 ⇒ runner 落一张终态卡（failed）⇒ 日志里两张卡的标签必须能区分
      process.kill(pid, "SIGTERM");
      const exited = Date.now() + 30_000;
      while (Date.now() < exited) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise((res) => setTimeout(res, 50));
      }
      const log = readFileSync(join(home, "logs", `runner-${id}.log`), "utf8");
      expect(log).toContain("card=quota_warning");
      expect(log).toContain("card=failed");
      // doctor 分桶：配额卡是提示级、终态卡是任务级（任务级与 DB 的 notify_failed 同一口径）
      const s = scanNotifyFailures(home);
      expect(s.advisory_logs).toBe(1);
      expect(s.logs_with_rejects).toBe(1);
      expect(s.advisory_by_code["19024"]).toBeGreaterThan(0);
      expect(s.by_code["19024"]).toBeGreaterThan(0);
    } finally {
      try {
        const apid = Number(readFileSync(pidfile, "utf8"));
        if (apid > 0) { try { process.kill(apid, "SIGKILL"); } catch { /* 已死 */ } }
      } catch { /* 无 pidfile */ }
      server.close();
    }
  }, 60_000);
});

suite("integration: cancel 撞上在飞的配额卡", () => {
  // 2026-11-16 评审发现：cancel 走 killTree，**3s 后对整个进程组补 SIGKILL**
  // （src/proc-tree.ts 的 graceMs 默认 3000）⇒ 正在排空通知的 runner 会被硬杀，
  // 排在飞通知的回执随之丢失（卡本身早 flush 给飞书了，丢的是「飞书收没收」）。
  // 这里让 webhook 延迟 6s 才响应（> 3s 的 SIGKILL 宽限）⇒ runner 必须活过那一刀。
  it("宿主的 SIGKILL 不能掐断 runner 的排空 ⇒ 卡必须等到回执", async () => {
    const received: string[] = [];
    let truncated = false;
    let responded = false;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        received.push(body);
        let finished = false;
        res.on("finish", () => { finished = true; responded = true; });
        res.on("close", () => { if (!finished) truncated = true; });
        res.on("error", () => { /* 客户端已断开 */ });
        // 6s > killTree 的 3s SIGKILL 宽限 ⇒ 旧实现必被砍在这之前
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 0, msg: "ok" }));
        }, 6000);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const pidfile = join(home, "agent.pid");
    try {
      setupHome({ FAKE_MODE: "quota", FAKE_PIDFILE: pidfile }, 60);
      writeFileSync(join(home, "config.json"), JSON.stringify({
        executors: { fake: { bin: fakeAgent, extra_flags: [] } },
        profiles: {
          fake: {
            executor: "fake",
            env: { PATH: process.env.PATH ?? "", FAKE_MODE: "quota", FAKE_PIDFILE: pidfile },
          },
        },
        notify: { feishu_webhook_url: `http://127.0.0.1:${port}/hook`, dry_run: false },
        defaults: { profile: "fake", timeout_sec: 60 },
      }));
      const r = await submit({ prompt: "cancel during quota card", project_path: home });
      const id = (r as { task_id: string }).task_id;
      // 等配额卡到达 webhook ⇒ 它此刻正在飞
      const arrived = Date.now() + 10_000;
      while (Date.now() < arrived && received.length === 0) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(received.length).toBe(1);
      // 走真实 cancel：killTree → SIGTERM 组播 → 3s 后 SIGKILL 组播
      cancel({ task_id: id });
      // 等回执落地（webhook 6s 才回）⇒ 卡必须送达、不能被 SIGKILL 砍掉
      const settled = Date.now() + 20_000;
      while (Date.now() < settled && !responded && !truncated) {
        await new Promise((res) => setTimeout(res, 100));
      }
      expect({ truncated, responded }).toEqual({ truncated: false, responded: true });
    } finally {
      try {
        const apid = Number(readFileSync(pidfile, "utf8"));
        if (apid > 0) { try { process.kill(apid, "SIGKILL"); } catch { /* 已死 */ } }
      } catch { /* 无 pidfile */ }
      server.close();
    }
  }, 45_000);
});

suite("integration: 通知的 webhook 解析失败", () => {
  // 2026-11-16 回归：webhook 写成 {env:VAR} 而变量缺失时 resolveEnvPlaceholders **抛错**。
  // 旧代码两处都没接：
  // - finalize：异常穿出 main ⇒ exit(1)，而 DB 早已落终态 ⇒ notify_failed=0、没有卡
  //   （注释写着「缺变量时抛错 → notify_failed」，承诺没兑现）；
  // - pushQuotaWarning：异常抛在 rl.on("line") 里 ⇒ uncaughtException ⇒ runner 当场死
  //   ⇒ 任务永远停在 running（2026-11-15 那类「卡在 running」的另一个成因）。
  it("终态卡的 webhook 解析失败 ⇒ 标 notify_failed，不能让 runner 崩掉", async () => {
    setupHome({}, 30);
    writeFileSync(join(home, "config.json"), JSON.stringify({
      executors: { fake: { bin: fakeAgent, extra_flags: [] } },
      profiles: { fake: { executor: "fake", env: { PATH: process.env.PATH ?? "" } } },
      notify: { feishu_webhook_url: "{env:AFEX_MISSING_WEBHOOK}", dry_run: false },
      defaults: { profile: "fake", timeout_sec: 30 },
    }));
    const r = await submit({ prompt: "broken webhook", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 15_000)).toBe("completed");
    const t = openStore(join(home, "tasks.db")).getTask(id) as { notify_failed: boolean };
    expect(t.notify_failed).toBe(true);
  }, 30_000);

  it("配额告警的 webhook 解析失败 ⇒ runner 不能崩，任务要走到终态", async () => {
    const pidfile = join(home, "agent.pid");
    setupHome({ FAKE_MODE: "quota", FAKE_PIDFILE: pidfile }, 6);
    writeFileSync(join(home, "config.json"), JSON.stringify({
      executors: { fake: { bin: fakeAgent, extra_flags: [] } },
      profiles: {
        fake: {
          executor: "fake",
          env: { PATH: process.env.PATH ?? "", FAKE_MODE: "quota", FAKE_PIDFILE: pidfile },
        },
      },
      notify: { feishu_webhook_url: "{env:AFEX_MISSING_WEBHOOK}", dry_run: false },
      defaults: { profile: "fake", timeout_sec: 6 },
    }));
    try {
      const r = await submit({ prompt: "quota + broken webhook", project_path: home });
      const id = (r as { task_id: string }).task_id;
      // runner 若死在 rl.on("line") 的异常里 ⇒ 任务永远停在 running ⇒ 这里超时失败
      expect(await waitForTerminal(id, 20_000)).toBe("failed");
    } finally {
      // runner 崩掉时 agent 会变孤儿（没人杀它）——按 pidfile 收尾，别把进程漏到机器上
      try {
        const apid = Number(readFileSync(pidfile, "utf8"));
        if (apid > 0) { try { process.kill(apid, "SIGKILL"); } catch { /* 已死 */ } }
      } catch { /* 无 pidfile */ }
    }
  }, 30_000);
});

suite("integration: runner 崩溃不留孤儿", () => {
  // 2026-11-17 实测：runner 崩了（uncaughtException）之后 agent 以 PPID=1 活到人工清理
  // ⇒ 持续烧 token。Node 的默认行为是「打印栈然后退」，没有机会收尾 ⇒ 必须自己装处理器。
  // 这里用编译产物跑一个最小 runner：登记一个长驻子进程 → 装致命异常处理器 → 异步抛异常。
  it("致命异常 ⇒ 先收掉 agent 再退（不留孤儿）", async () => {
    const script = join(home, "crash-child.mjs");
    const gcPidfile = join(home, "grandchild.pid");
    writeFileSync(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { attachAgent, installFatalAgentCleanup } from ${JSON.stringify(join(repoRoot, "dist", "agent-guard.js"))};
const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(gcPidfile)}, String(gc.pid));
attachAgent(gc.pid);
installFatalAgentCleanup();
setTimeout(() => { throw new Error("boom"); }, 50);
`);
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const code = await new Promise<number | null>((res) => child.on("close", (c) => res(c)));
    expect(stderr).toContain("uncaughtException");
    expect(code).toBe(1);
    // 孙进程必须跟着死（不能以 PPID=1 变孤儿继续跑）
    const gcPid = Number(readFileSync(gcPidfile, "utf8"));
    expect(gcPid).toBeGreaterThan(0);
    const gone = await (async () => {
      const dl = Date.now() + 6000;
      while (Date.now() < dl) {
        try { process.kill(gcPid, 0); } catch { return true; }
        await new Promise((res) => setTimeout(res, 50));
      }
      return false;
    })();
    expect(gone).toBe(true);
  }, 30_000);
});

suite("integration: needs_input → continue → completed", () => {
  it("first round needs_input; submit(continue_of) re-spawns runner; second round completed", async () => {
    // 第一轮
    setupHome({ FAKE_MODE: "needs_input" });
    const r1 = await submit({ prompt: "ask me", project_path: home });
    const id = (r1 as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 8_000)).toBe("needs_input");

    // 切到 ok 模式，让续跑直接成功
    setupHome({ FAKE_MODE: "ok" });
    const r2 = await submit({ prompt: "answer", continue_of: id, project_path: home });
    expect(r2).toMatchObject({ task_id: id, status: "running", rounds: 2 });
    expect(await waitForTerminal(id, 10_000)).toBe("completed");
    const t = openStore(join(home, "tasks.db")).getTask(id) as { status: string; rounds: number; result?: string };
    expect(t.status).toBe("completed");
    expect(t.rounds).toBe(2);
    expect(t.result).toContain("all done");
  }, 20_000);
});

suite("integration: concurrent submits", () => {
  // 并发安全：N 个任务同时提交到同一 home（共享 tasks.db），全部应各自进入终态、互不串扰。
  // SQLite WAL 模式保证 transition 原子性；本测试主要验证：
  //   1) 没有 task_id 重复 / 数据库错误
  //   2) 每个任务都到 completed（状态机不冲突）
  //   3) 日志文件按 task_id 隔离（不互踩）
  it("N parallel submits → all completed; no DB conflicts (concurrent regression)", async () => {
    const N = 4;
    const t0 = Date.now();
    const rs = await Promise.all(
      Array.from({ length: N }, (_, i) => submit({ prompt: `parallel-${i}`, project_path: home })),
    );
    const ids = rs.map((r) => (r as { task_id: string }).task_id);
    // task_id 互不重复
    expect(new Set(ids).size).toBe(N);
    // 全部进入终态（completed）。并发的 runner 各自 spawn fake-agent，互不冲突。
    await Promise.all(ids.map((id) => waitForTerminal(id, 15_000).then((s) => {
      expect({ id, s }).toEqual({ id, s: "completed" });
    })));
    // 每个 task 的 result 都填了，且 logs/ 下都有对应 jsonl
    const db = join(home, "tasks.db");
    for (const id of ids) {
      const t = openStore(db).getTask(id) as { status: string; result?: string };
      expect(t.status).toBe("completed");
      expect(t.result).toContain("all done");
      expect(existsSync(join(home, "logs", `${id}.jsonl`))).toBe(true);
    }
    // 端到端执行时间 sanity check：4 个任务并发跑（fake-agent 每轮 <200ms），整轮 < 8s
    expect(Date.now() - t0).toBeLessThan(8_000);
  }, 20_000);
});

suite("integration: transient API error retry (P0)", () => {
  it("retries on 429 and completes after transient failures", async () => {
    process.env.AGENT_EX_RETRY_BACKOFF_MS = "50,50";
    const attemptFile = join(home, "attempt.txt");
    setupHome({ FAKE_MODE: "transient", FAKE_ATTEMPT_FILE: attemptFile, FAKE_FAIL_TIMES: "2" });
    const r = await submit({ prompt: "do work", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 12_000)).toBe("completed");
    const final = status({ task_id: id }) as { status: string; result?: string };
    expect(final.result).toContain("all done");
    // 前两次 429 各产生一条 _retry 标记；第 3 次成功不再重试
    const log = readFileSync(join(home, "logs", `${id}.jsonl`), "utf8");
    expect(log.split("\n").filter((l) => l.includes('"_retry"')).length).toBe(2);
    // 计数器到 3：runner 共运行 3 次（2 次重试 + 1 次成功）
    expect(Number(readFileSync(attemptFile, "utf8"))).toBe(3);
    delete process.env.AGENT_EX_RETRY_BACKOFF_MS;
  }, 15_000);

  it("gives up after MAX_ATTEMPTS when 429 never recovers", async () => {
    process.env.AGENT_EX_RETRY_BACKOFF_MS = "50,50";
    const attemptFile = join(home, "attempt.txt");
    setupHome({ FAKE_MODE: "transient", FAKE_ATTEMPT_FILE: attemptFile, FAKE_FAIL_TIMES: "99" });
    const r = await submit({ prompt: "do work", project_path: home });
    const id = (r as { task_id: string }).task_id;
    expect(await waitForTerminal(id, 12_000)).toBe("failed");
    const log = readFileSync(join(home, "logs", `${id}.jsonl`), "utf8");
    // MAX_ATTEMPTS=3 → 仅 2 次重试（第 3 次失败即终态 failed）
    expect(log.split("\n").filter((l) => l.includes('"_retry"')).length).toBe(2);
    expect(Number(readFileSync(attemptFile, "utf8"))).toBe(3);
    delete process.env.AGENT_EX_RETRY_BACKOFF_MS;
  }, 15_000);
});
