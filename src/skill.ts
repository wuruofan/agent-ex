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
import { dirname, join, relative, resolve, sep } from "node:path";
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
  /** 该宿主是否自带"从 ~/.agents/skills 自动桥接"的机制。有就别手工建链。 */
  autoBridge?: (userHome: string) => boolean;
}

/**
 * 已知宿主。
 *
 * ⚠️ `codex` / `opencode` **未验证**该宿主真的会读自己的 skills 目录（本机 `~/.codex/skills`
 * 只有 `.system/`、`~/.config/opencode/skills` 是空的）⇒ 默认**不链**，只允许 `--target` 显式指定。
 */
export const SKILL_HOSTS: readonly SkillHost[] = [
  { id: "claude", label: "Claude Code", relDir: ".claude/skills" },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    relDir: ".workbuddy/skills",
    autoBridge: (userHome) => workBuddyBridges(userHome),
  },
  { id: "trae-cn", label: "Trae", relDir: ".trae-cn/skills" },
  { id: "codex", label: "Codex", relDir: ".codex/skills" },
  { id: "opencode", label: "OpenCode", relDir: ".config/opencode/skills" },
];

/**
 * WorkBuddy 是否会自动把 `~/.agents/skills/*` 桥接进 `~/.workbuddy/skills`。
 *
 * 判据是**探测**而不是硬编码：看那个 hook 文件在不在。
 * 该 hook 支持 `AGENTS_SKILLS_DIR` / `WORKBUDDY_SKILLS_DIR` 覆盖 ⇒ 可以在临时目录里隔离验证它的行为。
 *
 * ⚠️ 还要看排除表：hook 会**主动删掉**被排除名字的链（`.excluded-skill-names`）。
 * 若 `agent-ex-dispatch` 在排除表里，我们建的链下次会话就没了 ⇒ 那种情况不能算"自动桥接"。
 */
export function workBuddyBridges(userHome: string): boolean {
  const hook = join(userHome, ".workbuddy/hooks/sync-agents-skills.sh");
  if (!existsSync(hook)) return false;
  const excluded = join(userHome, ".workbuddy/skills/.excluded-skill-names");
  try {
    const text = readFileSync(excluded, "utf8");
    const hit = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .some((l) => l === SKILL_NAME);
    if (hit) return false;
  } catch {
    // 没有排除表 ⇒ 全部桥接
  }
  return true;
}

