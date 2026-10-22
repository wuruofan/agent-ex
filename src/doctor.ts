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
import { resolveEnvPlaceholders, resolveBinPath, validateConfig, type Config } from "./config.js";
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
  "19024": { meaning: "关键词校验失败（卡片不含机器人登记的关键词）", fix: "让 config 的 notify.keyword 与机器人「安全设置 → 自定义关键词」一致" },
  "19021": { meaning: "签名校验失败（机器人勾了「加签」，而本工具不发送 timestamp/sign）", fix: "在机器人安全设置里取消勾选「加签」" },
  "19022": { meaning: "IP 校验失败（机器人勾了「IP 白名单」）", fix: "取消勾选 IP 白名单，或把出口 IP 加进白名单" },
  "19001": { meaning: "webhook token 无效（地址失效：机器人被删/重建/地址轮换）", fix: "去机器人后台重新复制 webhook 地址，更新 .env 里的 FEISHU_WEBHOOK_URL" },
  "9499": { meaning: "请求体格式错误", fix: "检查卡片 JSON 是否超 20 KB" },
  "11232": { meaning: "触发限流", fix: "避开密集派发（单机器人 100 次/分、5 次/秒）" },
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
  if (!existsSync(p)) return { cfg: null, error: "config.json 不存在" };
  try {
    return { cfg: JSON.parse(readFileSync(p, "utf8")) as Config, error: null };
  } catch (e) {
    return { cfg: null, error: `config.json 解析失败：${(e as Error).message}` };
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
  if (!c) return { applied, skipped: ["config.json 不可用，未做任何修改"], notes };

  let changed = false;

  // keyword：只修"客观上错了"的两种——显式空串、可证明的改名遗留。
  // 缺失与自定义值一律不动（理由见上方注释）。
  const kw = c.notify?.keyword;
  const kwState = classifyKeyword(kw);
  if (kwState === "empty" || kwState === "stale") {
    const before = kw === undefined ? "(unset)" : JSON.stringify(kw);
    c.notify.keyword = BRAND;
    changed = true;
    applied.push(`notify.keyword: ${before} → ${BRAND}`);
    if (kwState === "stale") {
      notes.push(`若你的机器人登记的关键词就是旧名 "${kw}"，请改回去：agent-ex config set notify.keyword "${kw}"`);
    }
  }

  // 明文 webhook → 挪进 .env
  const url = c.notify?.feishu_webhook_url ?? "";
  if (url && !/^\{env:[A-Z0-9_]+\}$/.test(url) && /^https:\/\//.test(url)) {
    const envPath = join(home, ".env");
    let envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    if (!/^FEISHU_WEBHOOK_URL=/m.test(envText)) {
      envText = (envText ? envText.replace(/\n*$/, "\n") : "") + `FEISHU_WEBHOOK_URL=${url}\n`;
      writeFileSync(envPath, envText, { mode: 0o600 });
      // mode 只在**创建**文件时生效；.env 在 init 之后几乎总是已存在（沿用旧权限），
      // 必须显式 chmod，否则凭证从 644 的 config.json 挪进 644 的 .env，防护强度没变
      // （与 init.ts 的 writeEnvFile 同一写法）。
      chmodSync(envPath, 0o600);
      c.notify.feishu_webhook_url = "{env:FEISHU_WEBHOOK_URL}";
      changed = true;
      applied.push("notify.feishu_webhook_url: 明文 → {env:FEISHU_WEBHOOK_URL}（原值已写入 .env，权限 600）");
    } else {
      skipped.push(".env 里已有 FEISHU_WEBHOOK_URL，未覆盖（请手工核对是否与 config 一致）");
    }
  }

  if (changed) {
    validateConfig(c);
    writeFileSync(join(home, "config.json"), JSON.stringify(c, null, 2) + "\n");
  }
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
      title: "config.json 不可用",
      detail: error,
      fix: "agent-ex init 重建（会先备份坏文件）",
    });
    return { ok: false, summary: "config.json 不可用，无法体检其余项", findings };
  }
  const c = cfg!;

  // ---- 2. dry_run：最常见的原因，但不是缺陷，所以是 warn 不是 error ----
  const dryRun = c.notify?.dry_run ?? true;
  if (dryRun) {
    findings.push({
      severity: "warn",
      title: "通知处于 dry-run，不会真的投递",
      detail: "notify.dry_run = true ⇒ 终态卡片只打到 stderr，群里收不到。",
      fix: "agent-ex config set notify.dry_run false",
    });
  } else {
    findings.push({ severity: "ok", title: "通知处于真实投递模式", detail: "notify.dry_run = false" });
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
      title: "关键词被显式设为空",
      detail: "notify.keyword = \"\" ⇒ 卡片里不会有关键词元素（notifier.ts 的 if (keyword)）⇒ 只要机器人开了「自定义关键词」闸门就必然被拒收（19024）。",
      fix: `agent-ex config set notify.keyword ${BRAND}`,
      fixable: true,
    });
  } else if (kwState === "unset") {
    findings.push({
      severity: "info",
      title: "关键词未显式配置（运行时用产品名兜底）",
      detail: `notify.keyword 未设置 ⇒ 运行时会填 "${BRAND}"（config.ts 的 ??= BRAND，产品改名时自动跟随），卡片是带关键词元素的。若机器人在「安全设置 → 自定义关键词」登记的不是这个词，请显式设置。`,
    });
  } else if (kwState === "stale") {
    findings.push({
      severity: "error",
      title: "关键词是改名前的旧产品名",
      detail: `notify.keyword = "${keyword}"，这是本工具改名前用过的名字（现名 "${BRAND}"）。若机器人登记的是 "${BRAND}"，卡片会被拒收（19024）——2026-10-13→10-15 的 23 个任务零通知就是这个状态造成的。`,
      fix: `agent-ex config set notify.keyword ${BRAND}`,
      fixable: true,
    });
  } else if (kwState === "custom") {
    findings.push({
      severity: "warn",
      title: "关键词是自定义值（不替你决定，但要对齐机器人侧）",
      detail: `notify.keyword = "${keyword}"，与产品名 "${BRAND}" 不同。**若机器人登记的就是 "${keyword}"，这是对的，请忽略本条**；若登记的是 "${BRAND}"，卡片会被拒收（19024）。`,
      fix: "agent-ex doctor --send（自检卡能直接判定登记词是否匹配）",
    });
  } else {
    findings.push({
      severity: "ok",
      title: "关键词与产品名一致",
      detail: `notify.keyword = "${keyword}"。是否与机器人登记词一致，只有自检卡能验证：agent-ex doctor --send`,
    });
  }

  // ---- 4. webhook 是否配了 ----
  const webhookPlaceholder = c.notify?.feishu_webhook_url ?? "";
  const isPlaceholder = /^\{env:[A-Z0-9_]+\}$/.test(webhookPlaceholder);
  if (!webhookPlaceholder) {
    findings.push({ severity: "error", title: "未配置 webhook 地址", detail: "notify.feishu_webhook_url 为空" });
  } else if (!isPlaceholder) {
    // 明文凭证落在 config.json 里：config 会被提交/同步/贴到 issue 时就泄露了
    findings.push({
      severity: "error",
      title: "webhook 以明文存在 config.json（凭证泄露风险）",
      detail: "notify.feishu_webhook_url 不是 {env:VAR} 占位符。config.json 可能被提交或同步，webhook 地址本身就是凭证。",
      fix: "把地址挪进 .env，config 里改成 {env:FEISHU_WEBHOOK_URL}",
      fixable: true,
    });
  } else {
    const varName = /^\{env:([A-Z0-9_]+)\}$/.exec(webhookPlaceholder)![1];
    const envFile = join(home, ".env");
    const hasInEnv = existsSync(envFile) && new RegExp(`^${varName}=.+$`, "m").test(readFileSync(envFile, "utf8"));
    const hasInProcess = Boolean(process.env[varName]);
    if (hasInEnv || hasInProcess) {
      findings.push({ severity: "ok", title: "webhook 地址已配置", detail: `${varName} 在 ${hasInEnv ? ".env" : "进程环境"}里` });
    } else {
      findings.push({
        severity: "error",
        title: "webhook 地址未设置",
        detail: `${varName} 既不在 .env 也不在进程环境 ⇒ 真实发送时会抛 "env placeholder not found"。`,
        fix: `在 ${join(home, ".env")} 里加 ${varName}=<webhook 地址>`,
      });
    }
  }

  // ---- 5. 默认 profile 指向 ----
  const defProfile = c.defaults?.profile;
  if (defProfile && !c.profiles?.[defProfile]) {
    findings.push({
      severity: "error",
      title: "默认 profile 不存在",
      detail: `defaults.profile = "${defProfile}"，但 profiles 里没有它 ⇒ 每次派发都会失败（unknown profile）。`,
      fix: `agent-ex config use <存在的 profile>`,
      fixable: true,
    });
  }

  // ---- 6. executor 的 bin 是否可执行 ----
  for (const [name, e] of Object.entries(c.executors ?? {})) {
    if (resolveBinPath(e.bin) === null) {
      findings.push({
        severity: "error",
        title: `executor "${name}" 的 bin 不可用`,
        detail: `${e.bin} 不存在或不可执行`,
        fix: "agent-ex init 重新配置该 executor 的路径",
      });
    }
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
      .map(([code, n]) => `code=${code} ×${n} 次${FEISHU_ERRORS[code] ? `（${FEISHU_ERRORS[code].meaning}）` : ""}`)
      .join("，");
    // 每个码的修法互斥（19024 改关键词、19001 必须换地址）⇒ 全部列出，
    // 只给"次数最多"的那个会把人引到无效动作上。
    const fixes = Object.keys(stats.by_code)
      .map((code) => FEISHU_ERRORS[code]?.fix)
      .filter((f): f is string => Boolean(f));
    findings.push({
      severity: "warn",
      title: `历史上有 ${stats.logs_with_rejects} 个任务的通知被拒收（累计 ${attempts} 次尝试）`,
      detail: `${parts}。最近一次：${stats.recent[0]?.task_id}。`,
      fix: fixes.length > 0 ? fixes.join("；") : undefined,
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
      const card = buildFeishuCard("completed", "task_selfcheck", "自检卡片：正文不含产品名", effectiveKeyword);
      const res = await sendFeishuCard(url, card, { dryRun: false, fetchImpl: opts.fetchImpl, delays: opts.delays });
      if (res.ok) {
        findings.push({ severity: "ok", title: "自检卡已投递", detail: "飞书返回 code=0" });
      } else {
        const known = res.code !== null ? FEISHU_ERRORS[String(res.code)] : undefined;
        findings.push({
          severity: "error",
          title: "自检卡被拒收",
          // code 必须进结论：它是"改关键词"（19024）与"换地址"（19001）的唯一判据，
          // MCP 侧拿不到 stderr（MCP 侧此前只能看到一个布尔值）
          detail: `飞书返回 code=${res.code ?? "无响应"} msg=${res.msg || "(空)"}${known ? `（${known.meaning}）` : ""}。`,
          fix: known?.fix,
        });
      }
    } catch (e) {
      const msg = (e as Error).message;
      findings.push({
        severity: "error",
        title: "自检卡发送失败",
        detail: msg,
        // 别把人引到没坏的东西上：placeholder 报错是"变量没进进程环境"，不是"地址失效"
        fix: /env placeholder/.test(msg)
          ? `把该变量写进 ${join(home, ".env")}（或 export 到进程环境）后重试`
          : "检查 FEISHU_WEBHOOK_URL 是否有效",
      });
    }
  }

  const hasError = findings.some((f) => f.severity === "error");
  const summary = hasError
    ? `发现 ${findings.filter((f) => f.severity === "error").length} 个问题，通知链路不通`
    : findings.some((f) => f.severity === "warn")
      ? "配置基本可用，但有一项需要注意"
      : "一切正常";
  return { ok: !hasError, summary, findings, notify_failures: stats };
}
