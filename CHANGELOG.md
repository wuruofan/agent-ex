# Changelog

本文件记录 `agent-ex-mcp` 的版本历史。**每个版本号只发布一次**（npm 上已发布的版本不可变）。
发布流程见 [`AGENTS.md`](AGENTS.md#发布npm)。

## 0.6.0（2026-11-25）

**破坏性变化：派发到计费档 profile 需要显式授权。** 另修正 doctor 的两处判据，补上 MCP 市场收录。

- **`profile.cost`**（`"free"` / `"metered"`）：不声明按 `metered` 处理；声明 `free` 但系统无法独立验证时只 warn。`init` 会显式写好该字段。
- **`agent_ex_submit` 新增 `allow_metered`**：派发到默认 profile 或免费档永远放行；只有「切到别的、且计费的 profile」会被拒（不落任务行），除非显式传 `allow_metered: true`。按次生效——429、额度耗尽、超时、失败都不算同意计费。
- **留痕**：任务行记录本次派发的有效成本，`agent_ex_status` 回显，飞书终态卡页脚标注。
- **doctor**：worker PATH 缺口改为「worker 自己能否解析 node/npm/bun/git」（换工具链版本后需自己更新 `path_dirs`）；历史拒收证据只回看 7 天。
- **首步看门狗**：worker 10 分钟无 stdout 即判定挂死并失败（`AGENT_EX_FIRST_OUTPUT_TIMEOUT_MS` 可调）。
- **配额识别**：识别 opencode 免费档的 `Free usage limit reached.`，会推配额告警卡。
- **MCP 市场收录**：新增 `mcpName` / `server.json` / `glama.json`；`serverInfo.version` 不再硬编码。

## 0.5.1（2026-11-17）

**修掉六个「任务卡死 / 通知丢失 / 进程残留」的老毛病，外加 doctor 的两处口径修正。**

- **超时不再挂死**：agent 退出但逃逸孙进程占着 stdout 时，旧实现等不到 `close` 事件 ⇒ 任务永远停在 `running`。现在超时后 8s 宽限，agent 不退出就落 `failed(timeout)` 并推卡。
- **SIGTERM 时真等通知回执**：旧实现启动等待后立即 `exit(0)` ⇒ 拒收回执丢失、`notify_failed` 标不上。现在最多等 `AGENT_EX_NOTIFY_GRACE_MS`（默认 40s）。
- **配额告警卡也会被等到**：原先是 fire-and-forget，进程退出时被掐断；现在会被等，但不标 `notify_failed`。
- **webhook 解析失败不再崩 runner**：`{env:VAR}` 缺失时按通知失败处理（终态卡标 `notify_failed`）。
- **`cancel` 不再硬杀排空中的 runner**：runner 排空通知期间写 drain 标记，宿主放过它。
- **不再留孤儿 agent**：新增 `src/agent-guard.ts`，runner 不许在 agent 还活着时退出。
- **doctor 历史失败分两桶**：拒收日志行尾带 `card=<标签>`，任务级（对应 `notify_failed`）与提示级分开统计；老日志一律算任务级。
- **doctor 指出 worker PATH 工具链缺口**并给出补全命令；`profile set <p> path_dirs ""` 改为写 `[]`（明确表态不要额外目录，与「从未配过」区分）。
- **通知表与代码对齐**：`needs_input` 会发卡，`cancelled` 不发卡。

## 0.5.0（2026-11-12）

**dispatch skill 的宿主表扩容 + `--agent` 选宿主。**

- **宿主表从 5 家扩到 17 家**（一线常用）：Claude Code / Cursor / Windsurf / Trae / Trae CN /
  GitHub Copilot / Gemini CLI / OpenCode / Droid / Amp / Qwen Code / MiniMax Code / CodeBuddy /
  WorkBuddy，外加直读共享目录的 Codex / Cline / Zed。
  目录与「在场判据」对着 `npx skills`（vercel-labs/skills）的宿主表逐条核过，不抄它那 58 家。
- **`--agent <名字>`**：只装 / 只卸你点名的宿主（id 与别名都认，`'*'` = 全部需要建链的宿主）。
  与 `--target <目录>` 并存但语义不同：`--target` 点名的是**目录**（加法），
  `--agent` 点名的是**宿主**（选法——给了就只装这些）。
- **在场判据从「skills 目录存在」改成「宿主配置根目录存在」**：skills 目录常常是我们自己建出来的，
  拿它当判据 ⇒ 装过一次就永远在场，没装过的宿主反而被漏掉。
  且**我们自己建出来的配置根不算在场**（给没装的宿主建链会连带建出 `~/.cursor` 这种目录，
  否则它从此永远"在场"、普通 install 也会去链它）。
- **`status` 里「已经有条目」的宿主一定列出来**：amp 的链建在 `~/.config/agents/skills`，
  而它的配置根 `~/.config/amp` 可能压根不存在 ⇒ 按"在场"过滤会让这条链彻底看不见。
- **Codex / Cline / Zed 永不建链**：它们读的就是 `~/.agents/skills`，建链等于链到 canonical 自己，
  卸载时还会把 canonical 当成宿主链删掉。
- **修掉一个误报**：开发者路线下 canonical 是软链 ⇒ 直读共享目录的宿主会被误报成「链到别处」。
- `status` 按「本机装了 / 已经有条目 / 没装」分组输出，十几家宿主不再刷屏。
- 认不出来的 `--agent` 名字直接报错，**磁盘上一个字节都不写**。

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
