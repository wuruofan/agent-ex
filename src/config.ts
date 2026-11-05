import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { agentExHome, ensureRuntimeDirs } from "./paths.js";

export interface ExecutorConfig {
  bin: string;
  extra_flags?: string[];
}
export interface ProfileConfig {
  executor: string;
  env: Record<string, string>;
}
export interface Config {
  executors: Record<string, ExecutorConfig>;
  profiles: Record<string, ProfileConfig>;
  /** keyword 读入后一定已归一化（缺省填 BRAND），下游不再需要判空 */
  notify: { feishu_webhook_url: string; dry_run?: boolean; keyword: string };
  defaults: { profile: string; timeout_sec: number };
}

/**
 * 将 "{env:VAR_NAME}" 占位符替换为运行时环境变量；缺失则抛错（避免明文密钥落盘）。
 * 真实写法与 spec 草稿略有不同——见 plan §Task 2 Step 3 末尾的修正指引。
 */
export function resolveEnvPlaceholders(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^\{env:([A-Z0-9_]+)\}$/.exec(v);
    if (m) {
      const val = process.env[m[1]];
      if (!val) throw new Error(`env placeholder {env:${m[1]}} not found in process environment`);
      out[k] = val;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(home?: string): Config {
  ensureRuntimeDirs();
  const cfgPath = join(home ?? agentExHome(), "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Config;
  // 归一化（不是校验）：keyword 缺省时补 BRAND，让下游不必判空。
  // ⚠️ 必须留在 loadConfig、不能进 collectConfigIssues：一旦在这里把缺省填进去，
  // doctor 就再也看不到"字段缺失"这个态（永远等于 BRAND），info 档会消失。
  // notify 整块缺失时也不能在这里炸——那是 collectConfigIssues 该报的 issue。
  if (cfg.notify && typeof cfg.notify === "object") {
    cfg.notify.keyword ??= BRAND;
  }
  validate(cfg);
  return cfg;
}

/**
 * 校验一份 config（**不读盘**）。
 *
 * 单独导出是为了让 `init` 能在**写盘前**校验内存里的候选配置：原先 init 是先写盘再校验，
 * 校验失败时坏 config 已落盘、旧 config 已被覆盖且无法恢复（实测：bin 路径不存在时报
 * "config written but self-check failed" 并 exit 1，用户手里只剩一个坏文件）。
 */
export function validateConfig(cfg: Config): void {
  validate(cfg);
}

/** config 的问题分类。doctor 靠它决定"这条要不要再报一遍"。 */
export type ConfigIssueCode =
  | "executors.empty"
  | "profiles.empty"
  | "executor.bin"
  | "profile.executor"
  | "defaults.profile"
  | "notify.webhook"
  | "defaults.timeout_sec";

export interface ConfigIssue {
  code: ConfigIssueCode;
  /** 与 validate() 抛出的文案一致（第一条即抛出的那条）。 */
  message: string;
  /** 可复制执行的修复命令——没有它，标红的 finding 用户也无从下手。 */
  fix?: string;
  /**
   * 问题的主体（executor 名 / profile 名）。
   *
   * doctor 用它做去重：`executor.bin` 这类 code 会有多个实例，按 code 整体跳过
   * 会把"另一个 executor 也有问题"一起吞掉。去重键 = code + subject。
   */
  subject?: string;
}

/** 把任意值当成对象看待（非对象一律当作空对象）。 */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 收集一份 config 的**全部**问题（total：吃未校验的原始 JSON，绝不抛错）。
 *
 * 为什么要有它：doctor 原本手写 4 类检查、这里手写 8 条规则，两份各写各的 ⇒
 * 2026-10-23 实测两处**假阴性**：doctor 报"一切正常"、exit 0，而同一份配置
 * `loadConfig` 直接抛错、server 起不来：
 *   - `defaults.timeout_sec: "3600"`（doctor 只看 dry_run/keyword/webhook/defaults.profile）；
 *   - `defaults: {}`（doctor 的检查是 `if (defProfile && …)`，字段缺失就不触发）。
 * 体检工具在用户最需要它的时刻说"一切正常"，比不体检更糟。
 *
 * 所以规则只写这一份，doctor 消费它。签名收 `unknown`：doctor 读的是磁盘上的
 * 原始 JSON，defaults/notify 可能整块缺失，函数不能假设已通过校验。
 */
export function collectConfigIssues(cfg: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const c = asRecord(cfg);
  const executors = asRecord(c.executors);
  const profiles = asRecord(c.profiles);

  if (Object.keys(executors).length === 0) {
    issues.push({
      code: "executors.empty",
      message: "config.executors is empty",
      fix: "agent-ex init (rebuilds the config; the broken file is backed up first)",
    });
  }
  if (Object.keys(profiles).length === 0) {
    issues.push({
      code: "profiles.empty",
      message: "config.profiles is empty",
      fix: "agent-ex init (rebuilds the config; the broken file is backed up first)",
    });
  }
  for (const [name, raw] of Object.entries(executors)) {
    const bin = asRecord(raw).bin;
    if (typeof bin !== "string" || bin === "") {
      issues.push({
        code: "executor.bin",
        message: `executor "${name}" missing "bin"`,
        fix: `agent-ex config set executors.${name}.bin <path>`,
        subject: name,
      });
    } else if (!binIsExecutable(bin)) {
      issues.push({
        code: "executor.bin",
        message: `executor "${name}" bin "${bin}" not found or not executable`,
        fix: `agent-ex config set executors.${name}.bin <path>`,
        subject: name,
      });
    }
  }
  for (const [name, raw] of Object.entries(profiles)) {
    const exec = asRecord(raw).executor;
    if (typeof exec !== "string" || !executors[exec]) {
      issues.push({
        code: "profile.executor",
        message: `profile "${name}" references unknown executor "${exec}"`,
        fix: `agent-ex config set profiles.${name}.executor <existing executor>`,
        subject: name,
      });
    }
  }
  const defaults = asRecord(c.defaults);
  const defProfile = defaults.profile;
  if (typeof defProfile !== "string" || defProfile === "" || !profiles[defProfile]) {
    issues.push({
      code: "defaults.profile",
      message: `defaults.profile "${defProfile}" not found in profiles`,
      fix: "agent-ex profile use <existing profile>",
      subject: String(defProfile),
    });
  }
  const notify = asRecord(c.notify);
  if (typeof notify.feishu_webhook_url !== "string" || notify.feishu_webhook_url === "") {
    issues.push({
      code: "notify.webhook",
      message: "notify.feishu_webhook_url is required",
      fix: "agent-ex init (rebuilds the config; the broken file is backed up first)",
    });
  }
  // dry_run 缺省 = true（只打印到 stderr 不真发），调试期默认安全；想真发改 false
  const timeout = defaults.timeout_sec;
  if (!Number.isInteger(timeout) || (timeout as number) <= 0) {
    issues.push({
      code: "defaults.timeout_sec",
      message: "defaults.timeout_sec must be a positive integer",
      fix: "agent-ex config set defaults.timeout_sec 5400",
    });
  }
  return issues;
}

function validate(cfg: Config): void {
  const issues = collectConfigIssues(cfg);
  if (issues.length > 0) throw new Error(issues[0].message);
}

/**
 * 把 bin 解析成绝对路径：
 * - 含分隔符（绝对/相对路径）→ 直接校验 existence + X_OK；
 * - 裸命令名 → 按 PATH 查找（Node 无内置 PATH 解析，按 ":" 分隔实现）。
 * 返回 null 表示找不到。validate() 与 buildAgentEnv() 共用，保证
 * 「启动期校验」与「运行时 PATH」一致（否则裸名能在校验期通过、运行时 ENOENT）。
 */
export function resolveBinPath(bin: string): string | null {
  if (bin.includes("/")) {
    try { accessSync(bin, constants.X_OK); return bin; } catch { return null; }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 校验 bin 是否可解析且可执行：直接复用 resolveBinPath。 */
function binIsExecutable(bin: string): boolean {
  return resolveBinPath(bin) !== null;
}
