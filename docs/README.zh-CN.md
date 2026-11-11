# agent-ex

**把 AI 编程 Agent（Claude Code / OpenCode）当作「外部执行者」来协作。**

> 中文版 · [English README →](../README.md)

`agent-ex` 是一个 **MCP Server**：它把 AI 编程 Agent 当作**外部执行者**——你派发一张自包含的工单，
它在独立的 detached 后台进程里干活，过程与结果落在 SQLite 任务库里 ⇒ 长任务**不会阻塞你当前的对话**。

- npm 包名是 [`agent-ex-mcp`](https://www.npmjs.com/package/agent-ex-mcp)，
  装完后的命令叫 **`agent-ex`**。（`-mcp` 后缀只是为了绕开 registry 对 `agent-ex` 的包名相似度保护。）
- 数据目录是 `~/.agent-ex`（可用 `AGENT_EX_HOME` 覆盖）。

三种典型协作形态——都只是 `submit` 的不同 prompt，**不需要任何新工具**：

| 形态 | 怎么用 |
| :--- | :--- |
| **派发实现** | `submit(prompt=<自包含工单>)` → worker 独立完成 → `agent-ex wait` 带回结果 |
| **独立起草方案** | `submit(prompt="读 docs/ 与代码，产出设计方案写到 docs/plans/x.md")` |
| **相互 review** | `submit(prompt="审阅 docs/plans/x.md，按可执行性/遗漏/矛盾列问题")` |

## 特性

- **外部执行者**：任务在独立 detached 进程树里跑，`status` 查进度、`cancel` 终止。
- **任务状态机**：`queued → running → (needs_input → running → …) → completed | failed | cancelled`，最多 5 轮续跑。
- **多 Agent / 多 Provider**：内置 `claude` 与 `opencode` 两个 executor；每个 profile 自带 env、模型与 PATH 补充。
- **`needs_input` 续跑**：agent 反问时任务停在 `needs_input`，用 `submit(continue_of=…)` 把答案喂回去继续跑。
- **瞬时错误自动重试**：429 / 529 / 5xx / 连接重置等可恢复错误自动重试（3 次尝试，退避 30s → 60s）；超时与硬失败**不重试**。
- **飞书通知**：任务到达终态时推送卡片；`dry_run` 让你不发真消息也能调试。
- **密钥零落盘（config）**：`config.json` 只含 `{env:VAR}` 占位符；真实值在 `$AGENT_EX_HOME/.env`（chmod 600，不进 git）。
- **自更新 / 自诊断**：`version` 回报构建的 `gitSha`；`restart` 让 server 自行退出、由宿主 respawn 加载新构建。在跑的任务不受影响。

## 要求

- Node.js **>= 22.5**（server 与 runner 都要用 `node:sqlite`）
- 本地已安装要用的 agent CLI（`claude` 或 `opencode`）

## 安全须知

worker 以 agent CLI 的「跳过权限确认」模式运行（claude：`--dangerously-skip-permissions`；
opencode：`--auto`），**无二次确认**。请在**自己的机器、可信的项目目录**上使用，
并想清楚你交给 worker 的权限。

## 安装

```bash
npm i -g agent-ex-mcp
# 或免安装：
npx -y agent-ex-mcp@latest init
```

## 快速开始

```bash
agent-ex init
```

`init` 是交互式的：探测 agent CLI、问 provider 与密钥、写 `config.json` + `.env`，
最后**直接打印可粘贴的 MCP 注册片段**。把它拷进你的 MCP 客户端配置
（Trae：`TRAE SOLO CN/User/mcp.json`；WorkBuddy：`~/.workbuddy/mcp.json`）：

```jsonc
{
  "mcpServers": {
    "agent-ex": {
      "command": "/abs/path/to/node",          // init 现场打印
      "args": ["/abs/path/to/node_modules/agent-ex-mcp/dist/server.js"]
    }
  }
}
```

> **建议写绝对路径。** MCP 客户端拉起 server 时**不继承你的 shell PATH**，
> 而 `node_modules/.bin` 只有 `npm run` / `npx` 执行时才会临时注入。
> 实测 `PATH=/usr/bin:/bin` 下裸写 `"command": "agent-ex"` 直接 `command not found`，写绝对路径则正常。
> `init` 会把它启动时用的绝对路径直接打给你，照抄即可。
>
> ```bash
> which node        # 例如 /Users/<you>/.nvm/versions/node/v24.18.0/bin/node
> ```

之后在对话里说「把 X 派给后台 worker」即可；任务到达终态会推飞书通知（`init` 里配过 webhook 的话）。

`init` 重跑是**全量覆盖** `config.json`——只想改单个字段请用 `agent-ex config set` / `agent-ex profile set`。
详见《[init 详解](user-guide/init.md)》。

## 可选：安装 dispatch skill

MCP 工具是「底层能力」，dispatch skill 是叠加在上面的**派发规范**：什么时候该派、prompt 怎么写才自包含、
同一目录的**写**任务为什么禁止并发、`needs_input` 怎么续跑、什么时候干脆别派。

skill **随 npm 包一起分发**，装它只要一条命令：

```bash
agent-ex skill install
```

它做三件事：

1. 把 `skills/agent-ex-dispatch` **拷贝**到 `~/.agents/skills/agent-ex-dispatch`
   （Agent Skills 规范的共享目录）；
2. 在拷贝目录里写 `.agent-ex-skill.json`，记下**版本号**与内容指纹——
   `agent-ex skill status` / `agent-ex doctor` 靠它判断「装的是哪一版」；
3. 给**本机存在、且该链**的宿主（Claude Code / Cursor / Windsurf / Trae / Trae CN / Copilot /
   Gemini CLI / OpenCode / Droid / Amp / Qwen Code / MiniMax Code / CodeBuddy / WorkBuddy）各建一条软链。

几个要点：

- **版本与 CLI 同步**：skill 的版本号 = 打包它的 `agent-ex-mcp` 版本。已发布的包不可变 ⇒ 装出来的 skill
  永远和你的 CLI 对得上。升级 CLI 后再跑一次 `agent-ex skill install`，它会先问再替换。
- **不会覆盖别人的东西**：目标路径已有**实体目录**且不是 agent-ex 装的 ⇒ 直接中止、内容一字不改。
- **自动桥接的宿主不建链**：WorkBuddy 只扫 `~/.workbuddy/skills`，但多数 WorkBuddy 安装自带
  `~/.workbuddy/hooks/sync-agents-skills.sh`，会自己把 `~/.agents/skills` 桥接过去 ⇒
  `agent-ex skill install` 检测到就会告诉你不用手工链。没有该脚本的机器显式点名：
  `agent-ex skill install --agent workbuddy`。
- **直读共享目录的宿主永远不建链**：Codex / Cline / Zed 读的就是 `~/.agents/skills`，
  给它们建链等于链到 canonical 自己。`agent-ex skill status` 会把它们标成
  「reads ~/.agents/skills — no link needed」。
- **`--agent` 自己挑宿主**：默认给**本机装了**的宿主（判据是它们的配置根目录存在：
  `~/.claude`、`~/.cursor`、`~/.config/opencode` …）建链。`--agent <名字>` 则**只**装你点名的那些，
  且不问：

  ```bash
  agent-ex skill install --agent cursor --agent claude-code   # id 与别名都认
  agent-ex skill install --agent '*'                          # 全部需要建链的宿主
  agent-ex skill remove --agent cursor                        # 只删这一家，其余不动
  ```

  名字认不出来会直接报错，**磁盘上一个字节都不写**。
- **非交互环境（CI / 管道）直接拒绝执行**（退出码 2），除非显式给 `--yes`：这两个命令会建链、会重指、会删目录。
  `--yes` 的语义是「所有问题都答 yes」，**不是**「所有宿主都链上」。

看状态：`agent-ex skill status`（只读）；卸载：`agent-ex skill remove`。

## 命令行工具

`agent-ex` 既是 MCP server，也是几个运维子命令的入口：

| 命令 | 作用 |
| :--- | :--- |
| `agent-ex init` | 首次安装向导（探测 CLI、生成 `config.json` + `.env`）。**重跑会重写 `config.json`**；覆盖前逐项列出差异并要求确认，旧文件自动备份。 |
| `agent-ex doctor` | 体检：把「通知到底通不通」的证据聚合成结论 + 病因 + 修复命令。**只读**。 |
| `agent-ex doctor --fix` | 自动修**确定性缺陷**（显式空串关键词、改名前的旧产品名、明文 webhook 落在 config.json）。**不动 `dry_run`**（那是你的偏好）；**不动自定义关键词**（机器人登记什么词是用户的界面）。 |
| `agent-ex doctor --send` | 额外实发一张**正文不含产品名**的自检卡，验证真实投递。 |
| `agent-ex config list` | 列出 profiles / executors / notify / defaults 现状。 |
| `agent-ex config set <key> <value>` | 改单个字段。白名单：`notify.dry_run`、`notify.keyword`、`defaults.timeout_sec`，以及 `executors.<name>.bin`。 |
| `agent-ex profile list` | 列出所有 profile（标出默认的那个）。 |
| `agent-ex profile use <profile>` | **切**默认 profile。 |
| `agent-ex profile create <built-in> [--bin <path>]` | **物化**一个内置预设（当前：`opencode-zen-free`，零密钥的 opencode 免费模型）。只创建，不切默认。 |
| `agent-ex profile set <profile> <KEY> <value>` | 改 profile 的 env 字段，或用保留字 `executor` 改它用哪个 executor、用 `path_dirs` 声明 worker PATH 的额外目录。 |
| `agent-ex wait <task_id>` | **阻塞等一个任务到终态**（或到 `needs_input`），并把 worker 的最终报告提出来。 |
| `agent-ex skill install` | 把 dispatch skill 装到 `~/.agents/skills`（**随 npm 包分发**），并给本机存在的宿主各建一条软链。`--agent <名字>` 限定只装你点名的宿主。 |
| `agent-ex skill remove` | 卸载：删掉宿主软链与安装的拷贝。**只删软链**，实体目录一律不碰；只要还有东西留在原地，退出码就是非 0。 |
| `agent-ex skill status` | 只读：装在哪、是哪一版、哪些宿主还没链。 |

`doctor` 也有对应的 MCP 工具 `agent_ex_doctor`，让 agent 自己就能排错。

### `agent-ex wait`

```bash
agent-ex wait task_abc123                    # 等到终态或 needs_input
agent-ex wait task_abc123 --once             # 查一次就返回
agent-ex wait task_abc123 --max-wait-sec 900 # 自己给等待窗口
```

stdout 是机器可读的 `KEY=VALUE`，**退出码就是判据**：`0` 终态、`5` needs_input（**不是终态**——
答完后对同一个 id 再等一次）、`2` 超时、`3` 无此任务、`6` 库读不了（**环境问题**，不是任务问题）、`4` 参数用错。
完整契约见《[任务生命周期与状态机](user-guide/state-machine.md)》。

## MCP 工具

| 工具 | 参数 | 返回 |
| :--- | :--- | :--- |
| `agent_ex_submit` | `prompt`（必填）、`project_path`、`profile`、`continue_of`、`timeout_sec` | `{ task_id, status, rounds }` |
| `agent_ex_status` | `task_id`、`include_finished`（0.3.1+）、`limit` | 任务字段；`needs_input` 时含 `question` |
| `agent_ex_cancel` | `task_id`（必填） | 当前状态（对终态任务幂等） |
| `agent_ex_version` | — | `{ version, gitSha, buildTime }` |
| `agent_ex_doctor` | `send`（可选） | 带 severity / detail / fix 的 findings |
| `agent_ex_restart` | — | server 退出，由宿主 respawn |

> 部分 MCP 宿主会再加一层前缀（如 `mcp__agent-ex__agent_ex_submit`）。

server 是无状态的——状态全在 `tasks.db`。`restart` 不影响在跑的 worker（它们在各自的进程组里），
也不影响其他存活的 server 实例。

## 配置

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
| :--- | :--- |
| `executors.<name>.bin` | agent CLI 的位置——**裸命令名或绝对路径皆可**。 |
| `profiles.<name>.env` | 传给 agent 子进程的环境变量，`{env:VAR}` 占位符在任务运行时解析。**绝不要在这里写 `PATH` / `NODE_OPTIONS` / `LD_*` / `DYLD_*`**——那是 worker 的进程启动/加载面，等价于任意代码执行。 |
| `profiles.<name>.path_dirs` | 追加给 worker `PATH` 的**绝对**目录列表。这是扩展 worker PATH 唯一受支持的方式。 |
| `notify.dry_run` | `true`（缺省）只把卡片打到 stderr，不真发。 |
| `notify.keyword` | 追加在卡片末尾的关键词。缺省 `agent-ex`；必须与机器人侧登记的词一致。 |
| `defaults.profile` / `defaults.timeout_sec` | 默认 profile 与单轮超时秒数。 |

真实密钥永不进 `config.json`：那里只写 `{env:VAR}` 占位符，真实值放 `$AGENT_EX_HOME/.env`
（chmod 600，server 启动时自动加载）。

完整参考——全部字段、`{model:zen-free}`、`[1m]` 上下文窗口、`path_dirs`、写入口白名单：
《[配置详解](user-guide/configuration.md)》。

## 通知

通知走飞书（Lark）群自定义机器人 webhook。本工具**只支持「自定义关键词」这一种安全设置**——
**别勾选加签**：工具不发 `timestamp`/`sign`，勾了必然每张卡都被拒。

验证链路要用自检卡，别拿真实任务报告当探针：

```bash
agent-ex doctor --send
```

| 飞书 `code` | 含义 |
| :--- | :--- |
| `0` | 已投递 |
| `19024` | 关键词校验失败——机器人侧登记词与 `notify.keyword` 不一致 |
| `19021` | 签名校验失败——机器人勾了「加签」，去关掉 |
| `19001` | webhook 地址本身失效——重新复制一个 |
| `19022` | IP 校验失败——机器人勾了「IP 白名单」 |

完整走查（建机器人、安全设置矩阵、全部错误码）：《[飞书通知详解](user-guide/notifications.md)》。

## 排错

| 症状 | 多半是 |
| :--- | :--- |
| `executor "claude" bin "…" not found or not executable` | 路径不对或没 `+x`。写裸命令名时按 `process.env.PATH` 解析。 |
| 任务 `failed`，`error: failed to spawn runner: … ENOENT` | `bin` 所在目录里没有可执行文件。worker 的 `PATH` 由 `dirname(bin)` + `path_dirs` + 系统目录自建——`/opt/homebrew/bin` 不在其中，除非你用 `path_dirs` 声明。 |
| `{env:VAR}` 报 `not found in process environment` | 密钥既不在 `.env` 里也没 export 到 server 进程。加到 `$AGENT_EX_HOME/.env` 后重启 server。 |
| 飞书不推送 | `notify.dry_run` 还是 `true`；或 webhook 缺失；或机器人勾了加签（`code=19021`）。 |
| 改了代码但行为没变 | MCP 宿主复用常驻 server 进程。重新 build 后调 `restart`，再用 `version` 核对 `gitSha`。 |
| skill 装了但宿主没加载 | 跑 `agent-ex skill status` 看哪些宿主没链，再 `agent-ex skill install --agent <宿主>`。 |

## 文档

| 文档 | 内容 |
| :--- | :--- |
| [English README](../README.md) | 同一份指南的英文版 |
| [配置详解](user-guide/configuration.md) | `config.json` 全部字段、密钥、模型解析、worker PATH |
| [飞书通知详解](user-guide/notifications.md) | 建机器人、安全设置、错误码 |
| [任务生命周期与状态机](user-guide/state-machine.md) | 状态机、续跑、`agent-ex wait` 契约 |
| [init 详解](user-guide/init.md) | 交互式向导逐步说明 |
| [AGENTS.md](https://github.com/wuruofan/agent-ex/blob/main/AGENTS.md) | 维护者文档：硬约束、发版流程 |
| [CHANGELOG.md](https://github.com/wuruofan/agent-ex/blob/main/CHANGELOG.md) | 版本历史 |

## License

MIT
