/**
 * `agent-ex doctor` / `agent-ex config` 的 CLI 入口。
 *
 * 与 server 的分派是平级的：server.ts 看到 argv[2] 是 "doctor"/"config" 就转到这里，
 * 其余情况走 MCP server。两者共用同一套纯函数（src/doctor.ts、src/config-cmd.ts），
 * 所以 CLI 与 MCP 工具的行为必然一致——不会出现"命令行说通了、agent 查出来不通"。
 */
import { doctor, applyFixes } from "./doctor.js";
import { configPath, listConfig, setConfigValue, useProfile, WRITABLE, BUILTIN_PROFILES } from "./config-cmd.js";
import { agentExHome } from "./paths.js";

const SEVERITY_MARK: Record<string, string> = { error: "✗", warn: "!", ok: "✓", info: "·" };

function renderDoctor(report: Awaited<ReturnType<typeof doctor>>): void {
  console.log(`\n${report.summary}\n`);
  for (const f of report.findings) {
    console.log(`${SEVERITY_MARK[f.severity] ?? "·"} ${f.title}`);
    console.log(`    ${f.detail}`);
    if (f.fix) console.log(`    → ${f.fix}`);
  }
  if (report.notify_failures && report.notify_failures.logs_with_rejects > 0) {
    const s = report.notify_failures;
    console.log(`\n历史通知失败：${s.logs_with_rejects} 个任务的日志里有拒收记录`);
    for (const [code, n] of Object.entries(s.by_code)) console.log(`  code=${code} × ${n}`);
  }
  console.log("");
}

export async function runDoctor(args: string[]): Promise<number> {
  const send = args.includes("--send");
  const fix = args.includes("--fix");
  const home = agentExHome();
  const report = await doctor({ send, home });
  if (fix) {
    const r = applyFixes(home, report);
    console.log("\n--fix:");
    for (const a of r.applied) console.log(`  ✓ ${a}`);
    for (const s of r.skipped) console.log(`  · ${s}`);
    if (r.applied.length === 0 && r.skipped.length === 0) console.log("  · 没有可自动修复的问题");
    console.log("");
    // 修完再体检一次，让用户看到修后的状态
    const after = await doctor({ home });
    renderDoctor(after);
    return after.ok ? 0 : 1;
  }
  renderDoctor(report);
  return report.ok ? 0 : 1;
}

export function runConfig(args: string[]): number {
  const home = agentExHome();
  const [sub, ...rest] = args;

  if (!sub || sub === "list") {
    const l = listConfig(home);
    console.log(`\nconfig: ${configPath(home)}\n`);
    console.log("profiles:");
    for (const p of l.profiles) {
      const mark = p.is_default ? " ← default" : "";
      console.log(`  ${p.name}  executor=${p.executor}${p.model ? `  model=${p.model}` : ""}${mark}`);
    }
    console.log("\nexecutors:");
    for (const e of l.executors) console.log(`  ${e.name}  bin=${e.bin}`);
    console.log(`\nnotify:`);
    console.log(`  dry_run   ${l.notify.dry_run}${l.notify.dry_run ? "  (nothing is delivered)" : ""}`);
    console.log(`  keyword   ${l.notify.keyword}`);
    console.log(`  webhook   ${l.notify.webhook}`);
    console.log(`\ndefaults: profile=${l.defaults.profile}  timeout_sec=${l.defaults.timeout_sec}`);
    console.log(`\nwritable keys: ${Object.keys(WRITABLE).join(", ")}`);
    console.log(`built-in profiles: ${Object.keys(BUILTIN_PROFILES).join(", ")}`);
    console.log("");
    return 0;
  }

  if (sub === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) {
      console.error(`usage: agent-ex config set <key> <value>\n  keys: ${Object.keys(WRITABLE).join(", ")}`);
      return 2;
    }
    try {
      const r = setConfigValue(home, key, value);
      console.log(`✓ ${r.key} = ${JSON.stringify(r.value)}`);
      if (r.key === "notify.dry_run" && r.value === false) {
        console.log("  Now verify delivery: agent-ex doctor --send");
      }
      return 0;
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      return 1;
    }
  }

  if (sub === "use") {
    const name = rest[0];
    if (!name) {
      console.error(`usage: agent-ex config use <profile>\n  built-in: ${Object.keys(BUILTIN_PROFILES).join(", ")}`);
      return 2;
    }
    try {
      const r = useProfile(home, name);
      console.log(`✓ default profile → ${r.profile}${r.created ? ` (created${r.desc ? `: ${r.desc}` : ""})` : ""}`);
      return 0;
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      return 1;
    }
  }

  console.error(`unknown subcommand "${sub}" — usage: agent-ex config [list|set|use]`);
  return 2;
}
