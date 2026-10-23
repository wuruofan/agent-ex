/**
 * `agent-ex doctor` —— 体检：把"通知到底通不通"这个问题的证据聚合成一句结论。
 *
 * 为什么需要它：2026-10-13 → 10-15 连续 23 个任务零通知，而**证据早就存在**，
 * 只是散在三个地方没人看：
 *   - `tasks.db` 的 `notify_failed`：布尔值，只知道"失败了"，分不清是关键词拒收还是网络不通；
 *   - runner 日志 `logs/runner-*.log`：`[notifier] feishu rejected: code=19024` —— 唯一能定位病因的证据面，
 *     但要手工翻 N 个文件；
 *   - `config.json` 的 `notify.dry_run`：最常见的原因，一眼可见但没人去看。
 *
 * doctor 的价值就在"聚合"：一次调用给出结论 + 病因 + 修复命令。
 *
 * ⚠️ 关键词闸门匹配的是**整张卡片**（不是那行小字），所以 worker 报告正文里偶然出现产品名
 * 就能过闸 —— 配置错了也可能长期"看起来正常"。因此验证必须用正文干净的自检卡（--send）。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { agentExHome, logsDir } from "./paths.js";
import { BRAND } from "./brand.js";
import {
  resolveEnvPlaceholders,
  resolveBinPath,
  validateConfig,
  collectConfigIssues,
  type Config,
  type ConfigIssueCode,
} from "./config.js";
import { buildFeishuCard, sendFeishuCard } from "./notifier.js";

export type Severity = "error" | "warn" | "info" | "ok";

export interface Finding {
  severity: Severity;
  /** 短标题，如 "通知不会投递"。 */
  title: string;
  /** 具体证据（配置值、错误码、日志片段）。 */
  detail: string;
  /** 可执行的修复命令（给用户 copy-paste）。 */
  fix?: string;
  /** --fix 能否自动修（true 时 doctor --fix 会尝试）。 */
  fixable?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  /** 一句话结论。 */
  summary: string;
  findings: Finding[];
  /** 扫到的通知失败统计（来自 runner 日志）。 */
  notify_failures?: NotifyFailureStats;
}

export interface NotifyFailureStats {
  /** 含 reject 记录的 runner 日志数。 */
  logs_with_rejects: number;
  /** 按 code 聚合的次数。 */
  by_code: Record<string, number>;
  /** 最近的失败样本（task id + code + 时间）。 */
  recent: Array<{ task_id: string; code: string; msg: string }>;
}

/**
 * 飞书 webhook 错误的含义与处置。
 *
 * ⚠️ `19001` 是 2026-10-16 扫真实 runner 日志时发现的（README 此前没有这张码）：
 * "incoming webhook access token invalid" —— webhook 地址本身失效了（机器人被删/重建/地址轮换）。
 * 它与 `19024`（关键词不匹配）的修法**完全不同**：19024 改关键词，19001 必须换 webhook 地址。
 * 混为一谈会导致"改了关键词还是不通"，白折腾。
 */
export const FEISHU_ERRORS: Record<string, { meaning: string; fix: string }> = {
  "19024": { meaning: "keyword check failed (the card does not contain the keyword registered on the bot)", fix: 'make notify.keyword match the bot\'s "Security settings -> Custom keywords"' },
  "19021": { meaning: 'signature check failed (the bot has "signature verification" enabled, and this tool sends no timestamp/sign)', fix: 'uncheck "signature verification" in the bot\'s security settings' },
  "19022": { meaning: 'IP check failed (the bot has an "IP allowlist")', fix: "uncheck the IP allowlist, or add your egress IP to it" },
  "19001": { meaning: "webhook token invalid (the URL no longer works: bot deleted/recreated, address rotated)", fix: "copy the webhook URL again from the bot console and update FEISHU_WEBHOOK_URL in .env" },
  "9499": { meaning: "request body malformed", fix: "check whether the card JSON exceeds 20 KB" },
  "11232": { meaning: "rate limited", fix: "avoid bursty dispatching (100/min, 5/s per bot)" },
};

