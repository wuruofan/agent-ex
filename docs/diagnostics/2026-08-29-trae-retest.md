# Trae 调度员回测操作手册

**状态**：✅ **已回测通过（2026-10-10）**。结论见 §0 追加。下方 2–5 节保留为**重跑时的操作手册**。

> **历史无效轮次**：2026-08-29 22:52–23:00 那轮回测无效——当时 Trae 的 MCP 客户端已在 11:56:19 断连且不会自动重连（见 `2026-08-29-trae-mcp-visibility.md` §3），那轮是在**客户端已死**的状态下测的，新 prompt 从未被真正检验。据此得出的「Trae 出局」结论**已撤回**。

---

## 0. 2026-10-10 回测结果（当前有效结论）

**结论：Trae Schedule ✅ 可用，10 分钟粒度成立，MCP 工具在 tick 新会话里初始即可见。**

| 项 | 值 |
| :--- | :--- |
| Schedule ID | `94b4f694`（`agent-flow 调度员`，Active，cron `*/10 * * * *`，tz `Asia/Shanghai`） |
| 前置代码 | `f2eb264`（已重新 `npm run build`，`dist/server.js` 时间戳 10-09 17:27） |
| 主会话 MCP | 健康：`agent_flow_version` → `gitSha: f2eb264` |

### 0.1 判别方法：**探针法**，不信自报

调度员自报「idle」几乎没有信息量——它可能只是在复述 prompt。真正有判别力的是**它是否真的改变了 store**。

**做法**：往 `tasks.db` 直接 INSERT 一个虚构任务，构造���命中步骤 3 收割条件的字段：

```sh
NOW=$(date +%s)
sqlite3 ~/.agent-flow-ex/tasks.db <<SQL
INSERT INTO tasks (id,status,prompt,project_path,executor,profile,timeout_sec,
  session_id,rounds,result,question,progress,files_changed,pid,error,log_path,role,
  created_at,started_at,ended_at,notify_failed)
VALUES ('probe-trae-mcp-turn-test','running','探针：非真实任务…','/x','claude','default',
  60,NULL,1,NULL,NULL,NULL,'[]',NULL,NULL,'/tmp/probe-nonexistent.jsonl','worker',
  $NOW,$((NOW-1000)),NULL,0);
SQL
```

`status=running` + `timeout_sec=60` + `elapsed≈1000` ⇒ `1000 > 2×60`，正落在步骤 3 的收割条件里。

然后 `trigger` 一次并轮询 `status`：

```sh
for i in 1 2 3 4 5 6; do sleep 30
  sqlite3 ~/.agent-flow-ex/tasks.db \
    "select status from tasks where id='probe-trae-mcp-turn-test';"; done
```

**实测**：09:39:45 手动 trigger → **09:40:20（35s 内）** 探针已变 `cancelled`。唯一可能的写入来源就是这个 tick 调了 `agent_flow_cancel`。

**为什么这个判据强**：自然 tick（09:40:00）还没到，且本会话主 agent 全程未调用 `cancel`；状态变化只能来自那个 tick。⇒ 同时证明了「工具拿到了」「调用成功了」「MCP→store 链路通」三件事。

**收尾**：探针是虚构任务，取消无副作用，但仍须 `DELETE FROM tasks WHERE id='probe-…';` 清理（实测清理后活跃任务数为 0）。

### 0.2 三个反直觉发现

