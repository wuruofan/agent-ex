import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, applyFixes, scanNotifyFailures, classifyKeyword, FEISHU_ERRORS } from "../src/doctor.js";
import { BRAND } from "../src/brand.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "aex-doctor-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function writeCfg(cfg: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg, null, 2));
}

/**
 * 写一个"一切正常"的夹具：config + .env 都有 webhook。
 *
 * 为什么要 .env：doctor 会检查 {env:VAR} 占位符对应的变量是否真的存在（.env 或进程环境）。
 * 只写 config 不写 .env 会被正确地报成"webhook 地址未设置" —— 那是 doctor 在正常工作，
 * 不是夹具的 bug。
 */
function writeHealthy(over: Record<string, unknown> = {}): void {
  writeCfg(baseCfg(over));
  writeFileSync(join(home, ".env"), "FEISHU_WEBHOOK_URL=https://open.feishu.cn/hook/test\n");
}

function baseCfg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executors: { claude: { bin: "/bin/ls" } },
    profiles: { default: { executor: "claude", env: {} } },
    notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: BRAND },
    defaults: { profile: "default", timeout_sec: 3600 },
    ...over,
  };
}

describe("doctor —— 把证据聚合成结论", () => {
  it("配置正常时 ok", async () => {
    writeHealthy();
    const r = await doctor({ home });
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.severity === "error")).toBe(false);
  });

  it("dry_run=true 报为 warn（是偏好不是缺陷），并给出修复命令", async () => {
    writeHealthy();
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("dry-run"));
    expect(f?.severity).toBe("warn");
    expect(f?.fix).toContain("config set notify.dry_run false");
  });

  it("keyword 缺失是 info 而不是 error（运行时由 config.ts 的 ??= BRAND 兜底）", async () => {
    // 夹具要补 .env：否则 webhook 那条会先报 error，遮住这条断言
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true } }));
    writeFileSync(join(home, ".env"), "FEISHU_WEBHOOK_URL=https://open.feishu.cn/hook/test\n");
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("关键词"));
    expect(f?.severity).toBe("info");
    expect(f?.fixable).toBeFalsy();
    // 缺失不是缺陷：整体不该因此判红
    expect(r.findings.some((x) => x.severity === "error")).toBe(false);
  });

  it("keyword 是本工具的旧产品名时报错并指出不一致（2026-10-13 零通知的根因）", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "agent-flow-ex" } }));
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("旧产品名"));
    expect(f?.severity).toBe("error");
    expect(f?.fixable).toBe(true);
    expect(f?.detail).toContain("agent-flow-ex");
    expect(f?.detail).toContain(BRAND);
  });

  it("自定义 keyword 只报 warn、不判错（机器人登记什么词是用户的界面，见 brand.ts）", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "my-bot-word" } }));
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("自定义值"));
    expect(f?.severity).toBe("warn");
    expect(f?.fixable).toBeFalsy();
    // 文案必须说清"若机器人登记的就是这个词就忽略"，否则是把用户推向无效动作
    expect(f?.detail).toContain("my-bot-word");
    expect(f?.detail).toContain("忽略");
  });

  it("显式空串 keyword 是 error 且可自动修（卡片不带关键词 ⇒ 必然 19024）", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "" } }));
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("空"));
    expect(f?.severity).toBe("error");
    expect(f?.fixable).toBe(true);
  });

  it("明文 webhook 落在 config.json 里报凭证泄露风险", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "https://open.feishu.cn/hook/secret", dry_run: true, keyword: BRAND } }));
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("明文"));
    expect(f?.severity).toBe("error");
    expect(f?.fixable).toBe(true);
  });

  it("webhook 占位符对应的变量不在 .env 也不在环境里时报错", async () => {
    // 环境里恰好有这个变量会让断言失真 ⇒ 显式摘掉再测
    const saved = process.env.FEISHU_WEBHOOK_URL;
    delete process.env.FEISHU_WEBHOOK_URL;
    try {
      writeCfg(baseCfg());
      const r = await doctor({ home });
      expect(r.findings.some((f) => f.title.includes("webhook 地址未设置"))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.FEISHU_WEBHOOK_URL = saved;
    }
  });

  it("默认 profile 不存在时报错（会导致每次派发都失败）", async () => {
    writeCfg(baseCfg({ defaults: { profile: "ghost", timeout_sec: 3600 } }));
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("默认 profile"));
    expect(f?.severity).toBe("error");
  });

  it("executor 的 bin 不可执行时报错", async () => {
    writeCfg(baseCfg({ executors: { claude: { bin: "/definitely/not/here" } } }));
    const r = await doctor({ home });
    expect(r.findings.some((f) => f.title.includes("不可用"))).toBe(true);
  });

  it("config.json 坏掉时也能体检（不崩），并指出是 config 的问题", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), "{ not json");
    const r = await doctor({ home });
    expect(r.ok).toBe(false);
    expect(r.findings[0].title).toContain("config.json");
  });

  it("历史拒收记录是 warn 不是 error（过去的事，不该让 doctor 永远红）", async () => {
    writeHealthy();
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "logs", "runner-task_x.log"),
      "[notifier] feishu rejected: HTTP 200 code=19024 msg=Key Words Not Found (attempt 1/3)\n",
    );
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("历史上"));
    expect(f?.severity).toBe("warn");
    // 当前配置没问题 ⇒ 整体仍算 ok
    expect(r.ok).toBe(true);
  });

  it("历史汇总区分「受影响任务数」与「拒收次数」，并列出每个码各自的修法", async () => {
    writeHealthy();
    mkdirSync(join(home, "logs"), { recursive: true });
    // 一个任务重试 3 次 = 3 次尝试，但只算 1 个受影响任务
    writeFileSync(
      join(home, "logs", "runner-task_a.log"),
      "[notifier] feishu rejected: HTTP 200 code=19024 msg=Key Words Not Found (attempt 1/3)\n" +
      "[notifier] feishu rejected: HTTP 200 code=19024 msg=Key Words Not Found (attempt 2/3)\n" +
      "[notifier] feishu rejected: HTTP 200 code=19024 msg=Key Words Not Found (attempt 3/3)\n",
    );
    writeFileSync(
      join(home, "logs", "runner-task_b.log"),
      "[notifier] feishu rejected: HTTP 200 code=19001 msg=param invalid (attempt 1/3)\n",
    );
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("历史上"));
    expect(f?.title).toContain("2 个任务");       // 受影响任务数
    expect(f?.title).toContain("4 次尝试");       // 拒收尝试次数
    expect(f?.detail).toContain("code=19024 ×3 次");
    // 两个码的修法互斥（改关键词 vs 换地址）⇒ 都要给，不能只给次数最多的那个
    expect(f?.fix).toContain(FEISHU_ERRORS["19024"].fix);
    expect(f?.fix).toContain(FEISHU_ERRORS["19001"].fix);
  });
});

