// 用一个模拟 MCP client 驱动 mcp-wake-probe.mjs，验证探针本身能跑通。
// 模拟 client 声明 sampling 能力并实现它，这样三条通道的「成功路径」都被覆盖。
//
// 用途：这是**探针自检** —— 在把它交给 Trae 之前，先证明「探针能发、客户端能收、
// 采样能被响应」。Trae 那次跑失败时，就能确定问题在宿主侧而不是探针侧。
import { spawn } from "node:child_process";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LOG = join(tmpdir(), `probe-selftest-${process.pid}.log`);
if (existsSync(LOG)) rmSync(LOG);

const server = spawn(
  process.execPath,
  [new URL("./mcp-wake-probe.mjs", import.meta.url).pathname],
  { env: { ...process.env, PROBE_LOG: LOG }, stdio: ["pipe", "pipe", "pipe"] },
);

let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });

const buf = [];
server.stdout.on("data", (d) => buf.push(d));

const send = (o) => server.stdin.write(JSON.stringify(o) + "\n");

// 声明 sampling 能力 + 实现 sampling handler —— 模拟一个「能跑 LLM」的客户端。
//
// 注意钩子方向：sampling/createMessage 是 **server 发给 client 的请求**，
// 走的是 server 的 stdout → client 的 stdin 方向之外的**反向**。
// client 要回应它，得读 server 的 stdout；而 server 的 stdout 也就是本文件的
// buf 收集的那一路。所以这里监听的是 server.stdout，而不是 server.stdin。
let handledSampling = false;
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.method === "sampling/createMessage") {
        handledSampling = true;
        send({
          jsonrpc: "2.0",
          id: j.id,
          result: {
            role: "assistant",
            content: { type: "text", text: "WAKE_PROBE_SAMPLING_OK" },
            model: "fake",
            stopReason: "endTurn",
          },
        });
      }
    } catch {}
  }
});

// initialize 与 notifications/initialized 不能同一批发：SDK 的 _oninitialize 是异步的，
// capabilities 在它 resolve 之后才落到 _clientCapabilities。先等 initialize 的响应回来。
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: { sampling: {}, roots: { listChanged: true } },
    clientInfo: { name: "probe-selftest", version: "0" },
  },
});

// initialize 的响应回来后再发 initialized，然后才 tools/call。
// 响应在 server.stdout 上（server → client 方向），不是 stdin。
let initDone = false;
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.id === 1 && j.result && !initDone) {
      initDone = true;
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "probe_fire",
            arguments: { delay_ms: 200, note: "selftest" },
          },
        });
      }, 200);
    }
  }
});

setTimeout(() => {
  server.kill();
  const stdout = Buffer.concat(buf).toString();
  console.log("=== probe stderr ===");
  console.log(stderr);
  console.log("=== stdout (jsonrpc) ===");
  console.log(stdout.slice(0, 1500));

  console.log("=== probe log events ===");
  if (!existsSync(LOG)) {
    console.log("FAIL: no probe log written");
    process.exit(1);
  }
  const events = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const e of events) console.log(` ${e.event}`, JSON.stringify({ ...e, event: undefined, ts: undefined, seq: undefined, pid: undefined }));

  const has = (n) => events.some((e) => e.event === n);
  const checks = [
    ["server_ready", has("server_ready")],
    ["client_initialized", has("client_initialized")],
    ["tool_called", has("tool_called")],
    ["logging_sent", has("logging_sent")],
    ["resource_updated_sent", has("resource_updated_sent")],
    ["sampling_replied", has("sampling_replied")],
    ["sampling handled by client", handledSampling],
  ];
  console.log("=== checks ===");
  let bad = 0;
  for (const [n, ok] of checks) {
    console.log(ok ? "  ok  " : "  FAIL", n);
    if (!ok) bad++;
  }
  const caps = events.find((e) => e.event === "client_initialized")?.client_capabilities;
  console.log("client capabilities seen by probe:", JSON.stringify(caps));
  console.log(bad === 0 ? "\nALL PASS" : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}, 3000);
