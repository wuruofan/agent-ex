# 全量改名：agent-flow-ex → agent-peer

**状态**：📋 **待执行**（draft，2026-10-11）
**触发**：想把产品定位从「派发 worker」扩到「多 agent 协作（独立起草 / 相互review / spec-plan 讨论）」，现有名字只覆盖了前半。
**前置约束**：⚠️ **执行者必须坐在机器前**。本spec 的第 3 步会kill MCP server 并要求客户端重连；Trae 的 MCP 客户端在 server 进程退出后**不会自动重连**（见 `2026-08-29-trae-mcp-visibility.md` §11），无人值守时会把 MCP 变成永久不可用。**人不在机器边就不要开始。**

---

## 1. 目标与非目标

### 目标

1. 名字覆盖真实能力：既包含「派发 worker」，也包含「外部 agent 独立出方案 / 相互 review」。
2. 全部改名，不留混用：`agent_flow_*` 工具名、`~/.agent-flow-ex` 数据目录、`agent-flow-dispatch` skill 名、仓库/目录名、npm 包名。
3. 零数据丢失：库内 **98/98 行的 `log_path`** 与 6 行 `project_path` 在改名后仍可读。

### 非目标

- 不改任何功能行为。本次是纯改名 + 定位文案重写，**不改状态机、不改 prompt 语义、不加新能力**。
- 不引入「阶段」概念。spec/plan/开发/review 的差异应体现在 **prompt 的措辞**里，不写进代码枚举（见 §6）。

---

## 2. 名字选定

**候选评估**（npm 可用性已于 2026-10-11 用 `npm view <name> version`逐个查证）：

| 候选 | npm 状态 | 评价 |
| :--- | :--- | :--- |
| **`agent-peer`** | ✅ E404（未占用） | **选定。** `peer` 同时表达「外部」与「平级可互审」，正好对应「独立起草 + 相互 review」；技术调性与项目成熟度匹配 |
| `agent-mates` | ✅ 未占用 | 次选。更顺口亲和，但「mates」偏泛，暗示同类友好而非分工明确的搭档 |
| `agent-ex` | ✅ 未占用 | ❌ `-ex` 易读成 `agent.exe` / 「前一个 agent」，且丢掉协作语义 |
| `crew` | ✅ 未占用 | ❌ 太通用，无 agent 语义 |
| `agent-crew` | ❌ 已占 0.1.0 | — |
| `agentmates` | ❌ 已占 0.8.1 | — |
| `agent-ally` | ❌ 已占 0.1.4 | — |
| `crewkit` | ❌ 已占 1.1.9 | — |

**结论**：采用 `agent-peer`。包名 `agent-peer`，目录 `agent-peer`，数据目录 `~/.agent-peer`，skill 名 `agent-peer-dispatch`，工具前缀 `agent_peer_*`。

---

## 3. 执行前置检查（缺一不可，缺了别继续）

```bash
# 1) 没有活着的 runner（否则 SQLite 可能持有旧路径 / 正在写库）
ps aux | grep -E "dist/runner|claude -p|opencode run" | grep -v grep
#    必须无输出。若有，等它自然结束或确认可安全终止。

# 2) 备份数据目录（WAL 有 4.1MB 未 checkpoint，必须整目录备份）
cp -a ~/.agent-flow-ex ~/.agent-flow-ex.bak.$(date +%Y%m%d)
sqlite3 ~/.agent-flow-ex/tasks.db "PRAGMA wal_checkpoint(TRUNCATE);"   # 先落盘再搬

# 记录基线计数，供改完后比对
sqlite3 ~/.agent-flow-ex/tasks.db "select count(*) from tasks;"                            # 期望 98
sqlite3 ~/.agent-flow-ex/tasks.db "select count(*) from tasks where log_path like '%agent-flow-ex%';"   # 期望 98（全部行都带旧名）
sqlite3 ~/.agent-flow-ex/tasks.db "select count(*) from tasks where project_path like '%agent-flow-ex%';" # 期望 6
```

> 为什么先 `wal_checkpoint`：`tasks.db-wal` 有 4.1MB。直接 `mv` 目录带着 `-wal`/`-shm` 本身是安全的，但**跑过 checkpoint 后再改**能让「改完数据是否完整」变成可校验的事实，而不是祈祷。

---

## 4. 执行步骤（严格按序，每步都有验证）

### Step 1 · 代码与标识符改名

全量替换（仅限精确匹配，**不要碰 `.agent-flow-ex` 里的历史数据**）：

| 模式 | 替换为 | 影响面 |
| :--- | :--- | :--- |
| `agent_flow_` | `agent_peer_` | 111+50+50+36+16+16+11+1 处（工具名、测试、文案） |
| `.agent-flow-ex` | `.agent-peer` | 64 处（数据目录默认值 + 文案） |
| `agent-flow-dispatch` | `agent-peer-dispatch` | 61 处（skill 名 + 软链） |
| `agent-flow-ex` | `agent-peer` | 其余（包名、仓库名、文案） |

