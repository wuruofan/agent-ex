# 把 wait-task 收进 CLI：`agent-ex wait`

**文档编号**：2026-10-30-wait-as-cli-subcommand
**状态**：设计定稿并**全部实施完成**；`agent-ex-mcp@0.3.0` 已发布（tag `v0.3.0`），skill 侧迁移在 publish 之后由 `f7a66b3` 落地
**实施现状（2026-11-06 更新；下方 2026-11-04 的逐轮评审记录保留原貌）**：
- ✅ `src/report.ts`、`src/wait.ts`、`tests/wait.test.ts`（42 条用例）已落地；`src/server.ts` 已接上 `wait` 分支。
- ✅ 退出码与 stdout 契约按 §3.2 / §3.3 实现；金标准对照（completed / running / needs_input / failed / not_found + 遗留 WAL 的 copy 路径）**stdout 逐行一致**。
- ✅ D1 已修：copy 模式每轮按 `db`+`-wal`+`-journal` 整组签名重建副本（复制前后双签名校验）。
- ⚠️ **超时文案实现时保留了老措辞**（"the runner likely died"），与 §1.2 要求不符 → 已在 `7c2fa17` 改为「本轮上界已过 + 指向 `--max-wait-sec`」。
- ✅ 已完成（2026-11-05，在 publish 之后）：§6 第 3 步（删 `wait-task.mjs` + 改 SKILL.md）、§6 第 4 步（skill 版本门槛写死具体版本号）—— 由 `f7a66b3` 落地。门槛现为 `agent-ex-mcp >= 0.3.1`：0.3.0 有 `agent-ex wait`，但兜底查询要用的 `include_finished` 是 0.3.1 才加的。
**修订**：
2026-10-30 一轮评审——纠正"npm 用户拿不到脚本"的论据、把既有缺陷移出"冻结"范围、§3.3 补按状态的字段表与 exit 1、只读路径不复用 `Store` 类、wait 单独分支不载 `.env`、补测试落位与发布顺序。
2026-10-30 二次评审（对着代码逐条核验行号与语义）——**撤回 D2**（§1.2：单次 wait 观察不到轮次推进，按轮数缩放是把预算放大约 5 倍，代价方向反了）；逐项修订：D1 的源签名必须覆盖 `-wal`/`-journal`（§4）、`report.ts` 改为复用 `executor.parseEvent` 而非自造形状解析（§4）、新增 `--help`（exit 0）并让它兼任版本探针（§3.1/§3.2/§5.4）、`ELAPSED_SEC` 的语义必须先定性（§3.3）、`MAX_WAIT_SEC=never` 进字段表、skill 侧步骤并入 §6 并修正删除顺序、发布顺序改成「两个 commit，中间 publish」（§7）。
2026-10-30 三轮评审（外部 worker 独立评审 + 会话复核，P0 全部亲手核实）——**撤回上一轮的「复用 parseEvent」**：parseEvent 在 claude 混合 `text`+`tool_use` 消息里丢文本的三处问题仍然成立，§4 维持「`report.ts` 自解析、不复用」定稿，§3.3 同步改口径（本轮§3.3 已改）；新增信号语义（§3.2：SIGINT/SIGTERM 只结束等待进程自身——exit 130/143、清理副本，**绝不**向任务/runner 发信号）；skill 侧 `wait-task` 引用以 grep 全量清点为准（Task 6 已同步）。
2026-11-03 四轮评审（会话复核第二轮，全部按证据落地）——信号监听改挂 **CLI 边界**（`runWait` 保持纯函数，`deps.installSignals` 注入）；`STATUS=unknown` 定性为失败路径哨兵（非 `TaskStatus` 枚举）；`--report-out` 写失败仍输出路径的契约补注；copy 逐文件复制的**撕裂窗口**（复制前后双签名校验）；发布顺序改为 **commit A → `npm version` 提交 + push + tag → publish → commit B → push**（约束是"被 push 的那批不含 skill 改动"）；新增「**包未发布时本机自测必须先 `npm link`**」的补救路径（§5.2、§6.8、`install-skill.sh`），因为此时升级命令装回来的仍是旧版。
2026-11-04 五轮评审（对着上一轮改动再核）——修正两处自相矛盾：§4 副本复制口径统一为**整组**（`db`+`-wal`+`-journal`，源侧缺失要删副本同名文件），§5.2 的"不找 `dist`"改成"**不自动探测** `dist`"（`node dist/server.js` 是人工指定的开发期命令）；测试补三处：信号用例**只能进程级**（挪到真进程组）、Task 2 的 D1 单测必须在改完源库后**恢复 0555** 才会走重拷路径（否则退化成直读恢复）、真进程组补 exit 6 与 SIGINT/130，并写明 exit 1 为何不做 wait 专属用例。
2026-11-04 六轮（复核五轮改动）——**stderr 流式语义**（§3.2）：copy 降级说明 / `--verbose` 进度 / 预算超限必须**等待中途**就可见，`runWait` 经 `deps.writeStderr` 注入实时落盘（CLI 传 `process.stderr.write`），不注入则攒进返回值（单测 `r.stderr` 口径不变）；攒到返回才 flush 会让 SIGINT 测试等不到任何带内信号而死锁。`scripts/install-skill.sh` 正式纳入 Task 6 的提交清单（收尾提示的 npm link 行此前只改了文件没登记）。
**相关**：`skills/agent-ex-dispatch/SKILL.md`（Phase 2 loop）；`scripts/wait-task.mjs` 已于 `f7a66b3` 删除（在 0.3.0 publish 之后），等待环节现由 `agent-ex wait` 提供