/** 宿主 skills 目录的绝对路径。 */
export function hostDir(userHome: string, host: SkillHost): string {
  return join(userHome, host.relDir);
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
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
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
    return { path: canonical, state, target };
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
  hosts: Array<{ host: SkillHost; dir: string; state: TargetState; autoBridge: boolean }>;
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
    | "skill.hosts-unlinked";
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

  const unlinked = st.hosts.filter(
    (h) => h.state.kind === "missing" && !h.autoBridge && existsSync(h.dir),
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
  ok: boolean;
  lines: string[];
  errors: string[];
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
  /** 跳过所有提问（默认 true）。 */
  yes?: boolean;
  /** 提问回调。 */
  confirm?: ConfirmFn;
}

export interface RemoveOptions {
  userHome: string;
  source?: string;
  /** 只移除这些目录下的条目；**不给则连 canonical 一起移除**。 */
  targets?: string[];
  yes?: boolean;
  confirm?: ConfirmFn;
}

/**
 * 原子拷贝：先写同目录临时目录，再把旧的挪开、rename 到位。
 *
 * ⇒ 宿主永远读不到"写了一半"的 skill；失败时 canonical 原封不动。
 */
function copyAtomically(source: string, canonical: string): void {
  const parent = dirname(canonical);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.${SKILL_NAME}.tmp.${process.pid}`);
  const old = join(parent, `.${SKILL_NAME}.old.${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  cpSync(source, tmp, { recursive: true });
  const hadOld = existsSync(canonical);
  if (hadOld) renameSync(canonical, old);
  try {
    renameSync(tmp, canonical);
  } catch (e) {
    if (hadOld) {
      try {
        renameSync(old, canonical);
      } catch {
        /* 回滚失败：old 留在原处，交给用户 */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
}

/** 建一条宿主软链（先 lstat，**绝不用 shell ln**——ln 对已存在的目录目标不报错）。 */
function linkHost(dir: string, canonical: string): void {
  mkdirSync(dir, { recursive: true });
  const linkPath = join(dir, SKILL_NAME);
  const st = inspectTarget(linkPath);
  if (st.kind === "link") rmSync(linkPath, { force: true });
  else if (st.kind === "dir" || st.kind === "file") {
    throw new Error(`${linkPath} exists and is not a symlink`);
  }
  symlinkSync(canonical, linkPath, "dir");
}

/**
 * 安装。
 *
 * 流程与动作矩阵见 design §4.2 / §4.3。要点：
 * - canonical 是**固定**路径，状态分六态，每态有确定动作；
 * - `managed-copy` 且版本落后 ⇒ **问"是否更新"**；
 * - `foreign-dir` ⇒ **中止**，目录内容一字未改；
 * - 宿主链接：**显式 `--target` > 已有指向别处的链（重指）> autoBridge（不建链）> 其余问**。
 */
export async function installSkill(opts: InstallOptions): Promise<SkillActionResult> {
  const lines: string[] = [];
  const errors: string[] = [];
  const source = opts.source ?? resolveBundledSkillDir();
  const mode = opts.mode ?? "copy";
  const yes = opts.yes ?? false;
  const confirm: ConfirmFn = opts.confirm ?? (async (_q, def) => def);

  if (!existsSync(source)) {
    errors.push(`skill source not found: ${source}`);
    return { ok: false, lines, errors };
  }

  const canonical = canonicalPath(opts.userHome);

  // `--target` 不能等于 canonical 本身或它的父目录：
  //   - 等于 canonical   → 自链（link 指向自己）
  //   - 等于 canonical 的父目录 → canonical 就在那儿，等于让 canonical 自己链到自己
  for (const t of opts.targets ?? []) {
    const dir = resolve(t);
    if (dir === canonical || dir === dirname(canonical)) {
      errors.push(
        `--target ${dir} is the canonical location itself (${canonical}) — refusing to link it to itself`,
      );
      return { ok: false, lines, errors };
    }
  }

  const info = inspectCanonical(canonical, source);
  const version = currentVersion();

  const doCopy = (): void => {
    copyAtomically(source, canonical);
    writeMarker(canonical, {
      skill: SKILL_NAME,
      version,
      sha: hashDir(canonical) ?? "",
      source,
    });
  };

  switch (info.state) {
    case "missing": {
      if (mode === "link") {
        linkHost(dirname(canonical), source); // 目标就是 source
        lines.push(`linked   ${canonical} -> ${source}`);
      } else {
        doCopy();
        lines.push(`installed ${canonical} (copy of v${version})`);
      }
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
          rmSync(canonical, { force: true });
          doCopy();
          lines.push(`installed ${canonical} (copy of v${version}, replaced the link)`);
        } else {
          lines.push(`skip     ${canonical} (kept the existing link)`);
        }
      }
      break;
    }
    case "link-elsewhere": {
      const go = await confirm(
        `${canonical} points to ${info.target}, not to the bundled skill. Repoint it?`,
        true,
      );
      if (go) {
        rmSync(canonical, { force: true });
        if (mode === "link") linkHost(dirname(canonical), source);
        else doCopy();
        lines.push(
          mode === "link"
            ? `linked   ${canonical} -> ${source}`
            : `installed ${canonical} (copy of v${version}, replaced the old link)`,
        );
      } else {
        lines.push(`skip     ${canonical} (kept the existing link)`);
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
          rmSync(canonical, { recursive: true, force: true });
          linkHost(dirname(canonical), source);
          lines.push(`linked   ${canonical} -> ${source}`);
        } else {
          lines.push(`skip     ${canonical} (kept the installed copy)`);
        }
        break;
      }
      if (info.updateAvailable) {
        const warn = info.modified
          ? " It has local modifications — updating will overwrite them."
          : "";
        const go = await confirm(
          `Installed copy is v${info.marker?.version}; this package ships v${version}. Update?${warn}`,
          !info.modified,
        );
        if (go) {
          doCopy();
          lines.push(`updated  ${canonical} (v${info.marker?.version} -> v${version})`);
        } else {
          lines.push(`skip     ${canonical} (kept v${info.marker?.version})`);
        }
      } else {
        lines.push(`skip     ${canonical} (already up to date, v${info.marker?.version})`);
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
          rmSync(canonical, { recursive: true, force: true });
          linkHost(dirname(canonical), source);
          lines.push(`linked   ${canonical} -> ${source}`);
        } else {
          lines.push(`skip     ${canonical} (kept the existing directory)`);
        }
      } else {
        writeMarker(canonical, {
          skill: SKILL_NAME,
          version,
          sha: hashDir(canonical) ?? "",
          source,
        });
        lines.push(`adopted  ${canonical} (content matches v${version})`);
      }
      break;
    }
    case "foreign-dir": {
      errors.push(
        `${canonical} exists and was not installed by agent-ex (no marker, and its content differs from the bundled skill). ` +
          `agent-ex will not overwrite it — move it aside, then retry.`,
      );
      return { ok: false, lines, errors };
    }
  }

  // ---- 宿主链接 ----
  const explicit = new Set((opts.targets ?? []).map((t) => resolve(t)));
  for (const host of SKILL_HOSTS) {
    const dir = hostDir(opts.userHome, host);
    const isExplicit = explicit.has(resolve(dir));
    if (!isExplicit && !existsSync(dir)) continue; // 没这个宿主的目录 ⇒ 不打扰
    const linkPath = join(dir, SKILL_NAME);
    const st = inspectTarget(linkPath);

    try {
      if (st.kind === "link" && st.target === realOrSelf(canonical)) {
        lines.push(`linked   ${linkPath} (already points at the canonical copy)`);
        continue;
      }
      if (st.kind === "link") {
        // 已有一条指向别处的链 —— 自动桥接机制**不会**接管它，必须主动重指。
        const go = isExplicit
          ? true
          : await confirm(
              `${linkPath} points to ${st.target}, not at the canonical copy. Repoint it?`,
              true,
            );
        if (go) {
          rmSync(linkPath, { force: true });
          symlinkSync(canonical, linkPath, "dir");
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
        // 断链：指向的目标没了。直接换成指向 canonical。
        rmSync(linkPath, { force: true });
        symlinkSync(canonical, linkPath, "dir");
        lines.push(`repaired ${linkPath} -> ${canonical}`);
        continue;
      }
      // 没有条目
      if (!isExplicit && host.autoBridge && host.autoBridge(opts.userHome)) {
        lines.push(
          `note     ${host.label} bridges ${join(opts.userHome, ".agents/skills")} automatically — no link needed`,
        );
        continue;
      }
      const go = isExplicit
        ? true
        : await confirm(`Link the dispatch skill into ${host.label} (${dir})?`, true);
      if (go) {
        mkdirSync(dir, { recursive: true });
        symlinkSync(canonical, linkPath, "dir");
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
    const dir = resolve(t);
    if (SKILL_HOSTS.some((h) => resolve(hostDir(opts.userHome, h)) === dir)) continue;
    const linkPath = join(dir, SKILL_NAME);
    const st = inspectTarget(linkPath);
    if (st.kind === "link" && st.target === realOrSelf(canonical)) {
      lines.push(`linked   ${linkPath} (already points at the canonical copy)`);
      continue;
    }
    try {
      if (st.kind === "dir" || st.kind === "file") {
        lines.push(`skipped  ${linkPath} (exists and is not a symlink — not overwritten)`);
        continue;
      }
      rmSync(linkPath, { force: true });
      mkdirSync(dir, { recursive: true });
      symlinkSync(canonical, linkPath, "dir");
      lines.push(`linked   ${linkPath} -> ${canonical}`);
    } catch (e) {
      errors.push(`${linkPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ok: errors.length === 0, lines, errors };
}
/**
 * 卸载。
 *
 * 规则见 design §4.5：
 * - 宿主目录下的**软链一律删**（删链接不丢数据），并打印它原本指向哪；
 * - **实体目录一律不删**（可能是用户自己的）；
 * - canonical：`managed-copy` / `adoptable` ⇒ 删目录；软链 ⇒ 只删链接；
 * - **先删宿主链、后删 canonical**（反过来会留断链）。
 */
export async function removeSkill(opts: RemoveOptions): Promise<SkillActionResult> {
  const lines: string[] = [];
  const errors: string[] = [];
  const yes = opts.yes ?? false;
  const confirm: ConfirmFn = opts.confirm ?? (async (_q, def) => def);

  const dirs = (opts.targets ?? []).map((t) => resolve(t));
  const explicitOnly = dirs.length > 0;

  if (!yes) {
    const go = await confirm(
      explicitOnly
        ? `Remove the dispatch skill from ${dirs.join(", ")}?`
        : "Remove the dispatch skill (canonical copy and host links)?",
      true,
    );
    if (!go) {
      lines.push("aborted");
      return { ok: true, lines, errors };
    }
  }

  // ---- 宿主链接（先删）----
  const hostDirs = explicitOnly
    ? dirs
    : SKILL_HOSTS.map((h) => hostDir(opts.userHome, h));
  for (const dir of hostDirs) {
    const linkPath = join(dir, SKILL_NAME);
    const st = inspectTarget(linkPath);
    if (st.kind === "missing") continue;
    if (st.kind === "link" || st.kind === "broken-link") {
      try {
        rmSync(linkPath, { force: true });
        lines.push(`removed  ${linkPath}${st.target ? ` (was -> ${st.target})` : ""}`);
      } catch (e) {
        errors.push(`${linkPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    lines.push(
      `skipped  ${linkPath} (not a symlink — agent-ex did not create it; remove it by hand if you want it gone)`,
    );
  }

  // ---- canonical（后删）----
  if (!explicitOnly) {
    const canonical = canonicalPath(opts.userHome);
    const info = inspectCanonical(canonical, opts.source ?? resolveBundledSkillDir());
    try {
      if (info.state === "managed-copy" || info.state === "adoptable") {
        rmSync(canonical, { recursive: true, force: true });
        lines.push(`removed  ${canonical} (installed copy)`);
      } else if (info.state === "link-to-source" || info.state === "link-elsewhere") {
        rmSync(canonical, { force: true });
        lines.push(`removed  ${canonical} (symlink${info.target ? ` -> ${info.target}` : ""})`);
      } else if (info.state === "foreign-dir") {
        lines.push(
          `skipped  ${canonical} (not installed by agent-ex — remove it by hand if you want it gone)`,
        );
      }
    } catch (e) {
      errors.push(`${canonical}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ok: errors.length === 0, lines, errors };
}
