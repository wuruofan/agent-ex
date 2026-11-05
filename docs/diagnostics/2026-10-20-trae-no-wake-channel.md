# Trae 无后台唤醒通道 —— 会话内等待与自主 loop 的宿主前提

**文档编号**：2026-10-20-trae-no-wake-channel
**状态**：✅ **已实测定位**（2026-10-20；2026-10-21 追加 MCP 主动通道复测，见 §9）。结论：Trae **没有**「后台进程完成 → 自动开启新 turn」这条通道；`wait-task` 装备本身在 Trae 下**完整可用**，缺的只有唤醒那一段。**MCP 协议自带的 server→client 主动通道也补不上这一段**（§9）。
**文档类型**：`docs/diagnostics/`（与 `2026-08-29-trae-mcp-visibility.md`、`2026-10-16-readonly-sandbox.md` 同族：宿主行为 + 探针取证）
**关联**：`skills/agent-ex-dispatch/SKILL.md`「会话内定时等待与自主推进 loop」一节 —— 该节此前默认宿主具备唤醒能力，本文给出反例。**已据此修订 skill（10/21）**：见 §5。

---

## 1. 一句话结论

**Trae 的通知只在「有活跃 turn」时递送；turn 一空闲，后台进程的完成事件就停摆，直到下一次有人说话才被捎带送达。** 因此 `SKILL.md` 里「后台起 `wait-task` → 被唤醒继续」这条链路在 Trae 下**会断在唤醒那一步**：进程活着、任务也真的跑完了，但没有任何东西会主动叫醒 agent。

同一批探针同时确认了两件**成立**的事，避免把结论下得过宽：

| 命题 | 实测结果 |
| :--- | :--- |
| Trae 下后台进程能长时间存活、不受 600s 约束 | ✅ 成立（见 P2/P4） |
| Trae 下前台阻塞 ≤600s 能拿到结果并续在同一 turn | ✅ 成立（见 P3） |
| `wait-task.mjs` 在 Trae 下能读库并提取报告 | ✅ 完整可用（见 P5/P6） |
| Trae 后台完成事件能主动唤醒 agent | ❌ **不成立**（见 P2），这是 10/20 当日唯一的否定结论 |
| MCP server→client 主动通道（logging / resources/updated / sampling）能替代唤醒 | ❌ **不成立**（见 §9，2026-10-21） |

---

## 2. 触发

用户观察到「后台 `wait-task` 跑完后 agent 没有新 turn」，提问两件事：要不要在 skill 里明确「可能需要前台等待」；以及 skill 里有没有写 loop 的多轮交互方式。

先查文档现状：loop 是**写了**的，而且是一套完整协议（`SKILL.md` 的「自主推进 loop 协议（9/28 定稿：升级制闸门）」一节），但它把循环动力完整地押在唤醒上：

```
Loop 一步 = Step 1 并发检查 → Step 3 submit → 后台 wait-task → 被唤醒走上面 1–4 步 → 回到 Step 1
```

以及「以 `run_in_background` 方式启动，**不要**前台跑」、「进程在『终态 或 需要我』时退出 → **自动唤醒我**（后台任务完成会通知）」。这三处**都假定唤醒存在**。所以问题不是「skill 没写 loop」，而是「loop 的引擎在 Trae 上不存在」。

> 本节以下引用均按**内容**定位，不带行号（10/21 改 skill 后行号已漂移；改法见 §5）。

---

## 3. 探针矩阵（全部为 2026-10-20 本机实测）

时间戳为 `date +%s` 原值；本地时间按 `1792458666 → 09:11:06`（由 `ls -l` 的 mtime 校准）换算。

