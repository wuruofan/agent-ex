# agent-ex

**Dispatch and review with *external* agents.** 一个把 AI 编程 Agent（Claude Code / OpenCode）当作「外部执行者」来协作的 **MCP Server**——既能派发后台任务，也能让外部 agent 独立出方案、相互 review。

> 本文标题与命令名是 `agent-ex`，npm 包名是 [`agent-ex-mcp`](https://www.npmjs.com/package/agent-ex-mcp)（原因见「快速开始」下方说明）。

通过 MCP 工具 `agent_ex_submit` / `agent_ex_status` / `agent_ex_cancel` 提交任务：server 以 detached 子进程拉起**真实** agent CLI，用 SQLite 记录任务状态机，支持 `NEEDS_INPUT` 续跑、瞬时错误重试、超时、取消，并在任务结束时推送飞书通知。

> 下文的 `submit` / `status` / `cancel` / `version` / `restart` 均指 `agent_ex_*` 全名；
> 部分 MCP 宿主会再加一层前缀（如 `mcp__agent-ex__agent_ex_submit`）。

三种典型协作形态（都只是 `submit` 的不同 prompt，**不需要任何新工具**）：

| 形态 | 怎么用 |
| :--- | :--- |
| **派发实现** | `submit(prompt=自包含工单)` → worker 独立完成 → `wait-task.mjs` 带回结果 |
| **独立起草方案** | `submit(prompt="读 docs/ 与代码，产出设计方案写到 docs/plans/xxx.md")` |
| **相互 review** | `submit(prompt="审阅 docs/plans/xxx.md，按可执行性/遗漏/矛盾列问题")` |

## 特性

- **外部执行者**：任务在独立 detached 进程里跑，不阻塞你的对话；随时 `status` 查进度、`cancel` 终止。
- **状态机**：`queued → running → (needs_input → running → …) → completed | failed | cancelled`，最多 5 轮续跑。
- **多 Agent / 多 Provider**：内置 `claude` 与 `opencode` 两个 executor，可配置不同 profile（如 MiniMax、DeepSeek 网关）。
- **NEEDS_INPUT 续跑**：agent 反问时任务进入 `needs_input`，用 `submit(continue_of=…)` 把答案喂回去继续跑。
- **瞬时错误自动重试**：429 / 529 / 5xx / 连接重置等可恢复错误自动重试（共 3 次尝试，退避 30s → 60s），超时与硬失败不重试。
- **飞书通知**：任务终态（完成 / 失败 / 取消）推送飞书，支持 `dry_run` 调试；配额告警也会实时推送。
- **密钥零落盘（config）**：`config.json` 只含 `{env:ENV_VAR}` 占位符；真实密钥落在 `$AGENT_EX_HOME/.env`（chmod 600，server 启动自动加载），不进 git、不被同步。
- **自更新 / 自诊断**：`version` 回报 `gitSha` 确认新代码已生效，`restart` 让 server 自行退出并由宿主 respawn 加载新 `dist`——不必手动重启 MCP 宿主，在跑任务不受影响。

## 架构

```
MCP Client (TRAE / WorkBuddy / Claude Code / 任何 MCP 宿主)
   │  stdio: submit / status / cancel
   ▼
server.ts (MCP Server)
   │  submit → 写 SQLite → spawn detached runner
   ▼
runner.ts (detached 子进程)
   │  buildCommand → spawn agent CLI (claude -p / opencode)
   │  逐行解析 agent 事件 → 落库 + 写日志
   ▼
agent CLI (真实 claude / opencode) ── 事件流 ──▶ 终态 + 飞书通知
```

## 要求

- Node.js **>= 22.5**
- 本地已安装要用的 agent CLI（`claude` 或 `opencode`）

## 安全须知

worker 以 agent CLI 的「跳过权限确认」模式运行（claude：`--dangerously-skip-permissions`；opencode：`--auto`），无二次确认。请在**自己的机器、可信的项目目录**上使用；派发任务前想清楚你给了 worker 什么权限。

## 快速开始

```bash
npm i -g agent-ex-mcp    # 或免安装：npx -y agent-ex-mcp@latest init
agent-ex init        # 交互式配置：探测 CLI、收集密钥、生成 config + .env
```

> 包已发布到公共 registry（`agent-ex-mcp@0.1.0`）。
> **包名带 `-mcp` 后缀、命令名不带**：npm 上 `agent-ex` 与已被他人占用的 `agentex` 过于相似，
> 触发 registry 的包名相似度保护而无法发布，故加限定词规避；`bin` 仍为 `agent-ex`，
> 所以安装后命令是 `agent-ex init`（不是 `agent-ex-mcp init`）。数据目录 `~/.agent-ex` 同理保持不变。

`init` 结束时会**直接打印**可直接粘贴的 MCP 注册片段（用**绝对路径**，理由见下方注意事项），把它拷进你的 MCP 客户端配置即可（Trae：`TRAE SOLO CN/User/mcp.json`；WorkBuddy：`~/.workbuddy/mcp.json`）：

```jsonc
{
  "mcpServers": {
    "agent-ex": {
      "command": "/abs/path/to/node",          // init 现场打印，无需自己拼
      "args": ["/abs/path/to/node_modules/agent-ex/dist/server.js"]
    }
  }
}
```

> 注册后需在客户端里信任/启用该 server（首次接入通常要重启或手动连接）。
> `init` 还会提示 dispatch skill 的安装方式与各宿主 skills 目录的查法，见「可选：安装 dispatch skill」。

> ⚠️ **`command` 建议写绝对路径。** MCP 客户端拉起 server 时**不继承你的 shell PATH**，
> 而 `node_modules/.bin` 只有 `npm run`/`npx` 执行时才会临时注入。已实测（2026-10-11，tarball 全新安装）：
> `PATH=/usr/bin:/bin` 下裸写 `agent-ex` 直接 `command not found`，写绝对路径则正常返回。
> nvm / homebrew / GUI 应用托管的环境尤其容易踩。
>
> 绝对路径怎么拿：
>
> ```bash
> which node        # Linux/macOS → /Users/<you>/.nvm/versions/node/<v>/bin/node
> # 找不到 node 时 init 会把它启动时用的那个绝对路径直接打给你，照抄即可
> ```
>
> 也可显式补 `env.PATH`，但用绝对路径更省事：
>
> ```jsonc
> {
>   "mcpServers": {
>     "agent-ex": {
>       "command": "/Users/<you>/.nvm/versions/node/<v>/bin/node",
>       "args": ["/path/to/agent-ex/dist/server.js"],
>       "env": { "AGENT_EX_HOME": "/Users/<you>/.agent-ex" }
>     }
>   }
> }
> ```

之后在对话里说「把 X 派给后台 worker」即可；任务终态会推飞书通知（`init` 里配置过 webhook 的话）。

### 可选：安装 dispatch skill（推荐）

MCP 工具是「底层能力」，dispatch skill 是叠加在上面的**派发规范**：什么时候该派、prompt 怎么写才自包含、
同一目录为什么禁止并发、`needs_input` 怎么续跑、什么时候干脆别派（返工量小且强依赖当前会话上下文时，
自己更快更准）。装了它，你只说「把 X 派给 worker」，它会按规范把任务拆好、检查并发、拼好 prompt 再提交。

两条路线，按「你是使用者还是本仓库开发者」选一条，**不要两条都装**（目标路径会互相打架）。

### 路线 A：`npx skills`（推荐给使用者，不依赖本地仓库）

本仓库的 skill 遵循 [Agent Skills](https://github.com/agentskills) 开放规范（`SKILL.md` + `scripts/` + `references/`），
因此可以直接用 Vercel 的 [`skills` CLI](https://www.npmjs.com/package/skills) 从 GitHub 装——**无需 clone、无需 `npm i -g agent-ex-mcp`**：

```bash
# 先看这个仓库里有哪些 skill（dry-run，不落盘）
npx -y skills add wuruofan/agent-ex --list

# 全局安装单个 skill
npx -y skills add wuruofan/agent-ex --skill agent-ex-dispatch -g -y
```

- 缺省安装到 `~/.agents/skills/`（用户级，**全局生效**，任何项目里都能用）。
- 只给某一个宿主装（如只给 Claude Code）：去掉 `-g`，按 CLI 提示选目标。
- 更新：`npx skills update -g`；已装列表：`npx skills list -g`。
- ⚠️ 若你机器上 `~/.npm/_npx` 不可写，报权限错，加临时 cache：`npm_config_cache=/tmp/npm-cache npx -y skills add …`。

### 路线 B：`install-skill.sh`（开发者路线，软链到本地仓库）

```bash
./scripts/install-skill.sh          # 默认装到 ~/.agents/skills + ~/.workbuddy/skills
./scripts/install-skill.sh ~/some/other/skills   # 或指定目录
```

脚本把仓库里的 `skills/agent-ex-dispatch` **软链**到各宿主工具的用户级 skills 目录——
它是仓库的软链，**改完立刻生效、不会产生副本漂移**，适合边写 skill 边验证。可重复执行（幂等：已指向正确位置会 skip；
若目标路径已有**实体目录**则会中止并提示手动处理，不会覆盖）。

> 两条路线的取舍：路线 B 是**软链**，本地改了马上生效，但换台机器就没有；路线 A 是**实体副本**，
> 能独立分发但要手动 `update`。同一目标目录只能有一种——若想从 A 切到 B（或反过来），
> 先删掉旧的那份再装。

**生效范围是全局的，不是当前仓库**：入口落在用户级 skills 目录（`~/.agents/skills`、`~/.workbuddy/skills`），
WorkBuddy 会扫描这些路径，所以在任何项目里都能用。仓库里的 `./skills/` 是普通目录，**不是**项目级 skill 路径
（那会是 `./.workbuddy/skills`），因此既不会只在本仓库生效，也不会与项目级 skill 冲突。

> **Trae**：它的用户级 skills 目录因安装版本而异（本机 `TRAE SOLO CN` 用 `~/.trae-cn/skills`），
> 所以不在默认目标里，显式传进去即可：`./install-skill.sh ~/.trae-cn/skills`（路线 A 则去掉 `-g`，按 CLI 提示选 Trae）。
> 2026-10-10 实测：软链装好后 skill 在 Trae 里正常加载，派发 → 后台等待 → 完成后**开新 turn** 整条链路都通。

## 安装（从源码，开发者路线）

```bash
git clone https://github.com/wuruofan/agent-ex && cd agent-ex
npm install
npm run build        # tsc → 生成 dist/
npm run init         # 开发模式跑 init（tsx）
./scripts/install-skill.sh   # 可选：装 dispatch skill
```

## 配置

### 配置目录

配置放在 `AGENT_EX_HOME` 指向的目录下，文件名 `config.json`：

```bash
export AGENT_EX_HOME="$HOME/.agent-ex"   # 缺省即此；也可指向任意目录
```

### config.json 结构

参考 `config.example.json`，字段如下：

```jsonc
{
  "executors": {
    "claude":   { "bin": "/abs/path/to/claude", "extra_flags": ["--dangerously-skip-permissions"] },
    "opencode": { "bin": "/abs/path/to/opencode", "extra_flags": ["--auto"] }
  },
  "profiles": {
    "minimax-3": {
      "executor": "claude",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "{env:MINIMAX_API_KEY}",
        "ANTHROPIC_MODEL": "MiniMax-M3[1m]"
        // …其余 ANTHROPIC_* / CLAUDE_CODE_* 变量
      }
    }
  },
  "notify": {
    "feishu_webhook_url": "{env:FEISHU_WEBHOOK_URL}",
    "dry_run": true,
    "keyword": "agent-ex"
  },
  "defaults": { "profile": "minimax-3", "timeout_sec": 3600 }
}
```

| 字段 | 说明 |
|---|---|
| `executors.<name>.bin` | agent CLI 的位置：**绝对路径或裸命令名皆可**（见「`executors.<name>.bin`」）。 |
| `executors.<name>.extra_flags` | 拼到 agent 命令后的额外参数。权限开关按 executor 区分：claude 用 `--dangerously-skip-permissions`，opencode 用 `--auto`（`init` 会自动写对）。 |
| `profiles.<name>.executor` | 引用 `executors` 里的某个 executor。 |
| `profiles.<name>.env` | 传给 agent 子进程的环境变量；支持 `{env:VAR}` 占位符（见下）。**opencode 一般留空**（provider 由 opencode 自己的 `auth.json`/`opencode.json` 管理）；要给某个 profile 单独指定模型，写 `OPENCODE_CONFIG_CONTENT: "{\"model\":\"provider/model\"}"`——`extra_flags` 是 executor 级，多 profile 无法用它区分模型。另注意 `buildAgentEnv` 只给极简 `PATH`，worker 里的 shell 用不到 `/opt/homebrew/bin` 等，需要时在此显式补 `PATH`。 |
| `notify.feishu_webhook_url` | 飞书机器人 webhook；支持 `{env:FEISHU_WEBHOOK_URL}` 占位符。 |
| `notify.dry_run` | `true`（缺省）→ 只打印通知内容不真发；`false` → 真发。 |
| `notify.keyword` | 附加在卡片末尾的「关键词」安全闸门。**缺省 = `agent-ex`（`src/brand.ts` 的 `BRAND`，`loadConfig` 自动填入）**，一般无需手写。详见「飞书通知配置」。 |
| `defaults.profile` | `submit` 不指定 profile 时用的默认 profile（必须在 `profiles` 中存在）。 |
| `defaults.timeout_sec` | 单轮超时（秒），超时 SIGTERM 杀掉 agent。 |

### 免费模型动态解析：`{model:zen-free}`

opencode zen 的 free 模型集会**轮换**（`mimo-v2.5-free` → `mimo-v2.6-flash-free` 已发生过，`glm-4.7-free` 已整体消失），硬编码模型名很快就会失效。
把 `{model:zen-free}` 写进 profile 的 env，即可在**每次 spawn 前**动态解析出当前可用的 free 模型：

```jsonc
{
  "profiles": {
    "opencode-zen-free": {
      "executor": "opencode",
      "env": {
        "OPENCODE_CONFIG_CONTENT": "{\"model\":\"{model:zen-free}\",\"small_model\":\"{model:zen-free}\"}",
        "ZEN_FREE_PREFER": "mimo,nemotron,ling"   // 可选：家族前缀软偏好，逗号分隔、按序匹配
      }
    }
  }
}
```

- **事实来源 = spawn 时的实时清单**（`https://opencode.ai/zen/v1/models`，免鉴权），因此配置里**零硬引用**模型名。
- `ZEN_FREE_PREFER` 只是「口味」：前缀过期不会导致失败，只会退化为「不挑食」（按 id 稳定排序取第一个可用的 `-free` 模型）。
- 清单拉取失败 → 退回内置回退常量，**绝不阻塞任务启动**。
- free 模型撞限流会 429；配合下面的重试机制，已撞限的模型会被加入排除集，下一次尝试自动路由到另一个 free 模型。
- 非 zen profile 走零成本旁路（env 原样透传，不发任何请求）。

> 为何不做「报错后换模」自愈：模型下线时 opencode 报的 `UnknownError: "Unexpected server error..."`（且 exit=0）与真实服务端故障无法区分，
> 所以坚持 **spawn 前主动解析**，不做错误驱动的猜测。

### 上下文压缩：`[1m]` + `AUTO_COMPACT_WINDOW` + `PCT_OVERRIDE`

worker 的上下文占用到阈值就会触发自动压缩（摘要掉早期对话）。**这三个变量必须成套设置**，否则达不到预期，甚至会适得其反。

claude-code 对**未知模型**（如 MiniMax / DeepSeek 等第三方模型）会回落到 **200k** 窗口兜底，此时 `AUTO_COMPACT_WINDOW` 设多大都会被 `Math.min` 压回 200k，形同虚设。加 `[1m]` 后缀才能拿到 1M 窗口：

| 变量 | 作用 | 缺了会怎样 |
|---|---|---|
| `ANTHROPIC_MODEL` 带 `[1m]` | 窗口 200k → **1M** | 窗口恒为 200k，下面的 window 失效 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 压缩**工作窗口**（绝对值） | 阈值涨到 967k，逼近服务端上限，易撞顶失败 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 在工作窗口上的**百分比** | 退回内置默认（约 92%），压缩来得太晚 |

阈值的计算方式（claude-code v2.1.x）：

```
window  = min(模型窗口, max(100k, AUTO_COMPACT_WINDOW))
阈值    = min(window − 20000 − 13000, (window − 20000) × PCT%)
```

以 `AUTO_COMPACT_WINDOW=512000` + `PCT=90` 为例：`window=512000` → 阈值 ≈ **442,800 tokens**。

| PCT | 512k 窗口下的阈值 |
|---|---|
| 70 | 344,400 |
| 80 | 393,600 |
| 90 | 442,800 |
| 不设 | 479,000 |

> **注意**：`~/.claude/settings.json` 的 `env` 块也会注入这些变量。agent-ex 传了 `HOME` 给子进程，claude 会自行读取该文件——**若那里设了同名 key，agent-ex 的 `profiles.<name>.env` 优先级更高**（仅当该 key 已在 profile 中显式设置）。想完全由 agent-ex 单点控制，就把两个变量都写进 profile env。

**验证是否真的生效**：看任务日志 `result` 事件的 `modelUsage.<model>.contextWindow`——它反映模型窗口（带 `[1m]` 应为 `1000000`）；而**压缩工作窗口**不体现在该字段，要看日志里是否出现 `ran out of context`。

### `executors.<name>.bin`：绝对路径或裸命令名皆可

`runner` 拉起 agent 时，会显式构造子进程环境，其 `PATH` 以 **`dirname(解析后的 bin)` + 系统目录** 组成（`src/agent-env.ts`）。`bin` 支持两种写法：

- **裸命令名** `"claude"`：运行时按 `process.env.PATH` 解析成绝对路径（与启动期 `validate()` 行为一致），`dirname` 取解析结果目录。最省事，推荐。
- **绝对路径** `/abs/path/claude`：直接用，适合多版本 / 非标准安装。

想确认 claude 会被解析到哪：

```bash
which claude        # → /Users/you/.nvm/versions/node/v24.18.0/bin/claude
which opencode      # → /usr/local/bin/opencode
```

> 早期版本要求必须写绝对路径；现已支持裸名自动解析，无需再硬编码 nvm 路径。

### 密钥：config 占位符 + `.env` 真实值

`env` 与 `feishu_webhook_url` 里写成 `"{env:VAR_NAME}"` 形式的值，会在**任务运行时**（runner 进程）从环境变量替换。**config.json 永远不写真实密钥**，真实值放在 `$AGENT_EX_HOME/.env`：

```bash
# $AGENT_EX_HOME/.env（示例；init 命令会自动生成，chmod 600）
MINIMAX_API_KEY=sk-xxxx
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
```

- **server 启动时自动加载 `.env`** 灌进 `process.env`（`src/env-file.ts`；只补缺失，不覆盖真实环境变量），runner 是 server 的 detached 子进程，自动继承——所以**密钥不用写进 MCP 注册的 `env` 字段**。
- 占位符在运行时缺失 → 加载/解析直接报错（避免明文密钥意外落盘）。
- 想让 `.env` 生效，重启 server 进程即可。

### 飞书通知配置

飞书通知走**群自定义机器人 webhook**。整条链路分四段，每段都能单独验证——出问题先定位到段，再按段排查。

#### 1. 建机器人、拿 webhook

在目标群里：群设置 → 群机器人 → 添加机器人 → **自定义机器人**（不是应用机器人）。创建后复制形如

```
https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

的地址。这串地址**本身就是凭证**（谁拿到都能往群里发消息），不要贴进公开仓库或 issue。放进 `.env`：

```bash
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
```

`config.json` 里只写占位符 `"{env:FEISHU_WEBHOOK_URL}"`，真实值永不进 config。

#### 2. 安全设置：与本工具的匹配关系

自定义机器人有三种安全设置，**本工具只支持「自定义关键词」这一种**：

| 安全设置 | agent-ex 是否支持 | 说明 |
| :--- | :--- | :--- |
| **自定义关键词** | ✅ 支持 | 消息里必须包含登记的词，否则被拒收。缺省词 = `agent-ex`。 |
| **加签**（secret） | ❌ **不支持** | 需要在请求里带 `timestamp` + `sign`，本工具不发送（`src/notifier.ts` 的 `post()` 只发裸 payload）⇒ 勾选后必然收不到。 |
| **IP 白名单** | ❌ 不支持 | 需要登记调用方出口 IP，且各家 webhook 服务商规则不同，本工具不校验。 |

> ⚠️ **别勾选加签**。它是最常见的误配：卡片一律被拒，但日志里的报错不指向加签，很难自查（见 §4）。需要更严格的保护时，用关键词 + 不把 webhook 外泄即可。

配置关键词时，**填的词必须与卡片正文里出现的词一致**。本工具缺省把 `agent-ex` 追加到卡片末尾的一行小字（`notifier.ts` 的 `buildFeishuCard`，`text_size: "notation"`），因此机器人侧的关键词填 `agent-ex` 即可。若你在 `config.json` 里自定义了 `notify.keyword`，**两边都要跟着改**。

#### 3. 打开真实发送

`notify.dry_run` **缺省是 `true`**（只把卡片打到 stderr，不 POST）。链路验证通过后改成 `false` 才会真发。

#### 4. 验证（别拿真实任务报告当探针）

```bash
agent-ex doctor --send
```

这条命令会发一张**正文刻意不含产品名**的自检卡，并打印飞书返回的 `code` 与含义。
（想先看配置体检而不真发消息，跑 `agent-ex doctor` —— 它只读，不改任何东西。）

失败时看 stderr 的 `code`：

| `code` | 含义 | 处置 |
| :--- | :--- | :--- |
| `0` | 已投递（注意飞书出错也返 HTTP 200，**判定必须看 `code`，不能看 HTTP 状态码**） | — |
| `19024` | 关键词校验失败 | 机器人侧的关键词与 `notify.keyword` 不一致。⚠️ **闸门是对整张卡片做子串匹配**——worker 的报告正文里只要偶然出现该词，卡也能过。配置错了却可能长期"看起来正常"，所以**只认自检卡**。 |
| `19021` | **签名校验失败**（或时间戳距今超过 1 小时） | 机器人勾选了「加签」而本工具不发送 `timestamp`/`sign` ⇒ **去机器人安全设置里取消勾选加签**。 |
| `19022` | IP 校验失败 | 机器人勾选了「IP 白名单」而本机出口 IP 不在其中 ⇒ 取消勾选，或把出口 IP 加进白名单。 |
| `19001` | **webhook token 无效**（地址本身失效：机器人被删/重建/地址轮换） | ⚠️ 与 `19024` **修法完全不同**：这个要**换 webhook 地址**（去机器人后台重新复制，更新 `.env` 里的 `FEISHU_WEBHOOK_URL`），改关键词没用。 |
| `9499` | 请求体格式错误 | 卡片 JSON 不合 schema。注意官方限制：**请求体不得超过 20 KB**。 |
| `11232` | 触发限流 | 单机器人 **100 次/分钟、5 次/秒**；密集派发会撞上，尽量避开整点/半点发送。 |
| 其他 / 无 `code` | 网络或服务端问题 | 检查出口网络与代理。 |

> 本工具每次失败会重试 3 次（退避 1s / 4s），所以日志里出现 3 行同样的 `code` 是正常的。
>
> **机器人不在群**没有专属错误码——webhook 地址与群绑定，飞书通常**静默丢弃**。要换群必须重建机器人并换新地址。

> `doctor` 还会扫 `logs/runner-*.log` 里**历史上**的拒收记录并按 `code` 聚合 —— 2026-10-13→10-15 那次连续 23 个任务零通知，证据当时就已经躺在日志里，只是没人看。现在一条命令就能看到。

## 运行

### 命令行工具

`agent-ex` 既是 MCP server，也是几个运维子命令的入口：

| 命令 | 作用 |
| :--- | :--- |
| `agent-ex init` | 首次安装向导（探测 CLI、生成 config.json + .env）。**重跑会重写 config.json**，覆盖前会逐项列出将要变化的设置并要求确认，旧文件自动备份成 `config.json.bak.<时间戳>`。 |
| `agent-ex doctor` | 体检：把「通知到底通不通」的证据聚合成结论 + 病因 + 修复命令。**只读**，不改任何东西。 |
| `agent-ex doctor --fix` | 自动修**确定性缺陷**（显式空串关键词、改名前的旧产品名、明文 webhook 落在 config.json）。**不动 `dry_run`** ——那是你的偏好，不是缺陷；**也不动自定义关键词** ——机器人登记什么词是用户的界面。 |
| `agent-ex doctor --send` | 额外实发一张**正文不含产品名**的自检卡，验证真实投递。 |
| `agent-ex config list` | 列出 profiles / executors / notify / defaults 现状。 |
| `agent-ex config set <key> <value>` | 改单个字段。白名单：`notify.dry_run`、`notify.keyword`、`defaults.timeout_sec`，以及 `executors.<name>.bin`（定点修 bin 路径）。 |
| `agent-ex profile list` | 列出所有 profile（标出默认的那个）。 |
| `agent-ex profile use <profile>` | **切**默认 profile（profile 必须已存在）。 |
| `agent-ex profile create <built-in> [--bin <path>]` | **物化**一个内置预设（当前：`opencode-zen-free`，零密钥的 opencode 免费模型）。只创建，不切默认；`--bin` 用于 executor 不在 PATH 上时指定绝对路径。 |
| `agent-ex profile set <profile> <KEY> <value>` | 改 profile 的 env 字段（如 `ZEN_FREE_PREFER`），或用保留字 `executor` 改它用哪个 executor。 |

> `doctor` 也有对应的 MCP 工具 `agent_ex_doctor`，让 agent 自己就能排错，不用手抄命令。

### 作为 MCP Server（stdio）

生产形态（全局安装后）注册。**推荐用绝对路径**——`init` 会直接打印可粘贴的片段：

```jsonc
{
  "mcpServers": {
    "agent-ex": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/node_modules/agent-ex/dist/server.js"],
      "env": {
        "AGENT_EX_HOME": "/abs/path/to/your/home"   // 可省，缺省 ~/.agent-ex
        // 密钥不用放这里：server 启动时会自动读 $AGENT_EX_HOME/.env
      }
    }
  }
}
```

> 裸写 `"command": "agent-ex"`（依赖 PATH）虽然更「可搬机」，但 MCP 客户端 spawn 时不继承
> 你的 shell PATH，在 nvm / GUI 应用环境下很容易 `command not found`——优先用 `init` 打印的绝对路径。

开发模式（直接跑 TS，无需先 build）：

```bash
npm run server      # = tsx src/server.ts
```

### 手动跑单条任务（调试用）

`runner` 一般被 server 自动 spawn。需手动验证时，先确保 SQLite 里已有一条任务记录（通常由 `submit` 创建），再：

```bash
npm run runner <task_id>     # = tsx src/runner.ts <task_id>
```

### 跑测试

```bash
npm run build && npm test            # 单元 + 集成 = 196 全绿
npm run test:integration            # 只跑集成（会自动先build）
npm run typecheck                   # 仅类型检查
```

集成测试直接跑预编译的 `dist/runner.js`（与生产同款），避免 dev 路径下 tsx 冷启动拖慢 timing 断言。

> `tests/proc-tree.test.ts` 依赖 `ps` 枚举进程树，在拒绝执行 setuid `/bin/ps` 的沙箱里会自动 skip
> （这是刻意设计：能力不可验证时诚实跳过，而不是报假红）。

## MCP 工具

### `submit`

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 任务描述 / 指令。 |
| `project_path` | | agent 的工作目录，缺省为 server 进程 cwd。 |
| `profile` | | 用哪个 profile，缺省 `defaults.profile`。 |
| `continue_of` | | 填已有 `needs_input` 任务 id，把 `prompt` 作为该轮回答续跑。 |
| `timeout_sec` | | 单轮超时，缺省 `defaults.timeout_sec`。 |

返回 `{ task_id, status, rounds }` 或 `{ error }`。

### `status`

| 参数 | 说明 |
|---|---|
| `task_id` | 不填则返回所有活跃任务；填了返回单条。 |

返回字段含 `status / rounds / profile / elapsed_sec / progress / files_changed`，终态时含 `result` / `error`，`needs_input` 时含 `question`，通知失败时含 `notify_failed`。

### `cancel`

| 参数 | 必填 | 说明 |
|---|---|---|
| `task_id` | ✅ | 取消指定任务。 |

对终态任务幂等（返回当前状态，不改写）；对 `running` 任务会 SIGTERM 级联杀掉 agent 进程树。
若返回带 `warning`，说明进程树快照不可用（沙箱拒绝 setuid `/bin/ps`），组外逃逸的 agent 子进程可能残留。

### `version`

无参数。返回构建元数据 `{ version, gitSha, buildTime }`，用于确认重启后新代码已生效；`dist/build-meta.json` 缺失时返回 `{ unknown: true, note }`。

### `doctor`

| 参数 | 必填 | 说明 |
|---|---|---|
| `send` | ❌ | 是否实发自检卡（默认 `false`，只读体检）。 |

把「通知到底通不通」的证据聚合成结论：config 自身（关键词 / dry_run / webhook / 默认 profile）、
executor 的 bin 是否可执行、以及**历史上**的通知失败（扫 `logs/runner-*.log` 里的飞书拒收记录，按 `code` 聚合）。
每条 finding 带 `severity` / `detail` / `fix`（可复制的修复命令）。

> `send=true` 发的是**正文不含产品名**的自检卡 —— 飞书关键词闸门匹配整张卡片，
> 拿真实任务报告当探针会假通过。
> 被拒收时，**飞书返回的 `code` 与 `msg` 会直接写进结论**（不是只留在 stderr）——
> agent 据此就能区分"改关键词"（19024）与"换 webhook 地址"（19001），不必去翻日志。

### `restart`

无参数。主动退出当前 MCP server 进程，由宿主自动 respawn 并加载当前 `dist`。
server 无状态（状态全在 `tasks.db`），在跑 worker 位于独立进程组，**重启不影响在跑任务**，也不影响其他存活的 server 实例。

## 状态机

```
        submit
          │
          ▼
       queued ──spawn──▶ running ──agent 反问──▶ needs_input
          │                  │                        │
          │                  │ answered (submit continue_of)
          │                  │                        │
          │                  ▼                        ▼
          │               running ◀──────────────────┘   (最多 5 轮)
          │                  │
          ├──────────────────┤
          ▼                  ▼
     completed           failed
          │
          ▼
   cancelled (任意非终态可取消)
```

`needs_input` 续跑示例：

1. `submit({ prompt: "给项目加登录页", profile: "minimax-3" })` → 拿到 `task_id`。
2. `status({ task_id })` 看到 `status: "needs_input"`、`question: "用哪种数据库？"`。
3. `submit({ continue_of: task_id, prompt: "PostgreSQL" })` → 继续跑。

两个上限，别把它们混为一谈：

- **续跑轮数 ≤ 5**（`MAX_ROUNDS`）：第 5 轮仍有 pending question → 终态 `failed`，`error` 为 `rounds limit (5) reached with pending question`。
- **单轮瞬时重试 ≤ 3 次尝试**（`MAX_ATTEMPTS`）：仅对 429 / 529 / 5xx / 连接重置等**可恢复**错误生效，退避 30s → 60s（可用 `AGENT_EX_RETRY_BACKOFF_MS` 覆盖，逗号分隔毫秒）。真超时、`needs_input`、硬失败**不重试**。重试与续跑轮数是两个独立计数，任务在单轮内即可重试 3 次。

## 排错

- **`executor "claude" bin "…" not found or not executable`**：`bin` 路径不对或没 `+x`。写裸命令名时按 `process.env.PATH` 解析（见「`executors.<name>.bin`」），解析不到就写绝对路径。
- **任务 `failed`，`error: failed to spawn runner: … ENOENT`**：多因`bin` 指向的位置下没有可执行文件。注意 worker 子进程的 `PATH` 只由 `dirname(bin)` + 系统目录组成（见「`profiles.<name>.env`」），`/opt/homebrew/bin` 等不在其中——裸名建议先 `which` 确认解析结果。
- **飞书不推送**：检查 `dry_run` 是否还是 `true`；检查 `.env` 里 `FEISHU_WEBHOOK_URL` 是否存在（或 server 进程环境是否已 `export`）。若日志里有 `code=19024`（关键词不匹配）或卡片**一律**收不到，**先确认机器人没有勾选「加签」**——本工具不发送签名，勾选后必然全被拒。完整排查见「飞书通知配置」。
- **`{env:VAR}` 报错 `not found in process environment`**：对应密钥不在 `.env` 里，也没 `export` 到 server 进程环境。加到 `$AGENT_EX_HOME/.env` 后重启 server。
- **任务频繁超时，且日志里反复出现 `ran out of context`**：上下文被反复压缩，agent 丢失状态后重复劳动。查压缩阈值配置（见上「上下文压缩」）——若 `ANTHROPIC_MODEL` 没带 `[1m]`，窗口会被锁在 200k；工单过大（工具调用 ≫150 次）也会撞阈值，应先拆单。
- **改了代码但行为没变**：MCP host 会复用常驻 server 进程。`npm run build` 后调 `restart`，再用 `version` 核对 `gitSha`。
- **opencode 报 `UnknownError: "Unexpected server error..."`（且 exit=0）**：多半是配置里的模型已被下线。这个报错与真实服务端故障**无法区分**，别靠报错自愈——改用 `{model:zen-free}` 让模型在 spawn 前动态解析（见「免费模型动态解析」）。

## 快速初始化（`init` 命令）

不想手拼 JSON？用交互式 `init` 自动探测 CLI 路径、收集密钥，并生成 `config.json` + `.env`：

```bash
npm run init                 # 开发模式（tsx）
# 或生产形态：
node dist/server.js init    # 即 `agent-ex init`
```

交互流程（claude executor 为例）：

1. 用哪个 agent CLI（`claude` / `opencode`，自动探测并提示检测到的路径）；bin 用检测到的绝对路径（回车即采用）；
2. profile 名（默认 `default`）；
3. provider 预设（`minimax` / `deepseek` / `custom`）：
   - **预设**：内置 base_url + 默认模型 + 对应密钥变量名（`MINIMAX_API_KEY` / `DEEPSEEK_API_KEY`）。检测到该环境变量时**掩码展示**（`sk-…wXYZ`）并问 `Use this value? [Y/n]`——`Enter`/`Y` 直接采用；`n` 后粘贴新值，或 `Enter` 跳过。
   - **custom**：只问 `ANTHROPIC_BASE_URL` 与模型名；密钥**只粘贴**（无标准变量名可检测），占位符变量名从 profile 名派生（如 `myprov` → `MYPROV_API_KEY`）。
4. 飞书 webhook：检测到 `FEISHU_WEBHOOK_URL` 同样 `[Y/n]` 确认，否则粘贴或跳过（仍生成占位符 + `dry_run`）；
5. 默认超时秒数。

结束后：

- 写 `config.json`（**只含 `{env:VAR}` 占位符**，零明文）并自动用 `loadConfig()` 自校验；
- 把确认/粘贴到的密钥写进 `$AGENT_EX_HOME/.env`（**chmod 600**，幂等——同值不重写）；
- 若密钥最终没进 `.env`，会打印 ⚠ 提醒「运行时必须有该变量，否则任务失败」；
- 打印收尾指引：`AGENT_EX_HOME` 怎么设、**可直接粘贴的 MCP 注册片段（绝对路径）**、
  dispatch skill 的安装方式与各宿主 skills 目录的 `find` 查法、**以及怎么打开真实通知**（`config set notify.dry_run false` + `doctor --send`）。

> 已有 `config.json` 时 `init` 的行为：
>
> 1. 开头先问一次「要重写吗」（此时还不知道会改成什么样，只是给个廉价退出点）；
> 2. **问答结束后、写盘前**，把新旧配置的差异逐项列出来（哪些 profile 会消失、哪些字段被改写），
>    并解释后果（例：`notify.dry_run false → true` 意味着终态通知不再投递），让你**知情同意**；
> 3. 你同意后：先校验新配置（**校验不过就不写盘**，旧 config 原封不动），
>    再把旧 config 备份成 `config.json.bak.<时间戳>`，最后才写入。
>
> `.env` 是**增量合并**（只补/更新采集到的 key），所以重跑 `init` **不会丢密钥**。
>
> ⚠️ 但 `init` 是**全量覆盖**的：只想改一个字段（比如开通知）请用 `agent-ex config set`，
> 别重跑 `init` —— 那会把其它 profile 一起刷掉。
>
> opencode executor 不询问 provider——它由 opencode 自己的配置管理（`opencode auth login` / `opencode.json`），agent-ex 只负责拉起。

## 发布（npm）

包名 `agent-ex-mcp`，MIT。发布配置已在 `package.json` 就位：

| 字段 | 值 | 说明 |
|---|---|---|
| `name` | `agent-ex-mcp` | 带 `-mcp` 规避 registry 包名相似度保护（`agent-ex` 撞已占用的 `agentex`），见「快速开始」下的说明 |
| `bin` | `agent-ex` → `dist/server.js` | **命令名不带 `-mcp`**：全局安装后 `agent-ex` 可直接跑 server |
| `files` | `dist` / `config.example.json` / `README.md` | 源码、`tests/`、`docs/` 不进包 |
| `publishConfig.registry` | `https://registry.npmjs.org` | 锁定发布目标为官方源（见下） |
| `prepublishOnly` | `build` + `test` | 发布前自动构建并跑全量测试，测试红则发布中止 |
| `engines.node` | `>=22.5` | 依赖 `node:sqlite`（server 与 runner 都要用） |

```bash
npm run build && npm test      # prepublishOnly 也会跑，但建议先手动确认
npm publish --access public
```

> ⚠️ **必须显式带 `--registry https://registry.npmjs.org`**（或确保 `publishConfig.registry` 生效）。
> 国内常见的 `registry.npmmirror.com`（淘宝镜像）是**只读**的，不支持 `npm publish`，也不提供注册/登录端点；
> 带着它发布会在客户端就报 `ENEEDAUTH`。开发者若用镜像装依赖，请在 `~/.npmrc` 之外单独配置发布源。

发布者需自备 npm 账号，并开启 2FA：`npm profile enable-2fa auth-and-writes`。

**关于 token（npm 现行策略）**：发布必须满足二者之一——账号已开 2FA（`npm publish` 时用配置的验证器/安全密钥认证），
或使用**带 bypass 2FA 权限的 granular access token**。实测（2026-10-14）：账号未开 2FA 时，
`npm login` 拿到的会话凭据无法完成发布，registry 直接返回 `E403 … Two-factor authentication or granular
access token with bypass 2fa enabled is required`（此错**不会**提示要 OTP，容易误判为「已登录却仍被拒」）。
命令行创建方式：`npm token create --bypass-2fa --expires 90 --packages-all --packages-and-scopes-permission read-write`。
若要走无人值守的 CI，优先用下方的 Trusted Publisher（OIDC），无需长期密钥。

若要接 CI，推荐 [Trusted Publisher（OIDC）](https://docs.npmjs.com/trusted-publishers)（无需长期密钥），
它需要 npm CLI ≥ 11.5.1、Node ≥ 22.14，且**无法创建新包**：必须先手动发布至少一个版本、包已存在后才能配置。

> ⚠️ **npm 包不含 dispatch skill**：`skills/` 与 `scripts/` 不在 `files` 白名单里。
> 但这已不再是分发缺口——skill 走 [Agent Skills](https://github.com/agentskills) 规范，
> 使用者用 `npx skills add wuruofan/agent-ex --skill agent-ex-dispatch -g -y` 从 GitHub 直接装（见「安装 dispatch skill」）。

## 后续（planned）

- v2 daemon（设计文档见 `docs/designs/2026-08-18-session-adapter.md`，代码未启动）。
