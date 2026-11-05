# `CREATE TABLE IF NOT EXISTS` 不是迁移：旧库加列会静默失效

**状态**：✅ 已定位 + 已修复（2026-10-16）。改动：`src/store.ts`（列定义抽成 `COLUMNS` 数据 + `migrateColumns()` 差集补列）、`tests/store.test.ts`（第 5 组 5 条用例）。

## 0. 一句话

`CREATE TABLE IF NOT EXISTS` 只防"表不存在"，**不防"表存在但列过时"**——而后者才是升级时真正发生的事。本次给 `tasks` 加任何一列，升级过的用户都会在**运行期**撞 `table tasks has no column named X`，且报错不在启动期（本仓库当时也没有任何 `ALTER TABLE` / `user_version` / 迁移表）。

## 1. 机制复刻（实测，非推断）

旧库只有 `id` / `status`，再跑新版那种 `CREATE TABLE IF NOT EXISTS tasks (..., note TEXT, score INTEGER)`：

| 步骤 | 结果 |
| :--- | :--- |
| `CREATE TABLE IF NOT EXISTS tasks (id, status)` + 插一行 | 2 列 |
| 跑新版 SCHEMA（多 `note` / `score` + 索引） | **仍是 2 列**——整句被跳过 |
| `INSERT … (id, status, note)` | ❌ `table tasks has no column named note` |
| `SELECT note FROM tasks` | ❌ `no such column: note` |
| `SELECT id, status FROM tasks` | ✅ 正常（旧列不受影响） |

⇒ 症状是**局部的**：读旧列一切正常，只有碰到新列才炸，且报错点在某次具体操作里，看起来像"偶发 bug"。

## 2. 修复

列定义抽成 `COLUMNS: Record<string, string>`（建表与迁移共用同一份真相，避免两处漂移），`migrateColumns()` 在 `SCHEMA` 之后按 `pragma table_info` 求差集、逐列 `ALTER TABLE … ADD COLUMN`。

三条设计取舍：

| 取舍 | 理由 |
| :--- | :--- |
| **只在真有缺口时才动表** | 绝大多数 `open` 是 no-op，不产生写、不拿排他锁（沿用 `journal_mode` 那次"不因维护动作阻断工具调用"的思路） |
| **逐列一条、一列一 try** | 某列被占用/类型冲突时只跳过它，不让整次迁移回滚；缺列会在后续查询处明确报 `no such column`，**不会静默丢数据** |
| **不实现"重建表改列类型/约束"** | 那要先搬 45 行数据、失败窗口更大；收益只在真要改已有列时才出现（届时再说，不预先付这个复杂度） |

## 3. SQLite 的三条硬限制（实测，直接决定了上面的设计）

| 限制 | 实测报错 | 对本项目的含义 |
| :--- | :--- | :--- |
| 不能加 `PRIMARY KEY` 列 | `Cannot add a PRIMARY KEY column` | 主键恒为 `id`；要改主键只能重建表 |
| **不能加无默认值的 `NOT NULL` 列**（表非空时） | `Cannot add a NOT NULL column with default value NULL` | ⚠️ **这条直接改了 schema**：`prompt` / `project_path` / `executor` / `profile` / `timeout_sec` / `log_path` / `created_at` 原本是裸 `NOT NULL`，必须补 `DEFAULT` 才能被加到旧库上 |
| `ADD COLUMN` 不能改类型/约束 | — | 只能"追加"，不能"修改"（见上表第 3 行取舍） |

⇒ **`DEFAULT` 是迁移可行性的必要条件，不是可选风格**：7 个原本裸 `NOT NULL` 的列都补了零值默认值（`''` / `0`）。已验证这不改变语义——真实库被新代码打开后，`prompt` 的 `dflt_value` 仍是 `null`（`ADD COLUMN` 不重写已有列的默认值），45 行逐字未变。

## 4. 验证

| 验证 | 结果 |
| :--- | :--- |
| `npm test`（含新增第 5 组 5 条） | **151 passed / 16 files** |
| 迁移关掉（变异） | **4 条转红** ⇒ 断言有判别力，不是恒真 |
| 真实库（45 行）被新代码打开 | 迁移 no-op（列已齐），**45 行逐字未变**，`prompt` 列定义未被改写 |
| 夹具来源 | 每条用例从**手搓的残缺旧库**（只有 `id`/`status`）起，不复用当前 `SCHEMA` 造近似形状——否则会把待测迁移代码也带进夹具，出现"代码与夹具互相掩护"的假通过 |

## 5. 遗留

- 改**已有列**的类型/约束仍无路径（需重建表）。真要改时再实现，届时注意 `PRAGMA foreign_keys` 与重建窗口。
- 没有 `user_version` 之类的版本号。当前按"列差集"判定，是**幂等且自愈**的（缺什么补什么），不需要版本号；但若将来需要"按版本执行数据回填/不可逆变更"，那时必须引入版本表。
