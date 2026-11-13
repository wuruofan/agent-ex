# 超时归因设计：把「疑似原因」带回主 agent

**文档编号**：2026-11-13-timeout-attribution
**状态**：定稿（2026-11-13 用户确认：载体=DB 新列 + stdout 新行；计算点=Executor 可选钩子；分类=3 类 + 证据 + 置信措辞；profile 轮换=只做归因，换 profile 由主 agent 决定）
**最后更新**：2026-11-13
**目标版本**：0.6.0（当前 0.5.0）
**相关代码**：`src/runner.ts`、`src/store.ts`、`src/wait.ts`、`src/tools/status.ts`、`src/notifier.ts`、`src/executors/types.ts`、`src/executors/opencode.ts`、`src/executors/claude.ts`、`src/report.ts`

---

## 1. 动机

### 1.1 真实故障：两个超时任务，DB 里长得一模一样

2026-11-12 连续两个任务在 motelet 仓库超时，飞书卡片都写着 `timeout after 900s (round 1)`：

| task_id | resolved_model | prompt 字符 | text 事件 | tool 调用 | 结局 |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `task_mwd8blbh_30d0a9` | `opencode/mimo-v2.6-flash-free` | 2975 | **0** | 43 | ❌ 900s |
| `task_mwd8wcv4_e1009f` | `opencode/mimo-v2.6-flash-free` | 2301 | **0** | 8 | ❌ 1800s |

而 DB 的 `error` 字段只留下 `timeout after 900s (round 1)`——**没有任何信息告诉主 agent「为什么挂」**，主 agent 只能自己去翻 `~/.agent-ex/logs/*.jsonl` 做人工考古，或者干脆盲目重派（很可能再挂一次）。

### 1.2 人工考古后的结论：两种完全不同的故障

把 10 个真实任务的 runner log 逐个统计后，故障分成两类，处置方式**互相矛盾**：

| 归因 | 日志指纹 | 正确处置 |
| :--- | :--- | :--- |
| **接口空转**（provider 不回包） | `step_finish.tokens` 全 0 + `reason≠stop` + 相邻步间隔 ≈300s | **换 profile / 换模型重派**同一工单（任务本身没问题） |
| **模型不落笔**（只吐工具调用） | 步间隔正常（<210s）、`tokens.output` 低但非 0、tool 调用持续增长、**text 事件数 = 0** | **缩工单**（少问几问 / 限工具次数）或换模型（原工单原样重派会再挂） |

对照数据（同时证明「任务复杂」不是主因）：

| task_id | resolved_model | prompt 字符 | text | tool | 结局 |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `task_mwbma3x0_1e13ea` | `opencode/deepseek-v4.1-flash-free` | **6813** | 2 | 43 | ✅ |
| `task_mwblg4dr_c07d0e` | `opencode/deepseek-v4.1-flash-free` | 6788 | 2 | 71 | ✅ |
| `task_mwbn2vyp_8a661d` | `opencode/deepseek-v4.1-flash-free` | 2214 | 1 | 46 | ✅ |
| `task_mwd8wcv4_e1009f` | `opencode/mimo-v2.6-flash-free` | **2301** | 0 | 8 | ❌ 1800s |
| `task_mwd8blbh_30d0a9` | `opencode/mimo-v2.6-flash-free` | 2975 | 0 | 43 | ❌ 900s |

⇒ 同类工单，deepseek 全部一次成功出报告；mimo 全部 0 text 挂死，其中一个的 prompt 只有 2301 字符（比成功的 6813 字符短三分之二）。**决定性变量是模型，不是工单长度。**

### 1.3 目标

1. runner 层超时时，把**推测出的原因 + 支撑证据**落库，并经 `agent-ex wait` stdout / `agent_ex_status` / 飞书卡片三处暴露给主 agent。
2. 主 agent 拿到归因后，**不翻 log** 就能决定：换 profile 重派 / 缩工单 / 放弃。
3. **事实与推测严格分离**：既有 `error` 契约一个字不改；归因是独立字段、独立行、措辞带「疑似」。
4. 归因能力做成 **executor 侧可选钩子**：没实现的 executor 行为与今天完全一致（零变化、可回退）。