1. **Trae 的工具可见性与 WorkBuddy 相反**：`agent_flow_*` 在 tick 新会话的**初始工具列表里直接可见**，步骤 0 的 a 分支一次命中，不需要 `ToolSearch`。所以 §2 Step 5 那条「失败 → 去开『自动运行 MCP』」**对本轮不适用**——它开不开都不影响结果。
2. **不必先点 MCP 面板重连**：文档反复强调的「server 被 kill 后客户端不自愈」是**另一条故障**（`visibility.md` §11）。本轮主会话 MCP 一直健康（build 后仍能调 `agent_flow_version`），tick 也就正常。⇒ **先验证 MCP 是否真的活着，再决定要不要走重连流程**，否则会把「客户端本来就是好的」误判成「需要重连」。
3. **定时任务不是唯一选择，且不一定是最好的**：`skills/agent-flow-dispatch/scripts/wait-task.mjs` 在 Trae 下同样可用（2026-10-10 实测 exit 0 / `WAIT=terminal` / `ELAPSED_SEC=25` / `REPORT_TEXT=PONG`）。它只依赖 node 内置模块、直连 SQLite **只读**、完全不碰 MCP，所以与宿主无关；派发后起一个后台进程即可，**不需要任何确认弹窗**，而且唤醒的是**原会话**（上下文完整）。

   ⇒ **两条路线怎么选**：

   | | 定时巡检（Schedule） | wait-task.mjs |
   | :--- | :--- | :--- |
   | 需要确认 | 创建时要点 | ❌ 不用 |
   | 醒来后是谁 | 全新会话，无记忆 | **原会话**，上下文完整 |
   | 能做什么 | 只能按 prompt 机械判断 | 能按 plan 真实意图复核 |
   | 适合 | 完全无人值守（人睡觉时收割 needs_input / 孤儿） | 守着特定任务直到收尾 |

   2026-10-10 决策：本机不再常驻定时任务，走 wait-task 路线。

---

## 1. 本地已核对、无需你改的项

别浪费时间在这些上面，我都查过了：

| 项 | 状态 |
| :--- | :--- |
| MCP server 配置 `~/Library/Application Support/TRAE SOLO CN/User/mcp.json` | ✅ 已正确注册 agent-flow-ex，**不用动** |
| agent-flow-ex 代码 | ✅ 0 改动 |
| 调度员 prompt 除「步骤 0」外的部分 | ✅ 与 WorkBuddy 完全一致 |
| Schedule 的本地文件 | ❌ **不存在**——Schedule 存云端，只能走 `Schedule` 工具 |

> ⚠️ **2026-10-10 更正一条会误导人的旧说法**：本目录早前记着「`~/.trae-cn/` 是 7/30 起停更的旧版 Trae CN，别在那边找」。
> 那条**只对 MCP 注册表成立**（在用的 `TRAE SOLO CN` 从 `~/Library/Application Support/TRAE SOLO CN/User/mcp.json` 读），
> **但 `~/.trae-cn/` 恰恰是当前在用的 Trae 的用户级 skills 目录**——本仓库 skill 的软链就装在那里
> （`~/.trae-cn/skills/agent-flow-dispatch → <repo>/skills/agent-flow-dispatch`），2026-10-10 实测加载正常。
> ⇒ 装 skill 用 `~/.trae-cn/skills`；查 MCP 注册表才去 `TRAE SOLO CN/User/`。两件事别混。

---

## 2. 操作步骤

### Step 1 · 确认 Schedule 还在不在（1 分钟）

用 `Schedule` 工具（`action: "list"`）列出现有任务，找 `agent-flow 调度员`：

- **还在、且是 Paused** → 直接 Step 2
- **还在、且是 Active** → 先 Pause，再 Step 2（避免改 message 期间它自己触发）
- **已经不在了**（2026-10-10 实测就是这个状态：历史 `8a989934` 已不存在）→ 新建一个：
  - `name`：`agent-flow 调度员`
  - `cron_expression`：`*/10 * * * *`
  - `timezone`：`Asia/Shanghai`
  - `message`：Step 2 的全文

> ⚠️ **创建/修改都要点确认弹窗**（2026-10-10 连续撞了 3 次 10 分钟超时）。但**只有创建那一次要**——
> 之后每 10 分钟的 tick 自己跑，无人参与（实测自然 tick 于 09:51:26 自行触发，`Executions` 3→4）。

### Step 2 · 把 message 换成下面这段（务必整段替换）

关键点在**步骤 0**。旧版 prompt 少了这一步——这正是疑似失败原因。

