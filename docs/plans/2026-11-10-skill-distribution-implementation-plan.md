# `agent-ex skill` 子命令 + skill 随包分发 — 实施计划

日期：2026-11-10
设计文档：`docs/designs/2026-11-10-skill-distribution.md`（下称 **design**）
先例参照：`docs/plans/2026-10-30-wait-cli-implementation-plan.md`（同构：「skill 能力 → CLI 子命令」）

---

## 已定死的决策（design 已定，plan 不得再改）

| # | 决策 | 出处 |
| :--- | :--- | :--- |
| D1 | skill 打进 npm 包；`files` 加 `"skills/agent-ex-dispatch"`（**不写 `"skills"`**） | design §3 |
| D2 | 子命令：`agent-ex skill install` / `remove` / `status` | design §3 |
| D3 | **不做 `update`** | design §3 |
| D4 | 用户路线=拷贝，开发者路线=软链（`--link`） | design §3 |
| D5 | canonical **固定**在 `~/.agents/skills/agent-ex-dispatch`（不开放覆盖：自动桥接只认这个源），每宿主一条软链指向 canonical | design §3 |
| D6 | init **只打印** `agent-ex skill install`，不执行安装 | design §3 |
| D7 | init 收尾信息实测 39 行 → 24 行（非默认 home 30 行）；`AGENT_EX_HOME` **只在非默认路径时**保留 export 那一步，同时写进 MCP 片段的 `env` | design §6 |
| D8 | doctor 加 skill 段（info 级）；**不进 `collectConfigIssues()`** | design §3 |
| D9 | **provenance 随内容走**：拷贝目录内写 `.agent-ex-skill.json`（版本 + sha）；归属判定只读那一个目录。版本 = 打包它的 agent-ex 包版本。**没有集中状态文件** | design §3 |
| D10 | canonical 六态状态机（missing / link→source / link→elsewhere / managed-copy / adoptable / foreign-dir）× 拷贝·软链两种模式，各有确定动作 | design §4.2 |

## Global Constraints（每个 task 都隐含包含）

1. **顶层 import 纪律**（AGENTS.md 硬约束 7）：`src/server.ts` 顶层只留 `env-file` / `brand` / `ansi` / `marks`。
   `src/skill.ts` 必须在 `server.ts` 的 `skill` 分支里**动态 import**；`src/skill.ts` 本身**不得** import
   `@modelcontextprotocol/sdk`、`zod`、`node:sqlite`（`src/store.ts` 会拖进 SQLite）。
   `tests/cli-env.test.ts` 的懒加载断言必须仍然通过。
2. **校验只有一个真相源**（AGENTS.md 硬约束 6）：宿主表与安装状态判定只写在 `src/skill.ts`，
   doctor 与 installer **同源消费**。不要在 `doctor.ts` 里另写一份宿主表。
3. **init 的用户可见输出全英文**（AGENTS.md 硬约束 1）：`src/init.ts` 里所有 `console.log/error`、
   `ask()`、`rl.question()` 行不得含中文字符。`tests/init.test.ts:217-232` 会扫。
4. **`ln` 陷阱**（`README.md:150-151`）：`ln -s` 对已存在的**目录**目标不报错，会把软链塞进目录里。
   ⇒ 一律用 `fs.symlinkSync` + 前置 `lstat` 检查，**禁止**调用 shell `ln`。
5. **绝不覆盖既有实体目录**（沿用 `scripts/install-skill.sh:90-94` 的 abort 语义）。
6. **不写密钥**：skill 目录里没有任何凭证，但安装日志也不要打印 `~/.agent-ex/.env` 的内容。
7. 提交信息用 Conventional Commits（英文），**不加** AI trailer。分支从 `main` 切。

## 文件地图（动手前先锁定）

