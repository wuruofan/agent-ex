import { describe, expect, it } from "vitest";
import { collectConfigIssues, validateConfig, type Config } from "../src/config.js";
import { BRAND } from "../src/brand.js";

/**
 * config 的**唯一**校验真相源。
 *
 * 2026-10-23 的教训：doctor 手写 4 类检查、config.ts 手写 8 条规则，两份各写各的
 * ⇒ 两处假阴性（doctor 报"一切正常"、loadConfig 抛错、server 起不来）。
 * 现在规则只有这一份，所以这里要钉住"每条规则都有 code、每条 issue 都有 fix"。
 */
function baseCfg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executors: { claude: { bin: "/bin/ls" } },
    profiles: { default: { executor: "claude", env: {} } },
    notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: BRAND },
    defaults: { profile: "default", timeout_sec: 3600 },
    ...over,
  };
}

describe("collectConfigIssues —— 规则的唯一真相源", () => {
  it("正常配置没有 issue", () => {
    expect(collectConfigIssues(baseCfg())).toEqual([]);
  });

  it("吃未校验的原始 JSON 也不抛错（total）", () => {
    // doctor 读的是磁盘上的原始 JSON：defaults/notify 可能整块缺失
    expect(() => collectConfigIssues({})).not.toThrow();
    expect(() => collectConfigIssues(null)).not.toThrow();
    expect(() => collectConfigIssues("nonsense")).not.toThrow();
    expect(() => collectConfigIssues({ executors: "not-an-object" })).not.toThrow();
  });

  it("每条 issue 都带 code、message 与可复制的 fix", () => {
    const issues = collectConfigIssues({
      executors: { ghost: { bin: "/nope" } },
      profiles: { p: { executor: "missing", env: {} } },
      notify: {},
      defaults: { profile: "nope", timeout_sec: "3600" },
    });
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      expect(i.code).toBeTruthy();
      expect(i.message).toBeTruthy();
      // 没有 fix 的 error 等于"标红了却无从下手"
      expect(i.fix).toBeTruthy();
    }
  });

  it("timeout_sec 是字符串时报 issue（doctor 曾对此完全沉默）", () => {
    const issues = collectConfigIssues(baseCfg({ defaults: { profile: "default", timeout_sec: "3600" } }));
    const i = issues.find((x) => x.code === "defaults.timeout_sec");
    expect(i).toBeDefined();
    expect(i!.message).toContain("positive integer");
    expect(i!.fix).toContain("config set defaults.timeout_sec");
  });

  it("defaults 整块缺失时 defaults.profile 仍被报出（曾被静态跳过名单吞掉）", () => {
    const issues = collectConfigIssues(baseCfg({ defaults: undefined }));
    const i = issues.find((x) => x.code === "defaults.profile");
    expect(i).toBeDefined();
    expect(i!.fix).toContain("profile use");
  });

  it("defaults.profile 指向不存在的 profile 时被报出", () => {
    const issues = collectConfigIssues(baseCfg({ defaults: { profile: "ghost", timeout_sec: 3600 } }));
    expect(issues.find((x) => x.code === "defaults.profile")).toBeDefined();
  });

  it("executors / profiles 为空各有自己的 code", () => {
    const issues = collectConfigIssues({ executors: {}, profiles: {}, notify: {}, defaults: {} });
    expect(issues.find((x) => x.code === "executors.empty")).toBeDefined();
    expect(issues.find((x) => x.code === "profiles.empty")).toBeDefined();
  });

  it("profile 指向未知 executor 时被报出，且带定点修复命令", () => {
    const issues = collectConfigIssues(baseCfg({ profiles: { p: { executor: "nope", env: {} } } }));
    const i = issues.find((x) => x.code === "profile.executor");
    expect(i).toBeDefined();
    expect(i!.message).toContain("nope");
    expect(i!.fix).toContain("profiles.p.executor");
  });

  it("executor 的 bin 不可执行时带定点修复命令（而不是让人去跑 init）", () => {
    const issues = collectConfigIssues(baseCfg({ executors: { ghost: { bin: "/nope" } } }));
    const i = issues.find((x) => x.code === "executor.bin");
    expect(i).toBeDefined();
    expect(i!.fix).toContain("config set executors.ghost.bin");
  });

  it("executor 缺 bin 字段时也报出（不是只有'不可执行'这一种坏法）", () => {
    const issues = collectConfigIssues(baseCfg({ executors: { ghost: {} as never } }));
    const i = issues.find((x) => x.code === "executor.bin");
    expect(i).toBeDefined();
    expect(i!.message).toContain("missing");
  });

  it("notify 整块缺失时 webhook 被报出", () => {
    const issues = collectConfigIssues(baseCfg({ notify: undefined }));
    expect(issues.find((x) => x.code === "notify.webhook")).toBeDefined();
  });

  it("keyword 缺失不是 issue（运行时派生 BRAND，且 doctor 要能看见「缺失」这一态）", () => {
    const issues = collectConfigIssues(baseCfg({ notify: { feishu_webhook_url: "{env:X}", dry_run: true } }));
    expect(issues.find((x) => x.code.includes("keyword"))).toBeUndefined();
  });
});

describe("validateConfig —— 文案与规则一一对应", () => {
  it("抛的错与第一条 issue 的 message 一致", () => {
    const cfg = baseCfg({ defaults: { profile: "default", timeout_sec: "3600" } });
    const first = collectConfigIssues(cfg)[0];
    expect(() => validateConfig(cfg as unknown as Config)).toThrow(first.message);
  });

  it("正常配置不抛错", () => {
    expect(() => validateConfig(baseCfg() as unknown as Config)).not.toThrow();
  });
});