## 1. 问题

`wait-task.mjs`（576 行）+ 测试（329 行 / 43 条断言）目前住在 `skills/agent-ex-dispatch/scripts/`。

**先纠正一个容易说反的前提**：这个脚本**不是**"npm 用户永远拿不到"——它随 skill 走 GitHub 分发
（`npx -y skills add wuruofan/agent-ex --skill agent-ex-dispatch -g -y`，见 `scripts/install-skill.sh` 的终端用户路线），
装了 skill 就拿到了脚本。真正的问题是三条：

1. **没有版本号 ⇒ 版本漂移**：脚本住在 skill 里（GitHub 分发），产品走 npm（`package.json` 的 `files` 只有
   `dist` / `config.example.json` / `README.md`）。两边更新节奏不同步——DB schema 变、executor 日志形状变、
   退出码语义变时，skill 里的旧脚本不会跟着包升级 ⇒ **同一套语义有两个版本在跑**。
2. **知识三处双写**：runner 的真实上界（单轮 `3×timeout_sec + 90s`，`runner.ts` 每轮独立计时 + 3 次瞬态重试）、
   两种 executor 的日志形状（claude `message.content[]` / opencode 扁平 `{"type":"text"}`）、只读降级
   （复制 `tasks.db(+wal)` 到可写目录再读）这些事实 `src/` 都有；但**"等待 + 报告提取"**在 skill 里另写了一遍，
   `SKILL.md` 排错表「`agent_ex_status` 的 `result` 只给到一半」那条的末尾，还留着**第三份手写 python 提取 recipe**。
3. **强耦合且无回归保护**：脚本直接读 `$AGENT_EX_HOME/tasks.db` 的 `tasks` 表
   （`id/status/timeout_sec/log_path/question/files_changed/...`）。这些列一改脚本就哑掉，而它不在包的测试里。

### 1.1 迁移时必须一并修掉的既有缺陷（明确不在"冻结"范围内）

§3 的"迁移不改语义"指的是**健康路径**的可观测行为。下面这条是**已确认的缺陷**，照搬即是把 bug 固化成公开契约，
必须在本次迁移里修掉。（一轮评审还提过"预算不随轮数缩放"，二次核验后撤回，理由见 §1.2。）

**D1. 只读降级副本是"冻结快照"，轮询期间看不到任何状态变化。**
`ensureDb()` 缓存了连接，`copyForRead()` 只能在首次 open 时被调用（`wait-task.mjs:311-342`、`:279-294`）——
文件头注释宣称的"源文件变化时重做副本"（`copiedSig` 那套）在轮询循环里**不可达**。
实测（直读失败 → 走 copy 路径 → 3s 后源库状态改成 completed）：

```
[writer] source db updated -> status=completed
--- waiter exit: 2 elapsed: 10.1s
STATUS=running
WAIT=timeout
DB_SOURCE=copy
stderr: task still running after 10s ... the runner likely died without finalizing.
--- source db status now: {"status":"completed"}
```

等待进程盯的是**开跑那一刻的副本**，源库早已 `completed`，它却一直报 `running`，最后还附一条**错误诊断**
"the runner likely died without finalizing"。这正好落在本设计最在意的场景（宿主 shell 沙箱禁写 `~/.agent-ex`）：
白等一个预算周期，拿到假结论。
⇒ **修法**：copy 模式下每轮比对源签名（大小 + mtime；**范围是 `db` + `-wal` + `-journal` 整组**，见 §4），
变了就重建副本并重开连接。

### 1.2 撤回的候选缺陷：预算按轮数缩放（原 D2）

一轮评审曾认定推导预算 `3×timeout_sec + 90 + 120` 只对单轮任务成立，主张按
`rounds × (3×timeout_sec + 90)` 缩放（`MAX_ROUNDS = 5`，`runner.ts:19`）。**二次核验后撤回，三条理由：**

1. **轮次推进会先显形为 `needs_input`。** `rounds` 的唯一写入点是续跑（`tools/submit.ts:74`），而续跑的前置条件是
   `status === "needs_input"`（`tools/submit.ts:73`）；`wait` 在 `needs_input` 上就 exit 5 退出（`wait-task.mjs:532-535`）。
   ⇒ **单次 `wait` 观察不到轮次推进**，它盯的永远只有一轮，单轮上界就是正确上界。
2. **那个公式连"上界"都不是。** 轮与轮之间是人答问题的时间，无上界；把可确定的部分乘 5、把不可确定的部分漏掉，
   不构成任何上界，只是把数字做大。
