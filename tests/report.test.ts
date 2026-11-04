import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractReport, outlineOf, REPORT_TEXT_MAX } from "../src/report.js";

let DIR: string;   // 不能模块顶层建一次再 afterEach 删：第一个用例后目录就没了，后续写日志全 ENOENT
beforeEach(() => { DIR = mkdtempSync(join(tmpdir(), "af-report-")); });
const log = (name: string, lines: string[]) => {
  const p = join(DIR, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
};
const asst = (text: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const compact = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe("extractReport", () => {
  it("取最长的 assistant 文本块，而不是最后一块", () => {
    const p = log("a.jsonl", [asst("short"), asst("这是正文".repeat(200)), asst("尾块")]);
    expect(extractReport(p)).toBe("这是正文".repeat(200));
  });

  it("排除挂在 role=user 上的 compaction 摘要（摘要比正文长十倍也不取）", () => {
    const p = log("b.jsonl", [asst("真报告"), compact("摘要".repeat(3000))]);
    expect(extractReport(p)).toBe("真报告");
  });

  it("claude 形状：一条消息里的多个 text 块各算一块，取最长的那块", () => {
    const p = log("c.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
        { type: "text", text: "短" }, { type: "text", text: "长".repeat(50) }] } }),
    ]);
    expect(extractReport(p)).toBe("长".repeat(50));
  });

  it("opencode 形状：扁平 {type:text,text}", () => {
    const p = log("d.jsonl", [JSON.stringify({ type: "text", text: "oc 报告" })]);
    expect(extractReport(p)).toBe("oc 报告");
  });

  it("opencode 形状：part.text 兜底", () => {
    const p = log("e.jsonl", [JSON.stringify({ type: "text", part: { type: "text", text: "嵌套" } })]);
    expect(extractReport(p)).toBe("嵌套");
  });

  it("日志文件不存在时返回空串，不抛", () => {
    expect(extractReport(join(DIR, "nope.jsonl"))).toBe("");
  });

  it("坏 JSON 行被跳过，不影响其它行", () => {
    const p = log("f.jsonl", ["{not json", asst("好块")]);
    expect(extractReport(p)).toBe("好块");
  });
});

describe("outlineOf", () => {
  it("取 1-4 级标题", () => {
    expect(outlineOf("## 摘要\n正文\n### 验收\n0 fail\n##### 五级不算")).toEqual(["摘要", "验收"]);
  });

  it("最多 20 条", () => {
    const text = Array.from({ length: 30 }, (_, i) => `## H${i}`).join("\n");
    expect(outlineOf(text)).toHaveLength(20);
  });

  it("阈值常量冻结（spec §3.3）", () => {
    expect(REPORT_TEXT_MAX).toBe(1200);
  });
});
