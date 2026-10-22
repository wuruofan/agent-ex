/**
 * `agent-ex config` —— 改配置（list / use / set）。
 *
 * 为什么要有它：init 是**全量覆盖式**的"首次安装向导"，重跑一次会把旧 profile、
 * dry_run、timeout 全刷掉（2026-10-16 实测：2 个 profile 掉到 1 个，dry_run 从 false 被打回 true）。
 * 所以"只改一个字段"这件事**不能**用 init 干——这正是 2026-10-13→10-15 零通知的土壤：
 * 没人敢重跑 init 去改 dry_run，于是它一直停在 true。
 *
 * config set 刻意只接受**白名单字段**：任意点路径写入意味着一次手抖就能写出
 * 语法错误或语义错误的 config，而这类错误往往到派发任务时才暴露。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentExHome } from "./paths.js";
import { BRAND } from "./brand.js";
import { validateConfig, resolveBinPath, type Config } from "./config.js";
import { ZEN_FREE_PLACEHOLDER } from "./zen-free.js";

/** 可写的字段白名单：key → 类型 + 说明。 */
export const WRITABLE: Record<string, { type: "boolean" | "string" | "integer"; desc: string }> = {
  "notify.dry_run": { type: "boolean", desc: "false = 真实投递飞书；true = 只打 stderr" },
  "notify.keyword": { type: "string", desc: "飞书「自定义关键词」闸门；须与机器人侧登记的一致" },
  "defaults.profile": { type: "string", desc: "默认 profile 名" },
  "defaults.timeout_sec": { type: "integer", desc: "每轮超时秒数" },
};

export interface ConfigListResult {
  profiles: Array<{ name: string; executor: string; model: string; is_default: boolean; env: string[] }>;
  executors: Array<{ name: string; bin: string; bin_ok: boolean }>;
  notify: { dry_run: boolean; keyword: string; webhook: string };
  defaults: { profile: string; timeout_sec: number };
}

export function configPath(home: string = agentExHome()): string {
  return join(home, "config.json");
}

export function readConfig(home: string = agentExHome()): Config {
  const p = configPath(home);
  if (!existsSync(p)) throw new Error(`config.json not found at ${p} — run "agent-ex init" first`);
  return JSON.parse(readFileSync(p, "utf8")) as Config;
}

/** 写 config（先校验再写，不留坏文件）。 */
export function writeConfig(home: string, cfg: Config): void {
  validateConfig(cfg);
  writeFileSync(configPath(home), JSON.stringify(cfg, null, 2) + "\n");
}

/** 列出当前配置概览。 */
export function listConfig(home: string = agentExHome()): ConfigListResult {
  const c = readConfig(home);
  return {
    profiles: Object.entries(c.profiles ?? {}).map(([name, p]) => ({
      name,
      executor: p.executor,
      model: p.env?.ANTHROPIC_MODEL ?? p.env?.OPENCODE_CONFIG_CONTENT ?? "",
      is_default: c.defaults?.profile === name,
      // 只列环境变量**名字**（不列值）：值可能是大段配置内容，名字才回答
      // "这个 profile 会注入哪些变量"（如内置 profile 的 ZEN_FREE_PREFER）
      env: Object.keys(p.env ?? {}),
    })),
    // bin_ok 必须是真的探测结果：恒为 true 的字段是在骗人
    // （与 doctor 的 resolveBinPath 判定同源，见 config.ts）
    executors: Object.entries(c.executors ?? {}).map(([name, e]) => ({
      name,
      bin: e.bin,
      bin_ok: resolveBinPath(e.bin) !== null,
    })),
    notify: {
      dry_run: c.notify?.dry_run ?? true,
      keyword: c.notify?.keyword ?? BRAND,
      webhook: c.notify?.feishu_webhook_url ?? "",
    },
    defaults: { profile: c.defaults?.profile ?? "", timeout_sec: c.defaults?.timeout_sec ?? 0 },
  };
}

