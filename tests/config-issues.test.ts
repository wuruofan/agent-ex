import { describe, expect, it } from "vitest";
import {
  collectConfigIssues,
  effectiveProfileCost,
  isStructurallyFree,
  validateConfig,
  type Config,
} from "../src/config.js";
import { BRAND } from "../src/brand.js";
import { ZEN_FREE_PLACEHOLDER } from "../src/zen-free.js";

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
    profiles: { default: { executor: "claude", env: {}, cost: "free" } },
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

describe("collectConfigIssues —— profile.path_dirs 形状校验", () => {
  function withPathPrepend(pathDirs: unknown): Record<string, unknown> {
    return baseCfg({ profiles: { default: { executor: "claude", env: {}, path_dirs: pathDirs } } });
  }

  function onlyPathPrependIssue(pathDirs: unknown) {
    const hits = collectConfigIssues(withPathPrepend(pathDirs)).filter((i) => i.code === "profile.path_dirs");
    expect(hits).toHaveLength(1);
    expect(hits[0].subject).toBe("default");
    expect(hits[0].message).toContain("path_dirs");
    expect(hits[0].fix).toContain("profile set default path_dirs");
    return hits[0];
  }

  it("合法值不产出 issue", () => {
    expect(collectConfigIssues(withPathPrepend(["/a", "/b"])).filter((i) => i.code === "profile.path_dirs")).toEqual([]);
  });

  it("未配置时不产出 issue（老配置零影响）", () => {
    expect(collectConfigIssues(baseCfg()).filter((i) => i.code === "profile.path_dirs")).toEqual([]);
  });

  it("不是数组时报出", () => {
    expect(onlyPathPrependIssue("/a").message).toContain("array");
  });

  it("元素不是字符串时报出", () => {
    expect(onlyPathPrependIssue(["/a", 1]).message).toContain("strings");
  });

  it("元素为空串时报出", () => {
    expect(onlyPathPrependIssue([""]).message).toContain("non-empty");
  });

  it("元素不是绝对路径时报出", () => {
    expect(onlyPathPrependIssue(["relative/bin"]).message).toContain("absolute");
  });

  it("有重复项时报出", () => {
    expect(onlyPathPrependIssue(["/a", "/a"]).message).toContain("duplicated");
  });
});

describe("profile.cost —— 未声明 / 非法值", () => {
  it("未声明 cost 且非结构化 free ⇒ 一条 info issue（带 subject 与 fix）", () => {
    // claude + 空 env ⇒ 结构化判定不是 free
    const issues = collectConfigIssues(baseCfg({ profiles: { default: { executor: "claude", env: {} } } }));
    const i = issues.find((x) => x.code === "profile.cost");
    expect(i).toBeDefined();
    expect(i!.severity).toBe("info");
    expect(i!.subject).toBe("default");
    expect(i!.message).toMatch(/metered/);
    expect(i!.message).toMatch(/allow_metered/);
    // ⚠️ 回归锁（P0-1）：fix 方向必须是把隐式默认显式化，绝不能是 cost free
    expect(i!.fix).toBe("agent-ex profile set default cost metered");
    expect(i!.fix).not.toContain("cost free");
  });

  it("结构化 free 的 profile 未声明 cost 时不报 info（zen-free 不受影响）", () => {
    const issues = collectConfigIssues(baseCfg({
      executors: { opencode: { bin: "/bin/ls" } },
      profiles: {
        zen: {
          executor: "opencode",
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              model: ZEN_FREE_PLACEHOLDER,
              small_model: ZEN_FREE_PLACEHOLDER,
            }),
          },
        },
      },
      defaults: { profile: "zen", timeout_sec: 3600 },
    }));
    expect(issues.filter((x) => x.code === "profile.cost")).toEqual([]);
  });

  it("cost 值非法 ⇒ severity error（不是 info）", () => {
    const issues = collectConfigIssues(baseCfg({
      profiles: { default: { executor: "claude", env: {}, cost: "paid" } },
    }));
    const i = issues.find((x) => x.code === "profile.cost");
    expect(i).toBeDefined();
    expect(i!.severity).toBe("error");
    expect(i!.subject).toBe("default");
    expect(i!.message).toContain("paid");
    expect(i!.fix).toBeTruthy();
  });

  it("声明合法的 free / metered 不产出 cost issue", () => {
    for (const cost of ["free", "metered"] as const) {
      const issues = collectConfigIssues(baseCfg({ profiles: { default: { executor: "claude", env: {}, cost } } }));
      expect(issues.filter((x) => x.code === "profile.cost")).toEqual([]);
    }
  });
});

