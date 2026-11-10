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
| D5 | canonical 在 `~/.agents/skills/agent-ex-dispatch`，每宿主一条软链指向 canonical | design §3 |
| D6 | init **只打印** `agent-ex skill install`，不执行安装 | design §3 |
| D7 | init 收尾信息 33 行 → 14 行；`AGENT_EX_HOME` 写进 MCP 片段的 `env` | design §6 |
| D8 | doctor 加 skill 段（info 级）；**不进 `collectConfigIssues()`** | design §3 |
| D9 | **不引入状态文件**，全部从文件系统推导 | design §3 |

## Global Constraints（每个 task 都隐含包含）

1. **顶层 import 纪律**（AGENTS.md 硬约束 7）：`src/server.ts` 顶层只留 `env-file` / `brand` / `ansi` / `marks`。
   `src/skill.ts` 必须在 `server.ts` 的 `skill` 分支里**动态 import**；`src/skill.ts` 本身**不得** import
   `@modelcontextprotocol/sdk`、`zod`、`node:sqlite`（`src/store.ts` 会拖进 SQLite）。
   `tests/cli-env.test.ts` 的懒加载断言必须仍然通过。
2. **校验只有一个真相源**（AGENTS.md 硬约束 6）：宿主表与安装状态判定只写在 `src/skill.ts`，
   doctor 与 installer **同源消费**。不要在 `doctor.ts` 里另写一份宿主表。
3. **init 的用户可见输出全英文**（AGENTS.md 硬约束 1）：`src/init.ts` 里所有 `console.log/error`、
   `ask()`、`rl.question()` 行不得含中文字符。`tests/init.test.ts:217-232` 会扫。
4. **`ln` 陷阱**（`README.md:149-150`）：`ln -s` 对已存在的**目录**目标不报错，会把软链塞进目录里。
   ⇒ 一律用 `fs.symlinkSync` + 前置 `lstat` 检查，**禁止**调用 shell `ln`。
5. **绝不覆盖既有实体目录**（沿用 `scripts/install-skill.sh:90-94` 的 abort 语义）。
6. **不写密钥**：skill 目录里没有任何凭证，但安装日志也不要打印 `~/.agent-ex/.env` 的内容。
7. 提交信息用 Conventional Commits（英文），**不加** AI trailer。分支从 `main` 切。

## 文件地图（动手前先锁定）

| 文件 | 动作 | Task |
| :--- | :--- | :--- |
| `package.json` | 改 | T1 |
| `src/skill.ts` | **新建** | T2 / T3 |
| `src/cli.ts` | 改 | T4 |
| `src/server.ts` | 改 | T4 |
| `src/doctor.ts` | 改 | T5 |
| `src/init.ts` | 改 | T6 |
| `scripts/install-skill.sh` | 改 | T7 |
| `README.md` | 改 | T8 |
| `tests/skill.test.ts` | **新建** | T2 / T3 |
| `tests/init.test.ts` | 改 | T6 |
| `tests/cli-env.test.ts` | 改（加断言） | T4 |
| `docs/designs/2026-11-10-skill-distribution.md` | 已写 | — |
| `docs/plans/2026-11-10-skill-distribution-implementation-plan.md` | 本文件 | — |

---

## Task 1: 让 skill 真的进到 npm 包里

**为什么排第一**：后面所有任务都要能"从包内取到 skill"，这条不通就全都白做。

**改动**

1. `package.json` 的 `files` 加 `"skills/agent-ex-dispatch"`。
   ⚠️ 不要写 `"skills"`——`skills/.DS_Store` 会被打进包。
2. 验证打包产物：

```bash
npm run build && npm pack --dry-run
# 产物里必须能看到 skills/agent-ex-dispatch/SKILL.md 与 references/*.md
# 且**不能**出现 skills/.DS_Store
```

**验收**

