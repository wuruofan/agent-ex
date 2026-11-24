/**
 * 「硬配额 / 限流」信号的共享识别。
 *
 * 为什么抽成一处：claude.ts 与 opencode.ts 原本各写了一份**同款**正则，两份已经漂移过一次——
 * 2026-11-24 实测：opencode 免费档额度耗尽时，opencode 只在**自己的日志**里打
 * `AI_APICallError: Free usage limit reached.`，措辞是 "**usage** limit"（不是 "rate limit"）
 * + "**reached**"（不是 "exceeded"）⇒ 旧正则一条都匹配不上 ⇒ 连那张 ⚠️ 配额告警卡都不会推。
 *
 * ⚠️ 这里只回答「这段文本像不像额度/限流」，**不回答**「要不要重试」——
 * 重试裁决在 runner 的 `isTransientError`（另一件事：额度是账号级共享的，重试只是白等）。
 */

/** 命中任意一条即视为硬配额/限流信号。 */
const QUOTA_PATTERNS: RegExp[] = [
  /token plan/i,      // MiniMax："当前已达到 Token Plan 用量上限"
  /quota/i,           // 英文泛指（quota exceeded / quota reached）
  /用量上限/,          // 中文
  /rate.?limit/i,     // rate limit / rate-limit
  /usage limit/i,     // opencode 免费档："Free usage limit reached."
  /exceeded/i,        // "limit exceeded" / "quota exceeded"
];

/**
 * 判断一条错误是不是硬配额/限流信号。
 *
 * @param status HTTP 状态码（如 429；undefined = 没有状态码字段）
 * @param message 错误文本（可为空）
 */
export function isQuotaSignal(status: number | undefined, message: string): boolean {
  if (status === 429) return true;
  if (!message) return false;
  return QUOTA_PATTERNS.some((p) => p.test(message));
}
