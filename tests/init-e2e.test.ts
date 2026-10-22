import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init.js";

/**
 * init 的端到端行为。
 *
 * 驱动方式：用 PassThrough 喂答案（runInit 的签名本来就接受可注入的输入流），
 * 而不是 spawn 子进程 —— 后者要跟 readline 的流式输出赛跑，答案极易滞后一拍。
 *
 * 这些用例钉的是 2026-10-16 实测到的三个真实缺陷：
 *   1. 重跑 init 会静默丢掉旧 profile、把 dry_run 打回 true；
 *   2. 覆盖前只有一句 "Overwrite?"，用户不知道自己要放弃什么；
 *   3. 校验失败时坏 config 已落盘、旧 config 已被覆盖且无法恢复。
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aex-init-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * 逐条喂入答案行。
 *
 * 不能 `end()` 一次性喂完：readline 收到 EOF 后会关闭自己，后续 `question()` 全部抛
 * "readline was closed"。必须保持流打开、按提示顺序逐条写。
 */
function feeder(answers: string[]): { stream: PassThrough; done: Promise<void> } {
  const s = new PassThrough();
  let i = 0;
  const done = (async () => {
    for (const a of answers) {
      // 等 readline 真正 ask 了再写（用 setImmediate 让出事件循环）
      await new Promise((r) => setImmediate(r));
      s.write(a + "\n");
    }
    // 保留流打开：后续还有 question() 要问
  })();
  void i;
  return { stream: s, done };
}

const EXISTING = {
  executors: { claude: { bin: "/bin/ls", extra_flags: [] } },
  profiles: {
    "minimax-3": { executor: "claude", env: { ANTHROPIC_MODEL: "MiniMax-M3[1m]" } },
    "ds-v4": { executor: "claude", env: { ANTHROPIC_MODEL: "deepseek-v4-pro[1m]" } },
  },
  notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: false, keyword: "agent-flow-ex" },
  defaults: { profile: "ds-v4", timeout_sec: 5400 },
};

function seedExisting(home: string): void {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(home, { recursive: true });
  require("node:fs").writeFileSync(join(home, "config.json"), JSON.stringify(EXISTING, null, 2));
}

function readCfg(home: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
}

describe("init 覆盖既有 config", () => {
  const originalHome = process.env.AGENT_EX_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.AGENT_EX_HOME;
    else process.env.AGENT_EX_HOME = originalHome;
  });

  it("在写盘前问一次，覆盖前会先展示将要发生的变化", async () => {
    const home = join(dir, "home");
    seedExisting(home);
    process.env.AGENT_EX_HOME = home;

    // 答：确认继续 / claude / bin / profile / preset / 用检测到的key / 跳过webhook / timeout / 同意变更
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    try {
      await runInit(feeder(["y", "claude", "/bin/ls", "default", "minimax", "", "", "3600", "y"]).stream);
    } finally {
      console.log = origLog;
    }
    const text = out.join("\n");
    // 变更预告：逐项列出丢失与改写
    expect(text).toContain("profiles.ds-v4");
    expect(text).toContain("notify.dry_run");
    expect(text).toMatch(/Removed|Rewritten/);
  });

  it("用户拒绝变更时不写盘、旧 config 原封不动、且不产生备份", async () => {
    const home = join(dir, "home");
    seedExisting(home);
    process.env.AGENT_EX_HOME = home;

    const origLog = console.log;
    console.log = () => {};
    try {
      await runInit(feeder(["y", "claude", "/bin/ls", "default", "minimax", "", "", "3600", "n"]).stream);
    } finally {
      console.log = origLog;
    }
    const cfg = readCfg(home);
    expect(Object.keys(cfg.profiles).sort()).toEqual(["ds-v4", "minimax-3"]);
    expect(cfg.notify.dry_run).toBe(false);
    expect(cfg.notify.keyword).toBe("agent-flow-ex");
    expect(cfg.defaults.timeout_sec).toBe(5400);
    // 没写盘 ⇒ 不该有备份文件
    expect(readdirSync(home).filter((f) => f.includes(".bak"))).toEqual([]);
  });

  it("同意变更时先备份旧 config，再写新 config", async () => {
    const home = join(dir, "home");
    seedExisting(home);
    process.env.AGENT_EX_HOME = home;

    const origLog = console.log;
    console.log = () => {};
    try {
      await runInit(feeder(["y", "claude", "/bin/ls", "default", "minimax", "", "", "3600", "y"]).stream);
    } finally {
      console.log = origLog;
    }
    const baks = readdirSync(home).filter((f) => f.startsWith("config.json.bak."));
    expect(baks.length).toBe(1);
    // 备份里是旧内容（2 个 profile、dry_run=false）
    const bak = JSON.parse(readFileSync(join(home, baks[0]), "utf8"));
    expect(Object.keys(bak.profiles).sort()).toEqual(["ds-v4", "minimax-3"]);
    expect(bak.notify.dry_run).toBe(false);
    // 新 config 已生效
    expect(Object.keys(readCfg(home).profiles)).toEqual(["default"]);
  });

  it("配置非法时不写盘（先校验后落盘），旧 config 不受影响", async () => {
    const home = join(dir, "home");
    seedExisting(home);
    process.env.AGENT_EX_HOME = home;

    const origLog = console.log;
    const origErr = console.error;
    const errs: string[] = [];
    console.log = () => {};
    console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((c?: number) => { exitCode = c; throw new Error("__exit__"); }) as never;
    try {
      await runInit(feeder(["y", "claude", "/definitely/not/a/binary", "default", "minimax", "", "", "3600", "y"]).stream);
    } catch (e) {
      if ((e as Error).message !== "__exit__") throw e;
    } finally {
      process.exit = origExit;
      console.log = origLog;
      console.error = origErr;
    }
    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toMatch(/nothing written/);
    // 旧 config 完好
    expect(Object.keys(readCfg(home).profiles).sort()).toEqual(["ds-v4", "minimax-3"]);
    expect(readCfg(home).notify.dry_run).toBe(false);
  });
});