| 文件 | 动作 | Task |
| :--- | :--- | :--- |
| `package.json` | 改 | T1 |
| `src/skill.ts` | **新建** | T2 / T3 / T5 |
| `src/skill-cmd.ts` | **新建** | T4 |
| `src/server.ts` | 改 | T4 |
| `src/doctor.ts` | 改 | T5 |
| `src/init.ts` | 改 | T6 |
| `scripts/install-skill.sh` | 改 | T7 |
| `skills/agent-ex-dispatch/SKILL.md` | 改（安装段 :9-11） | T8 |
| `AGENTS.md` | 改（:43 分发说明、:108 files 表） | T8 |
| `README.md` | 改（112-180、命令表、:726、:729-731） | T8 |
| `tests/skill.test.ts` | **新建** | T2 / T3 |
| `tests/doctor.test.ts` | 改 | T5 |
| `tests/init.test.ts` | 改 | T6 |
| `tests/cli-env.test.ts` | 改（加断言） | T4 |
| `docs/designs/2026-11-10-skill-distribution.md` | 已写 | — |
| `docs/plans/2026-11-10-skill-distribution-implementation-plan.md` | 本文件 | — |

⚠️ `src/cli.ts` **不在这个表里**：`runSkill` 放 `src/skill-cmd.ts`。
`src/cli.ts:8` 静态 import `./doctor.js` → `model-check.js` → `executors/types.js` → claude/opencode/fake，
把 `runSkill` 放那儿会让一个纯文件操作拖进整套 executor 依赖（不违反硬约束 7 的字面禁令，
但违反"每个分支都要用且便宜"的精神）。

---

## Task 1: 让 skill 真的进到 npm 包里

**为什么排第一**：后面所有任务都要能"从包内取到 skill"，这条不通就全都白做。

**改动**

1. `package.json` 的 `files` 加 `"skills/agent-ex-dispatch"`。
   ⚠️ 理由是**"只发这一个 skill"**（`skills/` 下未来新增的内容不该被动进包），
   **不是** "避开 `.DS_Store`"——实测 `files:["skills"]` 时 npm **也不会**打包 `.DS_Store`（已复现）。
2. 验证打包产物：

```bash
npm run build && npm pack --dry-run --json
# 产物里必须能看到 skills/agent-ex-dispatch/SKILL.md 与 references/*.md
```

**验收**

- `npm pack --dry-run --json` 的输出里含 `skills/agent-ex-dispatch/SKILL.md`。
- 输出里**不含** `skills/.DS_Store`（不是必须，但确认一下没意外带东西）。
- `dist/` 里**没有** skill 副本（skill 是独立目录，不进 dist）——
  这决定了 `src/skill.ts` 解析源目录时用的是 `../skills` 而不是 `dist/skills`。
- ⚠️ 包体积会涨：skill 目录 gzip 后 **63,532 B**，当前 0.3.1 包 126,477 B ⇒ **约 +50%**。
  README 与发布说明要写明，别让用户以为包变小了。

**注意**：源目录解析用 `resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", "agent-ex-dispatch")`。
源码模式（`src/skill.ts`）⇒ `<repo>/skills/...`；编译模式（`dist/skill.js`）⇒ `<pkg>/skills/...`。
两种都对，**不要**硬编码 `dist/skills`。

---

## Task 2: `src/skill.ts` 的只读层 —— 宿主表、hash、inspect

**职责**：只读。本 Task 不碰任何写操作。

**API**

```ts
/** 宿主表：数据，不是 if-else 分支。加一家宿主只加一行。 */
export interface SkillHost {
  id: string;
  label: string;
  /** 用户级 skills 目录（绝对路径）。 */
  dir: string;
  /** 该宿主是否自带"从 ~/.agents/skills 自动桥接"的机制。有就别手工建链。 */
  autoBridge?: (home: string) => boolean;
}
export const SKILL_HOSTS: readonly SkillHost[];

/** 解析本模块内置的那份 skill 目录（源码模式与编译模式都对）。 */
export function resolveBundledSkillDir(baseDir?: string): string;

/** 当前 agent-ex 包版本（= 打包这份 skill 的版本；skill 的"版本号"就是它）。 */
export function currentVersion(): string;

/** 目录内容指纹：sha256(排序后的 "相对路径\0内容")，取前 12 位 hex。 */
export function hashDir(dir: string): string | null;

/** canonical 的六态（design §4.2）。 */
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
  /** 软链的指向（绝对路径）。 */
  target?: string;
  /** managed-copy 时来自 marker。 */
  marker?: SkillMarker;
  /** 当前内容 hash。 */
  sha?: string;
  /** managed-copy 且 marker.version != currentVersion() ⇒ 需要更新。 */
  updateAvailable?: boolean;
  /** managed-copy 但当前 hash != marker.sha ⇒ 用户手改过。 */
  modified?: boolean;
}

/** 拷贝目录内的 provenance（design §4.2）。 */
export interface SkillMarker {
  skill: string;
  version: string;
  sha: string;
  source: string;
}

export function inspectCanonical(canonical: string, source: string): CanonicalInfo;
export function readMarker(dir: string): SkillMarker | null;
export function writeMarker(dir: string, m: SkillMarker): void;

export interface SkillStatus {
  bundled: { dir: string; version: string; sha: string | null; exists: boolean };
  canonical: CanonicalInfo;
  hosts: Array<{ host: SkillHost; state: TargetState; autoBridge: boolean }>;
}
export function skillStatus(opts: { userHome: string; source?: string }): SkillStatus;
```

