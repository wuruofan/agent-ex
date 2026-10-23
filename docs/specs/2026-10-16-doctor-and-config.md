# doctor / config：把「通知通不通」变成一条命令能回答的问题

**状态**：✅ **已评审**（评审记录见 [`docs/reviews/2026-10-22-doctor-and-config-review.md`](../reviews/2026-10-22-doctor-and-config-review.md)；评审提出的 P0/P1 已修复并回填本 spec，Q1-Q6 结论见 §8）
**触发**：2026-10-13 → 10-15 连续 23 个任务零通知，事后复盘发现**证据早就存在，只是散在三处没人看**：
- `tasks.db` 的 `notify_failed`：布尔值，只知道"失败了"，分不清「关键词拒收」和「网络不通」；
- `~/.agent-ex/logs/runner-*.log`：`[notifier] feishu rejected: code=19024` —— 唯一能定位病因的证据面，但要手工翻 N 个文件；
- `config.json` 的 `notify.dry_run`：最常见的原因，一眼可见但没人去看。

**前置约束**：⚠️ 本 spec 的 Step 0（`--send` 自检卡）会**真实向飞书群发消息**。执行时必须确认目标群允许此类消息，且自检卡正文刻意不含产品名（见 §3.3）。

---

## 1. 目标与非目标

### 目标

1. **一次调用回答"通知通不通"**，输出 = 结论 + 病因 + 可复制的修复命令。
2. **让 agent 自己能排错**：同一套逻辑同时暴露为 MCP 工具，agent 无需手抄 shell 脚本。
3. **改配置不必重跑 init**：init 是全量覆盖式向导，"只改一个字段"必须有独立入口。
4. **一条命令切到 opencode 免费模型**（零密钥）。

### 非目标

- **不改通知的发送语义**（卡片结构、重试策略、限流处理一律不动）。
- **不做远程诊断**（不查飞书开放平台 API，只看本地配置 + 本地日志）。
- **不引入配置版本管理 / 事务性配置**（config 仍是单个 JSON 文件）。
- **不改 init 的"全量生成"定位**——只给它加安全网，不把它改造成增量工具。

---

## 2. 已确认的决策（评审时重点核这几条）

| # | 决策 | 理由 |
| :--- | :--- | :--- |
| D1 | 命令名 **`doctor`** | 指向动作、用户一看就懂（brew / npm / flutter 同款惯例）。曾考虑 `notify`，但它是动词当名词用，且子命令无一与"通知"这个对象对应。 |
| D2 | doctor **默认只读**，`--send` 才发消息 | 体检工具不该有副作用。 |
| D3 | `--fix` **只修确定性缺陷**，不动 `dry_run` | `dry_run` 是有文档的安全默认（偏好），不是缺陷。自动改成 `false` 等于替用户决定"往群里发真消息"。 |
| D4 | 历史失败记为 **warn** 而非 error | 历史不会消失。记 error ⇒ doctor 永远红 ⇒ 用户学会无视 ⇒ 体检工具本身失效。 |
| D5 | `config set` **只接受白名单字段** | 任意点路径写入意味着一次手抖就能写出坏 config，且这类错误往往到派发任务时才暴露。 |
| D6 | init 覆盖前**先校验后落盘** | 原先是"先写盘再校验"：校验失败时坏 config 已落盘、旧 config 已被覆盖且无法恢复。 |
| D7 | init 覆盖前的**变更预告放在写盘前一刻**（不是流程开头） | 开头还不知道新 config 长什么样，问"要不要覆盖"是让用户对未知后果点头。写盘前那一刻新旧两份都在手上，才能逐项列差异。 |
| D8 | 体检同时做成 **CLI 与 MCP 工具** | MCP 侧让 agent 自己能查（上次受影响的正是 agent，却在 SKILL.md 里手抄 node -e 脚本）。两者共用纯函数 ⇒ 行为必然一致。 |

---

## 3. 功能规格

### 3.1 `agent-ex doctor`（只读）

聚合三类证据：

