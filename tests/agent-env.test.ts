import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { buildAgentEnv } from "../src/agent-env.js";

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
