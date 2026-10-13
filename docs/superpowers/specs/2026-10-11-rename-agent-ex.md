# 全量改名：agent-flow-ex → agent-ex

**状态**：📋 **待执行**（draft，2026-10-11；2026-10-12 名字复评改定 `agent-ex`；**2026-10-12 两轮执行细节复核修正**，修正清单见 §10）
**触发**：想把产品定位从「派发 worker」扩到「多 agent 协作（独立起草 / 相互review / spec-plan 讨论）」，现有名字只覆盖了前半。
**前置约束**：⚠️ **执行者必须坐在机器前**。本 spec 的 **Step 0 就会 disable MCP server**，Step 5 才 re-enable；Trae 的 MCP 客户端在 server 进程退出后**不会自动重连**（见 `2026-08-29-trae-mcp-visibility.md` §11），无人值守时会把 MCP 变成永久不可用。**人不在机器边就不要开始。**

---

## 1. 目标与非目标

### 目标

1. 名字覆盖真实能力：既包含「派发 worker」，也包含「外部 agent 独立出方案 / 相互 review」。
2. 全部改名，不留混用：`agent_flow_*` 工具名、`AGENT_FLOW_*` 环境变量、`agentFlow*` 驼峰标识符、`~/.agent-flow-ex` 数据目录、`agent-flow-dispatch` skill 名、仓库/目录名、npm 包名、`package.json` 的 `bin`。
3. 零数据丢失：库内所有行的 `log_path` 在改名后仍可读。**基线数字一律以执行时现场实测为准**（见 §3）；2026-10-12 实测 = 21 行、其中 `log_path` 带旧名 21 行、`project_path` 带旧名 **0** 行。

### 非目标

- 不改任何功能行为。本次是纯改名 + 定位文案重写，**不改状态机、不改 prompt 语义、不加新能力**。
- 不引入「阶段」概念。spec/plan/开发/review 的差异应体现在 **prompt 的措辞**里，不写进代码枚举（见 §6）。
- **不修改历史记录**：`docs/` 里的历史文档、`.workbuddy/memory/*.md` 历史日志、以及库内 `prompt` / `result` / `question` 三列自由文本，一律逐字保留（理由见 §4 Step 2）。

---

## 2. 名字选定

**候选评估**（npm 可用性逐个查证；2026-10-11 首轮、2026-10-12 复核并重评）：

| 候选 | npm 状态 | 评价 |
| :--- | :--- | :--- |
| **`agent-ex`** | ✅ E404（未占用） | **选定**（2026-10-12 复评）。`ex` = **external**（作者本意）：「外部 agent」正是两种协作形态的共同本质——派发是把活交给外部执行者，互审是要外部视角，一个词全覆盖。与现名 `-ex` 一脉相承，迁移认知成本最低。GitHub 仓库名 `wuruofan/agent-ex` 亦空闲 |
| `agent-second` | ✅ 未占用 | 备选。second = 副手 + second opinion，覆盖也全，但隐喻不如 external 直白 |
| `agent-peer` | ✅ 未占用 | ❌ 降级（2026-10-11 曾选定，2026-10-12 复评降级）。三个问题：① `peer` 只覆盖「互审」半边，不覆盖「派发」（派发是层级关系不是平级）——重蹈「名字只覆盖一半」的覆辙；② 技术语境 `peer` 第一联想是 P2P（npm 上 `@peer-agent/*` 就是 P2P 协议）；③ GitHub `agent-peer` 名下 114 仓库含 `agent-peers-mcp`、`agent-peer-review`，心智被 peer review 类项目稀释。当初弃 `agent-ex` 的两条理由经复核均不成立：「丢掉协作语义」是误判，「agent.exe / 前任」歧义属可读性成本（见下） |
| `agent-mates` | ✅ 未占用 | 更顺口亲和，但「mates」偏泛，暗示同类友好而非分工明确的搭档 |
| `crew` | ✅ 未占用 | ❌ 太通用，无 agent 语义 |
| `agent-crew` | ❌ 已占 0.1.0 | — |
| `agentmates` | ❌ 已占 0.8.1 | — |
| `agent-ally` | ❌ 已占 0.1.4 | — |
| `crewkit` | ❌ 已占 1.1.9 | — |

**2026-10-12 复核**：`https://registry.npmjs.org/agent-ex` → `{"error":"Not found"}`；`https://github.com/wuruofan/agent-ex` → 404（对照 `wuruofan/agent-flow-ex` → 200）。两条可用性判断仍成立。

**遗留可读性成本**（接受，用文案兜底）：`ex` 是不透明缩写，陌生人不会自动展开成 external；GitHub 搜 `agent-ex` 有大量 `agent-example` / `agent-exchange` 噪声。缓解：README 首行标语显式写出 external（如 "agent-ex: dispatch & review with *external* agents"），§4 Step 6 的定位文案一并覆盖。

**结论**：采用 `agent-ex`。包名 `agent-ex`，目录 `agent-ex`，数据目录 `~/.agent-ex`，skill 名 `agent-ex-dispatch`，工具前缀 `agent_ex_*`，环境变量前缀 `AGENT_EX_*`。

---

## 3. 执行前置检查（缺一不可，缺了别继续）

### Step 0 ·（人操作）先在宿主面板 disable 这个 MCP server

三个理由，任一条都足够：

1. **server 常驻、查询期间会短暂持有 `tasks.db`**：2026-10-12 复核时确有 3 个 server 进程活着；虽然当时 `lsof` 抓不到持有者（连接是**按需**打开的，空闲时已关闭），但它随时可能被 submit/status 打开。不先放开，下面的 `wal_checkpoint(TRUNCATE)` 与 `cp -a` 就可能撞上活跃写入。
2. **改名期间 server 会用到已经不存在的路径**：Step 3 把仓库目录改名后，仍活着的 server 会用旧路径去 spawn runner（`agent-flow-ex/dist/runner.js` 已不存在）⇒ 期间任何 submit 都会失败或写出错状态。
3. **Step 5 本来就必须 disable → re-enable**（Trae 不自愈）——只是把同一步挪到最前面，不多做事。

