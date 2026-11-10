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
   而 hook 因为"条目已存在"也不会去改它。⇒ **必须由 install 主动发现并重指**（§4.4）。
2. `remove` 若按"软链必须指向 canonical 才删"的规则，会**拒绝删这条链** ⇒ 卸不干净。
   ⇒ remove 的规则必须改成：**软链一律可删**（删链接不丢数据，只需打印它原本指向哪），
   **只有实体目录才拒绝**（§4.5）。

⇒ 「装完提示是否链到 workbuddy」在**没有**自动桥接的机器上仍然必要；在**有**桥接的机器上，
真正该提示的不是"要不要链"，而是"**你已有一条指向别处的链，要不要重指到新的 canonical**"（§4.4）。

⚠️ 但 hook 是 **WorkBuddy 侧的行为，不是 agent-ex 可以假设的普遍事实**——别的机器可能没有这个 hook。
⇒ 设计不能写死"WorkBuddy 会自动桥接"，只能**探测后按需分支**（§4.4）。

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
| D7 | **init 收尾信息精简**（实测 39 行 → 24 行；非默认 home 30 行）。`AGENT_EX_HOME` **只在非默认路径时**保留 export 那一步（默认路径整步省略；同时写进 MCP 片段的 `env` 字段，**但那不能替代 export**——它只影响 MCP client 拉起的 server，用户手敲的 CLI 命令仍需要这个变量）。 |
| D8 | **doctor 加 skill 段**，但**不塞进 `collectConfigIssues()`**——那是 `config.json` 的真相源，skill 状态不是 config。新建 `collectSkillIssues()` 与之平行。 |
| D9 | **provenance 随 skill 内容走**：拷贝模式下在**拷贝目录内**写 `.agent-ex-skill.json`（版本 + sha）。归属判定只需读那一个目录本身 ⇒ 不用跨两处对账，**也就不需要集中状态文件**。版本号 = 打包它的 agent-ex 包版本（`dist/build-meta.json` 的 `version`）。软链模式**不写** marker（会弄脏仓库）。 |

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
  --yes            跳过所有询问（默认不链的宿主仍需 --target 显式指定）
  -h, --help

agent-ex skill remove [options]
  --target <dir>   只移除指定目标（默认：移除所有我们能认出来的）
  --yes            不询问

agent-ex skill status [--source <dir>]
  只读，无参数（--target 不接受：status 只报本机状态，没有"额外目标"可言）