3. **代价方向反了。** 万一真的跨轮（20s 轮询窗口内被别的执行者抢答了 `needs_input`）导致误判，代价是"重起一次 wait"
   ——一次唤醒；而放大 5 倍后，runner 真死时要白等 15 小时（`timeout_sec=3600` ⇒ 54450s）。
   现有 11010s 已经让 §6 的冒烟必须显式传 `--max-wait-sec`，再 ×5 等于逼所有调用方放弃推导预算。

⇒ **保留单轮上界**；超时文案从"the runner likely died"改成"本轮上界已过"。需要更宽窗口时由调用方显式
`--max-wait-sec`（`0` = 永不放弃），不写进默认值。SELECT 不需要加 `rounds` 列，也不需要 `executor` 列
（`report.ts` 自解析两种日志形状，见 §4）。

## 2. 决策

| 问题 | 决策 | 理由 |
| :--- | :--- | :--- |
| 等待做成 MCP 工具？ | **否** | MCP 工具是同步请求：占住本轮、每次返回都是一次全量重放、存活时间由客户端决定。`wait-task` 的价值恰恰是「独立进程 ⇒ 等待零 token + 唤醒落在原会话」，工具形态一条都保不住。缩成 60s 轮询则是换皮的轮询，违反铁律 4 |
| 实现归谁？ | **归产品（CLI 子命令）** | 逻辑与 `store` / `runner` / `logs` 同源；脚本随 skill 分发 ⇒ 没有版本号 ⇒ 与包版本漂移。必须随包发布才有意义（skill 只保留"何时用、怎么读结果"） |
| skill 留备份脚本？ | **不留** | 双实现 = 双倍维护 + 两个版本的行为漂移；skill 只保留"何时用、怎么读结果"的规范。找不到命令就**明确失败**，不静默降级 |
| 命令形态 | `agent-ex wait <task_id>` | 仍是 shell 里的普通进程，`run_in_background` 的三条属性原样保留 |
| 既有缺陷照搬？ | **否** | D1 是已确认缺陷，必须在迁移里修（§1.1）；D2 已撤回，预算保持单轮上界（§1.2）。冻结的是健康路径的语义，不是 bug |

## 3. 对外契约（**冻结**：健康路径的语义迁移不改；D1 除外，见 §1.1）

### 3.1 参数

| flag | 默认 | 语义 |
| :--- | :--- | :--- |
| `<task_id>`（位置） | 必填 | 目标任务 |
| `--interval-sec N` | `20` | 轮询间隔，必须 > 0 |
| `--max-wait-sec N` | 由任务推导 `3×timeout_sec + 90 + 120`；无 `timeout_sec` 时 `7200` | `0` = 永不放弃（stdout 输出字面量 `MAX_WAIT_SEC=never`）。**推导只看单轮上界，不随 `rounds` 缩放**（§1.2） |
| `-h` / `--help` | — | 打印用法、**exit 0**。同时充当版本探针：老 CLI 没有 `wait` 子命令，`agent-ex wait --help` 会走 unknown command 分支 exit 2（§3.2/§5.4） |
| `--report-out PATH` | `<tmpdir>/<task_id>.report.md` | 报告落盘位置 |
| `--copy-dir PATH` | 系统临时目录 | 库目录只读时的降级副本落点 |
| `--once` | 关 | 查一次就返回；**判断顺序是 terminal → needs_input → once**，所以 `needs_input` 仍走 exit 5，其余非终态才走 `WAIT=timeout` |
| `--verbose` | 关 | 每轮心跳写 stderr |
| `--no-digest` | 关 | 不输出 `REPORT_OUTLINE` / `REPORT_TEXT` / `REPORT_HEAD` |
| `--home PATH` | `$AGENT_EX_HOME` → `~/.agent-ex` | 数据目录（测试用） |

预算推导的取值口径：

- `timeout_sec` 缺失或非正数 ⇒ `7200`（与现实现一致）；
- 否则 `3×timeout_sec + 90 + 120`：3 次 attempt 各吃满 `timeout_sec`、30s+60s 退避、再留 120s 给 finalize + 通知
  ⇒ **与老脚本逐字一致**（`wait-task.mjs:245-249`）；
- **不看 `rounds`**（§1.2）。例：`timeout_sec=3600` ⇒ `11010`；`120` ⇒ `570`。

### 3.2 退出码与 `WAIT=`

| `WAIT` | exit | 含义 |
| :--- | :--- | :--- |
| `terminal` | 0 | `completed` / `failed` / `cancelled` |
| `needs_input` | 5 | worker 在等答复；**不是终态**，答复后对同一 id 重起等待 |
| `timeout` | 2 | max-wait 用尽，或 `--once` 时仍非终态且非 `needs_input`（后者见上一行）；**不自动续等** |
| `not_found` | 3 | 无此任务 |
| `db_unreadable` | 6 | 原地与副本都读不了 ⇒ **环境问题**，绝不等同于 `not_found` |
| — | 4 | 用法错误（**必须由 `runWait` 返回 4，不得抛异常**——`server.ts` 的 CLI 兜底会把异常映射成 1） |
| — | 1 | 内部异常（不应发生）；与老脚本的 fatal 路径一致（`wait-task.mjs:556-561`） |

