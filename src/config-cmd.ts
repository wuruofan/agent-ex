/**
 * `agent-ex config` / `agent-ex profile` —— 改配置。
 *
 * 为什么要有它：init 是**全量覆盖式**的"首次安装向导"，重跑一次会把旧 profile、
 * dry_run、timeout 全刷掉（2026-10-16 实测：2 个 profile 掉到 1 个，dry_run 从 false 被打回 true）。
 * 所以"只改一个字段"这件事**不能**用 init 干——这正是 2026-10-13→10-15 零通知的土壤：
 * 没人敢重跑 init 去改 dry_run，于是它一直停在 true。
 *
 * ⚠️ 写入口刻意只接受**白名单**（D5/D10）：
 *  - 固定键：`notify.dry_run` / `notify.keyword` / `defaults.timeout_sec`；
 *  - 模式键：`executors.<name>.bin`（<name> 必须已存在、值必须可执行）。
 * 任意点路径写入意味着一次手抖就能写出语法错误或语义错误的 config，
 * 而这类错误往往到派发任务时才暴露。
 *
 * `defaults.profile` **不在**白名单里：切默认只走 `profile use`。
 * 两个入口并存本身就是概念重复（谁都不知道该用哪个）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentExHome } from "./paths.js";
import { BRAND } from "./brand.js";
import { validateConfig, resolveBinPath, type Config } from "./config.js";
import { ZEN_FREE_PLACEHOLDER } from "./zen-free.js";

/** 可写的固定字段白名单：key → 类型 + 说明。 */
export const WRITABLE: Record<string, { type: "boolean" | "string" | "integer"; desc: string }> = {
  "notify.dry_run": { type: "boolean", desc: "false = 真实投递飞书；true = 只打 stderr" },
  "notify.keyword": { type: "string", desc: "飞书「自定义关键词」闸门；须与机器人侧登记的一致" },
  "defaults.timeout_sec": { type: "integer", desc: "每轮超时秒数" },
};

/**
 * 模式键：`executors.<name>.bin` —— 定点修复"bin 不可用"这个**阻断点**。
 *
 * 为什么必须有它（2026-10-23 实测）：坏 bin 会让 `validateConfig` 整份失败 ⇒
 * `doctor --fix` 修不了别的、`config set` 改任何字段都被挡（且报的是无关字段的错），
 * 而白名单里没有定点入口 ⇒ 用户唯一的出路是跑全量 `init`（对窄问题是重武器）。
 *
 * 两条约束：`<name>` 必须**已存在**（不静默创建 executor），
 * 值必须能通过 `resolveBinPath`（写一个不可执行的路径正是在重犯要修的错）。
 */
const EXECUTOR_BIN_KEY = /^executors\.([^.]+)\.bin$/;

/** profile 的 env key 规则：大写字母开头，只含大写字母/数字/下划线。 */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * 禁止写入 profile env 的 key —— 它们是 worker 进程的**启动/加载面**：
 *  - `NODE_OPTIONS`：等价于任意代码执行（`--require=/path/to/evil.js`）；
 *  - `PATH`：换掉解释器与子命令的查找范围；
 *  - `LD_*` / `DYLD_*`：动态链接器的加载路径。
 * 这些不该由"改一个环境变量"的命令来写。
 */
