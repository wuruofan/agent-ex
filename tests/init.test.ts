import { describe, expect, it } from "vitest";
import { isAbsolute } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiKeyVarFor,
  buildConfig,
  DEFAULT_CLAUDE_ENV,
  DEFAULT_EXTRA_FLAGS,
  detectAgentClis,
  mcpServerSnippet,
  missingTokenKey,
  nextSteps,
  nodeExecPath,
  planOpencodeProfile,
  presetEnv,
  renderDetectedClis,
  resolveServerEntry,
} from "../src/init.js";
import { BUILTIN_PROFILES, createProfile, readConfig } from "../src/config-cmd.js";
import { BRAND } from "../src/brand.js";

describe("探测 agent CLI", () => {
  it("只列真正找到的（没找到的不占位）", () => {
    const found = detectAgentClis((n) => (n === "opencode" ? "/opt/opencode/bin/opencode" : null));
    expect(found).toEqual([{ name: "opencode", bin: "/opt/opencode/bin/opencode" }]);
  });

  it("两个都找到时都列出来", () => {
    const found = detectAgentClis((n) => `/usr/bin/${n}`);
    expect(found.map((f) => f.name)).toEqual(["claude", "opencode"]);
  });

  it("一个都没找到时返回空数组（不是把没找到的塞成 null 占位）", () => {
    expect(detectAgentClis(() => null)).toEqual([]);
  });

  it("两个候选都列出来，用标记区分找到与没找到", () => {
    const text = renderDetectedClis([{ name: "opencode", bin: "/opt/opencode/bin/opencode" }]);
    expect(text).toContain("opencode");
    expect(text).toContain("/opt/opencode/bin/opencode");
    // 没找到的那个也要列出来（否则用户看不出"是没装还是不支持"），
    // 但要标清楚
    expect(text).toContain("claude");
    expect(text).toContain("not found on PATH");
    // 找到的那个带 ✓，没找到的带 ✗
    expect(text).toMatch(/✓\s+opencode/);
    expect(text).toMatch(/✗\s+claude/);
    // 旧格式是给机器看的
    expect(text).not.toContain("detected:");
  });

  it("一个都没找到时说清楚", () => {
    const text = renderDetectedClis([]);
    expect(text).toContain("No agent CLI found");
    expect(text).toContain("claude");
    expect(text).toContain("opencode");
  });
});

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