### 然后按序执行

```bash
# 1) 确认没有活着的持有者 / 进程
lsof ~/.agent-flow-ex/tasks.db          # 期望无输出。
#    ⚠️ 不要只靠 ps：沙箱/agent 环境下 `ps` 直接 EPERM（operation not permitted），
#    管道会让"无输出"看起来像"没有进程"（假通过）。能跑 ps 的环境里可另跑：
ps aux | grep -E "dist/(runner|server)|claude -p|opencode run" | grep -v grep    # 期望无输出

# 2) 先把 WAL 落盘（4.1MB 是 2026-10-11 的历史观测；2026-10-12 复核时 -wal 已不存在，
#    说明空闲期连接关闭时 SQLite 自动 checkpoint 过。此步对现状是幂等 no-op，但仍必须保留：
#    执行时无法假定库此刻恰好空闲）
sqlite3 ~/.agent-flow-ex/tasks.db "PRAGMA wal_checkpoint(TRUNCATE);"

# 3) 记录基线（Step 2 与验收 #3 要用；把现场数字抄进执行记录，别用本文件的历史数字）
sqlite3 ~/.agent-flow-ex/tasks.db "select count(*) from tasks;"
sqlite3 ~/.agent-flow-ex/tasks.db "select count(*) from tasks where log_path like '%agent-flow-ex%';"
sqlite3 ~/.agent-flow-ex/tasks.db "select count(*) from tasks where project_path like '%agent-flow-ex%';"   # 实测 0

# 4) 整目录备份（checkpoint 之后 -wal 已空 ⇒ 备份是干净快照）
cp -a ~/.agent-flow-ex ~/.agent-flow-ex.bak.$(date +%Y%m%d)

# 5) 干净锚点：动手前确保工作区干净，并把改名前的状态 commit 掉
git status --short -uno         # 期望无输出（有未提交改动就先提交/暂存）
                               #   ⚠️ 必须加 -uno：`<repo>/.trae/` 是 untracked 且不在 .gitignore
                               #   （里面是含绝对路径的本机 MCP 配置，本就不该入库），
                               #   不加 -uno 时这条永远过不了，执行者会被逼着把本机配置 commit 进去。
                               #   顺手可考虑把它加进 .gitignore（可选，不属于本次改名范围）。
git rev-parse HEAD          # 记下这个 sha，回滚靠它
```

> 顺序是有意的：**先停 server → 再 checkpoint → 再记基线 → 再备份 → 再留回滚锚点**。先 checkpoint 再备份，备份才是单一文件的干净快照，而不是带着一个 4.1MB 的 `-wal` 去祈祷。
>
> ⚠️ 基线数字是动态的：2026-10-11 那版写的 98/98/6 **已过期**（2026-10-12 实测 21/21/0）。执行时以现场为准，并把它写进执行记录。

---

## 4. 执行步骤（严格按序，每步都有验证）

### Step 1 · 代码与标识符改名

全量精确替换。**不要碰** `docs/`（历史文档）与 `.workbuddy/memory/*.md`（历史日志）。

| 模式 | 替换为 | 影响面（2026-10-12 实测 `git grep -o`，排除 docs） |
| :--- | :--- | :--- |
| `agent_flow_` | `agent_ex_` | 50 处（工具名、测试、文案） |
| `agent-flow-dispatch` | `agent-ex-dispatch` | 14 处（skill 名、软链、文案） |
| `agent-flow-ex` | `agent-ex` | 78 处（含 `.agent-flow-ex` 数据目录默认值与文案，以及包名/仓库名/bin/文案） |
| `AGENT_FLOW_` | `AGENT_EX_` | 68 处（5 个环境变量：`AGENT_FLOW_HOME`、`_SKILL_TARGETS`、`_RETRY_BACKOFF_MS`、`_RUNNER`、`_TEST_MODE`） |
| `agentFlow` | `agentEx` | 15 处（驼峰标识符，如 `agentFlowHome()`） |
| `agent-flow` | `agent-ex` | 兜底行：**裸 `agent-flow`**（不带 `-ex`/`-dispatch` 后缀）另有 4 文件 7 行 ≥10 处（`README.md:232,414`、`SKILL.md:2`、`wait-task.mjs:2`、`src/init.ts:286`），前 5 行都匹配不到 |

合计 **189 行**命中（`git grep -nEi "agent[-_]?flow" -- . ':!docs' | wc -l`，2026-10-12 实测），改完必须为 **0**。

> ⚠️ 兜底行必须放在**最后**：带 `-ex`/`-dispatch` 后缀的已被前 3 行处理完，裸 `agent-flow` 若先做会把已改好的再改一遍、留下 `agent-ex-ex` 这类烂尾。前 5 行之间互不冲突（`agent_flow_` / `AGENT_FLOW_` / `agentFlow` 是三种大小写下划线形态），按表从上到下做即可。

**⚠️ 别漏了 skill 目录本身**：内容替换不会重命名目录，而 `scripts/install-skill.sh:43-44` 是 `SKILL_NAME="agent-flow-dispatch"` + `CANONICAL="$REPO_ROOT/skills/$SKILL_NAME"` ⇒ 只改内容会让它指向**不存在的** `skills/agent-ex-dispatch`，Step 4 的软链必然失败或建出悬空链。`git grep` 扫不到目录名，`tests/` 也无引用（2026-10-12 查证），所以会一路拖到验收 #5 才炸：

```bash
git mv skills/agent-flow-dispatch skills/agent-ex-dispatch   # 与内容替换同批做
```

**关键文件**（改完逐个确认）：

- `src/paths.ts:5-6` —— `agentFlowHome()` 与 `AGENT_FLOW_HOME ?? ".agent-flow-ex"` 默认值（本步的核心）
- `src/server.ts`（5 个工具注册 + 启动注释里的 env 名）、`src/runner.ts`、`src/spawn-runner.ts`、`src/tools/test-helpers.ts`、`src/env-file.ts`、`src/config.ts`、`src/init.ts`（它生成给用户的收尾指引里也印 `AGENT_FLOW_HOME`）
- `scripts/install-skill.sh`（`AGENT_FLOW_SKILL_TARGETS`）、`scripts/smoke-status.mjs`、`scripts/smoke-stdio.mjs`
- `skills/agent-flow-dispatch/**`（SKILL.md、`references/*.md`、`scripts/wait-task.mjs` 及其 test）
- `tests/*.test.ts`、`package.json`（`name` + `bin` + `repository.url`）、`config.example.json:49`、`package-lock.json`、`README.md`

