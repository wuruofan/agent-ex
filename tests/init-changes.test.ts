import { describe, expect, it } from "vitest";
import { diffConfigs, renderChangeWarning } from "../src/init-changes.js";
import type { Config } from "../src/config.js";

function cfg(over: Partial<Config> = {}): Config {
  return {
    executors: { claude: { bin: "/bin/claude" } },
    profiles: { default: { executor: "claude", env: {} } },
    notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "agent-ex" },
    defaults: { profile: "default", timeout_sec: 3600 },
    ...over,
  };
}

describe("diffConfigs —— init 覆盖前的变更预告", () => {
  it("首次 init（没有旧 config）不报任何变化", () => {
    expect(diffConfigs(null, cfg())).toEqual([]);
  });

  it("报出会被丢掉的 profile", () => {
    const old = cfg({
      profiles: {
        "minimax-3": { executor: "claude", env: { ANTHROPIC_MODEL: "MiniMax-M3[1m]" } },
        "ds-v4": { executor: "claude", env: { ANTHROPIC_MODEL: "deepseek-v4-pro[1m]" } },
      },
    });
    const changes = diffConfigs(old, cfg());
    const lost = changes.find((c) => c.field === "profiles.ds-v4");
    expect(lost).toBeDefined();
    expect(lost?.after).toBe("(removed)");
  });

  it("报出 dry_run 从 false 变 true（最隐蔽的一种：通知静默不再投递）", () => {
    const old = cfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: false, keyword: "agent-ex" } });
    const changes = diffConfigs(old, cfg());
    const c = changes.find((x) => x.field === "notify.dry_run");
    expect(c?.before).toBe("false");
    expect(c?.after).toBe("true");
  });

  it("报出默认 profile 变更与 timeout 变更", () => {
    const old = cfg({ defaults: { profile: "ds-v4", timeout_sec: 5400 } });
    const changes = diffConfigs(old, cfg());
    expect(changes.find((c) => c.field === "defaults.profile")?.before).toBe("ds-v4");
    expect(changes.find((c) => c.field === "defaults.timeout_sec")?.before).toBe("5400");
  });

  it("报出 executor 的 bin 改了（换 CLI 路径影响所有指向它的 profile）", () => {
    const old = cfg({ executors: { claude: { bin: "/old/claude" } } });
    const changes = diffConfigs(old, cfg());
    expect(changes.find((c) => c.field === "executors.claude.bin")?.before).toBe("/old/claude");
  });

  it("值没变就不报（避免用噪音淹没真正的变更）", () => {
    expect(diffConfigs(cfg(), cfg())).toEqual([]);
  });
});

describe("renderChangeWarning —— 警告文案要说清后果", () => {
  it("把丢失与改写分开列，丢失项带 ✗", () => {
    const old = cfg({
      profiles: {
        "minimax-3": { executor: "claude", env: {} },
        "ds-v4": { executor: "claude", env: {} },
      },
    });
    const text = renderChangeWarning(diffConfigs(old, cfg()));
    expect(text).toContain("Removed");
    expect(text).toContain("profiles.ds-v4");
    expect(text).toContain("✗");
    expect(text).toContain("Rewritten");
  });

  it("dry_run false→true 要解释后果（而不只是列字段变化）", () => {
    const old = cfg({ notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: false, keyword: "agent-ex" } });
    const text = renderChangeWarning(diffConfigs(old, cfg()));
    expect(text).toContain("notify.dry_run false → true");
    expect(text).toMatch(/NOT be delivered/i);
  });

  it("默认 profile 被删时要点明会导致任务失败", () => {
    const old = cfg({
      profiles: { "ds-v4": { executor: "claude", env: {} } },
      defaults: { profile: "ds-v4", timeout_sec: 3600 },
    });
    const text = renderChangeWarning(diffConfigs(old, cfg()));
    expect(text).toMatch(/unknown profile/);
  });

  it("提醒 .env 是合并不是替换（密钥不会丢）", () => {
    const old = cfg({ profiles: { "ds-v4": { executor: "claude", env: {} } } });
    const text = renderChangeWarning(diffConfigs(old, cfg()));
    expect(text).toMatch(/\.env is merged/);
  });

  it("无变化时返回空字符串（不打印空警告块）", () => {
    expect(renderChangeWarning([])).toBe("");
  });
});