```

退出码沿用现有 CLI 约定：**0** 成功 / **1** 有失败 / **2** 用法错误。

补充三条（2026-11-10 代码评审后定）：

- **非交互环境默认拒绝写操作**：不是 TTY 且没给 `--yes` ⇒ 写操作**在动手之前**就退出（码 2）。
  之前的顺序是"先写 canonical，再在提问那一步抛错"⇒ 已经在用户磁盘上留了半份安装。
- **`--yes` 也不给默认不链的宿主建链**：`--yes` 的语义是"所有问题都答 yes"，
  不是"所有宿主都链上"。codex / opencode 这类默认不链的宿主仍需 `--target` 显式指定。
- **"还有东西留在原地" ⇒ 退出码非 0**：卸载的目的就是让东西消失，
  实体目录 / 外来目录删不掉时不能报 0（会让人以为已经干净了）。

### 4.2 canonical 的状态机

canonical = `~/.agents/skills/agent-ex-dispatch`（**固定**，不开放覆盖——理由见 §2.4.3 约束 A：
自动桥接机制只认 `~/.agents/skills` 这一个源，canonical 挪走就桥接不了）。

**归属与版本怎么判定（单一真相源）**

拷贝模式下，安装时在**拷贝目录内**写一个 marker：`.agent-ex-skill.json`

```json
{ "skill": "agent-ex-dispatch", "version": "0.3.2", "sha": "a1b2c3d4e5f6", "source": "<source 绝对路径>" }
```

- **版本号 = 打包这份 skill 的 agent-ex 包版本**（`dist/build-meta.json` 的 `version`）。
  已发布的 npm 包不可变 ⇒ 包版本 ⟹ skill 内容版本，一一对应，**零人工维护**。
- marker 放在**拷贝目录内**、不是集中状态文件：归属判定只需读**那一个目录本身**就得出，
  不用跨两处对账（集中状态文件会漂移：用户手工删了 skill，状态文件还在说"已装"）。
- ⚠️ **软链模式不写 marker**——canonical 指向仓库，写进去会弄脏 git 工作树。

**canonical 的六态**

| 态 | 判据 | 归属 |
| :--- | :--- | :--- |
| `missing` | 路径不存在 | — |
| `link→source` | 是软链，且 target == 本次 source | 我们装的 |
| `link→elsewhere` | 是软链，target != source | **别人的**（本机 workbuddy / trae 就是这样） |
| `managed-copy` | 是实体目录 + 含 marker | 我们装的（版本可读） |
| `adoptable` | 是实体目录 + 无 marker + **内容 hash == bundled** | 内容一致 ⇒ 认领（补写 marker） |
| `foreign-dir` | 是实体目录 + 无 marker + hash != bundled | **不是我们装的**（或被改过） |

**动作矩阵**

| canonical 现状 | 拷贝模式（默认） | 软链模式（`--link`） |
| :--- | :--- | :--- |
| `missing` | 拷贝安装 + 写 marker | 建软链 |
| `link→source` | 问：已是开发者路线，是否切成拷贝？ | skip（幂等） |
| `link→elsewhere` | 问：删掉旧链并切成拷贝？ | 问：重指到 source？ |
| `managed-copy`，`version == 当前` | **skip**（幂等） | 问：是否换成软链？ |
| `managed-copy`，`version != 当前` | **问"是否更新"**（见下） | 同上 |
| `managed-copy`，hash != marker.sha（被手改过） | 问：更新会覆盖你的修改，继续？ | 同上 |
| `adoptable` | 认领：补写 marker，视作已装 | 问：是否换成软链？ |
| `foreign-dir` | **中止**，提示用户手工处理 | **中止** |

**"是否更新"的判定与动作**（用户提的那个问题，落在这里）

1. `marker.version != 当前包版本` ⇒ **需要更新** ⇒ 问"是否更新"
2. 问的时候**还要看有没有被手改过**：`hash(canonical) != marker.sha` ⇒ 额外提示"这份被改过，
   更新会覆盖你的修改"
3. 用户确认 ⇒ 覆盖（原子：写临时目录 → `rename`）
4. 用户否认 ⇒ 保持原样，退出码 0（不是失败）

⚠️ **只有 `managed-copy` 才会走"更新"这条路**。`foreign-dir` 一律中止——
绝不能拿"更新"的名义覆盖一个我们没装过的目录。

### 4.3 install 的完整流程

```
1. 解析 source（默认 = 相对本模块位置解析的 <module>/skills/agent-ex-dispatch）
2. 解析 canonical（固定）
3. 按 §4.2 的动作矩阵处理 canonical（该问的问、该中止的中止、该 skip 的 skip）
4. 建宿主链：逐个探测到的宿主目录，按 §4.4 的分流处理
5. 打印结果清单
```

⚠️ **source 不能是 canonical 自己**（2026-11-10 复审 P1-2）：
`--link --source ~/.agents/skills/agent-ex-dispatch` 会把 canonical 换成一条**指向自己的软链**
（自指循环 ⇒ 该路径不可读），而命令还会返回 0。
`--target` 早有同类检查，`--source` 当时漏了 ⇒ 现在两边对称：
`source` 等于 canonical（哪怕是别名路径）或在 canonical 里面，一律拒绝。

⚠️ **「在 canonical 里面」按真实位置判，不按字面路径**（2026-11-10 第四轮评审 P1）：
软链的字面 target 会被**原样**写进 canonical ⇒ 只要 source 的**真实位置**落在 canonical 里面
（哪怕路径写的是 `<canonical>/sub`，哪怕 source 本身是个指向 canonical 内部的软链），
换位后 canonical 就指向自己的子树 ⇒ ELOOP、路径不可读，而命令 exit 0。
唯一放行的是**开发者路线**：canonical 自己是软链、且 source 就是它指向的那个目录。

⚠️ **`--target` 也不能指进 canonical 里面**（2026-11-10 第三轮评审 P2-a）：
- copy 模式 ⇒ 在装好的 skill 目录里建出指向自己祖先的环（`hashDir` 跳过软链 ⇒ 告警看不见）；
- link 模式 + canonical 是软链 ⇒ 软链落进**源码树**（仓库里凭空多出一个文件）。
⇒ 检查按**两条**算：链接位置在 canonical 路径里面，或在 canonical 的 realpath 里面
（开发者路线下 canonical 指向仓库里的 skill 目录）。

⚠️ canonical 与宿主链的改动都是**原子替换**（先在临时名上做好新内容，再换位，失败回滚）：
- 失败时 canonical 原封不动，且**不留临时目录**（临时名带 pid，留着下次进程也清不掉）；
- 切成软链时**先建好新链再换位**——不是"先删 canonical 再建链"，
  否则建链失败就永久丢了那份安装；
- 宿主链的重指 / 断链修复同理（旧的链在换位成功前一直都在）。

⚠️ **占位探测用 lstat、不是 existsSync**（2026-11-10 第三轮评审 P1-a）：
`existsSync` **跟随软链** ⇒ canonical 是悬空软链时返回 false ⇒ 不把占位的链接名挪开
⇒ `rename(目录, 悬空软链)` 报 ENOTDIR ⇒ 安装必失败，
而 doctor 给该状态的修法恰恰是 `agent-ex skill install` ⇒ 告警永远修不掉。

**已知限制**：临时名带 pid（并发隔离的代价）⇒ 进程被 SIGKILL 时，
`.tmp.<pid>` / `.old.<pid>` 会残留，后续进程清不掉它们（内容无害：新内容已就位，
残留只是一份多余备份或半截临时副本）。
`agent-ex skill remove` 会顺手清掉这些残留（它们是 agent-ex 自己的产物，不是用户数据）；
`install` 不自动清 —— 按 mtime 清陈旧残留会误伤并发中的另一个安装，不值得。

**宿主链接一律指向 canonical**（不是指向 source）：canonical 是唯一真源，`remove` 才能干净地删干净。

⚠️ **"软链指向别处"是本机当前的真实状态**，不是理论情况：
`~/.workbuddy/skills/agent-ex-dispatch` 与 `~/.trae-cn/skills/agent-ex-dispatch` 都指向**仓库**
（§2.4.1）。用户从开发者路线切到用户路线时，这两条必须被**重指到 canonical**，
否则 WorkBuddy / Trae 里用的还是仓库那份——而自动桥接机制**不会**纠正它（§2.4.3 约束 B）。

### 4.4 宿主链接的三种情形

对每个探测到的宿主目录：

- 该宿主**已有指向 canonical 的链** → `already linked`
- 该宿主**已有一条指向别处的链**（本机的 workbuddy / trae 就是这样）
  → 提示"现有一条链指向 <target>，要不要重指到新的 canonical？"
  → **重指**（--yes 直接重指）。⚠️ 即便该宿主有自动桥接机制，也**必须**重指：
    hook「从不覆盖已存在的条目」，它不会接管这条链（§2.4.3 约束 B）。
- 该宿主**没有链**：
  - 若探测到该宿主有自动桥接机制（当前只发现 WorkBuddy 的 `~/.workbuddy/hooks/sync-agents-skills.sh`）
    → 提示"它会自动桥接，不用手工链"，**不建链**
  - 若该宿主是**默认不链**的（codex / opencode：未验证这两个宿主会读自己的 skills 目录，
    且 codex 直接读共享目录 `~/.agents/skills`，本来就不需要链）
    → 提示"默认不链，需要就 `--target` 指定"，**不建链**
  - 否则 → 问"要不要链到它？"

⇒ 用户提的"装完提示是否链接到 workbuddy"落在这里：**有 hook 的机器上，若已有链则提示重指、
若没有链则提示不用管；没有 hook 的机器上才真的问要不要链。** 事实优先，不写死。

⚠️ **canonical 不是"一份可用的安装"时，一个宿主链都不建**：canonical 仍指向别处
（用户拒绝了重指）或写失败了 ⇒ 宿主链过去只会链到一个不是 bundled skill 的目录上。

⚠️ **"默认不链"只管"没有条目"的情形，不管"已经有一条旧链"**（2026-11-10 复审 P1-1）：
codex / opencode 目录里若已有一条指向别处的 `agent-ex-dispatch` 链，那条链**照样要重指**到
canonical —— 自动桥接机制从不接管已存在的条目，放着不管就是坏状态；
而且 `doctor` 会把它报成告警，若 `install` 修不了，那个告警就永远修不掉。

### 4.5 remove 的规则

- canonical 是**拷贝**（`managed-copy` / `adoptable`）→ 删掉这个目录
- canonical 是**软链** → 只删链接，**不删 target**
- canonical 是 `foreign-dir` → **拒绝删**，提示用户手工处理
- 各宿主目录下 `agent-ex-dispatch`：
  - 是**软链** → **删**（删链接不丢数据），并打印它原本指向哪
    ⚠️ **不要求它指向 canonical**：本机 workbuddy / trae 那两条指向仓库的链也必须能删掉，
    否则"从开发者路线切回用户路线"之后永远卸不干净（§2.4.3 约束 B）。
    唯一的例外是它指向 canonical 本身时，删 canonical 与删链接要**按顺序**做，别把 canonical 删成断链。
  - 是**实体目录** → **拒绝删**，提示用户手工处理（分不清是用户自己的还是被改过的）
- `ln` 陷阱（`README.md:150-151`）：`ln -s` 对已存在的目录目标不报错，会把软链塞进目录里。
  ⇒ 一律用 `fs.symlinkSync` + 前置 `lstat`，**绝不**用 shell `ln`。

**顺序与退出码（2026-11-10 代码评审后定）**：

- **先删宿主链、后删 canonical**。反过来会留断链。
  ⇒ **宿主链删不掉时，canonical 也不删**：留着 canonical，断的只是链；
  删了 canonical 还留着链，断的是整份 skill。
- **实体目录 / `foreign-dir` 删不掉 ⇒ 退出码非 0**。
  删了可能丢用户数据，所以 agent-ex 不删；但"用户要卸载、结果还有东西留在原地"**不是成功**。
  这类条目记进 `skipped`（与 `errors` 分开：不是错误，是"没删成"）。

### 4.6 status 的输出

只读，一次给全三件事（**示意**，实际以本机真实状态为准）：

```
Skill: agent-ex-dispatch
  bundled   /usr/local/lib/node_modules/agent-ex-mcp/skills/agent-ex-dispatch  (v0.3.2, sha a1b2c3d4e5f6)
  canonical ~/.agents/skills/agent-ex-dispatch  [copy v0.3.1]  UPDATE AVAILABLE (0.3.1 -> 0.3.2)
  hosts
    ok   ~/.claude/skills/agent-ex-dispatch      -> ~/.agents/skills/agent-ex-dispatch
    ok   ~/.workbuddy/skills/agent-ex-dispatch   -> ~/.agents/skills/agent-ex-dispatch
    --   ~/.trae-cn/skills/agent-ex-dispatch      (not linked)
    !    ~/.codex/skills/agent-ex-dispatch        -> /somewhere/else  (not the canonical copy)