**(a) config 自身**
- `notify.dry_run`：true → warn（附 `config set notify.dry_run false`）；false → ok
- `notify.keyword`：**四态判定**（`classifyKeyword()`，doctor 与 `--fix` 共用同一份规则）
  | 状态 | 判定 | severity | 可 `--fix` |
  | :--- | :--- | :--- | :--- |
  | 字段缺失 | 运行时由 `loadConfig` 填 `BRAND`（`config.ts` 的 `??= BRAND`），卡片**是带关键词元素的** | **info** | ❌ 不动 |
  | 显式空串 | `??=` 不替换空串 ⇒ 卡片**没有关键词元素** ⇒ 只要机器人开了闸门就必然拒收（19024） | **error** | ✅ |
  | 本工具的旧产品名（`agent-flow` / `agent-flow-ex`） | 改名前的遗留（2026-10-13→10-15 零通知的根因） | **error** | ✅ |
  | 其它自定义值 | **机器人登记什么词本地无从得知**，那是用户的界面（`brand.ts`） | **warn** | ❌ 不动 |
  - = `BRAND` → ok，并提示"是否与机器人登记词一致只有自检卡能验证"
  - ⚠️ **事实边界**：飞书机器人登记了什么词，本地无从得知。doctor 只能判「配置是否自洽」与「是否可证明投递不了」；**「与登记词是否一致」只有 `doctor --send` 能判定**（闸门匹配整卡，必须用正文干净的探针卡）
- `notify.feishu_webhook_url`：明文（非 `{env:VAR}`）→ error（凭证泄露风险，可 `--fix`）；占位符但变量不在 `.env` 也不在进程环境 → error
- `defaults.profile` 指向不存在的 profile → error（会导致每次派发都失败）
- `executors.<name>.bin` 不可执行 → error

**(b) executor 运行环境**
- 每个 executor 的 bin 用 `resolveBinPath()` 校验（与启动期校验同一套逻辑，避免"校验期通过、运行时 ENOENT"）

**(c) 历史通知失败**
- 扫 `logs/runner-*.log`，正则 `/feishu rejected: HTTP (\d+) code=(-?\d+) msg=(.*?)\s*\(attempt/`
- 聚合成：受影响任务数、按 `code` 的次数、每任务最近一次失败
- severity = **warn**（D4）

**输出契约**（CLI 与 MCP 一致）：
```jsonc
{
  "ok": false,                    // 有 error 级 finding 则 false
  "summary": "发现 2 个问题，通知链路不通",
  "findings": [
    { "severity": "error", "title": "…", "detail": "…", "fix": "agent-ex config set …", "fixable": true }
  ],
  "notify_failures": { "logs_with_rejects": 24, "by_code": { "19024": 69, "19001": 3 }, "recent": [ … ] }
}
```

### 3.2 `agent-ex doctor --fix`

可自动修的（**确定性缺陷**）：

| 修什么 | 怎么做 | 为什么算缺陷 |
| :--- | :--- | :--- |
| `notify.keyword` 是**显式空串** | 写 `BRAND` | 空串让卡片不带关键词元素 ⇒ 只要机器人开了闸门就必然 19024（唯一能证明"投递不了"的配置态） |
| `notify.keyword` 是**本工具的旧产品名** | 改回 `BRAND` | 改名遗留（2026-10-13→10-15 的 23 个零通知就是它造成的） |
| 明文 webhook 在 config.json | 原值写入 `.env`（`chmod 600`），config 改回 `{env:FEISHU_WEBHOOK_URL}` | config 可能被提交/同步，webhook 地址本身就是凭证 |

**不修的**：`dry_run`（D3）、`19024` 关键词与机器人侧不匹配（**不知道对方登记了什么**，只能提示）、`19001` webhook 地址失效（**要人去机器人后台换地址**）、`defaults.profile` 指向不存在（不知道该指向哪个）、**keyword 缺失**（运行时派生 `BRAND`，写死会冻结默认值、重新引入改名漂移）、**keyword 是自定义值**（用户的界面，`brand.ts`：「用户显式写 keyword 仍然优先」）。

**边界**：
- `.env` 里已有 `FEISHU_WEBHOOK_URL` 时**不覆盖**，只提示"请手工核对是否与 config 一致"（避免踩掉用户更晚改的值）
- 修完**再体检一次**并展示，让用户看到修后状态
- 写盘前走 `validateConfig()`，校验不过则不写
- 写 `.env` 后显式 `chmod 600`：`writeFileSync` 的 `mode` **只在创建文件时生效**，而 `.env` 在 init 之后几乎总是已存在（沿用旧权限）⇒ 不 chmod 就等于把凭证从 644 的 config.json 挪进 644 的 `.env`，防护强度没变
- 自动改了 keyword 时额外给一条**反悔路径**（"若你的机器人登记的就是旧名，请改回去"）

