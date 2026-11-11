# Changelog

本文件记录 `agent-ex-mcp` 的版本历史。**每个版本号只发布一次**（npm 上已发布的版本不可变）。
发布流程见 [`AGENTS.md`](AGENTS.md#发布npm)。

> ⚠️ **0.3.2 从未发布**：它只存在于 git（`chore(release): 0.3.2`），npm 上最高曾停留在 0.3.1。
> 0.4.0 包含了 0.3.2 的全部内容，并新增了用户可见子命令 ⇒ 按 semver 走 minor，直接发 0.4.0。

## 0.4.0（2026-11-11）

**dispatch skill 随 npm 包分发 + 三个新子命令。**

- **新子命令** `agent-ex skill install|remove|status`：
  - `install` 把 `skills/agent-ex-dispatch` 拷贝到 `~/.agents/skills/agent-ex-dispatch`，
    写 `.agent-ex-skill.json`（版本号 + 内容指纹），并给本机该链的宿主各建一条软链；
  - `remove` 只删软链与它自己装的拷贝，**实体目录一律不碰**；只要还有东西留在原地，退出码就是非 0；
  - `status` 只读：装在哪、是哪一版、哪些宿主还没链。
  - 用户路线 = 拷贝（写 marker），开发者路线 = 软链（`--link`，不写 marker）。
  - 非交互环境（CI / 管道）默认**拒绝执行**（退出码 2），须显式 `--yes`。
- **skill 目录进 npm 包**（`files` 白名单新增 `skills/agent-ex-dispatch`）⇒ 装完包一条命令就能用，不用 clone 仓库。
- **飞书卡片脚注**标出这次用的 profile 与**实际跑起来的模型**（`{model:zen-free}` 解析后的真实 id）。
- **`init` 收尾精简**：从 39 行降到 24 行，只保留用户真正要做的三件事。
- **模型存活预检**：派发前确认模型可用，避免任务起手就撞死模型。
- **`init` 自动探测工具链**并预填 worker 的 PATH 目录（node / npm / bun / git）。
- `profiles.<name>.path_dirs`（原 `path_prepend`）：worker PATH 的**唯一受控来源**。
- `agent-ex wait` 的报告改为**原子写**，修掉半截文件被读到的窗口。

## 0.3.1（2026-11-06）

**补发 `include_finished` 所在版本。**

- `agent_ex_status` 新增 `include_finished` / `limit`：能列出已终态的任务，
  供会话重启 / 上下文压缩后认回「上次派的那个」。
- **MCP 工具参数严格校验**：未知参数不再被静默剥离（`server.tool` 默认 strip ⇒ 旧版会把
  `include_finished` 悄悄吞掉、只回空列表，宿主分不清「不支持」与「真的没任务」）。
- dispatch skill 改用 `agent-ex wait`，不再依赖包内自带的 `wait-task.mjs` 脚本。
- skill 补一条宿主无关的兜底路径（万一 `agent-ex wait` 不可用）。

## 0.3.0（2026-11-05）

**`agent-ex wait` 作为 CLI 子命令。**

- 新增 `agent-ex wait <task_id>`：阻塞等任务到终态（或 `needs_input`），并把 worker 的最终报告提出来。
  stdout 是机器可读的 `KEY=VALUE`，退出码即判据（`0` 终态 / `5` needs_input / `2` 超时 / `3` 无此任务 /
  `6` 库读不了 / `4` 参数错）。
- **MCP SDK 懒加载**：CLI 子命令不再为 MCP SDK 付启动税（实测 6s → 0.9s），
  `node:sqlite` 也改成按需加载，`agent-ex init` 的交互提示符里不再插进实验性警告。
- `wait` 支持只读降级：沙箱禁写数据目录时复制一份库再读（stdout 出现 `DB_SOURCE=copy`）。
- contributor 指南从 README 拆到 [`AGENTS.md`](AGENTS.md)。

## 0.2.0（2026-10-26）

面向「配置改不动、通知不通」这两个高频痛点的版本。

**新增 MCP 工具**

- `agent_ex_doctor`：把「通知到底通不通」的证据聚合成**结论 + 病因 + 可复制的修复命令**；
  `send=true` 会实发一张正文不含产品名的自检卡。验证飞书关键词闸门必须用它——
  拿真实任务报告当探针会假通过。

**新增 CLI 子命令**（0.1.0 的 server 只认 `init`，其余子命令一律被静默吞成 MCP server）

- `agent-ex doctor [--fix] [--send]`：体检。`--fix` 自动修**确定性缺陷**（显式空串关键词、
  过期产品名、明文 webhook 落在 config.json），但**不动 `dry_run`**（那是偏好不是缺陷）、
  **不动自定义关键词**（机器人登记什么词是用户的界面）。
- `agent-ex config [list|set]`：改全局字段。写入口是**白名单**——只改一个字段不必重跑 `init`。
- `agent-ex profile [list|use|create|set]`：profile 生命周期。
  `profile create opencode-zen-free` 物化零密钥的内置免费模型预设。
- 拼错的子命令现在**明确报错并打印用法**，不再静默变成 MCP server。

**免费模型**

- zen 免费模型**动态解析** `{model:zen-free}`：每次 spawn 前拉实时清单（免鉴权），配置里零硬引用模型名；
  撞限流的模型进排除集后自动路由到下一个。

**修复**

- init 的 opencode+zen-free 分支与内置 preset 统一：**同名同 env**。
- CLI 与 MCP 的 `.env` 加载路径统一：此前 CLI 侧解析 `{env:VAR}` **必失败**。
- 飞书关键词改由单一 brand 常量派生；去掉 SQLite WAL 依赖（只读沙箱也能读 task db）。
- 零密钥的 opencode 配置不再误报「必须设置 MINIMAX_API_KEY」。

## 0.1.0（2026-10-14）

首个公开版本：`agent_ex_submit` / `agent_ex_status` / `agent_ex_cancel` / `agent_ex_version` /
`agent_ex_restart` 五个 MCP 工具，加上 `agent-ex init` 交互式向导
（探测 CLI → 生成 `config.json` + `.env`）。

> 已知缺陷：发布出去的 README 里写的是 `npm i -g agent-ex`，**错的包名**
> （实际发的是 `agent-ex-mcp`），照着装会装不到。后续版本已修。
>
> 另外，**包里没有 CLI 层**（`dist/cli.js` 等三个文件当时还没写），其 server 只认 `init`，
> 其余子命令会被静默吞成 MCP server。