- `npm pack --dry-run --json` 的输出里含 `skills/agent-ex-dispatch/SKILL.md`。
- 输出里**不含** `skills/.DS_Store`。
- `dist/` 里**没有** skill 副本（skill 是独立目录，不进 dist）——
  这决定了 `src/skill.ts` 解析源目录时用的是 `../skills` 而不是 `dist/skills`。

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

/** 目录内容指纹：sha256(排序后的 "相对路径\0内容")，取前 12 位 hex。 */
export function hashDir(dir: string): string | null;

export interface SkillTargetState {
  path: string;
  kind: "link" | "copy" | "dir" | "missing" | "broken-link";
  /** 软链的指向（绝对路径）。 */
  target?: string;
}
export function inspectTarget(path: string): SkillTargetState;

export interface SkillStatus {
  bundled: { dir: string; sha: string | null; exists: boolean };
  canonical: SkillTargetState & { stale: boolean };
  hosts: Array<{ host: SkillHost; state: SkillTargetState; autoBridge: boolean }>;
}
export function skillStatus(opts?: { home?: string; source?: string }): SkillStatus;
```

**宿主表初稿**（路径来自本机实测，design §2.3；**只放已验证的**）

| id | dir | autoBridge |
| :--- | :--- | :--- |
| `agents` | `~/.agents/skills` | —（canonical 落点，不是链接目标） |
| `claude` | `~/.claude/skills` | 无 |
| `workbuddy` | `~/.workbuddy/skills` | 有：`~/.workbuddy/hooks/sync-agents-skills.sh` 存在 |
| `trae-cn` | `~/.trae-cn/skills` | 无（路径随安装版本变，只在探测到时才提示） |
| `codex` | `~/.codex/skills` | 无 |
| `opencode` | `~/.config/opencode/skills` | 无 |

**测试**（`tests/skill.test.ts`）

- `resolveBundledSkillDir()` 在源码模式下解析到 `<repo>/skills/agent-ex-dispatch`。
- `hashDir()` 对同一目录两次调用结果相同；改动一个文件后结果不同；空目录返回固定值。
- `inspectTarget()` 四种形态：软链 / 实体目录 / 断链 / 不存在。
- `skillStatus()` 能报出 canonical 是拷贝还是软链，以及拷贝与 source 不同时 `stale === true`。
- **测试不得依赖开发机装了什么**：所有路径与宿主表都要可注入（`home` 参数 + 表的构造函数）。

---

## Task 3: `src/skill.ts` 的写层 —— install / remove

**install 的流程**（design §4.2，逐条实现）

1. 解析 `source`（默认 `resolveBundledSkillDir()`）与 `canonical`（默认 `<shared>/agent-ex-dispatch`）。
2. canonical 已存在时：
   - 软链且指向同一 source → `skip`（幂等）
   - 软链但指向别处 → 问是否重指（`--yes` 直接重指）
   - 实体目录 → **中止**，提示用户手工处理
3. canonical 的建立：
   - `--link`（开发者路线）→ `fs.symlinkSync(source, canonical, "dir")`
   - 默认（用户路线）→ **拷贝**目录内容（递归，`fs.cpSync(source, canonical, { recursive: true })`）
4. 宿主链：逐个探测到的宿主目录问是否建链；**有 `autoBridge` 的宿主不建链**（design §4.3），
   提示"它会自动桥接"；`--yes` 则全建；`--target` 的直接建。
5. 打印结果清单。

**remove 的流程**（design §4.4）

- canonical 是拷贝 → 删目录；是软链 → 只删链接不删 target。
- 宿主目录下 `agent-ex-dispatch`：软链且指向 canonical → 删；实体目录或指向别处的软链 → **拒绝删**并提示。
- 删之前先 `lstat` 确认形态，**不碰**没见过的路径。

**返回值**：都返回结构化结果（`{ ok, lines[], errors[] }`），**不直接 `console.log`**——
文案渲染归 `src/cli.ts`（与 `runDoctor` / `runConfig` 的分工一致）。

**测试**

- 幂等：连跑两次 `install`，第二次全 `skip`，且文件系统无变化。
- 实体目录冲突：在 canonical 放一个实体目录 → install **中止**，且该目录内容**一字未改**。
- 拷贝 vs 软链：默认装完 canonical 是实体目录；`--link` 装完是软链且指向 source。
- 断链：canonical 是指向不存在路径的软链 → 报 `broken-link` 而不是崩。
- remove 只删该删的：在宿主目录放一个**指向别处**的同名软链 → remove **拒绝删它**。
- 有 `autoBridge` 的宿主：install **不**为它建链。

---

## Task 4: CLI 接线 —— `src/cli.ts` + `src/server.ts`

**`src/cli.ts`**

```ts
export async function runSkill(args: string[]): Promise<number>;
```

- `install` / `remove` 需要交互提问 ⇒ 用 `node:readline/promises`（与 `src/init.ts` 同款）。
  ⚠️ 非 TTY（管道 / CI）时**不提问**，按 `--yes` 语义走并打印一行说明。
- `status` 只读，无参数。
- 退出码：0 成功 / 1 有失败 / 2 用法错误（与 `runConfig` / `runProfile` 一致）。

**`src/server.ts`**

- `USAGE` 加一行：`skill [install|remove|status]      manage the dispatch skill`
- 新增分支：

```ts
} else if (sub === "skill") {
  try {
    const { runSkill } = await import("./cli.js");
    process.exit(await runSkill(process.argv.slice(3)));
  } catch (e) {
    console.error(`[agent-ex] skill failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
```

⚠️ **动态 import 必须在分支内**（AGENTS.md 硬约束 7）。`src/skill.ts` 只用 `node:fs` / `node:path` /
`node:os` / `node:crypto`，不拖 SQLite、不拖 MCP SDK。

**测试**

- `tests/cli-env.test.ts` 加断言：`agent-ex skill status` 的进程**没有**加载 `node:sqlite` 与
  `@modelcontextprotocol/sdk`（沿用该文件现有的懒加载断言写法）。
- `tests/server-tools.test.ts` 的 **6 工具断言不变**（我们不动 MCP 工具面）。
- `scripts/smoke-stdio.mjs` 的 `PRODUCTION_TOOLS` **不变**。

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

**测试**

- 没装 skill 时 `doctor()` 仍然 `ok === true`（exit 0），但 findings 里有一条 info。
- 装了过期拷贝时有一条 warn。
- doctor 不写任何文件（快照对比：调用前后目录 mtime/内容不变）。

---

## Task 6: init 收尾信息精简 + `AGENT_EX_HOME` 进片段

**改动**（`src/init.ts`）

1. `mcpServerSnippet(serverEntry)` 增加 `env`：当 `home !== join(homedir(), HOME_DIR_NAME)` 时输出
   `"env": { "AGENT_EX_HOME": "<home>" }`。
   ⚠️ 默认路径**不加**这个字段——加了是噪音。
2. `nextSteps(home, serverEntry)` 按 design §6 重写成 14 行版本：
   - 删掉 `export AGENT_EX_HOME=...` 整步
   - "Absolute paths matter…" 三行 → 一行
   - skill 段 → `agent-ex skill install` 一行（删掉 `npx skills add` 与 `find ~ -maxdepth 4`）
   - dry-run 段删掉 "body must not contain the product name…"
   - 结尾压成一行 `Tune later: …`
3. **全部英文**（AGENTS.md 硬约束 1）。

**测试**（`tests/init.test.ts`）

- 改掉 `:397-408` 的三条断言：
  - `"skills add wuruofan/agent-ex"` → `"agent-ex skill install"`
  - `"find ~ -maxdepth 4"` → 断言**不含**（排障命令已挪去 README）
  - `AGENT_EX_HOME=/home/u/.agent-ex` → 改为断言**片段里**含 `"AGENT_EX_HOME"`（非默认路径时）
- 新增：默认路径时片段**不含** `env` 字段；非默认路径时含且值正确。
- `nextSteps()` 输出行数 ≤ 16（防回潮）。
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
exec npx --no-install tsx "$REPO_ROOT/src/server.ts" skill install --link --source "$REPO_ROOT/skills/agent-ex-dispatch" "$@"
```

⚠️ 保留原有参数语义：额外目标目录仍按位置参数传（`--target` 语义要能吃下位置参数，
或脚本里把位置参数转成 `--target`）。

**测试**：在临时 HOME 下跑一次脚本，断言软链建好且指向仓库；再跑一次断言幂等（skip）。

---

## Task 8: README + 冒烟 + 提交

**README 改动**

| 位置 | 改什么 |
| :--- | :--- |
| 112-180 | 「安装 dispatch skill」整节重写：主线改为 `npm i -g agent-ex-mcp` → `agent-ex skill install`；`npx skills` 降为附录并标注它的两个缺口（宿主表漏宿主、装出副本后 CLI 升级不会跟着更新） |
| 122 | 删掉 `scripts/` 的说法（目录里早没了） |
| 143-152 | WorkBuddy 那段改成：默认 `~/.agents/skills` → WorkBuddy **通常有自动桥接 hook**，没有的机器用 `agent-ex skill install --target ~/.workbuddy/skills` |
| 174-175 | 修 Trae 的自相矛盾：路径随版本变，`agent-ex skill install` 会探测 `~/.trae-cn/skills`，不在就提示 |
| 命令表 | 加 `skill install` / `remove` / `status` |
| 729-731 | 「npm 包不含 dispatch skill」改写为「npm 包内含 dispatch skill，装完包跑 `agent-ex skill install`」 |
| 排障段 | 把 `find ~ -maxdepth 4 -type d -name skills` 挪到这里（design §6 第 ③ 条） |

**冒烟**（按 `AGENTS.md` 发布流程第 ⑦ 步的思路）

```bash
REPO=$(pwd)
npm run build && npm test
D=$(mktemp -d); npm pack                      # → agent-ex-mcp-<version>.tgz
TGZ=$(ls -t "$REPO"/agent-ex-mcp-*.tgz | head -1)
( cd "$D" && npm init -y && npm install "$TGZ" \
  && ./node_modules/.bin/agent-ex skill status \
  && node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js" )
```

⚠️ 用 glob 取 tarball，**不要**硬编码版本号（发版节奏会变）。
⚠️ npm 上当前最高版本是 `0.3.1`，仓库 `package.json` 已是 `0.3.2`（本地已 `npm version`，**尚未发布**）——
   本次功能发版时要重新确认版本号与 CHANGELOG 归属。

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
- [ ] D5：canonical 在 `~/.agents/skills/agent-ex-dispatch`；宿主链指向 canonical（不是 source）
- [ ] D6：init 只**打印** `agent-ex skill install`，不执行安装
- [ ] D7：`nextSteps()` ≤ 16 行；`AGENT_EX_HOME` 在非默认路径时进片段的 `env`
- [ ] D8：doctor 有 skill 段；**`collectConfigIssues()` 里没有** skill 相关代码
- [ ] D9：**没有**新增状态文件；`remove` 的判定全部来自 `lstat` / `readlink`
- [ ] 硬约束 1：init 的用户可见输出无中文（`tests/init.test.ts` 绿）
- [ ] 硬约束 2：`src/server.ts` 顶层 import 未增加；`tests/cli-env.test.ts` 绿
- [ ] 硬约束 6：宿主表只在 `src/skill.ts` 一处
- [ ] `npm test` 全绿；`npm run typecheck` 通过
- [ ] README 两处过期/矛盾已修（`scripts/`、Trae）
