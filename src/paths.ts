import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR_NAME } from "./brand.js";

export function agentExHome(): string {
  return process.env.AGENT_EX_HOME ?? join(homedir(), HOME_DIR_NAME);
}
export function dbPath(): string {
  return join(agentExHome(), "tasks.db");
}
export function logsDir(): string {
  return join(agentExHome(), "logs");
}
/**
 * 「正在排空通知」标记目录。
 *
 * 为什么需要它：cancel 的 killTree 会在 graceMs（默认 3s）后对整个进程组补 SIGKILL，
 * 而 runner 收到 SIGTERM 后要等在飞的飞书通知落地（最多 40s）⇒ 硬杀会把通知的**回执**带走
 * （飞书拒收就没人知道了 ⇒ 静默失败）。runner 排空期间写标记，killTree 据此放过它。
 */
export function drainDir(): string {
  return join(agentExHome(), "drain");
}
/** 某个任务「正在排空通知」的标记文件路径。 */
export function drainMarkerPath(taskId: string): string {
  return join(drainDir(), `${taskId}.draining`);
}
export function ensureRuntimeDirs(): void {
  mkdirSync(agentExHome(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
  mkdirSync(drainDir(), { recursive: true });
}