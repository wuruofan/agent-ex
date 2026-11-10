# dispatch skill 的分发：打进 npm 包 + `agent-ex skill` 子命令

日期：2026-11-10
状态：待评审
关联：`README.md`「安装 dispatch skill」章节（112-180 行）、`scripts/install-skill.sh`、
`src/init.ts` 的 `nextSteps()`、`docs/designs/2026-10-30-wait-as-cli-subcommand.md`（同构先例）

---

## 1. 问题

dispatch skill（`skills/agent-ex-dispatch/`）是 MCP 工具之上的**派发规范层**：什么时候该派、
prompt 怎么写才自包含、同一目录的写任务为什么禁止并发、`needs_input` 怎么续跑、什么时候干脆别派。
它和 MCP 工具的关系见 `AGENTS.md`「文档分工」。

现在它有两条安装路线：

| 路线 | 机制 | 缺口 |
| :--- | :--- | :--- |
| A `npx skills add`（使用者） | 从 GitHub 拉**实体副本**到 `~/.agents/skills` | 联网 + npx 冷启动；第三方 CLI 的宿主表漏掉本机在用的宿主；装出副本后 CLI 升级、skill 仍旧 |
| B `scripts/install-skill.sh`（开发者） | 软链到本仓库 | 换机器就没有；逻辑是 bash，与 CLI 不是一套实现 |

本次要回答的是：**要不要把 skill 的分发收进 agent-ex CLI，以及收进来之后长什么样。**

## 2. 事实（本机实测，2026-11-10）

以下都是实测结果，不是推断。凡是"我没验的"一律列在 §8。

### 2.1 包与 skill 的体积

- `package.json:14-18` 的 `files` 白名单只有 `dist` / `config.example.json` / `README.md`。
- `tar -tzf agent-ex-mcp-0.3.1.tgz` 确认：已发布的包里**没有任何 `skills/` 目录**。
- `skills/agent-ex-dispatch/SKILL.md` = 85,549 B；整目录 135,721 B（`wc -c`）。
  ⇒ 打进包后 tarball 约 **+60 KB（gzip 后 63,532 B）**，相对当前 0.3.1 包的 126,477 B 约 +50%。可接受，但**不是"可忽略"**——README 与发布说明里要写明包体积涨了。

### 2.2 skill 对 CLI 的硬依赖

- `SKILL.md:12-13` / `:52-54`：等待环节调用 `agent-ex wait <task_id>`，要求 `agent-ex-mcp >= 0.3.1`
  （`include_finished` 是 0.3.1 才加的，0.3.0 会**静默剥离**这个未知参数）。
- `README.md:133-135`：没装全局包时，skill 退回 `npx -y agent-ex-mcp@latest wait`（更慢、且要联网）。
- ⇒ **任何要用这个 skill 的人，机器上必然有 npm 包**（全局装或 npx 拉）。这一点是分发方案的地基。

### 2.3 宿主怎么发现 skill（本机实测，纠正了一个想当然）

逐个 `ls -la` + `find -type l -exec readlink` 本机用户级 skills 目录（精确计数，非概括）：

| 宿主目录 | 软链数 | 指向形态（精确） |
| :--- | :--- | :--- |
| `~/.agents/skills` | 2 | `agent-ex-dispatch` → **本仓库**（绝对）；`galaxy-commit` → `~/.oh-my-galaxy/`（绝对，第三方） |
| `~/.claude/skills` | 4 | **3 条相对** `../../.agents/skills/<name>`（humanizer-zh / mmx-cli / progressing）；1 条绝对 → oh-my-galaxy |
| `~/.trae-cn/skills` | 9 | **6 条相对** `../../.agents/skills/<name>`；`agent-ex-dispatch` → **本仓库**（绝对）；1 条绝对 → oh-my-galaxy；1 条绝对 → 另一仓库 |
| `~/.workbuddy/skills` | 11 | **7 条绝对** → `~/.agents/skills/<name>/`（hook 桥接）；`agent-ex-dispatch` → **本仓库**（绝对）；2 条绝对 → 第三方/另一仓库 |
| `~/.codex/skills` | 0 | 只有 `.system/` |
| `~/.config/opencode/skills` | 0 | 空 |

