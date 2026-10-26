import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listConfig,
  setConfigValue,
  useProfile,
  createProfile,
  setProfileValue,
  readConfig,
  BUILTIN_PROFILES,
  WRITABLE,
} from "../src/config-cmd.js";
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

  it("bin_ok 是真的探测结果，不是恒为 true 的安慰字段", () => {
    seed({ executors: { claude: { bin: "/bin/ls" }, ghost: { bin: "/definitely/not/here" } } });
    const l = listConfig(home);
    expect(l.executors.find((e) => e.name === "claude")?.bin_ok).toBe(true);
    expect(l.executors.find((e) => e.name === "ghost")?.bin_ok).toBe(false);
  });

  it("列出 profile 的环境变量名（值可能很大，只给名字）", () => {
    seed();
    const l = listConfig(home);
    expect(l.profiles[0].env).toEqual(["ANTHROPIC_MODEL"]);
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
    expect(() => setConfigValue(home, "notify.webhook_url", "x")).toThrow(/Unknown key/);
    expect(() => setConfigValue(home, "profiles.default.env", "x")).toThrow(/Unknown key/);
  });

  it("defaults.profile 不在白名单里（切默认只走 profile use）", () => {
    seed();
    expect(() => setConfigValue(home, "defaults.profile", "other")).toThrow(/Unknown key/);
  });

  it("类型不对时拒绝且不写盘", () => {
    seed();
    expect(() => setConfigValue(home, "notify.dry_run", "maybe")).toThrow(/true\|false/);
    expect(() => setConfigValue(home, "defaults.timeout_sec", "-1")).toThrow(/positive integer/);
    expect(readConfig(home).notify.dry_run).toBe(true);
  });

  it("拒绝空串（空 keyword 会让卡片不带关键词 ⇒ 飞书必然拒收 19024）", () => {
    seed();
    expect(() => setConfigValue(home, "notify.keyword", "")).toThrow(/non-empty/);
    expect(() => setConfigValue(home, "notify.keyword", "   ")).toThrow(/non-empty/);
    expect(readConfig(home).notify.keyword).toBe(BRAND);
  });

  it("整数解析必须严格（parseInt 会把 3600abc 静默写成 3600、3.7 写成 3）", () => {
    seed();
    expect(() => setConfigValue(home, "defaults.timeout_sec", "3600abc")).toThrow(/positive integer/);
    expect(() => setConfigValue(home, "defaults.timeout_sec", "3.7")).toThrow(/positive integer/);
    expect(readConfig(home).defaults.timeout_sec).toBe(3600);
  });

  it("可写固定字段就是白名单里的那些", () => {
    expect(Object.keys(WRITABLE).sort()).toEqual([
      "defaults.timeout_sec", "notify.dry_run", "notify.keyword",
    ]);
  });
});

describe("config set executors.<name>.bin —— 定点修坏 bin", () => {
  it("改 bin 并落盘", () => {
    seed({ executors: { claude: { bin: "/definitely/not/here" } } });
    setConfigValue(home, "executors.claude.bin", "/bin/ls");
    expect(readConfig(home).executors.claude.bin).toBe("/bin/ls");
  });

  it("executor 不存在时拒绝（不静默创建）", () => {
    seed();
    expect(() => setConfigValue(home, "executors.ghost.bin", "/bin/ls")).toThrow(/Unknown executor/);
    expect(readConfig(home).executors.ghost).toBeUndefined();
  });

  it("值不可执行时拒绝（写一个坏路径正是在重犯要修的错）", () => {
    seed();
    expect(() => setConfigValue(home, "executors.claude.bin", "/definitely/not/here")).toThrow(/executable path/);
    expect(readConfig(home).executors.claude.bin).toBe("/bin/ls");
  });
});

describe("profile use —— 纯切换，不物化", () => {
  it("切到已存在的 profile", () => {
    seed({ profiles: { a: { executor: "claude", env: {} }, b: { executor: "claude", env: {} } } });
    useProfile(home, "b");
    expect(readConfig(home).defaults.profile).toBe("b");
  });

  it("切到不存在的 profile 时报错并列出可选项（不隐式创建）", () => {
    seed({ profiles: { a: { executor: "claude", env: {} } } });
    expect(() => useProfile(home, "nope")).toThrow(/Unknown profile/);
    expect(() => useProfile(home, "nope")).toThrow(/a/);
    // 没有被创建
    expect(readConfig(home).profiles.nope).toBeUndefined();
  });

  it("内置名提示先 create（不再隐式物化）", () => {
    seed();
    expect(() => useProfile(home, "opencode-zen-free")).toThrow(/profile create/);
    expect(readConfig(home).profiles["opencode-zen-free"]).toBeUndefined();
  });
});

