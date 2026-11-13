import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import { resolveEnvPlaceholders, resolveBinPath } from "./config.js";

/**
 * worker PATH 尾段的系统目录。
 *
 * 导出是因为「worker 实际拿到哪些目录」有两个消费者：buildAgentEnv 拼 PATH，
 * doctor 判断工具链目录有没有被覆盖。两处各写一份字面量必然会漂。
 */
export const WORKER_SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

/**
 * worker 实际会得到的 PATH 目录列表（顺序即优先级）：
 * executor 自己的 bin 目录 → profile.path_dirs → 系统目录。
 *
 * dirname(resolved) 恒排第一：用户的额外目录不能把 executor 本身挤掉。
 */
export function workerPathDirs(bin: string, pathDirs?: string[]): string[] {
  const resolved = resolveBinPath(bin) ?? bin;
  return [dirname(resolved), ...(pathDirs ?? []), ...WORKER_SYSTEM_PATH_DIRS];
}

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
  pathDirs?: string[],
): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    TMPDIR: tmpdir(),
    PATH: workerPathDirs(bin, pathDirs).join(":"),
    ...resolveEnvPlaceholders(profileEnv),
  };
}

/** `command -v` 的同步实现（唯一一处，init 与 doctor 共用）。 */
export function which(name: string): string | null {
  try {
    return execSync(`command -v ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** 值得补进 worker PATH 的工具链命令（各人装法不同：nvm/fnm/volta/asdf/mise/homebrew/系统包）。 */
export const TOOLCHAIN_BINS = ["node", "npm", "bun", "git"] as const;

/**
 * 探测工具链所在目录，给 worker 的 PATH 补料。
 *
 * 为什么要在用户的交互式终端里探测（init 直接探、doctor 探出来给修复命令）：
 * 那里的 PATH 就是用户真正在用的工具链（nvm/fnm/volta/homebrew …）；而 worker 的 PATH
 * 由 buildAgentEnv 完全自建，不继承 shell。二者的落差正是 node/npm/bun 在 worker 里
 * command not found 的根因。
 *
 * `whichFn` 可注入（与 detectAgentClis 同款理由：测试不能依赖开发机装了什么）。
 */
export function detectToolchainDirs(whichFn: (name: string) => string | null = which): string[] {
  const dirs: string[] = [];
  for (const name of TOOLCHAIN_BINS) {
    const bin = whichFn(name);
    // 没装 / 没在 PATH：跳过，不报错、不占位
    if (!bin) continue;
    // `command -v` 在含相对 PATH 项时可能返回相对路径 —— 不能写进 worker PATH
    if (!bin.startsWith("/")) continue;
    const dir = dirname(bin);
    // 基础 PATH 已覆盖 ⇒ 写进去是冗余
    if ((WORKER_SYSTEM_PATH_DIRS as readonly string[]).includes(dir)) continue;
    // 去重：nvm 下 node 与 npm 通常同目录，只应出现一次
    if (dirs.includes(dir)) continue;
    dirs.push(dir);
  }
  return dirs;
}