### 1.4 非目标

- **不**自动重试、**不**自动换模型、**不**自动换 profile。决策权在主 agent（它有 plan 上下文，runner 没有）。
- **不**改 `agent_ex_submit` 的参数契约（不加 `fallback_profiles` 之类）。
- **不**动 zen-free 内部「同一 profile 内换模型」的既有机制（`src/zen-free.ts` 的排除集），那是另一层的事。
- **不**把归因当事实断言。归因是启发式推断，证据串必须同时给出，让人能自己复核。

---

## 2. 数据模型

`tasks` 表新增两列。`src/store.ts` 的 `COLUMNS` 是建表与迁移的同一份真相，加列即自动 `ALTER TABLE` 补齐旧库（`migrateColumns()` 按 `pragma table_info` 求差集）。

| 列 | 类型 | 取值 | 说明 |
| :--- | :--- | :--- | :--- |
| `cause` | `TEXT`（默认 NULL） | `api_hang` / `no_text` / `slow_progress` / `unknown` | 归因标签 |
| `cause_evidence` | `TEXT`（默认 NULL） | 自由文本 | 人机皆可读的证据串 |

约束与语义：

- **不加 `NOT NULL` / `CHECK`**：SQLite 的 `ADD COLUMN` 不支持无默认值的 `NOT NULL`，加了会让旧库迁移失败（`store.ts` 的注释已记录该限制）。
- **值域用下划线**：跟随现有 stdout 风格（`WAIT=needs_input`、`WAIT=db_unreadable`），不用连字符。
- **NULL ≠ unknown**：
  - `NULL` = **没有归因结果**：executor 未实现 `classifyLog`，或实现了但 log 不可读（返回 `null`）⇒ DB 保持原样；
  - `unknown` = 参与了归因但**没匹配上任何判据**（证据串会说明）。
- 值域的**唯一真相源**是代码里的 `TimeoutCause` 联合类型；DB 不加 CHECK 约束（避免迁移风险），由代码保证写入合法值。

---

## 3. 计算点：Executor 可选钩子

### 3.1 为什么放在 executor 侧

日志格式是 **executor 的私有知识**：

- opencode 的 `step_finish.part.tokens` / `part.reason` 只在 `src/executors/opencode.ts` 里被认识；
- claude 的 `{"type":"assistant","message":{"role":"assistant","content":[…]}}` 形状在 `src/executors/claude.ts` 与 `src/report.ts` 里被认识。

把扫描逻辑放进 runner ⇒ runner 必须认识两种 CLI 的私有格式 ⇒ 分层破口。所以**判定归 executor，调用归 runner**。

### 3.2 契约

```ts
// src/executors/types.ts
export type TimeoutCause = "api_hang" | "no_text" | "slow_progress" | "unknown";

export interface CauseVerdict {
  cause: TimeoutCause;
  evidence: string;
}

export interface Executor {
  // …现有成员…
  /**
   * 可选：把 runner log 归因成超时原因（**推测**，非事实）。
   *
   * 不实现 = 该 executor 不参与归因 ⇒ cause 留 NULL，行为与今天完全一致。
   * 返回 null = 参与归因但拿不到证据（log 不存在/读不了）⇒ 同样留 NULL。
   */
  classifyLog?(logPath: string): CauseVerdict | null;
}
```

**可选是硬要求**：它保证了这个特性可以逐个 executor 落地，任何一步没做完，系统其余部分都不受影响。

### 3.3 共享模块

新建 `src/timeout-cause.ts`，只放**跨 executor 的公共部分**：

- `TimeoutCause` / `CauseVerdict` 类型定义（供 executor 与 runner 共用，避免两处各写一份字面量）；
- `readLogLines(logPath): string[]`——读文件、按行切、跳过坏行（沿用 `src/report.ts` 的容错姿势：只处理以 `{` 开头的行，坏 JSON 直接跳过）；
- `assistantTextsOf(ev)`——**复用 `src/report.ts` 的 `assistantTexts`**（把那个函数 `export` 出来），保证「什么算模型写的文本」在报告提取与归因判定里是**同一份真相**，不会两处漂移。

