/**
 * `agent-ex skill` 的**纯逻辑层** —— dispatch skill 的安装 / 卸载 / 状态判定。
 *
 * ⚠️ 这个模块只碰 `node:fs` / `node:path` / `node:os` / `node:crypto`：
 * 不 import MCP SDK、不 import zod、不 import `node:sqlite`。
 * server.ts 的 `skill` 分支里动态 import 它，硬约束 7（MCP SDK 与 SQLite 只能在分支内加载）。
 *
 * ## 为什么要有 marker（provenance 随内容走）
 *
 * canonical（`~/.agents/skills/agent-ex-dispatch`）这个路径是 **agent-ex 的专属命名空间**。
 * 但"目录里有个东西"本身**不能**证明它是我们装的——用户可能手放了一个同名目录。
 * 于是拷贝模式安装时，在**拷贝目录内**写一个 `.agent-ex-skill.json`：
 *
 *   { "skill": "agent-ex-dispatch", "version": "0.3.2", "sha": "a1b2c3d4e5f6", "source": "…" }
 *
 * - **版本号 = 打包这份 skill 的 agent-ex 包版本**（`package.json` 的 version）。
 *   已发布的 npm 包不可变 ⇒ 包版本 ⟹ skill 内容版本，一一对应，**零人工维护**。
 * - marker 放在**拷贝目录内**而不是集中状态文件：归属判定只需读**那一个目录本身**就得出，
 *   不用跨两处对账（集中状态文件会漂移：用户手工删了 skill，状态文件还在说"已装"）。
 * - ⚠️ **软链模式不写 marker**——canonical 指向仓库，写进去会弄脏 git 工作树。
 *
 * ## canonical 的六态（design §4.2）
 *
 *   missing          不存在
 *   link-to-source   软链，指向本次的 source
 *   link-elsewhere   软链，指向别处（本机 workbuddy / trae 那两条就指向仓库）
 *   managed-copy     实体目录 + 有 marker ⇒ 我们装的，版本可读
 *   adoptable        实体目录 + 无 marker + 内容 hash 与 bundled 相同 ⇒ 认领（补写 marker）
 *   foreign-dir      实体目录 + 无 marker + 内容不同 ⇒ **不是我们装的**（或被改过）⇒ 中止
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** dispatch skill 的名字（= canonical 目录名 = 宿主目录里的条目名）。 */
export const SKILL_NAME = "agent-ex-dispatch";

/** 拷贝目录内的 provenance 文件名。**不参与内容 hash**（否则自己改自己就永远对不上）。 */
export const MARKER_FILE = ".agent-ex-skill.json";

/**
 * 宿主表：**数据**，不是 if-else 分支。加一家宿主只加一行。
 *
 * `relDir` 相对**用户 home**（不是 agent-ex home）——`~/.agents/skills` 这类目录在用户 home 下。
 * 用相对路径而不是绝对路径，是为了让测试能注入临时 home（不依赖开发机的真实目录）。
 */
export interface SkillHost {
  id: string;
  label: string;
  /** 用户级 skills 目录，相对用户 home。 */
  relDir: string;
  /**
   * "这个宿主在不在本机"的判据目录（相对 home）。缺省 = `dirname(relDir)`。
   *
   * ⚠️ 少数宿主的 skills 目录**不是**它的配置根目录：
   *   - Amp 的 skills 在 `~/.config/agents/skills`，配置却在 `~/.config/amp`；
   *   - 直读共享目录的宿主（codex / cline / zed）压根没有自己的 skills 目录。
   * ⇒ 这些要显式写 `configRelDir`。
   */
  configRelDir?: string;
  /** `--agent` 的其它写法（大小写不敏感）。 */
  aliases?: readonly string[];
  /** 该宿主是否自带"从 ~/.agents/skills 自动桥接"的机制。有就别手工建链。 */
  autoBridge?: (userHome: string) => boolean;
  /**
   * 该宿主**直接读共享目录** `~/.agents/skills`（不读自己的目录）。
   *
   * ⇒ 永远**不建链**（`relDir` 就是共享目录本身，建链就是链到 canonical 自己）。
   * 事实依据：`npx skills` 的宿主表里这批宿主（cline / codex / zed …）的
   * global skills 路径就是 `~/.agents/skills`，且没有 `globalReadsCanonical: false`。
   */
  readsCanonical?: boolean;
}

/**
 * 已知宿主。
 *
 * 目录与"在场判据"对着 `npx skills`（vercel-labs/skills）的宿主表逐条核过：
 * 那边的 `globalSkillsDir` = 我们的 `relDir`，它的 `detectInstalled` = 我们的 `configRelDir`。
 * 我们不抄它那 58 家（维护债 + 漂移债），只收一线常用的一批。
 */
export const SKILL_HOSTS: readonly SkillHost[] = [
  { id: "claude", label: "Claude Code", relDir: ".claude/skills", aliases: ["claude-code"] },
  { id: "cursor", label: "Cursor", relDir: ".cursor/skills" },
  { id: "windsurf", label: "Windsurf", relDir: ".codeium/windsurf/skills" },
  { id: "trae", label: "Trae", relDir: ".trae/skills" },
  { id: "trae-cn", label: "Trae CN", relDir: ".trae-cn/skills" },
  { id: "copilot", label: "GitHub Copilot", relDir: ".copilot/skills", aliases: ["github-copilot"] },
  { id: "gemini", label: "Gemini CLI", relDir: ".gemini/skills", aliases: ["gemini-cli"] },
  { id: "opencode", label: "OpenCode", relDir: ".config/opencode/skills" },
  { id: "droid", label: "Droid (Factory)", relDir: ".factory/skills", aliases: ["factory"] },
  // Amp 的 skills 在 ~/.config/agents/skills（与 Replit / Universal 共用），配置在 ~/.config/amp。
  { id: "amp", label: "Amp", relDir: ".config/agents/skills", configRelDir: ".config/amp" },
  { id: "qwen", label: "Qwen Code", relDir: ".qwen/skills", aliases: ["qwen-code"] },
  { id: "minimax", label: "MiniMax Code", relDir: ".minimax/skills", aliases: ["minimax-code"] },
  { id: "codebuddy", label: "CodeBuddy", relDir: ".codebuddy/skills" },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    relDir: ".workbuddy/skills",
    autoBridge: (userHome) => workBuddyBridges(userHome),
  },
  // ↓ 直读共享目录 ~/.agents/skills 的宿主：不建链（见 SkillHost.readsCanonical）。
  { id: "codex", label: "Codex", relDir: ".agents/skills", configRelDir: ".codex", readsCanonical: true },
  { id: "cline", label: "Cline", relDir: ".agents/skills", configRelDir: ".cline", readsCanonical: true },
  { id: "zed", label: "Zed", relDir: ".agents/skills", configRelDir: ".config/zed", readsCanonical: true },
];

/**
 * WorkBuddy 是否会自动把 `~/.agents/skills/*` 桥接进 `~/.workbuddy/skills`。
 *
 * 判据是**探测**而不是硬编码：看那个 hook 文件在不在。
 * 该 hook 支持 `AGENTS_SKILLS_DIR` / `WORKBUDDY_SKILLS_DIR` 覆盖 ⇒ 可以在临时目录里隔离验证它的行为。
 *
 * ⚠️ **两张表都要查**：hook 会跳过
 *   - `.reserved-skill-names`（builtin / plugin / connector 占用的名字）
 *   - `.excluded-skill-names`（显式排除的名字）
 * 命中任意一张 ⇒ hook 不会桥接 ⇒ 不能算"自动桥接"，否则 install 以为不用建链、
 * 结果 WorkBuddy 里根本没有这个 skill。
 */