> 契约外提醒：老 CLI 收到 `agent-ex wait` 会走 unknown command 分支，**退出码是 2**（`server.ts:182`），
> 与 `WAIT=timeout` **撞码**。所以判据不是退出码而是 stdout：**有 `WAIT=` 行才适用本表；exit 2 且没有 `WAIT=` 行
> ⇒ CLI 太旧**（§5.4、§7）。想提前探测而不靠撞码：`agent-ex wait --help` —— 新 CLI exit 0，老 CLI exit 2。

**信号语义**：`SIGINT` / `SIGTERM` 只结束**等待进程**（按惯例 exit 130 / 143，stderr 一行说明），
**绝不向任务或 runner 发任何信号**（`wait` 是观察者，不是调度者；取消必须走 `agent_ex_cancel`）；
已写出的 `REPORT_PATH` 保留，`--copy-dir` 下的副本按 §4 清理。
⚠️ **监听器不无条件安装**：由 CLI 边界（`src/cli.ts`）显式开启 `deps.installSignals=true`，
`runWait` 内安装并在 `finally` 里 `off`；单测与其它调用方默认 `false`。否则它是全局副作用——
同进程反复调用会累积 listener（>10 触发 MaxListeners 警告），而且测试进程收到 `SIGINT`
会被 handler 里的 `process.exit(130)` 直接杀掉。
⚠️ 信号终止属**表外**：exit 130/143 且**没有 `WAIT=` 行** ⇒ 判据仍是"先看 stdout 有没有 `WAIT=`"（见上面的提醒）。

**stderr 的时序**：copy 降级说明 / `--verbose` 进度 / 预算超限这类**等待中途就该看见**的人类信息，
`runWait` 经 `deps.writeStderr` 注入实时落盘（CLI 传 `process.stderr.write`）；不注入（单测）则攒进返回值，
`r.stderr` 断言口径不变。不能攒到返回才 flush——那会让 `--verbose` 形同虚设，也会让 SIGINT 的
进程级测试等不到任何带内信号而死锁。

### 3.3 stdout 字段（顺序即契约）

字段**顺序**固定；但**不同 WAIT 状态下的字段集合不同**，实现必须逐状态对齐——老脚本就是按状态发不同子集，
§6.5 的金标准 diff 会盯住这点。

| WAIT | 字段（按此顺序） |
| :--- | :--- |
| `terminal` | `TASK_ID` `STATUS` `WAIT` `MAX_WAIT_SEC` [`DB_SOURCE=copy`] [`ELAPSED_SEC`] [`PROJECT_PATH`] `FILES_CHANGED` [`ERROR`] [`QUESTION`] `LOG_PATH` `REPORT_PATH` `REPORT_CHARS` [`REPORT_OUTLINE`] [`REPORT_TEXT` \| `REPORT_HEAD`] |
| `needs_input` | 与 `terminal` 同字段，但 **digest 三个字段全部不输出**（`REPORT_OUTLINE` / `REPORT_TEXT` / `REPORT_HEAD`）；`LOG_PATH` `REPORT_PATH` `REPORT_CHARS` 仍输出（部分报告可供选读） |
| `timeout` | `TASK_ID` `STATUS` `WAIT` `MAX_WAIT_SEC` [`DB_SOURCE=copy`] [`ELAPSED_SEC`] [`PROJECT_PATH`] `FILES_CHANGED` [`ERROR`] [`QUESTION`] —— **无** `LOG_PATH` / `REPORT_*`（任务未终态，不写报告文件） |
| `not_found` | `TASK_ID` `STATUS=unknown` `WAIT=not_found` —— **仅 3 行**，没有 `MAX_WAIT_SEC` |
| `db_unreadable` | `TASK_ID` `STATUS=unknown` `WAIT=db_unreadable` —— **仅 3 行**，没有 `MAX_WAIT_SEC` |

其余规则：

- `MAX_WAIT_SEC` 在 `--max-wait-sec 0` 时输出**字面量 `never`**（不是 `0`，`wait-task.mjs:428`）——解析端必须认这一个
  非数字取值，别用 `Number()` 硬转；
- `STATUS=unknown` **不是** `TaskStatus` 枚举值（`store.ts:34` 只有 6 个状态）：它是 `not_found` / `db_unreadable`
  两条失败路径的**哨兵**。解析端别拿枚举做校验，否则这两行会被判成脏数据；
- `--report-out` **写失败时仍会输出 `REPORT_PATH`**（老脚本行为，为保住 diff 一致）⇒ 该路径**可能不存在**，
  读之前先 `test -f`；
- digest 仅 `terminal` 且报告非空且未 `--no-digest`：≤1200 字符内联 `REPORT_TEXT`，否则 `REPORT_HEAD`（前 700）；
  `REPORT_OUTLINE` 取章节标题，一行 `|` 分隔（≤600 字符、≤20 条）；
