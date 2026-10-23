import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CLI 子命令的端到端行为：$AGENT_EX_HOME/.env 必须真的被加载。
 *
 * 为什么必须是**进程级**测试：P0-1 的根因是分派顺序——
 * server.ts 在模块顶层就把 doctor/config 分派走了，main() 里的 loadEnvFile() 根本不执行。
 * 单元测试调用的是 doctor({home}) 函数，它读 process.env，而 loadEnvFile() 是在**另一个进程**
 * 里做的事——在同一个进程里测永远测不出来。所以这里真起一个子进程跑 `agent-ex doctor --send`。
 *
 * 2026-10-22 实测过的现象（修复前）：同一轮体检里前半句"✓ webhook 地址已配置（在 .env 里）"、
 * 后半句"✗ env placeholder not found"——自相矛盾，且 --send 在 init 默认产出的配置下必然失败。
 *
 * ⚠️ 必须用**异步** exec：假飞书服务器跑在测试进程里，同步 execFileSync 会把父进程的
 * event loop 堵死 ⇒ 服务器没法应答 ⇒ 子进程三次全超时（实测 35s）。
 */
const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

let server: Server;
let webhookUrl: string;
let home: string;

beforeAll(async () => {
  // 本地假飞书：返回 code=0 ⇒ 一次就成功，不触发重试，也不出网
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, msg: "success" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  webhookUrl = `http://127.0.0.1:${port}/hook`;

  home = mkdtempSync(join(tmpdir(), "aex-cli-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executors: { fake: { bin: "/bin/ls" } },
    profiles: { p1: { executor: "fake", env: {} } },
    notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: false, keyword: "agent-ex" },
    defaults: { profile: "p1", timeout_sec: 60 },
  }, null, 2));
  // 密钥只放在 .env 里——这正是 init 的默认产出形态
  writeFileSync(join(home, ".env"), `FEISHU_WEBHOOK_URL=${webhookUrl}\n`);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ out: string; code: number }> {
  return runCliAt(home, args);
}

async function runCliAt(cwdHome: string, args: string[]): Promise<{ out: string; code: number }> {
  const env = { ...process.env, AGENT_EX_HOME: cwdHome };
  // 关键：进程环境里**不能**有这个变量，否则测的是"环境变量已有"而不是"加载了 .env"
  delete (env as Record<string, string | undefined>).FEISHU_WEBHOOK_URL;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxCli, join(repoRoot, "src", "server.ts"), ...args],
      { env, encoding: "utf8", timeout: 60_000 },
    );
    return { out: stdout + stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.code ?? -1 };
  }
}

describe("agent-ex doctor --send（CLI 路径）", () => {
  it("会加载 $AGENT_EX_HOME/.env 并用其中的密钥发出自检卡（P0-1 回归）", async () => {
    const r = await runCli(["doctor", "--send"]);
    // 修复前这里是 "env placeholder {env:FEISHU_WEBHOOK_URL} not found in process environment"
    expect(r.out).not.toContain("env placeholder");
    // 加载成功 ⇒ 占位符被解析 ⇒ 自检卡真的发出并被接受
    expect(r.out).toContain("自检卡已投递");
    expect(r.code).toBe(0);
  });

  it("同一轮体检里不再自相矛盾（不再同时出现「已配置」与「not found」）", async () => {
    const r = await runCli(["doctor", "--send"]);
    expect(r.out).toContain("webhook 地址已配置");
    expect(r.out).not.toContain("env placeholder not found");
  });
});

describe("agent-ex config list（CLI 路径）", () => {
  it("不可执行的 executor 在输出里被标出来，而不是静默罗列", async () => {
    const listHome = mkdtempSync(join(tmpdir(), "aex-cli-list-"));
    try {
      writeFileSync(join(listHome, "config.json"), JSON.stringify({
        executors: { good: { bin: "/bin/ls" }, ghost: { bin: "/definitely/not/here" } },
        profiles: { p1: { executor: "good", env: {} } },
        notify: { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: "agent-ex" },
        defaults: { profile: "p1", timeout_sec: 60 },
      }, null, 2));
      const r = await runCliAt(listHome, ["config", "list"]);
      expect(r.code).toBe(0);
      // listConfig 用 resolveBinPath 真探测；这里钉住"值真的被渲染"（否则就是死字段）
      expect(r.out).toMatch(/ghost\s+bin=\/definitely\/not\/here\s+\(missing/);
      expect(r.out).not.toMatch(/good\s+bin=\/bin\/ls\s+\(missing/);
    } finally {
      rmSync(listHome, { recursive: true, force: true });
    }
  });

  it("未预期的异常走 CLI 兜底，而不是漏一个裸 Node 栈（MCP 侧由 SDK 兜，CLI 侧必须自己对等）", async () => {
    const badHome = mkdtempSync(join(tmpdir(), "aex-cli-bad-"));
    try {
      // config.json 是个目录 ⇒ readFileSync 抛 EISDIR（不依赖 uid/权限，跨环境稳定）
      mkdirSync(join(badHome, "config.json"));
      const r = await runCliAt(badHome, ["config", "list"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("[agent-ex] config failed");
      // 裸栈的标志：Node 的崩溃页脚
      expect(r.out).not.toMatch(/Node\.js v/);
    } finally {
      rmSync(badHome, { recursive: true, force: true });
    }
  });
});