各 executor 的 `classifyLog` 自己实现判据，只用共享模块提供的行读取与文本形状知识。

---

## 4. 判据

### 4.1 opencode

runner log 里存的是 **CLI 原始 stdout 行**（`runner.ts` 的 `rl.on("line")` 把每行原样写进 log），外加 runner 自己写的 `user_prompt` / `_runner` 行——扫描时必须跳过非 CLI 行。

opencode 的相关事件形状：

```jsonc
{"type":"step_start","timestamp":1794469685561,"part":{…}}
{"type":"tool_use","timestamp":1794469683945,"part":{"type":"tool","tool":"bash","state":{"status":"completed",…}}}
{"type":"text","timestamp":…, "part":{"text":"…"}}
{"type":"step_finish","timestamp":…,"part":{"reason":"tool-calls|stop|unknown","tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}}
```

**「空转步」定义**：`step_finish` 且 `tokens.output === 0 && tokens.input === 0 && tokens.reasoning === 0 && (tokens.cache?.read ?? 0) === 0`——请求既没拿到上下文，也没产出任何东西。

判定（**自上而下，命中即返回**）：

1. **`api_hang`**：空转步 **≥ 2 个**，且**按 timestamp 排序后相邻两个空转步的间隔最大值 ≥ 60s**（中间是否夹着别的步不影响，只要两个空转步挨得近就不算挂死）。
   证据：`5 zero-token steps; gaps 305s/307s/310s`（gaps 取上述相邻间隔中最大的 3 个，超出用 `…`）。
2. **`no_text`**：全 log 的 text 事件数 **= 0** 且 tool 调用 **≥ 3** 次。
   证据：`0 text parts; 43 tool calls; last out 162 tok`。
3. **`slow_progress`**：text 事件数 **≥ 1**（模型在写，只是没在时限内收敛）。
   证据：`1 text part; 71 tool calls; last step 210s ago`。
4. **`unknown`**：以上都不匹配。
   证据：`log has 2 events, no usable signal`。

**为什么 `api_hang` 排在 `no_text` 前面**：`task_mwd8wcv4_e1009f` 同时满足「0 text」和「零 token 空转」两条。两条都成立时，「换 provider / 换模型」比「缩工单」更可操作（工单已经收窄过了，再缩是过度反应）。

**已知局限（写进文档，不藏）**：只有**一个**空转步时不足以判定 `api_hang`，会落到 `no_text`。此时证据串里的 `last out 0 tok` 会暴露异常，主 agent 可据此改判。

### 4.2 claude

claude 的 CLI 事件形状（`{"type":"assistant",…}` / `{"type":"result",…}` / `{"type":"system","subtype":"api_retry|api_error",…}`）与 opencode 完全不同，**没有** `step_finish.tokens`，精度天然低一档。

| 归因 | 判据 | 证据示例 |
| :--- | :--- | :--- |
| `api_hang` | 存在 `system` 事件且 `subtype ∈ {api_retry, api_error}`；或**最后一个 assistant 事件的 timestamp 与 log 中最后一个事件的 timestamp 之差 ≥ 120s**，且全程没有 `result` 事件 | `3 api_retry/api_error events` / `last assistant 210s before end, no result event` |
| `no_text` | assistant 事件的 `message.content[]` 里**没有任何 text block**（只有 tool_use），且 assistant 事件数 ≥3 | `0 text blocks in 5 assistant events` |
| `slow_progress` | 至少一个 assistant 事件含 text block | `2 text blocks in 5 assistant events` |
| `unknown` | 其余（含 assistant 事件数 <3 且无 api 错误信号） | `no usable signal in 4 events` |

「什么算 text block」复用 `src/report.ts` 的 `assistantTexts`（claude 分支），与报告提取同源。

### 4.3 措辞纪律

`cause` 是**推测**，不是事实。落到人可见面（飞书卡）时：

