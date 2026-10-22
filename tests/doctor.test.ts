import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, applyFixes, scanNotifyFailures, FEISHU_ERRORS } from "../src/doctor.js";
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

  it("keyword 缺失是 error，且可自动修", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true } }));
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("关键词"));
    expect(f?.severity).toBe("error");
    expect(f?.fixable).toBe(true);
  });

  it("keyword 是陈旧品牌名时报错并指出不一致（2026-10-13 零通知的根因）", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "agent-flow-ex" } }));
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("不一致"));
    expect(f?.severity).toBe("error");
    expect(f?.detail).toContain("agent-flow-ex");
    expect(f?.detail).toContain(BRAND);
  });

  it("明文 webhook 落在 config.json 里报凭证泄露风险", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "https://open.feishu.cn/hook/secret", dry_run: true, keyword: BRAND } }));
    const r = await doctor({ home });
    const f = r.findings.find((x) => x.title.includes("明文"));
    expect(f?.severity).toBe("error");
    expect(f?.fixable).toBe(true);
  });

  it("webhook 占位符对应的变量不在 .env 也不在环境里时报错", async () => {
    writeCfg(baseCfg());
    const r = await doctor({ home });
    expect(r.findings.some((f) => f.title.includes("webhook 地址未设置"))).toBe(true);
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
  it("keyword 缺失 → 补成 BRAND", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true } }));
    const r = await applyFixes(home, await doctor({ home }));
    expect(r.applied.join()).toContain("notify.keyword");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.keyword).toBe(BRAND);
  });

  it("陈旧品牌名 → 改回 BRAND", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "agent-flow-ex" } }));
    applyFixes(home, await doctor({ home }));
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.keyword).toBe(BRAND);
  });

  it("明文 webhook → 挪进 .env，config 留占位符", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "https://open.feishu.cn/hook/abc", dry_run: true, keyword: BRAND } }));
    const r = applyFixes(home, await doctor({ home }));
    expect(r.applied.join()).toContain("feishu_webhook_url");
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.feishu_webhook_url).toBe("{env:FEISHU_WEBHOOK_URL}");
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("https://open.feishu.cn/hook/abc");
  });

  it("不动 dry_run（那是偏好不是缺陷）", async () => {
    writeCfg(baseCfg());
    applyFixes(home, await doctor({ home }));
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.notify.dry_run).toBe(true);
  });

  it(".env 里已有同名变量时不覆盖（避免踩掉用户更晚改的值）", async () => {
    writeCfg(baseCfg({ notify: { feishu_webhook_url: "https://open.feishu.cn/hook/abc", dry_run: true, keyword: BRAND } }));
    writeFileSync(join(home, ".env"), "FEISHU_WEBHOOK_URL=https://other/hook\n");
    const r = applyFixes(home, await doctor({ home }));
    expect(r.skipped.join()).toContain("未覆盖");
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("https://other/hook");
  });
});