describe("classifyKeyword —— keyword 的四态判定（doctor 与 --fix 共用）", () => {
  it("四态互斥且可区分", () => {
    expect(classifyKeyword(undefined)).toBe("unset");
    expect(classifyKeyword("")).toBe("empty");
    expect(classifyKeyword("   ")).toBe("empty");
    expect(classifyKeyword(BRAND)).toBe("brand");
    expect(classifyKeyword("agent-flow-ex")).toBe("stale");
    expect(classifyKeyword("agent-flow")).toBe("stale");
    expect(classifyKeyword("my-bot-word")).toBe("custom");
  });
});

describe("scanNotifyFailures —— 从 runner 日志里挖证据", () => {
  it("按 code 聚合并数出受影响的任务数", () => {
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "logs", "runner-task_a.log"),
      "[notifier] feishu rejected: HTTP 200 code=19024 msg=Key Words Not Found (attempt 1/3)\n" +
      "[notifier] feishu rejected: HTTP 200 code=19024 msg=Key Words Not Found (attempt 2/3)\n");
    writeFileSync(join(home, "logs", "runner-task_b.log"),
      "[notifier] feishu rejected: HTTP 200 code=19001 msg=param invalid: incoming webhook access token invalid (attempt 1/3)\n");
    const s = scanNotifyFailures(home);
    expect(s.logs_with_rejects).toBe(2);
    expect(s.by_code["19024"]).toBe(2);
    expect(s.by_code["19001"]).toBe(1);
  });

  it("没有日志目录时返回空结果而不是抛错", () => {
    const s = scanNotifyFailures(home);
    expect(s.logs_with_rejects).toBe(0);
    expect(s.by_code).toEqual({});
  });
});