⚠️ **`userHome` 与 `agentExHome` 必须分开**（design §6 / plan Task 5）：
`userHome` = `os.homedir()`（`~/.agents/skills` 在这底下），`agentExHome` = `$AGENT_EX_HOME`（配置在这）。
混用会让 doctor 去看 `~/.agent-ex/.agents/skills`（错）。

**宿主表初稿**（路径来自本机实测，design §2.3；**只放已验证的**）

| id | dir | autoBridge |
| :--- | :--- | :--- |
| `agents` | `~/.agents/skills` | —（canonical 落点，不是链接目标） |
| `claude` | `~/.claude/skills` | 无 |
| `workbuddy` | `~/.workbuddy/skills` | 有：`~/.workbuddy/hooks/sync-agents-skills.sh` 存在 |
| `trae-cn` | `~/.trae-cn/skills` | 无（路径随安装版本变，只在探测到时才提示） |
| `codex` | `~/.codex/skills` | ⚠️ **未验证该宿主真的会读 skills 目录** ⇒ 默认不链，只允许 `--target` 显式指定 |
| `opencode` | `~/.config/opencode/skills` | ⚠️ 同上（本机该目录为空） |

⚠️ `autoBridge` 的判据是**探测**（那个 hook 文件在不在），不是硬编码"WorkBuddy 有"。
hook 支持 `AGENTS_SKILLS_DIR` / `WORKBUDDY_SKILLS_DIR` 覆盖 ⇒ **可以隔离测试它的行为**
（design §2.4.2 的实测就是这么做的），不必假设。

**测试**（`tests/skill.test.ts`）

- `resolveBundledSkillDir()` 在源码模式下解析到 `<repo>/skills/agent-ex-dispatch`。
- `currentVersion()` 等于 `package.json` 的 version（源码模式与编译模式都对）。
- `hashDir()` 对同一目录两次调用结果相同；改动一个文件后结果不同；空目录返回固定值。
- `inspectCanonical()` 六态各一条：missing / link→source / link→elsewhere / managed-copy /
  adoptable（无 marker 但内容一致）/ foreign-dir（无 marker 且内容不同）。
- `readMarker()` / `writeMarker()` 往返；marker 损坏（非法 JSON）时返回 null 而不是崩。
- `skillStatus()` 能报出 `updateAvailable` 与 `modified`。
- **测试不得依赖开发机装了什么**：所有路径与宿主表都要可注入（`userHome` 参数 + 表的构造函数）。

---

## Task 3: `src/skill.ts` 的写层 —— install / remove

**install 的流程**（design §4.2 动作矩阵 + §4.3，逐条实现）

1. 解析 `source`（默认 `resolveBundledSkillDir()`）与 `canonical`
   （**固定** `~/.agents/skills/agent-ex-dispatch`，不开放覆盖——自动桥接只认 `~/.agents/skills`，
   design §2.4.3 约束 A）。
2. `inspectCanonical()` 定出六态之一，然后按动作矩阵执行：
   - `missing` → 建（拷贝 / 软链）
   - `link→source` → skip（幂等）
   - `link→elsewhere` → 问是否重指 / 切换
   - `managed-copy` + `version == 当前` → skip
   - `managed-copy` + `version != 当前` → **问"是否更新"**；确认后覆盖
   - `managed-copy` + `modified` → 额外提示"这份被改过，更新会覆盖你的修改"
   - `adoptable` → 认领：补写 marker，视作已装
   - `foreign-dir` → **中止**，提示用户手工处理（目录内容**一字未改**）