⚠️ 有四处**测试断言里硬编码了旧名字符串**，它们应当被一起替换，**改完必须实测 `npm test` 通过**，别当成漏改手工回退：

| 位置 | 断言里的旧名 |
| :--- | :--- |
| `tests/init.test.ts:101` | `AGENT_FLOW_HOME=/home/u/.agent-flow-ex` |
| `tests/config.test.ts:32` | 默认值 `.agent-flow-ex` |
| `tests/notifier.test.ts:113,116` | 飞书卡片关键字 `agent-flow-ex` |
| `tests/tools.test.ts:188` | 错误文案 `AGENT_FLOW_TEST_MODE not enabled` |

**验证**：

```bash
# 主验证：0 命中
git grep -nEi "agent[-_]?flow" -- . ':!docs'    # 期望 0（2026-10-12 实测 189）
#  ⚠️ 一律用 -E 或 git grep。写 BRE 的 "a\|b" 会恒返回 0 命中 ——
#     Bash 工具里的 grep 是 WorkBuddy 自带的 toybox 0.8.13，不支持 \| 交替 ⇒ 静默"假通过"
#     （系统 /usr/bin/grep 支持，但执行环境不保证）
#  为什么用 git grep 而不是 grep -r：只搜 git 跟踪的文件 ⇒ 自动排除 node_modules/、dist/、.workbuddy/
#     （三者都在 .gitignore）；也不会把 .workbuddy/memory/*.md 里的历史记录误判成"残留"

npm run typecheck                                # 期望 0 error
npm test                                         # 期望与「改名前基线」一致（见下）
npm install --package-lock-only                  # 同步 lock 里的 name/bin；不做这条 package-lock.json 仍有旧名 ⇒ 主验证不过
```

> **测试基线要现场记，不要背数字**：原稿写死「123 passed / 4 skipped」是错的——2026-10-12 在 Trae 终端实测 **127 passed / 0 skipped**（15 个 test file 全过，8.45s），`skipped` 数取决于沙箱里 `ps` 是否可用（`proc-tree` / `integration` 里有依赖 `ps` 的用例），因环境而异。**执行前先跑一遍 `npm test` 记下 passed/skipped，改完再跑，要求两者完全一致。**

### Step 2 · 数据目录改名 + 数据库迁移

只有 `log_path` 需要迁移（它是**活指针**——`status` 靠它读日志）：

```bash
mv ~/.agent-flow-ex ~/.agent-ex

sqlite3 ~/.agent-ex/tasks.db "UPDATE tasks SET log_path = replace(log_path, '/.agent-flow-ex/', '/.agent-ex/');"
```

**不再迁移的三类，理由写死在这里，别重新加回来**：

- **`project_path`**：2026-10-12 实测**没有任何一行含旧名**（实际值是 `/tmp/oc-e2e/work`、`/tmp/oc-e2e/work2`、`/tmp/mcp-reg-work`、`/tmp/feishu-e2e`、`/tmp/feishu-neg`、`/Users/wuruofan/mine/rfw/motelet`，与仓库路径无关）。旧 spec 里那条 `replace(…, '/workspace/agent-flow-ex', …)` 是空操作，而且那个路径在本机从来不存在。执行时仍按 §3 第 3 步复核一次：**若不为 0，按实际值决定怎么迁移**，别照抄旧 SQL。
- **`prompt` / `result` / `question`**：**历史记录的自由文本，逐字保留**。改写历史会与验收 #4（"`result` 与改前一致"）直接冲突，也让过去的工单不再是当时发出的原文；里面残留的旧名只是文本，没有任何解析方。