describe("FEISHU_ERRORS —— 错误码含义与修法", () => {
  it("19001 与 19024 的修法不同（一个是换地址，一个是改关键词）", () => {
    expect(FEISHU_ERRORS["19001"].fix).toContain("webhook");
    expect(FEISHU_ERRORS["19024"].fix).toContain("keyword");
    expect(FEISHU_ERRORS["19001"].fix).not.toBe(FEISHU_ERRORS["19024"].fix);
  });
});

describe("--fix —— 只修确定性缺陷", () => {
  it("旧产品名 → 改回 BRAND，并提示如何改回去", () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "agent-flow-ex" } }));
    const r = applyFixes(home);
    expect(r.applied.join()).toContain("notify.keyword");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.keyword).toBe(BRAND);
    // 自动改的前提是"机器人登记的是新名"——把反悔路径告诉用户
    expect(r.notes.join()).toContain("agent-flow-ex");
  });

  it("显式空串 → 修回 BRAND（空串是能证明投递不了的配置态）", () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "" } }));
    const r = applyFixes(home);
    expect(r.applied.join()).toContain("notify.keyword");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.keyword).toBe(BRAND);
  });

  it("keyword 缺失 → 不动（运行时派生 BRAND；写死会冻结默认值、重新引入改名漂移）", () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true } }));
    const r = applyFixes(home);
    expect(r.applied.join()).not.toContain("notify.keyword");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect("keyword" in cfg.notify).toBe(false);
  });

  it("自定义 keyword → 不动（把能投递的配置改成不能投递是越权）", () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "my-bot-word" } }));
    const r = applyFixes(home);
    expect(r.applied.join()).not.toContain("notify.keyword");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.keyword).toBe("my-bot-word");
  });

  it("明文 webhook → 挪进 .env，config 留占位符", () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "https://open.feishu.cn/hook/abc", dry_run: true, keyword: BRAND } }));
    const r = applyFixes(home);
    expect(r.applied.join()).toContain("feishu_webhook_url");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.feishu_webhook_url).toBe("{env:FEISHU_WEBHOOK_URL}");
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("https://open.feishu.cn/hook/abc");
  });

  it("写进 .env 的凭证是 600（.env 已存在时也要 chmod，不能只靠 writeFileSync 的 mode）", () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "https://open.feishu.cn/hook/abc", dry_run: true, keyword: BRAND } }));
    // init 之后 .env 几乎总是已存在，且带着旧权限
    writeFileSync(join(home, ".env"), "EXISTING=1\n");
    chmodSync(join(home, ".env"), 0o644);
    applyFixes(home);
    const mode = statSync(join(home, ".env")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("不动 dry_run（那是偏好不是缺陷）", () => {
    writeCfg(baseCfg());
    applyFixes(home);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.dry_run).toBe(true);
  });

  it(".env 里已有同名变量时不覆盖（避免踩掉用户更晚改的值）", () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "https://open.feishu.cn/hook/abc", dry_run: true, keyword: BRAND } }));
    writeFileSync(join(home, ".env"), "FEISHU_WEBHOOK_URL=https://other/hook\n");
    const r = applyFixes(home);
    expect(r.skipped.join()).toContain("未覆盖");
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("https://other/hook");
  });

  /**
   * 回归：可修项与不可修项并存时（doctor 的主场景），--fix 曾把 validateConfig 的异常
   * 一路抛到 CLI —— 用户看到 Node 栈、看不到任何 finding，且改动一个字节都没落盘。
   */
  it("配置里另有不可修的坏字段时，--fix 不抛错、不写盘，并说明哪些改动被挡下", () => {
    writeCfg(baseCfg({
      executors: { claude: { bin: "/bin/ls" }, ghost: { bin: "/definitely/not/here" } },
      notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "" },
    }));
    const before = readFileSync(join(home, "config.json"), "utf8");
    const r = applyFixes(home); // 修复前：Error: executor "ghost" bin ... not found or not executable
    expect(r.applied).toEqual([]);                     // 没落盘就不能报"已修"
    expect(r.skipped.join()).toContain("未写入");
    expect(r.notes.join()).toContain("未落盘");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  });

  it("改动被挡下时不提示「改回去」——没改过就没什么可改回", () => {
    writeCfg(baseCfg({
      executors: { claude: { bin: "/bin/ls" }, ghost: { bin: "/definitely/not/here" } },
      notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "agent-flow-ex" },
    }));
    const r = applyFixes(home);
    expect(r.applied).toEqual([]);
    // 旧名提示只在真的写进 config 之后才成立
    expect(r.notes.join()).not.toContain("改回去");
  });

  it("校验失败时不先把凭证写进 .env（config 没改，凭证就不该多一份拷贝）", () => {
    writeCfg(baseCfg({
      executors: { claude: { bin: "/bin/ls" }, ghost: { bin: "/definitely/not/here" } },
      notify: { feishu_webhook_url: "https://open.feishu.cn/hook/abc", dry_run: true, keyword: BRAND },
    }));
    applyFixes(home);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });
});