3. canonical 的建立：
   - `--link`（开发者路线）→ `fs.symlinkSync(source, canonical, "dir")`；**不写 marker**
   - 默认（用户路线）→ **拷贝**目录内容（`fs.cpSync(source, canonical, { recursive: true })`），
     再写 marker（`version = currentVersion()`、`sha = hashDir(canonical)`、`source`）
4. 宿主链：逐个探测到的宿主目录，按 design §4.4 的三种情形处理；
   **有 `autoBridge` 的宿主不建链**（提示"它会自动桥接"），**但已有指向别处的链必须重指**
   （design §2.4.3 约束 B——自动桥接不覆盖已有条目，永远不接管它）。
5. 打印结果清单。

**原子性**（P1-10）：拷贝**先写同目录临时目录**（如 `~/.agents/skills/.agent-ex-dispatch.tmp.<pid>`），
成功后 `fs.renameSync` 覆盖 canonical；失败则删临时目录、canonical 原封不动。
⇒ 宿主不会读到"写了一半"的 skill。

**remove 的流程**（design §4.5）

- canonical 是 `managed-copy` / `adoptable` → 删目录；是软链 → 只删链接不删 target；
  是 `foreign-dir` → **拒绝删**并提示手工处理。
- 宿主目录下 `agent-ex-dispatch`：
  - **软链 → 一律删**（删链接不丢数据），并打印它原本指向哪。
    ⚠️ **不要求指向 canonical**：本机 workbuddy / trae 那两条指向仓库的链也必须能删，
    否则"从开发者路线切回用户路线"之后永远卸不干净（design §2.4.3 约束 B）。
  - 实体目录 → **拒绝删**并提示手工处理。
  - 顺序：**先删宿主链、后删 canonical**（反过来会留断链）。两种 canonical 形态都适用。
- 删之前先 `lstat` 确认形态，**不碰**没见过的路径。

**返回值**：都返回结构化结果（`{ ok, lines[], errors[] }`），**不直接 `console.log`**——
文案渲染归 `src/skill-cmd.ts`（与 `runDoctor` / `runConfig` 的分工一致）。
**"提问"通过注入的回调**（`confirm?: (q: string) => Promise<boolean>`），
纯逻辑层不自己碰 readline ⇒ 测试不需要模拟 TTY。

**测试**

- 幂等：连跑两次 `install`，第二次全 `skip`，且文件系统无变化。
- **更新流程**（用户提的那个"对比版本号，询问是否更新"）：
  - 装完后把 marker 的 version 改旧 → 再 `install` ⇒ 提示"是否更新"；确认 ⇒ 版本变新；否认 ⇒ 不变。
  - 装完后手改 canonical 里的文件 ⇒ 再 `install` ⇒ 额外提示"这份被改过"。
- `foreign-dir`：在 canonical 放一个**无 marker 且内容与 bundled 不同**的实体目录
  → install **中止**，且该目录内容**一字未改**。
- `adoptable`：放一个**无 marker 但内容与 bundled 相同**的目录 → install 认领（补 marker），不中止。
- 拷贝 vs 软链：默认装完 canonical 是实体目录**且含 marker**；`--link` 装完是软链且**不含** marker。
- 断链：canonical 是指向不存在路径的软链 → 报出来而不是崩。
- 原子性：模拟拷贝失败 → canonical 原封不动、临时目录被清理。
- remove 只删该删的：在宿主目录放一个**指向别处**的同名软链 → remove **删掉它**（软链一律可删），
  但打印它原本指向哪；放一个**实体目录** → remove **拒绝删**并提示手工处理。
- remove 不误删：`remove --target X` 只删 X，**不删 canonical**（除非明确要求）。
- 有 `autoBridge` 的宿主：install **不**为它建链。
- 有 `autoBridge` 的宿主 + 已存在指向别处的链：install **主动重指**到 canonical
  （自动桥接"从不覆盖已有条目"，不会接管它 ⇒ 不重指就永远用旧的那份）。