另外**不要漏了数据目录里的 `config.json`**：它是 live config（不是历史记录），`notify.keyword` 默认值就是 `agent-flow-ex`（与 [config.example.json:49](file:///Users/wuruofan/mine/rfw/agent-flow-ex/config.example.json#L49) 同源）。不改的话改名后飞书通知仍带旧 keyword，与目标 2「不留混用」矛盾。其余字段（executors / profiles / env）2026-10-12 已查，无旧名，改法：

```bash
# 改 notify.keyword 一处即可（改前先备份，配置错了通知就不发了）
cp ~/.agent-ex/config.json ~/.agent-ex/config.json.bak
# 把 "keyword": "agent-flow-ex"  改成  "keyword": "agent-ex"
grep -n 'agent-flow' ~/.agent-ex/config.json    # 改完期望无输出
```

**验证**（三条都要过）：

```bash
sqlite3 ~/.agent-ex/tasks.db "select count(*) from tasks;"                                        # = 基线（2026-10-12 实测 21）
sqlite3 ~/.agent-ex/tasks.db "select count(*) from tasks where log_path like '%agent-flow-ex%';"  # 期望 0
sqlite3 ~/.agent-ex/tasks.db "select count(*) from tasks where log_path like '%agent-ex%';"       # = 基线
```

### Step 3 · 目录与 git remote

```bash
cd /Users/wuruofan/mine/rfw            # ⚠️ 真实路径。本仓库不在 ~/workspace（那里没有这个项目）
mv agent-flow-ex agent-ex
cd agent-ex
git remote set-url origin git@github.com:wuruofan/agent-ex.git
```

**GitHub 仓库改名**（Settings → General → Repository name → Rename）—— ✅ **已完成**（2026-10-12 用 `gh repo rename agent-ex` 执行，见 §10 E-1）：
- GitHub 给旧 URL 建了 **301 重定向**（`agent-flow-ex` → `agent-ex` 已实测 301），老 clone 的 `git pull` 不受影响；
- **Actions / Dependabot / 其他集成不被重定向覆盖**（⚠️ 当前仓库**没有** `.github/workflows`，暂无实际受影响项）；
- `gh repo rename` 已自动把本地 remote 更新为新地址，所以下面脚本里的 `set-url` 属于**幂等重复**（保留是为了让脚本自洽、也能修复 remote 被意外改回的情况）。

⚠️ **一条副作用**：`mv` 之后 IDE 里打开的还是旧路径，文件面板会变空。**重新打开 `agent-ex` 文件夹**再继续（Trae CN / SOLO / WorkBuddy 若也开着这个目录，同样重开）。

### Step 4 · skill 软链修复

**三个**宿主都有旧链，改名后都会悬空（2026-10-12 实测：`~/.agents/skills`、`~/.workbuddy/skills`、`~/.trae-cn/skills` 各一条，都指向 `<repo>/skills/agent-flow-dispatch`）。**先删旧链再重建**：

```bash
for d in ~/.agents/skills ~/.workbuddy/skills ~/.trae-cn/skills; do
  [ -L "$d/agent-flow-dispatch" ] && rm "$d/agent-flow-dispatch"
done
cd /Users/wuruofan/mine/rfw/agent-ex        # 本步在 Step 3 之后 ⇒ 用新路径
./scripts/install-skill.sh ~/.agents/skills ~/.workbuddy/skills ~/.trae-cn/skills

ls -la ~/.agents/skills/agent-ex-dispatch ~/.workbuddy/skills/agent-ex-dispatch ~/.trae-cn/skills/agent-ex-dispatch
# 三条都须指向新的仓库路径
```

⚠️ **必须显式传全三个 target**：脚本默认只含 `~/.agents/skills` + `~/.workbuddy/skills`，而**显式传参会覆盖默认**（`scripts/install-skill.sh:57`）⇒ 少传哪个，哪个目录就留下悬空旧链。

### Step 5 · 重建 dist 并重连 MCP

```bash
npm run build     # 必须：dist 里还是旧工具名
```

⚠️ **本步需要人操作**（MCP 面板的重连按钮）。

本机需要改的是 **2 个配置文件**（2026-10-12 调整，原为 3 处——Trae CN 的项目级 `.trae/mcp.json` 已删除，见下方说明）：

| # | 宿主 | 配置文件 | 备注 |
| :--- | :--- | :--- | :--- |
| 1 | WorkBuddy | `~/.workbuddy/mcp.json` | 已确认真实路径 |
| 2 | Trae SOLO CN（traework） | `~/Library/Application Support/TRAE SOLO CN/User/mcp.json` | **全局**配置，2026-10-12 14:22 已配好并生效 |

每个文件里改这三处（键名 / 路径 / env）：

| 位置 | 旧 | 新 |
| :--- | :--- | :--- |
| server id（键名） | `agent-flow-ex` | `agent-ex` |
| `args[0]` | `/Users/wuruofan/mine/rfw/agent-flow-ex/dist/server.js` | `/Users/wuruofan/mine/rfw/agent-ex/dist/server.js` |
| `env` | `"AGENT_FLOW_HOME": "/Users/wuruofan/.agent-flow-ex"` | `"AGENT_EX_HOME": "/Users/wuruofan/.agent-ex"` |

**逐文件的具体差异**（别照抄成一样）：

- `~/.workbuddy/mcp.json` —— 有 `mcpServers` + `type: "stdio"`。
- `TRAE SOLO CN/User/mcp.json` —— **没有 `type` 字段也能正常工作**，照原样保留其余结构即可，只改上面三处。

**关于 Trae CN（IDE）**：原先它在用项目级 `<repo>/.trae/mcp.json`，**2026-10-12 已删除**（用户决定：这个含绝对路径的 untracked 文件每次改名都要跟着改，不如不要；Trae CN 不需要这个 MCP）。删除后 Trae CN 的 `User/` 目录里本来就没有全局 `mcp.json`，因此它现在**不持有这个 server**，改名与重连都与它无关。若日后要在 Trae CN 里用，需在 `~/Library/Application Support/Trae CN/User/mcp.json` 新建一份（该路径已验证与 SOLO 同构，但**未找到官方文档确认** Trae CN 一定读它，配置后须实测）。

1. 在 MCP 面板 **disable → re-enable**（或重启 IDE）迫使客户端重连。两个宿主各自独立，**WorkBuddy 与 SOLO 都要各自重连一次**。
2. 调 `agent_ex_version` 验证 —— 若还报「无此工具」，说明客户端仍连着旧 server，需再 disable/re-enable 一次。

> **为什么 SOLO 用全局**（2026-10-12 逐 bundle 比对，非推测）：两个版本的 MCP 实现代码**逐字符相同**，都读两处 —— 全局 `joinPath(userSettingsResource,"..","mcp.json")` 与项目级 `joinPath(workspaceUri,".trae","mcp.json")`；开关默认值也相同（`getValue("trae.mcp.enableWorkspaceMcp") ?? false`）。本机 SOLO 的 `User/` 目录里有 `mcp.json` ⇒ 走全局（已实测连通）；Trae CN 的 `User/` 目录里**没有** `mcp.json`，其 `settings.json` 里开关为 `true`，两者相加才使项目级成为它当时的唯一入口——现已删除该文件。
>
> ⇒ **不需要升级 Trae/SOLO 来"支持"全局路径**，当前版本已支持。

> 为什么不直接用 `agent_ex_restart`：该工具让 server 退出，注释里假设「host 会在 stdin/stdout 关闭后 respawn」（`src/tools/restart.ts:6-8`）。**这个假设在 Trae 下不成立**（客户端不自愈），所以在 Trae 上用它等于自杀。必须走 UI 面板重连。
>
> ⚠️ 若 `env` 键改名后忘记同步（或反之），`src/paths.ts` 的 `?? 默认值` 会让它**静默**落回 `~/.agent-ex` —— 恰好是对的目录，所以故障不会报错、只会迷惑后来人。改完按上表逐行核对。

### Step 6 · 定位文案重写（这次改名的真正价值）

改名本身不解决「名字只覆盖 worker」的问题。以下两处必须重写（正文里出现的 `AGENT_FLOW_HOME` 已由 Step 1 一并替换为 `AGENT_EX_HOME`，直接用新名）：

**a) README 第一段** —— 现在是「把 AI 编程 Agent 当作后台任务来调度的 MCP Server」，只讲派发。要改成覆盖三种协作形态：