- 报告提取：只收 `role=="assistant"` 的文本块、取**最长**块；两种日志形状的兼容由 `report.ts` **自解析**
  （§4 三审定稿，**不复用** `executor.parseEvent`——见下方修订记录第三轮的撤回说明），
  不要在 `wait` 里另写；terminal 且取不到时写 stderr 警告（`REPORT_CHARS=0` 不等于"worker 没说"）；
- **`ELAPSED_SEC` 的语义（已定死）**：**保名 + 定死语义**，**不改 DB、不改 `agent_ex_status`**。
  值 = `(ended_at ?? now) - started_at`，其中 `started_at` 是**首次**认领时刻（`store.ts:203` 的
  `COALESCE(started_at, ?)`），`ended_at` 由 `finalize()` 写（**含 `needs_input`**，`runner.ts:249-254`），
  续跑回 `running` 时 `store.transition()` 只 patch `rounds`、**既不清 `ended_at` 也不重置 `started_at`**
  （`store.ts:209-215`、`tools/submit.ts:74-75`）。
  ⇒ 按 `status` 分两种读法（**公式不变**，金标准 diff 要求逐字一致；口径必须写清）：
  - **终态行**（completed / failed / cancelled / 待答复的 needs_input）= **「首次认领 → 最后一次 finalize」
    的墙钟时长**（多轮任务 `finalize()` 写 N 次 `ended_at`，最后一次覆盖前一次），
    多轮任务里**含中间人工答复的等待**——不是纯执行时长，也不是本轮已用时；
  - **续跑后的 running 行**：`ended_at` 是**上一轮 finalize 的旧值**且续跑不清除 ⇒ `ELAPSED_SEC`
    **卡在旧值、不再增长**。这是迁移保留下来的已知行为，不是 bug 修复范围；要"本轮已用时"
    请用 `rounds` 与日志自行推算，**别拿这个字段当计时器**。
  为什么不定另两条路（2026-10-30 三审定）：
  - **改名 `WALL_SEC` 会直接打破 §6.5 的"逐行 diff 为空"**（老脚本输出的字段名是 `ELAPSED_SEC`）；
  - **「续跑时重置 `started_at`/清 `ended_at`」不是 wait 局部改动**：要动 `store.claimToRunning` 的
    "started_at 只记首次"不变量（`store.ts:198,203`）与 `agent_ex_status` 的 `elapsed_sec`
    （`tools/status.ts:29` 用同一公式），与 §8「不顺手改 `agent_ex_status` 的语义」直接冲突。
  （附带事实：**孤儿收割器根本没实现**——src 里只剩测试专用的 `agent_ex_set_started_at` 助手
  （`server.ts:105-114`），所以那条路的改动面确实小，但仍是产品级语义变更，不该由本次迁移顺带做。）
- **`QUESTION` 的解释力只绑定 `status=needs_input`**：DB 里续跑时不清 `question` 列
  （`tools/submit.ts:75` 只 patch 了 `rounds`）⇒ 多轮任务的终态行仍带上一轮的问句。
  调用方**不要**用"有没有 QUESTION"判断是否需要答复，只看 `STATUS`。

## 4. 代码结构

