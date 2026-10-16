# 只读沙箱读不到任务库（Trae shell sandbox）—— 根因是 WAL

**状态**：✅ 已定位 + 已修复（2026-10-16）。改动：`src/store.ts`（journal_mode）、`skills/agent-ex-dispatch/scripts/wait-task.mjs`（副本降级 + 退出码拆分）、`src/tools/{submit,status,cancel}.ts`（连接显式关闭）。

## 0. 触发

`task_mv9ni381_2f9a53`（22:50 终态 `completed`，293s，报告 14773 字符，0 文件改动）在 Trae 里复核时，`wait-task.mjs` 报 **exit 1**，沙箱日志指向写 `~/.agent-ex/tasks.db-wal` 被拒。

## 1. 结论（先记住这三条）

1. **不是任务失败**：`STATUS` / `WAIT` 才是权威字段；沙箱拒绝会让宿主把退出码报成 1，与任务状态无关。
2. **不是"某一次写入被挡"**，是 **WAL 文件格式 + 只读文件系统** 的组合必然性：`-shm` 一旦不在，无写权限的读者根本打不开库（§3），而"没有活写者"正是 `-shm` 不在的时刻（§4）。
3. 由此还暴露一个**误导性信号**：旧代码把"库打不开"归到 `WAIT=not_found`（exit 3）—— 同一信号也用于"任务不存在"，于是排查方向被引向「是不是 id 抄错了」。

## 2. Trae 侧策略（实地核对 `~/.trae-cn/permission/work/global.json`）

| 字段 | 值 | 含义 |
| :--- | :--- | :--- |
| `customProfiles.defaultCustomProfile.shellSandbox.enable` | `true` | shell 沙箱生效 |
| `filesystem.default` | `"read_only"` | 沙箱内命令**默认无写权限** |
| `resourceAuthorization.filesystem.readWrite` | `[]`（空） | 没有为 `~/.agent-ex` 开写权限 |
| `rules.commandRules` | `tail/echo/cd/make/lsof/xargs/bun/grep/head` → `execEnv:"host"` | **白名单外（含 `node`）都跑在沙箱里** |

⇒ `node …/wait-task.mjs` 不在白名单 ⇒ 沙箱内执行 ⇒ 对 `~/.agent-ex` 无写权限。

## 3. 机制：只读沙箱下，什么情况下能读、什么情况下不能（seatbelt 复刻矩阵）

