# Changelog

本文件记录 `agent-ex-mcp` 的版本历史。**每个版本号只发布一次**（npm 上已发布的版本不可变）。
发布流程见 [`AGENTS.md`](AGENTS.md#发布npm)。

> ⚠️ **0.3.2 从未发布**：它只存在于 git（`chore(release): 0.3.2`），npm 上最高曾停留在 0.3.1。
> 0.4.0 包含了 0.3.2 的全部内容，并新增了用户可见子命令 ⇒ 按 semver 走 minor，直接发 0.4.0。

## 0.6.0（未发布）

**派发到计费档 profile 现在需要显式授权：这是用户可见的破坏性行为变化。**

- **profile 新增 `cost` 字段**（`"free"` / `"metered"`），声明这个 profile 会不会花钱。
  **不声明按 `metered` 处理**（fail-safe）⇒ 升级后，既有配置里那些**结构化判定不是 free** 的 profile
  （几乎所有 claude 档与硬编码模型的 opencode 档）**每次派发都会被拦**——直到你显式声明
  `agent-ex profile set <name> cost free`（确认真不花钱才用），或每次调用带 `allow_metered: true`。
  结构化判定就是 free 的（`opencode-zen-free` 那类：executor 是 opencode 且 `model` / `small_model`
  **都**是 `{model:zen-free}` 占位符）照常放行，不受影响。
  `agent-ex init` 产出的配置会**显式**写好 `cost`（新装用户 `doctor` 一开始就是干净的、不会看到一堆 info），
  但 claude 档 / 自带 key 的 opencode 档本来仍是 metered ⇒ 派发仍需 `allow_metered`。
- **`agent_ex_submit` 新增 `allow_metered`**：派发到计费档必须带 `allow_metered: true`，
  否则直接拒绝（且**不留下任务行**）。这个开关**按次**生效——429、额度上限、free 池全挂、
  超时、失败**都不是**同意计费，不能靠加这个参数把任务"救活"。
- **留痕**：每次派发的有效成本记在任务行的 `cost` 列，由 `agent_ex_status` 回显、
  飞书终态卡页脚标注「计费档」/「免费档」/「未记录」。写入口只有闸门路径
  （`store.setCost()`）⇒ 「只有过了闸门的派发才会留痕」是结构保证，不是约定。
- **doctor**：未声明 `cost` 的 profile 报一条 info（**不阻断启动**，老配置照样能用）；
  `cost` 值非法报 error；声明 `free` 但系统无法独立验证时报 warn（只提示，**不自动改判**）。
- **首步看门狗**：worker 起进程后 10 分钟内 stdout 一行都没出 ⇒ 判定挂死并快速失败，
  错误文案点名「模型额度/限流」。此前这种形态（opencode 撞上限额后既不输出也不退出）
  只能等全局超时（默认一小时）才落终态，实测挂过一次 40 分钟。
  阈值可用 `AGENT_EX_FIRST_OUTPUT_TIMEOUT_MS` 调整。
- **配额识别**：opencode 免费档额度耗尽的真实措辞（`Free usage limit reached.`）现在能被识别 ⇒
  会推那张 ⚠️ 配额告警卡，而不是静默到终态。

## 0.5.1（2026-11-17）

**六个「任务卡死 / 通知丢失 / 进程残留」的老毛病一起修掉，外加 doctor 的两处口径修正。**

- **超时不再挂死**：agent 自己退出、但有个逃逸孙进程一直占着 stdout（被 init 收养 ⇒ 杀不掉、管道不关）
  ⇒ 旧实现把「落终态」挂在 child 的 `close` 事件上，那个事件永不触发 ⇒ 任务永远停在 `running`。
  实测有一次挂了 **16.5 小时**，最后靠人工 cancel 收场。现在超时后有 **8s 宽限**：agent 不退出就自己落
  `failed(timeout)` 并推卡 ⇒ agent 卡死不会让任务永远停在 `running`。
- **SIGTERM 时真等通知回执**：旧 handler 只是「启动」了等待就 `process.exit(0)`，回执随进程一起消失
  ⇒ 飞书拒收时 `notify_failed` 标不上、日志里也不会有 `[notifier] feishu rejected` ⇒ doctor 扫不到，
  正是它本该抓的那类静默失败。现在会真等到回执落地（最多 `AGENT_EX_NOTIFY_GRACE_MS`，默认 40s，
  盖住 notifier 自己最坏的 ~35s）；等不到就把「没送达」标进 DB 再走。
- **配额告警卡也会被等到**：它原先是 fire-and-forget（不进等待集合）⇒ SIGTERM / 超时兜底退出时它被掐断，
  「这个任务正在配额上要挂了」的早期告警**静默丢失**。现在它在飞也会被等。
  但它被掐断**不**标 `notify_failed`——那笔账只记「任务终态那张卡」。
- **webhook 解析失败不再崩 runner**：`{env:VAR}` 变量缺失时 `resolveEnvPlaceholders` 会抛错，旧代码两处都没接：
  终态卡那条异常穿出 `main`（任务已终态、runner 却 exit(1) ⇒ `notify_failed` 标不上、也没卡发出），
  配额卡那条抛在 `rl.on("line")` 里（uncaughtException ⇒ runner 当场死 ⇒ 任务永远停在 `running`）。
  现在解析失败 = 通知失败（终态卡标 `notify_failed`），不是崩溃。
- **`cancel` 不再硬杀正在排空通知的 runner**：`cancel` 走 `killTree`，默认 3s 后对整个进程组补 SIGKILL，
  而 runner 要等在飞的飞书通知（最多 40s）⇒ 排空中被砍，回执丢失（卡早 flush 给飞书了，丢的是「飞书收没收」）。
  现在 runner 排空期间会写一个 drain 标记，宿主据此放过它——它排空后自己退出。
- **不再留孤儿 agent**：runner 退出时 agent 还活着（宿主只杀 runner 本身、agent 在同组里活了下来；
  或 runner 崩了、Node 默认直接退出）⇒ 没人杀它、没人读它的 stdout，它一直烧 token。
  新增 `src/agent-guard.ts` 持有这条不变式：「runner 不许在 agent 还活着时退出」。
- **doctor 的历史失败分两桶**：runner 对终态卡和配额告警卡写的是同一行拒收日志 ⇒ doctor 把配额卡的拒收
  也算成「任务通知被拒收」，而 DB 里那些任务的 `notify_failed` 仍是 0 ⇒ 两处口径矛盾。
  现在拒收日志行末尾带 `card=<标签>`，doctor 据此分桶：任务级（终态卡，与 `notify_failed` 同一口径）
  与提示级（配额告警卡，明说不影响 `notify_failed`）。老日志没有标签 ⇒ 一律算任务级（保守）。
- **`doctor` 会指出 worker PATH 的工具链缺口，并给出补全命令**：
  - 从旧版本升级上来的 config 没有 `profile.path_dirs`，而 worker 的 PATH 是自建的
    （`dirname(bin)` → `path_dirs` → 系统目录，不继承 shell）⇒ node/npm/bun/git 要等到
    任务里第一次调用才以 `command not found` 炸出来。`agent-ex doctor` 现在会探测你 shell 里的
    这几个命令，把**没被 worker PATH 覆盖**的目录报成 warn，并给出
    `agent-ex profile set <profile> path_dirs …`（已有目录保留在前）。
  - 判据是**缺口**不是「字段缺失」：目录已被 `dirname(bin)` / `path_dirs` / 系统目录覆盖时不报；
    `bin` 本身不可用时也不报（病灶在 bin）。doctor 仍然只读，`--fix` 的范围不变。
  - **`profile set <p> path_dirs ""` 由「删掉键」改为「写 `[]`」**。两者从此是两种状态：
    `[]` = 你明确表态不要额外目录（doctor 不再提示补全），缺席 = 从未配过（doctor 会提示）。
    删键的话这两种状态在文件里长得一样，doctor 只能对主动清空过的用户反复唠叨。
  - 工具链探测与其依赖的 worker PATH 目录列表移到 `src/agent-env.ts`：`init` 与 `doctor` 共用同一份。
- **通知表与代码对齐**：`docs/user-guide/notifications.md` 的「什么时候发通知」此前与代码不符两处——
  `needs_input` 实际**会**发卡（❓「需要输入」卡，不发的话没人知道要去答复）、
  `cancelled` 实际**不发**卡（cancel 是主动叫停：server 先把任务置为 `cancelled`，
  runner 随后收尾时那张终态卡也就落不下来）。两处都已按实际行为改写。
- 另附两份设计文档：超时归因设计（`docs/specs/`）与它的「悬空步」判据。

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