describe("init 的文案语言", () => {
  /**
   * init 的**用户可见**输出必须全英文。
   *
   * 为什么钉死：init 的向导（问题、默认值提示、next steps、变更预告）历来全是英文，
   * 中间混进过一句中文说明（"opencode: provider 由 opencode 自己的配置管理…"）——
   * 一屏里两种语言，用户得自己分辨哪句是哪语种。代码注释用中文没关系（那是给开发者看的），
   * 但**用户看到的东西**要么全英文、要么全中文，不能混。
   *
   * 断言方式：扫 init.ts 源码里所有 console.log/error 与 ask() 的提示语，
   * 看有没有中文字符。
   */
  it("init 源码里没有面向用户的中文输出", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const src = readFileSync(join(repoRoot, "src", "init.ts"), "utf8");

    // 只看"用户可见"的调用：console.log / console.error / ask( / rl.question(
    // 注释里的中文不在这些行里（注释行以 * 或 // 开头）。
    const userVisible = src
      .split("\n")
      .filter((line) => /console\.(log|error)\(|rl\.question\(|\bask\(/.test(line))
      .filter((line) => !/^\s*(\*|\/\/)/.test(line));
    const chinese = userVisible.filter((line) => /[一-龥]/.test(line));
    expect(chinese).toEqual([]);
  });
});

describe("init 的 opencode 分支 —— 与内置 preset 必须同名同 env", () => {
  /**
   * 2026-10-26 修复的问题：
   * init 的 zen-free 分支原先把 profile 叫 "default"、env 只写 OPENCODE_CONFIG_CONTENT
   * （漏 ZEN_FREE_PREFER），而内置 preset 叫 "opencode-zen-free"、env 多一个偏好字段。
   * 于是用户先跑 init、再跑 `profile create opencode-zen-free`，会得到**两个语义相同、
   * 名字不同、env 也不同**的 profile——切来切去各说各话。
   */
  it("zen free 且用户不改名 → 名字与 env 都取内置 preset", () => {
    const plan = planOpencodeProfile(true, "");
    expect(plan.profile).toBe("opencode-zen-free");
    expect(plan.env).toEqual(BUILTIN_PROFILES["opencode-zen-free"].env);
  });

  it("用户改了名：名字跟着改，env 不变（env 描述模型配置，不描述名字）", () => {
    const plan = planOpencodeProfile(true, "my-zen");
    expect(plan.profile).toBe("my-zen");
    expect(plan.env).toEqual(BUILTIN_PROFILES["opencode-zen-free"].env);
  });

  it("不用 zen free → 普通 profile（default + 空 env）", () => {
    const plan = planOpencodeProfile(false, "");
    expect(plan.profile).toBe("default");
    expect(plan.env).toEqual({});
  });

  it("env 是深拷贝：改它不会污染进程内的内置常量", () => {
    const plan = planOpencodeProfile(true, "");
    plan.env.ZEN_FREE_PREFER = "mutated";
    expect(BUILTIN_PROFILES["opencode-zen-free"].env.ZEN_FREE_PREFER).toBe("deepseek,glm,mimo");
  });

  it("不变量：init 产出的 env 与 `profile create opencode-zen-free` 落盘的 env 逐字段相同", () => {
    const home = mkdtempSync(join(tmpdir(), "aex-init-plan-"));
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          executors: { opencode: { bin: "/bin/ls" } },
          profiles: { default: { executor: "opencode", env: {} } },
          notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: BRAND },
          defaults: { profile: "default", timeout_sec: 3600 },
        }, null, 2),
      );
      createProfile(home, "opencode-zen-free");
      const fromCreate = readConfig(home).profiles["opencode-zen-free"];
      const fromInit = planOpencodeProfile(true, "");
      expect(fromInit.profile).toBe("opencode-zen-free");
      expect(fromInit.env).toEqual(fromCreate.env);
      // 两边都必须带偏好字段（这是当初 init 漏掉的那一个）
      expect(fromInit.env.ZEN_FREE_PREFER).toBe("deepseek,glm,mimo");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("missingTokenKey —— 零密钥配置不许报假警报", () => {
  it("opencode zen free（无 ANTHROPIC_AUTH_TOKEN）→ undefined，不提醒", () => {
    // 2026-10-26 实测：原先兜底成 {env:MINIMAX_API_KEY}，opencode + zen free
    // 跑完 init 必出"去设 MINIMAX_API_KEY，否则任务会失败"的假警报。
    const env = { OPENCODE_CONFIG_CONTENT: "{}", ZEN_FREE_PREFER: "deepseek,glm,mimo" };
    expect(missingTokenKey(env, new Set())).toBeUndefined();
  });

  it("claude 预设且 .env 里没有 → 报出缺的变量名", () => {
    expect(missingTokenKey({ ANTHROPIC_AUTH_TOKEN: "{env:MINIMAX_API_KEY}" }, new Set())).toBe("MINIMAX_API_KEY");
  });

  it("claude 预设且 .env 里已有 → undefined", () => {
    expect(missingTokenKey({ ANTHROPIC_AUTH_TOKEN: "{env:MINIMAX_API_KEY}" }, new Set(["MINIMAX_API_KEY"]))).toBeUndefined();
  });

  it("custom 预设的变量名由 profile 派生，照样能报出来", () => {
    expect(missingTokenKey({ ANTHROPIC_AUTH_TOKEN: "{env:MYPROV_API_KEY}" }, new Set())).toBe("MYPROV_API_KEY");
  });
});

describe("MCP 配置片段（2026-10-10 实测：必须绝对路径）", () => {
  it("command 是 node 解释器绝对路径，不是裸命令名", () => {
    const parsed = JSON.parse(mcpServerSnippet("/x/dist/server.js"));
    const entry = parsed.mcpServers["agent-ex"];
    // 回归防线：曾输出 {command:"agent-ex"}，MCP 客户端 spawn 时无 PATH → command not found。
    expect(entry.command).not.toBe("agent-ex");
    expect(isAbsolute(entry.command)).toBe(true);
    expect(entry.command).toBe(nodeExecPath());
  });
  it("args 带 server 入口绝对路径，且片段是合法 JSON", () => {
    const parsed = JSON.parse(mcpServerSnippet("/x/dist/server.js"));
    expect(parsed.mcpServers["agent-ex"].args).toEqual(["/x/dist/server.js"]);
  });
  it("server 入口由 init 自身位置推导，不依赖 cwd", () => {
    const entry = resolveServerEntry();
    expect(isAbsolute(entry)).toBe(true);
    expect(entry.endsWith("/server.js")).toBe(true);
  });
});

describe("nextSteps 收尾指引", () => {
  const text = nextSteps("/home/u/.agent-ex", "/abs/dist/server.js");
  it("包含数据目录、注册片段与 skill 安装指引", () => {
    expect(text).toContain("AGENT_EX_HOME=/home/u/.agent-ex");
    expect(text).toContain("/abs/dist/server.js");
    expect(text).toContain("skills add wuruofan/agent-ex");
  });
  it("解释了绝对路径的原因（PATH 不可继承）与宿主 skills 目录查找法", () => {
    expect(text).toMatch(/without your shell PATH|不继承/);
    expect(text).toContain("find ~ -maxdepth 4");
  });
});
