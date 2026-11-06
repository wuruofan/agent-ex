#!/usr/bin/env node
/**
 * mcp-wake-probe.mjs — 探测宿主（MCP client）会不会被 server 的主动通知叫醒。
 *
 * 背景
 * ----
 * agent-ex 是被动状态机：任务跑完 → 状态写进 tasks.db → **没有任何东西会推给宿主**。
 * 「后台任务完成 → 宿主开新 turn」这条通道在 Claude Code / WorkBuddy 上实测存在，
 * 在 Trae 上 10/20 实测**不存在**（docs/diagnostics/2026-10-20-trae-no-wake-channel.md P2）。
 *
 * MCP 协议本身有 server→client 的两条主动通道，本探针两条都试：
 *   1. `notifications/message`（logging）—— fire-and-forget，客户端不必回。
 *   2. `sampling/createMessage` —— server **请求**客户端跑一次 LLM，等回结果。
 *      比 notification 强：它是一次有响应的请求，若客户端实现了 sampling，
 *      就证明宿主有「让模型跑起来」的执行器（哪怕不一定是带会话上下文的那一个）。
 *
 * 关键：通知本身**不能证明**宿主被叫醒了 —— 只有宿主因此**产生新的 turn** 才是证据。
 * 所以本探针把「我发了什么」「客户端回了什么」「之后有没有新请求进来」全部落盘，
 * 由人（或另一个 agent）看时间线判断。
 *
 * 用法
 * ----
 * 作为 MCP server 启动：
 *   node scripts/probes/mcp-wake-probe.mjs
 *
 * 它暴露一个工具 `probe_fire`，参数 `{ delay_ms?, note? }`：
 *   - 立即回一条结果（工具调用本身必须先成功，否则宿主可能直接判失败不接后续）
 *   - 延后 `delay_ms`（默认 3000）后依次发 logging 通知与 sampling 请求
 *   - 把每一次尝试的成败写进 probe log（stderr + 文件）
 *
 * 看结果：
 *   - **客户端是否声明了 sampling 能力** → 探针在 initialize 时打印 client capabilities
 *   - **通知有没有送达/被响应** → probe log 里的 SEND/RECV 记录
 *   - **宿主有没有被叫醒** → 探针在通知之后如果收到**新的**请求（tools/call 等），
 *     说明有东西被触发了；日志里的时间戳与调用内容是直接证据
 *
 * 产出的证据文件（默认路径可用 PROBE_LOG 覆盖）：
 *   ~/.agent-ex/probe-wake.log —— 追加模式的 JSONL，每行一条带时间戳的事件
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG_PATH =
  process.env.PROBE_LOG ?? join(homedir(), ".agent-ex", "probe-wake.log");

let seq = 0;

function log(event, data = {}) {
  seq += 1;
  const rec = {
    seq,
    ts: new Date().toISOString(),
    epoch_ms: Date.now(),
    pid: process.pid,
    event,
    ...data,
  };
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n");
  } catch (e) {
    process.stderr.write(`[probe] log write failed: ${e?.message}\n`);
  }
  // stderr 是 MCP stdio server 唯一安全的日志通道（stdout 是协议流）。
  process.stderr.write(
    `[probe] ${rec.ts} #${seq} ${event} ${JSON.stringify(data)}\n`,
  );
}

log("server_start", {
  log_path: LOG_PATH,
  sdk_version: "1.30.0",
  argv: process.argv.slice(1),
});

const server = new McpServer(
  { name: "mcp-wake-probe", version: "0.1.0" },
  {
    // 声明 logging + resources 能力，否则 SDK 的 assertNotificationCapability 会拒绝
    // notifications/message 与 notifications/resources/updated。
    capabilities: {
      logging: {},
      resources: {},
    },
    instructions:
      "Wake-channel probe. Call probe_fire; it replies immediately and then pushes " +
      "a logging notification and a sampling request to the client after a delay. " +
      "The point is to see whether this client turns those into a new agent turn.",
  },
);

// 客户端在 initialize 握手里声明的能力 —— 这决定了 sampling 能不能用。
server.server.oninitialized = () => {
  const caps = server.server.getClientCapabilities();
  log("client_initialized", { client_capabilities: caps ?? null });
  process.stderr.write(
    `[probe] CLIENT CAPABILITIES: ${JSON.stringify(caps ?? null, null, 2)}\n`,
  );
};

// 资源：万一宿主支持 resources 拉取，这是一条比推送更稳的路。
server.registerResource(
  "probe-state",
  "probe://state",
  {
    title: "Wake probe state",
    description:
      "Latest probe state. Read this if the client prefers pulling over pushing.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          { seq, at: new Date().toISOString(), note: "probe state" },
          null,
          2,
        ),
      },
    ],
  }),
);

server.tool(
  "probe_fire",
  "Fire a logging notification and a sampling request at the client after a delay. " +
    "Used to test whether the host turns MCP server-initiated messages into a new agent turn.",
  {
    delay_ms: z
      .number()
      .int()
      .min(0)
      .max(60000)
      .optional()
      .describe("Delay before firing (default 3000)"),
    note: z.string().optional().describe("Free-form marker echoed into the log"),
  },
  async ({ delay_ms = 3000, note }) => {
    const at = Date.now();
    log("tool_called", { delay_ms, note: note ?? null, at });

    // 立刻回结果：工具调用必须先成功返回，否则宿主可能把后续行为判为失败路径。
    void (async () => {
      await new Promise((r) => setTimeout(r, delay_ms));

      // ---- 1. logging notification（fire-and-forget）----
      try {
        await server.server.sendLoggingMessage({
          level: "info",
          logger: "mcp-wake-probe",
          data: {
            kind: "wake-probe",
            note: note ?? null,
            message:
              "WAKE_PROBE_LOGGING: a background task reached a terminal state. " +
              "If you are seeing this as a NEW turn, the host turns MCP notifications " +
              "into agent turns.",
          },
        });
        log("logging_sent", { note: note ?? null });
      } catch (e) {
        log("logging_failed", { error: e?.message ?? String(e) });
      }

      // ---- 2. resources/updated（另一条推送）----
      try {
        await server.server.notification({
          method: "notifications/resources/updated",
          params: { uri: "probe://state" },
        });
        log("resource_updated_sent", {});
      } catch (e) {
        log("resource_updated_failed", { error: e?.message ?? String(e) });
      }

      // ---- 3. sampling（server 请求客户端跑一次 LLM）----
      // 客户端没声明 sampling 能力时 SDK 会抛错 —— 这本身就是一条结论。
      const caps = server.server.getClientCapabilities();
      if (!caps?.sampling) {
        log("sampling_skipped", {
          reason: "client did not declare the sampling capability",
          client_capabilities: caps ?? null,
        });
      } else {
        try {
          const res = await Promise.race([
            server.server.createMessage({
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text:
                      "WAKE_PROBE_SAMPLING: reply with exactly WAKE_PROBE_SAMPLING_OK " +
                      "and nothing else. This proves the client can run an LLM on the " +
                      "server's request.",
                  },
                },
              ],
              maxTokens: 64,
            }),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("sampling timed out after 30s")), 30000),
            ),
          ]);
          log("sampling_replied", { result: res });
        } catch (e) {
          log("sampling_failed", { error: e?.message ?? String(e) });
        }
      }

      log("fire_sequence_done", {});
    })();

    return {
      content: [
        {
          type: "text",
          text:
            `fired: probe_fire called at ${new Date(at).toISOString()}; ` +
            `logging + resources/updated + sampling will fire in ${delay_ms}ms. ` +
            `probe log: ${LOG_PATH}`,
        },
      ],
    };
  },
);

server.server.onerror = (err) => {
  log("server_error", { error: err?.message ?? String(err) });
};

await server.connect(new StdioServerTransport());
log("server_ready", {});

// stdin EOF = 客户端断开。
process.stdin.on("end", () => {
  log("stdin_end", {});
  process.exit(0);
});