const FORBIDDEN_ENV_KEYS = new Set(["NODE_OPTIONS", "PATH"]);
const FORBIDDEN_ENV_PREFIXES = ["LD_", "DYLD_"];

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
  const c = readConfig(home);

  // ---- 模式键：executors.<name>.bin ----
  const m = EXECUTOR_BIN_KEY.exec(key);
  if (m) {
    const name = m[1];
    if (!c.executors?.[name]) {
      throw new Error(
        `unknown executor "${name}" — existing: ${Object.keys(c.executors ?? {}).join(", ") || "(none)"}；` +
        `executor 不存在时不能用这条命令建（请先 agent-ex profile create <builtin>）`,
      );
    }
    const value = rawValue.trim();
    if (value === "") throw new Error(`"${key}" expects a non-empty path, got ""`);
    if (resolveBinPath(value) === null) {
      throw new Error(`"${key}" expects an executable path (absolute path or a command on PATH), got "${rawValue}"`);
    }
    c.executors[name].bin = value;
    writeConfig(home, c);
    return { key, value };
  }

  // ---- 固定键 ----
  const spec = WRITABLE[key];
  if (!spec) {
    throw new Error(
      `unknown key "${key}" — writable keys: ${Object.keys(WRITABLE).join(", ")}, executors.<name>.bin`,
    );
  }
  let value: unknown;
  if (spec.type === "boolean") {
    const v = rawValue.trim().toLowerCase();
    if (v !== "true" && v !== "false") throw new Error(`"${key}" expects true|false, got "${rawValue}"`);
    value = v === "true";
  } else if (spec.type === "integer") {
    // 严格解析：parseInt("3600abc")=3600、parseInt("3.7")=3 都会静默写进 config，
    // 而用户以为写进去的是他给的那个数。
    const t = rawValue.trim();
    if (!/^\d+$/.test(t)) throw new Error(`"${key}" expects a positive integer, got "${rawValue}"`);
    const n = Number(t);
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
  else if (group === "defaults") c.defaults[field as "timeout_sec"] = value as never;
  else throw new Error(`unknown config group "${group}"`);
  writeConfig(home, c);
  return { key, value };
}

/** 已知的内置 profile 名（`profile create <name>` 时物化）。 */
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

export interface ProfileUseResult {
  profile: string;
}

export interface ProfileCreateResult {
  profile: string;
  desc: string;
  /** 这次一并注册的 executor（内置 profile 需要 executor 存在）。 */
  executor: string;
  /** executor 是这次新建的吗（false = 复用了已有的）。 */
  executor_created: boolean;
}

/**
 * 切换默认 profile —— **只切换，不物化**。
 *
 * 原来的 `config use` 一次做了三件结构性写入（补 executor、写 profile env、切默认）
 * 混着一次切换 ⇒ "我只是想切一下"也会改结构。拆开后：
 *  - 切默认 = `profile use`（profile 必须已存在）
 *  - 物化预设 = `profile create`（只创建，不切默认）
 */
export function useProfile(home: string, name: string): ProfileUseResult {
  const c = readConfig(home);
  if (!c.profiles?.[name]) {
    if (BUILTIN_PROFILES[name]) {
      throw new Error(
        `profile "${name}" not created yet — run "agent-ex profile create ${name}" first ` +
        `(内置预设需要先物化，create 不会自动切默认)`,
      );
    }
    throw new Error(
      `unknown profile "${name}" — existing: ${Object.keys(c.profiles ?? {}).join(", ") || "(none)"}`,
    );
  }
  c.defaults.profile = name;
  writeConfig(home, c);
  return { profile: name };
}

/**
 * 物化一个内置 profile 预设 —— **只创建，不切默认**。
 *
 * `--bin` 是必需的逃生口，不是装饰：内置 executor（opencode）常常不在 PATH 上
 * （本机就装在 ~/.opencode/bin），而 `validateConfig` 会在落盘前拒绝不可执行的 bin
 * ⇒ executor 条目根本写不进去 ⇒ 用户被"create 失败"与"set executors.<name>.bin 要求
 * name 已存在"两条规则夹死。给了 --bin 就能一次落地。
 */
export function createProfile(home: string, name: string, opts: { bin?: string } = {}): ProfileCreateResult {
  const c = readConfig(home);
  const builtin = BUILTIN_PROFILES[name];
  if (!builtin) {
    throw new Error(
      `unknown built-in profile "${name}" — built-in: ${Object.keys(BUILTIN_PROFILES).join(", ")}`,
    );
  }
  if (c.profiles?.[name]) {
    throw new Error(`profile "${name}" already exists — use "agent-ex profile use ${name}" to switch to it`);
  }
  let executorCreated = false;
  if (!c.executors?.[builtin.executor]) {
    const bin = opts.bin ?? builtin.executor;
    if (resolveBinPath(bin) === null) {
      throw new Error(
        `executor "${builtin.executor}" bin "${bin}" not found or not executable — ` +
        `若它不在 PATH 上，请用 --bin <绝对路径>：agent-ex profile create ${name} --bin /path/to/${builtin.executor}`,
      );
    }
    c.executors[builtin.executor] = { bin, extra_flags: builtin.executor === "opencode" ? ["--auto"] : [] };
    executorCreated = true;
  }
  // 深拷贝 env：直接挂 builtin.env 会让后续的 `profile set` 原地改到**进程内的常量**上
  // （同一进程里再物化一次就会带上被改过的值）。
  c.profiles[name] = { executor: builtin.executor, env: { ...builtin.env } };
  writeConfig(home, c);
  return { profile: name, desc: builtin.desc, executor: builtin.executor, executor_created: executorCreated };
}

