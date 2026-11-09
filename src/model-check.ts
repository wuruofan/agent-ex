/**
 * 模型存活预检 —— 「模型引用提取 + 存活探测」的唯一实现。
 *
 * 背景（2026-10 实测）：profile 的 `OPENCODE_CONFIG_CONTENT` 里配了一个已下线的 model id，
 * 任务会在 1 秒内 failed，opencode 只抛
 * `UnknownError: "Unexpected server error. Check server logs for details."`（且 exit=0），
 * agent-ex 侧没有留下任何模型名线索，无法区分「模型下线」与「真服务端故障」。
 * 错误驱动自愈不可行（见 zen-free.ts 顶部注释），所以必须在派发前**主动探测**。
 *
 * ⚠️ 这里**绝不能**塞进 config.ts 的 `collectConfigIssues()`：那是同步纯函数、零 I/O，
 * 且被所有 config 写盘路径消费。动态探测只能由 submit / doctor 这两个已按需动态 import
 * 的模块消费（AGENTS.md 硬约束 #6：规则仍只有一份，只是按「静态结构 / 动态证据」分类）。
 */
import { spawn } from "node:child_process";
import { getExecutor } from "./executors/types.js";

export type ModelLiveness = "ok" | "missing" | "unknown" | "unsupported";

export interface ModelRef {
  /** 完整模型 id，形如 "minimax-cn-coding-plan/MiniMax-M3.1-Flash" */
  model: string;
  /** "/" 之前的 provider 段，形如 "minimax-cn-coding-plan" */
  provider: string;
}

export interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 注入点：测试用它替代真实 spawn。默认实现用 child_process 起子进程。 */
export type RunImpl = (argv: string[], timeoutMs: number) => Promise<RunOutcome>;

const DEFAULT_TIMEOUT_MS = 5000;

/** 从 OPENCODE_CONFIG_CONTENT 里解析出 model 字符串；解析不出来返回 null。 */
export function parseOpencodeModel(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const m = (JSON.parse(raw) as { model?: unknown }).model;
    return typeof m === "string" ? m : null;
  } catch {
    return null;
  }
}

/** 解析 `opencode models <provider>` 的 stdout → 模型 id 数组（每行一个完整 id）。 */
export function parseModelList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes("/"));
}

/**
 * 从 profile 的 env 里抽取模型引用；不适用时返回 null。
 *
 * 跳过（= 不探测、不拦截、不报 finding）：
 *  - executor 不是 opencode；
 *  - 没有 OPENCODE_CONFIG_CONTENT / 不是合法 JSON / 没有 model 字段；
 *  - model 里含 `{model:` 占位符（spawn 时才动态解析，配置里零硬引用）；
 *  - model 里没有 `/`（无从得知 provider）。
 */
export function extractModelRef(executor: string, env: Record<string, string>): ModelRef | null {
  if (executor !== "opencode") return null;
  const model = parseOpencodeModel(env.OPENCODE_CONFIG_CONTENT);
  if (!model) return null;
  if (model.includes("{model:")) return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  return { model, provider: model.slice(0, slash) };
}

/** 默认 RunImpl：spawn 子进程、收集 stdout/stderr、超时 kill。 */
const defaultRunImpl: RunImpl = (argv, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (out: RunOutcome) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    let child;
    try {
      // argv[0] 是 bin；Node 的 spawn 会自己补 argv[0]，所以必须 slice(1)。
      child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ code: null, stdout, stderr: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ code: null, stdout, stderr });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr: stderr + e.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });
  });

/**
 * 探测模型是否仍在可用清单里。
 *
 * 判定顺序（严格）：
 *  executor 不支持 → unsupported；
 *  spawn 失败/超时/非 0 退出 → unknown；
 *  清单为空 → unknown；
 *  命中 → ok；
 *  否则 → missing（**只有这个确定性结论可以拦截**）。
 */
export async function checkModelLiveness(
  ref: ModelRef,
  opts: { bin: string; executor: string; runImpl?: RunImpl; timeoutMs?: number },
): Promise<ModelLiveness> {
  const { bin, executor, runImpl = defaultRunImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  let ex;
  try {
    ex = getExecutor(executor);
  } catch {
    return "unsupported";
  }
  const build = ex.buildModelListCommand;
  if (!build) return "unsupported";

  let argv: string[];
  try {
    argv = build.call(ex, bin, ref.provider);
  } catch {
    return "unknown";
  }

  let outcome: RunOutcome;
  try {
    outcome = await runImpl(argv, timeoutMs);
  } catch {
    return "unknown";
  }
  if (outcome.code !== 0) return "unknown";
  const list = parseModelList(outcome.stdout);
  if (list.length === 0) return "unknown";
  return list.includes(ref.model) ? "ok" : "missing";
}