- 用「**疑似原因**」，不用「原因是」「接口挂了」；
- 必须同时给出证据串，让人能自己复核；
- claude 侧精度低一档 ⇒ 证据串里明确写出依据（如 `no usable signal in 4 events`）。

---

## 5. 数据流

```
runner 判定超时
   │
   ├─ child.on("close") → log.end()          ← 日志此时已落盘完整
   │
   ├─ executor.classifyLog(task.log_path)    ← 此刻读 log 安全
   │     └─ 没实现 / 返回 null ⇒ cause 保持 NULL
   │
   ├─ store.transition(task.id, ["running"], "failed",
   │      { error: "timeout after 900s (round 1)",
   │        cause, cause_evidence })
   │
   └─ finalize → 飞书卡片 detail = 事实行 + 「疑似原因」行
                    │
                    ▼
              tasks.db（单一真相）
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
 wait stdout    status MCP     飞书卡片
 CAUSE=         cause?         疑似原因：…
 CAUSE_EVIDENCE=
```

**时序安全点**：`log.end()` 在 `child.on("close")` 回调里同步调用（`runner.ts`），`finalize` 在其后 ⇒ 扫描时文件已完整，不会读到半截行。

**只归因 runner 层超时**：`timedOut === true` 时才调 `classifyLog`。其它失败路径（`resultIsError`、exit code ≠ 0）的 `error` 里已经有 `stderrTail` 或退出码这类明确信息，不需要推测；`needs_input` 不是失败。

---

## 6. `agent-ex wait` stdout 契约

新增两行，紧跟 `ERROR=` 之后：

```
TASK_ID=task_mwd8blbh_30d0a9
STATUS=failed
WAIT=terminal
MAX_WAIT_SEC=2910
ELAPSED_SEC=905
FILES_CHANGED=0
ERROR=timeout after 900s (round 1)
CAUSE=api_hang
CAUSE_EVIDENCE=5 zero-token steps; gaps 305s/307s/310s
LOG_PATH=/Users/…/task_mwd8blbh_30d0a9.jsonl
REPORT_PATH=/tmp/task_mwd8blbh_30d0a9.report.md
REPORT_CHARS=0
```

规则：

- **`ERROR=` 行内容一字不改**（既有解析不破）。
- `CAUSE=` / `CAUSE_EVIDENCE=` **有值才输出**——与 `QUESTION=`、`DB_SOURCE=copy` 的既有惯例一致：没归因能力 / 非超时失败 / wait 层超时（`WAIT=timeout`，任务还在 running）⇒ **不出现这两行**。
- `CAUSE_EVIDENCE=` 的值原样透传（可能含空格与 `;`），主 agent 整行取。
- 顺序不变式：`ERROR=` 之后、`LOG_PATH=` 之前。

---

## 7. `agent_ex_status`（MCP）

`src/tools/status.ts` 的 `TaskView` 增加两个**可选**字段，有值才带（与 `error` 的处理方式一致）：

```ts
export interface TaskView {
  // …现有字段…
  error?: string;
  cause?: string;            // api_hang | no_text | slow_progress | unknown
  cause_evidence?: string;
}
```

单任务查询与列表两种形态都返回（列表走同一套字段映射）。

---

## 8. 飞书卡片

卡片 detail（`buildFeishuCard` 的第 3 个参数）在 `failed` 且有归因时，追加一行：

```
timeout after 900s (round 1)
疑似原因：模型未产出文本（0 text parts; 43 tool calls; last out 162 tok）
```

标签的中文映射（`cause` → 卡片措辞）：

| `cause` | 卡片措辞 |
| :--- | :--- |
| `api_hang` | 模型接口空转 |
| `no_text` | 模型未产出文本 |
| `slow_progress` | 有产出但未在时限内收敛 |
| `unknown` | 无法归因 |

**卡片结构不变**：`buildFeishuCard(status, taskId, detail, keyword, meta)` 的签名与 schema 都不动，只是 `detail` 字符串多一行。

---

## 9. 主 agent 的决策规则（写进 dispatch skill）

这是本特性真正产生价值的地方——归因是给**主 agent**用的输入，skill 必须写清楚「拿到什么就做什么」。