/**
 * 本工具改名前用过的产品名（改名史，见 git: agent-flow → agent-flow-ex → agent-ex）。
 *
 * 只有这些名字能被判定为"客观上错了"：它们只可能来自本仓库自己的改名，
 * 留在 config 里就是没跟着改的遗留——2026-10-13→10-15 的 23 个任务零通知
 * 就是 live config 里留着 `agent-flow-ex` 造成的（机器人登记的是新名 `agent-ex`）。
 *
 * ⚠️ 不在名单里的自定义词（用户自己登记的）**不算错**：机器人登记了什么词，
 * 本地无从得知，那是用户的界面（见 brand.ts："用户显式写 keyword 仍然优先"）。
 */
const STALE_BRANDS = new Set(["agent-flow", "agent-flow-ex"]);

/** notify.keyword 的四种状态——doctor 的判定与 --fix 的动作共用这一份分类，避免两处规则漂移。 */
export type KeywordState = "unset" | "empty" | "brand" | "stale" | "custom";

/**
 * 判定 notify.keyword 处于哪种状态。
 *
 * - `unset`：字段缺失 ⇒ 运行时由 `loadConfig` 填 BRAND（config.ts 的 `??= BRAND`），
 *   卡片**是带关键词元素**的 ⇒ 不是缺陷，更不能把 BRAND 写死进 config
 *   （写死等于冻结默认值，下次改名又变成"陈旧值"，正是 brand.ts 要防的漂移）。
 * - `empty`：显式空串 ⇒ `??=` 不会替换它（空串不是 null/undefined）⇒ 卡片里
 *   **没有关键词元素**（notifier.ts 的 `if (keyword)`）⇒ 只要机器人开了关键词闸门
 *   就必然被拒（19024）。这是唯一能证明"投递不了"的配置态。
 * - `stale`：本工具的旧产品名 ⇒ 客观上的遗留，可自动修。
 * - `custom`：用户自定义词 ⇒ 合法，不判错、不自动改。
 */
export function classifyKeyword(keyword: string | undefined): KeywordState {
  if (keyword === undefined) return "unset";
  if (keyword.trim() === "") return "empty";
  if (keyword === BRAND) return "brand";
  if (STALE_BRANDS.has(keyword)) return "stale";
  return "custom";
}

/**
 * `--fix` 的能力表：doctor 的 `fixable` 标记与 `applyFixes` 的实现**共用这一份**。
 *
 * 以前 `fixable` 是手写的，于是出现过两处"标了能修、实际不修"：
 *  - 默认 profile 不存在标 `fixable: true`，但 applyFixes 没有这个分支
 *    ⇒ `--fix` 打印"没有可自动修复的问题"（MCP 侧 agent 会照着调，白跑一趟）；
 *  - 明文 webhook 标 `fixable: true`，但 applyFixes 只处理 `^https://` 开头
 *    ⇒ `{env:bad_lower}` 这种形状不合规的占位符被报成"明文凭证泄露"，
 *      而 `--fix` 静默不动、连 skipped 都不留。
 *
 * 现在能修的种类写在这张表里：doctor 只对表内的 kind 标 fixable，applyFixes 也只实现
 * 表内的 kind。新增一种自动修复 = 表里加一行 + applyFixes 加分支，两处不可能再漂。
 */
export type FixKind = "keyword.empty" | "keyword.stale" | "webhook.plaintext";
export const FIXABLE_KINDS: readonly FixKind[] = ["keyword.empty", "keyword.stale", "webhook.plaintext"];

/**
 * notify.feishu_webhook_url 的四种状态——doctor 的判定与 --fix 的动作共用这一份。
 *
 * `placeholder` 与 `malformed` 必须分开：前者是正常形态（只需确认变量有没有设），
 * 后者是"形状就不对"（比如 `{env:bad_lower}`，小写变量名解析不了）。把后者混进
 * "明文凭证泄露"是错的——它不是凭证泄露，而是一个必然失败的占位符。
 */
