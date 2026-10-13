import { describe, expect, it } from "vitest";
import {
  fetchZenFreeIds,
  pickZenFreeModel,
  resolveZenFreeEnv,
  ZEN_FREE_FALLBACK_MODEL,
  ZEN_FREE_PLACEHOLDER,
} from "../src/zen-free.js";

/** 造一个 typeof fetch 形状的假端点：返回 OpenAI list 格式。 */
function fakeFetch(ids: string[] | "throw" | { ok: false }): typeof fetch {
  const impl = async (): Promise<Response> => {
    if (ids === "throw") throw new Error("network down");
    if (!Array.isArray(ids)) return { ok: false, status: 503 } as Response;
    return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) } as unknown as Response;
  };
  return impl as unknown as typeof fetch;
}

const SAMPLE_IDS = [
  "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free",
  "ling-3.1-flash-free",
  "step-5-preview-free",
  "jev-1.13-free", // 非文本模型，必须被黑名单排除
  "claude-opus-5-5", // 付费模型，必须被过滤
];

describe("pickZenFreeModel（纯函数：过滤 + 黑名单 + 偏好 + 排除）", () => {
  it("只挑 -free 模型，排除付费与 jev-*", () => {
    const pick = pickZenFreeModel(SAMPLE_IDS, "", new Set());
    expect(pick).toBeTruthy();
    expect(pick!.endsWith("-free")).toBe(true);
    expect(pick!.startsWith("jev-")).toBe(false);
  });
  it("偏好前缀按顺序优先（与字母序无关）", () => {
    expect(pickZenFreeModel(SAMPLE_IDS, "ling", new Set())).toBe("ling-3.1-flash-free");
    expect(pickZenFreeModel(SAMPLE_IDS, "nemotron,mimo", new Set())).toBe("nemotron-3.5-lightning-free");
  });
  it("偏好大小写不敏感，且 stale 前缀自动退化为兜底（不报错）", () => {
    expect(pickZenFreeModel(SAMPLE_IDS, "MIMO", new Set())).toBe("mimo-v2.6-flash-free");
    expect(pickZenFreeModel(SAMPLE_IDS, "glm", new Set())).toBe("ling-3.1-flash-free"); // 稳定排序后的第一个
  });
  it("无偏好时按 id 稳定排序，不随上游列表顺序抖动", () => {
    const shuffled = [...SAMPLE_IDS].reverse();
    expect(pickZenFreeModel(shuffled, "", new Set())).toBe(pickZenFreeModel(SAMPLE_IDS, "", new Set()));
  });
  it("排除集生效（撞限换模路由的基础）；全排除返回 null", () => {
    const exclude = new Set(["ling-3.1-flash-free", "mimo-v2.6-flash-free", "nemotron-3.5-lightning-free", "step-5-preview-free"]);
    expect(pickZenFreeModel(SAMPLE_IDS, "mimo", exclude)).toBeNull();
  });
  it("空列表返回 null", () => {
    expect(pickZenFreeModel([], "", new Set())).toBeNull();
  });
});

describe("fetchZenFreeIds", () => {
  it("解析 OpenAI list 格式的 data[].id", async () => {
    expect(await fetchZenFreeIds(fakeFetch(SAMPLE_IDS))).toEqual(SAMPLE_IDS);
  });
  it("非 2xx / 网络异常 → null（fail-safe，不抛）；空 data → []", async () => {
    expect(await fetchZenFreeIds(fakeFetch({ ok: false }))).toBeNull();
    expect(await fetchZenFreeIds(fakeFetch("throw"))).toBeNull();
    expect(await fetchZenFreeIds(fakeFetch([]))).toEqual([]);
  });
});

describe("resolveZenFreeEnv", () => {
  const zenEnv = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: ZEN_FREE_PLACEHOLDER, small_model: ZEN_FREE_PLACEHOLDER }),
    ZEN_FREE_PREFER: "mimo",
  };

  it("无占位符 → 原样透传，零成本旁路", async () => {
    const env = { A: "1" };
    const r = await resolveZenFreeEnv(env, new Set(), fakeFetch(SAMPLE_IDS));
    expect(r.env).toBe(env);
    expect(r.model).toBeNull();
  });
  it("替换所有占位符（model + small_model 同模），其余 {env:VAR} 不受影响", async () => {
    const r = await resolveZenFreeEnv({ ...zenEnv, X: "{env:API_KEY}" }, new Set(), fakeFetch(SAMPLE_IDS));
    const cfg = JSON.parse(r.env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.model).toBe("opencode/mimo-v2.6-flash-free");
    expect(cfg.small_model).toBe("opencode/mimo-v2.6-flash-free");
    expect(r.env.X).toBe("{env:API_KEY}");
    expect(r.model).toBe("opencode/mimo-v2.6-flash-free");
  });
  it("列表拉取失败 → 用内置回退常量，绝不阻塞任务", async () => {
    const r = await resolveZenFreeEnv(zenEnv, new Set(), fakeFetch("throw"));
    expect(JSON.parse(r.env.OPENCODE_CONFIG_CONTENT).model).toBe(ZEN_FREE_FALLBACK_MODEL);
    expect(r.model).toBe(ZEN_FREE_FALLBACK_MODEL);
  });
  it("排除集生效：撞限模型被路由掉（重试换模语义）", async () => {
    const r = await resolveZenFreeEnv(zenEnv, new Set(["opencode/mimo-v2.6-flash-free"]), fakeFetch(SAMPLE_IDS));
    expect(r.model).not.toBe("opencode/mimo-v2.6-flash-free");
    expect(r.model!.endsWith("-free")).toBe(true);
  });
});
