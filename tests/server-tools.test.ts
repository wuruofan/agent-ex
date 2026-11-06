import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 真实 spawn MCP server 走 stdio JSON-RPC，断言注册出来的工具集。
//
// 为什么需要这一层：src/server.ts 曾把 agent_ex_set_started_at 注册了两次，
// MCP SDK 对同名工具抛 "Tool ... is already registered"，被 main() 捕获后
// process.exit(1) —— server 启动即死，且只在 AGENT_EX_TEST_MODE=1 时暴露。
// 而模块顶层就直接执行 main()，函数级单测根本 import 不到它，所以必须 spawn 真实进程来验。

const CLI = join(process.cwd(), "node_modules/.bin/tsx");

function listTools(extra: Record<string, string>): Promise<string[]> {
  return withServer(extra, (send, onReply) => {
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    onReply(2, (m: { result?: { tools?: { name: string }[] } }) =>
      (m.result?.tools ?? []).map((t) => t.name));
  });
}

/**
 * 调用一个工具，返回原始 JSON-RPC 响应（成功或失败都要看得到）。
 */
function callTool(
  extra: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text?: string; error?: { code: number; message: string } }> {
  return withServer(extra, (send, onReply) => {
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
    onReply(2, (m: { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { code: number; message: string } }) => ({
      isError: m.result?.isError,
      text: m.result?.content?.[0]?.text,
      error: m.error,
    }));
  });
}

/**
 * 起一个真实的 MCP server，走 initialize → 一次调用 → 收答案。
 *
 * 抽出来是因为 listTools 与 callTool 的握手部分完全一样，而 callTool 需要的
 * 还不止工具名——它要看得见 JSON-RPC 层的 error 字段，才能断言"未知参数被拒"
 * 到底是以错误形式还是以正常结果形式回来的。
 */
function withServer<T>(
  extra: Record<string, string>,
  body: (
    send: (o: unknown) => void,
    onReply: (id: number, pick: (m: never) => T) => void,
  ) => void,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "afex-srv-"));
  const child = spawn(CLI, ["src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_EX_HOME: home, ...extra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise<T>((resolve, reject) => {
    let buf = "";
    let answered = false;
    // 60s 而不是原来的 25s：server 启动要加载整个 MCP SDK（连带 express/hono/ajv），
    // 文件 open 慢的机器上单次就 10s 量级；这里是"挂死"的上界，收得太紧只会误报。
    const timer = setTimeout(() => { child.kill(); reject(new Error("server call timeout")); }, 60_000);
    const done = (err: Error | null, value?: T) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      child.kill();
      rmSync(home, { recursive: true, force: true });
      err ? reject(err) : resolve(value!);
    };
    const onReply = (id: number, pick: (m: never) => T) => {
      const handler = (m: never) => done(null, pick(m));
      replyHandlers.set(id, handler);
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        const m = JSON.parse(line);
        if (m.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          body(
            (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n"),
            onReply,
          );
        } else if (m.id === 2) {
          replyHandlers.get(2)?.(m);
        }
      }
    });
    const replyHandlers = new Map<number, (m: never) => void>();
    child.on("exit", (code) => done(new Error(`server exited before answering (code ${code})`)));
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
    }) + "\n");
  });
}

describe("MCP server tool registration", () => {
  // 用例级超时写 120s 而不是 30s：每次 spawn 都要起一个完整 server（加载 MCP SDK →
  // express/hono/ajv，几百个模块）。并行跑其它 spawn 类测试文件时单次可到 30s+，
  // 30s 会让"慢"伪装成"工具没注册"。真正的挂死由 listTools 内部的 60s deadline 报错。
  it("registers the 6 production tools and no test helper", async () => {
    const names = (await listTools({ AGENT_EX_TEST_MODE: "0" })).sort();
    expect(names).toEqual([
      "agent_ex_cancel",
      "agent_ex_doctor",
      "agent_ex_restart",
      "agent_ex_status",
      "agent_ex_submit",
      "agent_ex_version",
    ]);
  }, 120_000);

  it("registers set_started_at exactly once when test mode is on", async () => {
    const names = await listTools({ AGENT_EX_TEST_MODE: "1" });
    expect(names.filter((n) => n === "agent_ex_set_started_at")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(7);
  }, 120_000);

  // zod 的 z.object() 默认**剥离**未知参数（additionalProperties:false 只写在
  // JSON Schema 里，zod 层不执行），于是拼错的参数名会被静默忽略、返回一个
  // 看似正常的空列表。agent 无法从返回值区分"参数没生效"和"真的没有任务"——
  // 曾经就因此在 MCP 指向旧版 dist 时误判成"没有任务"。.strict() 让它变成显式错误。
  //
  // SDK 把校验失败包装成 result.isError=true + 文本消息（不是 JSON-RPC error 字段），
  // 所以这里断言 isError 与消息文本。
  it("rejects an unknown argument instead of silently ignoring it", async () => {
    const r = await callTool({}, "agent_ex_status", { include_terminal: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/-32602/);
    expect(r.text).toMatch(/include_terminal/);
    expect(r.text).toMatch(/Unrecognized key/i);
  }, 120_000);

  it("accepts the documented arguments", async () => {
    const r = await callTool({}, "agent_ex_status", { include_finished: true, limit: 3 });
    expect(r.error).toBeUndefined();
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(JSON.parse(r.text!))).toBe(true);
  }, 120_000);
});