```
src/report.ts   extractReport(logPath) / outlineOf(text) / digest 阈值常量
                · **自解析，不复用 executor 的 `parseEvent`**（2026-10-30 三审定）：parseEvent 服务的是
                  runner 的"最后一条消息"需求，与"找出报告"是两种需求，且与老脚本有三处语义差异——
                  ① claude 消息同时含 text 与 tool_use 时，parseEvent 提前 return toolUse、**丢掉那段 text**
                  （`executors/claude.ts:29-31`；26-28 是 `find` 的谓词，不是返回点）；② 一条消息含多个 text 块时 `join("")` **拼成一段**
                  （`:32-35`），而契约要的是"最长单块"；③ **不检查 `message.role`**（只看 `type==="assistant"`），
                  而 compaction 摘要正是靠 role 挂在 `user` 上、必须排除。
                  要"复用"就得补回 ③ 并把契约里的"块"改成"消息"，或为 ① 重新解析 claude 形状——
                  后者等于把形状解析又写一遍 ⇒ 净复杂度更高、行为还会与老脚本漂移（直接顶到 §6.5 的 diff）。
                · 代价与取舍：产品内会同时存在"executor 的形状知识（工具事件/sessionId/result）"与
                  "report 的提取规则（role 过滤/最长块/outline）"两份——**两者不重叠**。
                  §1 第 2 条要消灭的是**跨包**双写（skill 与产品各一份），迁移后 skill 那份被删 ⇒
                  产品内 report.ts 这一份即达标。
                · 同时取代 SKILL.md 排错表里那份手写 python 提取 recipe
src/wait.ts     runWait(argv) → { stdout, stderr, exitCode }；内部注入 sleep/now，便于测试
                · copy 模式：**仅在直接只读打开失败时**进入；每轮以 `tasks.db` + `-wal` + `-journal` **这一组**的
                  `(mtime, size)` 作源签名（只签主库会在"写者只追加 `-wal`"时永远判不新鲜 ⇒ 把 D1 原样种回去；
                  现实现 `sourceSig()` 就是签 db + wal 两个文件，`wait-task.mjs:260-271`）；
                  签名未变就复用现有连接，变了才重拷整组并重开（不是每 20s 无条件复制）；
                  退出/收到信号时删除副本与 `-shm`，**源库及其 `-wal` 一律不动**（D1）
                · 预算**只看单轮**（§1.2），不做 rounds 缩放
src/store.ts    **新增 openReadonlyStore(dbPath)**：只 `new DatabaseSync(path, { readOnly: true })`
                + 一条 SELECT。**只读路径不复用 Store 类**——Store 构造函数全是写/锁操作
                （mkdirSync / busy_timeout / journal_mode 切换 / CREATE TABLE / ALTER TABLE 迁移，
                store.ts:113-121、173-185），而 wait 的定义是"绝不干扰 MCP server 与活着的 runner"。
                （`DatabaseSyncCtor` 目前只声明一个参数（`store.ts:25`）——**本次要放宽**：补可选
                 `options?: { readOnly?: boolean }` 并让 `openReadonlyStore` 真正传下去；Node 的
                 `DatabaseSync` 运行时支持 `{ readOnly: true }`，窄化只是本仓库的类型声明。）
                只读打开失败 ⇒ 复制**整组**（`tasks.db` + `-wal` + `-journal`）到 --copy-dir 再开（DB_SOURCE=copy）；
                源侧不存在的成员要在副本侧删掉同名文件（否则上一次副本残留的 `-journal` 会把新副本带偏）。
                ⚠️ **逐文件顺序复制不是快照**（本次新增机制带来的窗口，不是老实现遗留）：若在
                「拷主库 → 写者提交 → 拷 `-journal`」之间命中提交，会拿到半写主库 + 缺失 journal，
                SQLite 无从回滚 ⇒ 读到撕裂页（malformed，或静默返回旧行）。修法：**复制前后各取一次
                源签名**，不一致就丢弃重来（最多 2 次；仍不一致按 `db_unreadable` 处理，别硬报成功）。
src/server.ts   wait **单独一个 else if 分支**：不调用 loadEnvFile()（§4 刻意不做），
                但复用同一套 try/catch 兜底（CLI 侧异常体验必须与 MCP 侧对等，server.ts:166-175）；
                USAGE 加一行
src/cli.ts      runWait 的入口（与 runDoctor / runConfig / runProfile 平级）；
                usage 错误**返回 4**，不抛异常（否则被 server.ts 的兜底映射成 1）；
                `--help` **返回 0**
```

刻意不做的：`wait` 不加载 `.env`（不解析 `{env:VAR}`，与 doctor 不同）；不打印任何彩色/符号，stdout 只给机器可读的 KEY=VALUE。
另注：`wait` 必然要开库，所以每次会在 stderr 留一条 `ExperimentalWarning: SQLite is an experimental feature`
（`init` 是靠动态 import 躲掉的，这里躲不掉）——它是噪音不是契约，但**别写"stderr 只有一行"这类断言**。

## 5. skill 侧改动

1. 调用方式（后台跑，语义不变）：

```bash
agent-ex wait <task_id> --report-out /tmp/<task_id>.report.md
```

2. 命令发现：`command -v agent-ex` → 找不到就**按场景给三条路**：
   - 正常用户：`npm i -g agent-ex-mcp`；
   - 免安装：`npx -y agent-ex-mcp@latest wait <task_id>`（**已实测**：包名 `agent-ex-mcp` 与 bin 名 `agent-ex`
     不同不影响解析，能正确进到子命令分派——旧版报 `unknown command "wait"` / exit 2，属预期）；
   - **仓库开发路线**：`npm link`（把本地 `dist/` 挂成全局 `agent-ex`），或直接 `node <repo>/dist/server.js wait`。
   **不自动探测** `dist`（上面那条 `node <repo>/dist/server.js wait` 是人工指定的开发期命令，属于第三条路，
   不是探测逻辑）、不解析 MCP 配置、不回退脚本。
   ⚠️ **包发布之前**，前两条装回来的仍是旧版（本机实测 `agent-ex` = 0.2.0）⇒ `agent-ex wait` 只会
   unknown command / exit 2，而"exit 2 ⇒ 给升级命令"那条兜底会把人在原地打转。这个窗口里
   **本机自测 skill 必须先 `npm link`**（§6 第 8 步、`install-skill.sh` 收尾提示）。
   ⚠️ 这条会**改掉 README 的一个承诺**：README「路线 A」明写装 skill「无需 `npm i -g agent-ex-mcp`」，
   而本设计之后 wait loop 必须有二进制 ⇒ 那句必须同批改（§6 第 7 步）。`npx` 那条回退是给"只装 skill
   不装包"的人留的活路，顺带把版本门槛退化成"总是最新"。