describe("profile create —— 物化内置预设（只创建，不切默认）", () => {
  it("创建 profile 并注册 executor，但不切默认", () => {
    seed();
    const r = createProfile(home, "opencode-zen-free", { bin: "/bin/ls" });
    expect(r.executor_created).toBe(true);
    const c = readConfig(home);
    expect(c.profiles["opencode-zen-free"].executor).toBe("opencode");
    expect(c.executors.opencode).toBeDefined();
    // 只创建，不切默认
    expect(c.defaults.profile).toBe("default");
  });

  it("env 必须是占位符形态（真实模型名在 spawn 时动态解析）", () => {
    seed();
    createProfile(home, "opencode-zen-free", { bin: "/bin/ls" });
    const env = readConfig(home).profiles["opencode-zen-free"].env;
    expect(env.OPENCODE_CONFIG_CONTENT).toContain(ZEN_FREE_PLACEHOLDER);
  });

  it("executor 不存在时自动注册（带 --auto）", () => {
    seed();
    createProfile(home, "opencode-zen-free", { bin: "/bin/ls" });
    expect(readConfig(home).executors.opencode.extra_flags).toEqual(["--auto"]);
  });

  it("executor 已存在时复用，不覆盖", () => {
    seed({ executors: { claude: { bin: "/bin/ls" }, opencode: { bin: "/bin/ls" } } });
    const r = createProfile(home, "opencode-zen-free");
    expect(r.executor_created).toBe(false);
    expect(readConfig(home).executors.opencode.bin).toBe("/bin/ls");
  });

  /**
   * 回归 P1-2：opencode 装了但不在 PATH 上时，create 曾是**死路**——
   * validateConfig 在落盘前拒绝 ⇒ executor 条目写不进去 ⇒
   * 而 `config set executors.<name>.bin` 要求 name 已存在 ⇒ 用户被两条规则夹死。
   * 现在：--bin 给出出路，且错误信息直接把它说清楚。
   */
  it("executor 不在 PATH 上时报错并给出 --bin 的用法（不能是死路）", () => {
    seed();
    // 精确复现"装了但不在 PATH"：临时把 PATH 清空
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-bin-dir";
    try {
      expect(() => createProfile(home, "opencode-zen-free")).toThrow(/--bin/);
      // 给了 --bin 就能落地
      createProfile(home, "opencode-zen-free", { bin: "/bin/ls" });
      expect(readConfig(home).profiles["opencode-zen-free"]).toBeDefined();
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("bin 不可执行时报错", () => {
    seed();
    expect(() => createProfile(home, "opencode-zen-free", { bin: "/definitely/not/here" })).toThrow(/not found or not executable/);
    expect(readConfig(home).profiles["opencode-zen-free"]).toBeUndefined();
  });

  it("非内置名报错", () => {
    seed();
    expect(() => createProfile(home, "nope")).toThrow(/Unknown built-in/);
  });

  it("已存在时报错并指向 profile use", () => {
    seed();
    createProfile(home, "opencode-zen-free", { bin: "/bin/ls" });
    expect(() => createProfile(home, "opencode-zen-free")).toThrow(/already exists/);
  });

  /**
   * `create --use` 一步到位：物化 + 切默认。
   * 为什么不让 `use` 自动物化：`create` 可能需要 --bin（opencode 常在 ~/.opencode/bin），
   * 而 `use` 是纯切换，不该悄悄写新 profile / executor —— 半步失败就会留下半截配置。
   */
  it("--use 在创建的同时切默认，且不改动其它 profile", () => {
    seed({
      profiles: { keep: { executor: "claude", env: {} } },
      defaults: { profile: "keep", timeout_sec: 3600 },
    });
    const r = createProfile(home, "opencode-zen-free", { bin: "/bin/ls", use: true });
    expect(r.switched_default).toBe(true);
    const c = readConfig(home);
    expect(c.profiles["opencode-zen-free"]).toBeDefined();
    expect(c.profiles.keep).toBeDefined();
    expect(c.defaults.profile).toBe("opencode-zen-free");
  });

  it("不加 --use 时不切默认（保持纯创建）", () => {
    seed();
    const r = createProfile(home, "opencode-zen-free", { bin: "/bin/ls" });
    expect(r.switched_default).toBe(false);
    expect(readConfig(home).defaults.profile).toBe("default");
  });

  it("内置 profile 清单就是那一个免费模型", () => {
    expect(Object.keys(BUILTIN_PROFILES)).toEqual(["opencode-zen-free"]);
  });

  it("物化时深拷贝 env（不能污染进程内的内置常量）", () => {
    seed();
    createProfile(home, "opencode-zen-free", { bin: "/bin/ls" });
    setProfileValue(home, "opencode-zen-free", "ZEN_FREE_PREFER", "deepseek,mimo");
    // 内置常量本身没被改
    expect(BUILTIN_PROFILES["opencode-zen-free"].env.ZEN_FREE_PREFER).toBe("deepseek,glm,mimo");
  });

  it("内置偏好不含已消失的家族前缀（ling 已在上游下线）", () => {
    // 2026-10-26 实测实时清单：free 模型只剩 deepseek / glm / mimo / nemotron / beam / flint / jev
    const prefer = BUILTIN_PROFILES["opencode-zen-free"].env.ZEN_FREE_PREFER;
    expect(prefer.split(",").map((s) => s.trim())).not.toContain("ling");
    // 口味顺序：deepseek 优先
    expect(prefer.split(",")[0].trim()).toBe("deepseek");
  });
});

describe("profile set —— 改 profile 的字段（键必须受约束）", () => {
  it("改 env 变量", () => {
    seed();
    setProfileValue(home, "default", "ZEN_FREE_PREFER", "deepseek,mimo");
    expect(readConfig(home).profiles.default.env.ZEN_FREE_PREFER).toBe("deepseek,mimo");
  });

  it("用保留字 executor 改用哪个 executor", () => {
    seed({ executors: { claude: { bin: "/bin/ls" }, other: { bin: "/bin/ls" } } });
    setProfileValue(home, "default", "executor", "other");
    expect(readConfig(home).profiles.default.executor).toBe("other");
  });

  it("executor 指向不存在的名字时拒绝", () => {
    seed();
    expect(() => setProfileValue(home, "default", "executor", "nope")).toThrow(/Unknown executor/);
  });

  it("拒绝会改写 worker 启动面的 key（NODE_OPTIONS ≈ 任意代码执行）", () => {
    seed();
    expect(() => setProfileValue(home, "default", "NODE_OPTIONS", "--require=/tmp/evil.js")).toThrow(/not allowed/);
    expect(() => setProfileValue(home, "default", "PATH", "/tmp")).toThrow(/not allowed/);
    expect(() => setProfileValue(home, "default", "LD_PRELOAD", "/tmp/x.so")).toThrow(/not allowed/);
    expect(() => setProfileValue(home, "default", "DYLD_INSERT_LIBRARIES", "/tmp/x.dylib")).toThrow(/not allowed/);
    expect(readConfig(home).profiles.default.env.NODE_OPTIONS).toBeUndefined();
  });

  it("拒绝小写/含横线的 env key", () => {
    seed();
    expect(() => setProfileValue(home, "default", "bad_key", "x")).toThrow(/not a valid env key/);
    expect(() => setProfileValue(home, "default", "lower", "x")).toThrow(/not a valid env key/);
  });

  it("拒绝空值", () => {
    seed();
    expect(() => setProfileValue(home, "default", "SOME_KEY", "  ")).toThrow(/non-empty/);
  });

  it("profile 不存在时报错", () => {
    seed();
    expect(() => setProfileValue(home, "ghost", "SOME_KEY", "x")).toThrow(/Unknown profile/);
  });

  it("OPENCODE_CONFIG_CONTENT 必须是合法 JSON 且含 model", () => {
    seed();
    expect(() => setProfileValue(home, "default", "OPENCODE_CONFIG_CONTENT", "{not json")).toThrow(/valid JSON/);
    expect(() => setProfileValue(home, "default", "OPENCODE_CONFIG_CONTENT", "{}")).toThrow(/model/);
  });

  it("内置 zen-free profile 必须保留动态解析占位符（不能被换成硬编码模型名）", () => {
    seed();
    createProfile(home, "opencode-zen-free", { bin: "/bin/ls" });
    expect(() =>
      setProfileValue(home, "opencode-zen-free", "OPENCODE_CONFIG_CONTENT", JSON.stringify({ model: "some/model" })),
    ).toThrow(/placeholder/);
    // 保留占位符就能写
    setProfileValue(
      home,
      "opencode-zen-free",
      "OPENCODE_CONFIG_CONTENT",
      JSON.stringify({ model: ZEN_FREE_PLACEHOLDER, small_model: ZEN_FREE_PLACEHOLDER }),
    );
    expect(readConfig(home).profiles["opencode-zen-free"].env.OPENCODE_CONFIG_CONTENT).toContain(ZEN_FREE_PLACEHOLDER);
  });
});
