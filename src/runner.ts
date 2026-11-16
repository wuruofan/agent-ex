/**
 * detached runner 入口：node runner.ts <task_id>
 * 生命周期：认领任务 → 组装命令 → spawn agent(detached) → 逐行解析事件/落库/写日志 → 终态 + 通知。
 */
import { appendFileSync, createWriteStream, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { openStore, type Task, type TaskPatch } from "./store.js";
import { loadConfig, resolveEnvPlaceholders } from "./config.js";
import { getExecutor } from "./executors/types.js";
import { isFileMutatingTool } from "./executors/file-tools.js";
import { buildAgentEnv } from "./agent-env.js";
import { wrapInitialPrompt, wrapContinuePrompt, extractNeedsInput } from "./prompt.js";
import { resolveZenFreeEnv } from "./zen-free.js";
import { profileModelLabel } from "./model-check.js";
import { sendFeishuCard, buildFeishuCard } from "./notifier.js";
import { dbPath } from "./paths.js";
import { killTree } from "./proc-tree.js";

const MAX_ROUNDS = 5;
/**
 * 通知等待的宽限：进程退出前最多等通知落地多久。
 *
 * 默认 40s —— 必须盖过 notifier 自己的最坏耗时（`notifier.ts` 的 post()：3 次尝试 × 10s
 * 超时 + 1s/4s 退避 ≈ 35s），否则「通知其实失败了、回执却被进程退出带走」会重演。
 * 可用 AGENT_EX_NOTIFY_GRACE_MS 覆盖（毫秒）—— 集成测试走短宽限。
 */
const NOTIFY_GRACE_MS = (() => {
  const v = Number(process.env.AGENT_EX_NOTIFY_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 40_000;
})();
const MAX_RESULT_LEN = 4000;

/**
 * 超时后「强制收尾」的宽限：超时定时器触发后，再等这么久让 agent 自己走 close 路径。
 *
 * 为什么需要它（2026-11-16 定位的真实故障 task_mwhlwihp_29b736）：
 * 旧实现把「落终态」挂在 child 的 'close' 事件上（进程退出 **且** stdio 全关）。
 * 只要有**逃逸孙进程持有 stdout**（agent 自己退出、孙进程被 init 收养、killTree 的
 * ppid 快照扫不到它），管道写端就一直开着 ⇒ 'close' 永不触发 ⇒ 任务永远停在 running。
 * 实测那次挂了 16.5 小时，最后靠人工 cancel 收场。
 *
 * 宽限取 8s：killTree 内部在 SIGTERM 后 3s 补 SIGKILL，留 5s 余量给「能被杀掉的 agent」
 * 走正常 close 路径；超过宽限仍无 close ⇒ agent 侧已卡死，不能再等，直接落终态。
 */
const TIMEOUT_FINALIZE_GRACE_MS = 8000;

// 瞬态重试：agent 自身内部重试耗尽后仍把 429/529 当作终态报错时，runner 再兜底重试。
// 仅对「瞬时/可恢复」错误重试；timeout（真超时）、needs_input（等人工）、硬失败不重试。
const MAX_ATTEMPTS = 3;
// 退避可用 AGENT_EX_RETRY_BACKOFF_MS 覆盖（逗号分隔，毫秒），便于集成测试走短退避；生产默认 30s/60s。
const RETRY_BACKOFF_MS = (process.env.AGENT_EX_RETRY_BACKOFF_MS ?? "30000,60000")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

/** 判断 agent 终态报错是否为可重试的瞬时错误（429 限流 / 529 集群过载 / 5xx / 连接重置 / 配额临时不可用）。 */
function isTransientError(text: string | null): boolean {
  if (!text) return false;
  const patterns = [
    /\b429\b/,                 // Too Many Requests / Token Plan 上限
    /\b529\b/,                 // MiniMax 集群过载
    /\b50[234]\b/,             // 502/503/504 网关/服务临时不可用
    /token plan/i,
    /用量上限/,
    /集群负载/,
    /request rejected/i,
    /rate.?limit/i,
    /econnreset|etimedout|socket hang up|fetch failed|connection reset|upstream connect error/i,
    /try again|稍后重试/i,
  ];
  return patterns.some((p) => p.test(text));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 单次 agent 运行的结果快照（供重试循环与终态裁决共用）。 */
interface RunOutcome {
  timedOut: boolean;
  question: string | null;
  resultText: string | null;
  resultIsError: boolean;
  stderrTail: string;
  lastAssistantText: string;
  code: number | null;
}

/** 当前轮 finalize 启动的通知 promise；SIGTERM handler 等待它完成（防止被截断导致 notify_failed 未落库）。 */
let pendingNotify: Promise<void> | null = null;

/**
 * 等当前通知落地后退出进程；宽限耗尽仍未落地 ⇒ 先把「通知没送达」标进 DB 再走。
 *
 * 为什么不能直接 exit：飞书卡片是「任务已终态」唯一的对外信号，进程先走会把在飞的请求掐断，
 * **回执**（成功 / 被拒收 code=19024 等）随之一并丢失 ⇒ DB 显示 notify_failed=0（通知正常）、
 * runner 日志里也不会有 `[notifier] feishu rejected` ⇒ doctor 扫日志也扫不到 ⇒ 静默失败。
 * （2026-11-16 实测：旧 SIGTERM handler 只是**启动**了 Promise.race 就 process.exit(0)，等于没等。）
 *
 * 宽限耗尽时标 notify_failed 是保守但诚实的：这次退出会掐断请求，卡片多半真没送达；
 * 反过来若不标，DB 就会替一张没送到的卡背书。
 */
async function exitAfterNotify(
  store: ReturnType<typeof openStore>,
  task: Task,
): Promise<void> {
  if (pendingNotify) {
    const settled = await Promise.race([
      // 成功或失败都算「落地了」：失败时 finalize 的 .then 已经把 notify_failed 标上了。
      pendingNotify.then(() => true, () => true),
      sleep(NOTIFY_GRACE_MS).then(() => false),
    ]);
    if (!settled) {
      try { store.patch(task.id, { notify_failed: true }); } catch { /* best effort */ }
    }
  }
  process.exit(0);
}

/**
 * 本次运行**实际用到的**模型（zen-free 占位符解析后才非空），只用于卡片底部小字。
 *
 * 为什么让它当模块级变量：runner 是单任务进程（一次只跑一个 task），而终态由 finalize /
 * pushQuotaWarning 两个模块级函数收尾，模型却只有 main 的重试循环里解析得出来
 * （`resolveZenFreeEnv` 每次 attempt 前重算，撞限会换模）。穿参得改两处签名、还要一路透传，
 * 换来的是"更纯"——但这里没有第二个调用方，纯度没有承接者。
 */
let activeModel: string | null = null;

/**
 * 卡片底部小字：这次用哪个 profile、哪个模型跑的（与 keyword 同一行，见 notifier.ts）。
 *
 * 只列事实、不加 `profile：`/`模型：` 标签——三个值都是标识符，位置即语义，
 * 标签只会让这行 12px 灰字变长、挤在一起反而不好扫（2026-11-10 用户定的格式）。
 * 模型取不到（opencode 可以完全不声明模型，走它自己的全局配置）就只留 profile：
 * 宁可少一个字段，也不写"默认模型"这种既不精确又占位的词。
 */
function cardFooter(task: Task, cfg: Awaited<ReturnType<typeof loadConfig>>): string {
  const model = activeModel ?? profileModelLabel(cfg.profiles[task.profile]?.env);
  return model ? `${task.profile}  ·  ${model}` : task.profile;
}

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) { console.error("usage: runner.ts <task_id>"); process.exit(2); }

  // 这里刻意**不** close：runner 是任务级短命进程（分钟级），整个生命周期就用这一个连接，
  // 进程退出即由内核释放 —— 这本来就是 SQLite 设计的正常关机路径，且不会有连接累积。
  // 需要显式 close 的是 server 侧的按需开库（submit/status/cancel），见 store.ts。
  const store = openStore(dbPath());
  const task = store.getTask(taskId)!; // 非空断言仅供闭包内类型窄化；下一行运行时 guard 兜底
  if (!task) { console.error(`task ${taskId} not found`); process.exit(2); }
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    console.error(`task ${taskId} already terminal (${task.status}); exiting`);
    process.exit(0);
  }

  if (!store.claimToRunning(taskId, process.pid)) {
    const cur = store.getTask(taskId);
    console.error(`claim failed, task is ${cur?.status ?? "gone"}; exiting`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const executorCfg = cfg.executors[task.executor];
  const executor = getExecutor(task.executor);
  const profile = cfg.profiles[task.profile];
  const profileEnv = profile?.env ?? {};
  const pathDirs = profile?.path_dirs;

  // 本轮原始输入：round1 用 task.prompt；续跑轮从日志读 server 预写的 user_prompt 行
  const rawInput = task.rounds === 1 ? task.prompt : readRoundInput(task.log_path, task.rounds);
  if (rawInput === null) {
    finalize(store, task, "failed", { error: `round ${task.rounds} input not found in log` }, cfg);
    return;
  }
  const prompt = task.rounds === 1 ? wrapInitialPrompt(rawInput, task.timeout_sec) : wrapContinuePrompt(rawInput, task.timeout_sec);
  appendFileSync(task.log_path, JSON.stringify({ type: "user_prompt", round: task.rounds, text: rawInput }) + "\n");
  // cancel 场景：server 端 killTree(runnerPid)（组杀 runner + agent；逃逸子进程靠 ppid 快照补杀）。
  // 真正**等**通知落地再退出（不是只启动 race 就走）——回执丢了就是静默失败，见 exitAfterNotify。
  process.on("SIGTERM", () => {
    void exitAfterNotify(store, task);
  });

  // 配额/限流告警单任务只推一次（任务级去重，不依赖 DB 字段）。
  // runner 崩了 SIGTERM 整体收尾不再触发告警，故无需持久化。
  let quotaWarned = false;

  // 超时的错误文案：超时定时器与「强制收尾」两处共用，保证 DB 里与卡片上的说法一致。
  const timeoutError = `timeout after ${task.timeout_sec}s (round ${task.rounds})`;
  // 本次运行是否已经由「强制收尾」路径落过终态（避免 close 到达后再 finalize 一次）。
  let timeoutFinalized = false;

  // 单次 agent 运行：spawn → 逐行解析事件/落库/写日志 → 终态时 resolve 出本次运行结果。
  // 不设 detached：agent 继承 runner 的进程组（runner 自己是 leader），便于 cancel 时组杀级联到 agent。
  // 注意：agent 的 Bash 工具可能派生出逃出该组的子进程（见 proc-tree.ts），cancel/timeout 用 killTree 兜底。
  // agentEnv 由调用方（重试循环）在每次 attempt 前构建：zen-free 占位符的动态解析结果随 attempt 变化（撞限换模）。
  function runAgent(attempt: number, agentEnv: NodeJS.ProcessEnv): Promise<RunOutcome> {
    return new Promise((resolve) => {
      timeoutFinalized = false;
      const files = new Set<string>(task.files_changed ?? []);
      const log = createWriteStream(task.log_path, { flags: "a" });
      // buildCommand 返回的完整 argv 含 bin 作为 [0]；spawn 的第一个参数**也**是 bin。
      // Node 的 spawn 不会替换 argv[0]，只会补一个 —— 两者叠加，child 实际收到
      // `[0]=bin(自身) [1]=bin [2]=run ...`，即 bin 被夹带成子命令的第一个位置参数。
      // opencode 会把它当 prompt 吞掉 → 参数解析失败、打 help、exit 1（2026-10-08 e2e 实测）。
      // claude CLI 忽略位置参数，所以这个 bug 一直潜伏、只有 opencode 暴露。
      // 故这里必须切掉 argv[0] 再交给 spawn。
      const fullArgv = executor.buildCommand(executorCfg.bin, executorCfg.extra_flags ?? [], task.session_id ?? undefined);
      // 守卫：executor 若返回 [bin, bin, ...] 这类重复，去掉多余的前导bin（否则同样会被当位置参数）。
      const argv = fullArgv[0] === executorCfg.bin ? fullArgv.slice(1) : fullArgv;
      if (argv[0] === executorCfg.bin) {
        log.write(JSON.stringify({ type: "_runner", event: "argv_guard", duplicate_bin: true }) + "\n");
        argv.shift();
      }
      const child: ChildProcess = spawn(executorCfg.bin, argv, {
        cwd: task.project_path,
        env: agentEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      log.write(JSON.stringify({ type: "_runner", event: "spawn", argv: fullArgv, round: task.rounds, attempt, child_pid: child.pid }) + "\n");
      child.stdin!.write(prompt);
      child.stdin!.end();

      let timedOut = false;
      // 超时后的「强制收尾」定时器：见 TIMEOUT_FINALIZE_GRACE_MS 的说明。
      // **不 unref**：它必须能把 runner 的事件循环钉住，宽限期内进程不能静默退出。
      let forceFinalizeTimer: NodeJS.Timeout | null = null;
      let lastAssistantText = "";
      let resultText: string | null = null;
      let resultIsError = false;
      let stderrTail = "";
      // 每轮超时：killTree(child.pid) 给 agent 发 SIGTERM（含其后代树，覆盖 agent Bash 工具逃出进程组的
      // 长命令子进程），3s 后未驯服者自动补 SIGKILL（killTree 内部兜底）。agent 退出后 child.close 触发，
      // 本次运行标记为 timedOut。
      // 注意：避免 kill(-process.pid) 给整个进程组——那会让 runner 自己 SIGTERM 跳过 child.close 处理；
      // killTree 只从 child.pid 向下清，不动 runner 所在的组根。
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) killTree(child.pid);
        // 兜底：agent 若在宽限期内不退出（逃逸孙进程持有 stdout / 进程卡在不可中断 IO），
        // 'close' 永不触发 ⇒ 靠 close 落终态会永远落不了 ⇒ 宽限一过就自己落终态，不等 close。
        forceFinalizeTimer = setTimeout(() => {
          timeoutFinalized = true;
          const text = (resultText ?? lastAssistantText ?? "").trim();
          finalize(store, task, "failed", { error: timeoutError, result: trunc(text) }, cfg);
          resolve({ timedOut: true, question: null, resultText, resultIsError, stderrTail, lastAssistantText, code: null });
          // 通知是「任务已失败」唯一的对外信号 ⇒ 等它落地再退出，别让进程先走把回执带跑。
          void exitAfterNotify(store, task);
        }, TIMEOUT_FINALIZE_GRACE_MS);
      }, task.timeout_sec * 1000);
      timeoutTimer.unref();

      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        log.write(line + "\n");
        const ev = executor.parseEvent(line);
        if (!ev) return;
        const patch: TaskPatch = {};
        if (ev.sessionId && !task.session_id) { patch.session_id = ev.sessionId; task.session_id = ev.sessionId; }
        if (ev.toolUse) {
          // files_changed 记「改过什么」不是「碰过什么」：只读工具（Read/Grep/Glob…）带 file 也不进。
          // 判据见 executors/file-tools.ts；progress 不受影响，仍如实回显最近一次工具调用。
          if (ev.toolUse.file && isFileMutatingTool(ev.toolUse.name)) files.add(ev.toolUse.file);
          patch.progress = `${ev.toolUse.name} ${ev.toolUse.file ?? ""}`.trim();
          patch.files_changed = [...files];
        }
        if (ev.assistantText) lastAssistantText = ev.assistantText;
        if (ev.result) { resultText = ev.result.text; resultIsError = ev.result.isError; }
        // 配额告警：识别到首个 429 / 硬配额信号时立即推一张 ⚠️ 卡，不再静默等终态。
        if (ev.quotaWarning && !quotaWarned) {
          quotaWarned = true;
          pushQuotaWarning(cfg, task, ev.quotaWarning);
        }
        if (Object.keys(patch).length) store.patch(taskId, patch);
      });
      child.stderr!.on("data", (d: Buffer) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-2048);
        log.write(JSON.stringify({ type: "stderr", text: s }) + "\n");
      });

      child.on("close", (code) => {
        clearTimeout(timeoutTimer);
        // agent 正常退出了 ⇒ 宽限内的强制收尾不再需要（否则会把已完成的活判成超时失败）
        if (forceFinalizeTimer) { clearTimeout(forceFinalizeTimer); forceFinalizeTimer = null; }
        log.end();
        const finalText = (resultText ?? lastAssistantText ?? "").trim();
        const question = extractNeedsInput(finalText);
        resolve({ timedOut, question, resultText, resultIsError, stderrTail, lastAssistantText, code });
      });
    });
  }

  // 重试循环：仅对瞬时错误（429/529/5xx/连接重置/配额临时不可用）重试；
  // timeout（真超时）、needs_input（等人工）、硬失败不重试。第 MAX_ATTEMPTS 次仍失败即终态 failed。
  // zen-free 动态模型：占位符在**每次 attempt 前**解析（实时列表可能已轮换）；撞瞬时错误的模型
  // 进排除集 → 下一 attempt 自动路由到另一个 free 模型。非 zen profile 是零成本旁路（原样返回）。
  let outcome: RunOutcome | null = null;
  let attempt = 0;
  const zenExcluded = new Set<string>();
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const resolved = await resolveZenFreeEnv(profileEnv, zenExcluded);
    if (resolved.model) {
      activeModel = resolved.model;
      appendFileSync(task.log_path, JSON.stringify({ type: "_runner", event: "zen_model", attempt, model: resolved.model, excluded: [...zenExcluded] }) + "\n");
    }
    outcome = await runAgent(attempt, buildAgentEnv(executorCfg.bin, resolved.env, pathDirs));
    const finalText = (outcome.resultText ?? outcome.lastAssistantText ?? "").trim();
    if (outcome.timedOut) break;           // 真超时，不是 API 瞬时错误
    if (outcome.question) break;           // 等人工，交给 dispatcher 代答/续跑
    if (outcome.resultIsError || outcome.code !== 0) {
      const errText = outcome.stderrTail || finalText || "";
      if (isTransientError(errText) && attempt < MAX_ATTEMPTS) {
        if (resolved.model) zenExcluded.add(resolved.model);
        appendFileSync(task.log_path, JSON.stringify({ type: "_retry", attempt, reason: trunc(errText, 200) }) + "\n");
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 60000);
        continue;
      }
    }
    break;
  }

  // 终态裁决（与单次运行的分支语义完全一致）
  const o = outcome!;
  const finalText = (o.resultText ?? o.lastAssistantText ?? "").trim();
  const question = o.question;
  if (o.timedOut) {
    // 已被「强制收尾」路径落过终态就别再落一次（transition 只认 running，重复调用会打出
    // "lost race" 噪音，且对人对日志都是误导——任务本来就是超时失败，不是别处改的）。
    if (!timeoutFinalized) {
      finalize(store, task, "failed", { error: timeoutError, result: trunc(finalText) }, cfg);
    }
  } else if (question) {
    if (task.rounds >= MAX_ROUNDS) {
      finalize(store, task, "failed", { error: `rounds limit (${MAX_ROUNDS}) reached with pending question`, question: trunc(question) }, cfg);
    } else {
      finalize(store, task, "needs_input", { question: trunc(question), result: trunc(finalText) }, cfg);
    }
  } else if (o.resultIsError) {
    finalize(store, task, "failed", { error: trunc(o.stderrTail || finalText || "agent reported error"), result: trunc(finalText) }, cfg);
  } else if (o.code === 0 && finalText) {
    finalize(store, task, "completed", { result: trunc(finalText) }, cfg);
  } else {
    finalize(store, task, "failed", { error: trunc(o.stderrTail || `agent exited with code ${o.code ?? "?"}`) }, cfg);
  }
}

