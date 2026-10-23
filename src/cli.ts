/**
 * `agent-ex doctor` / `agent-ex config` / `agent-ex profile` 的 CLI 入口。
 *
 * 与 server 的分派是平级的：server.ts 看到 argv[2] 是 "doctor"/"config"/"profile" 就转到这里，
 * 其余情况走 MCP server。两者共用同一套纯函数（src/doctor.ts、src/config-cmd.ts），
 * 所以 CLI 与 MCP 工具的行为必然一致——不会出现"命令行说通了、agent 查出来不通"。
 */
import { doctor, applyFixes } from "./doctor.js";
import {
  configPath,
  listConfig,
  setConfigValue,
  useProfile,
  createProfile,
  setProfileValue,
  WRITABLE,
  BUILTIN_PROFILES,
} from "./config-cmd.js";
import { agentExHome } from "./paths.js";
import { ansi } from "./ansi.js";
import { MARK, CMD, SEVERITY_MARK } from "./marks.js";

/**
 * 渲染体检结果。
 *
 * 颜色跟着**级别**走，不跟着内容走：一屏输出里最该被一眼抓到的是 error。
 * 转义序列只在 TTY 下产生（见 ansi.ts），重定向到文件时是干净文本。
 *
 * 符号词汇见 marks.ts：mark 一律在行首，`→` 只用于"可复制执行的命令"。
 */
function renderDoctor(report: Awaited<ReturnType<typeof doctor>>): void {
  console.log(`\n${report.ok ? ansi.green(report.summary) : ansi.bold(ansi.red(report.summary))}\n`);
  for (const f of report.findings) {
    const style = SEVERITY_MARK[f.severity] ?? SEVERITY_MARK.info;
    console.log(`${style.paint(style.mark)} ${style.paint(f.title)}`);
    console.log(`    ${f.detail}`);
    if (f.fix) console.log(`    ${ansi.dim(CMD)} ${ansi.cyan(f.fix)}`);
  }
  if (report.notify_failures && report.notify_failures.logs_with_rejects > 0) {
    const s = report.notify_failures;
    console.log(`\n${ansi.yellow(`${s.logs_with_rejects} task log(s) contain rejected notifications`)}`);
    for (const [code, n] of Object.entries(s.by_code)) console.log(`  code=${code} × ${n}`);
  }
  console.log("");
}

export async function runDoctor(args: string[]): Promise<number> {
  const send = args.includes("--send");
  const fix = args.includes("--fix");
  const home = agentExHome();

  // ⚠️ `--fix --send` 的顺序：先修、再体检（并只发**一张**卡）。
  // 反过来（先发卡再修）会发出一张"修复前"的自检卡——那张卡可能注定被拒收
  // （比如关键词是空串、卡片根本没带关键词元素），用户拿到的 code 是修复前的状态，
  // 毫无意义。修复后那张卡才是用户要的结论。
  if (fix) {
    const r = applyFixes(home);
    // 标题用 bold 与其他段一致；末尾不再补空行——renderDoctor 自己以空行开头
    console.log(`\n${ansi.bold("Fixes:")}`);
    for (const a of r.applied) console.log(`  ${ansi.green(MARK.ok)} ${a}`);
    for (const s of r.skipped) console.log(`  ${ansi.dim(MARK.info)} ${s}`);
    for (const n of r.notes) console.log(`  ${ansi.yellow(MARK.warn)} ${n}`);
    if (r.applied.length === 0 && r.skipped.length === 0) {
      console.log(`  ${ansi.dim(MARK.info)} nothing to auto-fix`);
    }
    // 修完再体检一次，让用户看到修后状态（--send 也在这里发，且只发这一张）
    const after = await doctor({ home, send });
    renderDoctor(after);
    return after.ok ? 0 : 1;
  }

  const report = await doctor({ send, home });
  renderDoctor(report);
  return report.ok ? 0 : 1;
}

export function runConfig(args: string[]): number {
  const home = agentExHome();
  const [sub, ...rest] = args;

  if (!sub || sub === "list") {
    const l = listConfig(home);
    console.log(`\n${ansi.bold("Config:")} ${ansi.dim(configPath(home))}\n`);
    console.log(ansi.bold("Profiles:"));
    for (const p of l.profiles) {
      const mark = p.is_default ? ansi.dim("  (default)") : "";
      const env = p.env.length > 0 ? `  env=${p.env.join(",")}` : "";
      console.log(`  ${ansi.bold(ansi.cyan(p.name))}  executor=${p.executor}${p.model ? `  model=${p.model}` : ""}${env}${mark}`);
    }
    console.log(`\n${ansi.bold("Executors:")}`);
    // bin_ok 必须真的渲染出来：只在结构里探测、界面上不显示，等于没修
    // （原先恒为 true 的字段至少还骗得过眼睛，现在是真值却没人看）
    for (const e of l.executors) {
      const bad = e.bin_ok ? "" : `  ${ansi.red("(missing — not executable)")}`;
      console.log(`  ${ansi.bold(ansi.cyan(e.name))}  bin=${e.bin}${bad}`);
    }
    console.log(`\n${ansi.bold("Notify:")}`);
    console.log(`  dry_run   ${l.notify.dry_run}${l.notify.dry_run ? `  ${ansi.yellow("(nothing is delivered)")}` : ""}`);
    console.log(`  keyword   ${l.notify.keyword}`);
    console.log(`  webhook   ${l.notify.webhook}`);
    console.log(`\n${ansi.bold("Defaults:")} profile=${l.defaults.profile}  timeout_sec=${l.defaults.timeout_sec}`);
    console.log(`\n${ansi.dim(`Writable keys: ${Object.keys(WRITABLE).join(", ")}, executors.<name>.bin`)}`);
    console.log(`${ansi.dim(CMD)} agent-ex profile use <profile>  ${ansi.dim("(switch the default)")}`);
    console.log("");
    return 0;
  }

  if (sub === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) {
      console.error(`usage: agent-ex config set <key> <value>\n  keys: ${Object.keys(WRITABLE).join(", ")}, executors.<name>.bin`);
      return 2;
    }
    try {
      const r = setConfigValue(home, key, value);
      console.log(`${ansi.green(MARK.ok)} ${r.key} = ${ansi.bold(JSON.stringify(r.value))}`);
      if (r.key === "notify.dry_run" && r.value === false) {
        console.log(`  ${ansi.dim("Verify delivery:")} ${ansi.dim(CMD)} ${ansi.cyan("agent-ex doctor --send")}`);
      }
      return 0;
    } catch (e) {
      console.error(`${ansi.red(MARK.error)} ${(e as Error).message}`);
      return 1;
    }
  }

  console.error(`${ansi.red(MARK.error)} Unknown subcommand "${sub}" — usage: agent-ex config [list|set]`);
  return 2;
}