export function workBuddyBridges(userHome: string): boolean {
  const hook = join(userHome, ".workbuddy/hooks/sync-agents-skills.sh");
  if (!existsSync(hook)) return false;
  for (const table of [".reserved-skill-names", ".excluded-skill-names"]) {
    const p = join(userHome, ".workbuddy/skills", table);
    try {
      const hit = readFileSync(p, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .some((l) => l === SKILL_NAME);
      if (hit) return false;
    } catch {
      // 没有这张表 ⇒ 这张表不排除我们
    }
  }
  return true;
}

/** 宿主 skills 目录的绝对路径。 */
export function hostDir(userHome: string, host: SkillHost): string {
  return join(userHome, host.relDir);
}

/**
 * 宿主的**配置根目录**（绝对路径）——"这个宿主在不在本机"的判据。
 *
 * 为什么要判"配置根"而不是"skills 目录"：skills 目录常常是我们自己建出来的，
 * 拿它当判据 ⇒ 装过一次就永远"在场"，没装过的宿主反而被漏掉。
 * 判据取宿主自己的家目录（`~/.claude`、`~/.config/opencode` …），跟"装没装过 skill"无关。
 */
export function hostConfigRoot(userHome: string, host: SkillHost): string {
  return join(userHome, host.configRelDir ?? dirname(host.relDir));
}

/**
 * 宿主是否在本机（它的配置根目录存在）。
 *
 * ⚠️ **"我们自己建出来的目录"不算在场**：
 * 给一个没装的宿主建链，会连带建出 `<配置根>/skills/`，而配置根往往**就是** skills 目录的父目录
 * （`~/.claude` ⊃ `~/.claude/skills`）⇒ 建完链它就永远"在场"了。
 * ⇒ 配置根里**只有我们自己建的那点东西**时，判为"不在场"。
 *
 * 例外（amp / codex / cline / zed）：它们的 skills 目录**不在**配置根里面
 * （amp 的 skills 在 `~/.config/agents/skills`，配置在 `~/.config/amp`）
 * ⇒ 我们没碰过它们的配置根，不存在自我污染。
 */
export function hostPresent(userHome: string, host: SkillHost): boolean {
  const root = hostConfigRoot(userHome, host);
  if (!existsSync(root)) return false;
  return !onlyContainsOurOwnWork(userHome, host, root);
}

/**
 * 配置根里是不是**只有我们自己建的东西**（skills 目录 + 我们那条链）？
 *
 * 判断不出来时一律返回 false（当作"不只有我们的"）⇒ 宁可多链一个宿主，
 * 也不要把"我们建过"误判成"用户装了"。
 */
function onlyContainsOurOwnWork(userHome: string, host: SkillHost, root: string): boolean {
  const skills = hostDir(userHome, host);
  // skills 目录不在配置根里面 ⇒ 我们没往配置根里写东西。
  if (!isInside(skills, root)) return false;
  let rootEntries: string[];
  try {
    rootEntries = readdirSync(root);
  } catch {
    return false;
  }
  // 配置根里除了 skills 目录还有别的东西 ⇒ 宿主确实在（配置、缓存、历史……）。
  if (rootEntries.some((n) => !samePath(join(root, n), skills))) return false;
  // 配置根里只有 skills 目录 ⇒ 看 skills 目录里有没有别的东西。
  try {
    return readdirSync(skills).every((n) => n === SKILL_NAME);
  } catch {
    return false;
  }
}

/** 需要建链的宿主（直读共享目录的不算——给它们建链就是链到 canonical 自己）。 */
export function linkableHosts(): SkillHost[] {
  return SKILL_HOSTS.filter((h) => !h.readsCanonical);
}

/** 按 id 或别名找宿主（大小写不敏感）。找不到返回 null。 */
export function findHost(name: string): SkillHost | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  for (const h of SKILL_HOSTS) {
    if (h.id.toLowerCase() === key) return h;
    if (h.aliases?.some((a) => a.toLowerCase() === key)) return h;
  }
  return null;
}

/** `--agent '*'`：全部需要建链的宿主。 */
export const ALL_HOSTS = "*";

/** `--agent` 的解析结果。 */
export interface AgentSelection {
  /** 命中的宿主 id（去重，按宿主表顺序）。 */
  ids: string[];
  /** 认不出来的名字（报给用户）。 */
  unknown: string[];
  /** 是否选了 `*`。 */
  all: boolean;
}

/**
 * 解析 `--agent` 的取值 ⇒ 宿主 id 列表。
 *
 * 接受：宿主 id、别名（`claude` / `claude-code` 都行）、`*`（全部需要建链的宿主）。
 */
export function resolveAgentSelection(names: readonly string[]): AgentSelection {
  const ids: string[] = [];
  const unknown: string[] = [];
  let all = false;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (name === ALL_HOSTS) {
      all = true;
      continue;
    }
    const host = findHost(name);
    if (!host) {
      unknown.push(name);
      continue;
    }
    if (!ids.includes(host.id)) ids.push(host.id);
  }
  return { ids, unknown, all };
}

/** 合法取值的清单（报错时列给用户看）。 */
export function hostSelectorNames(): string[] {
  const out: string[] = [];
  for (const h of SKILL_HOSTS) {
    out.push(h.id);
    for (const a of h.aliases ?? []) out.push(a);
  }
  out.push(ALL_HOSTS);
  return out;
}

/** canonical 的绝对路径（**固定**——自动桥接只认 `~/.agents/skills` 这一个源）。 */
export function canonicalPath(userHome: string): string {
  return join(userHome, ".agents/skills", SKILL_NAME);
}

/**
 * 解析本模块内置的那份 skill 目录。
 *
 * 相对**本模块自身位置**解析 ⇒ 源码模式与编译模式都对：
 *   - `src/skill.ts`  → `<repo>/skills/agent-ex-dispatch`
 *   - `dist/skill.js` → `<pkg>/skills/agent-ex-dispatch`
 * **不要**硬编码 `dist/skills`。
 */
export function resolveBundledSkillDir(baseDir?: string): string {
  const base = baseDir ?? dirname(fileURLToPath(import.meta.url));
  return resolve(base, "..", "skills", SKILL_NAME);
}

/**
 * 当前 agent-ex 包版本 —— 也就是**这份 skill 的版本号**。
 *
 * 已发布的 npm 包不可变 ⇒ 包版本 ⟹ skill 内容版本。开发者路线（软链到仓库）下不比较版本，
 * 因为软链永远实时。
 */
export function currentVersion(): string {
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const v = JSON.parse(readFileSync(p, "utf8")).version;
    return typeof v === "string" && v ? v : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 目录内容指纹：`sha256(排序后的 "相对路径\0长度\0内容")`，取前 12 位 hex。
 *
 * 三个刻意的选择：
 * - **路径分隔符归一**成 `/`（Windows 的 `path.relative` 会给反斜杠）；
 * - **带长度前缀**（内容里含 NUL 也不会让边界含糊）；
 * - **排除 marker 自己**——否则写完 marker 再算 hash 就永远对不上。
 *
 * 软链**不参与** hash（Dirent 对软链既非 file 也非 directory）⇒ 同一份内容在不同机器上结果一致。
 */
export function hashDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const rels: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(d, entry.name));
        continue;
      }
      if (!entry.isFile()) continue; // 软链 / 特殊文件一律跳过
      const rel = relative(dir, join(d, entry.name)).split(sep).join("/");
      if (rel === MARKER_FILE) continue;
      rels.push(rel);
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  rels.sort();
  const h = createHash("sha256");
  for (const rel of rels) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(dir, ...rel.split("/")));
    } catch {
      continue;
    }
    h.update(String(buf.length));
    h.update("\0");
    h.update(rel);
    h.update("\0");
    h.update(buf);
  }
  return h.digest("hex").slice(0, 12);
}

/** 拷贝目录内的 provenance。 */
export interface SkillMarker {
  skill: string;
  version: string;
  sha: string;
  source: string;
}

