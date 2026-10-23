/**
 * `agent-ex init` —— 交互式 onboarding。
 * 自动探测 agent CLI 绝对路径、引导填写 profile 与密钥，生成：
 *   $AGENT_EX_HOME/config.json   —— 只含 {env:VAR} 占位符，零明文密钥
 *   $AGENT_EX_HOME/.env          —— 真实密钥，chmod 600，本地文件不提交不同步
 * 完成后用 loadConfig() 自校验，并提示可编辑 config.json 调整模型别名/默认 env。
 *
 * 密钥处理策略：
 *   - preset（minimax/deepseek）：检测对应环境变量 → 掩码展示 → 问 "Use this value? (Y/n)"（Enter=Y）；
 *     拒绝后粘贴新值或 Enter=skip。config 占位符沿用预设的 token_var。
 *   - custom：只粘贴（无标准变量名可检测）；占位符变量名从 profile 名派生（apiKeyVarFor）。
 *   - 检测到/粘贴到的值写入 .env（幂等）；config.json 始终是 {env:VAR}。
 */
import { execSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentExHome, ensureRuntimeDirs } from "./paths.js";
import { loadConfig, validateConfig, type Config } from "./config.js";
import { BRAND } from "./brand.js";
import { ZEN_FREE_PLACEHOLDER } from "./zen-free.js";
import { diffConfigs, renderChangeWarning } from "./init-changes.js";
import { ansi } from "./ansi.js";
import { MARK } from "./marks.js";

type RL = ReturnType<typeof createInterface>;

/** 本工具支持的 agent CLI（名字 = config 里的 executor 名）。 */
export const AGENT_CLIS = ["claude", "opencode"] as const;