```
你是 agent-flow-ex 的调度员。工作区：/Users/meow/workspace/agent-flow-ex。
任务状态只用 agent_flow_* 工具变更；允许只读工作区文件（含 question 引用的 docs/problems/*.md，用于核对上下文）；
禁止写文件、禁止 git、禁止直接读写 ~/.agent-flow-ex/tasks.db。
若本轮无任何可行动作，回复「idle」即结束，不要多做。

步骤：
0. 工具获取（必做，不可跳过）：agent_flow_* 是 MCP 工具，可能不在你的初始工具列表里。
   禁止仅凭"初始工具列表里看不到"就判定工具不存在——这是本任务最常见的失败模式。
   按序尝试：
   a. 直接调用 agent_flow_status()（不带参数）。成功则跳到步骤 1。
   b. 若报"无此工具"，用你可用的工具发现/搜索能力查找含 "agent_flow" 的工具并加载，再重新调用。
   c. 若仍拿不到，回复「tools unavailable」并列出你尝试过的具体方式，然后结束。
      不要猜测、不要改文件、不要尝试其他替代手段。
1. 调用 agent_flow_status()（不带参数），获取所有活跃任务（queued/running/needs_input）。
2. 对每个 needs_input 任务（单次最多处理 3 个）：
   a. 读该任务 question；需要时可只读 question 指向的 docs/problems/*.md 或相关文件取上下文。
   b. 仅当 question 属「机械/事实/配置类」且你能从现有代码/上下文确知答案时才代答；
      涉及方向选择、破坏性操作、需求歧义、rounds>=3、或你不确定的，一律不猜，保留待人工（飞书已推送）。
   c. 可代答时 agent_flow_submit(continue_of=<task_id>, prompt=<简短明确可直接执行的答案>)。
3. 对 status=running 且 elapsed_sec > 2×timeout_sec 的任务：agent_flow_cancel(task_id=...)（孤儿/卡死收割）。
4. 其他不操作；处理完结束。
约束：单次最多 3 个 needs_input；不对同一 task_id 重复 submit；rounds>=3 不代答；不确定就不代答。

最后用一句话报告本轮结果（idle / 处理了哪些 task_id / tools unavailable），不要写任何文件。
```

### Step 3 · trigger 一次，然后看**它说了什么**

判定不看「成功/失败」，看**调度员报告的具体内容**：

| 报告内容 | 结论 | 下一步 |
| :--- | :--- | :--- |
| `idle` / 列出了活跃任务 | ✅ **Trae 复活** | Step 4 |
| `tools unavailable` + 列出尝试过的方式 | ❌ 步骤 0 三分支都走不通 | Step 5 |
| 直接说「No agent_flow_* tools available」且**没提尝试过什么** | ❌ prompt 没生效 | 检查 message 是否整段替换成功 |

> **「没提尝试过什么」是重要信号**：说明步骤 0 根本没被执行（message 没换成功），而不是平台问题。

### Step 4 · 成功 → 迁回 Trae

1. 让 Schedule 保持 Active，观察 2–3 个自然 tick（20–30 分钟），确认守时。
2. 确认无问题后，WorkBuddy 的 `automation-1788012019991` 保持 PAUSED 即可（配置已保留，随时可恢复，作为已验证的备用）。
3. 更新 spec §3 / §5 / §11：派发方改回 Trae，WorkBuddy 降为备选。

### Step 5 · 失败 → 开「自动运行 MCP」

1. Trae **设置 → 对话流（Work）→ 自动运行 MCP**，打开。
2. 重启 Trae（让 MCP server 重新加载）。
3. 再 `trigger` 一次。
   - 通了 → 走 Step 4
   - 仍不通 → **Trae 出局**，保持 WorkBuddy 现状（1 小时粒度，但已验证可靠），把结论补进 spec。

---

## 3. 回测时要注意的两件事

1. **不要先去点「自动运行 MCP」开关**。先换 prompt trigger 一次——这样才能分清是「prompt 缺步骤 0」还是「平台不给工具」。先点开关的话，即使生效你也分不清是开关起作用还是 Trae 重启起作用，信息量为零。
2. **WorkBuddy 的调度员已暂停**（`automation-1788012019991`，`FREQ=HOURLY`，2026-08-29 22:41 置 PAUSED），回测期间不会来抢任务、结果不会混淆。配置保留，随时可恢复——恢复只需把 `status` 改回 `ACTIVE`。

   > 即便两边同时跑也不会互相踩坏：`submit(continue_of=)` 有原子校验，先到先得、后到返错。暂停纯粹是为了让回测结果干净。