⇒ **纠正**：「`~/.agents/skills` 是共享目录，装进去所有宿主都能读到」是**错的**。
   实测宿主是通过**每家一条软链**指向 `~/.agents/skills` 的（相对或绝对两种形态都有）。
   ⇒ canonical 必须落在 `~/.agents/skills`，**且每家宿主都要一条链**——宿主表是必需品，不是可选项。

### 2.4 三类软链的来源归因，以及 WorkBuddy 的自动桥接 hook

#### 2.4.1 本机三类软链的来源

按「链接目标形态 + 时间戳」归因（`find -type l -exec stat`）：

| 位置 | 目标形态 | 时间 | 来源 |
| :--- | :--- | :--- | :--- |
| `~/.agents/skills/agent-ex-dispatch` | 绝对路径 → **本仓库** | 10-13 09:50 | `scripts/install-skill.sh` |
| `~/.workbuddy/skills/agent-ex-dispatch` | 绝对路径 → **本仓库** | **10-13 09:50** | **同上（同一秒、同一次运行）** |
| `~/.trae-cn/skills/agent-ex-dispatch` | 绝对路径 → 本仓库 | 10-13 09:50 | 同上 |
| `~/.claude/skills/*`（**3 条**：humanizer-zh / mmx-cli / progressing） | **相对** `../../.agents/skills/*` | 9/4 ~ 10/29 | `npx skills` CLI |
| `~/.trae-cn/skills/*`（**6 条**相对） | 相对 `../../.agents/skills/*` | 3/12 ~ 10/29 | `npx skills` CLI |
| `~/.workbuddy/skills/*`（**7 条**：humanizer-zh / mcp-builder / mmx-cli / progressing / skill-creator / skill-vetter / template-skill / web-fetch-as-markdown 中的 7 个） | 绝对路径 → `~/.agents/skills/<name>/` | 10-21 16:50 ~ 11-06 17:02 | **WorkBuddy 桥接 hook** |
| `~/.claude/skills/galaxy-commit`、`~/.trae-cn/skills/galaxy-commit`、`~/.workbuddy/skills/galaxy-commit`、`~/.workbuddy/skills/blog-voice` | 绝对路径 → `~/.oh-my-galaxy/` 等第三方位置 | — | 与本功能无关 |

⚠️ **别把 `~/.workbuddy/skills/agent-ex-dispatch` 当成 hook 的产物**——它是 `install-skill.sh` 装的
（与 `~/.agents/skills` 那条同一次运行），不是桥接出来的。三条 `agent-ex-dispatch` 链同源于 10-13 的开发者路线。

#### 2.4.2 hook 本身的行为（隔离实验实测）

`~/.workbuddy/hooks/sync-agents-skills.sh` 存在，逻辑是：

- 遍历 `~/.agents/skills/*/`，凡是含 `SKILL.md` 的，就 `ln -s` 到 `~/.workbuddy/skills/<name>`；
- **从不覆盖**已存在的条目；跳过 builtin/plugin 保留名（`.reserved-skill-names`）与
  `.excluded-skill-names` 里的名字；
- **剪掉**指向 `~/.agents/skills` 的失效软链（源被删了才剪）；
- 幂等，每个会话启动跑一次。

**实测（隔离，不碰真实目录）**：hook 支持 `AGENTS_SKILLS_DIR` / `WORKBUDDY_SKILLS_DIR` 覆盖目录，
于是可以在临时目录里跑它：

```bash
P=$(mktemp -d); mkdir -p "$P/agents/probe-skill" "$P/wb"
printf -- '---\nname: probe-skill\n---\n' > "$P/agents/probe-skill/SKILL.md"
AGENTS_SKILLS_DIR="$P/agents" WORKBUDDY_SKILLS_DIR="$P/wb" \
  WORKBUDDY_SKILL_CACHE="$P/none.json" bash ~/.workbuddy/hooks/sync-agents-skills.sh
# → synced 1 skill(s) from ~/.agents/skills
# → $P/wb/probe-skill -> $P/agents/probe-skill/    （绝对路径软链）
rm -rf "$P"
```