| 形态 | 怎么用 |
| :--- | :--- |
| **派发实现** | `submit(prompt=自包含工单)` → worker 独立完成 → `wait-task.mjs` 带回结果 |
| **独立起草方案** | `submit(prompt="读 docs/ 与代码，产出设计方案写到 docs/plans/xxx.md")` |
| **相互 review** | `submit(prompt="审阅 docs/plans/xxx.md，按可执行性/遗漏/矛盾列问题")` |

**b) SKILL.md 新增「什么时候用协作、什么时候自己干」一节** —— 现在只教「怎么派活」。要写清：
- 返工量小且强依赖当前上下文 → 自己做（现有铁律，别丢）
- 需要独立视角 / 方案不显然 → 派出去当「第二意见」
- spec/plan 阶段的方案起草与 review → 派出去，落文件而不是留在对话里

---

## 5. 验收标准

| # | 标准 | 验证方式 |
| :--- | :--- | :--- |
| 1 | 代码/配置里无旧名残留 | §4 Step 1 的 `git grep -nEi "agent[-_]?flow" -- . ':!docs'` 期望 0 命中（含 `.md`、`package-lock.json`） |
| 2 | typecheck + 全量测试通过 | `npm run typecheck && npm test` → 期望与**改前实测基线完全一致**（2026-10-12 Trae 终端实测 = 127 passed / 0 skipped，15 files；`skipped` 数随沙箱 `ps` 可用性浮动，别背数字，先记基线再比对） |
| 3 | 数据零丢失 | `tasks` 总数**等于执行前记录的基线**（2026-10-12 实测 21）；`log_path like '%agent-flow-ex%'` = 0 且 `like '%agent-ex%'` = 基线 |
| 4 | 历史记录**逐字未变** | 抽查一条终态任务，`prompt` / `result` / `question` 与改前逐字一致（改前先 `sqlite3 -json` 导出该行做 diff）；`log_path` 指向的新路径**文件真实存在**（`ls` 一下） |
| 5 | skill 在**三个**宿主都加载 | `ls -la ~/.agents/skills/agent-ex-dispatch ~/.workbuddy/skills/agent-ex-dispatch ~/.trae-cn/skills/agent-ex-dispatch`，三条都指向新仓库路径 |
| 6 | MCP 可用 | `agent_ex_version` 返回的 `gitSha` 等于改名后的 HEAD |
| 7 | README/skill 定位覆盖三种协作形态 | 人工核对 §4 Step 6 表格 |
| 8 | 包元数据自洽 | `package.json` 的 `name`/`bin`/`repository.url` 与 `package-lock.json` 三处同名新名（由 #1 覆盖，此处人工再确认一眼） |
| 9 | **机器上 3 处 MCP 配置都改了**（#1 的 `git grep` 覆盖不到） | 见下方命令块，期望 0 命中 |

**验收 #9 的验证命令**（不能只用 `git grep`——`<repo>/.trae/mcp.json` 是 untracked，另两处在仓库外）：

```bash
# 1) 两个已知宿主逐个查（注意：grep -c 在 0 命中时输出 0 且退出码 1，
#    直接 `|| echo 缺文件` 会把「正确」误报成「缺文件」；先判文件存在，再 || true 兜住退出码）
for f in ~/.workbuddy/mcp.json \
         "$HOME/Library/Application Support/TRAE SOLO CN/User/mcp.json"; do
  if [ -f "$f" ]; then
    n=$(grep -c 'agent-flow' "$f" || true)     # 期望 0
    printf '%-72s %s\n' "$f" "$([ "$n" = 0 ] && echo OK || echo "残留 $n 处！")"
  else
    printf '%-72s %s\n' "$f" "文件不存在"
  fi
done

# 2) 兜底：全机扫一遍 mcp.json，确认没有第 3 处（2026-10-12 实测：原本 3 处，
#    Trae CN 的项目级 .trae/mcp.json 已删除后只剩这 2 处）
find ~ -name mcp.json -not -path "*/node_modules/*" -not -path "*/.git/*" \
  -exec grep -l "agent-flow" {} \; 2>/dev/null
```

两条都应**无 `agent-flow` 命中**。第 2 条若列出 spec 里没提的文件，说明还有漏的宿主。

---

## 6. 设计说明：为什么这些都不写进代码

「spec 阶段 / 开发阶段 / review 阶段」的差异，**只体现在 prompt 的措辞里**，不新增 `--phase` 参数、不在状态机里加 `reviewing` 状态。

理由是本项目最早的一条不变量：**派发方（Scheduler）完全外置、agent-flow-ex 几乎 0 改动**（见 `2026-08-29-self-loop-design.md` §2）。一旦把阶段写进代码：
- 调度员（任何宿主）都要理解这套枚举，破坏「prompt 即规约」；
- 想换个派发方就得改代码，回到「派发方不可替换」的老问题。

**阶段是 prompt 的语义，不是 API 的参数。** 这一条在改名的同时必须守住，否则新名字承诺的「多阶段协作」反而被实现方式绑死。

---

## 7. 风险