describe("effectiveProfileCost / isStructurallyFree —— 判定唯一真相源", () => {
  const zenEnv = (model: unknown, smallModel?: unknown): Record<string, string> => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      smallModel === undefined ? { model } : { model, small_model: smallModel },
    ),
  });

  it("V1：未声明且非结构化 free ⇒ metered；声明 free ⇒ free（声明优先）", () => {
    expect(effectiveProfileCost({ executor: "claude", env: {} })).toBe("metered");
    // 声明优先：即使结构判定不 free，也尊重声明
    expect(effectiveProfileCost({ executor: "claude", env: {}, cost: "free" })).toBe("free");
    // 声明 metered 时即使结构像 free 也按 metered
    expect(
      effectiveProfileCost({ executor: "opencode", env: zenEnv(ZEN_FREE_PLACEHOLDER, ZEN_FREE_PLACEHOLDER), cost: "metered" }),
    ).toBe("metered");
  });

  it("未声明 + 两个模型字段都是占位符 ⇒ free", () => {
    expect(
      effectiveProfileCost({ executor: "opencode", env: zenEnv(ZEN_FREE_PLACEHOLDER, ZEN_FREE_PLACEHOLDER) }),
    ).toBe("free");
  });

  it("V3：只有 model 是占位符、small_model 缺省 ⇒ 不是 free（fail-safe）", () => {
    expect(isStructurallyFree("opencode", zenEnv(ZEN_FREE_PLACEHOLDER))).toBe(false);
    expect(effectiveProfileCost({ executor: "opencode", env: zenEnv(ZEN_FREE_PLACEHOLDER) })).toBe("metered");
  });

  it("V2：model 是占位符但 small_model 是硬编码 id ⇒ 不是 free", () => {
    expect(isStructurallyFree("opencode", zenEnv(ZEN_FREE_PLACEHOLDER, "opencode/paid-model"))).toBe(false);
  });

  it("V2b：model 是硬编码 id 但 small_model 是占位符 ⇒ 不是 free", () => {
    expect(isStructurallyFree("opencode", zenEnv("opencode/paid-model", ZEN_FREE_PLACEHOLDER))).toBe(false);
  });

  it("executor 不是 opencode ⇒ 不是 free", () => {
    expect(isStructurallyFree("claude", zenEnv(ZEN_FREE_PLACEHOLDER, ZEN_FREE_PLACEHOLDER))).toBe(false);
  });

  it("OPENCODE_CONFIG_CONTENT 不是合法 JSON ⇒ false，不抛", () => {
    expect(() => isStructurallyFree("opencode", { OPENCODE_CONFIG_CONTENT: "{not json" })).not.toThrow();
    expect(isStructurallyFree("opencode", { OPENCODE_CONFIG_CONTENT: "{not json" })).toBe(false);
    expect(isStructurallyFree("opencode", {})).toBe(false);
  });

  it("executorOverride 优先于 profile.executor（续跑按任务行的 executor 判定）", () => {
    const profile = { executor: "opencode", env: zenEnv(ZEN_FREE_PLACEHOLDER, ZEN_FREE_PLACEHOLDER) };
    expect(effectiveProfileCost(profile)).toBe("free");
    // 任务行是 claude ⇒ runner 实际起的是付费 CLI ⇒ 按 metered
    expect(effectiveProfileCost(profile, "claude")).toBe("metered");
  });
});

describe("validateConfig —— 抛第一条 error（不是 issues[0]）", () => {
  it("info 在前、error 在后时，抛的是 error 的 message", () => {
    // profile 无 cost ⇒ info（profiles 循环，排在前）
    // timeout 是字符串 ⇒ error（defaults 规则，排在后）
    const cfg = baseCfg({
      profiles: { default: { executor: "claude", env: {} } },
      defaults: { profile: "default", timeout_sec: "3600" },
    });
    const issues = collectConfigIssues(cfg);
    expect(issues[0].code).toBe("profile.cost");
    expect(issues[0].severity).toBe("info");
    const firstError = issues.find((i) => i.severity !== "info");
    expect(firstError!.code).toBe("defaults.timeout_sec");

    // 旧实现取 issues[0] 会抛 info 文案；现在必须抛 error 那条。
    expect(() => validateConfig(cfg as unknown as Config)).toThrow(firstError!.message);
    expect(() => validateConfig(cfg as unknown as Config)).not.toThrow(/has no cost declared/);
  });

  it("正常配置不抛错（info 不阻断）", () => {
    expect(() => validateConfig(baseCfg() as unknown as Config)).not.toThrow();
    // 老配置（无 cost）只有 info ⇒ 也不抛
    const legacy = baseCfg({ profiles: { default: { executor: "claude", env: {} } } });
    expect(() => validateConfig(legacy as unknown as Config)).not.toThrow();
  });
});
