import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listConfig, setConfigValue, useProfile, readConfig, BUILTIN_PROFILES, WRITABLE } from "../src/config-cmd.js";
import { BRAND } from "../src/brand.js";
import { ZEN_FREE_PLACEHOLDER } from "../src/zen-free.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "aex-cfg-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function seed(over: Record<string, unknown> = {}): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executors: { claude: { bin: "/bin/ls" } },
    profiles: { default: { executor: "claude", env: { ANTHROPIC_MODEL: "M3" } } },
    notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: BRAND },
    defaults: { profile: "default", timeout_sec: 3600 },
    ...over,
  }, null, 2));
}

describe("config list", () => {
  it("列出 profiles / notify / defaults，并标出默认 profile", () => {
    seed();
    const l = listConfig(home);
    expect(l.profiles.map((p) => p.name)).toEqual(["default"]);
    expect(l.profiles[0].is_default).toBe(true);
    expect(l.notify.dry_run).toBe(true);
    expect(l.notify.keyword).toBe(BRAND);
    expect(l.defaults.timeout_sec).toBe(3600);
  });
});

describe("config set —— 白名单字段", () => {
  it("改 notify.dry_run", () => {
    seed();
    const r = setConfigValue(home, "notify.dry_run", "false");
    expect(r.value).toBe(false);
    expect(readConfig(home).notify.dry_run).toBe(false);
  });

  it("改 notify.keyword", () => {
    seed();
    setConfigValue(home, "notify.keyword", "my-bot");
    expect(readConfig(home).notify.keyword).toBe("my-bot");
  });

  it("改 defaults.timeout_sec", () => {
    seed();
    setConfigValue(home, "defaults.timeout_sec", "900");
    expect(readConfig(home).defaults.timeout_sec).toBe(900);
  });

  it("拒绝白名单外的 key（防止手抖写坏 config）", () => {
    seed();
    expect(() => setConfigValue(home, "notify.webhook_url", "x")).toThrow(/unknown key/);
    expect(() => setConfigValue(home, "profiles.default.env", "x")).toThrow(/unknown key/);
  });

  it("类型不对时拒绝且不写盘", () => {
    seed();
    expect(() => setConfigValue(home, "notify.dry_run", "maybe")).toThrow(/true\|false/);
    expect(() => setConfigValue(home, "defaults.timeout_sec", "-1")).toThrow(/positive integer/);
    expect(readConfig(home).notify.dry_run).toBe(true);
  });

  it("可写字段就是白名单里的那些", () => {
    expect(Object.keys(WRITABLE).sort()).toEqual([
      "defaults.profile", "defaults.timeout_sec", "notify.dry_run", "notify.keyword",
    ]);
  });
});

describe("config use —— 切默认 profile", () => {
  it("切到已存在的 profile", () => {
    seed({ profiles: { a: { executor: "claude", env: {} }, b: { executor: "claude", env: {} } } });
    const r = useProfile(home, "b");
    expect(r.created).toBe(false);
    expect(readConfig(home).defaults.profile).toBe("b");
  });

  it("切到内置的 opencode-zen-free：自动创建 profile 并复用已有 executor", () => {
    seed();
    const r = useProfile(home, "opencode-zen-free");
    expect(r.created).toBe(true);
    const c = readConfig(home);
    expect(c.defaults.profile).toBe("opencode-zen-free");
    expect(c.profiles["opencode-zen-free"].executor).toBe("opencode");
    // executor 不存在时才新建
    expect(c.executors.opencode).toBeDefined();
    // env 必须是占位符形态（真实模型名在 spawn 时动态解析）
    const env = c.profiles["opencode-zen-free"].env;
    expect(env.OPENCODE_CONFIG_CONTENT).toContain(ZEN_FREE_PLACEHOLDER);
  });

  it("opencode executor 不存在时自动注册（带 --auto）", () => {
    seed();
    useProfile(home, "opencode-zen-free");
    const c = readConfig(home);
    expect(c.executors.opencode.extra_flags).toEqual(["--auto"]);
  });

  it("切到不存在的非内置 profile 时报错并列出可选项", () => {
    seed();
    expect(() => useProfile(home, "nope")).toThrow(/unknown profile/);
    expect(() => useProfile(home, "nope")).toThrow(/opencode-zen-free/);
  });

  it("内置 profile 清单就是那一个免费模型", () => {
    expect(Object.keys(BUILTIN_PROFILES)).toEqual(["opencode-zen-free"]);
  });
});
