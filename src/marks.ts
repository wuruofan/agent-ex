/**
 * 终端输出的**符号与配色词汇表** —— 全项目共用这一份定义。
 *
 * 为什么要有它：改之前符号散在各处、各说各话：
 *   - `✗` 在 doctor 里是 "error"，在 init 的变更预告里是 "removed"（同符两义）
 *   - `·` 在 doctor 里是 "info"，在变更预告里是 "rewritten"（同符两义）
 *   - `!` 只在 doctor 出现、`⚠️` 只在 init 出现（两套"警告"）
 *   - `→` 有时是"可复制的命令"、有时是"旧值 → 新值"（同符两义）
 * 用户看到的就是"有的行有左箭头、有的行有 Emoji、有的行没有"，密度一高就分不清哪个标记是什么。
 *
 * 统一后的约定：
 *   | 符号 | 含义 | 颜色 |
 *   | :--- | :--- | :--- |
 *   | `✗` | 错误 / 失败 | 红 |
 *   | `!` | 警告 / 需要注意 | 黄 |
 *   | `✓` | 成功 / 正常 | 绿 |
 *   | `·` | 中性信息 | 暗灰 |
 *   | `-` | 会被删除 | 红 |
 *   | `+` | 会被新增 | 绿 |
 *   | `±` | 会被改写 | 黄 |
 *
 * ⚠️ **不要用 emoji**：宽度不可控（同一个 `⚠️` 在不同终端/字体下占 1 列或 2 列），
 * 而且带变体选择符 U+FE0F，复制粘贴出去会带出不可见字符。
 * 飞书卡片里的 emoji 不受此约束——那是发给群友看的，终端规范不适用。
 */
import { ansi } from "./ansi.js";

/** 符号本身（不含颜色）。 */
export const MARK = {
  /** 错误 / 失败。 */
  error: "✗",
  /** 警告 / 需要注意。 */
  warn: "!",
  /** 成功 / 正常。 */
  ok: "✓",
  /** 中性信息。 */
  info: "·",
  /** 会被删除（变更预告）。 */
  removed: "-",
  /** 会被新增（变更预告）。 */
  added: "+",
  /** 会被改写（变更预告）。 */
  changed: "±",
} as const;

/** 「可复制的命令」标记 —— 后面跟的一定是一条能粘进终端的完整命令。 */
export const CMD = "→";

/** 严重级别 → 符号 + 颜色。doctor 的 finding 与 CLI 渲染共用。 */
export const SEVERITY_MARK: Record<string, { mark: string; paint: (s: string) => string }> = {
  error: { mark: MARK.error, paint: ansi.red },
  warn: { mark: MARK.warn, paint: ansi.yellow },
  ok: { mark: MARK.ok, paint: ansi.green },
  info: { mark: MARK.info, paint: ansi.dim },
};