---

## Task 4: CLI 接线 —— `src/skill-cmd.ts` + `src/server.ts`

**`src/skill-cmd.ts`（新）**

```ts
export async function runSkill(args: string[]): Promise<number>;
```

- `install` / `remove` 需要交互提问 ⇒ 用 `node:readline/promises`（与 `src/init.ts` 同款）。
  ⚠️ **非 TTY（管道 / CI）默认拒绝写操作**：打印一行"检测到非交互环境，请显式加 `--yes`"并 exit 2。
  原先写的"非 TTY 按 `--yes` 语义走"**不安全**——`install --yes` 会给探测到的宿主建链/重指，
  `remove --yes` 会删链、删 canonical 拷贝。CI 里一条非交互命令就可能改掉用户的
  `~/.agents` / `~/.claude` / `~/.trae-cn` / `~/.workbuddy`。
- `status` 只读，无参数；**绝不创建任何目录或文件**。
- 退出码：0 成功 / 1 有失败 / 2 用法错误（与 `runConfig` / `runProfile` 一致）。
  ⚠️ 补充（2026-11-10 复审）："还有东西留在原地"（实体目录 / 外来目录删不掉）也算失败 ⇒ 退出码 1。
- ⚠️ **"提问"必须可注入**：把提问做成一个回调参数（`prompt?: (q: string, def: boolean) => Promise<boolean>`），
  默认实现走 readline。测试直接注入假回调，不去模拟 TTY。

**`src/server.ts`**

- `USAGE` 加一行：`skill [install|remove|status]      manage the dispatch skill`
- 新增分支：

```ts
} else if (sub === "skill") {
  try {
    const { runSkill } = await import("./skill-cmd.js");
    process.exit(await runSkill(process.argv.slice(3)));
  } catch (e) {
    console.error(`[agent-ex] skill failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