在 `skills/agent-ex-dispatch/SKILL.md` 的「终态到手后必须走的流程」第 1 步（`WAIT=` 分支）下新增：

| `CAUSE=` | 含义（**推测**） | 主 agent 该做什么 |
| :--- | :--- | :--- |
| `api_hang` | provider 侧空转，**不是任务问题** | **换 profile 重派同一工单**（`agent-ex profile list` 看有哪些可用 profile），**不要**缩工单 |
| `no_text` | 模型在跑但不落笔 | **缩工单**（少问几问 / 限工具调用次数）**或**换模型；原工单原样重派大概率再挂 |
| `slow_progress` | 在产出，只是没在时限内收敛 | 加 `timeout_sec` 或把任务拆小 |
| 无 `CAUSE=` 行 | 老 executor / 非超时失败 | 回到今天的默认处置（以 `ERROR=` 为主信息） |

配套铁律（同样写进 skill）：

1. **`CAUSE` 是推测不是事实**——换 profile 时必须连带说明依据（`CAUSE_EVIDENCE=` 原文），不要写成「接口挂了」这种结论。
2. **不要把归因当自动重试许可**——归因只改变「重派时怎么改」，不改变「要不要重派」的决策权归属（仍是主 agent）。
3. **归因与 `ERROR=` 冲突时以 `ERROR=` 为准**：`ERROR` 是事实，归因是推测。

---

## 10. profile 轮换的边界（本版明确不做）

| 机制 | 本版 | 理由 |
| :--- | :--- | :--- |
| zen-free **同一 profile 内**换模型 | **保持现状**（`src/zen-free.ts` 的排除集 + attempt 循环） | 已在 runner 层实现，与本特性正交 |
| 跨 **profile** 换（opencode-zen-free → opencode-minimax-cn → claude…） | **不做自动链**；由主 agent 读到 `CAUSE=` 后**显式**用 `agent_ex_submit({profile: …})` 重派 | runner 不懂 profile 之间的语义等价性（claude profile 未必装了、minimax-cn 未必有 key）；自动换 = 静默改变执行环境，且 runner 没有 plan 上下文来判断「换一个够不够」 |

⇒ 主 agent 换 profile 时需要知道有哪些可选：`agent-ex profile list`（`src/config-cmd.ts` 的 `profile` 子命令）已存在，skill 里直接引用。

**未来若要做 profile 降级链**（另立 spec）：submit 增加显式的 fallback 列表、runner 在 attempt 边界切换、切换事件落 log——但那需要先定义「profile 等价性」这个概念，目前没有。

---

## 11. 测试

| 文件 | 覆盖 |
| :--- | :--- |
| `tests/executors-opencode.test.ts` | `classifyLog` 的 4 条判据各一例（用真实事件形状构造）；未匹配 ⇒ `unknown`；日志不存在 ⇒ `null` |
| `tests/executors-claude.test.ts` | 同上，claude 事件形状 |
| `tests/store.test.ts` | 新列在旧库上自动迁移；`patch`/`transition` 写入 `cause`/`cause_evidence` 后能读回 |
| `tests/wait.test.ts` | `CAUSE=` / `CAUSE_EVIDENCE=` 有值时输出、无值时不输出；顺序在 `ERROR=` 之后 `LOG_PATH=` 之前；`ERROR=` 内容不变 |
| `tests/tools.test.ts` | `agent_ex_status` 返回 `cause` / `cause_evidence`；无归因时字段不出现 |
| `tests/notifier.test.ts` | 卡片 detail 含「疑似原因」与中文标签；`cause=unknown` 时措辞为「无法归因」 |
| `tests/integration.test.ts` | 真起 runner 跑一个必然超时的任务 ⇒ 任务终态带 `cause`，卡片带疑似原因 |

**测试写法约束**（沿用仓库既有习惯）：单测不依赖真实网络 / 真实 CLI；opencode 的判据用例直接用真实事件 JSON 行（形状照抄 `~/.agent-ex/logs/*.jsonl` 的实测样本）。

---

## 12. 文档同步（按 AGENTS.md 的「改动时的连带规则」）