复刻命令（**必须**配一条 `touch` 对照先证明策略真的生效）：

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny file-write* (subpath "<目录>"))' <cmd>
```

> ⚠️ **路径要写真实路径**：`/tmp` 是 `/private/tmp` 的软链，用 `/tmp/...` 做 `subpath` 会**静默不匹配** ⇒ 整个沙箱失效、全部"假通过"（本轮先踩了一次）。同理 `/var` → `/private/var`。

| # | 场景（库为 WAL 格式） | 结果 |
| :--- | :--- | :--- |
| M1 | `db + -wal + -shm`，禁写整个目录 | ✅ exit 0，数据正确 |
| W2 | 同上，只禁写 `-wal` | ✅ exit 0 |
| W1 | 同上，只禁写 `-shm` | ✅ exit 0 |
| W4 | 同上，`-wal`/`-shm` 都禁写（目录可写） | ✅ exit 0 |
| **M2** | **`-shm` 缺失**，禁写目录 | ❌ `wait-task: unable to open database file` → 旧代码记成 `WAIT=not_found` / exit 3 |
| **M4** | `-wal`/`-shm` 都不在，禁写目录 | ❌ 同上 |

**读结论**：只读连接**本来不需要**写 `-wal`/`-shm`（M1/W1/W2/W4 全过）。唯一失败入口是 **`-shm` 缺失/无效** —— 此时 SQLite 必须先做 WAL recovery（建 wal-index、必要时重写 `-wal`），那是写操作。

## 4. 为什么 `-shm` 不在是**常态**而不是意外

写者生命周期实证（`open → createTask → close`，观察目录）：

| 相位 | 目录内容 |
| :--- | :--- |
| 写者已打开 | `tasks.db` + `tasks.db-shm`(32KB) + `tasks.db-wal` |
| 写者 clean close 后 | **只剩 `tasks.db`**（checkpoint 后 16KB）——`-wal` 与 `-shm` **双双被删** |

而 agent-ex 的 server 是**按需开库**（每次工具调用 `openStore`，见 `submit.ts` / `status.ts` / `cancel.ts`），runner 只在任务期间持有连接 ⇒ **任务刚终态、runner 刚退出**这一刹那，恰好是"没有活写者"——也就是 `wait-task` 醒来的那一刻。

> 当前生产库之所以还有 4MB `-wal` + `-shm`，是因为 server 进程里**有 6 个连接没被回收**（见 §6），恰好把 shm 钉在磁盘上，**掩盖**了这个问题。它们一旦被 GC 回收，问题立刻显形。

## 5. 修复（三处，互补）

| 改动 | 内容 | 为什么这样切 |
| :--- | :--- | :--- |
| `src/store.ts` | `journal_mode` 由 **WAL → TRUNCATE**；`busy_timeout` 先设；切换失败**容忍**（不能因一次 status 把 server 打死） | 治本：静止态只剩 `tasks.db`（+0 字节 `-journal`），只读沙箱天然可读，**不依赖"恰好有写者活着"**。代价是失去 WAL 的「一写多读」，本场景写入都是单条短 UPDATE，可忽略 |
| `skills/.../wait-task.mjs` | 直接打开失败 → 把 `db(+wal)` 复制到**可写目录**后只读读副本（`DB_SOURCE=copy`）；新增 `--copy-dir` | 兜底：转换需要窗口（§6），且他人库/旧库可能仍是 WAL。副本目录可写 ⇒ SQLite 可在副本上自行 recovery |
| `wait-task.mjs` 退出码 | 新增 `WAIT=db_unreadable` / **exit 6**，与 `not_found`(3) 分开 | 环境问题不再伪装成"id 抄错"，并把处置写在 stderr 里 |

> 附注：**只有 WAL 是持久化的**（写在库头），DELETE/TRUNCATE/PERSIST 都是连接级设置。所以一次成功切换就永久摆脱 WAL 文件格式；其他客户端（`sqlite3` CLI）不改 PRAGMA 时用 DELETE，同属 rollback journal 格式，静止态同样不留 `-wal`/`-shm`。

## 6. 验证

| 验证 | 结果 |
| :--- | :--- |
| `npm test`（vitest 全量，含集成） | **141 passed / 16 files** |
| `wait-task.test.mjs`（含新增第 8 组沙箱用例） | **43 passed / 0 failed** |
| 真实库**副本**转换（44 行） | `-wal`(4MB)/`-shm` 消失、`tasks.db-journal` 0 字节、44 行完好、`task_mv9ni381_2f9a53=completed` |
| 转换后的库 + **禁写沙箱**跑 `wait-task` | ✅ exit 0（且未走副本；证明静止态可直接读） |
| 生产库就地转换（尝试） | ⚠️ `[store] journal_mode switch skipped: database is locked` —— 被 server 那 6 个未回收连接挡住。**代码容忍、读取照常**（设计预期）；重启 MCP server 后自动完成转换 |

## 7. 遗留 / 下一步

- **生产库目前仍是 WAL 格式**：需要"所有连接退出"的窗口才能转换 ⇒ **重启 MCP server**（宿主面板 disable → enable）。重启前由副本降级兜着（`DB_SOURCE=copy`），不影响复核。
- `openStore()` 在 `submit/status/cancel` 已显式 `close()`；**runner 刻意不关**（任务级短命进程，进程退出即正常关机路径，且不会累积）。
- 写者**崩溃**留下热 journal 时，读者仍需写权限回滚 —— 窗口极小，且被副本降级覆盖；暂不处理。