3. 删除 `scripts/wait-task.mjs` 与 `scripts/wait-task.test.mjs`；`Resources` 列表、`SKILL.md` 里所有脚本路径引用、
   **排错表「`agent_ex_status` 的 `result` 只给到一半」那条末尾的手写 python 提取 recipe**、只读沙箱说明全部改成 CLI 说法
   （`WAIT=db_unreadable` 的语义与 `--copy-dir` 保留）。删除动作的**顺序约束**见 §6 第 7 步（与 `vitest.config.ts`
   的 `exclude`、以及发布顺序绑在一起）。
   顺带修两处**现存的过期文案**：「会话内定时等待」末尾那条退出码清单仍写"3 无此任务**或 DB 不可读**"（现在是 3 与 6 分开）；
   `Resources` 列表里的 `scripts/wait-task.mjs` 行仍指向脚本路径。
4. 版本门槛写进技能说明：需要 `agent-ex >= <X>`，**X = `wait` 子命令首次发布的版本号**（发布后写死具体值，
   设计阶段只写"最低版本"）。
   **探针用 `agent-ex wait --help`**（新 CLI exit 0 / 老 CLI 走 unknown command 分支 exit 2），不需要
   `agent-ex --version` —— 后者目前不存在：实测会静默启动 MCP server 并打印 `[agent-ex] mcp server ready (stdio)`，
   版本信息只有 MCP 工具 `agent_ex_version`（`tools/version.ts:22`）。运行期判读同 §3.2：
   **有 `WAIT=` 行才认退出码**；exit 2 且没有 `WAIT=` 行 ⇒ CLI 太旧，按 §7 的文案给升级命令。
   `--version` 另开一项，本次不做。

## 6. 迁移步骤与验收

1. `src/report.ts` + 单测：claude / opencode 两种日志形状的用例（含 opencode `part.text` 兜底）、
   `role` 过滤（compaction 摘要挂在 `user` 上）、取最长块、outline（阈值三分支在 `emit` 里，归 `wait` 的单测）。
2. `src/wait.ts` + 单测：**43 条断言按状态分组重写**（现测试是 spawn 子进程、断言进程级 exit code/stderr；
   新接口 `runWait(argv) → { stdout, stderr, exitCode }`，usage 错**返回 4** 而不是抛，`--help` 返回 0）。
   落位 `tests/wait.test.ts`（vitest）。测试仍用合成 `AGENT_EX_HOME`，不碰真实库。
   **另需一组真进程用例**（`tsx src/server.ts wait …`）覆盖「返回值 → `process.exit`」那一段，否则退出码契约
   只在进程内被验证过：至少 0 / 2 / 3 / 4 / 5 / 6 各一条，`--help` 一条，SIGINT 一条（断言 exit 130）。
   ⚠️ 信号这条**只能**进程级写：handler 里是 `process.exit(130)`，在 vitest 进程内触发会连带杀掉 worker。
   exit 1 不做 wait 专属用例（`runWait` 的每条路径都把错误收成 0/2/3/4/6，走不到 catch；该分支与 config/doctor
   共用，已由 `tests/cli-env.test.ts` 的 "config failed" 钉住）。
   `vitest.config.ts` 的 `exclude` 在这一步**先别动**——它护着还活着的 `skills/.../wait-task.test.mjs`（见第 7 步）。
3. **D1 的回归用例（先红后绿）**：构造一个**遗留 WAL 库**（`PRAGMA journal_mode=WAL` → 干净关闭 → 目录里只剩
   `tasks.db`），`chmod 0555` 库目录 ⇒ 直读必然失败 ⇒ 走 copy 路径；随后恢复写权限并改源库状态，
   **等待进程必须看到新状态**，不再以 `WAIT=timeout` 收场。
   ⚠️ 别写"禁写库目录"就算数：库已是 `journal_mode=TRUNCATE`，禁写目录下直读**能成功**，copy 路径根本进不去。
   现成的正确构造在 `wait-task.test.mjs` 的 group 8（`PRAGMA journal_mode=WAL` + `chmodSync(dir, 0o555)`）。
   （原 D2 的用例随 §1.2 一起撤销。）
4. `server.ts` 子命令 + `USAGE` + `--help`（exit 0）；`tests/server-tools.test.ts` 不受影响（工具面未变）。
5. **金标准对照**：先拿旧脚本在**同一份库**上跑一遍并把 stdout 存档，再拿 `agent-ex wait --once` 逐行 diff
   （3 份真实日志：一个超时单、一个 opencode 单、一个长报告单）。stderr 前缀会从 `wait-task:` 变成
   `agent-ex wait:`，不比——但也意味着**没有存档就没有基准**，所以"先存档"这一步不能省。
6. 手工冒烟：后台起 `agent-ex wait <task_id> --max-wait-sec 60`，`kill` 掉 runner 进程 → 应在 60s 内以
   `WAIT=timeout` / exit 2 返回，而不是挂死。
   ⚠️ **必须显式给 `--max-wait-sec`**：不给就走推导预算（timeout_sec=3600 ⇒ 11010s ≈ 3 小时），冒烟会跑到天亮。