⇒ hook 确实会把 `~/.agents/skills/*` 桥接进 `~/.workbuddy/skills`。**结论方向成立，但证据是这条实验，
不是那条手工链。**

#### 2.4.3 由此逼出的两个约束（**原设计的漏洞**）

**约束 A：canonical 必须在 `~/.agents/skills`，否则 hook 桥接不了。**
hook 只认 `~/.agents/skills` 这一个源。canonical 落到别处（`--target` 指到别的目录）⇒
WorkBuddy 侧永远没有链。⇒ canonical 路径**固定**为 `~/.agents/skills/<name>`，不开放覆盖。

**约束 B：hook「从不覆盖已存在的条目」⇒ 已存在的手工链，hook 永远不接管。**
本机 `~/.workbuddy/skills/agent-ex-dispatch` 就是这样一条手工链（指向仓库）。后果：

1. 用户从「开发者路线」（软链到仓库）切到「用户路线」（包内拷贝到 `~/.agents/skills`）时，
   **workbuddy 侧那条链仍然指向仓库** ⇒ WorkBuddy 里用的还是仓库那份，不是新装的。
   而 hook 因为"条目已存在"也不会去改它。⇒ **必须由 install 主动发现并重指**（§4.2 第 2 步）。
2. `remove` 若按"软链必须指向 canonical 才删"的规则，会**拒绝删这条链** ⇒ 卸不干净。
   ⇒ remove 的规则必须改成：**软链一律可删**（删链接不丢数据，只需打印它原本指向哪），
   **只有实体目录才拒绝**（§4.4）。

⇒ 「装完提示是否链到 workbuddy」在**没有**自动桥接的机器上仍然必要；在**有**桥接的机器上，
真正该提示的不是"要不要链"，而是"**你已有一条指向别处的链，要不要重指到新的 canonical**"（§4.3）。

⚠️ 但 hook 是 **WorkBuddy 侧的行为，不是 agent-ex 可以假设的普遍事实**——别的机器可能没有这个 hook。
⇒ 设计不能写死"WorkBuddy 会自动桥接"，只能**探测后按需分支**（§4.3）。

### 2.5 既有文档的过期与矛盾（本次一并修）

- `README.md:122` 说 skill 含 `scripts/` —— 目录里早没了，只剩 `SKILL.md` + 2 个 `references/`。
- `README.md:122` 说 skill 含 `scripts/` —— 目录里早没了，只剩 `SKILL.md` + 2 个 `references/`。
- ⚠️ **`README.md:175` 与 `:143-144` 并不矛盾**（原先这里写成"自相矛盾"，是误归因，已更正）：
  `:143-144` 全文只讲 **WorkBuddy**（`skills` CLI 的宿主表里最接近的是 `codebuddy` → `~/.codebuddy/skills`），
  `:175` 讲的是 **Trae**（"路线 A 则去掉 `-g`，按 CLI 提示选 Trae"）。两者讲的是不同宿主，没有对照关系。
  ⇒ 真正待核实的是另一件事：**`skills` CLI 是否真有 Trae 选项、它会装到哪个路径**——本仓库没运行过该 CLI，无法确认。
  ⇒ README 要改的不是"消除矛盾"，而是**把 Trae 的安装路径交给 `agent-ex skill install` 去探测**（`~/.trae-cn/skills`，
  路径随安装版本变），并删掉对第三方 CLI 行为的转述。

### 2.6 独立评审的结论

同一设计的第二意见由 worker 独立产出（agent-ex 任务 `task_mwa03rkx_3f3338`，opencode-zen-free profile，
256 秒，零文件改动）。它**同意选 A**，但纠正了我草案的两处事实错误与两处判断错误：