export type WebhookState = "empty" | "placeholder" | "plaintext" | "malformed";

export function classifyWebhook(url: string | undefined): WebhookState {
  const u = url ?? "";
  if (u === "") return "empty";
  if (/^\{env:[A-Z0-9_]+\}$/.test(u)) return "placeholder";
  if (/^https?:\/\//i.test(u)) return "plaintext";
  return "malformed";
}

/** 从 runner 日志里聚合通知失败证据。 */
export function scanNotifyFailures(home: string = agentExHome()): NotifyFailureStats {
  const dir = join(home, "logs");
  const stats: NotifyFailureStats = { logs_with_rejects: 0, by_code: {}, recent: [] };
  if (!existsSync(dir)) return stats;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("runner-") && f.endsWith(".log"));
  } catch {
    return stats;
  }
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const re = /feishu rejected: HTTP (\d+) code=(-?\d+) msg=(.*?)\s*\(attempt/g;
    let m: RegExpExecArray | null;
    const codesHere: Array<{ code: string; msg: string }> = [];
    while ((m = re.exec(text)) !== null) {
      codesHere.push({ code: m[2], msg: m[3] });
    }
    if (codesHere.length === 0) continue;
    stats.logs_with_rejects += 1;
    for (const c of codesHere) {
      stats.by_code[c.code] = (stats.by_code[c.code] ?? 0) + 1;
    }
    // 每个日志只记一条（同一任务重试 3 次算一次失败，但计数保留全部尝试数）
    const first = codesHere[0];
    stats.recent.push({ task_id: f.replace(/^runner-/, "").replace(/\.log$/, ""), code: first.code, msg: first.msg });
  }
  stats.recent.sort((a, b) => (a.task_id < b.task_id ? 1 : -1));
  return stats;
}

/** 读现有 config（宽容：坏 config 也要能体检）。 */
function readConfigLoose(home: string): { cfg: Config | null; error: string | null } {
  const p = join(home, "config.json");
  if (!existsSync(p)) return { cfg: null, error: "config.json does not exist" };
  try {
    return { cfg: JSON.parse(readFileSync(p, "utf8")) as Config, error: null };
  } catch (e) {
    return { cfg: null, error: `config.json failed to parse: ${(e as Error).message}` };
  }
}

/**
 * `--fix`：只修**确定性缺陷**，不碰用户偏好。
 *
 * 分界线的理由：doctor 若自动把 `dry_run` 改成 false，等于替用户决定"要往群里发真消息"——
 * 那是有后果的偏好，不是缺陷。所以 dry_run 只报不改。
 *
 * 可以自动修的，都是"客观上错了"的状态：
 *   - notify.keyword 显式空串 → 写 BRAND（空串让卡片不带关键词 ⇒ 必然 19024）；
 *   - notify.keyword 是本工具的旧产品名 → 改回 BRAND（改名遗留，2026-10-13 零通知的根因）；
 *   - 明文 webhook 落在 config.json → 挪进 .env、config 留占位符（凭证卫生）。
 *
 * 刻意**不修**的：
 *   - keyword 缺失 → 运行时派生 BRAND；写死等于冻结默认值，重新引入改名漂移；
 *   - keyword 是自定义值 → 机器人登记什么词是用户的界面（见 brand.ts）。
 */
export interface FixResult {
  applied: string[];
  skipped: string[];
  /** 需要用户知情的提示（如自动改了 keyword 后怎么改回去）。 */
  notes: string[];
}