---

## 4. 2026-08-29 22:52–23:00 实测补充（Trae 侧诊断 + 我方复核）

Trae 侧连跑数轮，产出 `dispatcher-reports/dispatcher-1788015*.md`。我方对其结论**逐条复核**，结论有取有舍。

### 4.1 采信的部分

| 项 | 证据 |
| :--- | :--- |
| MCP 注册表正确 | `TRAE SOLO CN/User/mcp.json` 含 `agent-flow-ex`，路径真实 |
| server 健康 | 手动 spawn + `initialize` 握手返回合规，38 小时内主会话调用全部 `code:0` |
| Schedule 子会话拿不到工具 | `Extension <name> not found`，七种名字全试过 |

### 4.2 **不采信**：`serverNames:[]` 不是原因

Trae 报告称「`updatePluginMcpConfigs` 一直 `serverNames:[]` → Schedule 没绑定任何 MCP」，并据此建议「在 Schedule 里显式绑定 MCP」。

**复核结果：该论据不成立。**

```
$ grep -o '"serverNames":\[[^]]*\]' mcp-servers-render.log | sort | uniq -c
    205 "serverNames":[]
```

205 条，**从 2026-08-27 21:42:39 到 2026-08-29 22:58:20 从未非空**——包括 08-29 上午 09:15–11:45 主会话调用全部成功（`code:0`）的那段时间。

→ `[PluginMcp]` 这条通道**本来就是空的，且与故障无关**。它是条无关通道，不是原因。照「在 Schedule 里显式绑定」去做，大概率白费。

### 4.3 「自动运行 MCP」是许可开关，不是注入开关

用户推测该开关已开、MCP 应有权限。磁盘核查：

- `updatePluginMcpConfigs` 里 `"enabled": true`（205 条恒为 true）→ 许可**确实给了**
- 同一条记录里 `serverNames: []` → 但**供给是空的**

**给空集合授权，结果仍是空集。** 「有权限」与「有东西可跑」是两件事。

另：该开关的实际取值在磁盘上**查不到**（`state.vscdb` 100 个 key 只有 `ai.config.autoRun.migration.*` 迁移标记；`User/settings.json`、`storage.json`、`SharedStorage` 均无），大概率存账号侧。**需人工在 UI 确认：设置 → 对话流（Work）→ 自动运行 MCP 是否为开。**

- 已经开着 → 它只是许可开关，与本故障无关，**Trae 出局**
- 其实没开 → 还有救，开了再 trigger 一次

### 4.4 存在但**不建议**的兜底：Bash 直连 MCP（stdio）

Schedule 子会话有 `RunCommand`，且 node 绝对路径可用。实测纯 shell 可绕过 MCP 注入：

```sh
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"sh","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_flow_status","arguments":{}}}' \
 | /Users/meow/.nvm/versions/node/v24.18.0/bin/node \
   /Users/meow/workspace/agent-flow-ex/dist/server.js
```

→ 返回 `[]`，不需要任何 MCP 客户端。**技术上可行。**

**但建议不采用**：它会让 Trae 版 prompt 与 WorkBuddy 版分叉，破坏「prompt 即规约 / 派发方可替换」这条不变量——那正是本设计最值钱的部分。为 6 倍粒度优势换掉它不划算。

**若 1 小时粒度确实不可接受**，更干净的是 spec §5.4 的 launchd 路线（系统级 cron，10 分钟 + 纯脚本轮询器），它不污染 prompt。

---

## 4. 结果回填

回测完请把结论写进 spec（`docs/superpowers/specs/2026-08-29-self-loop-design.md`）：

- §3 派发方能力矩阵：Trae 行的「进程内 MCP 可见性」
- §7 V2：10 分钟粒度是否守时
- §11.1：派发方最终选型