describe("doctor --send —— 自检卡的结论里必须带飞书 code", () => {
  const original = process.env.FEISHU_WEBHOOK_URL;
  beforeEach(() => { process.env.FEISHU_WEBHOOK_URL = "https://open.feishu.cn/hook/test"; });
  afterEach(() => {
    if (original === undefined) delete process.env.FEISHU_WEBHOOK_URL;
    else process.env.FEISHU_WEBHOOK_URL = original;
  });

  it("被拒收时把 code 与 msg 写进结论（MCP 侧拿不到 stderr，此前只能看到一个布尔值）", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: false, keyword: BRAND } }));
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ code: 19024, msg: "Key Words Not Found" }),
    }) as Response);
    const r = await doctor({ home, send: true, fetchImpl: fetchMock as unknown as typeof fetch, delays: [0, 0] });
    const f = r.findings.find((x) => x.title.includes("自检卡"));
    expect(f?.severity).toBe("error");
    expect(f?.detail).toContain("code=19024");
    expect(f?.detail).toContain("Key Words Not Found");
    // 修法也跟着 code 走：19024 改关键词、19001 换地址
    expect(f?.fix).toBe(FEISHU_ERRORS["19024"].fix);
  });

  it("投递成功时记 ok", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: false, keyword: BRAND } }));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }) as Response);
    const r = await doctor({ home, send: true, fetchImpl: fetchMock as unknown as typeof fetch, delays: [0, 0] });
    const f = r.findings.find((x) => x.title.includes("自检卡已投递"));
    expect(f?.severity).toBe("ok");
  });

  it("keyword 缺失时探针卡用有效关键词（BRAND），不能因为原始值是 undefined 就误报被拒收", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: false } }));
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { ok: true, status: 200, json: async () => ({ code: 0 }) } as Response;
    });
    const r = await doctor({ home, send: true, fetchImpl: fetchMock as unknown as typeof fetch, delays: [0, 0] });
    // 卡片里必须有关键词元素，且内容是 BRAND（与真实投递一致）
    expect(bodies[0]).toContain(BRAND);
    expect(r.findings.some((f) => f.title.includes("自检卡已投递"))).toBe(true);
  });
});