| 我草案里写的 | 评审查到的 | 处置 |
| :--- | :--- | :--- |
| "任何使用者都已经装了 npm 包" | `SKILL.md:54` + `README.md:133-135` 支持没装包、走 npx 回退 | 事实错。论据改成「无论如何都依赖 npm 包，只是可能以 npx 形式」 |
| "skill 是 52KB" | 85,549 B / 135,721 B | 事实错，已更正（§2.1） |
| "`dist/../skills` + 软链 = 零分叉" | 开发者要"改完即生效"，用户要"升级即更新且不悬空"，**更新语义不同**；pnpm 的全局包目录是指向 store 的软链，升级后旧链悬空 | 判断错。改成显式两条路线：用户拷贝、开发者软链 |
| 否定 B 只给了原则 | 五条具体失败场景（GitHub 不可达/内网代理、`skills` CLI 未锁版本、host 表缺宿主、装出副本导致 CLI 升级后 skill 仍旧、自动执行第三方 CLI 的供应链风险） | 判断错。已补进 §7 |

## 3. 决策

| # | 决策 |
| :--- | :--- |
| D1 | **skill 打进 npm 包**：`package.json` 的 `files` 加 `"skills/agent-ex-dispatch"`——**只发这一个 skill**，避免 `skills/` 下未来新增的内容被动进包。（⚠️ 原先的理由"不写 `skills` 是为了避开 `.DS_Store`"**不成立**：实测 `files:["skills"]` 时 npm 也不会打包 `.DS_Store`，`.gitignore`/npm 默认排除。）分发以包内那份为准。 |
| D2 | 新增 `agent-ex skill install` / `remove` / `status` 三个子命令。 |
| D3 | **不提供 `update`**。`install` 幂等即刷新；开发者路线是软链、天然实时。 |
| D4 | **用户路线=拷贝，开发者路线=软链**。两条路线显式分开，不追求"一份实现覆盖两边"。 |
| D5 | **canonical + 宿主链接**两层：canonical **固定**在 `~/.agents/skills/agent-ex-dispatch`（不开放覆盖——自动桥接只认这个源，§2.4.3 约束 A），每个宿主一条软链指向它。宿主表 `SKILL_HOSTS` 是唯一真相源。 |
| D6 | **init 只打印 `agent-ex skill install`，不执行安装**。 |
| D7 | **init 收尾信息精简**（实测 39 行 → 24 行；非默认 home 26 行）。`AGENT_EX_HOME` **只在非默认路径时**保留 export 那一步（默认路径整步省略；同时写进 MCP 片段的 `env` 字段，**但那不能替代 export**——它只影响 MCP client 拉起的 server，用户手敲的 CLI 命令仍需要这个变量）。 |
| D8 | **doctor 加 skill 段**，但**不塞进 `collectConfigIssues()`**——那是 `config.json` 的真相源，skill 状态不是 config。新建 `collectSkillIssues()` 与之平行。 |
| D9 | **不引入状态文件**。装了什么、能删什么、有没有过期，全部从文件系统推导（`lstat` + `readlink` + 内容 hash）。多一份状态文件就是多一份会漂移的真相。 |

### D1 的论据

1. **不增加任何前置步骤**：skill 硬依赖 `agent-ex` 二进制（§2.2），所以使用者无论走哪条路都已经在用 npm 包。
   把 skill 放进同一个包 = 一次下载同时拿到两样东西。
2. **版本一致性**：skill 里写死了 `>= 0.3.0` / `>= 0.3.1` 门槛。从 GitHub main 拉 skill 可能比用户装的 CLI **更新**，
   那是更危险的错配方向（0.3.0 静默剥离 `include_finished` 就是现成的活证据）。包内那份永远与 CLI 同版本。
3. **宿主目录可控**：第三方 CLI 的宿主表漏掉本机在用的宿主（§2.3/§2.4），而宿主表我们自己掌握。
4. **可离线、可测**：CI 不需要网络。

### D3 为什么不要 update

