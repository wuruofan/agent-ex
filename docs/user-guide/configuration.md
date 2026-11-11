# 配置详解（agent-ex）

> 本文是 [`agent-ex-mcp`](https://www.npmjs.com/package/agent-ex-mcp) 的**深度章节**：
> `config.json` 的全部字段、密钥怎么放、模型怎么动态解析、worker 的 PATH 怎么拼。
> 只想快速跑起来的看仓库根 [README](../../README.md) 的「Configuration」一节就够。

关联实现：`src/config.ts`（**校验的唯一真相源**，`validateConfig()` 与 `doctor` 都消费它）、
`src/config-cmd.ts`（`config` / `profile` 子命令的纯函数）、
`src/agent-env.ts`（worker 子进程环境）。

---

## 1. 配置目录

配置文件放在 `AGENT_EX_HOME` 指向的目录下，文件名固定为 `config.json`：

```bash
export AGENT_EX_HOME="$HOME/.agent-ex"   # 缺省即此；也可指向任意目录
```

目录里同时会有：

| 文件 | 作用 |
| :--- | :--- |
| `config.json` | 主配置（**只含 `{env:VAR}` 占位符，零明文密钥**） |
| `.env` | 真实密钥，权限 `chmod 600`，server 启动时自动加载 |
| `tasks.db` | SQLite 任务库，**全局单库**（所有项目共用） |
| `logs/` | runner 日志（`runner-*.log` / `task_*.jsonl`），`doctor` 会扫 |

## 2. `config.json` 结构

参考仓库根的 `config.example.json`，完整字段：

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
| `executors.<name>.bin` | agent CLI 的位置：**绝对路径或裸命令名皆可**（见 §3）。 |
| `executors.<name>.extra_flags` | 拼到 agent 命令后的额外参数。权限开关按 executor 区分：claude 用 `--dangerously-skip-permissions`，opencode 用 `--auto`（`init` 会自动写对）。 |
| `profiles.<name>.executor` | 引用 `executors` 里的某个 executor。 |
| `profiles.<name>.env` | 传给 agent 子进程的环境变量；支持 `{env:VAR}` 占位符（见 §5）。**opencode 一般留空**（provider 由 opencode 自己的 `auth.json`/`opencode.json` 管理）；要给某个 profile 单独指定模型，写 `OPENCODE_CONFIG_CONTENT: "{\"model\":\"provider/model\"}"`——`extra_flags` 是 executor 级，多 profile 无法用它区分模型。**不要在此写 `PATH`**（会被拒绝）；要给 worker 补 PATH 目录用 `profiles.<name>.path_dirs`（见 §4）。 |
| `profiles.<name>.path_dirs` | 插进 worker `PATH` 的额外**绝对路径目录**列表（位于 executor 的 bin 目录之后、系统目录之前）。典型用途：让 worker 用 nvm 的 `node`。 |
| `notify.feishu_webhook_url` | 飞书机器人 webhook；支持 `{env:FEISHU_WEBHOOK_URL}` 占位符。 |
| `notify.dry_run` | `true`（缺省）→ 只打印通知内容不真发；`false` → 真发。 |
| `notify.keyword` | 附加在卡片末尾的「关键词」安全闸门。**缺省 = `agent-ex`**（`src/brand.ts` 的 `BRAND`，`loadConfig` 自动填入），一般无需手写。同一行还会标出这次用的 profile 与模型。详见《[飞书通知详解](notifications.md)》。 |
| `defaults.profile` | `submit` 不指定 profile 时用的默认 profile（必须在 `profiles` 中存在）。 |
| `defaults.timeout_sec` | 单轮超时（秒），超时 SIGTERM 杀掉 agent。 |

### 写入口是白名单

改配置**不要手改文件**，走这些命令（`src/config-cmd.ts` 的 `WRITABLE` + `executors.<name>.bin`）：

```bash
agent-ex config set notify.dry_run false
agent-ex config set notify.keyword my-agent
agent-ex config set defaults.timeout_sec 1800
agent-ex config set executors.claude.bin /abs/path/to/claude
agent-ex profile set minimax-3 executor claude
agent-ex profile set minimax-3 path_dirs /Users/you/.nvm/versions/node/v24.14.0/bin
```

`profile set` 的保留字：`executor`（换 executor）、`path_dirs`（worker PATH 目录，逗号分隔，空值清空），
其余 key 视为 env 变量名。

## 3. `executors.<name>.bin`：绝对路径或裸命令名皆可

`runner` 拉起 agent 时会显式构造子进程环境，其 `PATH` 以 **`dirname(解析后的 bin)` + 系统目录** 组成
（`src/agent-env.ts`）。`bin` 支持两种写法：

- **裸命令名** `"claude"`：运行时按 `process.env.PATH` 解析成绝对路径（与启动期 `validate()` 行为一致），
  `dirname` 取解析结果目录。最省事，推荐。
- **绝对路径** `/abs/path/claude`：直接用，适合多版本 / 非标准安装。

想确认 claude 会被解析到哪：

```bash
which claude        # → /Users/you/.nvm/versions/node/v24.18.0/bin/claude
which opencode      # → /usr/local/bin/opencode
```

> 早期版本要求必须写绝对路径；现已支持裸名自动解析，无需再硬编码 nvm 路径。

## 4. `profiles.<name>.path_dirs`：给 worker 补 PATH 目录

worker 的 `PATH` 由 `buildAgentEnv` 自建：
`dirname(executor bin)` → `path_dirs` → 系统目录（`/usr/bin:/bin:/usr/sbin:/sbin`），
**不读** `process.env.PATH`。要让 worker 用 nvm 的 `node` 而不是 homebrew 的，就声明额外目录
（绝对路径，逗号分隔）：

```bash
agent-ex profile set minimax-3 path_dirs /Users/you/.nvm/versions/node/v24.14.0/bin,/Users/you/.bun/bin
# 清空该字段：
agent-ex profile set minimax-3 path_dirs ""
```

- 只在**该 profile** 里生效；executor 自己的 bin 目录恒排第一，不会被挤掉。
- `agent-ex init` 会自动探测本机的 node/npm/bun/git 所在目录并预填该字段（各人的装法不同，不必手抄路径）；
  仍可用 `agent-ex profile set` 手工增删。
- 每项必须是绝对路径、非空、不重复；不合法时加载/`doctor` 会报出，`profile set` 当场拒绝。
- **不要**改成 profile env 里的 `PATH`：`profile set` 会拒绝（那是 worker 的启动面，等价于任意代码执行）。

> 同理，`profile env` 里也禁止写 `NODE_OPTIONS` / `PATH` / `LD_*` / `DYLD_*`——
> 它们是 worker 进程的启动/加载面，等价于任意代码执行。受控的 PATH 来源只有 `profile.path_dirs`。

## 5. 密钥：config 占位符 + `.env` 真实值

`env` 与 `feishu_webhook_url` 里写成 `"{env:VAR_NAME}"` 形式的值，会在**任务运行时**（runner 进程）
从环境变量替换。**config.json 永远不写真实密钥**，真实值放在 `$AGENT_EX_HOME/.env`：

```bash
# $AGENT_EX_HOME/.env（示例；init 命令会自动生成，chmod 600）
MINIMAX_API_KEY=sk-xxxx
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
```

- **server 启动时自动加载 `.env`** 灌进 `process.env`（`src/env-file.ts`；只补缺失，不覆盖真实环境变量），
  runner 是 server 的 detached 子进程，自动继承——所以**密钥不用写进 MCP 注册的 `env` 字段**。
- 占位符在运行时缺失 → 加载/解析直接报错（避免明文密钥意外落盘）。
- 想让 `.env` 生效，重启 server 进程即可。

## 6. 免费模型动态解析：`{model:zen-free}`

opencode zen 的 free 模型集会**轮换**（`mimo-v2.5-free` → `mimo-v2.6-flash-free` 已发生过，
`glm-4.7-free` 曾整体消失、后来又以 `glm-5.3-flash-free` 回来），硬编码模型名很快就会失效。
把 `{model:zen-free}` 写进 profile 的 env，即可在**每次 spawn 前**动态解析出当前可用的 free 模型：

```jsonc
{
  "profiles": {
    "opencode-zen-free": {
      "executor": "opencode",
      "env": {
        "OPENCODE_CONFIG_CONTENT": "{\"model\":\"{model:zen-free}\",\"small_model\":\"{model:zen-free}\"}",
        "ZEN_FREE_PREFER": "deepseek,glm,mimo"   // 可选：家族前缀软偏好，逗号分隔、按序匹配
      }
    }
  }
}
```

- **事实来源 = spawn 时的实时清单**（`https://opencode.ai/zen/v1/models`，免鉴权），
  因此配置里**零硬引用**模型名。
- `ZEN_FREE_PREFER` 只是「口味」：前缀过期不会导致失败，只会退化为「不挑食」（按 id 稳定排序取第一个可用的 `-free` 模型）。
- 清单拉取失败 → 退回内置回退常量，**绝不阻塞任务启动**。
- free 模型撞限流会 429；配合重试机制，已撞限的模型会被加入排除集，下一次尝试自动路由到另一个 free 模型。
- 非 zen profile 走零成本旁路（env 原样透传，不发任何请求）。

> 为何不做「报错后换模」自愈：模型下线时 opencode 报的
> `UnknownError: "Unexpected server error..."`（且 exit=0）与真实服务端故障无法区分，
> 所以坚持 **spawn 前主动解析**，不做错误驱动的猜测。

## 7. 上下文压缩：`[1m]` + `AUTO_COMPACT_WINDOW` + `PCT_OVERRIDE`

worker 的上下文占用到阈值就会触发自动压缩（摘要掉早期对话）。**这三个变量必须成套设置**，
否则达不到预期，甚至会适得其反。

claude-code 对**未知模型**（如 MiniMax / DeepSeek 等第三方模型）会回落到 **200k** 窗口兜底，
此时 `AUTO_COMPACT_WINDOW` 设多大都会被 `Math.min` 压回 200k，形同虚设。加 `[1m]` 后缀才能拿到 1M 窗口：

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

> **注意**：`~/.claude/settings.json` 的 `env` 块也会注入这些变量。agent-ex 传了 `HOME` 给子进程，
> claude 会自行读取该文件——**若那里设了同名 key，agent-ex 的 `profiles.<name>.env` 优先级更高**
> （仅当该 key 已在 profile 中显式设置）。想完全由 agent-ex 单点控制，就把两个变量都写进 profile env。

**验证是否真的生效**：看任务日志 `result` 事件的 `modelUsage.<model>.contextWindow`——
它反映模型窗口（带 `[1m]` 应为 `1000000`）；而**压缩工作窗口**不体现在该字段，
要看日志里是否出现 `ran out of context`。

## 8. 排错：配置加载失败

| 症状 | 原因 / 处置 |
| :--- | :--- |
| `{env:VAR}` 报错 `not found in process environment` | 对应密钥不在 `.env` 里，也没 `export` 到 server 进程环境。加到 `$AGENT_EX_HOME/.env` 后重启 server。 |
| `executor "claude" bin "…" not found or not executable` | `bin` 路径不对或没 `+x`。写裸命令名时按 `process.env.PATH` 解析，解析不到就写绝对路径。 |
| 任务 `failed`，`error: failed to spawn runner: … ENOENT` | 多因 `bin` 指向的位置下没有可执行文件。注意 worker 子进程的 `PATH` 只由 `dirname(bin)` + `path_dirs` + 系统目录组成，`/opt/homebrew/bin` 等不在其中——裸名建议先 `which` 确认解析结果。 |
| `profile env` 里写 `PATH` / `NODE_OPTIONS` 被拒 | 设计如此：那是 worker 的启动/加载面。改用 `path_dirs`。 |

体检命令：`agent-ex doctor`（只读）、`agent-ex config list`（看现状）。