/**
 * 设置单个白名单字段。
 *
 * 返回新值；非法值抛错（不写盘）。
 */
export function setConfigValue(home: string, key: string, rawValue: string): { key: string; value: unknown } {
  const spec = WRITABLE[key];
  if (!spec) {
    throw new Error(`unknown key "${key}" — writable keys: ${Object.keys(WRITABLE).join(", ")}`);
  }
  const c = readConfig(home);
  let value: unknown;
  if (spec.type === "boolean") {
    const v = rawValue.trim().toLowerCase();
    if (v !== "true" && v !== "false") throw new Error(`"${key}" expects true|false, got "${rawValue}"`);
    value = v === "true";
  } else if (spec.type === "integer") {
    const n = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`"${key}" expects a positive integer, got "${rawValue}"`);
    value = n;
  } else {
    value = rawValue.trim();
    // 非空校验：空串不是"没填"，而是一个能造出必然失败的配置态——
    // notify.keyword = "" 会让卡片不带关键词元素 ⇒ 飞书必然拒收（19024）。
    // 空白字符同理（写进去等于把闸门关死）。
    if (value === "") {
      throw new Error(
        key === "notify.keyword"
          ? `"${key}" expects a non-empty string — 空串会让卡片不带关键词，飞书必然拒收（19024）`
          : `"${key}" expects a non-empty string, got ""`,
      );
    }
  }
  // 按 key 前缀写回（只允许已知的两段路径）
  const [group, field] = key.split(".");
  if (group === "notify") c.notify[field as "dry_run"] = value as never;
  else if (group === "defaults") c.defaults[field as "profile"] = value as never;
  else throw new Error(`unknown config group "${group}"`);
  writeConfig(home, c);
  return { key, value };
}

/** 已知的内置 profile 名（用于 "config use <name>" 时自动创建）。 */
export const BUILTIN_PROFILES: Record<string, { executor: string; env: Record<string, string>; desc: string }> = {
  "opencode-zen-free": {
    executor: "opencode",
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: ZEN_FREE_PLACEHOLDER, small_model: ZEN_FREE_PLACEHOLDER }),
      // 偏好"家族前缀"（软口味）：命中的 free 模型优先，取不到就退化为不挑食，绝不因此失败。
      // 空 = 不挑食（选稳定排序的第一个）。用户可改 config.json 里的这一行。
      ZEN_FREE_PREFER: "mimo,nemotron,ling",
    },
    desc: "opencode zen 免费模型（零密钥，模型集会轮换，spawn 时动态解析）",
  },
};

export interface UseProfileResult {
  profile: string;
  created: boolean;
  desc: string;
}

/**
 * 切换默认 profile。
 *
 * profile 不存在时，若命中内置名（如 opencode-zen-free）就**自动创建**：
 * 免去手写 profile env 的样板。executor 不存在时一并注册（bin 走 PATH 探测）。
 */
export function useProfile(home: string, name: string, opts: { bin?: string } = {}): UseProfileResult {
  const c = readConfig(home);
  let created = false;
  let desc = "";
  if (!c.profiles[name]) {
    const builtin = BUILTIN_PROFILES[name];
    if (!builtin) {
      throw new Error(
        `unknown profile "${name}" — existing: ${Object.keys(c.profiles ?? {}).join(", ") || "(none)"}; ` +
        `built-in: ${Object.keys(BUILTIN_PROFILES).join(", ")}`,
      );
    }
    if (!c.executors[builtin.executor]) {
      const bin = opts.bin ?? builtin.executor;
      c.executors[builtin.executor] = { bin, extra_flags: builtin.executor === "opencode" ? ["--auto"] : [] };
    }
    c.profiles[name] = { executor: builtin.executor, env: builtin.env };
    created = true;
    desc = builtin.desc;
  }
  c.defaults.profile = name;
  writeConfig(home, c);
  return { profile: name, created, desc };
}
