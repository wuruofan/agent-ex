import { readFileSync } from "node:fs";

export const REPORT_TEXT_MAX = 1200;
export const REPORT_HEAD_MAX = 700;
export const OUTLINE_MAX = 600;
export const OUTLINE_MAX_HEADS = 20;

/**
 * 一条日志行里所有 assistant 撰写的文本块（跨两种 executor 形状）。
 *
 *   claude    {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":…}]}}
 *   opencode  {"type":"text","text":…} 或 {"type":"text","part":{"text":…}}
 *
 * 两道过滤都不能少：type==="assistant" 排除 compaction 摘要（摘要挂在 role:"user" 上），
 * role==="assistant" 是第二道防线。取**最长块**而不是最后一块——长任务里最后一条常常只是一句收尾。
 */
function assistantTexts(ev: any): string[] {
  if (ev?.type === "assistant") {
    const msg = ev.message;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
    return msg.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text);
  }
  if (ev?.type === "text") {
    const text = typeof ev.text === "string" ? ev.text : (typeof ev.part?.text === "string" ? ev.part.text : null);
    return typeof text === "string" ? [text] : [];
  }
  return [];
}

export function extractReport(logPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
  let longest = "";
  for (const line of raw.split("\n")) {
    if (!line || line.charCodeAt(0) !== 0x7b /* { */) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    for (const text of assistantTexts(ev)) {
      if (text.length > longest.length) longest = text;
    }
  }
  return longest;
}

export function outlineOf(text: string): string[] {
  const heads: string[] = [];
  for (const raw of text.split("\n")) {
    const m = /^#{1,4}\s+(.+?)\s*$/.exec(raw.trim());
    if (!m) continue;
    heads.push(m[1]);
    if (heads.length >= OUTLINE_MAX_HEADS) break;
  }
  return heads;
}
