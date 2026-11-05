import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
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
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify(EXISTING, null, 2));
}

function readCfg(home: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
}

describe("init 的 CLI 探测与选择", () => {
  const originalHome = process.env.AGENT_EX_HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.AGENT_EX_HOME;
    else process.env.AGENT_EX_HOME = originalHome;
  });

  /**
   * 回归：只装了 opencode 的人看到的却是
   *   "Executor to configure (claude/opencode) [claude]:"
   * ——答案唯一（只能 opencode），而且**默认值还指向没装的 claude**：
   * 直接回车就会配出一个根本不存在的 executor，还得再手打一遍它的绝对路径。
   */
  it("只探测到一个 CLI 时不再问「用哪个」，直接用那个", async () => {
    const home = join(dir, "home2");
    process.env.AGENT_EX_HOME = home;
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    try {
      // 答案序列里**没有** executor 那一项：只回答 bin / profile / zen / webhook / timeout
      // （新目录 ⇒ 没有"覆盖确认"与"同意变更"两个问题）
      await runInit(
        feeder(["", "default", "", "", "3600"]).stream,
        { which: (n) => (n === "opencode" ? "/bin/ls" : null) },
      );
    } finally {
      console.log = origLog;
    }
    const text = out.join("\n");
    // 不该再问
    expect(text).not.toContain("Which agent CLI to use");
    expect(text).not.toContain("Executor to configure");
    // 直接用探测到的那个
    expect(text).toContain("Using opencode");
    // 而且配置里就是 opencode（不是没装的那个 claude）
    const cfg = readCfg(home);
    expect(Object.keys(cfg.executors)).toEqual(["opencode"]);
  });

  it("探测到两个时才问用哪个，且默认是探测到的第一个", async () => {
    const home = join(dir, "home3");
    process.env.AGENT_EX_HOME = home;
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    try {
      // 答案：用哪个(claude) / bin(用探测到的) / profile / preset / key / webhook / timeout
      // （新目录 ⇒ 没有"覆盖确认"与"同意变更"两个问题）
      // 探测到的路径用 /bin/ls（真实存在且可执行）——写假的路径会在写盘前校验时失败
      await runInit(
        feeder(["claude", "", "default", "minimax", "", "", "3600"]).stream,
        { which: () => "/bin/ls" },
      );
    } finally {
      console.log = origLog;
    }
    const text = out.join("\n");
    // 两个都列出来了
    expect(text).toContain("claude");
    expect(text).toContain("opencode");
    // 配置里是选中的那个
    const cfg = readCfg(home);
    expect(Object.keys(cfg.executors)).toEqual(["claude"]);
  });

  /**
   * 回归：yes/no 型提问原先用 `[N]` / `[Y]` 后缀。
   *
   * `[N]` 只说"默认值是 N"，没说还能按什么；Unix 惯例是 `(y/N)`——
   * **小写=可选的答案，大写=回车即取的默认值**，一眼看出"按 N 就是不"。
   *
   * ⚠️ 断言方式：提问走的是 `rl.question`（直接写 stdout），**不经过 console.log**，
   * 所以必须捕获 stdout 本身，捕获 console.log 抓不到提示语。
   */
  it("yes/no 型提问用 (y/N) / (Y/n) 形式", async () => {
    const home = join(dir, "home4");
    process.env.AGENT_EX_HOME = home;
    // ⚠️ 提问走 readline（直接写 process.stdout.write），**不经过 console.log**
    const out: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      out.push(String(chunk));
      return true;
    };
    try {
      await runInit(
        feeder(["claude", "", "default", "minimax", "", "", "3600"]).stream,
        { which: () => "/bin/ls" },
      );
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origWrite;
    }
    const text = out.join("");
    // 旧形式不该再出现
    expect(text).not.toContain("[N]");
    expect(text).not.toContain("[Y]");
    expect(text).not.toContain("[Y/n]");
    // 新形式在
    expect(text).toMatch(/\(y\/N\)|\(Y\/n\)/);
  });

  it("覆盖确认的长提示分多行（不顶满终端宽度）", async () => {
    const home = join(dir, "home5");
    mkdirSync(home, { recursive: true });
    // 放一个既有 config ⇒ 触发覆盖确认
    seedExisting(home);
    process.env.AGENT_EX_HOME = home;

    // ⚠️ 两个通道要分别捕获：
    //  - 说明文字走 console.log（**vitest 会拦截它**，不经过 process.stdout.write）
    //  - 提问走 readline（直接写 process.stdout.write）
    const logged: string[] = [];
    const written: string[] = [];
    const origLog = console.log;
    const origWrite = process.stdout.write.bind(process.stdout);
    console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
    (process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return true;
    };
    try {
      await runInit(
        feeder(["n", "", "default", "minimax", "", "", "3600"]).stream,
        { which: () => "/bin/ls" },
      );
    } finally {
      console.log = origLog;
      (process.stdout as unknown as { write: unknown }).write = origWrite;
    }
    const text = logged.join("\n");
    // 路径行与说明行是**两行**（不是一条长文本顶满终端宽度）
    expect(text).toMatch(/config\.json[^\n]*already exists\.\n[^\n]*Re-running init REWRITES it/);
    // 首行带 warn 符号：整段输出的视觉语法是"每行以符号开头"，断开一处就很突兀
    expect(text).toMatch(/^! .*config\.json already exists\.$/m);
    // 提问走 readline
    expect(written.join("")).toContain("(y/N)");
  });
});

describe("init 覆盖既有 config", () => {
  const originalHome = process.env.AGENT_EX_HOME;

  /**
   * 注入探测结果：**只找到 claude** ⇒ init 不会再问"用哪个 CLI"（答案已唯一），
   * 答案序列因此少一项。
   *
   * 不注入的话，init 的问答流程会随"本机装了几个 CLI"变化 ⇒ 测试变成
   * "这台机器恰好装了 X"的巧合（同 §9 的 PATH 巧合）。
   */
  const onlyClaude = { which: (n: string) => (n === "claude" ? "/bin/ls" : null) };

  afterEach(() => {
    if (originalHome === undefined) delete process.env.AGENT_EX_HOME;
    else process.env.AGENT_EX_HOME = originalHome;
  });

  it("在写盘前问一次，覆盖前会先展示将要发生的变化", async () => {
    const home = join(dir, "home");
    seedExisting(home);
    process.env.AGENT_EX_HOME = home;

    // 答：确认继续 / bin / profile / preset / 用检测到的key / 跳过webhook / timeout / 同意变更
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    try {
      await runInit(feeder(["y", "/bin/ls", "default", "minimax", "", "", "3600", "y"]).stream, onlyClaude);
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
      await runInit(feeder(["y", "/bin/ls", "default", "minimax", "", "", "3600", "n"]).stream, onlyClaude);
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
      await runInit(feeder(["y", "/bin/ls", "default", "minimax", "", "", "3600", "y"]).stream, onlyClaude);
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
      await runInit(feeder(["y", "/definitely/not/a/binary", "default", "minimax", "", "", "3600", "y"]).stream, onlyClaude);
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