```

⚠️ **动态 import 必须在分支内**（AGENTS.md 硬约束 7）。`src/skill.ts` 只用 `node:fs` / `node:path` /
`node:os` / `node:crypto`，不拖 SQLite、不拖 MCP SDK、不拖 executor 链。

**测试**

- `tests/cli-env.test.ts` 加断言：`agent-ex skill status` 的进程**没有**加载 `node:sqlite` 与
  `@modelcontextprotocol/sdk`。
  ⚠️ 该文件现有的写法是"import store.ts 后查 `process.moduleLoadList`"（`:189-202`）与
  "子命令输出不含 `ExperimentalWarning` / `tasks.db` / `mcp server ready`"（`:204-228`），
  **没有**"子进程没加载 SDK"的现成断言——要断言就得在子进程里 dump `moduleLoadList`。
  ⚠️ 把 `["skill","status"]` 加进 `:216` 的循环前**必须注入临时 HOME**，否则会读真实的 `~/.agents`。
- `tests/server-tools.test.ts` 的 **6 工具断言不变**（我们不动 MCP 工具面）——已核对：
  `tests/server-tools.test.ts:113-121` 仍是 6 个工具。
- `scripts/smoke-stdio.mjs` 的 `PRODUCTION_TOOLS` **不变**——已核对：`:55-62` 仍是 6 个。

---

## Task 5: doctor 的 skill 段

**改动**（`src/doctor.ts`）

- 新增 `collectSkillIssues()`（放在 `src/skill.ts`，与 `collectConfigIssues` 平行）：
  - 未安装 → `info` + fix `agent-ex skill install`
  - canonical 是拷贝且与包内那份不一致 → `warn` + fix `agent-ex skill install`
  - 已装且最新 → `ok`
  - 有宿主目录存在但没链 → `info`，列出可链的宿主
- doctor 消费它，**severity 最高只到 `warn`，且绝不影响 `ok`/exit code**——
  skill 是可选件，没装不该让体检失败。

⚠️ **不塞进 `collectConfigIssues()`**（AGENTS.md 硬约束 6 的边界：那是 `config.json` 的真相源）。

⚠️ **`home` 语义必须拆开**：doctor 的 `opts.home` 是 **agent-ex home**（`$AGENT_EX_HOME`，通常 `~/.agent-ex`）；
而 skill 的 canonical 在**用户 home** 下的 `~/.agents/skills`。混用 ⇒ doctor 会去看 `~/.agent-ex/.agents/skills`（错）。
⇒ `collectSkillIssues()` 的入参要分开：`{ agentExHome, userHome }`，doctor 侧新增可注入的 `userHome`（默认 `os.homedir()`）。

**测试**

- 没装 skill 时 `doctor()` 仍然 `ok === true`（exit 0），但 findings 里有一条 info。
- 装了过期拷贝时有一条 warn。
- doctor 不写任何文件（快照对比：调用前后目录 mtime/内容不变）。
- ⚠️ **`tests/doctor.test.ts` 要改**：现有 20+ 个 `doctor({ home: tmp })` 用例，
  若 skill 状态默认读 `os.homedir()`，这些用例会去读**真实的** `~/.agents/skills`——
  本机恰好有 `agent-ex-dispatch` 软链 ⇒ "没装 skill"的断言在这台机器上红、在 CI 上绿。
  ⇒ 必须给 doctor 加可注入的 `userHome`，并让测试传临时目录。

---

## Task 6: init 收尾信息精简 + `AGENT_EX_HOME` 进片段

**改动**（`src/init.ts`）

1. `mcpServerSnippet(serverEntry, home?)` 增加 `env`：当 `home !== join(homedir(), HOME_DIR_NAME)` 时输出
   `"env": { "AGENT_EX_HOME": "<home>" }`。
   ⚠️ 默认路径**不加**这个字段——加了是噪音。
   ⚠️ **签名要显式加 `home` 参数**（`tests/init.test.ts:379/387` 只传一个参数 ⇒ 需给默认值），
   不能在函数内部读 `os.homedir()`——那样测试就依赖开发机了。
2. `nextSteps(home, serverEntry)` 按 design §6 重写：
   - `export AGENT_EX_HOME=...` **只在非默认路径时保留**（默认路径整步省略）。
     ⚠️ **不能直接删掉这一步**：MCP 片段的 `env` 只影响 MCP client 拉起的 server 进程；
     用户随后手敲的 `agent-ex config set …` / `agent-ex doctor --send` 仍在没有该变量的 shell 里
     ⇒ 会读写默认 `~/.agent-ex`。删掉 = "静默打错目录"。
   - "Absolute paths matter…" 三行 → 一行
   - skill 段 → `agent-ex skill install` 一行（删掉 `npx skills add` 与 `find ~ -maxdepth 4`）
   - dry-run 段删掉 "body must not contain the product name…"
   - 结尾压成一行 `Tune later: …`
3. **全部英文**（AGENTS.md 硬约束 1）。

**测试**（`tests/init.test.ts`）

- 改掉 `:397-408` 的三条断言：
  - `"skills add wuruofan/agent-ex"` → `"agent-ex skill install"`
  - `"find ~ -maxdepth 4"` → 断言**不含**（排障命令已挪去 README）
  - `AGENT_EX_HOME=/home/u/.agent-ex` → 拆成两条：默认路径断言**不含** `export AGENT_EX_HOME`；
    非默认路径断言**含** `export AGENT_EX_HOME=<home>` **且**片段的 `env` 里也有它
- 新增：默认路径时片段**不含** `env` 字段；非默认路径时含且值正确。
- ⚠️ **行数断言按实测算，别拍脑袋**：`mcpServerSnippet` 用 `JSON.stringify(…, null, 2)` ⇒ 片段展开 **10 行**；
  模板其余 14 行 ⇒ **默认路径 24 行 / 非默认 30 行**（非默认多出 export 段 3 行 + 片段 `env` 字段 3 行）。
  断言写 "默认 ≤ 26 行、非默认 ≤ 32 行"。
  （原先写的 "≤ 16 行" 会红：那是把片段当单行 JSON 数出来的。
  当前 `nextSteps` 实测 **39 行 / 非空 31**，也不是原先写的 33。）
- 中文扫描测试（`:217-232`）仍绿。

---

## Task 7: `scripts/install-skill.sh` 改成薄壳

**为什么**：`AGENTS.md`「同一条事实只写一处」。bash 里那套「软链 + 幂等 skip + 非软链则中止」
和 TS 实现是同一件事的两份实现，必然漂移。

**改法**

```bash
#!/usr/bin/env bash
# 开发者路线：把仓库里的 skill 软链到宿主目录。
# 实现已收敛到 src/skill.ts（与 `agent-ex skill install` 同一套逻辑），
# 这里只做转发，避免 bash 与 TS 两份实现漂移。
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 旧接口的三个语义必须保住，否则是破坏性变更：
#   1. 位置参数 = 额外目标目录（旧脚本的用法：`./install-skill.sh ~/.some/skills`）
#   2. AGENT_EX_SKILL_TARGETS="a:b" 环境变量（`:59-64`）
#   3. 默认目标 = ~/.agents/skills + ~/.workbuddy/skills（`:53-57`）
TARGETS=()
if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
elif [ -n "${AGENT_EX_SKILL_TARGETS:-}" ]; then
  IFS=':' read -ra TARGETS <<< "$AGENT_EX_SKILL_TARGETS"