### 3.3 `agent-ex doctor --send`

发一张**正文刻意不含产品名**的自检卡，把飞书返回的 `code` 纳入结论。

⚠️ **为什么正文必须干净**：飞书关键词闸门匹配的是**整张卡片**（不是那行小字），worker 报告正文里偶然出现产品名就能过闸。2026-10-16 实测：live config 留着旧名 `agent-flow-ex`，连续 23 个任务 0 通知，却因某张卡的正文提到新名而误判为"已恢复"。**拿真实任务报告当探针是无效验证。**

**`code` 必须进结论**（不只是 stderr 日志）：MCP 侧 `agent_ex_doctor({send:true})` 的返回值里没有码，agent 就无法区分「改关键词」（19024）与「换 webhook 地址」（19001）——而这恰是 `FEISHU_ERRORS` 这张表存在的理由。

**探针卡必须用**有效**关键词**：keyword 缺失时运行时填 `BRAND`（`config.ts` 的 `??= BRAND`），探针卡若用原始的 `undefined` 就会不含关键词元素 ⇒ 明明能投递却报"被拒收"。

**CLI 路径必须先加载 `.env`**：`server.ts` 在模块顶层就分派了 `doctor`/`config` 子命令，**走不到 `main()` 里的 `loadEnvFile()`** ⇒ `{env:VAR}` 占位符解析不了、`--send` 在 init 默认产出的配置形态下**必然失败**（2026-10-22 实测：同一轮体检里前半句"✓ webhook 已配置（在 .env 里）"、后半句"✗ env placeholder not found"）。

### 3.4 `agent-ex config`

| 子命令 | 语义 |
| :--- | :--- |
| `list` | 列出 profiles（含哪个是 default）/ executors / notify 三项 / defaults |
| `set <key> <value>` | 改单个白名单字段 |
| `use <profile>` | 切默认 profile |

**白名单**（D5）：`notify.dry_run`(bool) · `notify.keyword`(str) · `defaults.profile`(str) · `defaults.timeout_sec`(int>0)

**`use` 的自动创建**：profile 不存在且命中内置名 `opencode-zen-free` 时自动创建：
- profile env = `OPENCODE_CONFIG_CONTENT` 用 `{model:zen-free}` 占位符 + `ZEN_FREE_PREFER=mimo,nemotron,ling`
- executor `opencode` 不存在时一并注册（`extra_flags: ["--auto"]`）
- 真实模型名在 **spawn 时**由 `zen-free.ts` 动态解析（模型集会轮换，配置里零硬引用）

---

## 4. init 的三项修复（与 doctor/config 同批）

| 缺陷（实测） | 修法 |
| :--- | :--- |
| 重跑 init **静默丢**旧 profile、把 `dry_run` 从 `false` 打成 `true`、把 `timeout` 从 5400 打成 3600 | 覆盖前**逐项列差异** + 解释后果 + 知情同意（D7） |
| 提示语只有一句 `Overwrite? [N]`，用户不知道要放弃什么 | 变更预告块：分「Removed」/「Rewritten」，并对 `dry_run false→true`、默认 profile 被删两种情况补一句后果说明 |
| **先写盘后校验**：自检失败时坏 config 已落盘、旧 config 已被覆盖且不可恢复 | 改成**先校验后落盘**（D6），失败则旧 config 原封不动；写前备份 `config.json.bak.<时间戳>` |

**为什么警告放在写盘前而不是开头**：开头问"要不要覆盖"是让用户对未知后果点头；写盘前那一刻新旧两份都在手上，才能说清"会丢什么"。

**`.env` 不在风险范围**：`writeEnvFile` 是**增量合并**（只补/更新采集到的 key），密钥不会因重跑 init 而丢失。变的只有 `config.json`。

---

## 5. 文件结构

| 文件 | 职责 |
| :--- | :--- |
| `src/doctor.ts` | 体检核心 + `--fix` + 历史日志扫描 + 飞书错误码表。**纯逻辑，无 IO 副作用**（除读文件与可选发卡） |
| `src/config-cmd.ts` | config 的 list/set/use + 内置 profile 定义 + 白名单 |
| `src/cli.ts` | CLI 渲染层（doctor / config 的输出格式） |
| `src/init-changes.ts` | init 覆盖前的 diff + 警告文案（**纯函数**，便于单测） |
| `src/config.ts` | 新增导出 `validateConfig(cfg)`（不读盘），供 init 写盘前校验 |
| `src/server.ts` | 新增 `agent_ex_doctor` MCP 工具 + `doctor`/`config` 子命令分派 |
| `src/store.ts` | schema 迁移（见 §6） |