| 风险 | 缓解 |
| :--- | :--- |
| **MCP 断连后无人重连**（最严重） | Step 0 就 disable、Step 5 才 re-enable，两处都要求人在场；无人值守时**不要开始** |
| **改名期间 server 仍在跑** ⇒ spawn 失败 / 写出错状态 | Step 0 先 disable；用 `lsof ~/.agent-flow-ex/tasks.db` 复核无持有者 |
| `agent_ex_restart` 在 Trae 下等于自杀 | 不用它，走 UI 面板 disable → re-enable |
| `log_path` 失效 | §4 Step 2 的 SQL 迁移 + 验收 #3/#4 |
| 4.1MB WAL 未落盘 ⇒ 迁移不完整 / 备份不干净 | §3 先 `wal_checkpoint(TRUNCATE)` **再**备份（现状下是 no-op，但保留以防执行时恰逢活跃写入） |
| **验证"假通过"**：BRE `\|` 在 Bash 工具的 toybox grep 下恒 0 命中 | 验证一律 `-E` 或 `git grep`；见 §4 Step 1 验证块 |
| 旧验证只覆盖 `*.ts/*.mjs/*.sh/*.json`，`.md` 全漏（README/SKILL 正是要改的） | 改用 `git grep`（覆盖全部跟踪文件，仍排除 `docs/`） |
| 漏掉软链宿主（实测有**三个**） | §4 Step 4 显式列三个 target；验收 #5 逐个 `ls` |
| **漏改 skill 目录名** ⇒ `install-skill.sh` 的 `CANONICAL` 指向不存在路径，软链全断 | Step 1 的 `git mv skills/agent-flow-dispatch skills/agent-ex-dispatch`（git grep 扫不到目录名，只能靠这条） |
| 测试断言里硬编码的旧名字符串被漏改或误回退 | §4 Step 1 的关键文件清单 + 实测 `npm test` |
| `package-lock.json` 未同步 | Step 1 验证块里的 `npm install --package-lock-only` |
| GitHub 旧链接 404 | Rename 后自动 301；Actions/Dependabot 不被覆盖（当前无 workflow，属预防性） |
| `npx skills` 用户装的是旧名 skill | skill 走 GitHub 分发，改名后需重新 add；README 已提示先 `--list` |
| **3 处 MCP 配置漏改某一处** ⇒ 该宿主静默失效（`paths.ts` 的 `?? 默认值` 会落到正确目录，不报错） | §4 Step 5 三宿主对照表 + 验收 #9 的两条扫描命令 |

---

## 8. 回滚

```bash
# 0) 面板 disable MCP（同 Step 0）
# 1) 代码与目录
cd /Users/wuruofan/mine/rfw && mv agent-ex agent-flow-ex
cd agent-flow-ex && git remote set-url origin git@github.com:wuruofan/agent-flow-ex.git
#    代码正文用 git checkout <§3 记录的 sha> 或 revert 改名那笔 commit（Step 1 是一次全量替换，
#    §3 第 5 步已留干净锚点）
npm run build
# 2) 数据（只回滚 log_path —— prompt/result/question 本次没被改写，无需回滚）
mv ~/.agent-ex ~/.agent-flow-ex
sqlite3 ~/.agent-flow-ex/tasks.db "UPDATE tasks SET log_path = replace(log_path, '/.agent-ex/', '/.agent-flow-ex/');"
# 2b) config.json 的 notify.keyword 改回（有 .bak 可直接覆盖还原）
mv ~/.agent-flow-ex/config.json.bak ~/.agent-flow-ex/config.json
# 3) 软链（三个宿主）
for d in ~/.agents/skills ~/.workbuddy/skills ~/.trae-cn/skills; do rm -f "$d"/agent-ex-dispatch; done
cd /Users/wuruofan/mine/rfw/agent-flow-ex
./scripts/install-skill.sh ~/.agents/skills ~/.workbuddy/skills ~/.trae-cn/skills
#    （代码仓库已由 git checkout 还原 ⇒ skills/agent-flow-dispatch/ 目录名也自动回来，
#      install-skill.sh 的 CANONICAL 才指向存在的路径）
# 4) MCP 配置三处改回（server id / args / env：AGENT_EX_HOME → AGENT_FLOW_HOME，路径 → ~/.agent-flow-ex）
#    → 面板 disable → re-enable
```

备份目录 `~/.agent-flow-ex.bak.<日期>` 在 §3 前置检查已创建；若迁移结果不符预期，可直接整目录还原（此时 `-wal` 已 checkpoint 落盘，还原即完整）。

---

## 9. 待确认

- [x] 名字 `agent-ex` 是否最终确认？→ **已确认**（2026-10-12，`ex` = external，作者本意）。注意：**先改 `agent_ex_` 工具名会留下已发布版本的兼容负担**——包未发布前改是零成本，发布后就难了
- [x] GitHub 仓库是否本次一起改名？→ **已改名**（2026-10-12 执行 `gh repo rename agent-ex`，见 §10 E-1）。301 已验证，本地 remote 已自动更新
- [x] 是否需要在 README 顶部加一段「旧名 → 新名」迁移说明？→ **不加**（2026-10-12 定）。无存量用户（0 star / 0 fork / 0 watcher，npm 未发布，2026-10-12 查证）；GitHub 改名自带 301；README 安装命令在 Step 1 一并改掉，改完自洽
- [x] **环境变量 / 驼峰标识符是否一并改名？→ 是**（2026-10-12 复核定）。目标 2 是"不留混用"，而 `AGENT_FLOW_HOME` 同时出现在 README 与本机 MCP 配置里，只改代码会造成读写两套名。改动零成本：包未发布、本机 `~/.zshrc` / `~/.zprofile` 都没有依赖它（已查）
- [x] **`project_path` 是否迁移？→ 否**（2026-10-12 实测 0 行含旧名，旧 SQL 是空操作）
- [x] **`prompt` / `result` / `question` 是否改写？→ 否**（历史记录逐字保留；改写会与验收 #4 冲突）
- [x] **验证命令形式 → `-E` 或 `git grep`**（Bash 工具里的 grep 是 toybox，不支持 BRE `\|`；`git grep` 还顺带排除 gitignore 目录）
- [x] ✅ **Trae 宿主的 MCP 配置文件路径** —— 2026-10-12 已全部定位并逐个读文件确认，共 **3 处**：`~/.workbuddy/mcp.json`（WorkBuddy）、`~/Library/Application Support/TRAE SOLO CN/User/mcp.json`（SOLO/traework，**全局**，已生效）、`<repo>/.trae/mcp.json`（Trae CN，**项目级**，untracked）。原先"需现场定位"的猜测作废。
- [x] **`config.json` 的 `notify.keyword` 是否改？→ 是**（2026-10-12 复核定）。它是 live config 不是历史记录，留旧名等于飞书通知继续带 `agent-flow-ex`，与目标 2 冲突；改前备份、回滚直接还原。
- [x] **skill 目录 `skills/agent-flow-dispatch/` 是否 rename？→ 是**（2026-10-12 复核定）。内容替换不会改目录名，而 `install-skill.sh` 用 `CANONICAL="$REPO_ROOT/skills/$SKILL_NAME"` 定位 ⇒ 必须 `git mv`，否则软链全断。