else
  TARGETS=("$HOME/.agents/skills" "$HOME/.workbuddy/skills")
fi
ARGS=()
for t in "${TARGETS[@]}"; do ARGS+=(--target "$t"); done
exec npx --no-install tsx "$REPO_ROOT/src/server.ts" skill install --link \
  --source "$REPO_ROOT/skills/agent-ex-dispatch" "${ARGS[@]}"
```

⚠️ **位置参数必须转成 `--target`**，不能原样追加——§4.1 只定义了 `--target`，
`runSkill` 不解析位置参数就会 exit 2。
⚠️ **`--target` 不能等于 canonical 本身或它的父目录**（`~/.agents/skills`）
⇒ 否则会自链 / EEXIST。canonical 恒为 `~/.agents/skills/agent-ex-dispatch`，
所以 `--target ~/.agents/skills` 必须在参数校验里**拒绝**（它就是父目录）。
⚠️ 旧默认目标只有 2 个，新实现默认探测更多宿主 ⇒ 这是**有意的破坏性变更**，
要在脚本输出里明说，也让 README 写明。

**测试**：在临时 HOME 下跑一次脚本，断言软链建好且指向仓库；再跑一次断言幂等（skip）；
断言 `AGENT_EX_SKILL_TARGETS` 与位置参数两种入口都生效；断言 `--target ~/.agents/skills` 被拒绝。

---

## Task 8: README + AGENTS + SKILL.md + 冒烟 + 提交

**README 改动**

| 位置 | 改什么 |
| :--- | :--- |
| 112-180 | 「安装 dispatch skill」整节重写：主线改为 `npm i -g agent-ex-mcp` → `agent-ex skill install`；`npx skills` 降为附录并标注它的两个缺口（宿主表漏宿主、装出副本后 CLI 升级不会跟着更新） |
| 122 | 删掉 `scripts/` 的说法（目录里早没了，只剩 `SKILL.md` + 2 个 `references/`） |
| 143-152 | WorkBuddy 那段改成：默认装到 `~/.agents/skills`；WorkBuddy **多数情况下有自动桥接 hook**（`~/.workbuddy/hooks/sync-agents-skills.sh`），没有的机器用 `agent-ex skill install --target ~/.workbuddy/skills` |
| 174-175 | Trae：路径随安装版本变，`agent-ex skill install` 会探测 `~/.trae-cn/skills`，不在就提示。**删掉"路线 A 按 CLI 提示选 Trae"这种转述**（第三方 CLI 的行为我们没验证过） |
| 命令表 | 加 `skill install` / `remove` / `status` |
| **726** | files 表加 `skills/agent-ex-dispatch`（⚠️ 原先只改了 729-731，**漏了这一行**） |
| 729-731 | 「npm 包不含 dispatch skill」改写为「npm 包内含 dispatch skill，装完包跑 `agent-ex skill install`」 |
| 排障段 | 把 `find ~ -maxdepth 4 -type d -name skills` 挪到这里（design §6 第 ③ 条） |

**`AGENTS.md` 改动**（⚠️ 原先整个漏了）

| 位置 | 改什么 |
| :--- | :--- |
| **:43** | `skills/agent-ex-dispatch/` — dispatch skill（走 GitHub 分发，**不进 npm 包**）→ 改成"随 npm 包分发，`agent-ex skill install` 安装" |
| **:108** | files 表加 `skills/agent-ex-dispatch` |
| 「文档分工」节 | skill 的分发方式变了，那一行的说明要跟着改 |
| 「发布」节 | 加一句"包体积 +50%（skill gzip 后 63,532 B）" |

**`skills/agent-ex-dispatch/SKILL.md` 改动**

| 位置 | 改什么 |
| :--- | :--- |
| **:9-11** | 安装方式段：现在指向 `npx skills add` 与"README 的路线 A"，而路线 A 已降为附录 ⇒ 改成 `agent-ex skill install` |

⚠️ SKILL.md 是**随包分发的内容本体**——它自己还教用户用旧方式装自己，是最讽刺的一种不一致，必须改。

**冒烟**（按 `AGENTS.md` 发布流程第 ⑦ 步的思路）

```bash
REPO=$(pwd)
npm run build && npm test
D=$(mktemp -d); npm pack                      # → agent-ex-mcp-<version>.tgz
TGZ=$(ls -t "$REPO"/agent-ex-mcp-*.tgz | head -1)
( cd "$D" && npm init -y && npm install "$TGZ" \
  && HOME="$D" ./node_modules/.bin/agent-ex skill status \
  && HOME="$D" ./node_modules/.bin/agent-ex skill install --yes \
  && HOME="$D" ./node_modules/.bin/agent-ex skill status \
  && node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js" )
```

⚠️ 用 glob 取 tarball，**不要**硬编码版本号（发版节奏会变）。
⚠️ **必须隔离 HOME**（`HOME="$D"`）：否则 `agent-ex skill status` 读开发者真实的 `~/.agents`，
`install --yes` 还会去改真实的 `~/.claude` / `~/.trae-cn` / `~/.workbuddy`。

⚠️ `agent-ex skill status` 在临时 HOME 下必须能跑（不能假设 `~/.agents/skills` 存在）。

**提交**（分支从 `main` 切）

- `feat(skill): ship the dispatch skill in the npm package and add agent-ex skill subcommands`
- `docs: rewrite the skill install section and fix the stale Trae/scripts claims`
- `refactor(skill): make install-skill.sh delegate to the TypeScript implementation`

---

## 自检（写完后对着 design 逐条核对）

- [ ] D1：`npm pack` 产物含 `skills/agent-ex-dispatch/`，且**不含** `.DS_Store`
- [ ] D2：三个子命令都能跑；`status` 只读；`remove` 只删该删的
- [ ] D3：仓库里**没有** `update` 子命令
- [ ] D4：`install` 默认拷贝、`--link` 软链；**两者都可测**
- [ ] D5：canonical **固定**在 `~/.agents/skills/agent-ex-dispatch`；宿主链指向 canonical（不是 source）
- [ ] D6：init 只**打印** `agent-ex skill install`，不执行安装
- [ ] D7：`nextSteps()` 默认路径 ≤ 26 行 / 非默认 ≤ 32 行（实测 24 / 30）；`AGENT_EX_HOME` 在**非默认**路径时既进片段的 `env`、也保留 export 那一步
- [ ] D8：doctor 有 skill 段；**`collectConfigIssues()` 里没有** skill 相关代码
- [ ] D9：provenance 只在**拷贝目录内**（`.agent-ex-skill.json`），**没有**集中状态文件；`remove` 的判定来自 `lstat` / `readlink` / marker
- [ ] D10：canonical 六态全部有确定动作；`managed-copy` 版本落后 ⇒ **问"是否更新"**；`foreign-dir` ⇒ 中止且内容一字未改
- [ ] 硬约束 1：init 的用户可见输出无中文（`tests/init.test.ts` 绿）
- [ ] 硬约束 7：`src/server.ts` 顶层 import 未增加（`skill` 分支内动态 import `./skill-cmd.js`）；`tests/cli-env.test.ts` 绿
- [ ] 硬约束 6：宿主表只在 `src/skill.ts` 一处
- [ ] `npm test` 全绿；`npm run typecheck` 通过
- [ ] README 两处过期/矛盾已修（`scripts/`、Trae）
