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
export function ensureRuntimeDirs(): void {
  mkdirSync(agentExHome(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
}