**为什么不塞进 `src/tools/`**：`doctor` 有 CLI 与 MCP 两个入口，核心逻辑必须与渲染层分离；`src/tools/` 现有文件都是 MCP 工具的薄封装。

---

## 6. 附带修复：schema 迁移（本次会话早前提出，独立于 doctor）

### 6.1 问题

`CREATE TABLE IF NOT EXISTS` 只防"表不存在"，**不防"表存在但列过时"**——而后者才是升级时真正发生的事。实测：旧库只有 `id`/`status`，跑新版 SCHEMA 后新增列一个都没出现，写它们报 `table tasks has no column named X`，且报错在**运行期**而非启动期。

### 6.2 修法

列定义抽成 `COLUMNS` 数据（建表与迁移共用同一份真相），`migrateColumns()` 在 SCHEMA 之后按 `pragma table_info` 求差集、逐列 `ALTER TABLE … ADD COLUMN`。

### 6.3 三条实测的 SQLite 硬限制（直接决定了设计）

| 限制 | 实测报错 | 对设计的影响 |
| :--- | :--- | :--- |
| 不能加 `PRIMARY KEY` 列 | `Cannot add a PRIMARY KEY column` | 主键恒为 `id` |
| **不能加无默认值的 `NOT NULL` 列**（表非空时） | `Cannot add a NOT NULL column with default value NULL` | ⚠️ **7 个原本裸 `NOT NULL` 的列必须补 `DEFAULT`**（`''`/`0`）才能被加到旧库上 |
| `ADD COLUMN` 不能改类型/约束 | — | 只能"追加"不能"修改"（改类型需重建表，本次**不做**） |

### 6.4 验证

- 关掉迁移 → **4 条测试转红**（断言有判别力）
- 真实 45 行库被新代码打开 → 迁移 no-op，**45 行逐字未变**，`prompt` 列的 `dflt_value` 仍是 `null`（`ADD COLUMN` 不重写已有列）

---

## 7. 实测证据（不是推断）

| 主张 | 证据 |
| :--- | :--- |
| 旧名关键词导致 23 个任务零通知 | 扫 24 个 runner 日志：`code=19024` ×69、`code=19001` ×3 |
| live config 当时**根本没有** `notify.keyword` 字段 | doctor 在真实 config 上跑出的第一条 error |
| **`19001` 是新发现的错误码**，README 此前没有 | 扫日志时首次出现；含义 = `incoming webhook access token invalid`（webhook 地址本身失效） |
| `19001` 与 `19024` 修法完全不同 | 19024 改关键词；19001 **必须换 webhook 地址**（机器人被删/重建/地址轮换），改关键词无用 |
| init 会静默丢配置 | 拿 2-profile / `dry_run=false` / `timeout=5400` 的 config 实跑 init → 变成 1 profile / `true` / `3600` |
| init 先写盘后校验 | 实测输出 `config written but self-check failed: … not found or not executable` + exit 1，此时坏 config 已落盘 |
| 旧库加列会静默失效 | 实测：旧库跑新版 SCHEMA 后新列不存在，写入报 `no such column` |
| zen-free 实时清单可用 | 实测拉到 86 个模型，`{model:zen-free}` 解析成功 |

---

## 8. 评审要问的问题（**已裁决**）

评审记录：[`docs/reviews/2026-10-22-doctor-and-config-review.md`](../reviews/2026-10-22-doctor-and-config-review.md)（2026-10-22）。下表是裁决后的结论与落地状态。