export function applyFixes(home: string): FixResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  const c = readConfigLoose(home).cfg;
  if (!c) return { applied, skipped: ["config.json is unusable; nothing was changed"], notes };

  // 先在内存里改完、校验完，再动任何文件。
  //
  // 为什么不能边改边写：validateConfig 校验的是**整份**配置，而 --fix 修的只是其中一两项。
  // 2026-10-23 实测：一个坏 executor + 一个空 keyword 的配置，--fix 把异常从 validateConfig
  // 一路抛到 CLI，用户看到的是 Node 栈、什么 finding 都没有，且那次修的一个字节都没落盘。
  // doctor 的存在前提就是"一次聚合多个问题"，所以"可修项与不可修项并存"是主路径而非边角。
  // 现在校验失败时把改动记为 skipped/notes 并原样返回——文件不动，但话说明白。
  let changed = false;
  /** 待落盘的改动说明：写盘成功后才搬进 applied，避免"报修了却没写进去"。 */
  const pending: string[] = [];
  /** 待写入 .env 的行（延后到校验通过再写，避免 config 没改而凭证先被复制）。 */
  let envLine: string | null = null;
  /**
   * "改回去"的提示：**只在真的落盘后**才告诉用户。
   *
   * 之前它在改内存时就被 push 进 notes ⇒ 校验失败、什么都没写的时候，
   * 用户仍被告知"若你的机器人登记的就是旧名，请改回去"——可压根没改过，
   * 没什么可改回。与 applied 的 pending/applied 分档同理：报告必须与事实一致。
   */
  let revertHint: string | null = null;

  // keyword：只修"客观上错了"的两种——显式空串、可证明的改名遗留。
  // 缺失与自定义值一律不动（理由见上方注释）。
  const kw = c.notify?.keyword;
  const kwState = classifyKeyword(kw);
  if (kwState === "empty" || kwState === "stale") {
    const before = kw === undefined ? "(unset)" : JSON.stringify(kw);
    c.notify.keyword = BRAND;
    changed = true;
    pending.push(`notify.keyword: ${before} -> ${BRAND}`);
    if (kwState === "stale") {
      revertHint = `If the keyword registered on your bot really is the old name "${kw}", change it back: agent-ex config set notify.keyword "${kw}"`;
    }
  }

  // 明文 webhook → 挪进 .env。
  // 只处理 plaintext（http(s):// 开头）：placeholder 是正常形态，malformed（形状不对）
  // 也不是凭证——两者都不该被"自动修复"成 .env 条目。
  const url = c.notify?.feishu_webhook_url ?? "";
  if (classifyWebhook(url) === "plaintext") {
    const envPath = join(home, ".env");
    const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    if (!/^FEISHU_WEBHOOK_URL=/m.test(envText)) {
      envLine = `${envText ? envText.replace(/\n*$/, "\n") : ""}FEISHU_WEBHOOK_URL=${url}\n`;
      c.notify.feishu_webhook_url = "{env:FEISHU_WEBHOOK_URL}";
      changed = true;
      pending.push("notify.feishu_webhook_url: plaintext -> {env:FEISHU_WEBHOOK_URL} (original value moved to .env, mode 600)");
    } else {
      skipped.push("FEISHU_WEBHOOK_URL already exists in .env; not overwritten (verify by hand that it matches config)");
    }
  }

  if (!changed) return { applied, skipped, notes };

  try {
    validateConfig(c);
  } catch (e) {
    skipped.push(`config.json not written: validation of the whole config failed (${(e as Error).message})`);
    notes.push(`These changes were NOT written: ${pending.join("; ")}. The broken field above cannot be fixed automatically (--fix does not know what it should become); fix it first, then re-run --fix.`);
    return { applied, skipped, notes };
  }

  if (envLine !== null) {
    const envPath = join(home, ".env");
    writeFileSync(envPath, envLine, { mode: 0o600 });
    // mode 只在**创建**文件时生效；.env 在 init 之后几乎总是已存在（沿用旧权限），
    // 必须显式 chmod，否则凭证从 644 的 config.json 挪进 644 的 .env，防护强度没变
    // （与 init.ts 的 writeEnvFile 同一写法）。
    chmodSync(envPath, 0o600);
  }
  writeFileSync(join(home, "config.json"), JSON.stringify(c, null, 2) + "\n");
  applied.push(...pending);
  // 落盘成功了，"改回去"这条提示才有意义（没改过就没什么可改回）
  if (revertHint) notes.push(revertHint);
  return { applied, skipped, notes };
}

