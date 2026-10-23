/**
 * 极简 ANSI 着色 —— 只为 CLI 输出服务。
 *
 * 为什么自己写而不是引一个库：着色需求就这么点（几种颜色 + 开关），
 * 为此拉一个依赖不划算（减熵优先）。
 *
 * 开关规则（按 no-color.org 的惯例 + 常见约定）：
 *  - `NO_COLOR` 存在（任意值）⇒ 关闭。理由：用户明确要求"别给我颜色"。
 *  - `FORCE_COLOR` 存在且非 "0" ⇒ 强制开启（CI 里截图、脚本里想要颜色时用）。
 *  - 否则只在 **stdout 是 TTY** 时开启。理由：输出被重定向到文件或管道时，
 *    转义序列只是噪音（`cat log | grep error` 会看到一堆乱码）。
 *
 * ⚠️ 只有**给人看的终端输出**才该用这里的函数。MCP 工具的返回值是 JSON 数据，
 * 绝不能带转义序列。
 */

/** 是否启用颜色。每次调用时判断（不是模块加载时）——测试要能切换。 */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "0") return true;
  return Boolean(process.stdout.isTTY);
}

function wrap(code: string, s: string): string {
  return colorEnabled() ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export const ansi = {
  /** 加粗：标题、关键结论。 */
  bold: (s: string) => wrap("1", s),
  /** 变暗：次要信息（"没找到"这类，不该抢注意力）。 */
  dim: (s: string) => wrap("2", s),
  /** 绿色：成功、已就绪。 */
  green: (s: string) => wrap("32", s),
  /** 黄色：警告、需要注意。 */
  yellow: (s: string) => wrap("33", s),
  /** 红色：错误、失败。 */
  red: (s: string) => wrap("31", s),
  /** 青色：标题、正在做的事。 */
  cyan: (s: string) => wrap("36", s),
};