| # | 问题 | 结论 | 依据 / 落地 |
| :--- | :--- | :--- | :--- |
| Q1 | `doctor` 的历史失败记 warn（D4）是否可接受？ | **接受，记 warn**，但必须修聚合文案 | 历史不会消失（记 error ⇒ doctor 永远红 ⇒ 用户学会无视）。文案已改：区分「受影响任务数」与「拒收次数」，并列出**每个码各自的修法**（19024 改关键词 / 19001 换地址互斥，只给次数最多的那个会把人引到无效动作） |
| Q2 | `--fix` 改 `keyword` 是否越权？ | **越权，已收窄**为四态（见 §3.1） | 实测 `--fix` 曾把用户与机器人侧一致的 `my-bot-word` 覆写成 `agent-ex`，把能投递的配置改成不能投递；且与 `brand.ts`「用户显式写 keyword 仍然优先」冲突。19024 的 69 次证据只支持「**陈旧产品名**是错的」，推不出「任何 ≠BRAND 都错」。**缺失**也不是错（运行时 `??= BRAND`），**显式空串**才是（必然 19024） |
| Q3 | `config set` 白名单（D5）是否够用？ | **够**，并已补非空校验 | 四个键覆盖了实测的所有需求；已补：`string` 类型拒绝空串/纯空白（否则 `config set notify.keyword ""` 能造出必然 19024 的状态） |
| Q4 | doctor 是否该**默认**就发卡？ | **不默认**（保持 D2） | `--send` 会真实 POST 到群；MCP 侧 `agent_ex_doctor` 由 agent 自行调用，默认发送等于让 agent 有权刷群 |
| Q5 | `opencode-zen-free` 内置 profile 的 `ZEN_FREE_PREFER` 默认值 | **保留 `mimo,nemotron,ling`** | 它是**软偏好**：命中前缀就用、未命中退回 `candidates[0]`，清单过期只会退化为"不挑食"，不可能导致失败。补的是可见性：`config list` 现在会列出 profile 的环境变量名 |
| Q6 | 迁移是否要支持"改已有列类型"（重建表）？ | **不做**（保持现状） | 真实库打开前后逐字节不变；`ADD COLUMN` 天然只增不改，需要改类型时再引入重建表 + `user_version`（§10.2 已记为缺口） |

---

## 9. 实现现状与本 spec 的关系

**⚠️ 实现先于 spec 落地**（本轮会话中在用户明确要求"先解决 schema 隐患"的前提下先行实现，未先出 spec —— 流程偏离，已如实记录）。

当前状态：**全部通过测试，已提交**（`bc5759f` 实现；`9a74cb2` 评审修复；`8d2b2db` `--fix` 校验崩溃修复）。

| 测试文件 | 覆盖 |
| :--- | :--- |
| `tests/store.test.ts`（+5） | schema 迁移：补列、读写可用、NOT NULL 靠 DEFAULT、幂等、空库 |
| `tests/init-changes.test.ts`（11） | diff 逻辑 + 警告文案的后果说明 |
| `tests/init-e2e.test.ts`（4） | init 端到端：预告展示 / 拒绝则不写盘 / 同意则备份 / 非法则不写盘 |
| `tests/doctor.test.ts`（30） | 各类 finding、keyword 四态、历史扫描聚合、错误码含义、`--fix` 边界（含"坏字段挡住写盘"的不崩溃/不落盘）、`--send` 的 code 回传 |
| `tests/config-cmd.test.ts`（15） | list / set 白名单与类型校验 / 非空校验 / use 自动创建 |
| `tests/cli-env.test.ts`（3） | **进程级**回归：CLI 子命令必须加载 `$AGENT_EX_HOME/.env`（P0-1）；`config list` 真的渲染 `bin_ok` |

全量：**215 passed / 21 files**，`tsc --noEmit` 0 error。

**变异验证**（证明断言有判别力）：关掉迁移 → 4 红；关掉变更预告 → 2 红；改成先写盘后校验 → 2 红；doctor 不扫历史 → 1 红；`--fix` 改 `dry_run` → 1 红；`config set` 不校验白名单 → 1 红；
**评审后新增**：撤掉 CLI 的 `loadEnvFile()` → 1 红；撤掉 `.env` 的 `chmodSync` → 1 红；`--fix` 覆写自定义 keyword → 2 红；`config set` 允许空串 → 1 红；notifier 不回传 `code` → 2 红；
**2026-10-23 新增**：去掉 `applyFixes` 里的 try/catch（让 `validateConfig` 的异常穿透）→ **2 红**（实测修复前是 Node 栈 + exit 1）；把 `.env` 写回提前到校验之前 → **1 红**。

> ⚠️ **测试不再依赖开发机环境**：原先 `config use opencode-zen-free` 的两个用例要求本机装了 `opencode` 且在 `PATH` 上，否则必红——"全绿"曾经只是那台机器的巧合。现在用例显式给一个存在的 `bin`，与 `PATH` 无关。

---

## 10. 尚未处理 / 已知缺口

