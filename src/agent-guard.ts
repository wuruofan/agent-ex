/**
 * runner ↔ agent 的生命周期守卫。
 *
 * 不变式：**runner 退出 ⇒ 它启动的 agent 已经死了**。
 *
 * 为什么需要：runner 的每条退出路径若在 agent 还活着时退出，agent 就变成**孤儿**——
 * 没人杀它、没人读它的 stdout，它会一直跑下去烧 token。
 * 2026-11-17 实测：runner 崩了之后 fake-agent 以 PPID=1 活到人工清理。
 *
 * 哪条路径会留下孤儿（cancel 不算：它走 killTree 组杀，agent 一起死）：
 * 1. **只杀 runner 不杀组**：宿主 SIGTERM runner 本体 ⇒ runner 排空通知后退出 ⇒ agent 还活着；
 * 2. **runner 自己崩**：uncaughtException / 未处理的 promise 拒绝 ⇒ Node 默认「打印栈然后退」⇒ agent 还活着。
 */
import { collectDescendants } from "./proc-tree.js";

/** 本次运行活着的 agent 进程（runner 是单任务进程，一次只有一个）。 */
let livePid: number | null = null;

/** agent 起来了 → 登记（退出前要靠它收尾）。 */
export function attachAgent(pid: number): void {
  livePid = pid;
}
/** agent 已经退出（close 事件）→ 注销。 */
export function detachAgent(): void {
  livePid = null;
}
/** 当前活着的 agent pid（没登记时为 null）。 */
export function liveAgentPid(): number | null {
  return livePid;
}

/**
 * 同步硬杀 agent 树（SIGKILL）。
 *
 * 给「马上要退出、没法 await」的场景用：进程 'exit' 钩子、致命异常处理器。
 * 用 SIGKILL 而不是 SIGTERM：这时已经没有时间等它优雅退出，
 * 而「活着持续烧 token」比「不优雅地死」严重得多。
 */
export function killAgentTreeSync(): void {
  const pid = livePid;
  if (pid === null) return;
  livePid = null;
  for (const p of collectDescendants(pid)) {
    try { process.kill(p, "SIGKILL"); } catch { /* 已死 */ }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* 已死 */ }
}

/**
 * 杀掉 agent 进程树并**等它确实死**：先 SIGTERM（给 CLI 收尾的机会），
 * 宽限内没死就 SIGKILL。返回时 agent 一定已经不在了。
 *
 * 不用 killTree：它的 SIGKILL 兜底是 unref 的定时器，进程退出后就没了
 * （这里要的是「返回前它确实死了」这个保证，不是「之后再补一刀」）。
 */
export async function terminateAgentTree(graceMs = 3000): Promise<void> {
  const pid = livePid;
  if (pid === null) return;
  livePid = null;
  for (const p of collectDescendants(pid)) {
    try { process.kill(p, "SIGTERM"); } catch { /* 已死 */ }
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* 已死 */ }
  const deadline = Date.now() + graceMs + 500;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; } // 已死
    await sleep(50);
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* 已死 */ }
}

/**
 * 装上致命异常处理器：异常时**先收干净 agent 再退**，别让它变孤儿。
 *
 * 为什么必须自己装：Node 的默认行为是「打印栈 → 退出」⇒ agent 变孤儿。
 * 装了 handler 之后 Node 不再自动退出（handler 返回后进程继续跑）⇒ 我们有机会先收尾。
 */
export function installFatalAgentCleanup(): void {
  let handling = false;
  const fatal = (kind: string) => (e: unknown) => {
    if (handling) return; // 已经处理过一次 ⇒ 不重复
    handling = true;
    console.error(`[agent-guard] ${kind}:`, e);
    void terminateAgentTree(1500).finally(() => {
      process.exit(1);
    });
  };
  process.on("uncaughtException", fatal("uncaughtException"));
  process.on("unhandledRejection", fatal("unhandledRejection"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