export async function doctor(opts: { home?: string; send?: boolean; fetchImpl?: typeof fetch; delays?: number[] } = {}): Promise<DoctorReport> {
  /**
   * 体检（只读，不改任何东西）。
   *
   * `send` 为真时额外发一张**正文不含产品名**的自检卡，并把飞书返回的 code 纳入结论。
   */
  const home = opts.home ?? agentExHome();
  const findings: Finding[] = [];

  // ---- 1. config 本身 ----
  const { cfg, error } = readConfigLoose(home);
  if (error) {
    findings.push({
      severity: "error",
      title: "config.json is unusable",
      detail: error,
      fix: "agent-ex init (rebuilds the config; the broken file is backed up first)",
    });
    return { ok: false, summary: "config.json is unusable — the rest could not be checked", findings };
  }
  const c = cfg!;

  /**
   * 去重键集合：记录"本次已经产出过更详细 finding"的 (code, subject)。
   *
   * ⚠️ 必须是**动态记录**，不能用静态跳过名单：静态名单本身就是第二份真相，
   * 2026-10-23 实测 `defaults: {}` 时 doctor 报"一切正常"——自有检查是
   * `if (defProfile && …)`（字段缺失就不触发），而 `defaults.profile` 又在跳过名单里，
   * 两边都不报。现在规则来自 collectConfigIssues，doctor 只补充**更详细**的文案。
   */
  const emitted = new Set<string>();
  const emitKey = (code: ConfigIssueCode, subject?: string) => `${code}#${subject ?? ""}`;

  // ---- 2. dry_run：最常见的原因，但不是缺陷，所以是 warn 不是 error ----
  const dryRun = c.notify?.dry_run ?? true;
  if (dryRun) {
    findings.push({
      severity: "warn",
      title: "Notifications are in dry-run mode — nothing is delivered",
      detail: "notify.dry_run = true -> terminal cards only go to stderr; the chat never receives them.",
      fix: "agent-ex config set notify.dry_run false",
    });
  } else {
    findings.push({ severity: "ok", title: "Notifications are actually delivered", detail: "notify.dry_run = false" });
  }

  // ---- 3. 关键词 ----
  // 事实边界（先说清楚 doctor 能判什么、不能判什么）：
  // 飞书机器人"登记了什么词"本地无从得知。所以 doctor 只能判**配置自身是否自洽**
  // 与**是否可证明投递不了**；"与登记词是否一致"只有 `doctor --send` 能判定——
  // 闸门匹配的是整张卡片，必须用正文干净的探针卡（见 §3.3 的实测教训）。
  const keyword = c.notify?.keyword;
  const kwState = classifyKeyword(keyword);
  if (kwState === "empty") {
    findings.push({
      severity: "error",
      title: "Keyword is explicitly empty",
      detail: 'notify.keyword = "" -> the card carries no keyword element (notifier.ts: if (keyword)) -> as long as the bot has the "custom keyword" gate enabled, every card is rejected (19024).',
      fix: `agent-ex config set notify.keyword ${BRAND}`,
      fixable: FIXABLE_KINDS.includes("keyword.empty"),
    });
  } else if (kwState === "unset") {
    findings.push({
      severity: "info",
      title: "Keyword not set explicitly (the product name is used at runtime)",
      detail: `notify.keyword is unset -> runtime fills in "${BRAND}" (config.ts: ??= BRAND, so it follows product renames); the card does carry a keyword element. If the bot registered a different word under "Security settings -> Custom keywords", set it explicitly.`,
    });
  } else if (kwState === "stale") {
    findings.push({
      severity: "error",
      title: "Keyword is a pre-rename product name",
      detail: `notify.keyword = "${keyword}", an old name of this tool (current: "${BRAND}"). If the bot registered "${BRAND}", every card is rejected (19024) — this is exactly what caused 23 tasks with zero notifications on 2026-10-13..15.`,
      fix: `agent-ex config set notify.keyword ${BRAND}`,
      fixable: FIXABLE_KINDS.includes("keyword.stale"),
    });
  } else if (kwState === "custom") {
    findings.push({
      severity: "warn",
      title: "Keyword is a custom value (not changed for you, but it must match the bot)",
      detail: `notify.keyword = "${keyword}", which differs from the product name "${BRAND}". If the bot registered "${keyword}", this is correct — ignore this item. If it registered "${BRAND}", cards are rejected (19024).`,
      fix: "agent-ex doctor --send (a self-check card tells you whether the registered word matches)",
    });
  } else {
    findings.push({
      severity: "ok",
      title: "Keyword matches the product name",
      detail: `notify.keyword = "${keyword}". Whether it matches the word registered on the bot can only be verified by a self-check card: agent-ex doctor --send`,
    });
  }

  // ---- 4. webhook 是否配了 ----
  // 四态（classifyWebhook）：empty / placeholder（正常形态）/ plaintext（凭证泄露，可修）/ malformed（形状不对，不可修）
  const webhookState = classifyWebhook(c.notify?.feishu_webhook_url);
  if (webhookState === "empty") {
    findings.push({
      severity: "error",
      title: "No webhook URL configured",
      detail: "notify.feishu_webhook_url is empty",
      fix: "agent-ex init (rebuilds the config; the broken file is backed up first)",
    });
    emitted.add(emitKey("notify.webhook"));
  } else if (webhookState === "plaintext") {
    // 明文凭证落在 config.json 里：config 会被提交/同步/贴到 issue 时就泄露了
    findings.push({
      severity: "error",
      title: "Webhook stored in plaintext in config.json (credential leak risk)",
      detail: "notify.feishu_webhook_url is not an {env:VAR} placeholder. config.json may be committed or synced, and the webhook URL is itself a credential.",
      fix: "agent-ex doctor --fix (moves the URL into .env and rewrites it as {env:FEISHU_WEBHOOK_URL})",
      fixable: FIXABLE_KINDS.includes("webhook.plaintext"),
    });
  } else if (webhookState === "malformed") {
    // 形状不合规的占位符（如 {env:bad_lower}）：不是凭证泄露，是必然失败的配置
    findings.push({
      severity: "error",
      title: "Webhook placeholder has the wrong shape",
      detail: `notify.feishu_webhook_url = "${c.notify?.feishu_webhook_url}", which is neither {env:UPPER_CASE_VAR} nor an http(s) URL. The resolver only accepts {env:[A-Z0-9_]+}, so this value can never be resolved.`,
      fix: "agent-ex config set (change notify.feishu_webhook_url in config.json to {env:FEISHU_WEBHOOK_URL} and put the secret in .env)",
    });
  } else {
    const varName = /^\{env:([A-Z0-9_]+)\}$/.exec(c.notify!.feishu_webhook_url)![1];
    const envFile = join(home, ".env");
    const hasInEnv = existsSync(envFile) && new RegExp(`^${varName}=.+$`, "m").test(readFileSync(envFile, "utf8"));
    const hasInProcess = Boolean(process.env[varName]);
    if (hasInEnv || hasInProcess) {
      findings.push({ severity: "ok", title: "Webhook URL is configured", detail: `${varName} is in ${hasInEnv ? ".env" : "the process environment"}` });
    } else {
      findings.push({
        severity: "error",
        title: "Webhook URL is not set",
        detail: `${varName} is in neither .env nor the process environment -> a real send will throw "env placeholder not found".`,
        fix: `add ${varName}=<webhook URL> to ${join(home, ".env")}`,
      });
    }
  }

  // ---- 5. 默认 profile 指向 ----
  // 缺失与"指向不存在的 profile"是两种病，但都归 defaults.profile 这一个 code。
  const defProfile = c.defaults?.profile;
  if (!defProfile) {
    findings.push({
      severity: "error",
      title: "No default profile set",
      detail: "defaults.profile is missing -> dispatching has no default profile (unknown profile); the server will not start.",
      fix: "agent-ex profile use <existing profile>",
    });
    emitted.add(emitKey("defaults.profile", "undefined"));
  } else if (!c.profiles?.[defProfile]) {
    findings.push({
      severity: "error",
      title: "Default profile does not exist",
      detail: `defaults.profile = "${defProfile}", but profiles has no such entry -> every dispatch fails (unknown profile).`,
      fix: "agent-ex profile use <existing profile>",
      // ⚠️ 不可自动修：不知道该指向哪个（"哪个都可能是"）。以前这里标 fixable: true，
      // 但 applyFixes 没有这个分支 ⇒ MCP 侧 agent 照着调 --fix 只会得到
      // "没有可自动修复的问题"，白跑一趟。fixable 由能力表派生，不手写。
      fixable: false,
    });
    emitted.add(emitKey("defaults.profile", defProfile));
  }

  // ---- 6. executor 的 bin 是否可执行 ----
  for (const [name, e] of Object.entries(c.executors ?? {})) {
    // ⚠️ bin 字段可能整个缺失（手改 config 的常见后果）：此时 resolveBinPath(undefined)
    // 会抛 "Cannot read properties of undefined" ⇒ doctor 崩掉、什么都报不出来。
    // 体检工具在配置坏了的时候**最不能崩**——那正是它该出结论的时刻。
    const bin = (e as { bin?: unknown } | undefined)?.bin;
    if (typeof bin !== "string" || bin === "") {
      findings.push({
        severity: "error",
        title: `executor "${name}" has no bin`,
        detail: `executors.${name}.bin is missing or not a string -> the agent cannot be spawned for dispatch.`,
        fix: `agent-ex config set executors.${name}.bin <absolute path>`,
      });
      emitted.add(emitKey("executor.bin", name));
      continue;
    }
    if (resolveBinPath(bin) === null) {
      findings.push({
        severity: "error",
        title: `executor "${name}" bin is unusable`,
        detail: `${bin} does not exist or is not executable`,
        // 定点修复：不是"跑 init 重配一遍"（那是重武器），而是改这一个字段。
        fix: `agent-ex config set executors.${name}.bin <absolute path>`,
      });
      emitted.add(emitKey("executor.bin", name));
    }
  }

  // ---- 6b. 兜底：把 validateConfig 的规则补进来 ----
  //
  // 上面几段是 doctor 自己的**具名**检查（文案更具体）；但它们覆盖不全——
  // 2026-10-23 实测两处假阴性：doctor 报"一切正常"、exit 0，而同一份配置
  // loadConfig 直接抛错、server 起不来（timeout_sec 是字符串、defaults 整块缺失）。
  // 规则只写一份（config.ts 的 collectConfigIssues），这里把**没被具名检查覆盖**的
  // 那些补成 error finding。
  for (const issue of collectConfigIssues(c)) {
    const key = emitKey(issue.code, issue.subject);
    if (emitted.has(key)) continue;
    emitted.add(key);
    findings.push({
      severity: "error",
      title: `Config problem: ${issue.message}`,
      detail: "This comes from the shared validation rules in config.ts (the same ones loadConfig throws on at startup) — the same config would keep the server from starting.",
      fix: issue.fix,
    });
  }

  // ---- 7. 历史失败证据（runner 日志）----
  // 注意 severity 是 **warn 而不是 error**：这是**过去**发生的失败，不是当前配置的问题。
  // 2026-10-13→10-15 的 23 个零通知正是"历史早已在日志里、但没人看"——
  // 若把它算成 error，doctor 会永远红着，而修好配置后它依然红着（历史不会消失），
  // 久而久之用户就学会无视 doctor 的报错 ⇒ 体检工具本身失效。
  // 它要表达的是"这里有线索"，而不是"现在坏了"。
  const stats = scanNotifyFailures(home);
  if (stats.logs_with_rejects > 0) {
    // 两个单位不能混着说：logs_with_rejects 是**受影响的任务数**（一个 runner 日志 = 一个任务），
    // by_code 里的数字是**拒收尝试次数**（每次失败重试 3 次都会各留一行）。
    const attempts = Object.values(stats.by_code).reduce((a, b) => a + b, 0);
    const parts = Object.entries(stats.by_code)
      .map(([code, n]) => `code=${code} ×${n} attempt(s)${FEISHU_ERRORS[code] ? ` (${FEISHU_ERRORS[code].meaning})` : ""}`)
      .join("; ");
    // 每个码的修法互斥（19024 改关键词、19001 必须换地址）⇒ 全部列出，
    // 只给"次数最多"的那个会把人引到无效动作上。
    const fixes = Object.keys(stats.by_code)
      .map((code) => FEISHU_ERRORS[code]?.fix)
      .filter((f): f is string => Boolean(f));
    findings.push({
      severity: "warn",
      title: `${stats.logs_with_rejects} task(s) had notifications rejected in the past (${attempts} attempt(s) total)`,
      detail: `${parts}. Most recent: ${stats.recent[0]?.task_id}.`,
      fix: fixes.length > 0 ? fixes.join("; ") : undefined,
    });
  }

  // ---- 8. 可选：实发一张自检卡 ----
  if (opts.send) {
    try {
      const url = resolveEnvPlaceholders({ url: c.notify.feishu_webhook_url }).url;
      // 探针卡必须与真实投递用**同一个词**：缺 keyword 时运行时填 BRAND（config.ts 的 ??=），
      // 这里若用原始的 undefined，卡片就不带关键词元素 → 明明能投递却报"被拒收"。
      const effectiveKeyword = c.notify.keyword ?? BRAND;
      // 正文刻意不含产品名：闸门匹配整卡，用真实报告当探针会假通过
      const card = buildFeishuCard("completed", "task_selfcheck", "self-check card: body contains no product name", effectiveKeyword);
      const res = await sendFeishuCard(url, card, { dryRun: false, fetchImpl: opts.fetchImpl, delays: opts.delays });
      if (res.ok) {
        findings.push({ severity: "ok", title: "Self-check card delivered", detail: "Feishu returned code=0" });
      } else {
        const known = res.code !== null ? FEISHU_ERRORS[String(res.code)] : undefined;
        findings.push({
          severity: "error",
          title: "Self-check card was rejected",
          // code 必须进结论：它是"改关键词"（19024）与"换地址"（19001）的唯一判据，
          // MCP 侧拿不到 stderr（MCP 侧此前只能看到一个布尔值）
          detail: `Feishu returned code=${res.code ?? "no response"} msg=${res.msg || "(empty)"}${known ? ` (${known.meaning})` : ""}.`,
          fix: known?.fix,
        });
      }
    } catch (e) {
      const msg = (e as Error).message;
      findings.push({
        severity: "error",
        title: "Failed to send the self-check card",
        detail: msg,
        // 别把人引到没坏的东西上：placeholder 报错是"变量没进进程环境"，不是"地址失效"
        fix: /env placeholder/.test(msg)
          ? `add the variable to ${join(home, ".env")} (or export it into the process env), then retry`
          : "check whether FEISHU_WEBHOOK_URL is valid",
      });
    }
  }

  const hasError = findings.some((f) => f.severity === "error");
  const summary = hasError
    ? `${findings.filter((f) => f.severity === "error").length} problem(s) found — the notification path is broken`
    : findings.some((f) => f.severity === "warn")
      ? "Config is usable, but one item needs attention"
      : "All good";
  return { ok: !hasError, summary, findings, notify_failures: stats };
}