1. **改已有列的类型/约束**无路径（需重建表）——真要改时再实现。
2. **无 `user_version` 版本号**：当前按"列差集"判定，幂等且自愈，不需要版本号；但若将来需要"按版本执行数据回填/不可逆变更"，那时必须引入版本表。
3. **`doctor` 不查飞书开放平台**——`19001`（地址失效）只能提示"去换地址"，无法自动确认地址是否还有效。
4. **SKILL.md 仍保留了旧的手抄 `node -e` 自检脚本**（已改为指向 `doctor`，但未删除历史条目）——若需彻底清理，是独立的一次改动。
5. **`19001` 之外的飞书错误码未穷举**：`FEISHU_ERRORS` 只收了实测见过的 6 个，未见过的码会原样显示 code 与 msg。
6. **doctor 判不了"机器人登记的词是什么"**：这是飞书侧的私有状态，本地无从得知。doctor 的定位因此是"排除可证明的故障 + 汇总历史证据"，**最终的匹配判定只能靠 `doctor --send`**（自检卡正文干净 ⇒ 不会被偶然提及产品名蒙混过关）。
7. **CLI 与 MCP 的环境加载路径曾经分叉**（已修）：MCP 侧 `main()` 里有 `loadEnvFile()`、CLI 侧没有 ⇒ 同一份配置，agent 查得通、命令行查不通。修复后两者共用同一套加载路径（`tests/cli-env.test.ts` 钉住）。

---

## 11. 评审处置（2026-10-22）

评审：[`docs/reviews/2026-10-22-doctor-and-config-review.md`](../reviews/2026-10-22-doctor-and-config-review.md)。裁决如下——**接受为主，其中 P1-2 的修法比评审建议更收窄**（理由：评审自己给的证据链指向更窄的结论）。

| # | 评审提出的问题 | 处置 | 说明 |
| :--- | :--- | :--- | :--- |
| P0-1 | CLI 子命令路径不加载 `.env`，`doctor --send` 必然失败 | **接受，已修** | `server.ts` 在子命令分派前 `loadEnvFile()`。新增**进程级**回归测试（`tests/cli-env.test.ts`）——单元测试测不出来，因为 `loadEnvFile()` 是另一个进程里做的事 |
| P1-2 | `keyword ≠ BRAND ⇒ error` 过宽，`--fix` 会破坏能投递的配置 | **接受，并收得更窄** | 改成四态（§3.1）。与评审建议的差别：**缺失**不判 error 也不可修（运行时 `??= BRAND` ⇒ 卡片是带关键词元素的；写死会冻结默认值、重新引入改名漂移）；**显式空串**才是 error+可修（唯一能证明投递不了的态）。自定义词降为 warn、不动 |
| P1-3 | `--fix` 写 `.env` 未 chmod，实测停在 644 | **接受，已修** | 补 `chmodSync(envPath, 0o600)`，与 `init.ts` 的 `writeEnvFile` 对齐（`mode` 只在创建文件时生效） |
| P2-4 | `--send` 未把飞书 `code` 纳入结论 | **接受，已修** | `notifier.ts` 的 `post()` 改为返回 `FeishuResult{ok, code, msg, httpStatus}`，`code` 与 `msg` 直接写进 finding 的 `detail`，修法跟着 `code` 走（`FEISHU_ERRORS`）。MCP 侧同样受益 |
| P2-5 | `listConfig` 的 `bin_ok` 恒为 true；`config list` 不显示 profile env | **接受，已修** | `bin_ok` 改用 `resolveBinPath()` 真实探测；`config list` 列出 profile 的环境变量**名**（值可能很大） |
| P2-6 | `applyFixes(home, report)` 的 `report` 从未使用 | **接受，已修** | 删掉死参数：规则由 `classifyKeyword()` 统一提供，doctor 与 `--fix` 不可能漂移 |
| P2-7 | `config set` 的 `as` 绕过类型；`keyword` 无非空校验 | **接受部分** | 已补**非空校验**（空串必然 19024）。`as never` 的类型逃逸保留但已由 `WRITABLE` 的 `spec.type` 兜底，未做大规模类型重构（收益不抵改动面） |
| P2-8 | 历史失败聚合单位混用，且只给一个码的修法 | **接受，已修** | 标题区分「受影响任务数」与「拒收次数」；`fix` 列出**每个码各自的修法**（19024 改关键词 / 19001 换地址互斥） |

**评审之外补的一条**：两个 `config use opencode-zen-free` 用例原本依赖本机装了 `opencode` 且在 `PATH` 上——"196 全绿"只是那台机器的巧合。已改为与 `PATH` 无关。
