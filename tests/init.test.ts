import { describe, expect, it } from "vitest";
import { isAbsolute } from "node:path";
import {
  apiKeyVarFor,
  buildConfig,
  DEFAULT_CLAUDE_ENV,
  DEFAULT_EXTRA_FLAGS,
  mcpServerSnippet,
  nextSteps,
  nodeExecPath,
  presetEnv,
  resolveServerEntry,
} from "../src/init.js";

describe("presetEnv", () => {
  it("merges generic claude default env (API_TIMEOUT_MS) into every preset", () => {
    const env = presetEnv("minimax", "MINIMAX_API_KEY");
    expect(env.API_TIMEOUT_MS).toBe(DEFAULT_CLAUDE_ENV.API_TIMEOUT_MS);
  });
  it("minimax: token placeholder + known model + extra env", () => {
    const env = presetEnv("minimax", "MINIMAX_API_KEY");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("{env:MINIMAX_API_KEY}");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M3[1m]");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("384000");
  });
  it("deepseek: distinct haiku model alias", () => {
    const env = presetEnv("deepseek", "DEEPSEEK_API_KEY");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("{env:DEEPSEEK_API_KEY}");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-pro[1m]");
  });
  it("custom is not handled by presetEnv", () => {
    expect(presetEnv("custom", "X_API_KEY")).toEqual({});
  });
});

describe("apiKeyVarFor (custom key var name derived from profile)", () => {
  it("uppercases and sanitizes the profile name", () => {
    expect(apiKeyVarFor("myprov")).toBe("MYPROV_API_KEY");
    expect(apiKeyVarFor("My Prov!")).toBe("MY_PROV_API_KEY");
  });
  it("falls back to DEFAULT when profile yields no usable chars", () => {
    expect(apiKeyVarFor("")).toBe("DEFAULT_API_KEY");
    expect(apiKeyVarFor("   ")).toBe("DEFAULT_API_KEY");
  });
});

describe("buildConfig", () => {
  it("produces a config with executor/profile/notify/defaults", () => {
    const cfg = buildConfig({
      executor: "claude",
      bin: "/bin/node",
      profile: "default",
      env: { A: "1" },
      notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true },
      timeout_sec: 3600,
    });
    expect(cfg.executors.claude.bin).toBe("/bin/node");
    expect(cfg.profiles.default.env).toEqual({ A: "1" });
    expect(cfg.notify.dry_run).toBe(true);
    expect(cfg.defaults.profile).toBe("default");
  });
  it("opencode executor 用 --auto（不是 claude 的 --dangerously-skip-permissions）", () => {
    const cfg = buildConfig({
      executor: "opencode",
      bin: "/usr/local/bin/opencode",
      profile: "oc",
      env: {},
      notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true },
      timeout_sec: 3600,
    });
    expect(cfg.executors.opencode.extra_flags).toEqual(DEFAULT_EXTRA_FLAGS.opencode);
    expect(cfg.executors.opencode.extra_flags).toEqual(["--auto"]);
  });
});

describe("MCP 配置片段（2026-10-10 实测：必须绝对路径）", () => {
  it("command 是 node 解释器绝对路径，不是裸命令名", () => {
    const parsed = JSON.parse(mcpServerSnippet("/x/dist/server.js"));
    const entry = parsed.mcpServers["agent-flow-ex"];
    // 回归防线：曾输出 {command:"agent-flow-ex"}，MCP 客户端 spawn 时无 PATH → command not found。
    expect(entry.command).not.toBe("agent-flow-ex");
    expect(isAbsolute(entry.command)).toBe(true);
    expect(entry.command).toBe(nodeExecPath());
  });
  it("args 带 server 入口绝对路径，且片段是合法 JSON", () => {
    const parsed = JSON.parse(mcpServerSnippet("/x/dist/server.js"));
    expect(parsed.mcpServers["agent-flow-ex"].args).toEqual(["/x/dist/server.js"]);
  });
  it("server 入口由 init 自身位置推导，不依赖 cwd", () => {
    const entry = resolveServerEntry();
    expect(isAbsolute(entry)).toBe(true);
    expect(entry.endsWith("/server.js")).toBe(true);
  });
});

describe("nextSteps 收尾指引", () => {
  const text = nextSteps("/home/u/.agent-flow-ex", "/abs/dist/server.js");
  it("包含数据目录、注册片段与 skill 安装指引", () => {
    expect(text).toContain("AGENT_FLOW_HOME=/home/u/.agent-flow-ex");
    expect(text).toContain("/abs/dist/server.js");
    expect(text).toContain("skills add wuruofan/agent-flow-ex");
  });
  it("解释了绝对路径的原因（PATH 不可继承）与宿主 skills 目录查找法", () => {
    expect(text).toMatch(/without your shell PATH|不继承/);
    expect(text).toContain("find ~ -maxdepth 4");
  });
});