export interface ProfileSetResult {
  profile: string;
  key: string;
  value: string;
}

/**
 * 改一个 profile 的字段。
 *
 * `<KEY>` 有两种：
 *  - `executor`（保留字，小写）：改这个 profile 用哪个 executor；值必须是已存在的 executor 名。
 *  - 其余：环境变量名，必须匹配 `^[A-Z][A-Z0-9_]*$`。
 *
 * 为什么要这么收：profile env 是**注入 worker 进程**的环境变量，
 * `NODE_OPTIONS` / `PATH` / `LD_*` 写进去等于允许任意代码执行或换掉解释器——
 * 这比"写坏一个字段"严重得多。env key 的大小写规则也和 config 键不是一套，
 * 所以用三参数而不是通用点路径。
 */
export function setProfileValue(
  home: string,
  profileName: string,
  key: string,
  rawValue: string,
): ProfileSetResult {
  const c = readConfig(home);
  const p = c.profiles?.[profileName];
  if (!p) {
    throw new Error(
      `unknown profile "${profileName}" — existing: ${Object.keys(c.profiles ?? {}).join(", ") || "(none)"}`,
    );
  }
  const value = rawValue.trim();
  if (value === "") throw new Error(`"${key}" expects a non-empty value, got ""`);

  // ---- executor（保留字）----
  if (key === "executor") {
    if (!c.executors?.[value]) {
      throw new Error(
        `unknown executor "${value}" — existing: ${Object.keys(c.executors ?? {}).join(", ") || "(none)"}`,
      );
    }
    p.executor = value;
    writeConfig(home, c);
    return { profile: profileName, key, value };
  }

  // ---- 环境变量 ----
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `"${key}" is not a valid env key — expected uppercase letters/digits/underscore (e.g. ZEN_FREE_PREFER) ` +
      `or the reserved word "executor"`,
    );
  }
  if (FORBIDDEN_ENV_KEYS.has(key) || FORBIDDEN_ENV_PREFIXES.some((p2) => key.startsWith(p2))) {
    throw new Error(
      `"${key}" is not allowed — it controls the worker process's startup/loader surface ` +
      `(NODE_OPTIONS ≈ arbitrary code execution, PATH/LD_* change what gets loaded)`,
    );
  }
  if (key === "OPENCODE_CONFIG_CONTENT") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (e) {
      throw new Error(`"${key}" must be valid JSON — ${(e as Error).message}`);
    }
    const model = (parsed as { model?: unknown } | null)?.model;
    if (typeof model !== "string" || model === "") {
      throw new Error(`"${key}" must contain a "model" field (string)`);
    }
    // 内置 zen-free profile 的意义就是"模型集会轮换、spawn 时动态解析"。
    // 把它换成硬编码模型名 = 悄悄关掉这个特性，所以必须保留占位符。
    const current = p.env?.[key] ?? "";
    if (current.includes(ZEN_FREE_PLACEHOLDER) && !value.includes(ZEN_FREE_PLACEHOLDER)) {
      throw new Error(
        `"${key}" must keep the ${ZEN_FREE_PLACEHOLDER} placeholder for this profile ` +
        `(hard-coding a model name disables dynamic resolution)`,
      );
    }
  }
  p.env = { ...(p.env ?? {}), [key]: value };
  writeConfig(home, c);
  return { profile: profileName, key, value };
}
