/**
 * 随包分发的 dispatch skill 的**内容**约束（不是安装逻辑——那部分在 skill.test.ts）。
 *
 * 为什么要有这一层：`skills/agent-ex-dispatch/` **随 npm 包分发**（`files` 字段），
 * 它的措辞就是调度方（另一个 agent）的行为契约。写错了没有任何编译错误、没有任何运行时报错，
 * 只会悄悄失效——比如把「计费授权要用户点头」写成了「额度满了就换付费档」。
 * ⇒ 用 grep 断言把关键规则钉住。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillMd = readFileSync(join(repoRoot, "skills", "agent-ex-dispatch", "SKILL.md"), "utf8");

describe("dispatch skill —— 计费闸门的措辞（V32）", () => {
  it("铁律 5 含「allow_metered 只在切到当前默认档以外的计费档时才传」", () => {
    expect(skillMd).toContain("`allow_metered` 只在「切到**当前默认档以外**、且会花钱的 profile」");
  });

  it("写明「用当前默认档不需要它」——闸门拦的是切换，不是收费", () => {
    expect(skillMd).toContain("用**当前配置里的默认档**（`defaults.profile`）**不需要**它");
  });

  it("否定清单齐全：429 / 额度上限 / free 池全挂 / 模型下线 / 超时 / 失败都不构成同意", () => {
    const line = skillMd
      .split("\n")
      .find((l) => l.includes("`allow_metered` 只在「切到")) ?? "";
    for (const item of ["429", "额度上限", "free 池全挂", "模型下线", "超时", "失败"]) {
      expect(line).toContain(item);
    }
    expect(line).toContain("不构成同意计费");
  });

  it("429 段补了参数口径：不要自己加 allow_metered 重派", () => {
    expect(skillMd).toContain("也不要自己加 `allow_metered: true` 重派");
  });

  it("Phase 2 放行规则补了计费授权边界", () => {
    expect(skillMd).toContain("授权范围也不含计费授权");
  });

  it("前置检查探 submit schema 里有没有 allow_metered", () => {
    expect(skillMd).toContain("计费闸门能力探测");
    // 老 server 的两种形态都要写清楚：静默剥离 ≠ 闸门在工作
    expect(skillMd).toContain("静默剥离");
  });

  it("参数枚举与 Step 3 参数表都含 allow_metered", () => {
    expect(skillMd).toContain(
      "只有 `prompt` / `project_path` / `profile` / `timeout_sec` / `continue_of` / `allow_metered`",
    );
    expect(skillMd).toContain("| `allow_metered` | |");
  });

  it("排错表有「被计费闸门拒绝」这一行（否则 agent 只会反复重试）", () => {
    expect(skillMd).toContain("is not the profile currently configured");
  });
});
