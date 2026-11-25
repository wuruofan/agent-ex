import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAgentEnv, which } from "../src/agent-env.js";

const bin = process.execPath;
const binDir = dirname(bin);
const SYSTEM = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

describe("buildAgentEnv —— worker 环境自建 PATH", () => {
  /**
   * 回归保护：没有 path_dirs 的老配置，PATH 必须与今天**逐字节一致**。
   * 这也是「不继承 process.env.PATH」这条硬约束的可执行断言。
   */
  it("不传 pathDirs 时 PATH 与历史行为逐字节一致", () => {
    const env = buildAgentEnv(bin, {});
    expect(env.PATH).toBe([binDir, ...SYSTEM].join(":"));
  });

  it("pathDirs 插在 executor bin 目录之后、系统目录之前", () => {
    const env = buildAgentEnv(bin, {}, ["/nvm/node/bin", "/bun/bin"]);
    expect(env.PATH).toBe([binDir, "/nvm/node/bin", "/bun/bin", ...SYSTEM].join(":"));
  });

  it("空数组与不传第三个参数等价", () => {
    expect(buildAgentEnv(bin, {}, []).PATH).toBe(buildAgentEnv(bin, {}).PATH);
  });

  it("HOME / TMPDIR 仍被显式构造", () => {
    const env = buildAgentEnv(bin, {});
    expect(env.HOME).toBe(process.env.HOME);
    expect(typeof env.TMPDIR).toBe("string");
  });
});

/**
 * `which(name, {PATH})` 是 doctor「worker 跑不跑得动」这条判据的底座：
 * 它必须**只在传入的那条 PATH 里**解析，不能漏回调用进程自己的 PATH。
 *
 * 这条断言一旦破了，doctor 的缺口判据就会去问错的问题
 * （问的是 doctor 自己跑不跑得动，而不是 worker 跑不跑得动）。
 */
describe("which —— 注入 PATH 时的解析语义", () => {
  it("只在那条 PATH 里找得到，找不到就返回 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "aex-which-"));
    const file = join(dir, "aex-fake-tool");
    try {
      writeFileSync(file, "#!/bin/sh\nexit 0\n");
      chmodSync(file, 0o755);
      expect(which("aex-fake-tool", { PATH: dir })).toBe(file);
      expect(which("aex-fake-tool", { PATH: "/nonexistent-aex-dir" })).toBeNull();
      // 不传 env 时才沿用调用进程自己的 PATH
      expect(which("aex-fake-tool")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