| # | 形态 | 命令 / 参数 | 观测 | 判定 |
| :-- | :-- | :-- | :-- | :-- |
| **P1** | 后台 + **turn 活跃** | `Shell{run_in_background:true}`，`sleep 60` | `job-f7a0635633204e618de4080ece5851ea`；标记文件写入 `WAKE_PROBE_DONE 1792458666`（09:11:06），进程提前退出；`task_notification` 在我**同一 turn 仍在执行**（另一次 76.8s 阻塞调用）时注入 | 通知**在活跃 turn 内会递送** ✅ |
| **P2** | 后台 + **turn 已空闲** | `Shell{run_in_background:true}`，`sleep 240` | `job-5f5c0656b1244094a81c4581b5619695`；退出码 0，日志 `done`；标记 `WAKE2 1792458944`（09:15:44）。我随即结束 turn、**不发任何指令**；此后**没有出现任何自主 turn**，通知与用户下一条消息（「好像没有唤醒？」）**同批送达** | **无自主 turn** ❌ 决定性 |
| **P3** | 前台阻塞 | `Shell{timeout:300000}`，`sleep 240` | `wall_ms=241470`，`status=completed`，`FG_DONE 1792460633`（09:43:53） | 前台 ≤600s **有效**、结果回同一 turn ✅ |
| **P4** | 前台阻塞触顶 | `Shell{timeout:600000}`，`sleep 700` | `wall_ms=600233`，`status=**timed_out_moved_to_background**`；`ps` 显示进程仍活（`ELAPSED 10:05`） | 600s 是**硬上限**；超时**自动转后台** ⇒ 落回无唤醒 ❌ |
| **P5** | 装备自检（否定路径） | `wait-task.mjs <bogus_id> --once` | `STATUS=unknown` / `WAIT=not_found` / `EXIT=3` | 脚本在 Trae 下能跑、能开库 ✅ |
| **P6** | 装备自检（肯定路径） | `wait-task.mjs task_mvfhc6wt_b0078c --once` | `STATUS=completed` / `WAIT=terminal` / `ELAPSED_SEC=147` / `FILES_CHANGED=1` / `REPORT_CHARS=361` / `MAX_WAIT_SEC=11010` / `EXIT=0`，`REPORT_TEXT` 内联 | **装备完整可用** ✅ |

### 3.1 P2 的量级口径（不要把上界当精确值）

能确知的只有区间：作业在 **1792458944 退出**，用户下一条消息在**此后、且在我下一次读时钟（1792460371，09:39:31）之前**到达。故「退出 → 有人说话」的间隔 **≤ 1427s ≈ 23.8min**，这是**上界**（我读时钟晚于用户发言，差值把那一段空档也算进去了）。用户侧的主观体验是「等了约 24 分钟什么都没发生」，与该上界一致。

**不依赖这个数字也能定案**：P2 的作业早已终态，而我在空闲状态**没有产生任何 turn**——「无自主 turn」是直接观测，不是从这个秒数推出来的。

### 3.2 P2 的一处不确定性（结论不受影响）

从 transcript 只能看到通知与用户消息同批出现，**分不清**两种情况：① Trae 在作业完成时就生成了通知、但**缓冲**到下次对话才 flush；② 通知本就要等到下一次对话才生成。两者对使用者的后果完全相同（**不会主动唤醒**），故不追。若要区分需宿主侧日志，不在本次范围。

---

## 4. 机制

SKILL.md「为什么这样可行」里的**工具层**那条结论在 Trae 下**仍然成立**，甚至被 P4 逐字验证：后台进程的寿命由它自己决定，工具层不介入；**前台调用才受 timeout 约束，超时会自动转后台而不是被杀**（P4 的 `timed_out_moved_to_background` 就是这句的字面实现）。

问题出在另一头：**递送**。Trae 的完成通知挂靠在**对话轮次**上，而不是挂靠在进程上。于是：

- 有活跃 turn → 事件能挤进来（P1）；
- 无活跃 turn → 事件无处可投递，等到下一次有人说话（P2）。

⇒ 这条通道**不是一个「等待器」，只是一个「回执」**。它无法承担 loop 里「等终态 → 继续」的驱动职责。

---

## 5. 对 `SKILL.md` 的影响（**10/21 已按本文改完**）

§2/§3 引用的 `SKILL.md:NNN` 行号是**本文取证当时（10/20）的位置**，10/21 改动后已漂移
（在 ~249 处插入了兜底段，247 之后的内容整体下移）。下表已换成**按内容定位**，不再依赖行号。

### 5.1 已改（10/21，`skills/agent-ex-dispatch/SKILL.md`）