- 用户路线是拷贝 ⇒ 刷新 = 重装，`install` 幂等即可，不需要第二个动词。
- 开发者路线是软链 ⇒ 天然实时，压根用不上。
- 独立的 `update` 若定义为"从 GitHub 拉最新"，等于给 **skill 与 CLI 版本脱钩**开口子——正是要避免的。
- 真正要解的问题是"包升级了但拷贝没刷新"，那是**信息**问题：doctor 检测到过期并给出修复命令 `agent-ex skill install`。

**代价（明说）**：skill 文档迭代（周级）会比 npm 发版（月级）慢，用户拿到的文档可能比 GitHub main 旧几周。
判为可接受——反方向的错配会直接踩坏。等真有人抱怨 skill 旧了，再加一个显式的
`skill install --from-github`（标注为脱离版本锁定的高级选项），路径先留着。

## 4. 对外契约

### 4.1 命令面

```
agent-ex skill install [options]
  --target <dir>   额外宿主目录（可重复）：不经询问直接建链
  --source <dir>   skill 源目录（默认：本模块内置的那份）
  --link           开发者路线：canonical 用软链而不是拷贝
  --yes            跳过所有询问，给所有探测到的宿主建链
  -h, --help

agent-ex skill remove [options]
  --target <dir>   只移除指定目标（默认：移除所有我们能认出来的）
  --yes            不询问

agent-ex skill status
  只读，无参数
```

退出码沿用现有 CLI 约定：**0** 成功 / **1** 有失败 / **2** 用法错误。

### 4.2 install 的流程

```
1. 解析 source（默认 = 相对本模块位置解析的 <module>/skills/agent-ex-dispatch）
2. 解析 canonical = `~/.agents/skills/agent-ex-dispatch`（**固定**，不开放覆盖——理由见 §2.4.3 约束 A：
   自动桥接机制只认 `~/.agents/skills` 这一个源，canonical 挪走就桥接不了）
     --link → canonical 是指向 source 的**软链**
     默认    → canonical 是 source 的**拷贝**
3. canonical 已存在：
     软链且指向同一 source → skip（幂等）
     软链但指向别处        → 问是否重指（--yes 直接重指）
     实体目录              → **中止**，提示用户手工处理（沿用 install-skill.sh:90-94 的 abort 语义）
4. 建宿主链：逐个探测到的宿主目录，问是否建链（--yes 全建，--target 的直接建）
5. 打印结果清单
```

**宿主链接一律指向 canonical**（不是指向 source）：canonical 是唯一真源，`remove` 才能干净地删干净。

⚠️ **第 3 步的"软链但指向别处"是本机当前的真实状态**，不是理论情况：
`~/.workbuddy/skills/agent-ex-dispatch` 与 `~/.trae-cn/skills/agent-ex-dispatch` 都指向**仓库**
（§2.4.1）。用户从开发者路线切到用户路线时，这两条必须被**重指到 canonical**，
否则 WorkBuddy / Trae 里用的还是仓库那份——而自动桥接机制**不会**纠正它（§2.4.3 约束 B）。

### 4.3 提示文案按"有没有自动桥接"分流

对每个探测到的宿主目录，分三种情形：

- 该宿主**已有指向 canonical 的链** → `already linked`
- 该宿主**已有一条指向别处的链**（本机的 workbuddy / trae 就是这样）
  → 提示"现有一条链指向 <target>，要不要重指到新的 canonical？"
  → **重指**（--yes 直接重指）。⚠️ 即便该宿主有自动桥接机制，也**必须**重指：
    hook「从不覆盖已存在的条目」，它不会接管这条链（§2.4.3 约束 B）。
- 该宿主**没有链**：
  - 若探测到该宿主有自动桥接机制（当前只发现 WorkBuddy 的 `~/.workbuddy/hooks/sync-agents-skills.sh`）
    → 提示"它会自动桥接，不用手工链"，**不建链**
  - 否则 → 问"要不要链到它？"

⇒ 用户提的"装完提示是否链接到 workbuddy"落在这里：**有 hook 的机器上，若已有链则提示重指、
若没有链则提示不用管；没有 hook 的机器上才真的问要不要链。** 事实优先，不写死。

### 4.4 remove 的规则