export function runProfile(args: string[]): number {
  const home = agentExHome();
  const [sub, ...rest] = args;

  if (!sub || sub === "list") {
    const l = listConfig(home);
    console.log(`\n${ansi.bold("Profiles:")}`);
    for (const p of l.profiles) {
      const mark = p.is_default ? ansi.dim("  (default)") : "";
      const env = p.env.length > 0 ? `  env=${p.env.join(",")}` : "";
      console.log(`  ${ansi.bold(ansi.cyan(p.name))}  executor=${p.executor}${p.model ? `  model=${p.model}` : ""}${env}${mark}`);
    }
    // 只列**还没物化**的预设：已经进了 config 的再列一遍，等于说"它不在 config 里"，是假话
    const unmaterialized = Object.keys(BUILTIN_PROFILES).filter((n) => !l.profiles.some((p) => p.name === n));
    if (unmaterialized.length > 0) {
      console.log(`\n${ansi.bold("Built-in presets")} ${ansi.dim("(not in the config yet):")} ${unmaterialized.join(", ")}`);
      console.log(`${ansi.dim(CMD)} agent-ex profile create <name>`);
    }
    console.log("");
    return 0;
  }

  if (sub === "use") {
    const name = rest[0];
    if (!name) {
      console.error(`usage: agent-ex profile use <profile>\n  existing: ${listConfig(home).profiles.map((p) => p.name).join(", ") || "(none)"}`);
      return 2;
    }
    try {
      const r = useProfile(home, name);
      console.log(`${ansi.green(MARK.ok)} default profile = ${ansi.bold(r.profile)}`);
      return 0;
    } catch (e) {
      console.error(`${ansi.red(MARK.error)} ${(e as Error).message}`);
      return 1;
    }
  }

  if (sub === "create") {
    const name = rest[0];
    if (!name) {
      console.error(`usage: agent-ex profile create <built-in> [--bin <path>] [--use]\n  built-in: ${Object.keys(BUILTIN_PROFILES).join(", ")}`);
      return 2;
    }
    // --bin <path>：内置 executor 常常不在 PATH 上（装在 ~/.opencode/bin 之类），
    // 而 validateConfig 会在落盘前拒绝不可执行的 bin ⇒ 不给这个选项就无路可走。
    const binIdx = rest.indexOf("--bin");
    const bin = binIdx >= 0 ? rest[binIdx + 1] : undefined;
    const use = rest.includes("--use");
    try {
      const r = createProfile(home, name, { ...(bin ? { bin } : {}), ...(use ? { use: true } : {}) });
      console.log(`${ansi.green(MARK.ok)} Created profile ${ansi.bold(r.profile)}${r.desc ? ansi.dim(`: ${r.desc}`) : ""}`);
      if (r.executor_created) console.log(`  ${ansi.dim("registered executor")} ${r.executor}`);
      // 没加 --use 才提示下一步；加了就已经切好了，再提示"Next: use"就是噪音
      if (r.switched_default) console.log(`  ${ansi.green(MARK.ok)} default profile = ${ansi.bold(r.profile)}`);
      else console.log(`  ${ansi.dim("Next:")} ${ansi.dim(CMD)} ${ansi.cyan(`agent-ex profile use ${r.profile}`)}   ${ansi.dim("(or pass --use next time)")}`);
      return 0;
    } catch (e) {
      console.error(`${ansi.red(MARK.error)} ${(e as Error).message}`);
      return 1;
    }
  }

  if (sub === "set") {
    const [name, key, value] = rest;
    if (!name || !key || value === undefined) {
      console.error(
        `usage: agent-ex profile set <profile> <key> <value>\n` +
        `  key: an env var name (e.g. ZEN_FREE_PREFER) or the reserved word "executor"`,
      );
      return 2;
    }
    try {
      const r = setProfileValue(home, name, key, value);
      console.log(`${ansi.green(MARK.ok)} ${r.profile}.${r.key} = ${ansi.bold(JSON.stringify(r.value))}`);
      return 0;
    } catch (e) {
      console.error(`${ansi.red(MARK.error)} ${(e as Error).message}`);
      return 1;
    }
  }

  console.error(`${ansi.red(MARK.error)} Unknown subcommand "${sub}" — usage: agent-ex profile [list|use|create|set]`);
  return 2;
}
