// stdio 冒烟：模拟 Trae 客户端发 initialize + tools/list 给 server.js
//
// 用法：
//   node scripts/smoke-stdio.mjs                       # 用本仓库的 dist/server.js
//   node scripts/smoke-stdio.mjs /path/to/server.js     # 用指定的 server 入口（发布前验证"装出来的包"时用这个）
//   node scripts/smoke-stdio.mjs <server.js> <AGENT_EX_HOME>
//
// 断言三件事（2026-10-26 补齐）：
//   1) 六个生产工具全部注册
//   2) TEST ONLY 工具**没有**被注册（它是 test mode 才开的，生产包不该暴露）
//   3) server 确实起来了（stderr 里的 ready 标记）
//
// 为什么第 2 条要断言：0.1.0 漏打 CLI 层那类事故，症状就是"包里缺东西"，
// 而 tools/list 是唯一能在发布前机械发现"少了哪个文件"的检查点。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

const serverEntry = process.argv[2] || join(repoRoot, "dist", "server.js");
const home = process.argv[3] || join(tmpdir(), "agent-ex-smoke");

if (!existsSync(serverEntry)) {
  console.error(`FAIL: server entry not found: ${serverEntry}`);
  console.error("      先跑 `npm run build`，或把要测的 server.js 路径作为第一个参数传进来。");
  process.exit(1);
}

const server = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, AGENT_EX_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });

const buf = [];
server.stdout.on("data", (d) => { buf.push(d); });

const send = (obj) => server.stdin.write(JSON.stringify(obj) + "\n");

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

const PRODUCTION_TOOLS = [
  "agent_ex_submit",
  "agent_ex_status",
  "agent_ex_cancel",
  "agent_ex_version",
  "agent_ex_restart",
  "agent_ex_doctor",
];
const TEST_ONLY_TOOLS = ["agent_ex_set_started_at"];

setTimeout(() => {
  server.kill();
  const stdout = Buffer.concat(buf).toString();
  let failed = false;
  let sawTools = false;

  for (const line of stdout.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.id === 2 && j.result?.tools) {
        sawTools = true;
        const names = j.result.tools.map((t) => t.name);
        console.log("server:", serverEntry);
        console.log("tools:", names.join(", "));

        const missing = PRODUCTION_TOOLS.filter((n) => !names.includes(n));
        if (missing.length === 0) {
          console.log(`OK: ${PRODUCTION_TOOLS.length} 个生产工具全部注册`);
        } else {
          console.error("FAIL: 缺工具", missing);
          failed = true;
        }

        const leaked = TEST_ONLY_TOOLS.filter((n) => names.includes(n));
        if (leaked.length === 0) {
          console.log("OK: 未暴露 TEST ONLY 工具");
        } else {
          console.error("FAIL: 暴露了 TEST ONLY 工具", leaked);
          failed = true;
        }
      }
    } catch {}
  }

  if (!sawTools) {
    console.error("FAIL: 没收到 tools/list 的响应");
    failed = true;
  }
  if (stderr.includes("mcp server ready")) {
    console.log("OK: server 启动就绪");
  } else {
    console.error("FAIL: server 未就绪，stderr:", stderr.slice(0, 400));
    failed = true;
  }

  console.log(failed ? "FAIL" : "ALL OK");
  process.exit(failed ? 1 : 0);
}, 2000);