/** 读 marker。**目录不存在 / 文件不存在 / JSON 坏了 / 形状不对 ⇒ 一律 null**（不抛）。 */
export function readMarker(dir: string): SkillMarker | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, MARKER_FILE), "utf8")) as Partial<SkillMarker>;
    if (
      raw && typeof raw === "object" &&
      typeof raw.version === "string" &&
      typeof raw.sha === "string"
    ) {
      return {
        skill: typeof raw.skill === "string" ? raw.skill : SKILL_NAME,
        version: raw.version,
        sha: raw.sha,
        source: typeof raw.source === "string" ? raw.source : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 写 marker。 */
export function writeMarker(dir: string, m: SkillMarker): void {
  writeFileSync(join(dir, MARKER_FILE), JSON.stringify(m, null, 2) + "\n");
}

/** canonical 的六态。 */
export type CanonicalState =
  | "missing"
  | "link-to-source"
  | "link-elsewhere"
  | "managed-copy"
  | "adoptable"
  | "foreign-dir";

export interface CanonicalInfo {
  path: string;
  state: CanonicalState;
  /** 软链的指向（已解析成绝对路径）。 */
  target?: string;
  /** managed-copy 时来自 marker。 */
  marker?: SkillMarker;
  /** 当前内容 hash。 */
  sha?: string;
  /** managed-copy 且 marker.version != 当前包版本 ⇒ 有新版本可更新。 */
  updateAvailable?: boolean;
  /** managed-copy 但当前 hash != marker.sha ⇒ 用户手改过。 */
  modified?: boolean;
  /** 是软链、但**指向的目标已经不存在** ⇒ 断链（读不到内容）。 */
  broken?: boolean;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * 这个软链是不是指向 canonical 本身？
 *
 * 比的是**解析后的绝对路径**：软链的字面 target 可能是相对路径，
 * 也可能指向 canonical 的某个别名路径（`/tmp` vs `/private/tmp`）。
 */
export function pointsAtCanonical(target: string | undefined, canonical: string): boolean {
  if (!target) return false;
  return realOrSelf(target) === realOrSelf(canonical);
}

/**
 * 路径的"真实形式"：把**最近的已存在祖先**做 realpath，剩下的段原样拼上。
 *
 * 为什么不用 `realpathSync`：路径**不存在**时 realpath 会失败，
 * 而 realpath 的兜底（`resolve`）是**字面**的 ⇒ macOS 上 `/var/...` 与 `/private/var/...`
 * 会当成两个不同的地方，拦截就被绕过了（2026-11-10 第四轮评审 P2-a）。
 * 这个函数对不存在的路径也能给出与已存在祖先一致的形式。
 */
function realish(p: string): string {
  const abs = resolve(p);
  // ⚠️ tail 要**含 basename(abs)**：只拼父目录的话，"在某目录里"会被算成"就是那个目录"。
  const tail: string[] = [basename(abs)];
  let dir = dirname(abs);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    tail.unshift(basename(dir));
    dir = parent;
  }
  let base = dir;
  try {
    base = realpathSync(dir);
  } catch {
    /* 祖先也不存在 ⇒ 用字面 */
  }
  return join(base, ...tail);
}

/** 路径 a 是不是就是路径 b（按 realpath 比，能识别 `/tmp` vs `/private/tmp` 这种别名）？ */
function samePath(a: string, b: string): boolean {
  return realOrSelf(a) === realOrSelf(b);
}

/** a 在 b 里面吗（含 a === b）？两边都按"最近存在祖先"的真实形式比较。 */
function isInside(a: string, b: string): boolean {
  const x = realish(a);
  const y = realish(b);
  return x === y || x.startsWith(y.endsWith(sep) ? y : y + sep);
}

/** canonical 这条路径现在是不是软链？ */
function isSymlinkPath(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 这个路径上**有东西**吗？
 *
 * ⚠️ **不跟随软链**：`existsSync` 跟随 ⇒ 悬空软链返回 false，
 * 而"这个名字被占着"这件事对 rename 至关重要 ——
 * `rename(目录, 悬空软链)` 会报 ENOTDIR（目标不是目录），
 * 那种状态下安装**必失败**，而 doctor 给的修法恰恰是这条命令
 * （2026-11-10 第三轮评审 P1-a）。所以这里用 lstat：名字被占着就算有。
 */
function pathOccupied(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 这个链接位置会不会落在 canonical 里面？
 *
 * 两种"里面"都要算：
 *   - 按**路径**（canonical 还没装时，target 指到它的子目录）；
 *   - 按 **realpath**（canonical 是软链时 —— 开发者路线下 canonical 指向仓库里的
 *     skill 目录，`--target <canonical>/references` 会在**源码树**里建出软链）。
 */
function linkPathInsideCanonical(linkPath: string, canonical: string): boolean {
  // 按路径（含别名归一）：链接位置落在 canonical 路径里面
  if (isInside(linkPath, canonical)) return true;
  // canonical 是软链时（开发者路线），它的**真实位置**也要算：
  // `--target <canonical>/references` 软链解析后就是**源码树**里的目录。
  const linkDir = realOrSelf(dirname(linkPath));
  const canonReal = realOrSelf(canonical);
  return isInside(linkDir, canonReal);
}

/**
 * `source` 会不会让 canonical 变成一条**指向自己的断链**（自指循环）？
 *
 * ⚠️ 不能简单地比 realpath：canonical 是**软链**时（开发者路线）realpath(canonical)
 * 正好就是 source —— 那正是要装的形态，不能误伤。
 * 所以分两种：
 *   - canonical 是软链 ⇒ 只有「source 就是 canonical 这条路径」才危险；
 *   - canonical 是实体目录 ⇒ source 等于它（哪怕是别名路径）或在它里面，都危险。
 */
export function sourceWouldSelfLink(source: string, canonical: string): boolean {
  return selfLinkReason(source, canonical) !== null;
}

/**
 * source 会不会让 canonical 变成一条**指向自己的断链**？返回原因（null = 没问题）。
 *
 * 判据是**真实位置**的包含关系，不是字面路径（2026-11-10 第四轮评审 P1）：
 * 软链的字面 target 会被原样写进 canonical ⇒ 只要 source 的**真实位置**落在
 * canonical 里面，换位后 canonical 就指向自己的子树 ⇒ ELOOP、路径不可读。
 *
 * ⚠️ 一条例外：**canonical 自己是软链、且 source 就是它指向的那个目录** ⇒ 放行
 * （那正是开发者路线：canonical → 仓库里的 skill 目录，换成指向同一处的链是空操作）。
 */
export function selfLinkReason(source: string, canonical: string): string | null {
  if (resolve(source) === resolve(canonical)) return "is the canonical location itself";
  const canonReal = realOrSelf(canonical);
  const sourceReal = realOrSelf(source);
  if (sourceReal === canonReal) {
    // source 就是 canonical 现在指向的地方
    return isSymlinkPath(canonical) ? null : "is the canonical location itself";
  }
  if (isInside(sourceReal, canonReal)) return "is inside the canonical location";
  return null;
}

/**
 * 判定 canonical 的状态。**只读**，不创建任何东西。
 *
 * @param canonical canonical 的绝对路径
 * @param source    本次要装的源目录（用来判断软链是不是指向它）
 */
export function inspectCanonical(canonical: string, source: string): CanonicalInfo {
  let st;
  try {
    st = lstatSync(canonical);
  } catch {
    return { path: canonical, state: "missing" };
  }

  if (st.isSymbolicLink()) {
    let target: string;
    try {
      target = realOrSelf(resolve(dirname(canonical), readlinkSync(canonical)));
    } catch {
      target = canonical;
    }
    const state: CanonicalState = target === realOrSelf(source) ? "link-to-source" : "link-elsewhere";
    // ⚠️ 断链要单独标出来：canonical 是软链但目标没了 ⇒ 那个路径**读不到内容**
    // （第三轮评审附带项：status 只打印 `[link -> …]`，用户看不出它已经断了）。
    return { path: canonical, state, target, broken: !existsSync(target) };
  }

  if (!st.isDirectory()) {
    // 文件 / 设备等：不是我们能管理的
    return { path: canonical, state: "foreign-dir" };
  }

  const sha = hashDir(canonical) ?? undefined;
  const marker = readMarker(canonical);
  if (marker) {
    return {
      path: canonical,
      state: "managed-copy",
      marker,
      sha,
      updateAvailable: marker.version !== currentVersion(),
      modified: sha !== undefined && marker.sha !== sha,
    };
  }

  const bundledSha = hashDir(source);
  if (sha && bundledSha && sha === bundledSha) {
    // 内容与 bundled 一致 ⇒ 这是别人（多半是 npx skills）装的同一份内容 ⇒ 认领
    return { path: canonical, state: "adoptable", sha };
  }
  return { path: canonical, state: "foreign-dir", sha };
}

/** 目标路径的形态。 */
export interface TargetState {
  path: string;
  kind: "link" | "dir" | "file" | "missing" | "broken-link";
  /** 软链的指向（已解析成绝对路径）。 */
  target?: string;
}

/** 判定任意目标路径的形态（只读）。 */
export function inspectTarget(path: string): TargetState {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { path, kind: "missing" };
  }
  if (st.isSymbolicLink()) {
    let target: string;
    try {
      target = realOrSelf(resolve(dirname(path), readlinkSync(path)));
    } catch {
      target = path;
    }
    return { path, kind: existsSync(target) ? "link" : "broken-link", target };
  }
  if (st.isDirectory()) return { path, kind: "dir" };
  return { path, kind: "file" };
}

export interface SkillStatus {
  bundled: { dir: string; version: string; sha: string | null; exists: boolean };
  canonical: CanonicalInfo;
  hosts: Array<{
    host: SkillHost;
    dir: string;
    state: TargetState;
    autoBridge: boolean;
    /** 这个宿主在不在本机（配置根目录存在）。 */
    present: boolean;
  }>;
}

/**
 * 汇总状态（**只读**：不创建任何目录或文件）。
 *
 * @param userHome 用户 home（`~/.agents/skills` 在这底下）
 * @param source   skill 源目录，默认取本模块内置的那份
 */
export function skillStatus(opts: { userHome: string; source?: string }): SkillStatus {
  const source = opts.source ?? resolveBundledSkillDir();
  const canonical = canonicalPath(opts.userHome);
  return {
    bundled: {
      dir: source,
      version: currentVersion(),
      sha: hashDir(source),
      exists: existsSync(source),
    },
    canonical: inspectCanonical(canonical, source),
    hosts: SKILL_HOSTS.map((host) => {
      const dir = hostDir(opts.userHome, host);
      return {
        host,
        dir,
        state: inspectTarget(join(dir, SKILL_NAME)),
        autoBridge: host.autoBridge ? host.autoBridge(opts.userHome) : false,
        present: hostPresent(opts.userHome, host),
      };
    }),
  };
}

/** doctor 消费的 skill 问题（与 `collectConfigIssues` 平行，但**不是** config 的问题）。 */
export interface SkillIssue {
  code:
    | "skill.missing"
    | "skill.outdated"
    | "skill.modified"
    | "skill.foreign"
    | "skill.unmanaged-but-matching"
    | "skill.hosts-unlinked"
    | "skill.host-link-elsewhere";
  severity: "info" | "warn" | "ok";
  title: string;
  detail: string;
  fix?: string;
}

/**
 * 收集 skill 相关的体检项。
 *
 * ⚠️ **绝不塞进 `collectConfigIssues()`**——那是 `config.json` 的真相源，skill 状态不是 config。
 * 这里是与它**平行**的一份，installer 与 doctor 同源消费（单一真相源模式）。
 *
 * severity 最高只到 `warn`：skill 是可选件，没装不该让体检失败。
 */
export function collectSkillIssues(opts: { userHome: string; source?: string }): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const st = skillStatus(opts);
  const c = st.canonical;

  switch (c.state) {
    case "missing":
      issues.push({
        code: "skill.missing",
        severity: "info",
        title: "Dispatch skill is not installed",
        detail: `No skill at ${c.path}. Without it the agent has no dispatch discipline (when to delegate, how to write a self-contained prompt, why same-folder writes must not run concurrently).`,
        fix: "agent-ex skill install",
      });
      break;
    case "managed-copy":
      if (c.updateAvailable) {
        issues.push({
          code: "skill.outdated",
          severity: "warn",
          title: "Installed dispatch skill is older than the bundled one",
          detail: `Installed v${c.marker?.version} at ${c.path}; this package ships v${st.bundled.version}. The skill documents version-gated behaviour, so a stale copy can describe features this build does not have.`,
          fix: "agent-ex skill install",
        });
      } else {
        issues.push({
          code: "skill.outdated",
          severity: "ok",
          title: "Dispatch skill is installed and up to date",
          detail: `${c.path} (v${c.marker?.version})`,
        });
      }
      if (c.modified) {
        issues.push({
          code: "skill.modified",
          severity: "warn",
          title: "Installed dispatch skill has local modifications",
          detail: `Content hash at ${c.path} does not match the one recorded when it was installed (v${c.marker?.version}). Updating will overwrite those changes.`,
          fix: "agent-ex skill install (it will ask before overwriting)",
        });
      }
      break;
    case "adoptable":
      issues.push({
        code: "skill.unmanaged-but-matching",
        severity: "info",
        title: "Dispatch skill is present but was not installed by agent-ex",
        detail: `${c.path} matches the bundled skill byte for byte, so agent-ex can adopt it.`,
        fix: "agent-ex skill install",
      });
      break;
    case "foreign-dir":
      issues.push({
        code: "skill.foreign",
        severity: "warn",
        title: "Dispatch skill directory was not installed by agent-ex",
        detail: `${c.path} exists but carries no agent-ex marker and does not match the bundled skill. agent-ex will not overwrite it.`,
        fix: `inspect ${c.path} by hand, then remove or rename it before running agent-ex skill install`,
      });
      break;
    case "link-to-source":
      issues.push({
        code: "skill.outdated",
        severity: "ok",
        title: "Dispatch skill is linked to a source directory (developer route)",
        detail: `${c.path} -> ${c.target}. It follows the source, so it never goes stale.`,
      });
      break;
    case "link-elsewhere":
      issues.push({
        code: "skill.foreign",
        severity: "warn",
        title: "Dispatch skill is linked to another location",
        detail: `${c.path} -> ${c.target}, which is not the bundled skill.`,
        fix: "agent-ex skill install (it will ask whether to repoint it)",
      });
      break;
  }

  const canonicalAbs = realOrSelf(st.canonical.path);
  // 链到别处的宿主 / 断掉的链：链还在，但它指的不是 canonical ⇒ 宿主看到的可能是一份旧内容，
  // 或者根本读不到。两种都要报 —— 只在 status 里报、doctor 静默，等于体检漏项。
  // ⚠️ 直读共享目录的宿主（codex / cline / zed）要**排除**：它们那条"链"就是 canonical 自己，
  // 开发者路线下 canonical 是指向仓库的软链 ⇒ 目标不等于 canonicalAbs ⇒ 会被误报成"链到别处"。
  const mislinked = st.hosts.filter(
    (h) =>
      !h.host.readsCanonical &&
      (h.state.kind === "broken-link" ||
        (h.state.kind === "link" && h.state.target !== canonicalAbs)),
  );
  if (mislinked.length > 0) {
    const broken = mislinked.filter((h) => h.state.kind === "broken-link");
    const elsewhere = mislinked.filter((h) => h.state.kind === "link");
    const detailParts: string[] = [];
    if (elsewhere.length > 0) {
      detailParts.push(
        `These links do not point at ${st.canonical.path}: ${elsewhere
          .map((h) => `${h.host.label} (${h.state.path} -> ${h.state.target})`)
          .join(", ")}.`,
      );
    }
    if (broken.length > 0) {
      detailParts.push(
        `These links are broken (their target is gone): ${broken
          .map((h) => `${h.host.label} (${h.state.path})`)
          .join(", ")}.`,
      );
    }
    issues.push({
      code: "skill.host-link-elsewhere",
      severity: "warn",
      title: "Some hosts link the dispatch skill to a different location",
      detail: detailParts.join(" "),
      fix: "agent-ex skill install (it will repoint or repair them)",
    });
  }

  const unlinked = st.hosts.filter(
    (h) =>
      h.state.kind === "missing" &&
      !h.autoBridge &&
      // ⚠️ 直读共享目录的宿主（codex / cline / zed）不算"漏链"——它们本来就没有自己的条目。
      !h.host.readsCanonical &&
      // 只报**本机装了**的宿主：没装的宿主装它没意义（那是 `--agent` 的活）。
      h.present,
  );
  if (unlinked.length > 0) {
    issues.push({
      code: "skill.hosts-unlinked",
      severity: "info",
      title: "Dispatch skill is not linked into some hosts",
      detail: `Not linked: ${unlinked.map((h) => `${h.host.label} (${h.dir})`).join(", ")}. Those hosts will not see the skill.`,
      fix: "agent-ex skill install",
    });
  }

  return issues;
}

/** 写操作的结果。**纯逻辑层不 console.log**——文案渲染归 skill-cmd.ts。 */
export interface SkillActionResult {
  /**
   * 成功与否。
   *
   * ⚠️ `skipped` 非空 ⇒ `ok` 为 false：用户说"卸载"，结果**还有东西留在原地**
   * （实体目录 / 外来目录，agent-ex 不能删）——那不是"卸载成功"，是"部分完成"。
   * 静默返回 0 会让用户以为已经干净了。
   */
  ok: boolean;
  lines: string[];
  errors: string[];
  /** **留着没删**的东西（不是错误：删了可能丢用户数据；但结果不是"干净"）。 */
  skipped: string[];
}

/** 提问回调。**注入**它，纯逻辑层才不需要模拟 TTY。 */
export type ConfirmFn = (question: string, defaultYes: boolean) => Promise<boolean>;

export interface InstallOptions {
  /** 用户 home（`~/.agents/skills` 在这底下）。 */
  userHome: string;
  /** skill 源目录，默认取本模块内置的那份。 */
  source?: string;
  /** copy = 用户路线（拷贝）；link = 开发者路线（软链）。 */
  mode?: "copy" | "link";
  /** 额外宿主目录（显式指定 ⇒ 直接建链，不问）。 */
  targets?: string[];
  /**
   * 显式点名要装的宿主（`--agent`）：宿主 id、别名，或 `*`（全部需要建链的宿主）。
   *
   * 点名的宿主 ⇒ 直接建链，不问；**没点名**的宿主按"在本机 + 问一句"的老规矩走。
   */
  agents?: string[];
  /**
   * 跳过所有提问（每个问题都按 yes 答）。
   *
   * ⚠️ 默认 **false**。默认 `confirm` 在**没人能答问题**时会抛错（拒绝执行），
   * 而不是默认按"是"放行 —— 库 API 被误用时不该静默删东西。
   * 要放行就显式给 `yes: true`，或自己注入 `confirm`。
   * CLI 层（`skill-cmd.ts`）在非 TTY 且没有 `--yes` 时直接拒绝执行写操作。
   */
  yes?: boolean;
  /** 提问回调。 */
  confirm?: ConfirmFn;
}

export interface RemoveOptions {
  userHome: string;
  source?: string;
  /** 只移除这些目录下的条目；**不给则连 canonical 一起移除**。 */
  targets?: string[];
  /** 只移除这些宿主下的条目（`--agent`）；**不给则连 canonical 一起移除**。 */
  agents?: string[];
  /**
   * 跳过确认（一律执行）。
   *
   * ⚠️ 默认 **false**：不传 `confirm` 时，卸载会**拒绝执行并抛错**
   * （库 API 被误用时不该静默删东西）。要放行就显式给 `yes: true`。
   */
  yes?: boolean;
  confirm?: ConfirmFn;
}

/**
 * **原子替换 canonical**：先在同目录的临时名上把新内容做好，成功了才换上去。
 *
 * `build(tmp)` 负责把新内容写到 tmp（拷贝目录 / 软链），失败时它自己抛。
 * 本函数负责剩下的：挪走旧的 → 换新的 → 失败回滚。
 *
 * ⇒ 宿主永远读不到"写了一半"的 skill；失败时 canonical 原封不动。
 *
 * ⚠️ **失败路径必须保住上一份 canonical**（2026-11-10 评审 P1-1 / P2-1 / P2-2）：
 *   - `build` 失败 ⇒ canonical 没动过，只要把半截的 tmp 收掉
 *     （临时名带 pid，留着**下次进程也清不掉** ⇒ 必须无条件清）；
 *   - `rename(canonical, old)` 失败 ⇒ canonical 原地不动（还是好的），清 tmp 后抛；
 *   - `rename(tmp, canonical)` 失败 ⇒ 尝试把 `old` 挪回 canonical；
 *     **挪不回去就绝不能删 `old`** —— 那是用户上一份安装的唯一副本。
 *     （原实现用 `finally { rmSync(old) }` 无条件删，与它自己的注释相反。）
 */
function replaceAtomically(canonical: string, build: (tmp: string) => void): void {
  const parent = dirname(canonical);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.${SKILL_NAME}.tmp.${process.pid}`);
  const old = join(parent, `.${SKILL_NAME}.old.${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });

  try {
    build(tmp);
  } catch (e) {
    // 新内容没做好：canonical 根本没被碰过，只要把半截的 tmp 收掉。
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }

  const hadOld = pathOccupied(canonical);
  if (hadOld) {
    try {
      renameSync(canonical, old);
    } catch (e) {
      // 旧的挪不动 ⇒ canonical 原地不动（还是好的）；tmp 是多余的，收掉。
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
  try {
    renameSync(tmp, canonical);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    let restored = false;
    if (hadOld) {
      try {
        renameSync(old, canonical);
        restored = true;
      } catch {
        /* 挪不回去 —— old 必须留在原处，它是唯一副本 */
      }
    }
    if (hadOld && !restored) {
      throw new Error(
        `failed to install and failed to restore the previous copy — it is kept at ${old}. ` +
          `Move it back to ${canonical} by hand. (original error: ${e instanceof Error ? e.message : String(e)})`,
      );
    }
    throw e;
  }
  // 只有成功到位（或已成功回滚）才清 old；走到这里说明 new 已经在 canonical 上。
  // ⚠️ 清不掉**不算安装失败**（新内容已经就位，报失败是撒谎）——
  // 残留的是一个隐藏的备份目录，下个进程清不掉它，但那是"多了一份备份"，
  // 不是"装坏了"。真要处理得靠按 mtime 清陈旧残留，不在这次范围内。
  try {
    rmSync(old, { recursive: true, force: true });
  } catch {
    /* 留着就留着：新内容已在位 */
  }
}

/** 拷贝路线：把 source 整个拷成 canonical（原子）。 */
function copyAtomically(source: string, canonical: string): void {
  replaceAtomically(canonical, (tmp) => cpSync(source, tmp, { recursive: true }));
}

/** 软链路线：把 canonical 换成指向 target 的软链（原子；旧的挪开失败 ⇒ 原地不动）。 */
function linkAtomically(canonical: string, target: string): void {
  replaceAtomically(canonical, (tmp) => symlinkSync(target, tmp, "dir"));
}

/** 在 linkPath 处建一条指向 target 的软链（父目录不存在就建）。 */
function symlinkAt(linkPath: string, target: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, "dir");
}

/**
 * 安装。
 *
 * 流程与动作矩阵见 design §4.2 / §4.3。要点：
 * - canonical 是**固定**路径，状态分六态，每态有确定动作；
 * - `managed-copy` 且版本落后 ⇒ **问"是否更新"**；
 * - `foreign-dir` ⇒ **中止**，目录内容一字未改；
 * - 宿主链接：**显式 `--target` / `--agent` > 已有指向别处的链（重指）> autoBridge（不建链）> 其余问**。
 */
export async function installSkill(opts: InstallOptions): Promise<SkillActionResult> {
  const lines: string[] = [];
  const errors: string[] = [];
  // ⚠️ source 必须是**绝对路径**：软链的字面 target 是相对链接所在目录解析的，
  // 相对 source 会装出必然断掉的链（2026-11-10 评审 P1-2）。
  const source = resolve(opts.source ?? resolveBundledSkillDir());
  const mode = opts.mode ?? "copy";
  const yes = opts.yes ?? false;
  // 默认提问实现：**没人能答问题时拒绝执行**，而不是默认按"是"放行。
  // CLI 层总是注入带 TTY 检查的 confirm；程序化调用方必须显式给
  // `yes: true`（全答 yes）或自己的 confirm —— 否则这行会抛。
  const confirm: ConfirmFn =
    opts.confirm ??
    (async (q, _def) => {
      if (yes) return true;
      throw new Error(
        `cannot ask interactively: "${q}" — pass yes: true (accept every answer) or a confirm callback`,
      );
    });

  // ⚠️ `--agent` 的名字**先校验**：认不出来就别动磁盘（半份安装比报错更糟）。
  const selected = resolveAgentSelection(opts.agents ?? []);
  if (selected.unknown.length > 0) {
    errors.push(
      `unknown host${selected.unknown.length > 1 ? "s" : ""}: ${selected.unknown.join(", ")}. ` +
        `Valid names: ${hostSelectorNames().join(", ")}.`,
    );
    return { ok: false, lines, errors, skipped: [] };
  }

  // source 必须**像个 skill 目录**：否则装出去的是个空目录，宿主那边根本不会加载。
  if (!existsSync(source)) {
    errors.push(`skill source not found: ${source}`);
    return { ok: false, lines, errors, skipped: [] };
  }

  const canonical = canonicalPath(opts.userHome);

  // ⚠️ source 不能是 canonical 自己：那会装出一条**指向自己的断链**（自指循环），
  // 而且命令还会返回 0（2026-11-10 评审 P1-2）。`--target` 早有同类检查，source 之前漏了。
  // ⚠️ 这个检查**排在 SKILL.md 校验之前**：canonical 里面有子目录（references/），
  // 拿它当 source 时更根本的问题是"自指"，不是"没有 SKILL.md"。
  const selfLink = selfLinkReason(source, canonical);
  if (selfLink) {
    errors.push(
      `--source ${source} ${selfLink} (${canonical}) — refusing to link it to itself`,
    );
    return { ok: false, lines, errors, skipped: [] };
  }

  if (!existsSync(join(source, "SKILL.md"))) {
    errors.push(`skill source has no SKILL.md: ${source} (not a skill directory?)`);
    return { ok: false, lines, errors, skipped: [] };
  }

  // `--target` 不能等于 canonical 本身或它的父目录：
  //   - 等于 canonical   → 自链（link 指向自己）
  //   - 等于 canonical 的父目录 → canonical 就在那儿，等于让 canonical 自己链到自己
  // 也不能指到 canonical **里面**（2026-11-10 第三轮评审 P2-a）：
  //   - copy 模式 ⇒ 在装好的 skill 目录里建出指向自己祖先的环（hashDir 跳过软链 ⇒ 告警看不见）；
  //   - link 模式 + canonical 是软链 ⇒ 软链落进**源码树**（仓库里凭空多一个文件）。
  for (const t of opts.targets ?? []) {
    const dir = resolve(t);
    if (dir === canonical || dir === dirname(canonical) || samePath(dir, canonical)) {
      errors.push(
        `--target ${dir} is the canonical location itself (${canonical}) — refusing to link it to itself`,
      );
      return { ok: false, lines, errors, skipped: [] };
    }
    const linkPath = join(dir, SKILL_NAME);
    if (linkPathInsideCanonical(linkPath, canonical)) {
      errors.push(
        `--target ${dir} would put a link inside the canonical location (${canonical}) — refusing`,
      );
      return { ok: false, lines, errors, skipped: [] };
    }
  }

  const info = inspectCanonical(canonical, source);
  const version = currentVersion();

  /**
   * 跑一次可能抛 I/O 错误的写操作。
   *
   * 失败 ⇒ 记进 `errors` 并返回 false（**不往上抛**）：canonical 阶段的 I/O 失败
   * 是一次"安装没成功"，不是"命令用错了" ⇒ CLI 退出码应该是 1 而不是 2。
   */
  /** canonical 为什么不能给宿主链用（给用户看的解释）。null = 可以。 */
  let canonicalProblem: string | null = null;
  const attempt = (what: string, fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      // ⚠️ attempt 只用于 canonical 阶段的写操作 ⇒ 这里失败 = canonical 没更新成功
      canonicalProblem = "the canonical copy could not be updated";
      return false;
    }
  };

  const doCopy = (): void => {
    copyAtomically(source, canonical);
    writeMarker(canonical, {
      skill: SKILL_NAME,
      version,
      sha: hashDir(canonical) ?? "",
      source,
    });
  };

  /**
   * canonical 现在是不是"一份可用的安装"？
   * 只有 true 时才给宿主建链——否则宿主会被链到一个不是 bundled skill 的目录上。
   */
  let canonicalReady = false;

  switch (info.state) {
    case "missing": {
      if (mode === "link") {
        // 目标就是 source
        if (!attempt(`link ${canonical}`, () => linkAtomically(canonical, source))) break;
        lines.push(`linked   ${canonical} -> ${source}`);
      } else {
        if (!attempt(`install ${canonical}`, doCopy)) break;
        lines.push(`installed ${canonical} (copy of v${version})`);
      }
      canonicalReady = true;
      break;
    }

    case "link-to-source": {
      if (mode === "link") {
        lines.push(`skip     ${canonical} (already linked to the source)`);
      } else {
        const go = await confirm(
          `${canonical} is already linked to ${info.target}. Replace it with a copy?`,
          true,
        );
        if (go) {
          // ⚠️ 不用先 rm：copyAtomically 自己就是原子替换（旧的挪开、新的换位、失败回滚）。
          if (!attempt(`install ${canonical}`, doCopy)) break;
          lines.push(`installed ${canonical} (copy of v${version}, replaced the link)`);
        } else {
          lines.push(`skip     ${canonical} (kept the existing link)`);
        }
      }
      canonicalReady = true;
      break;
    }
    case "link-elsewhere": {
      const go = await confirm(
        `${canonical} points to ${info.target}, not to the bundled skill. Repoint it?`,
        true,
      );
      if (go) {
        if (!attempt(`install ${canonical}`, () => {
          if (mode === "link") linkAtomically(canonical, source);
          else doCopy();
        })) break;
        lines.push(
          mode === "link"
            ? `linked   ${canonical} -> ${source}`
            : `installed ${canonical} (copy of v${version}, replaced the old link)`,
        );
        canonicalReady = true;
      } else {
        lines.push(`skip     ${canonical} (kept the existing link)`);
        // ⚠️ canonical 仍指向别处 ⇒ **不要**再给宿主建链，
        // 否则宿主会被链到一个"不是 bundled skill"的目录上。
        canonicalReady = false;
        canonicalProblem = "the canonical copy still points somewhere else";
      }
      break;
    }
    case "managed-copy": {
      if (mode === "link") {
        const go = await confirm(
          `${canonical} is an installed copy (v${info.marker?.version}). Replace it with a link to ${source}?`,
          true,
        );
        if (go) {
          // ⚠️ 原子替换：先建好新链再换位。直接 rm 再建的话，
          // symlinkSync 失败就**永久丢了这份安装**（2026-11-10 评审 P2-2）。
          if (!attempt(`link ${canonical}`, () => linkAtomically(canonical, source))) break;
          lines.push(`linked   ${canonical} -> ${source}`);
          canonicalReady = true;
        } else {
          lines.push(`skip     ${canonical} (kept the installed copy)`);
          canonicalReady = true; // 保留的那份仍然是可用的安装
        }
        break;
      }
      if (info.updateAvailable || info.modified) {
        // 版本落后 ⇒ 问"是否更新"；版本一致但被手改 ⇒ 也得问，否则用户的修改会被静默忽略。
        const question = info.updateAvailable
          ? `Installed copy is v${info.marker?.version}; this package ships v${version}. Update?` +
            (info.modified ? " It has local modifications — updating will overwrite them." : "")
          : `The installed copy (v${info.marker?.version}) has local modifications. ` +
            `Replace it with the bundled v${version}?`;
        const go = await confirm(question, !info.modified);
        if (go) {
          if (!attempt(`install ${canonical}`, doCopy)) break;
          lines.push(
            info.updateAvailable
              ? `updated  ${canonical} (v${info.marker?.version} -> v${version})`
              : `restored ${canonical} (replaced the modified copy with v${version})`,
          );
        } else {
          lines.push(`skip     ${canonical} (kept v${info.marker?.version})`);
        }
        canonicalReady = true;
      } else {
        lines.push(`skip     ${canonical} (already up to date, v${info.marker?.version})`);
        canonicalReady = true;
      }
      break;
    }
    case "adoptable": {
      if (mode === "link") {
        const go = await confirm(
          `${canonical} holds the bundled skill but was not installed by agent-ex. Replace it with a link to ${source}?`,
          true,
        );
        if (go) {
          if (!attempt(`link ${canonical}`, () => linkAtomically(canonical, source))) break;
          lines.push(`linked   ${canonical} -> ${source}`);
        } else {
          lines.push(`skip     ${canonical} (kept the existing directory)`);
        }
      } else {
        if (!attempt(`adopt ${canonical}`, () => writeMarker(canonical, {
          skill: SKILL_NAME,
          version,
          sha: hashDir(canonical) ?? "",
          source,
        }))) break;
        lines.push(`adopted  ${canonical} (content matches v${version})`);
      }
      // 无论认领还是跳过，目录里就是 bundled skill 的内容 ⇒ 宿主链上去是安全的。
      canonicalReady = true;
      break;
    }
    case "foreign-dir": {
      errors.push(
        `${canonical} exists and was not installed by agent-ex (no marker, and its content differs from the bundled skill). ` +
          `agent-ex will not overwrite it — move it aside, then retry.`,
      );
      return { ok: false, lines, errors, skipped: [] };
    }
  }

  // ---- 宿主链接 ----
  const explicit = new Set((opts.targets ?? []).map((t) => resolve(t)));
  /** 显式点名（`--agent <名字>`）的宿主 ⇒ 直接建链，不问。 */
  const namedHosts = new Set(selected.ids);
  /** `--agent '*'`：全部需要建链的宿主（autoBridge 的除外——它自己会桥接）。 */
  const starSelected = selected.all;
  /**
   * 用户点名了宿主（`--agent`）⇒ **只**装点名的那些。
   *
   * ⚠️ 为什么不是"点名 = 额外再装一个"：宿主是**自动探测**的，
   * 加法语义下 `--agent cursor` 会顺手把本机装着的 Claude Code 也链上，
   * 用户没法说"我只要 Cursor"。--target 才是加法（它点名的是目录，没有自动探测这回事）。
   */
  const agentFilter = namedHosts.size > 0 || starSelected;
  /** 已经被宿主循环处理过的目录（避免下面"额外的 --target 目录"重复处理）。 */
  const handledDirs = new Set<string>();
  if (!canonicalReady) {
    // canonical 不是一份可用的安装（用户拒绝了重指，或写失败）⇒ 宿主链过去只会链到错的东西。
    lines.push(
      `skip     host links (${canonicalProblem ?? "the canonical copy is not a usable install of the bundled skill"})`,
    );
  }
  for (const host of SKILL_HOSTS) {
    if (!canonicalReady) break;
    // ⚠️ 直读共享目录的宿主（codex / cline / zed）**永远不建链**：
    // 它们的 relDir 就是 `~/.agents/skills` ⇒ 建出来的"链"就是 canonical 自己，
    // 卸载时还会把 canonical 当成宿主链删掉。
    if (host.readsCanonical) continue;
    const dir = hostDir(opts.userHome, host);
    const named = namedHosts.has(host.id);
    // 点名了宿主 ⇒ 没被点名的**一个都不碰**。
    if (agentFilter && !named && !starSelected) continue;
    const isExplicit = explicit.has(resolve(dir)) || named;
    const picked = isExplicit || starSelected;
    const linkPath = join(dir, SKILL_NAME);
    const st = inspectTarget(linkPath);
    // ⚠️ 在场判据是**配置根目录**（`~/.claude` 之类），不是 skills 目录：
    // skills 目录常常是我们自己建出来的，拿它当判据 ⇒ 装过一次就永远"在场"。
    // 已经有条目的照旧处理（重跑一次要能看到"已经是这条链"）。
    if (!picked && !hostPresent(opts.userHome, host) && st.kind === "missing") continue;
    // 这个目录归宿主循环管了 ⇒ 下面"额外的 --target 目录"那一段别再来一遍。
    handledDirs.add(resolve(dir));

    try {
      if (st.kind === "link" && pointsAtCanonical(st.target, canonical)) {
        lines.push(`linked   ${linkPath} (already points at the canonical copy)`);
        continue;
      }
      if (st.kind === "link") {
        // 已有一条指向别处的链 —— 自动桥接机制**不会**接管它，必须主动重指。
        // ⚠️ 这条对"不建链"的宿主（直读共享目录的 codex / cline / zed）同样成立：
        // "不建链"限定的是**没有条目**时要不要新建，不是"放着一条旧链不管"
        // （spec §4.4）。放着不管 ⇒ status/doctor 永远告警，而告警给的修法还修不了。
        const go = isExplicit
          ? true
          : await confirm(
              `${linkPath} points to ${st.target}, not at the canonical copy. Repoint it?`,
              true,
            );
        if (go) {
          // ⚠️ 原子替换：旧的链还在时先把新链建好再换位。
          // 「先删后建」的话，symlinkSync 一失败旧链已经没了（2026-11-10 第三轮评审 P1-b）。
          replaceAtomically(linkPath, (tmp) => symlinkSync(canonical, tmp, "dir"));
          lines.push(`repointed ${linkPath} -> ${canonical}`);
        } else {
          lines.push(`skip     ${linkPath} (kept the existing link)`);
        }
        continue;
      }
      if (st.kind === "dir" || st.kind === "file") {
        lines.push(
          `skipped  ${linkPath} (exists and is not a symlink — agent-ex will not overwrite it; remove it by hand if it is stale)`,
        );
        continue;
      }
      if (st.kind === "broken-link") {
        // 断链：指向的目标没了。换成指向 canonical（同样原子替换）。
        replaceAtomically(linkPath, (tmp) => symlinkSync(canonical, tmp, "dir"));
        lines.push(`repaired ${linkPath} -> ${canonical}`);
        continue;
      }
      // ---- 没有条目 ----
      // ⚠️ autoBridge 的宿主（WorkBuddy）自己会桥接 ⇒ 不建多余的链。
      // 但**显式点名**（`--agent workbuddy` / `--target …`）时以用户为准：他要什么给什么。
      if (!isExplicit && host.autoBridge && host.autoBridge(opts.userHome)) {
        lines.push(
          `note     ${host.label} bridges ${join(opts.userHome, ".agents/skills")} automatically — no link needed`,
        );
        continue;
      }
      // 显式点名（`--agent`）或 `--agent '*'` ⇒ 直接建，不问。
      const go = isExplicit || starSelected
        ? true
        : await confirm(`Link the dispatch skill into ${host.label} (${dir})?`, true);
      if (go) {
        symlinkAt(linkPath, canonical);
        lines.push(`linked   ${linkPath} -> ${canonical}`);
      } else {
        lines.push(`skip     ${linkPath} (not linked)`);
      }
    } catch (e) {
      errors.push(`${linkPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- 显式 --target 的目录（不在宿主表里的）----
  for (const t of opts.targets ?? []) {
    if (!canonicalReady) break;
    const dir = resolve(t);
    // ⚠️ 宿主循环已经处理过的目录别再来一遍（--agent 过滤时，宿主可能被跳过了，
    // 但用户仍然用 --target 明确点名了那个目录 ⇒ 该装还得装）。
    if (handledDirs.has(dir)) continue;
    const linkPath = join(dir, SKILL_NAME);
    const st = inspectTarget(linkPath);
    if (st.kind === "link" && pointsAtCanonical(st.target, canonical)) {
      lines.push(`linked   ${linkPath} (already points at the canonical copy)`);
      continue;
    }
    try {
      if (st.kind === "dir" || st.kind === "file") {
        lines.push(`skipped  ${linkPath} (exists and is not a symlink — not overwritten)`);
        continue;
      }
      replaceAtomically(linkPath, (tmp) => symlinkSync(canonical, tmp, "dir"));
      lines.push(`linked   ${linkPath} -> ${canonical}`);
    } catch (e) {
      errors.push(`${linkPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ⚠️ install 的 "skipped" 只是**说明**（比如宿主目录里已有一个不是软链的实体目录）：
  // canonical 装成功了 ⇒ 退出码仍然是 0。remove 不一样：卸载的目的就是让东西消失，
  // 还留着东西就不算成功。
  return { ok: errors.length === 0, lines, errors, skipped: [] };
}
/**
 * 卸载。
 *
 * 规则见 design §4.5：
 * - 宿主目录下的**软链一律删**（删链接不丢数据），并打印它原本指向哪；
 * - **实体目录一律不删**（可能是用户自己的）⇒ 记进 `skipped`，**结果不是"干净"**（退出码非 0）；
 * - canonical：`managed-copy` / `adoptable` ⇒ 删目录；软链 ⇒ 只删链接；
 * - **先删宿主链、后删 canonical**（反过来会留断链）。
 *   ⇒ **宿主链删不掉时就别删 canonical**：留着 canonical，断的只是链；
 *   删了 canonical 还留着链，断的是整份 skill。
 */
export async function removeSkill(opts: RemoveOptions): Promise<SkillActionResult> {
  const lines: string[] = [];
  const errors: string[] = [];
  /** 留着没删的东西。 */
  const skipped: string[] = [];
  const yes = opts.yes ?? false;
  // 同 installSkill：没人能答问题时**拒绝执行**，不默认按"是"放行。
  const confirm: ConfirmFn =
    opts.confirm ??
    (async (q, _def) => {
      if (yes) return true;
      throw new Error(
        `cannot ask interactively: "${q}" — pass yes: true (accept every answer) or a confirm callback`,
      );
    });

  const dirs = (opts.targets ?? []).map((t) => resolve(t));
  // ⚠️ `--agent` 的名字**先校验**：认不出来就别动磁盘。
  const selected = resolveAgentSelection(opts.agents ?? []);
  if (selected.unknown.length > 0) {
    errors.push(
      `unknown host${selected.unknown.length > 1 ? "s" : ""}: ${selected.unknown.join(", ")}. ` +
        `Valid names: ${hostSelectorNames().join(", ")}.`,
    );
    return { ok: false, lines, errors, skipped };
  }
  /** 显式点名要清的宿主（`--agent`）。直读共享目录的宿主没有自己的条目 ⇒ 跳过。 */
  const namedHosts = new Set(selected.ids);
  const namedDirs = SKILL_HOSTS.filter((h) => namedHosts.has(h.id) && !h.readsCanonical).map((h) =>
    hostDir(opts.userHome, h),
  );
  for (const h of SKILL_HOSTS) {
    if (namedHosts.has(h.id) && h.readsCanonical) {
      lines.push(`note     ${h.label} reads the shared directory — nothing to remove there`);
    }
  }
  // 指定了宿主/目录 ⇒ **只**清那些地方，canonical 留着（跟 `--target` 一个规矩）。
  // `--agent` 是**宿主过滤器**，不是"全量卸载"的另一种写法：`--agent '*'` 也只清宿主链。
  const explicitOnly = dirs.length > 0 || selected.ids.length > 0 || selected.all;

  if (!yes) {
    const what = selected.all ? "all hosts" : [...dirs, ...namedDirs].join(", ");
    const go = await confirm(
      explicitOnly
        ? `Remove the dispatch skill from ${what}?`
        : "Remove the dispatch skill (canonical copy and host links)?",
      true,
    );
    if (!go) {
      lines.push("aborted");
      return { ok: true, lines, errors, skipped };
    }
  }

  // ---- 宿主链接（先删）----
  // ⚠️ 直读共享目录的宿主（codex / cline / zed）**必须排除**：它们的"条目"就是 canonical 自己，
  // 当成宿主链删掉 ⇒ 卸载把 canonical 删了，却报告成"删了几条宿主链"。
  const allHostDirs = linkableHosts().map((h) => hostDir(opts.userHome, h));
  const hostDirs = explicitOnly
    ? [...new Set([...dirs, ...namedDirs, ...(selected.all ? allHostDirs : [])])]
    : allHostDirs;
  /** 宿主链有没有删失败的？删失败 ⇒ canonical 不能删（见函数注释）。 */
  let hostLinkFailed = false;
  for (const dir of hostDirs) {
    const linkPath = join(dir, SKILL_NAME);
    const st = inspectTarget(linkPath);
    if (st.kind === "missing") continue;
    if (st.kind === "link" || st.kind === "broken-link") {
      try {
        rmSync(linkPath, { force: true });
        lines.push(`removed  ${linkPath}${st.target ? ` (was -> ${st.target})` : ""}`);
      } catch (e) {
        hostLinkFailed = true;
        errors.push(`${linkPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    skipped.push(linkPath);
    lines.push(
      `skipped  ${linkPath} (not a symlink — agent-ex did not create it; remove it by hand if you want it gone)`,
    );
  }

  // ---- canonical（后删）----
  if (!explicitOnly) {
    const canonical = canonicalPath(opts.userHome);
    if (hostLinkFailed && existsSync(canonical)) {
      // ⚠️ 先链后 canonical：宿主链还在（删不掉），canonical 先别动 ——
      // 删了 canonical，留在原地的链就全成了断链。
      // ⚠️ 只有 canonical **真的存在**时才说"kept"；它压根不存在时说"kept"是误导。
      skipped.push(canonical);
      lines.push(
        `kept     ${canonical} (some host links could not be removed — deleting it now would leave them dangling)`,
      );
    } else {
      const info = inspectCanonical(canonical, opts.source ?? resolveBundledSkillDir());
      try {
        if (info.state === "managed-copy" || info.state === "adoptable") {
          rmSync(canonical, { recursive: true, force: true });
          lines.push(`removed  ${canonical} (installed copy)`);
        } else if (info.state === "link-to-source" || info.state === "link-elsewhere") {
          rmSync(canonical, { force: true });
          lines.push(`removed  ${canonical} (symlink${info.target ? ` -> ${info.target}` : ""})`);
        } else if (info.state === "foreign-dir") {
          skipped.push(canonical);
          lines.push(
            `skipped  ${canonical} (not installed by agent-ex — remove it by hand if you want it gone)`,
          );
        }
      } catch (e) {
        errors.push(`${canonical}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // ---- 顺手清掉自己留下的临时物 ----
    // 安装过程用 `.${SKILL_NAME}.tmp.<pid>` / `.old.<pid>` 做原子替换；
    // 进程被 kill 时它们会留在 canonical 的父目录里。
    // ⇒ "卸载干净"就得把它们也清掉（它们是 agent-ex 自己的产物，不是用户数据）。
    for (const leftover of listLeftovers(dirname(canonical))) {
      try {
        rmSync(leftover, { recursive: true, force: true });
        lines.push(`removed  ${leftover} (leftover from an interrupted install)`);
      } catch (e) {
        errors.push(`${leftover}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { ok: errors.length === 0 && skipped.length === 0, lines, errors, skipped };
}

/** canonical 父目录里 agent-ex 自己留下的临时物（`.agent-ex-dispatch.tmp.*` / `.old.*`）。 */
function listLeftovers(parent: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.startsWith(`.${SKILL_NAME}.tmp.`) || n.startsWith(`.${SKILL_NAME}.old.`))
    .map((n) => join(parent, n));
}
