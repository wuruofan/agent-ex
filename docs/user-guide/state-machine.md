# 任务生命周期与状态机（agent-ex）

> 本文是 [`agent-ex-mcp`](https://www.npmjs.com/package/agent-ex-mcp) 的**深度章节**：
> 任务从 `submit` 到终态怎么走、`needs_input` 怎么续跑、两个上限分别管什么、
> 以及 `agent-ex wait` 的 stdout 契约与退出码。
> 命令速查见仓库根 [README](../../README.md) 的「CLI commands」一节。

关联实现：`src/store.ts`（SQLite 状态机）、`src/runner.ts`（detached runner）、
`src/wait.ts`（`agent-ex wait` 的阻塞等待）。

---

## 1. 状态机

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

### 两个上限，别把它们混为一谈

- **续跑轮数 ≤ 5**（`MAX_ROUNDS`）：第 5 轮仍有 pending question → 终态 `failed`，
  `error` 为 `rounds limit (5) reached with pending question`。
- **单轮瞬时重试 ≤ 3 次尝试**（`MAX_ATTEMPTS`）：仅对 429 / 529 / 5xx / 连接重置等**可恢复**错误生效，
  退避 30s → 60s（可用 `AGENT_EX_RETRY_BACKOFF_MS` 覆盖，逗号分隔毫秒）。真超时、`needs_input`、
  硬失败**不重试**。重试与续跑轮数是两个独立计数，任务在单轮内即可重试 3 次。

### 超时：任务一定会走到终态

单轮超时按任务的 `timeout_sec` 计。到点后 runner 给 agent 进程树发 SIGTERM（3s 后补 SIGKILL），
**落终态不依赖 agent 是否退出**：

- agent 正常退出 → 立刻落 `failed`，`error` 为 `timeout after <N>s (round R)`；
- agent 卡死不退（逃逸孙进程持有 stdout、进程卡在不可中断 IO）→ 宽限 **8s** 后由 runner 自己落
  同样的 `failed`，并照发终态卡片。

⇒ 任务最迟在 `timeout_sec + 8s` 进入终态，**不会永远停在 `running`**。

### 首步看门狗：worker 一句话不说就快速失败

除了单轮超时，runner 还有一道更早的闸门：**spawn 之后 10 分钟内 stdout 一行都没有 ⇒ 判定挂死**，
杀掉进程树、8s 宽限后落 `failed`，`error` 形如
`worker produced no output for 600s (round 1) — most likely the model hit its quota/rate limit …`。

- **为什么需要它**：某些故障形态里 worker 进程活着、却既不输出也不退出（实测：opencode 撞上
  免费档额度耗尽时报 `AI_APICallError: Free usage limit reached.`，然后就那么睡着）。没有这道闸门，
  只能等 `timeout_sec`（默认 3600s）才落终态——任务在 `running` 上白躺一小时。
- **判据是「首行 stdout」**：worker 只要吐出第一行事件就说明它开工了，之后卡住该由单轮超时管。
- **不重试**：额度是**账号级共享**的，立即重试只是再白等一轮（换 free 模型同样无效）。
- 阈值可用 `AGENT_EX_FIRST_OUTPUT_TIMEOUT_MS` 覆盖（毫秒，默认 600000）。

> 2026-11-16 修：旧实现把「落终态」挂在 agent 的 `close` 事件上（进程退出**且** stdio 全关），
> 管道被逃逸孙进程占住时该事件永不触发 —— 真实任务 `task_mwhlwihp_29b736` 因此在 `running`
> 挂了 16.5 小时，最后靠人工 `cancel` 收场。

> 例外：runner 进程**自身**被强杀（掉电 / 外部 `SIGKILL`）时来不及落终态，任务会停在 `running`。
> 这时靠 `agent-ex wait` 的预算兜底（`WAIT=timeout`，exit 2）叫醒主 agent，由它决定 cancel 还是重派。

### 取消

`cancel` 对终态任务**幂等**（返回当前状态，不改写）；对 `running` 任务会 SIGTERM 级联杀掉 agent 进程树。
若返回带 `warning`，说明进程树快照不可用（沙箱拒绝 setuid `/bin/ps`），组外逃逸的 agent 子进程可能残留。

**runner 自己被收尾时**（宿主 SIGTERM runner 本体，不走 `cancel`）：先杀掉 agent 进程树，再落
`failed`（`error` 为 `runner terminated before the task finished`），最后等在飞的飞书卡片落地再退出。

⇒ 任务不会因为 runner 被收尾而永远停在 `running`。只有 runner 被**强杀**（外部 `SIGKILL` / 掉电）
才会来不及落终态 —— 那时靠 `agent-ex wait` 的预算兜底（`WAIT=timeout`，exit 2）叫醒主 agent。

> 2026-11-17 修：此前 runner 收到 SIGTERM 就直接退出，agent 进程**没人管** ⇒ 它变成孤儿继续跑、
> 持续烧 token（实测以 `PPID=1` 活到人工清理）。现在退出前一定先收掉 agent 进程树。
> `cancel` 路径本来就没这个问题（它走 `killTree` 组杀，agent 一起死）。

### 状态查询

`status({ task_id })` 返回字段含 `status / rounds / profile / cost / project_path / started_at / created_at /
elapsed_sec / progress / files_changed`，终态时含 `result` / `error`，`needs_input` 时含 `question`，
通知失败时含 `notify_failed`。

`cost` 是**派发当时的有效成本**（`free` / `metered`）：升级前的历史任务没有这个记录 ⇒ 回显
「未记录」（**不是 free**）。它记的是「工具当时依据当时配置作出的判定」，不是「模型是否真收费」的真值。

`include_finished: true`（0.3.1+）会连已结束的任务一起列（按创建时间倒序，默认 20 条）。
会话重启 / 上下文压缩后用它认回「上次派的那个」——那通常已经终态。
⚠️ **0.3.0 会静默忽略该参数并返回空列表**，别把空列表当成「没有任务」。

> ⚠️ 全局单库：`tasks.db` 在 `$AGENT_EX_HOME` 下由所有项目共用，
> `include_finished` 会跨项目列出（含绝对路径与完整终报），用 `project_path` / `started_at` 认回自己的任务。

---

## 2. `agent-ex wait`：等任务结果

派完活不必一直轮询——`agent-ex wait` 会自己等到有结论，并把 worker 的最终报告一并带出来：

```bash
agent-ex wait task_abc123                    # 等到终态或 needs_input
agent-ex wait task_abc123 --once             # 查一次就返回
agent-ex wait task_abc123 --max-wait-sec 900 # 自己给等待窗口
```

stdout 是机器可读的 `KEY=VALUE`（顺序固定，可直接解析）：

```
TASK_ID=task_abc123
STATUS=completed
WAIT=terminal
MAX_WAIT_SEC=11010
ELAPSED_SEC=900
PROJECT_PATH=/path/to/project
FILES_CHANGED=3
LOG_PATH=/Users/you/.agent-ex/logs/task_abc123.jsonl
REPORT_PATH=/tmp/task_abc123.report.md
REPORT_CHARS=3322
REPORT_OUTLINE=摘要 | 验收
REPORT_TEXT=## 摘要 …
```

**退出码就是判据**：

| `WAIT` | exit | 含义 |
| :--- | :--- | :--- |
| `terminal` | 0 | `completed` / `failed` / `cancelled` |
| `needs_input` | 5 | worker 在等你答复——**不是终态**。答完后对**同一个 task_id** 再起一次 wait |
| `timeout` | 2 | 等待窗口用尽，任务仍在跑。**不会自动续等** |
| `not_found` | 3 | 没有这个任务（多半是 id 抄错了） |
| `db_unreadable` | 6 | 库读不了——**环境问题**（沙箱禁写数据目录），不是任务问题 |
| — | 4 | 参数用错了 |

> ⚠️ 判据是 stdout 里**有没有 `WAIT=` 行**，不是退出码。老版本 CLI 不认识 `wait` 这个子命令，
> 会走 unknown command 分支并返回 **2**，与 `WAIT=timeout` 撞码。想提前探测：`agent-ex wait --help`——
> 新版本 exit 0，老版本 exit 2。

**常用参数**：

| 参数 | 作用 |
| :--- | :--- |
| `--once` | 查一次就返回，不进入等待循环 |
| `--max-wait-sec N` | 自己指定等待窗口（默认按任务的 `timeout_sec` 推导：`3×timeout_sec+90+120`；`0` = 永不放弃） |
| `--interval-sec N` | 轮询间隔，默认 20 秒 |
| `--report-out PATH` | 报告落盘位置，默认写到临时目录 |
| `--copy-dir PATH` | 数据目录只读时的降级副本落点（沙箱场景） |
| `--verbose` | 每轮心跳写 stderr |
| `--no-digest` | 不内联报告摘要（`REPORT_OUTLINE` / `REPORT_TEXT` / `REPORT_HEAD`），报告仍会落盘 |

**沙箱里读不到库怎么办**：宿主 shell 沙箱禁止写数据目录时，SQLite 建不了 `-shm` 就读不了。
`wait` 会自动降级为「复制一份再读」（stdout 里出现 `DB_SOURCE=copy`）；连副本也读不了就是 exit 6
`db_unreadable`——**这是环境问题，别当成「任务不存在」**。此时可用 `--copy-dir <可写目录>` 指定落点。

---

## 3. 手动跑单条任务（调试用）

`runner` 一般被 server 自动 spawn。需手动验证时，先确保 SQLite 里已有一条任务记录
（通常由 `submit` 创建），再：

```bash
npm run runner <task_id>     # = tsx src/runner.ts <task_id>
```

> 这是**仓库开发者**的调试入口，不随 npm 包分发（`scripts/` 不在 `files` 白名单里）。