- canonical 是**拷贝** → 删掉这个目录
- canonical 是**软链** → 只删链接，**不删 target**
- 各宿主目录下 `agent-ex-dispatch`：
  - 是**软链** → **删**（删链接不丢数据），并打印它原本指向哪
    ⚠️ **不要求它指向 canonical**：本机 workbuddy / trae 那两条指向仓库的链也必须能删掉，
    否则"从开发者路线切回用户路线"之后永远卸不干净（§2.4.3 约束 B）。
    唯一的例外是它指向 canonical 本身时，删 canonical 与删链接要**按顺序**做，别把 canonical 删成断链。
  - 是**实体目录** → **拒绝删**，提示用户手工处理（分不清是用户自己的还是被改过的）
- `ln` 陷阱（`README.md:150-151`）：`ln -s` 对已存在的目录目标不报错，会把软链塞进目录里。
  ⇒ 一律用 `fs.symlinkSync` + 前置 `lstat`，**绝不**用 shell `ln`。

### 4.5 status 的输出

只读，一次给全三件事：

```
Skill: agent-ex-dispatch
  bundled   /usr/local/lib/node_modules/agent-ex-mcp/skills/agent-ex-dispatch  (132 KB, sha a1b2c3d4e5f6)
  canonical ~/.agents/skills/agent-ex-dispatch  [copy]  up-to-date
  hosts
    ok   ~/.claude/skills/agent-ex-dispatch      -> ~/.agents/skills/agent-ex-dispatch
    ok   ~/.workbuddy/skills/agent-ex-dispatch   -> ~/.agents/skills/agent-ex-dispatch
    --   ~/.trae-cn/skills/agent-ex-dispatch      (not linked)
```

**过期判定**（不需要状态文件）：
- canonical 是软链 → 永远不过期（指向源，源变了自动跟随）
- canonical 是拷贝 → 比对内容 hash（`sha256(排序后的 "相对路径\0内容")`，取前 12 位 hex）

### 4.6 doctor 的 skill 段（info 级，不影响 exit code）

- 未安装 → `info`："dispatch skill is not installed" + fix `agent-ex skill install`
- 已安装但拷贝与包内那份不一致 → `warn`："installed copy is older than the bundled one" + fix `agent-ex skill install`
- 已安装且最新 → `ok`
- 有宿主目录存在但没链 → `info`，列出可链的宿主

⚠️ **不塞进 `collectConfigIssues()`**：那是 `config.json` 的真相源，skill 状态不是 config。
   平行新建 `collectSkillIssues()`，installer 与 doctor 同源消费（对齐 `config.ts` 的单一真相源模式）。

## 5. 代码结构

| 文件 | 职责 |
| :--- | :--- |
| `src/skill.ts`（新） | `SKILL_HOSTS` 宿主表 + `collectSkillIssues()` + `inspect/install/remove` 纯逻辑 + 内容 hash。**宿主表与安装状态的唯一真相源** |
| `src/skill-cmd.ts`（新） | `runSkill(args)`：`install` / `remove` / `status` 的 CLI 入口与文案。**独立模块，不放 `cli.ts`**——`cli.ts:8` 静态 import `./doctor.js` → `model-check.js` → `executors/types.js` → claude/opencode/fake，为一个纯文件操作拖进整套 executor 依赖（不违反硬约束 7 的字面禁令，但违反"每个分支都要用且便宜"的精神） |
| `src/server.ts` | `USAGE` 加一行；新增 `skill` 分支，**分支内动态 import** `./skill-cmd.js`（AGENTS.md 硬约束 7） |
| `src/doctor.ts` | 消费 `collectSkillIssues()`，加 skill 段（info 级） |
| `src/init.ts` | `nextSteps()` 精简；skill 段换成 `agent-ex skill install` |
| `scripts/install-skill.sh` | 改成薄壳，调 TS 实现（开发者软链路线），避免 bash/TS 两份实现漂移 |
| `package.json` | `files` 加 `"skills/agent-ex-dispatch"` |
| `skills/agent-ex-dispatch/SKILL.md` | **安装段（:9-11）要改**：它现在指向 `npx skills add` 与"README 的路线 A"，而路线 A 已降级为附录 |
| `AGENTS.md` | **:43**「skills 走 GitHub 分发，**不进 npm 包**」与 D1 正面冲突，必须改；**:108** 的 files 表也要同步 |
| `README.md` | 112-180 重写两条路线；修 §2.5 的过期处；命令表；**:726** 与 **729-731** 两处 files/分发说明 |
| `tests/skill.test.ts`（新） | 宿主表 / 幂等 / 实体目录中止 / 拷贝 vs 软链 / hash 过期判定 |
| `tests/doctor.test.ts` | 现有用例大量用 `doctor({ home: tmp })`；skill 状态在**用户 home** 下，必须让两者可分开注入，否则测试会去读真实的 `~/.agents/skills` |
| `tests/init.test.ts` | `nextSteps` 断言跟着改 |