| 位置（按内容） | 改前 | 改后 |
| :--- | :--- | :--- |
| 「以 `run_in_background` 方式启动」之后 | 无兜底 | 新增「**[回来先查] 宿主无关的兜底**」：每个新 turn 先查未消费的 wait-task 进程，按 `WAIT=` 分流 |
| 「进程在终态或需要我时退出 → 自动唤醒我」 | 假定唤醒必然发生 | 改成「**唤醒我**（宿主可能不具备唤醒能力，那种情况下由上面『[回来先查]』兜底接上 —— 唤醒是预期行为，不是保证）」 |
| 「被唤醒后必须走的流程」 | 标题绑定「被唤醒」 | 改成「**终态到手后必须走的流程**」—— 兜底路径与唤醒路径共用同一个闸门 |
| loop 协议「Loop 一步」 | 「被唤醒走上面 1–4 步」 | 「终态到手走上面 1–4 步」+「唤醒没来也不阻塞」 |
| 铁律 4 / Step 4「不轮询」 | 无豁免 | 显式豁免：兜底**每个 turn 最多查一次**、只针对已知待消费进程 |

兜底的查法只用**跨宿主都成立**的手段：重跑 `wait-task.mjs <task_id> --once`（幂等、
不改任务状态、不重派）。**不点名任何宿主专有工具** —— `CheckCommandStatus` 是 Trae 专名，
且 §6 已实测它在该宿主上直接报错，作为兜底首选是错的。

### 5.2 为什么是「兜底查询」而不是另外两条路

§5 原先列的三个候选修法里，**两条被否**，理由记在这里以免重复讨论：

| 候选 | 判定 | 理由 |
| :--- | :--- | :--- |
| **前台阻塞 ≤600s 兜底** | ❌ 否 | 任务中位 22min、p75 39min（见 SKILL.md 的轮询成本分析），**远超 600s 硬上限**；P4 已实测触顶后自动转后台，等于没等。只能覆盖极短任务。 |
| **定时巡检（Schedule 路线）** | ❌ 否 | 唤醒的是**新会话**，拿不到本会话上下文 ⇒ 丢掉的正是「带着前序任务事实 + plan 约束 + 用户期间发言回来判断」这块（SKILL.md 明确不许外包的部分）。 |
| **兜底查询（本轮采用）** | ✅ 采用 | 不依赖宿主唤醒能力、不依赖会话连续性（用 `agent_ex_status` 列出活跃任务可认回 task_id）、不产生额外的上下文重放成本（每个 turn 最多查一次）。代价：Trae 下 loop **退化为「用户每次回话推进一轮」**，不是真自主 loop —— 这是事实，不是缺陷。 |

> 不采用「把复核/唤醒外包给 subagent」这类绕法：loop 的价值恰恰在唤醒时**带着前序任务事实 + 当前 plan 约束 + 用户期间发言**回来判断（`SKILL.md`「不要把复核外包给 subagent」一条），换会话或换执行者都会把这块丢掉。

---

## 6. 环境附注（本会话，成因部分未定位）

这些是**本会话观察**，不是 Trae 不变量，但会影响 skill 里 shell 片段的写法，故记下：

| 项 | 观察 | 说明 |
| :--- | :--- | :--- |
| `RunCommand` | 一律报 `Toolhost terminal commands must be routed through the agent runtime`（直接调用与经 `Exec` 调用均如此） | 连 `echo` 都不过 ⇒ 与命令内容无关，是宿主侧透传/路由问题。**同日 `2026-08-29` 的 raw 报告里 `RunCommand` 是存在的**，故非 Trae 不变量 |
| `CheckCommandStatus` | 同一个错误 | 与上同源 |
| `Shell` | ✅ 可用，含 `run_in_background` / `timeout` / `cwd` | **本次全部探针都走它**；`SKILL.md` 的 `run_in_background` 措辞在此宿主下就落在这个工具上 |
| `mcp_agent-ex` | 报 `MCP server is not found`；宿主只透传了 `integrated_code_mode` | 未定位。故本文**没有**做「submit → wait-task」的端到端联调，只用真实历史任务验证了 `wait-task` 单侧（P6） |

### 6.1 `2026-10-16` 修复的回报

P5/P6 能直读 `~/.agent-ex/tasks.db`（**未**走副本降级——`DB_SOURCE` 只在用副本时才打印，本次输出里没有该行，见 `wait-task.mjs:430-432`），得益于 10/16 把 `journal_mode` 从 WAL 改成 TRUNCATE：静止态只剩 `tasks.db` + 0 字节 `tasks.db-journal`（本次实测确认）。⇒ **旧结论「只读沙箱读不到库」已不再是当前状态**，那条路径现在能走通。