function finalize(
  store: ReturnType<typeof openStore>, task: Task,
  to: "needs_input" | "completed" | "failed", patch: TaskPatch,
  cfg: Awaited<ReturnType<typeof loadConfig>>
): void {
  const ok = store.transition(task.id, ["running"], to, { ...patch, ended_at: Math.floor(Date.now() / 1000) });
  if (!ok) { console.error(`terminal transition to ${to} lost race; task state changed elsewhere`); return; }
  const detail = to === "needs_input" ? String(patch.question ?? "") : to === "completed" ? trunc(String(patch.result ?? "")) : String(patch.error ?? "");
  // 注册 pending 给 SIGTERM handler 等待；正常完成后清空，避免内存里挂旧 promise。
  // feishu_webhook_url 支持 {env:VAR} 占位符；dry_run 时不解析（打日志即可），真实发送才解析，
  // 缺变量时抛错 → notify_failed（任务状态不受影响）。
  const dryRun = cfg.notify.dry_run ?? true;
  const webhook = dryRun ? cfg.notify.feishu_webhook_url
    : resolveEnvPlaceholders({ url: cfg.notify.feishu_webhook_url }).url;
  pendingNotify = sendFeishuCard(webhook, buildFeishuCard(to, task.id, detail, cfg.notify.keyword, cardFooter(task, cfg)), { dryRun })
    .then((r) => { if (!r.ok) store.patch(task.id, { notify_failed: true }); })
    .catch((e) => { console.error("[notifier] unexpected:", e); store.patch(task.id, { notify_failed: true }); })
    .finally(() => { pendingNotify = null; });
}

