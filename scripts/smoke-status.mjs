// stdio 冒烟 #2：调 tools/call agent_ex_status 无参，期望 []
//
// 用法：node scripts/smoke-status.mjs [server.js 路径]（默认用本仓库的 dist/server.js）
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverEntry = process.argv[2] || join(scriptDir, "..", "dist", "server.js");
if (!existsSync(serverEntry)) {
  console.error(`FAIL: server entry not found: ${serverEntry}`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "afex-smoke-"));
mkdirSync(join(home, "logs"), { recursive: true });
writeFileSync(join(home, "config.json"), JSON.stringify({
  executors: { fake: { bin: process.execPath, extra_flags: [] } },
  profiles: { fake: { executor: "fake", env: {} } },
  notify: { feishu_webhook_url: "https://example.invalid/hook", dry_run: true },
  defaults: { profile: "fake", timeout_sec: 60 },
}));

const server = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, AGENT_EX_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });
const buf = [];
server.stdout.on("data", (d) => { buf.push(d); });

const send = (obj) => server.stdin.write(JSON.stringify(obj) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_ex_status", arguments: {} } });

setTimeout(() => {
  server.kill();
  const stdout = Buffer.concat(buf).toString();
  let ok = false;
  for (const line of stdout.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.id === 2 && j.result?.content?.[0]?.text) {
        const parsed = JSON.parse(j.result.content[0].text);
        console.log("status result:", JSON.stringify(parsed));
        if (Array.isArray(parsed) && parsed.length === 0) { ok = true; }
      }
    } catch {}
  }
  console.log(ok ? "OK: status returned []" : "FAIL");
  process.exit(ok ? 0 : 1);
}, 1500);