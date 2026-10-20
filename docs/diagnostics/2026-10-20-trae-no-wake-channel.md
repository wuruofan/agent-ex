# Trae 无后台唤醒通道 —— 会话内等待与自主 loop 的宿主前提

**文档编号**：2026-10-20-trae-no-wake-channel
**状态**：✅ **已实测定位**（2026-10-20）。结论：Trae **没有**「后台进程完成 → 自动开启新 turn」这条通道；`wait-task` 装备本身在 Trae 下**完整可用**，缺的只有唤醒那一段。
**文档类型**：`docs/diagnostics/`（与 `2026-08-29-trae-mcp-visibility.md`、`2026-10-16-readonly-sandbox.md` 同族：宿主行为 + 探针取证）
**关联**：`skills/agent-ex-dispatch/SKILL.md`「会话内定时等待与自主推进 loop」一节 —— 该节此前默认宿主具备唤醒能力，本文给出反例。

---

## 1. 一句话结论

**Trae 的通知只在「有活跃 turn」时递送；turn 一空闲，后台进程的完成事件就停摆，直到下一次有人说话才被捎带送达。** 因此 `SKILL.md` 里「后台起 `wait-task` → 被唤醒继续」这条链路在 Trae 下**会断在唤醒那一步**：进程活着、任务也真的跑完了，但没有任何东西会主动叫醒 agent。

同一批探针同时确认了两件**成立**的事，避免把结论下得过宽：

| 命题 | 实测结果 |
| :--- | :--- |
| Trae 下后台进程能长时间存活、不受 600s 约束 | ✅ 成立（见 P2/P4） |
| Trae 下前台阻塞 ≤600s 能拿到结果并续在同一 turn | ✅ 成立（见 P3） |
| `wait-task.mjs` 在 Trae 下能读库并提取报告 | ✅ 完整可用（见 P5/P6） |
| Trae 后台完成事件能主动唤醒 agent | ❌ **不成立**（见 P2），这是本次唯一的否定结论 |

---

## 2. 触发

用户观察到「后台 `wait-task` 跑完后 agent 没有新 turn」，提问两件事：要不要在 skill 里明确「可能需要前台等待」；以及 skill 里有没有写 loop 的多轮交互方式。

先查文档现状：loop 是**写了**的，而且是一套完整协议（`SKILL.md:295-304`「自主推进 loop 协议（9/28 定稿：升级制闸门）」），但它把循环动力完整地押在唤醒上：

```
SKILL.md:298  Loop 一步 = Step 1 并发检查 → Step 3 submit → 后台 wait-task → 被唤醒走上面 1–4 步 → 回到 Step 1
```

以及 `SKILL.md:247`「以 `run_in_background` 方式启动，**不要**前台跑」、`SKILL.md:256`「进程在『终态 或 需要我』时退出 → **自动唤醒我**（后台任务完成会通知）」。这三处**都假定唤醒存在**。所以问题不是「skill 没写 loop」，而是「loop 的引擎在 Trae 上不存在」。

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

`SKILL.md:252` 那条「工具层」结论在 Trae 下**仍然成立**，甚至被 P4 逐字验证：后台进程的寿命由它自己决定，工具层不介入；**前台调用才受 timeout 约束，超时会自动转后台而不是被杀**（P4 的 `timed_out_moved_to_background` 就是这句的字面实现）。

问题出在另一头：**递送**。Trae 的完成通知挂靠在**对话轮次**上，而不是挂靠在进程上。于是：

- 有活跃 turn → 事件能挤进来（P1）；
- 无活跃 turn → 事件无处可投递，等到下一次有人说话（P2）。

⇒ 这条通道**不是一个「等待器」，只是一个「回执」**。它无法承担 loop 里「等终态 → 继续」的驱动职责。

---

## 5. 对 `SKILL.md` 的影响（**已列出，本文未改**）

以下三处是**假定的宿主能力**在 Trae 上失效，本文只记录，**未改动 skill**（等用户决定方案）：

| 位置 | 现文 | 问题 |
| :--- | :--- | :--- |
| `SKILL.md:247` | 「以 `run_in_background` 方式启动，**不要**前台跑」 | 在 Trae 下是**反的**建议：后台起得到的是「不会闭环」，前台 ≤600s 反而能闭环（P3） |
| `SKILL.md:256` | 「进程在终态或需要我时退出 → **自动唤醒我**（后台任务完成会通知）」 | Trae 下不成立（P2） |
| `SKILL.md:295-304`、`286`、`298` | loop 协议与「被唤醒后必须走的流程」 | 协议本身没问题，但**引擎缺席** ⇒ 在 Trae 退化为「用户手动回来查一次、跑一个任务」，不再是自主 loop |

**候选修法（未实施，三种不互斥）**：

1. **加一节「宿主唤醒语义差异」**：`run_in_background`（Claude Code / WorkBuddy，真唤醒）vs Trae（假唤醒，需人工触发每一轮）。以本文探针为据。
2. **改 247**：改成按宿主分档 —— 前台阻塞 ≤600s 可作**短任务兜底**；超过即自动转后台，等于没等。
3. **给 loop 补降级路径**：Trae 下显式声明「loop 需人工触发每一轮」，或退回**定时巡检**（`docs/diagnostics/2026-08-29-trae-retest.md` §0.2 的 Schedule 路线，10 分钟粒度、会话无记忆）。注意该路线唤醒的是**新会话**，拿不到本会话上下文，与本 loop 的取舍不同。

> 不采用「把复核/唤醒外包给 subagent」这类绕法：loop 的价值恰恰在唤醒时**带着前序任务事实 + 当前 plan 约束 + 用户期间发言**回来判断（`SKILL.md:284`），换会话或换执行者都会把这块丢掉。

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

1. **唤醒语义的正面清单未做**：Claude Code / WorkBuddy 侧「后台完成 → 真唤醒」是既有实测结论（`SKILL.md:252` 一带），本文**未复测**，只确认了 Trae 一侧的反例。
2. **`RunCommand` 被拒的根因未定位**：需要宿主侧配置证据，属另一条线索（与 `2026-08-29-trae-mcp-visibility.md` 的 MCP 透传问题可能同源）。
3. **端到端联调缺失**：`mcp_agent-ex` 不可见，故本次是「submit 由 MCP」+「等待由脚本」两条腿里**只验了后一条**。
4. **`SKILL.md` 未改**：第 5 节的三处候选修法等用户拍板；改法与本文一并提交会混淆「取证」与「改规范」两件事。