---

## 10. 2026-10-12 复核修正清单

（本次 review 只改本文件，未执行任何改名动作。逐条都有现场证据。）

| # | 原稿问题 | 修正 |
| :--- | :--- | :--- |
| P0-1 | 验证命令用 BRE `"a\|b"` —— Bash 工具里的 grep 是 **toybox 0.8.13，不支持 `\|`** ⇒ 改名前就已 0 命中，"期望 0 命中"是空门 | 全部换成 `grep -E` / `git grep -nEi`，并在正文写明为什么 |
| P0-2 | Step 3 `cd ~/workspace/agent-ex`：① 该目录要到 Step 4 的 `mv` 才存在；② 真实仓库在 `/Users/wuruofan/mine/rfw/agent-flow-ex`，`~/workspace` 下没有这个项目 | 路径全部改为真实路径；并把「目录与 git remote」调到软链修复**之前**（Step 3 → Step 4 互换） |
| P0-3 | 基线硬编码 98/98/6；`project_path` 迁移 SQL 目标串 `/workspace/agent-flow-ex` | 基线改为"现场实测并记录"（附 2026-10-12 实测 21/21/0）；删除该 SQL 并写明理由 |
| P1-4 | 只列两个软链宿主 | 补齐 `~/.agents/skills`（实测共三个）；写明"显式传参覆盖脚本默认目标"这个坑 |
| P1-5 | 替换表盖不住 `AGENT_FLOW_*`（5 个 env var，68 处）与 `agentFlow*` 驼峰（15 处），与目标 2 冲突 | 新增两行替换规则；关键文件补 `src/runner.ts`、`spawn-runner.ts`、`tools/test-helpers.ts`、`init.ts`、`config.example.json`；§9 记为已决项 |
| P1-6 | 验证的 `--include` 不含 `.md` ⇒ README/SKILL/references 全漏；补 `*.md` 又会被 `.workbuddy/memory/*.md` 误伤 | 改用 `git grep`（只搜跟踪文件，自动排除 node_modules/dist/.workbuddy） |
| P2-7 | 未提及 `package-lock.json`，而验证含 `*.json` ⇒ 必然失败且无指引 | Step 1 验证块加 `npm install --package-lock-only` |
| P2-8 | §3 只查 runner、不查 server；且 `ps` 在沙箱里 EPERM ⇒ 静默假通过 | 新增 Step 0（先 disable server）+ `lsof` 判定持有者；写明 `ps` 的 EPERM 陷阱 |
| P2-9 | Step 5 只提 command/args，漏 server id 与 env | §4 Step 5 给出 3 个宿主 × 3 处位置的完整对照表，并注明各文件结构差异 |
| P3-10 | 验收 #4「result 与改前一致」与 Step 2 改写 result 自相矛盾 | 明确"不改写三列自由文本"；#4 改为逐字未变的可执行验证 |
| P3-11 | §8 回滚未覆盖被改写的三列、且路径同样错 | 回滚镜像正向步骤（三个软链 + mcp.json 三处 + 不再回滚三列） |
| P3-12 | 验收 #2 写「127 全绿」 | 改为「与改前实测基线一致」（第二轮再修：原稿据此填的 123/4 也不对，见下 R-5） |
| P3-13 | 影响面数字 330/64/61 与 111+50+50+… 明细对不上现场（实测排除 docs 后 50/14/78/68/15，合计 189 行） | 表格换成实测值并标注口径 |
| P3-14 | §7 的 Actions 风险 | 降级为预防性说明（当前仓库无 `.github/workflows`） |
| P2-15 | Step 5 原文把 Trae MCP 配置写成"需现场定位"（当时只搜了 `~/.trae-cn/*.json`） | 实测定位到 3 个宿主的确切路径（`~/.workbuddy/mcp.json`、`TRAE SOLO CN/User/mcp.json`、`<repo>/.trae/mcp.json`），写成对照表；新增验收 #9（`git grep` 覆盖不到这 3 处） |
| P2-16 | 复核中途曾推断"SOLO 缺 `enableWorkspaceMcp` 键 ⇒ 只吃全局配置" | **该推断错误，已纠正**：逐 bundle 比对确认两版本实现逐字符相同、开关默认值都是 `false`；真实差别只是本机 Trae CN 设为 `true`、SOLO 未设置。也据此确认**无需升级**即可用全局路径 |
| 新增 | —— | §3 增加"干净锚点"（提交/记录 HEAD sha）供回滚；Step 2 增加"若实测 project_path 不为 0 则按实际值处置" |

### 第二轮 review 修正（2026-10-12 晚，同样只改本文件）

