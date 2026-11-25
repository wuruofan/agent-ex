import { randomBytes } from "node:crypto";
import { statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../store.js";
import { loadConfig, effectiveProfileCost, type Config, type ProfileCost } from "../config.js";
import { logsDir, dbPath } from "../paths.js";
import { spawnDetachedRunner } from "../spawn-runner.js";
import {
  extractModelRef,
  checkModelLiveness,
  type ModelLiveness,
  type ModelRef,
  type RunImpl,
} from "../model-check.js";

export interface SubmitArgs {
  prompt: string;
  project_path?: string;
  profile?: string;
  continue_of?: string;
  timeout_sec?: number;
  /**
   * 计费授权：**仅当用户本轮明确同意为这次派发付费时**才传 true。
   *
   * 目标 profile 是计费档（metered）而这个开关缺省 ⇒ 派发被拒（见 costGateError）。
   * 免费档（free）不需要它。
   *
   * ⚠️ 429 / 额度上限 / free 池全挂 / 超时 / 失败 **都不构成**同意计费——
   * 那种情况下正确的做法是停下来报告，不是加这个参数重试。
   */
  allow_metered?: boolean;
}

/** 测试注入点：替换模型存活探测的真实 spawn。生产调用方不传。 */
export interface SubmitDeps {
  runImpl?: RunImpl;
}

export type SubmitResult =
  | { task_id: string; status: string; rounds: number; warning?: string }
  | { error: string };

/**
 * 派发前的模型存活预检。
 *
 * 返回 null = 不适用（非 opencode / 无模型引用 / executor 没有 bin），无需处理。
 * `missing` 是**唯一可拦截的确定性结论**；`unknown` 只降级为「未能验证」的 warning。
 */
async function probeProfileModel(
  cfg: Config,
  executor: string,
  env: Record<string, string>,
  profileName: string,
  runImpl: RunImpl | undefined,
): Promise<{ ref: ModelRef; liveness: ModelLiveness } | null> {
  const ref = extractModelRef(executor, env);
  if (!ref) return null;
  const bin = cfg.executors[executor]?.bin;
  if (typeof bin !== "string" || bin === "") return null;
  const liveness = await checkModelLiveness(ref, { bin, executor, runImpl });
  return { ref, liveness };
}

function missingModelError(profileName: string, ref: { model: string; provider: string }): string {
  return (
    `profile "${profileName}" points at model "${ref.model}", which is not in the available list for provider ` +
    `"${ref.provider}" (opencode models). The id looks offline — update OPENCODE_CONFIG_CONTENT to a model that still exists before dispatching.`
  );
}

/**
 * 计费闸门的拒绝文案（设计文档 D3）。
 *
 * 必须包含：被拦的 profile 名 + 当前默认档是谁 + 「用户已指定/已同意就传 `allow_metered: true` 重试」。
 * 点名 `defaults.profile` 是必须的——否则调用方无法判断该「让用户切默认」还是「这次带个授权」。
 *
 * 末句是刻意的：429 / 额度上限 / 超时 / 失败都**不构成**同意计费，
 * 不写清楚的话，调用方很容易在这几种情况下自己加 `allow_metered` 重试。
 */
function costGateError(profileName: string, configuredProfile: string, reason?: string): string {
  const extra = reason ? ` ${reason}` : "";
  return (
    `profile "${profileName}" is not the profile currently configured (defaults.profile = "${configuredProfile}") ` +
    `and it is a metered profile — using it may cost money.${extra} ` +
    `If the user explicitly asked for this profile, or has agreed to pay for this run, ` +
    `pass allow_metered: true and retry. ` +
    `A quota error, an exhausted free pool, a timeout, or a failed run is NOT that agreement.`
  );
}

/**
 * 计费闸门：**切到**一个计费档 profile 时要用户点头。
 *
 * 三条判据，全满足才放行：
 *  1. 目标 profile **就是用户当前配置的那个**（`defaults.profile`）⇒ **配置即授权**，放行。
 *     用户自己选定的付费档是他的事，agent 照着用就行，不需要每次点头。
 *  2. 目标 profile 是**免费档** ⇒ 不花钱，与钱无关，放行。
 *  3. 其余（切到了别的、而且那个会花钱的 profile）⇒ 必须带 `allow_metered: true`。
 *
 * ⚠️ 闸门的目标是「**agent 自主换到付费档**」这个形状（事故的真正成因），
 * 不是「这个 profile 收费」。把 1 也拦掉，会让用户自己的付费配置每次派发都要点头——
 * 那既不解决问题，又把正常流程变成噪音。
 *
 * ⚠️ 判定用的是**有效成本**（声明优先，未声明按结构化判定），真相源在 config.ts 的
 * `effectiveProfileCost()`——doctor 与这里共用它，改判定逻辑时两处同时变。
 */
function checkCostGate(target: {
  profileName: string;
  cost: ProfileCost;
  configuredProfile: string;
  allowMetered: boolean | undefined;
  reason?: string;
}): string | null {
  if (target.cost !== "metered") return null;              // 免费档：与钱无关
  if (target.allowMetered === true) return null;            // 用户已点头
  if (target.profileName === target.configuredProfile) return null; // 配置即授权
  return costGateError(target.profileName, target.configuredProfile, target.reason);
}

/**
 * 等一小段时间（默认 80ms）让异步 spawn 错误浮现。
 * - 同步异常（fs 校验等）通过 try/catch 直接处理。
 * - 异步异常（ENOENT 等）在 child.on('error') 后触发 → onSpawnError 回调里把任务转 failed 并持有 msg。
 *   submit 在 await 这个窗口之后检查 spawnErr，若存在则同步返回 error；否则声明启动成功。
 *
 * 设计取舍：80ms 是经验值——ENOENT 在本机通常 <50ms 完成；过短会漏掉、过久会让同步 submit 变慢。
 */
const SPAWN_ERROR_GRACE_MS = 80;

/**
 * spawn detached runner 并捕获异步 spawn 错误。
 *
 * ⚠️ 回调**自己开/关一次库**，不复用 submit 的连接：child.on('error') 不受 80ms 宽限窗口约束，
 * 完全可能晚于 submit 返回（那时连接已 close）触发 —— 复用它方连接就是"写到已关闭的库上"。
 * 这条路径本身罕见（spawn 失败），每次多开一次库是划算的。
 */
function spawnRunnerWithAsyncErrorCapture(
  id: string,
  currentStatus: "queued" | "running",
): { pid: number | null; spawnError: Promise<string | null> } {
  let errMsg: string | null = null;
  const { child } = spawnDetachedRunner(id, (e) => {
    errMsg = e.message;
    const s = openStore(dbPath());
    try {
      s.transition(id, [currentStatus], "failed", {
        error: `failed to spawn runner: ${e.message}`,
        ended_at: Math.floor(Date.now() / 1000),
      });
    } finally {
      s.close();
    }
  });
  const spawnError = new Promise<string | null>((resolve) => {
    setTimeout(() => resolve(errMsg), SPAWN_ERROR_GRACE_MS);
  });
  return { pid: child.pid ?? null, spawnError };
}

export async function submit(args: SubmitArgs, deps: SubmitDeps = {}): Promise<SubmitResult> {
  if (!args.prompt?.trim()) return { error: "prompt is required" };
  const cfg = loadConfig();
  const store = openStore(dbPath());
  // 连接必须显式 close：server 是长跑进程，按需开库却不关，只能等 GC 回收（实测 2026-10-16：
  // 存活 1d18h 的 server 仍持有 6 个未释放的 tasks.db 连接），而迟迟不回收的连接会把
  // `-wal`/`-shm` 一并钉在磁盘上。见 store.ts 的 useRollbackJournal()。
  try {
    // ---- 续跑：needs_input 任务答疑 ----
    if (args.continue_of) {
      const t = store.getTask(args.continue_of);
      if (!t) return { error: `task ${args.continue_of} not found` };
      if (t.status !== "needs_input") return { error: `task ${args.continue_of} is "${t.status}", expected "needs_input"` };

      // ---- 计费闸门：必须在**状态变更**与**模型探测**之前（设计文档 D3 的四条硬约束）----
      // 拦的是「续跑切到了当前默认档以外、且会花钱的 profile」；目标就是默认档 ⇒ 配置即授权，放行。
      // profile 用**任务行**里的（不是 args.profile——续跑时传 profile 无效，现实现即如此）；
      // executor 也用**任务行**里的：runner 起的是 task.executor（runner.ts:240-242），
      // 而 env 取自当前 config 的 profile。profile.executor 被改成 opencode+占位符、任务行仍是 claude 时，
      // 按 profile.executor 判会放行一个**付费**档 ⇒ 这里必须按 task.executor 判。
      const tProfile = cfg.profiles[t.profile];
      const tCost: ProfileCost = tProfile ? effectiveProfileCost(tProfile, t.executor) : "metered";
      const gate = checkCostGate({
        profileName: t.profile,
        cost: tCost,
        configuredProfile: cfg.defaults.profile,
        allowMetered: args.allow_metered,
        reason: tProfile
          ? undefined
          : "It is no longer in config.json, so its cost cannot be determined (treated as metered).",
      });
      if (gate) return { error: gate };

      // 续跑分支同样要探测：任务行里存了当初的 profile / executor。
      const tProbe = tProfile
        ? await probeProfileModel(cfg, t.executor, tProfile.env ?? {}, t.profile, deps.runImpl)
        : null;
      if (tProbe?.liveness === "missing") return { error: missingModelError(t.profile, tProbe.ref) };
      const tUnverified = tProbe?.liveness === "unknown";

      const rounds = t.rounds + 1;
      const ok = store.transition(args.continue_of, ["needs_input"], "running", { rounds });
      if (!ok) return { error: `task ${args.continue_of} state changed concurrently (now "${store.getTask(args.continue_of)?.status}")` };
      // 留痕：写该轮的有效成本。粘性 metered 由 setCost 保证（已发生的计费事实不被后续轮次抹掉）。
      store.setCost(args.continue_of, tCost);
      appendFileSync(t.log_path, JSON.stringify({ type: "user_prompt", round: rounds, text: args.prompt }) + "\n");
      const { pid, spawnError } = spawnRunnerWithAsyncErrorCapture(args.continue_of, "running");
      if (pid !== null) store.patch(args.continue_of, { pid });
      const err = await spawnError;
      if (err) return { error: `failed to spawn runner for ${args.continue_of}: ${err}` };
      return tUnverified
        ? {
            task_id: args.continue_of,
            status: "running",
            rounds,
            warning: `model liveness for profile "${t.profile}" could not be verified (model list unavailable); dispatch continues`,
          }
        : { task_id: args.continue_of, status: "running", rounds };
    }

    // ---- 新任务 ----
    const profileName = args.profile ?? cfg.defaults.profile;
    const profile = cfg.profiles[profileName];
    if (!profile) return { error: `unknown profile "${profileName}"` };
    if (!cfg.executors[profile.executor]) return { error: `profile "${profileName}" references unknown executor` };

    // ---- 计费闸门：必须在**模型探测**与**建任务**之前（设计文档 D3 的四条硬约束）----
    // 拦的是「切到了当前默认档以外、且会花钱的 profile」；目标就是默认档 ⇒ 配置即授权，放行。
    // 前置到探测之前有两个理由：① 被拒的调用不该白付一次 `opencode models` 子进程；
    // ② "模型 missing" 不该先于 "cost 拒绝" 返回——那会掩盖真正的原因。
    const cost = effectiveProfileCost(profile);
    const gate = checkCostGate({
      profileName,
      cost,
      configuredProfile: cfg.defaults.profile,
      allowMetered: args.allow_metered,
    });
    if (gate) return { error: gate };

    // ---- 模型存活预检：missing 直接拒绝派发（不创建任务）；unknown 只告警 ----
    const probe = await probeProfileModel(cfg, profile.executor, profile.env ?? {}, profileName, deps.runImpl);
    if (probe?.liveness === "missing") return { error: missingModelError(profileName, probe.ref) };
    const modelUnverified = probe?.liveness === "unknown";

    const timeout_sec = args.timeout_sec ?? cfg.defaults.timeout_sec;
    if (!Number.isInteger(timeout_sec) || timeout_sec <= 0) return { error: "timeout_sec must be a positive integer" };

    const project_path = args.project_path ?? process.cwd();
    try {
      if (!statSync(project_path).isDirectory()) return { error: `project_path "${project_path}" is not a directory` };
    } catch {
      return { error: `project_path "${project_path}" not accessible` };
    }

    // ---- 同目录活跃任务警告：把"同目录写任务禁止并发"从纪律变成被检查的事实 ----
    // 不阻断（合法场景由调度方判断，如刻意接续工作），只随结果带出 warning 让调度方看见。
    const sameDirActive = store.listActive().filter((t) => t.project_path === project_path);
    const warnings: string[] = [];
    if (sameDirActive.length) {
      warnings.push(
        `project_path "${project_path}" already has ${sameDirActive.length} active task(s), e.g. ` +
        `${sameDirActive[0].id} (${sameDirActive[0].status}); same-directory tasks share one working tree and can clobber each other`,
      );
    }
    if (modelUnverified) {
      warnings.push(`model liveness for profile "${profileName}" could not be verified (model list unavailable); dispatch continues`);
    }
    const warning = warnings.length ? warnings.join("; ") : undefined;

    const id = `task_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    store.createTask({
      id, prompt: args.prompt, project_path, executor: profile.executor, profile: profileName,
      timeout_sec, log_path: join(logsDir(), `${id}.jsonl`), role: "worker",
      created_at: Math.floor(Date.now() / 1000),
      cost,
    });
    const { pid, spawnError } = spawnRunnerWithAsyncErrorCapture(id, "queued");
    if (pid !== null) store.patch(id, { pid });
    const err = await spawnError;
    if (err) return { error: `failed to spawn runner for ${id}: ${err}` };
    return warning
      ? { task_id: id, status: "queued", rounds: 1, warning }
      : { task_id: id, status: "queued", rounds: 1 };
  } finally {
    store.close();
  }
}
