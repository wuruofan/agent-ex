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
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
 *   - notify.keyword 缺失 → 写 BRAND（缺省由代码派生，唯一的真相源）；
 *   - notify.keyword 是陈旧品牌名（≠ BRAND）→ 改回 BRAND（机器人登记的词改了名，这是遗留）；
 *   - 明文 webhook 落在 config.json → 挪进 .env、config 留占位符（凭证卫生）。
 */
export interface FixResult {
  applied: string[];
  skipped: string[];
}

export function applyFixes(home: string, report: DoctorReport): FixResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  const c = readConfigLoose(home).cfg;
  if (!c) return { applied, skipped: ["config.json 不可用，未做任何修改"] };

  let changed = false;

  // keyword 缺失或陈旧 → 改回 BRAND
  const kw = c.notify?.keyword;
  if (!kw || kw !== BRAND) {
    const before = kw ?? "(unset)";
    c.notify.keyword = BRAND;
    changed = true;
    applied.push(`notify.keyword: ${before} → ${BRAND}`);
  }

  // 明文 webhook → 挪进 .env
  const url = c.notify?.feishu_webhook_url ?? "";
  if (url && !/^\{env:[A-Z0-9_]+\}$/.test(url) && /^https:\/\//.test(url)) {
    const envPath = join(home, ".env");
    let envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    if (!/^FEISHU_WEBHOOK_URL=/m.test(envText)) {
      envText = (envText ? envText.replace(/\n*$/, "\n") : "") + `FEISHU_WEBHOOK_URL=${url}\n`;
      writeFileSync(envPath, envText, { mode: 0o600 });
      c.notify.feishu_webhook_url = "{env:FEISHU_WEBHOOK_URL}";
      changed = true;
      applied.push("notify.feishu_webhook_url: 明文 → {env:FEISHU_WEBHOOK_URL}（原值已写入 .env）");
    } else {
      skipped.push(".env 里已有 FEISHU_WEBHOOK_URL，未覆盖（请手工核对是否与 config 一致）");
    }
  }

  if (changed) {
    validateConfig(c);
    writeFileSync(join(home, "config.json"), JSON.stringify(c, null, 2) + "\n");
  }
  return { applied, skipped };
}

export async function doctor(opts: { home?: string; send?: boolean } = {}): Promise<DoctorReport> {
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
  const keyword = c.notify?.keyword;
  if (!keyword) {
    findings.push({
      severity: "error",
      title: "未配置关键词",
      detail: "notify.keyword 缺失 ⇒ 飞书「自定义关键词」闸门必然拒收。",
      fix: `agent-ex config set notify.keyword ${BRAND}`,
      fixable: true,
    });
  } else if (keyword !== BRAND) {
    // 陈旧品牌名：这是 2026-10-13→10-15 零通知的根因（live config 一直留着旧名 agent-flow-ex）
    findings.push({
      severity: "error",
      title: "关键词与当前产品名不一致",
      detail: `notify.keyword = "${keyword}"，而产品名是 "${BRAND}"。飞书按整卡子串匹配，若机器人登记的是 "${BRAND}"，卡片会被拒收（19024）。`,
      fix: `agent-ex config set notify.keyword ${BRAND}`,
      fixable: true,
    });
  } else {
    findings.push({ severity: "ok", title: "关键词与产品名一致", detail: `notify.keyword = "${keyword}"` });
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
    const parts = Object.entries(stats.by_code)
      .map(([code, n]) => `code=${code} ×${n}${FEISHU_ERRORS[code] ? `（${FEISHU_ERRORS[code].meaning}）` : ""}`)
      .join("，");
    const worst = Object.entries(stats.by_code).sort((a, b) => b[1] - a[1])[0][0];
    findings.push({
      severity: "warn",
      title: `历史上有 ${stats.logs_with_rejects} 个任务的通知被拒收`,
      detail: `${parts}。最近一次：${stats.recent[0]?.task_id}。`,
      fix: FEISHU_ERRORS[worst]?.fix,
    });
  }

  // ---- 8. 可选：实发一张自检卡 ----
  if (opts.send) {
    try {
      const url = resolveEnvPlaceholders({ url: c.notify.feishu_webhook_url }).url;
      // 正文刻意不含产品名：闸门匹配整卡，用真实报告当探针会假通过
      const card = buildFeishuCard("completed", "task_selfcheck", "自检卡片：正文不含产品名", c.notify.keyword);
      const sent = await sendFeishuCard(url, card, { dryRun: false });
      if (sent) {
        findings.push({ severity: "ok", title: "自检卡已投递", detail: "飞书返回 code=0" });
      } else {
        findings.push({
          severity: "error",
          title: "自检卡被拒收",
          detail: "飞书返回非 0 code，详见 stderr 里的 [notifier] feishu rejected 行。",
        });
      }
    } catch (e) {
      findings.push({
        severity: "error",
        title: "自检卡发送失败",
        detail: (e as Error).message,
        fix: "检查 FEISHU_WEBHOOK_URL 是否有效",
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