| # | 问题 | 修正 |
| :--- | :--- | :--- |
| R-1 (P0) | 替换表漏**裸 `agent-flow`**：实测 4 文件 7 行 ≥10 处（`README.md:232,414`、`SKILL.md:2`、`wait-task.mjs:2`、`src/init.ts:286`），前 5 行模式都匹配不到 ⇒ 按表执行完主验证必然剩 ~10 处 | 表格加兜底行 `agent-flow` → `agent-ex`，并注明**必须最后做**（否则 `agent-ex-ex`） |
| R-2 (P0) | **没人改名 `skills/agent-flow-dispatch/` 目录本身**：内容替换不改目录名，而 `install-skill.sh:43-44` 用 `CANONICAL="$REPO_ROOT/skills/$SKILL_NAME"` 定位 ⇒ Step 4 软链必断。git grep 扫不到目录名、`tests/` 无引用，会拖到验收 #5 才炸 | Step 1 加 `git mv skills/agent-flow-dispatch skills/agent-ex-dispatch`；§7 加对应风险行 |
| R-3 (P0) | §3 第 5 步 `git status --short 期望无输出` **永远过不了**：现场有 `?? .trae/`（untracked、不在 .gitignore）⇒ 执行者会被逼着把本机 MCP 配置 commit | 改 `git status --short -uno`，并注明 `.trae/` 为何不该入库 |
| R-4 (P1) | 验收 #9 第一条命令逻辑反了：`grep -c … \|\| echo 缺文件` —— 0 命中（正确态）时 grep 输出 `0` 且退出码 1，打印成 `0缺文件`；漏改反而不提示 | 先 `[ -f ]` 判存在、`grep -c \|\| true` 兜退出码、显式打印 OK / 残留 N 处（已在旧名状态下实测：两个存在的宿主正确报「残留 3 处」） |
| R-5 (P1) | 验收 #2 硬编码「123 passed / 4 skipped」，实测 Trae 终端是 **127 passed / 0 skipped**（15 files / 8.45s）；skipped 数随沙箱 `ps` 可用性浮动 ⇒ 与本文件 P0-3 批判的同款错误（拿历史数字当现场事实） | 改为「先跑一遍记基线，改完要求完全一致」；补注 skipped 浮动原因 |
| R-6 (P1) | Step 0 理由 #1 复现不了：3 个 server 进程活着，但 `lsof tasks.db` **0 持有者**、`tasks.db-wal` **不存在**（4.1MB 是 2026-10-11 历史观测） | 理由 #1 改为「按需打开、空闲已关闭，但随时可能被 submit 打开」；WAL 注明现状下是幂等 no-op、保留仅为防御 |
| R-7 (P2) | 数据目录 `~/.agent-flow-ex/config.json` 漏了：`notify.keyword = "agent-flow-ex"` 是 **live config**（非历史），不改则飞书通知继续带旧 keyword，与目标 2「不留混用」矛盾 | Step 2 补改法（含 `.bak` 备份 + 验证 grep）；§8 回滚补 `mv config.json.bak` 还原 |
| R-8 (P2) | Step 3 `mv` 后 **Trae CN 打开的工作区路径失效**，spec 只写了 MCP 重连 | Step 3 补「重新打开 `agent-ex` 文件夹」 |
| R-9 (P2) | Step 3 `set-url` 指向尚不存在的 `wuruofan/agent-ex` ⇒ 到 GitHub Rename 前 push/fetch 全 404，§9 只说「推送前再改仓库名」 | Step 3 明确「改名完成前不要 push」 |

### 执行期变更（2026-10-12 晚，改名开始前落地）

| # | 变更 | 说明 |
| :--- | :--- | :--- |
| E-1 | **GitHub 仓库已提前改名** | `gh repo rename agent-ex` 已执行（admin 权限），`wuruofan/agent-ex` → 200、旧地址 `wuruofan/agent-flow-ex` → **301**，本地 remote 已自动更新为 `git@github.com:wuruofan/agent-ex.git`。⇒ Step 3 的「远端 404 / 改名完成前禁 push」已失效，本段随之删除 |
| E-2 | **Trae CN 的项目级 `.trae/mcp.json` 已删除** | 用户决定不要（每改名一次就要跟着改，且含本机绝对路径）。⇒ Step 5 与验收 #9 从 3 处收敛为 **2 处**；Trae CN 当前不持有此 server。若日后要在 Trae CN 用，需新建 `Trae CN/User/mcp.json`（路径同构已验证，但无官方文档确认，配置后须实测） |
| E-3 | Step 1 的 `-uno` 与 §3 的 `.trae/` 说明作废 | `.trae/` 已随文件删除，`git status` 现在本就干净，`-uno` 不再必要（保留也无害） |

### 执行期实测偏差（2026-10-13 执行时发现，原 spec 未覆盖）

| # | 偏差 | 处置与应补的规则 |
| :--- | :--- | :--- |
| X-1 | **`mv ~/.agent-flow-ex ~/.agent-ex` 撞上已存在的目标目录**。Step 1 跑测试时 `AGENT_EX_HOME` 的新默认值 `~/.agent-ex` 已被创建（空目录），于是旧目录被**嵌套**进去（`~/.agent-ex/.agent-flow-ex/`），随后 `sqlite3 ... "UPDATE tasks"` 报 `no such table: tasks` | 已把嵌套层内容提出、核对 21 行数据完好、删除嵌套层与空壳 `tasks.db`，**无数据丢失**（日志 42 个文件全在）。⇒ Step 2 应加前置守卫：`[ -e ~/.agent-ex ] && ls -A ~/.agent-ex` 先看清是空壳还是有内容，再决定 `mv` / 合并 |
| X-2 | **Step 1 之后必须立刻 `npm run build`，测试才有意义**。integration 测试跑的是 `dist/runner.js`，dist 仍是改名前的旧代码 ⇒ 9 个用例报 `runner exited with code 2 before claim`。原 spec 把 build 放在 Step 5，太靠后 | 已补跑 build（dist 旧名残留 0），127/127 恢复。⇒ Step 1 的验证块应加「`npm run build` 后再 `npm test`」，否则 `npm test` 不是有效验收 |
| X-3 | **沙箱会拦写用户级目录**。`install-skill.sh` 与两份 `mcp.json` 都在 `~/.agents/skills`、`~/.workbuddy`、`~/Library/Application Support/TRAE SOLO CN/User` 下，会话沙箱直接报 `Operation not permitted`，即使开「需批准」也过不去 | 这三处由用户在终端执行（已完成）。⇒ 改名 spec 应写明「哪些步骤必然需要人在终端」，否则执行到一半才发现被拦 |
| X-4 | **目录改名会让 agent 会话的 cwd 失效**，后续工具调用报 `cwd does not exist`（工具无法自建终端，继承旧 cwd） | 用户在 IDE 里重新指定工作区后恢复。⇒ Step 3 之后应显式提示「重新打开工作区」，且执行顺序上更稳的做法是先提交再改名 |
| X-5 | `disabled: true` 是用户执行 Step 0 时由客户端写入的（两份 `.bak` 里本来就有），不是本次改名引入的 | 记录在案，避免日后误以为是残留字段 |
