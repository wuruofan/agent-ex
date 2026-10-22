/**
 * init 覆盖既有 config 时的**变更预告**。
 *
 * 为什么要单独一个模块：init 是"从零生成"的全量覆盖式向导，而用户往往只是想改一个字段
 * （比如把 dry_run 从 true 改成 false）。实测拿一个 2-profile、dry_run=false、timeout=5400 的
 * config 跑一次 init，结果是：
 *   profiles  minimax-3, ds-v4  →  default      （丢了一个 profile）
 *   dry_run   false             →  true         （被重置回安全默认）
 *   timeout   5400              →  3600
 * 三个用户显式设过的值被静默重置，而当时的提示语只有一句
 * "config.json already exists. Overwrite? [N]" —— 用户答 y 之前并不知道自己要放弃什么。
 *
 * ⚠️ `.env` 不在风险范围内：writeEnvFile 是**增量合并**（只补/更新采集到的 key，
 * 保留其余），所以密钥不会因为重跑 init 而丢失。变的只有 config.json。
 */
import type { Config } from "./config.js";

export interface ConfigChange {
  /** 变更类别，决定提示语怎么写。 */
  kind: "profile" | "setting" | "notify" | "executor";
  /** 人类可读的字段名，如 "profiles.ds-v4"、"notify.dry_run"。 */
  field: string;
  before: string;
  after: string;
}

/** 只报告"有意义的"变化：等值不算变化。 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 对比旧 config 与候选新 config，列出**会被丢失或被改写**的项。
 *
 * 语义是"覆盖会造成什么后果"，不是"diff 是什么"——因此：
 *   - 旧 config 里存在、新 config 里没有的 profile / executor ⇒ 报 "removed"（真丢失）；
 *   - 两边都有但值不同的字段 ⇒ 报 "changed"（被改写）。
 * 只在旧 config 存在时有内容；首次 init 返回空数组。
 */
export function diffConfigs(oldCfg: Config | null, newCfg: Config): ConfigChange[] {
  const changes: ConfigChange[] = [];
  if (!oldCfg) return changes;

  // profile：丢失的与被改写的
  for (const [name, p] of Object.entries(oldCfg.profiles ?? {})) {
    if (!(name in newCfg.profiles)) {
      changes.push({ kind: "profile", field: `profiles.${name}`, before: describeProfile(p), after: "(removed)" });
    } else if (!same(p, newCfg.profiles[name])) {
      changes.push({
        kind: "profile",
        field: `profiles.${name}`,
        before: describeProfile(p),
        after: describeProfile(newCfg.profiles[name]),
      });
    }
  }
  // 新增的 profile 也报出来：用户可能以为是"只改开关"
  for (const name of Object.keys(newCfg.profiles ?? {})) {
    if (!(name in (oldCfg.profiles ?? {}))) {
      changes.push({ kind: "profile", field: `profiles.${name}`, before: "(absent)", after: describeProfile(newCfg.profiles[name]) });
    }
  }

  // executor：bin 路径变了（换了个 CLI 版本/路径）会影响所有指向它的 profile
  for (const [name, e] of Object.entries(oldCfg.executors ?? {})) {
    if (!(name in newCfg.executors)) {
      changes.push({ kind: "executor", field: `executors.${name}`, before: e.bin, after: "(removed)" });
    } else if (e.bin !== newCfg.executors[name].bin) {
      changes.push({ kind: "executor", field: `executors.${name}.bin`, before: e.bin, after: newCfg.executors[name].bin });
    }
  }

  // notify：dry_run 被重置是最常见也最隐蔽的（false → true 会让通知静默不再投递）
  if (oldCfg.notify?.dry_run !== newCfg.notify?.dry_run) {
    changes.push({
      kind: "notify",
      field: "notify.dry_run",
      before: String(oldCfg.notify?.dry_run),
      after: String(newCfg.notify?.dry_run),
    });
  }
  if ((oldCfg.notify?.keyword ?? "") !== (newCfg.notify?.keyword ?? "")) {
    changes.push({
      kind: "notify",
      field: "notify.keyword",
      before: oldCfg.notify?.keyword || "(unset)",
      after: newCfg.notify?.keyword || "(unset)",
    });
  }

  // defaults：默认 profile 指向被删掉的 profile 是"覆盖后任务直接失败"的典型原因
  if (oldCfg.defaults?.profile !== newCfg.defaults?.profile) {
    changes.push({
      kind: "setting",
      field: "defaults.profile",
      before: oldCfg.defaults?.profile ?? "(unset)",
      after: newCfg.defaults?.profile ?? "(unset)",
    });
  }
  if (oldCfg.defaults?.timeout_sec !== newCfg.defaults?.timeout_sec) {
    changes.push({
      kind: "setting",
      field: "defaults.timeout_sec",
      before: String(oldCfg.defaults?.timeout_sec),
      after: String(newCfg.defaults?.timeout_sec),
    });
  }
  return changes;
}

function describeProfile(p: { executor: string; env: Record<string, string> }): string {
  const model = p.env?.ANTHROPIC_MODEL ?? p.env?.OPENCODE_CONFIG_CONTENT ?? "";
  const modelPart = model ? `, model=${truncate(model, 40)}` : "";
  return `executor=${p.executor}${modelPart}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * 把变更列表渲染成给用户看的警告块。
 *
 * 措辞上刻意说明"这会怎样"而不只是"字段变了"——比如 dry_run 从 false 变 true，
 * 要让用户知道结果是"终态通知不再投递"，否则他可能以为那只是个无害的字段变化。
 */
export function renderChangeWarning(changes: ConfigChange[]): string {
  if (changes.length === 0) return "";
  const lines = [
    "",
    "⚠️  Re-running init REWRITES config.json. These settings will change:",
    "",
  ];
  const lost = changes.filter((c) => c.after === "(removed)");
  const changed = changes.filter((c) => c.after !== "(removed)");
  if (lost.length) {
    lines.push("  Removed (will be gone):");
    for (const c of lost) lines.push(`    ✗ ${c.field}  ${c.before}`);
    lines.push("");
  }
  if (changed.length) {
    lines.push("  Rewritten:");
    for (const c of changed) lines.push(`    · ${c.field}  ${c.before} → ${c.after}`);
    lines.push("");
  }
  // 逐项解释最容易被忽略的后果
  const notes: string[] = [];
  const dryRun = changed.find((c) => c.field === "notify.dry_run");
  if (dryRun && dryRun.before === "false" && dryRun.after === "true") {
    notes.push('  notify.dry_run false → true means terminal notifications will NOT be delivered.');
  }
  const dp = changed.find((c) => c.field === "defaults.profile");
  // 风险在**旧**默认 profile 被删：它可能同时是 defaults.profile 和别的 profile 的依赖。
  // （新默认 profile 是本次新建的，不会被删。）
  if (dp && lost.some((c) => c.field === `profiles.${dp.before}`)) {
    notes.push(`  defaults.profile "${dp.before}" is being removed — tasks would fail with "unknown profile".`);
  }
  if (lost.length) {
    notes.push("  (config.json.bak will be kept; .env is merged, not replaced, so your keys survive.)");
  }
  if (notes.length) {
    lines.push(...notes);
    lines.push("");
  }
  return lines.join("\n");
}
