import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentExHome, dbPath, logsDir } from "../src/paths.js";
import { loadConfig, resolveEnvPlaceholders } from "../src/config.js";
import { buildConfig } from "../src/init.js";
import { BRAND, HOME_DIR_NAME } from "../src/brand.js";

// 用 process.execPath 作为 fixture bin：保证测试环境一定存在（validate 会做 existsSync 校验）。
const validConfig = {
  executors: {
    claude: { bin: process.execPath, extra_flags: ["--dangerously-skip-permissions"] },
  },
  profiles: {
    "minimax-3": {
      executor: "claude",
      env: { ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic", ANTHROPIC_AUTH_TOKEN: "{env:MINIMAX_API_KEY}" },
    },
  },
  notify: { feishu_webhook_url: "https://open.feishu.cn/hook/x", dry_run: true },
  defaults: { profile: "minimax-3", timeout_sec: 3600 },
};

describe("paths", () => {
  beforeEach(() => { process.env.AGENT_EX_HOME = mkdtempSync(join(tmpdir(), "afex-")); });
  afterEach(() => { rmSync(process.env.AGENT_EX_HOME!, { recursive: true, force: true }); delete process.env.AGENT_EX_HOME; });

  it("resolves home from env with fallback to ~/.agent-ex", () => {
    expect(agentExHome()).toBe(process.env.AGENT_EX_HOME);
    const savedHome = process.env.HOME;
    const savedAfHome = process.env.AGENT_EX_HOME;
    delete process.env.AGENT_EX_HOME;
    expect(agentExHome()).toBe(join(savedHome!, HOME_DIR_NAME));
    expect(HOME_DIR_NAME).toBe(`.${BRAND}`); // 目录名派生自品牌名，不是各自硬编码
    process.env.AGENT_EX_HOME = savedAfHome;
  });
  it("derives db and logs paths", () => {
    expect(dbPath()).toBe(join(agentExHome(), "tasks.db"));
    expect(logsDir()).toBe(join(agentExHome(), "logs"));
  });
});

describe("loadConfig", () => {
  it("loads and validates a valid config", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    writeFileSync(join(home, "config.json"), JSON.stringify(validConfig));
    const cfg = loadConfig(home);
    expect(cfg.profiles["minimax-3"].executor).toBe("claude");
    rmSync(home, { recursive: true, force: true });
  });
  it("rejects profile referencing unknown executor", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const bad = structuredClone(validConfig);
    bad.profiles["minimax-3"].executor = "nope";
    writeFileSync(join(home, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(home)).toThrow(/executor/);
    rmSync(home, { recursive: true, force: true });
  });
  it("rejects missing defaults.profile target", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const bad = structuredClone(validConfig);
    bad.defaults.profile = "ghost";
    writeFileSync(join(home, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(home)).toThrow(/ghost/);
    rmSync(home, { recursive: true, force: true });
  });
  it("rejects nonexistent executor bin (fail-fast over queued-and-stuck)", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const bad = structuredClone(validConfig);
    bad.executors.claude.bin = "/nonexistent/path/to/claude";
    writeFileSync(join(home, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(home)).toThrow(/not found or not executable/);
    rmSync(home, { recursive: true, force: true });
  });

  // 2026-10-16 实测：本机 live config 的 notify.keyword 一直留着改名前的 `agent-flow-ex`，
  // 而 config.example.json / README 早就是新名 ⇒ 连续 23 个任务的终态卡被飞书静默拒收
  // （code=19024）。仓库测试照不到 live config，所以缺省值必须由代码派生且被测试钉住。
  it("defaults notify.keyword to BRAND when the user did not set one", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    writeFileSync(join(home, "config.json"), JSON.stringify(validConfig)); // 无 keyword
    expect(loadConfig(home).notify.keyword).toBe(BRAND);
    rmSync(home, { recursive: true, force: true });
  });
  it("keeps an explicit user keyword (the bot's registered word is theirs to choose)", () => {
    const home = mkdtempSync(join(tmpdir(), "afex-"));
    const custom = structuredClone(validConfig);
    (custom.notify as Record<string, unknown>).keyword = "my-own-word";
    writeFileSync(join(home, "config.json"), JSON.stringify(custom));
    expect(loadConfig(home).notify.keyword).toBe("my-own-word");
    rmSync(home, { recursive: true, force: true });
  });
});

/**
 * 防漂移：文档/示例里写死的品牌名必须等于 BRAND。
 * 2026-10-16 的真实故障正是"文档已改、live config 没改"这类不一致的下游后果；
 * 这里把示例与 README 纳入断言范围，下次改名漏改任何一处都会红。
 */
describe("brand consistency", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  it("config.example.json ships the same keyword as BRAND", () => {
    const raw = readFileSync(join(repoRoot, "config.example.json"), "utf8");
    const parsed = JSON.parse(raw) as { notify: { keyword?: string } };
    expect(parsed.notify.keyword).toBe(BRAND);
  });
  it("README documents the same keyword", () => {
    const raw = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(raw).toContain(`"keyword": "${BRAND}"`);
  });
  it("init writes the same keyword into a fresh config", () => {
    const notify = buildConfig({
      executor: "claude",
  cost: "metered",
      bin: process.execPath,
      profile: "p",
      env: {},
      notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: BRAND },
      timeout_sec: 3600,
    }).notify;
    expect(notify.keyword).toBe(BRAND);
  });
});

/**
 * 防漂移：Registry 元数据的三份副本（package.json / server.json / mcpName）必须同步。
 * `npm version` 只改 package.json 与 package-lock.json，不会碰 server.json；而 Registry 里
 * 同一版本号不可重发 ⇒ 漏 bump 时 publish 会直接失败。这里把一致性钉在测试阶段。
 */
describe("registry manifest consistency", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
    mcpName?: string;
  };
  const server = JSON.parse(readFileSync(join(repoRoot, "server.json"), "utf8")) as {
    name: string;
    version: string;
    packages: Array<{ version: string }>;
  };

  it("server.json version matches package.json (top level and packages entry)", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]?.version).toBe(pkg.version);
  });
  it("mcpName points at the same server name the registry manifest declares", () => {
    expect(pkg.mcpName).toBe(server.name);
  });
});

describe("resolveEnvPlaceholders", () => {
  it("resolves {env:VAR} placeholders from process.env", () => {
    process.env.MINIMAX_API_KEY = "sk-test";
    expect(resolveEnvPlaceholders({ A: "{env:MINIMAX_API_KEY}", B: "literal" })).toEqual({ A: "sk-test", B: "literal" });
    delete process.env.MINIMAX_API_KEY;
  });
  it("throws on missing placeholder env", () => {
    delete process.env.NO_SUCH_KEY_XYZ;
    expect(() => resolveEnvPlaceholders({ A: "{env:NO_SUCH_KEY_XYZ}" })).toThrow(/NO_SUCH_KEY_XYZ/);
  });
});