### 宿主表（D5 的落地）

```ts
export interface SkillHost {
  id: string;           // "agents" | "claude" | "workbuddy" | "trae-cn" | ...
  label: string;        // 人类可读名
  dir: string;          // 用户级 skills 目录（绝对路径）
  /** 该宿主是否自带"从 ~/.agents/skills 自动桥接"的机制（有就别手工链）。 */
  autoBridge?: (home: string) => boolean;
}
```

宿主表是**数据**，不是 if-else 分支——加一家宿主只加一行。

## 6. init 收尾信息精简（D7）

现在 `nextSteps()`（`src/init.ts:367-400`）实测渲染 **39 行**（非空 31）——原写"33 行"是估计值，以实测为准。逐条处理：

| 现在 | 处理 | 理由 |
| :--- | :--- | :--- |
| ① `export AGENT_EX_HOME=...` 整步 | **改成条件保留**：默认路径（`~/.agent-ex`）整步省略；**非默认路径必须留** | ⚠️ 写成"直接删掉"是错的：MCP 片段的 `env` 只影响 MCP client 拉起的 server 进程；用户随后手敲的 `agent-ex config set …` / `agent-ex doctor --send` 仍在**没有**该变量的 shell 里 ⇒ 会读写默认 `~/.agent-ex`。"一步 export"不能换成"静默打错目录" |
| ② MCP 片段 + "Absolute paths matter…" 三行散文 | 压成一行 | "Use absolute paths — MCP clients don't inherit your shell PATH." 必须留（挡最常见的启动失败），但三行散文是散文 |
| ③ skill 段（npx 命令 + clone 提示 + `find ~ -maxdepth 4`） | 换成一行 `agent-ex skill install` | `find` 那条是**排障**命令不是安装步骤 → 挪进 README |
| ④ dry-run 段 | 保留两条命令，删掉 "body must not contain the product name…" | 那是 `doctor --send` 的内部细节，不是 init 该讲的 |
| ⑤ "Optional: edit config.json…" | 压成一行尾巴 | |

改完（默认路径，**24 行**；非默认路径多出 export 一行，**26 行**）：

```
Next steps:

1) Register the MCP server in your client (Trae: TRAE SOLO CN/User/mcp.json,
   WorkBuddy: ~/.workbuddy/mcp.json):
     {
       "mcpServers": {
         "agent-ex": {
           "command": "/abs/node",
           "args": ["/abs/dist/server.js"]
         }
       }
     }
   Use absolute paths — MCP clients don't inherit your shell PATH.

2) Install the dispatch skill (recommended):
     agent-ex skill install

3) Feishu notifications are in dry-run mode — nothing is delivered yet:
     agent-ex config set notify.dry_run false
     agent-ex doctor --send

Tune later: agent-ex config set <key> <value> | agent-ex profile set <profile> <KEY> <value>
```

⚠️ **行数是算出来的，不是估的**：`mcpServerSnippet` 用 `JSON.stringify(…, null, 2)` ⇒ 片段展开 **10 行**；
模板其余部分 14 行 ⇒ 合计 24 行（非默认路径 +2 行 export）。⇒ 断言写 **"默认路径 ≤ 24 行 / 非默认 ≤ 26 行"**，
不要写成 "≤ 16"（原写的 14 行是**把片段画成单行**数出来的，与实现不符）。