7. **skill 侧（三件事必须同一个提交）**：删 `scripts/wait-task.mjs`、删 `scripts/wait-task.test.mjs`、
   移除 `vitest.config.ts` 的 `exclude: ["skills/**/*.test.mjs"]`。
   ⚠️ 顺序：先删 `exclude` 而文件还在，vitest 会把那个自带 runner 的 `.mjs` 收进来并因模块解析失败转红。
   同批改文档：`SKILL.md`（调用方式 / `command -v` 发现 / Resources 列表 / 那份 python recipe / 只读沙箱说明 /
   那两处过期文案）、README（「命令行工具」表加一行 `agent-ex wait <task_id>` + 退出码含义 0/2/3/4/5/6，
   **并删掉「路线 A 无需 `npm i -g agent-ex-mcp`」这句承诺**）、AGENTS.md 的 project layout 登记
   `src/report.ts` / `src/wait.ts`。
8. **发布顺序（四个动作，中间插 publish）**：commit A = 代码 + 测试（skill 不动）→ `npm version X` 提交
   + **push + tag**（**这批里必须没有 skill 改动**）→ publish → commit B = 删脚本 + 改 SKILL.md / README → push。
   理由见 §7 的"反向错配"行：AGENTS.md 的流程是 ④push → ⑧publish，**push 必然发生在 publish 之前**；
   真正的约束是「**被 push 的那批里不含 skill 改动**」，而不是"push 必须在 publish 后"——否则 skill
   会先上 GitHub、后上 npm，正好落进"新 skill + 旧包"。
   ⚠️ **publish 之前本机跑 skill 必须先 `npm link`**（或直接 `node dist/server.js wait`）：此时全局
   `agent-ex` 仍是已发布的旧版（本机实测 0.2.0），`agent-ex wait` 走 unknown command / exit 2，而兜底
   文案给的 `npm i -g agent-ex-mcp` 装回来的还是旧版。`install-skill.sh` 的收尾提示同批加一行。

## 7. 风险与取舍

| 风险 | 处置 |
| :--- | :--- |
| skill 与包版本错配（新版 skill 调旧版 CLI） | 技能里写明最低版本；探针 `agent-ex wait --help`（新 0 / 老 2，§5.4）；运行期判据是**"有 `WAIT=` 行才认退出码"**，exit 2 且无 `WAIT=` 行 ⇒ CLI 太旧，给升级命令（`server.ts` 已有的 unknown command 分支只需补措辞）。⚠️ **包尚未发布时升级命令无效**：本机自测先 `npm link`（§5.2、§6 第 8 步） |
| **反向错配：老 skill + 新 CLI ⇒ 两套实现并存** | 发布顺序固定为「**四个动作、中间插 publish**」：commit A（代码 + 测试，skill 不动）→ `npm version X` 提交 + push + tag → `npm publish` → commit B（删脚本 + 改文档）→ push。约束是**被 push 的那批不含 skill 改动**（AGENTS.md 是 ④push → ⑧publish，push 必然在 publish 之前）。中间态尽量短 |
| stdout 契约被后续改动破坏 | 字段与顺序视为公开契约，变更需同步 skill 与 README；单测直接钉住字段行（§3.3 的按状态字段表，含 `MAX_WAIT_SEC=never`） |
| 只读沙箱下 CLI 起不来（拿不到数据目录） | 保留复制降级与 `--copy-dir`；`db_unreadable` 与 `not_found` 继续分开。**并修 D1**：copy 模式必须每轮按源签名重建副本，且**签名要覆盖 `db` + `-wal` + `-journal` 整组**——只签主库，写者往 `-wal` 追加时永远判不新鲜，等于把 D1 种回去。⚠️ 逐文件复制不是快照：**复制前后各取一次签名，不一致就重来（≤2 次）**，否则会读到撕裂页（§4） |
| 推导预算偏短（跨轮竞态） | **不缩放**（§1.2）：单次 wait 观察不到轮次推进，真跨轮了也只是重起一次 wait；要更宽窗口由调用方显式 `--max-wait-sec`。反过来放大默认值，代价是 runner 真死时白等 5 倍 |
| 退出码被调用方误读 | 本表之外还有两种：用法错 = 4（`runWait` 返回，不是抛）、内部异常 = 1；老 CLI 的 unknown command = 2。skill 判读**先看 stdout 有没有 `WAIT=`**，再认退出码 |
| 删除脚本后老用户的工作流失效 | 属于有意的破坏性变更：在 release 说明里给"升级包 + 更新 skill"两行命令，不做长期双轨 |

## 8. 不做什么

- 不做 MCP 工具 `agent_ex_wait`；
- 不给 `agent_ex_status` 加长轮询 / 内联全文（截断是 DB 的既成事实，全文走 `wait` 的 `REPORT_PATH`）；
- 不把 `wait` 塞进 runner 或 daemon（会让 runner 的生命周期与调用方耦合）；
- **不**新增 `agent-ex --version`（本次）：版本门槛靠 §5.4 的 `--help` 探针 + 「有 `WAIT=` 行才认退出码」的判读；
  `agent-ex --version` 目前会静默启动 MCP server，要修另开一项；
- **不**顺手改 `agent_ex_status` 的 `question` 语义（DB 里续跑不清 `question` ⇒ 终态行仍带上一轮的问句）：
  只按 `STATUS` 判定，§3.3 已写明。