关键文件（改完必须逐个确认）：`src/paths.ts:6`、`src/server.ts`（5 个工具注册）、`skills/agent-flow-dispatch/**`、`scripts/install-skill.sh`、`tests/*.test.ts`、`package.json`（`name` + `repository.url`）、`README.md`。

**验证**：
```bash
grep -rn "agent_flow_\|agent-flow-ex\|agent-flow-dispatch" \
  --include="*.ts" --include="*.mjs" --include="*.sh" --include="*.json" \
  . | grep -v node_modules | grep -v "^./docs/"     # 期望 0 命中
npm run typecheck                # 期望 0 error
npm test                         # 期望全绿（当前 127）
```

### Step 2 · 数据目录改名 + 数据库迁移

目录改名后，**必须迁移库里的绝对路径**，否则 98 行 `log_path` 失效（复核历史任务时读不到日志）：

```bash
mv ~/.agent-flow-ex ~/.agent-peer

sqlite3 ~/.agent-peer/tasks.db <<'SQL'
UPDATE tasks SET log_path     = replace(log_path,     '/.agent-flow-ex/', '/.agent-peer/');
UPDATE tasks SET project_path = replace(project_path, '/workspace/agent-flow-ex', '/workspace/agent-peer');
UPDATE tasks SET prompt       = replace(prompt,       'agent-flow-ex', 'agent-peer');
UPDATE tasks SET result       = replace(result,       'agent-flow-ex', 'agent-peer');
UPDATE tasks SET question     = replace(question,     'agent-flow-ex', 'agent-peer');
SQL
```

**验证**（三条都要过）：
```bash
sqlite3 ~/.agent-peer/tasks.db "select count(*) from tasks;"                          # 与基线一致（98）
sqlite3 ~/.agent-peer/tasks.db "select count(*) from tasks where log_path like '%agent-flow-ex%';"   # 期望 0
sqlite3 ~/.agent-peer/tasks.db "select count(*) from tasks where log_path like '%agent-peer%';"    # 期望 98
```

### Step 3 · skill 软链修复（改名前必做）

两个软链指向旧目录，改名后会悬空。**先删旧链再重建**：

```bash
for d in ~/.workbuddy/skills ~/.trae-cn/skills; do
  [ -L "$d/agent-flow-dispatch" ] && rm "$d/agent-flow-dispatch"
done
cd ~/workspace/agent-peer
./scripts/install-skill.sh ~/.workbuddy/skills ~/.trae-cn/skills

ls -la ~/.workbuddy/skills/agent-peer-dispatch   # 应指向新仓库路径
ls -la ~/.trae-cn/skills/agent-peer-dispatch
```

### Step 4 · 目录与 git remote

```bash
cd ~/workspace
mv agent-flow-ex agent-peer
cd ~/workspace/agent-peer
git remote set-url origin git@github.com:wuruofan/agent-peer.git
```

**GitHub 仓库改名**（Settings → General → Repository name → Rename）：
- GitHub 会给旧 URL 建 **301 重定向**，`git clone` 老地址仍可用；
- 但 **Actions / Dependabot / 其他集成不被重定向覆盖**，需手动更新；
- 若暂时不想动远端，可先只做本地 `git remote set-url`，等下次推送前再改仓库名。

### Step 5 · 重建 dist 并重连 MCP

```bash
npm run build     # 必须：dist 里还是旧工具名
```

⚠️ **本步是整个spec 里唯一需要人操作的一步**：
1. 更新宿主 MCP 配置里的 `command` / `args` 路径（`args` 指向 `agent-peer/dist/server.js`）；
2. 在 MCP 面板 disable → re-enable（或重启 IDE）迫使客户端重连；
3. 调 `agent_peer_version` 验证 —— 若还报「无此工具」，说明客户端仍连着旧 server，需再 disable/re-enable 一次。

> 为什么不直接用 `agent_peer_restart`：该工具让 server 退出，注释里假设「host 会在 stdin/stdout 关闭后 respawn」（`src/tools/restart.ts:6-8`）。**这个假设在 Trae 下不成立**（客户端不自愈），所以在 Trae 上用它等于自杀。必须走 UI 面板重连。

### Step 6 · 定位文案重写（这次改名的真正价值）

改名本身不解决「名字只覆盖 worker」的问题。以下两处必须重写：

**a) README 第一段** —— 现在是「把 AI 编程 Agent 当作后台任务来调度的 MCP Server」，只讲派发。要改成覆盖三种协作形态：

| 形态 | 怎么用 |
| :--- | :--- |
| **派发实现** | `submit(prompt=自包含工单)` → worker 独立完成 → `wait-task.mjs` 带回结果 |
| **独立起草方案** | `submit(prompt="读 docs/ 与代码，产出设计方案写到 docs/plans/xxx.md")` |
| **相互 review** | `submit(prompt="审阅 docs/plans/xxx.md，按可执行性/遗漏/矛盾列问题")` |

