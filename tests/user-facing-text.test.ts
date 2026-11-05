import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MARK, CMD, SEVERITY_MARK } from "../src/marks.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 用户点开终端就能看到的模块：init / doctor / config / profile 四条命令的全部文案。 */
const CLI_FACING = ["cli.ts", "doctor.ts", "init.ts", "init-changes.ts", "config-cmd.ts", "config.ts"];

/**
 * 去掉注释，只留代码。
 *
 * 为什么需要：这类文件里的中文**几乎全是**给人读的注释（存证、决策理由），
 * 而那些注释恰恰是应该保留中文的。真正要守的是"字符串里没有中文"——
 * 注释一剥，剩下的就是会出现在终端/错误信息里的字面量。
 *
 * 手工扫描而不是用编译器 API：这里只需要处理 `//`、块注释和三种引号，
 * 而且必须**先认出字符串**再判注释（`"https://…"` 里的 `//` 不是注释）。
 */
function stripComments(s: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | '"' | "'" | "`" = "code";
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && d === "*") { state = "block"; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { state = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; i += 2; } else i += 1;
      continue;
    }
    // 字符串内部：转义不结束字符串，同种引号结束
    if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
    if (c === state) { state = "code"; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

function code(file: string): string {
  return stripComments(readFileSync(join(SRC, file), "utf8"));
}

describe("用户可见文案：全英文", () => {
  /**
   * 2026-10-23：init 的其余文案都是英文，唯独 opencode 那条是中文；
   * 更糟的是 doctor 的 finding 几乎全是中文——同一个 CLI 里两套语言。
   * 现在统一英文，这条用例守住它不再回潮。
   */
  for (const file of CLI_FACING) {
    it(`${file} 的字符串里没有中文`, () => {
      const hits = code(file)
        .split("\n")
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter((x) => /[\u4e00-\u9fff]/.test(x.line));
      expect(hits, hits.map((h) => `${file}:${h.no} ${h.line}`).join("\n")).toEqual([]);
    });
  }
});

describe("符号词汇表：只有一套", () => {
  /**
   * 改之前三套符号混用：`✗ ! ✓ ·`（doctor）、`→`（命令与值变化共用）、`⚠️ ❓ ✅ ❌`（emoji）。
   * 同一个 `✗` 在 doctor 里是 error、在变更预告里是 removed。
   * 现在全部走 marks.ts，这里钉住"没有绕开词汇表的裸符号"。
   */
  it("marks.ts 之外不出现裸的 mark 符号", () => {
    const naked = /[✗✓⚠❓✅❌±]/;
    for (const file of CLI_FACING.filter((f) => f !== "config.ts")) {
      const hits = code(file)
        .split("\n")
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        .filter((x) => naked.test(x.line));
      expect(hits, hits.map((h) => `${file}:${h.no} ${h.line}`).join("\n")).toEqual([]);
    }
  });

  it("图标不是 emoji：宽度可控、复制不带变体选择符", () => {
    for (const v of Object.values(MARK)) {
      expect(v).not.toMatch(/\p{Emoji_Presentation}|\uFE0F/u);
      expect([...v]).toHaveLength(1); // 单个码点（`±` 也是单码点）
    }
  });

  it("removed/added/changed 用 diff 约定（- / + / ±），不是中性符号", () => {
    expect(MARK.removed).toBe("-");
    expect(MARK.added).toBe("+");
    expect(MARK.changed).toBe("±");
  });

  it("→ 只留给可复制的命令", () => {
    expect(CMD).toBe("→");
    // 值的变化一律用 `->`，避免"这箭头后面能不能抄进终端"要靠猜
    const sources = CLI_FACING.map((f) => [f, code(f)] as const);
    for (const [file, src] of sources) {
      const arrowInTemplate = src.split("\n").filter((l) => l.includes("→"));
      expect(arrowInTemplate, `${file}: ${arrowInTemplate.join(" | ")}`).toEqual([]);
    }
  });

  it("doctor 的四个级别都有 mark，且颜色跟着级别走", () => {
    expect(Object.keys(SEVERITY_MARK).sort()).toEqual(["error", "info", "ok", "warn"]);
    expect(SEVERITY_MARK.error.mark).toBe(MARK.error);
    expect(SEVERITY_MARK.warn.mark).toBe(MARK.warn);
    expect(SEVERITY_MARK.ok.mark).toBe(MARK.ok);
    expect(SEVERITY_MARK.info.mark).toBe(MARK.info);
  });
});
