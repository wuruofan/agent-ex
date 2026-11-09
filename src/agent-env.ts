import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { resolveEnvPlaceholders, resolveBinPath } from "./config.js";

/**
 * 显式构造 agent 子进程环境（spec §7.1）：不继承任意 shell 环境。
 * 关键：不引入任何白名单/黑名单——profile env 全量透传（Spike S4 已实测不影响 session 落盘）。
 *
 * PATH 以 dirname(resolveBinPath(bin)) 打头：裸命令名（"claude"）会先按运行时的
 * process.env.PATH 解析成绝对路径再取目录，从而与 validate() 行为一致——
 * 避免「启动时校验通过、运行时 spawn ENOENT」的分裂（config.ts 注释有详述）。
 */
export function buildAgentEnv(
  bin: string,
  profileEnv: Record<string, string>,
  pathPrepend?: string[],
): NodeJS.ProcessEnv {
  const resolved = resolveBinPath(bin) ?? bin;
  return {
    HOME: process.env.HOME,
    TMPDIR: tmpdir(),
    // 顺序：executor 自己的 bin 目录 → profile.path_prepend → 系统目录。
    // dirname(resolved) 恒排第一：用户的额外目录不能把 executor 本身挤掉。
    PATH: [dirname(resolved), ...(pathPrepend ?? []), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    ...resolveEnvPlaceholders(profileEnv),
  };
}