```

⚠️ **链到别处 / 断掉的链不能标成绿勾**（实现只打印 sha，不打印体积）。

**过期判定**（读 marker，不额外记状态）：
- canonical 是软链 → 永远不过期（指向源，源变了自动跟随）
- canonical 是 `managed-copy` → `marker.version != 当前包版本` ⇒ **UPDATE AVAILABLE**
- canonical 是 `adoptable`（无 marker 但内容一致）→ 视作已装，版本 = 当前
- canonical 是 `foreign-dir` → 报 `not managed by agent-ex`，提示手工处理

⚠️ **status 绝不创建任何目录或文件**（只读命令）。

### 4.7 doctor 的 skill 段（info 级，不影响 exit code）

- 未安装 → `info`："dispatch skill is not installed" + fix `agent-ex skill install`
- 已安装但 `marker.version != 当前包版本` → `warn`："installed copy is older than the bundled one" + fix `agent-ex skill install`
- 已安装且版本一致 → `ok`
- canonical 是 `foreign-dir` → `warn`："not managed by agent-ex"（我们没装过，不自动动它）
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

改完（默认路径，**24 行**；非默认路径多出 export 那段 + 片段里的 `env` 字段，**30 行**）：

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
模板其余部分 14 行 ⇒ 合计 24 行（非默认路径 +3 行 export 段 +3 行 `env` 字段 ⇒ 30 行）。⇒ 断言写 **"默认路径 ≤ 26 行 / 非默认 ≤ 32 行"**（留一点余量），
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
| R5 | 宿主侧**已存在**指向别处的同名软链（如本机 workbuddy / trae 指向仓库那两条）——自动桥接机制"从不覆盖已有条目"，永远不接管它 | install 必须**主动发现并重指**到 canonical（§4.4 第二种情形）；remove 必须能删掉这类链（§4.5） |
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
- WorkBuddy 的桥接 hook 是否所有 WorkBuddy 版本都有：**未验证**——本机有，所以 §4.4 用探测而不是假设。
