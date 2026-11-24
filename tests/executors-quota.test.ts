// 共享的「硬配额 / 限流」识别（claude 与 opencode 共用一份，见 src/executors/quota.ts）。
//
// 回归点（2026-11-24 实测）：opencode 免费档额度耗尽时，opencode 只在**自己的日志**里打
// `AI_APICallError: Free usage limit reached.`——措辞是 "usage limit"（不是 "rate limit"）
// + "reached"（不是 "exceeded"）⇒ 旧正则一条都匹配不上 ⇒ 连那张 ⚠️ 配额告警卡都不会推。
import { describe, expect, it } from "vitest";
import { isQuotaSignal } from "../src/executors/quota.js";

describe("isQuotaSignal", () => {
  it("429 状态码直接命中（不看文案）", () => {
    expect(isQuotaSignal(429, "")).toBe(true);
  });

  it("opencode 免费档措辞命中：Free usage limit reached.", () => {
    expect(
      isQuotaSignal(undefined, "AI_APICallError: Free usage limit reached. Free models work in OpenCode"),
    ).toBe(true);
  });

  it("MiniMax 措辞命中：Token Plan 用量上限", () => {
    expect(isQuotaSignal(undefined, "当前已达到 Token Plan 用量上限。… (2067)")).toBe(true);
  });

  it("英文措辞命中：rate limit / quota exceeded", () => {
    expect(isQuotaSignal(undefined, "rate limit exceeded")).toBe(true);
    expect(isQuotaSignal(undefined, "quota exceeded")).toBe(true);
  });

  it("普通服务端错误不命中（不制造假告警）", () => {
    expect(isQuotaSignal(500, "Unexpected server error. Check server logs for details.")).toBe(false);
    expect(isQuotaSignal(undefined, "")).toBe(false);
  });
});