| 文件 | 改什么 |
| :--- | :--- |
| `skills/agent-ex-dispatch/SKILL.md` | ① stdout 新字段 `CAUSE=` / `CAUSE_EVIDENCE=`；② 决策规则表（§9）；③「失败/超时」排错表补一行（为什么超时后不自动换模） |
| `docs/user-guide/state-machine.md` | wait stdout 契约补两行 + 四个 `cause` 的含义与处置建议 |
| `docs/user-guide/notifications.md` | 卡片带「疑似原因」 |
| `README.md` / `docs/README.zh-CN.md` | MCP tools 表里 `agent_ex_status` 的返回值补 `cause`；`agent-ex wait` 段一句 |
| `CHANGELOG.md` | 0.6.0 条目 |

**同一条事实只写一处**：四个 `cause` 的**定义**写在 `docs/user-guide/state-machine.md`；skill 里只写「怎么用」（决策表），不重复定义；README 只给一句摘要 + 链接。

---

## 13. 兼容性

| 场景 | 行为 |
| :--- | :--- |
| executor 未实现 `classifyLog`（如 `fake`） | `cause` 为 NULL，stdout 不多两行，行为与今天**完全一致** |
| 旧库（无新列） | `migrateColumns()` 自动 `ALTER TABLE` 补列；旧数据 cause=NULL |
| 老 skill 读新 stdout | 多两行不影响解析（旧 skill 忽略未知行）⇒ **但归因的价值要靠新 skill 才吃得到** ⇒ skill 与 server **同版本发版** |
| 老 server 读新 skill | skill 会等 `CAUSE=` 行而读不到 ⇒ 走「无 `CAUSE=` 行」的默认分支，行为等同今天 |
| `agent_ex_status` 返回新增字段 | 老主 agent 忽略未知字段即可 |

**发布版本**：0.6.0（feature，minor）。skill 与 npm 包同版本发布（skill 走 `skills/agent-ex-dispatch/` 随包分发）。

---

## 14. 风险与已知局限

| 风险 | 说明 | 缓解 |
| :--- | :--- | :--- |
| 归因误判 | 启发式规则，不是因果证明 | 措辞统一为「疑似」；必带证据串；skill 里写明「以 `ERROR=` 为准」 |
| 单次空转步无法判 `api_hang` | 落到 `no_text` | 证据串里 `last out 0 tok` 暴露异常；文档明写此局限 |
| claude 侧精度低一档 | 无 `step_finish.tokens` | claude 判据只用它有的信号（api_error / text block），证据串注明依据 |
| 日志体积 | `classifyLog` 全量读 log | 实测 192KB 量级；只在终态扫一次，不是热路径 |
| 归因漂移 | executor 升级改了日志形状 | 判据全部基于已实测的事件形状；`unknown` 兜底，不会误报成具体原因 |

---

## 15. 附：实测原始数据（本设计的校准依据）

来自 `~/.agent-ex/logs/`，2026-11-11 ~ 11-13 的 10 个真实任务：

```
task_id                   text  tool  steps  reasons(tools/unknown)  lastTok_out  lastGap_s  zeroTokSteps
task_mwbn2vyp_8a661d      1     46    24     24/0                    2500         41         0
task_mwbma3x0_1e13ea      2     43    23     23/0                    1378         94         0
task_mwblg4dr_c07d0e      2     71    72     72/0                    1656         72         0
task_mwd8blbh_30d0a9      0     43    26     26/0                    162          177        0
task_mwd8wcv4_e1009f      0     8     9      4/5                     0            320        5
task_mwacatue_add1eb      0     26    15     15/0                    130          210        0
```

- 健康任务：`text ≥ 1`、每步 output token 1378–2500、步间隔 41–94s。
- `no_text` 型失败：`text = 0`、output token 130–162（低但非零）、步间隔 <210s。
- `api_hang` 型失败：`reason=unknown` 且 tokens 全 0 的步 **5 个**、间隔 305/307/310s、opencode 自身日志对应 `stream providerID=opencode modelID=mimo-v2.6-flash-free` 之后 5 分钟零事件。