function which(name: string): string | null {
  try {
    return execSync(`command -v ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

export interface DetectedCli {
  name: string;
  /** 绝对路径（`command -v` 的结果）。 */
  bin: string;
}

/**
 * 探测可用的 agent CLI。
 *
 * `whichFn` 可注入：测试不能依赖开发机装了什么（§9 的"PATH 巧合"同款问题）。
 */
export function detectAgentClis(whichFn: (name: string) => string | null = which): DetectedCli[] {
  const out: DetectedCli[] = [];
  for (const name of AGENT_CLIS) {
    const bin = whichFn(name);
    if (bin) out.push({ name, bin });
  }
  return out;
}

/**
 * 探测结果的展示。
 *
 * 原先是 `detected: claude=(not found)  opencode=/path` —— 给机器看的：
 * "没找到"与"找到了"平铺在同一行，用户得自己分辨哪个可用。
 *
 * 现在两个候选**都列出来**，用颜色区分（找到=绿、没找到=暗）：
 * 只列找到的那个会让人看不出"另一个到底是没有、还是压根不支持"。
 */
export function renderDetectedClis(found: DetectedCli[]): string {
  const lines = AGENT_CLIS.map((name) => {
    const hit = found.find((f) => f.name === name);
    return hit
      ? `  ${ansi.green(MARK.ok)} ${name.padEnd(9)} ${hit.bin}`
      : `  ${ansi.dim(MARK.error)} ${ansi.dim(name.padEnd(9) + "not found on PATH")}`;
  });
  const header = found.length === 0
    ? ansi.yellow("No agent CLI found on PATH")
    : ansi.bold("Agent CLIs on PATH");
  return `${header}\n${lines.join("\n")}`;
}

async function ask(rl: RL, prompt: string, def?: string): Promise<string> {
  // 默认值用暗色：它是"回车即可"的提示，不该和正题一样抢注意力
  const suffix = def !== undefined ? ` ${ansi.dim(`[${def}]`)}` : "";
  return (await rl.question(`${ansi.cyan(prompt)}${suffix}${ansi.dim(":")} `)).trim();
}

/**
 * yes/no 型提问。
 *
 * 为什么不用普通 `ask` + `[Y/n]` 后缀：
 *  - `[N]` 只说"默认值是 N"，没说还能按什么。Unix 惯例是 `(y/N)`——
 *    **小写=可选的答案，大写=回车即取的默认值**，一眼看出"按 N 就是不"。
 *  - 返回值直接是 boolean，调用方不会各写一遍大小写/空串的归一化（漏一处就是 bug）。
 *
 * 非法输入不重问而是按默认值处理：重问意味着在 readline 里循环，
 * 一旦输入流已经 EOF（管道/脚本场景），第二次 question() 会抛 "readline was closed"。
 */
async function askYesNo(rl: RL, prompt: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "(Y/n)" : "(y/N)";
  const answer = (await rl.question(`${ansi.cyan(prompt)} ${ansi.dim(hint)}${ansi.dim(":")} `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  if (answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  console.log(ansi.dim(`  (please answer y or n — treating it as "${defaultYes ? "yes" : "no"}")`));
  return defaultYes;
}

/** 通用 claude 环境变量默认值：自动并入每个 claude profile，用户可事后编辑 config.json 调整。 */
export const DEFAULT_CLAUDE_ENV: Record<string, string> = {
  API_TIMEOUT_MS: "3000000",
};

interface Preset {
  base_url: string;
  model: string;
  small?: string;
  opus?: string;
  haiku?: string;
  /** 该 provider 密钥的标准环境变量名（init 据此检测环境里的值）。 */
  token_var: string;
  extra?: Record<string, string>;
}

/** provider 预设 = base_url + 默认模型 + 密钥变量名；未来加 provider 只需加一条（数据驱动，不碰逻辑）。 */
const PRESETS: Record<string, Preset> = {
  minimax: {
    base_url: "https://api.minimaxi.com/anthropic",
    model: "MiniMax-M3[1m]",
    small: "MiniMax-M3[1m]", opus: "MiniMax-M3[1m]", haiku: "MiniMax-M3[1m]",
    token_var: "MINIMAX_API_KEY",
    extra: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "384000" },
  },
  deepseek: {
    base_url: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-pro[1m]",
    small: "deepseek-v4-pro[1m]", opus: "deepseek-v4-pro[1m]", haiku: "deepseek-v4-flash[1m]",
    token_var: "DEEPSEEK_API_KEY",
  },
};

/** custom 时密钥的 .env 变量名：从 profile 名派生（myprov → MYPROV_API_KEY），多 custom profile 互不冲突。 */
export function apiKeyVarFor(profile: string): string {
  const base = profile.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "DEFAULT";
  return `${base}_API_KEY`;
}

/** provider preset → claude executor 所需的 profile.env（密钥为 {env:VAR} 占位符 + 通用默认 env）。 */
export function presetEnv(presetName: string, tokenVar: string): Record<string, string> {
  if (presetName === "custom") return {};
  const p = PRESETS[presetName] ?? PRESETS.minimax;
  return {
    ...DEFAULT_CLAUDE_ENV,
    ANTHROPIC_BASE_URL: p.base_url,
    ANTHROPIC_AUTH_TOKEN: `{env:${tokenVar}}`,
    ANTHROPIC_MODEL: p.model,
    ANTHROPIC_SMALL_FAST_MODEL: p.small ?? p.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.small ?? p.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.opus ?? p.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: p.haiku ?? p.model,
    ...(p.extra ?? {}),
  };
}

/** 掩码展示密钥：sk-abc…wxyz（前 3 后 4），确认用对账号又不泄露。 */
function maskSecret(v: string): string {
  return v.length > 8 ? `${v.slice(0, 3)}…${v.slice(-4)}` : "***";
}

/**
 * 密钥/URL 采集（两步语义各自自洽）：
 *   detect=true 且环境里有值 → 掩码展示，问 "Use this value? (Y/n)"（Enter=Y，符合默认值惯例）；
 *     拒绝（n）才进入下一步 → 粘贴新值，或 Enter=skip。
 *   detect=false（custom）→ 直接粘贴或跳过。
 * 返回解析到的真实值；undefined 表示跳过（保留占位符，不写 .env）。
 */
async function collectSecret(
  rl: RL,
  opts: { label: string; varName: string; detect: boolean },
): Promise<string | undefined> {
  const detected = opts.detect ? process.env[opts.varName] : undefined;
  if (detected) {
    // "Detected X = sk-abc…wxyz" 单独一行，问题另起一行 ⇒ 两件事都看得清
    console.log(`Detected ${opts.varName} = ${maskSecret(detected)}`);
    if (await askYesNo(rl, "Use this value?", true)) return detected;
  }
  const b = (await ask(rl, `Paste ${opts.label} (or Enter to skip)`)).trim();
  return b || undefined;
}

/** 读 .env（保留出现顺序，跳过空行/注释；同 key 只取首个）。 */
function readEnv(envPath: string): { keys: string[]; map: Map<string, string> } {
  const keys: string[] = [];
  const map = new Map<string, string>();
  if (!existsSync(envPath)) return { keys, map };
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    const k = raw.slice(0, eq).trim();
    const v = raw.slice(eq + 1).trim();
    if (k && !map.has(k)) { map.set(k, v); keys.push(k); }
  }
  return { keys, map };
}

/**
 * 把 entries 合并进 $home/.env（chmod 600）。幂等：与已有值相同则不重写。
 * 返回本次实际写入的 key 列表。
 */
export function writeEnvFile(home: string, entries: Record<string, string>): string[] {
  const envPath = join(home, ".env");
  const { keys, map } = readEnv(envPath);
  const written: string[] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (map.get(k) === v) continue;
    if (!map.has(k)) keys.push(k);
    map.set(k, v);
    written.push(k);
  }
  if (written.length === 0) return written;
  const body = keys.map((k) => `${k}=${map.get(k)}`).join("\n") + "\n";
  writeFileSync(envPath, body, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return written;
}

export interface InitAnswers {
  executor: string;
  bin: string;
  profile: string;
  env: Record<string, string>;
  notify: { feishu_webhook_url: string; dry_run?: boolean; keyword?: string };
  timeout_sec: number;
}

/**
 * 各 executor 的默认「无人值守」权限开关（语义相同、参数名不同）：
 * - claude：`--dangerously-skip-permissions`
 * - opencode：`--auto`（v1.18.33 的文档化开关；`--dangerously-skip-permissions` 虽仍被解析，
 *   但未见于 `opencode run --help`，属未文档化兼容，不作为默认值）
 */
export const DEFAULT_EXTRA_FLAGS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  opencode: ["--auto"],
};

/** 纯函数：答案 → config 对象。脱离 readline，便于单测与自校验复用。 */
export function buildConfig(a: InitAnswers) {
  return {
    executors: { [a.executor]: { bin: a.bin, extra_flags: DEFAULT_EXTRA_FLAGS[a.executor] ?? [] } },
    profiles: { [a.profile]: { executor: a.executor, env: a.env } },
    notify: a.notify,
    defaults: { profile: a.profile, timeout_sec: a.timeout_sec },
  };
}

/**
 * 解析当前运行 init 的 node 解释器绝对路径（用于 MCP 配置里）。
 * 刻意不用 process.execPath 之外的手段：execPath 就是真实解释器，天然带 shebang 的
 * `#!/usr/bin/env node` 之外的绝对路径，避免 MCP 客户端 spawn 时依赖 PATH。
 */
export function nodeExecPath(): string {
  return process.execPath;
}

/**
 * 生成可直接粘贴进宿主 MCP 配置的片段。
 * **为什么必须用绝对路径**：MCP 客户端 spawn 子进程时不继承用户 shell 的 PATH——
 * `node_modules/.bin` 只有 npm 脚本执行时才临时注入。所以 `{command:"agent-ex"}`
 * 这类裸命令名在 IDE（GUI 应用不读 .zshrc，尤其 nvm 用户）里会直接 command not found。
 * 2026-10-10 实测：同一台机器 PATH 不含 .bin 时裸命令名失败、绝对路径正常。
 */
export function mcpServerSnippet(serverEntry: string): string {
  return JSON.stringify(
    { mcpServers: { [BRAND]: { command: nodeExecPath(), args: [serverEntry] } } },
    null,
    2,
  );
}

/**
 * init 结束后打印"下一步"，含飞书通知的自检提示。
 *
 * 为什么要专门提示 dry_run：init 写出的 config 一律 `dry_run: true`（安全默认），
 * 于是"配好了却没收到通知"是最常见的第一手困惑 —— 卡片只打到 stderr。
 * 这里把这一句和它的修复命令直接摆出来。
 */
export function nextSteps(home: string, serverEntry: string): string {
  return [
    "",
    "Next steps:",
    "",
    "1) Set the data dir (put it in your MCP server env):",
    `     export AGENT_EX_HOME=${home}`,
    "",
    "2) Register the MCP server — paste into your client's MCP config",
    "   (Trae: TRAE SOLO CN/User/mcp.json, WorkBuddy: ~/.workbuddy/mcp.json):",
    mcpServerSnippet(serverEntry),
    "",
    "   Absolute paths matter: MCP clients spawn the server without your shell PATH,",
    "   so a bare \"agent-ex\" command often fails to start (common with nvm).",
    "",
    "3) Install the dispatch skill (optional but recommended — gives you the",
    "   dispatch workflow and the background waiter):",
    "     npx -y skills add wuruofan/agent-ex --skill agent-ex-dispatch -g -y",
    "",
    "   Already have a clone? ./scripts/install-skill.sh links it instead.",
    "   Skill dirs differ per host; if the load does not take effect, find yours with:",
    "     find ~ -maxdepth 4 -type d -name skills -path '*<host>*' 2>/dev/null",
    "",
    "4) Feishu notifications are in dry-run mode (nothing is delivered yet).",
    "   When the bot's keyword matches, turn delivery on:",
    "     agent-ex config set notify.dry_run false",
    "   Then verify with a clean self-check card (body must not contain the",
    "   product name, or the keyword gate may pass by accident):",
    "     agent-ex doctor --send",
    "",
    "5) Optional: edit " + join(home, "config.json") + " to tune model aliases / env.",
    "   Or use the targeted commands: agent-ex config set <key> <value> / agent-ex profile set <profile> <KEY> <value>",
  ].join("\n");
}

/**
 * 读既有 config（宽容解析）。
 *
 * 宽容是刻意的：config 可能已经坏了（手改出错 / 迁移写坏），而 init 的职责是**修复**它，
 * 不能因为 JSON 解析失败就崩在门口——那种情况下用户看到的是"init 报了个语法错误"，
 * 而不是"你的 config 坏了，init 会重写它"。因此解析失败按 null 处理（=当成没有旧 config），
 * 但把警告留给变更预告那一段去说。
 */
function readExistingConfig(cfgPath: string): Config | null {
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Config;
    return cfg && typeof cfg === "object" ? cfg : null;
  } catch {
    return null;
  }
}

/** 备份文件后缀：20261016-142530（本地时间，排序友好）。 */
function timestampSuffix(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface InitOptions {
  /**
   * 探测 agent CLI 的实现（默认走 `command -v`）。
   *
   * 可注入是为了让测试**不依赖开发机装了什么**：init 的问答流程会随
   * "探测到几个 CLI"变化（只找到一个就不再问"用哪个"），若探测结果依赖
   * 开发机环境，测试就会变成"这台机器恰好装了 X"的巧合。
   */
  which?: (name: string) => string | null;
}

export async function runInit(input: NodeJS.ReadableStream = process.stdin, opts: InitOptions = {}): Promise<void> {
  const home = agentExHome();
  ensureRuntimeDirs();
  const cfgPath = join(home, "config.json");
  const rl = createInterface({ input, output: process.stdout });

  try {
    if (existsSync(cfgPath)) {
      // 这里只做"廉价退出"，不做"知情同意"：此刻还不知道新 config 长什么样（问答还没开始），
      // 所以问"要不要覆盖"是在让用户对一个未知后果点头。知情同意放在写盘前那一刻
      // （那时新旧两份都在手上，能逐项列出差异）。
      //
      // 提示分三行：一行长文本会顶满终端宽度、还把问题挤在末尾。
      console.log(`${ansi.yellow(MARK.warn)} ${ansi.bold(cfgPath)} already exists.`);
      console.log(ansi.dim("  Re-running init REWRITES it — you will see exactly what changes before anything is written."));
      if (!(await askYesNo(rl, "Continue?", false))) { console.log("Aborted."); return; }
    }

    // ---- 探测可用的 agent CLI ----
    // 只列真正找到的；**只找到一个时不再问"用哪个"**（答案已经唯一），
    // 找到多个才问。
    const found = detectAgentClis(opts.which);
    console.log(renderDetectedClis(found));

    let executor: string;
    let detected: string | null = null;
    if (found.length === 1) {
      // 只有一个可用项 ⇒ 问"claude 还是 opencode"是白问（默认还是 claude 的话更糟：
      // 用户直接回车就会配出一个**根本没装**的 executor，还得再手打一遍它的路径）。
      executor = found[0].name;
      detected = found[0].bin;
      // 说清"为什么是它"：用户得知道这是**唯一**可用的，而不是我们随便挑的
      const missing = AGENT_CLIS.filter((n) => n !== executor).join(", ");
      console.log(`${ansi.green(MARK.ok)} Using ${ansi.bold(executor)} ${ansi.dim(`(${detected}) — the only one installed; ${missing} not found`)}\n`);
    } else if (found.length > 1) {
      const names = found.map((f) => f.name);
      const answer = (await ask(rl, `Which agent CLI to use? (${names.join("/")})`, found[0].name)).toLowerCase();
      const chosen = found.find((f) => f.name === answer);
      if (!chosen) {
        console.log(`${ansi.yellow(MARK.warn)} Unknown agent CLI "${answer}" — using ${found[0].name}`);
      }
      executor = (chosen ?? found[0]).name;
      detected = (chosen ?? found[0]).bin;
    } else {
      // 一个都没找到：只能问用户要绝对路径
      executor = (await ask(rl, "Agent CLI to configure (claude/opencode)", "claude")).toLowerCase() || "claude";
      if (executor !== "claude" && executor !== "opencode") {
        console.log(`${ansi.yellow(MARK.warn)} Unknown agent CLI "${executor}", falling back to claude`);
        executor = "claude";
      }
    }

    let bin = (await ask(rl, `Absolute path to ${executor} binary`, detected ?? "")).trim();
    if (!bin && detected) bin = detected;
    if (!bin) { console.error(`${ansi.red(MARK.error)} No binary path provided; aborting.`); process.exit(1); }

    const profile = (await ask(rl, "Profile name", "default")).trim() || "default";

    const envUpdates: Record<string, string> = {};
    let env: Record<string, string> = {};

    if (executor === "claude") {
      const presetName = (await ask(rl, "Provider preset (minimax/deepseek/custom)", "minimax")).toLowerCase() || "minimax";
      let tokenVar: string;
      if (presetName === "custom") {
        const base = (await ask(rl, "ANTHROPIC_BASE_URL")).trim();
        const model = (await ask(rl, "ANTHROPIC_MODEL")).trim();
        tokenVar = apiKeyVarFor(profile);
        env = { ...DEFAULT_CLAUDE_ENV, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: `{env:${tokenVar}}`, ANTHROPIC_MODEL: model };
      } else {
        const p = PRESETS[presetName] ?? PRESETS.minimax;
        tokenVar = p.token_var;
        env = presetEnv(presetName, tokenVar);
      }
      // custom 无标准变量名可检测 → 只粘贴
      const secret = await collectSecret(rl, { label: "API key", varName: tokenVar, detect: presetName !== "custom" });
      if (secret) envUpdates[tokenVar] = secret;
    } else {
      console.log(`${ansi.dim(MARK.info)} opencode: the provider is managed by opencode itself (opencode auth login / opencode.json); agent-ex only launches it. For extra env vars, add them to the profile's env later.`);
      // zen free：零密钥、模型集会轮换 → 用 {model:zen-free} 占位符让 runner 每次 spawn 时动态解析。
      const zen = await askYesNo(rl, "Use opencode zen free model (auto-resolving, no key needed)", true);
      if (zen) {
        env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: ZEN_FREE_PLACEHOLDER, small_model: ZEN_FREE_PLACEHOLDER }) };
      }
    }

    const feishuSecret = await collectSecret(rl, { label: "Feishu webhook URL", varName: "FEISHU_WEBHOOK_URL", detect: true });
    if (feishuSecret) envUpdates.FEISHU_WEBHOOK_URL = feishuSecret;
    const notify = { feishu_webhook_url: "{env:FEISHU_WEBHOOK_URL}", dry_run: true, keyword: BRAND };

    const timeoutRaw = (await ask(rl, "Default timeout (seconds)", "3600")).trim();
    const timeout = Number.parseInt(timeoutRaw, 10) || 3600;

    const config = buildConfig({ executor, bin, profile, env, notify, timeout_sec: timeout });

    // ---- 覆盖前的变更预告：让用户知道"要放弃什么"再决定 ----
    // 位置在这里（而不是流程开头）是因为"要变成什么"必须等问答结束才知道；
    // 而"现在有什么"在读旧 config 时就有了。两份信息齐了才谈得上预告。
    const oldCfg = readExistingConfig(cfgPath);
    const changes = diffConfigs(oldCfg, config as Config);
    if (changes.length > 0) {
      console.log(renderChangeWarning(changes));
      const proceed = await askYesNo(rl, "Apply these changes?", false);
      if (!proceed) { console.log("Aborted."); return; }
    }

    // ---- 先校验、后落盘 ----
    // 原先是"先写盘再校验"，校验失败时坏 config 已落盘、旧 config 已被覆盖且无法恢复
    // （实测：bin 路径不存在 → "config written but self-check failed" + exit 1，
    //   用户手里只剩一个坏文件）。改成写前校验，失败则旧 config 原封不动。
    try {
      validateConfig(config as Config);
    } catch (e) {
      console.error(`${ansi.red(MARK.error)} Config is invalid, nothing written: ${(e as Error).message}`);
      process.exit(1);
    }

    // 备份旧 config（覆盖是不可逆的，留一份回退路径）
    if (oldCfg) {
      const bak = `${cfgPath}.bak.${timestampSuffix()}`;
      try {
        writeFileSync(bak, readFileSync(cfgPath));
        console.log(`${ansi.dim(MARK.info)} Backed up existing config -> ${bak}`);
      } catch (e) {
        console.error(`${ansi.red(MARK.error)} Could not back up existing config: ${(e as Error).message}`);
      }
    }

    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`\n${ansi.dim(MARK.info)} Wrote ${cfgPath}`);

    const written = writeEnvFile(home, envUpdates);
    if (written.length > 0) {
      console.log(`${ansi.dim(MARK.info)} Wrote ${join(home, ".env")} (chmod 600): ${written.join(", ")}`);
    } else {
      console.log(`${ansi.dim(MARK.info)} .env unchanged (no new secrets written)`);
    }

    try {
      loadConfig(home);
      console.log(`${ansi.green(MARK.ok)} Config valid`);
    } catch (e) {
      console.error(`${ansi.red(MARK.error)} Config written but self-check failed: ${(e as Error).message}`);
      process.exit(1);
    }

    // 提示：占位符对应变量不在 .env（也没被采集到）→ 提醒运行时必须有值，否则任务失败
    const tokenPlaceholder = env.ANTHROPIC_AUTH_TOKEN ?? "{env:MINIMAX_API_KEY}";
    const tokenKeyMatch = /^\{env:(.+)\}$/.exec(tokenPlaceholder);
    const tokenKey = tokenKeyMatch ? tokenKeyMatch[1] : undefined;
    if (tokenKey && !readEnv(join(home, ".env")).map.has(tokenKey)) {
      console.log(`\n${ansi.yellow(MARK.warn)} ${tokenKey} not set — add it to ${join(home, ".env")} (or export it) before running the server, otherwise tasks will fail.`);
    }

    console.log(nextSteps(home, resolveServerEntry()));
  } finally {
    rl.close();
  }
}

/**
 * MCP 注册要指向的 server 入口绝对路径。
 * init 自己就在这个文件里（dist/init.js），server 入口是同目录的 dist/server.js——
 * 由当前文件位置推导，不依赖 cwd，也不需要用户自己拼。
 */
export function resolveServerEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "server.js");
}

// 直接运行时自动启动：tsx src/init.ts / node dist/init.js。
// 被 server.ts import（argv[1] 是 server）时不自动跑，避免与 server 的 init 分支重复执行。
const invokedDirectly = !!process.argv[1] && fileURLToPath(import.meta.url) === pathResolve(process.argv[1]);
if (invokedDirectly) {
  runInit().catch((e) => { console.error("[agent-ex] init failed:", e); process.exit(1); });
}