**b) SKILL.md 新增「什么时候用协作、什么时候自己干」一节** —— 现在只教「怎么派活」。要写清：
- 返工量小且强依赖当前上下文 → 自己做（现有铁律，别丢）
- 需要独立视角 / 方案不显然 → 派出去当「第二意见」
- spec/plan 阶段的方案起草与 review → 派出去，落文件而不是留在对话里

---

## 5. 验收标准

| # | 标准 | 验证方式 |
| :--- | :--- | :--- |
| 1 | 代码里无旧名残留 | §4 Step 1 的 grep 期望 0 命中 |
| 2 | typecheck + 全量测试通过 | `npm run typecheck && npm test`（127 全绿） |
| 3 | 数据零丢失 | `tasks` 总数与基线一致（**98**）；`log_path like '%agent-peer%'` = 98，`like '%agent-flow-ex%'` = 0 |
| 4 | 历史日志仍可读 | 随便挑一个终态任务，`agent_peer_status` 返回的 `result` 与改前一致 |
| 5 | skill 在两个宿主都加载 | `ls -la ~/.workbuddy/skills/agent-peer-dispatch ~/.trae-cn/skills/agent-peer-dispatch`（两条都须指向新仓库路径） |
| 6 | MCP 可用 | `agent_peer_version` 返回的 `gitSha` 等于改名后的 HEAD |
| 7 | README/skill 定位覆盖三种协作形态 | 人工核对 §4 Step 6 表格 |

---

## 6. 设计说明：为什么这些都不写进代码

「spec 阶段 / 开发阶段 / review 阶段」的差异，**只体现在 prompt 的措辞里**，不新增 `--phase` 参数、不在状态机里加 `reviewing` 状态。

理由是本项目最早的一条不变量：**派发方（Scheduler）完全外置、agent-flow-ex 几乎 0 改动**（见 `2026-08-29-self-loop-design.md` §2）。一旦把阶段写进代码：
- 调度员（任何宿主）都要理解这套枚举，破坏「prompt 即规约」；
- 想换个派发方就得改代码，回到「派发方不可替换」的老问题。

**阶段是 prompt 的语义，不是 API 的参数。** 这一条在改名的同时必须守住，否则新名字承诺的「多阶段协作」反而被实现方式绑死。

---

## 7. 风险

| 风险 | 缓解 |
| :--- | :--- |
| **MCP 断连后无人重连**（最严重） | §4 Step 5 明确要求人操作；无人值守时**不要开始** |
| `agent_peer_restart` 在 Trae 下等于自杀 | 不用它，走 UI 面板 disable → re-enable |
| 98 行 `log_path` 失效 | §4 Step 2 的 SQL 迁移 + 验收第 3/4 条 |
| 4.1MB WAL 未落盘导致迁移不完整 | §3 先 `PRAGMA wal_checkpoint(TRUNCATE)` |
| GitHub 旧链接 404 | Rename 后 GitHub 自动 301；Actions/集成需手动更新 |
| `npx skills` 用户装的是旧名 skill | skill 走 GitHub 分发，改名后需重新 add；README 已提示先`--list` |
| 遗漏某个软链目录 | Step 3 显式列出两个宿主；验收第 5 条逐个 `ls` 确认 |

---

## 8. 回滚

```bash
# 1) 停 MCP（面板 disable）
# 2) 代码
cd ~/workspace && mv agent-peer agent-flow-ex
cd agent-flow-ex && git remote set-url origin git@github.com:wuruofan/agent-flow-ex.git
npm run build
# 3) 数据
mv ~/.agent-peer ~/.agent-flow-ex
sqlite3 ~/.agent-flow-ex/tasks.db <<'SQL'
UPDATE tasks SET log_path     = replace(log_path,     '/.agent-peer/', '/.agent-flow-ex/');
UPDATE tasks SET project_path = replace(project_path, '/workspace/agent-peer', '/workspace/agent-flow-ex');
SQL
# 4) 软链
for d in ~/.workbuddy/skills ~/.trae-cn/skills; do rm -f "$d"/agent-peer-dispatch; done
./scripts/install-skill.sh ~/.workbuddy/skills ~/.trae-cn/skills
# 5) MCP 配置改回旧路径 → 面板 disable → re-enable
```

备份目录 `~/.agent-flow-ex.bak.<日期>` 在 Step 3 已创建，回滚时若迁移结果不符预期可直接整目录还原。

---

## 9. 待确认

- [ ] 名字 `agent-peer` 是否最终确认？（若改主意只需替换全文 `agent-peer`，但**先改 `agent_peer_` 工具名会留下已发布版本的兼容负担**——包未发布前改是零成本，发布后就难了）
- [ ] GitHub 仓库是否本次一起改名？还是先只改本地、推送前再改？
- [ ] 是否需要在README 顶部加一段「旧名 → 新名」迁移说明（面向已装过旧 skill 的用户）？