function readRoundInput(logPath: string, round: number): string | null {
  let found: string | null = null;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j?.type === "user_prompt" && j.round === round && typeof j.text === "string") found = j.text;
    } catch { /* skip event lines */ }
  }
  return found;
}

function trunc(s: string, max = MAX_RESULT_LEN): string {
  return s.length > max ? s.slice(0, max) + "…(truncated)" : s;
}

/**
 * 中途配额/限流告警推送：复用 finalize 的 webhook/env 解析路径，独立 fire-and-forget。
 * 不阻塞事件循环；不修改任务状态（任务还在跑）；不进入 pendingNotify（避免被 SIGTERM 截断）。
 * 唯一去重由 runner 主循环的 quotaWarned 局部标志保证（同任务只触发一次）。
 */
function pushQuotaWarning(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  task: Task,
  q: { status?: number; message: string; attempt?: number },
): void {
  const dryRun = cfg.notify.dry_run ?? true;
  const webhook = dryRun ? cfg.notify.feishu_webhook_url
    : resolveEnvPlaceholders({ url: cfg.notify.feishu_webhook_url }).url;
  const parts: string[] = [];
  if (typeof q.status === "number") parts.push(`**状态码**：\`${q.status}\``);
  if (typeof q.attempt === "number") parts.push(`**重试次数**：${q.attempt}`);
  parts.push(`worker 触发配额/限流信号，正在重试；持续下去任务大概率失败，会自动推送终态卡片。`);
  if (q.message) parts.push(`\n> ${q.message}`);
  const detail = parts.join("\n\n");
  sendFeishuCard(webhook, buildFeishuCard("quota_warning", task.id, detail, cfg.notify.keyword, cardFooter(task, cfg)), { dryRun })
    .catch((e) => { console.error("[quota-warn] unexpected:", e); });
}

main().catch((e) => { console.error("[runner] fatal:", e); process.exit(1); });