---

## 7. 复现命令

```bash
# P2：后台起 240s 作业，然后结束本轮、什么都不发；观察是否出现自主 turn
#   （经宿主 Shell 工具，参数 run_in_background: true）
#   sleep 240; echo "WAKE2 $(date +%s)" > /tmp/probe_wake2.txt

# P3/P4：前台阻塞的两档（240s 通过 / 700s 在 600s 处转后台）
#   timeout: 300000 → 期望 completed
#   timeout: 600000 → 期望 timed_out_moved_to_background

# P5/P6：装备自检
SKILL_DIR=/Users/meow/workspace/agent-flow-ex/skills/agent-ex-dispatch
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-task.mjs" <bogus_id> --once          # 期望 exit 3
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/wait-task.mjs" <real_task_id> --once      # 期望 exit 0
```

探针现场已清理（`/tmp/probe_wake_marker.txt`、`/tmp/probe_wake2.txt` 删除；P4 进程 `StopCommand` 停掉）。

---

## 8. 遗留

1. **唤醒语义的正面清单未做**：Claude Code / WorkBuddy 侧「后台完成 → 真唤醒」是既有实测结论（SKILL.md「为什么这样可行」一节），本文**未复测**，只确认了 Trae 一侧的反例。
2. **`RunCommand` 被拒的根因未定位**：需要宿主侧配置证据，属另一条线索（与 `2026-08-29-trae-mcp-visibility.md` 的 MCP 透传问题可能同源）。
3. **端到端联调缺失**：`mcp_agent-ex` 不可见，故本次是「submit 由 MCP」+「等待由脚本」两条腿里**只验了后一条**。
4. ~~**`SKILL.md` 未改**：第 5 节的三处候选修法等用户拍板~~ → **10/21 已改**，见 §5.1（新增宿主无关的兜底查询）+ §5.2（另两条候选被否的理由）。
5. **兜底路径本身未做端到端实测**：§5.1 的兜底只用 `wait-task.mjs --once` 单侧验证（P5/P6），**没有**在 Trae 上跑一次「submit → 兜底查询 → 复核 → 续跑」的完整闭环（`mcp_agent-ex` 在该宿主不可见，见遗留 3）。skill 侧的规范已经写好，但闭环行为未经验证。
6. **「已消费」标记的落地方式未定**：§5.1 要求复核后把 task_id 划掉，但**存在哪里**（会话上下文里的清单 / 任务库 / 外部文件）没有定。目前定的是「写进回复正文或待办清单」——纯靠上下文有被压缩丢失的风险（届时 task_id 消失，反而不会重复复核；已终态的任务也无法用 `agent_ex_status` 无参列出，它只列 queued/running/needs_input）。

---

## 9. MCP 主动通道复测（2026-10-21，P7）—— 补不上唤醒这一段

P2 只证明了「Agent 自己的后台作业完成事件」不唤醒。一个自然的反问是：MCP 协议本身有 server→client 的主动通道，**能不能绕过宿主的事件机制、由 MCP server 直接把 agent 叫醒？** 本次实测否。

### 9.1 探针与执行条件

| 项 | 值 |
| :--- | :--- |
| 探针 | `scripts/probes/mcp-wake-probe.mjs`（247 行，MCP SDK 1.30.0） |
| 自检 | `scripts/probes/smoke-wake-probe.mjs`（模拟 client）三通道全绿，故失败只可能出在宿主侧 |
| 注册方式 | 临时写入 `~/Library/Application Support/Trae CN/User/mcp.json`，与 `agent-ex` 并列（**只加不改**），JSON 解析校验通过 |
| 启用 | 用户在 MCP 面板启用 + 重启 Trae；工具清单确认落盘 `~/.trae-cn/mcps/<session>/solo_agent/mcp_mcp-wake-probe/tools/probe_fire.json` |
| 探针进程 | `pid 91193`，13:39:31 启动，13:43:26 仍存活、stdin 未断开 |
| 触发参数 | `probe_fire {delay_ms: 5000, note: "trae-wake-test"}` |

### 9.2 日志（`~/.agent-ex/probe-wake.log`，UTC）