init 交互过程中的其它输出（CLI 探测、toolchain 提示、备份、校验）**全部保留**——那些是"正在发生的事"。

⚠️ init 的用户可见输出**必须全英文**（`tests/init.test.ts:217-232` 会扫中文字符）。
⚠️ 连带：`tests/init.test.ts:397-408` 的断言要跟着改；
     `mcpServerSnippet` 的签名要显式改成 `mcpServerSnippet(serverEntry, home?)`（`home` 可注入 ⇒ 测试不依赖开发机的 `homedir()`）。

## 7. 风险与取舍

| # | 风险 | 对策 |
| :--- | :--- | :--- |
| R1 | skill 文档迭代快于 npm 发版 ⇒ 用户拿到的文档旧 | 判为可接受（版本错配比文档滞后危险）。真被抱怨时加 `install --from-github` |
| R2 | 宿主目录表要维护（各家 IDE 路径会变，Trae 还随版本变） | 表里只放**已验证**的路径；探测到才提示；`--target` 兜底 |
| R3 | 软链在 pnpm/yarn 全局安装下可能悬空（包目录是 store 软链） | 用户路线用**拷贝**，不依赖包目录的软链结构 |
| R4 | 目标已有实体目录时覆盖 = 数据丢失 | 沿用 `install-skill.sh:90-94` 的 abort 语义，绝不覆盖 |
| R5 | 宿主侧**已存在**指向别处的同名软链（如本机 workbuddy / trae 指向仓库那两条）——自动桥接机制"从不覆盖已有条目"，永远不接管它 | install 必须**主动发现并重指**到 canonical（§4.2 第 3 步、§4.3 第二种情形）；remove 必须能删掉这类链（§4.4） |
| R6 | 宿主目录里已有**同名**的别的 skill（保留名/排除名） | 探测到已存在的同名条目 → 跳过并报告，不覆盖 |
| R7 | npm 包多一份分发渠道 ⇒ 仓库与包里的 skill 是两份快照 | 源仍是仓库的 `skills/`，包只是发布产物；过期由 doctor 报，由 `install` 刷新 |
| R8 | `remove` 误删用户自己的文件 | **软链一律可删**（删链接不丢数据，打印原指向）；**实体目录一律拒绝**并提示手工处理；canonical 是拷贝时删目录，是软链时只删链接 |

## 8. 不做什么

- **不做 `skill update`**（D3）。
- **不做"从 GitHub 拉 skill"**（D1/D3；路径留着，需要时再加 `--from-github`）。
- **不把 skill 安装塞进 `init` 的交互流程**（D6）。init 是全量覆盖式的成功向导，skill 安装是可选件、
  要写多个宿主目录、且遇实体目录按现有语义必须中止——把"成功向导"变成"硬失败"不合理。
  若日后要一键，另加非交互的 `--with-skill`，不复用 init 主流程。
- **不做通用 skill 框架**（不引入目录扫描、多 skill 依赖解析）。我们只内置一个 skill。
- **不引入状态文件**（D9）。
- **不改 MCP 工具面**（不新增 `agent_ex_skill` 之类的工具）——安装 skill 是宿主侧的动作，agent 用不到。

## 9. 未验证 / 存疑

- 第三方 `skills` CLI 的宿主表与 `--skill/-g/-y` 语义：**未运行该 CLI**，采信 `README.md:143-147` 的记录。
- Windows 的 `fs.symlinkSync(..., 'junction')` 行为：**未实测**。本仓库其它脚本也是 bash 路线
  （`install-skill.sh`），当前按 Unix 优先设计；若要支持 Windows 需要单独一轮。
- pnpm / yarn 全局安装的目录布局：**未实测**，R3 是基于常见布局的判断。
- WorkBuddy 的桥接 hook 是否所有 WorkBuddy 版本都有：**未验证**——本机有，所以 §4.3 用探测而不是假设。