```json
{"seq":4,"ts":"2026-10-21T13:42:03.954Z","event":"tool_called","delay_ms":5000,"note":"trae-wake-test"}
{"seq":5,"ts":"2026-10-21T13:42:08.957Z","event":"logging_sent","note":"trae-wake-test"}
{"seq":6,"ts":"2026-10-21T13:42:08.958Z","event":"resource_updated_sent"}
{"seq":7,"ts":"2026-10-21T13:42:08.959Z","event":"sampling_skipped","reason":"client did not declare the sampling capability","client_capabilities":{}}
{"seq":8,"ts":"2026-10-21T13:42:08.959Z","event":"fire_sequence_done"}
```

同一进程在 **13:39:31 initialize** 时记录的：

```json
{"seq":3,"event":"client_initialized","client_capabilities":{}}   // pid 91193，另 pid 40320（03:23、13:39 两轮）同样为 {}
```

### 9.3 观测窗口

- `delay_ms=5000` 到点后，**60 秒静默窗口**：期间我没有发送任何用户消息、没有「戳一下」（避免污染证据），只跑了一条 `sleep 60`。
- 窗口结束后（13:43:26 UTC）复查：日志仍停在 `seq:8`，**没有任何新的入站请求**（若宿主因通知生成动作并回调该 server，会留下 `tool_called` 等新记录）。
- **本会话内没有出现任何非用户触发的新 turn**；窗口之后的首个对话事件就是用户这句「追加吧」。
- 探针进程未退出、stdin 未断 ⇒ 不是「server 挂了所以没送达」，而是**送达之后宿主零反应**。

### 9.4 判定

| 通道 | 协议层结果 | 是否产生新 turn |
| :--- | :--- | :--- |
| `notifications/message`（logging） | 发出成功（`logging_sent`） | ❌ |
| `notifications/resources/updated` | 发出成功（`resource_updated_sent`） | ❌ |
| `sampling/createMessage` | **握手阶段即排除**（`sampling_skipped`） | 不适用 |

**决定性事实是 `client_capabilities: {}`** —— Trae 的 MCP client 在 initialize 时**不声明任何可选能力**（没有 `sampling`、没有 `roots`、没有 `elicitation`）。这不是「运行时调用失败」，而是**协议层就没有这条通道的入场券**：sampling 要求 server 主动请求客户端跑一次 LLM，客户端未声明该能力时 SDK 直接拒绝构造请求。

⇒ **MCP 主动通道在 Trae 下不能替代宿主唤醒。** 这不是 P2 的重复，而是把 P2 的结论从「宿主的事件递送机制不唤醒」推进到「协议层提供的替代通道也不存在」：Trae 既不会把通知翻译成新 turn，也不提供带响应的 sampling 请求入口。**Trae 下 loop 只能是「用户回话时推进一轮」**，§5.1 的兜底查询仍是唯一可行路径。

### 9.5 证据强度的边界（不要把结论说过头）

1. **「无新 turn」的观测有一处不可完全排除**：理论上宿主可能开了新 turn 却什么也不做、也不回调任何工具。本次的判据是「会话里没有出现非用户触发的 turn + 探针无新入站请求 + 界面无新动作（用户侧观察）」，三者一致；但严格说，仍是**行为层证据**而非宿主日志证据。
2. **`client_capabilities: {}` 是协议层直接读取，不受第 1 条影响**：sampling 不可用这一条是硬的，即使前一条存疑也独立成立。
3. **`mcp.json` 已在复测后被删除**：探针当前只活在内存里（pid 91193），**下次重启 Trae 该 server 即消失**。探针与 prompt 都在仓库（`scripts/probes/`、`docs/diagnostics/probe-prompt-for-trae.md`），可随时重跑；要长期保留需重新写回配置。
4. **两个宿主侧参数坑（与结论无关，但会卡住复跑）**：
   - 直接调用时 `delay_ms` 传数字被宿主转成字符串，报 `MCP error -32602: Input validation error: Expected number, received string`；同参数重试一次即成功（推测为宿主转发层的序列化差异，未定位）。
   - 在 `integrated_code_mode` 的 `Exec` 里嵌套调 `run_mcp`，一律报 `MCP server is not found` —— 嵌套上下文看不到本 session 注册的 server，**探针必须从顶层调用**。
