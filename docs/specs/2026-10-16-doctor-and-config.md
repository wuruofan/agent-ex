# doctor / config：把「通知通不通」变成一条命令能回答的问题

**状态**：✅ **已评审**（评审记录见 [`docs/reviews/2026-10-22-doctor-and-config-review.md`](../reviews/2026-10-22-doctor-and-config-review.md)；评审提出的 P0/P1 已修复并回填本 spec，Q1-Q6 结论见 §8）
**后续变更**：2026-10-23 定稿的 CLI 重组与校验收口见 **§12（已实现）**；§3.4 描述的是当前已提交的形态。第二轮评审（同日）指出的 P1/P2/P3 已并入 §12 与 §10。
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
| D9 | **按对象拆分命令**：`config` = 全局标量 + executor；`profile` = profile 生命周期 | 原 `config use` 一次做三件结构性写入（补 executor、写 profile env、切默认）+ 一次切换，语义混杂；且 profile env 创建后**没有任何编辑入口**（`ZEN_FREE_PREFER` 只能手改 JSON） |
| D10 | `config set` 用**键形状白名单**：3 个固定键 + `executors.<name>.bin`，**不引入通用点路径** | 既保留 D5 的防手抖边界，又给"坏 bin 挡住一切"一个定点修复入口（原先只能跑全量 `init`） |

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

### 3.4 `agent-ex config`（当前已提交形态；CLI 重组见 §12.1）

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

⚠️ 这套形态有三个已确认的问题，修复方案在 §12.1：`use` 混合了"物化预设"与"切换"；`defaults.profile` 与 `use` 是两个切默认入口；profile env 没有编辑入口。

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
| `src/config-cmd.ts` | config 的 list/set + profile 的 list/use/create/set + 内置 profile 定义 + 键白名单（§12.1 重组后仍是一个文件：共用 `readConfig`/`writeConfig`） |
| `src/cli.ts` | CLI 渲染层（doctor / config / profile 的输出格式） |
| `src/init-changes.ts` | init 覆盖前的 diff + 警告文案（**纯函数**，便于单测） |
| `src/config.ts` | 导出 `validateConfig(cfg)`（不读盘，供 init 写盘前校验）+ `collectConfigIssues(cfg)`（§12.2，规则的唯一真相源） |
| `src/server.ts` | 新增 `agent_ex_doctor` MCP 工具 + `doctor`/`config`/`profile` 子命令分派 |
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
| zen-free 实时清单可用 | 实测拉到 85 个模型（2026-10-23），`{model:zen-free}` 解析成功 |

---

## 8. 评审要问的问题（**已裁决**）

评审记录：[`docs/reviews/2026-10-22-doctor-and-config-review.md`](../reviews/2026-10-22-doctor-and-config-review.md)（2026-10-22）。下表是裁决后的结论与落地状态。

| # | 问题 | 结论 | 依据 / 落地 |
| :--- | :--- | :--- | :--- |
| Q1 | `doctor` 的历史失败记 warn（D4）是否可接受？ | **接受，记 warn**，但必须修聚合文案 | 历史不会消失（记 error ⇒ doctor 永远红 ⇒ 用户学会无视）。文案已改：区分「受影响任务数」与「拒收次数」，并列出**每个码各自的修法**（19024 改关键词 / 19001 换地址互斥，只给次数最多的那个会把人引到无效动作） |
| Q2 | `--fix` 改 `keyword` 是否越权？ | **越权，已收窄**为四态（见 §3.1） | 实测 `--fix` 曾把用户与机器人侧一致的 `my-bot-word` 覆写成 `agent-ex`，把能投递的配置改成不能投递；且与 `brand.ts`「用户显式写 keyword 仍然优先」冲突。19024 的 69 次证据只支持「**陈旧产品名**是错的」，推不出「任何 ≠BRAND 都错」。**缺失**也不是错（运行时 `??= BRAND`），**显式空串**才是（必然 19024） |
| Q3 | `config set` 白名单（D5）是否够用？ | **不够，裁决已更正**（见 §12.3） | 评审时判"够"，依据是"缺陷都能被现有键修到"。反例：坏 `executor.bin` 是**阻断点**——它会让 `--fix` 的整份校验失败、也让 `config set` 报无关字段的错，而白名单里没有定点入口，唯一出路是跑全量 `init`。修法：加键形状 `executors.<name>.bin`（`<name>` 必须已存在、值必须过 `resolveBinPath`）。另补：`string` 类型拒绝空串/纯空白（否则 `config set notify.keyword ""` 能造出必然 19024 的状态） |
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
| `tests/init-e2e.test.ts`（8） | init 端到端：预告展示 / 拒绝则不写盘 / 同意则备份 / 非法则不写盘 / **只探测到一个 CLI 时不再问"用哪个"** / 探测到两个时才问 / **yes-no 用 (y/N) 形式** / **长提示分多行** |
| `tests/init.test.ts`（19） | `detectAgentClis` / `renderDetectedClis`：只列真正找到的、展示用标记区分找到与没找到、没找到时明确说没有；**init 的用户可见输出不得含中文** |
| `tests/ansi.test.ts`（8） | 颜色开关：`NO_COLOR`（任意值）⇒ 关、非 TTY ⇒ 关、`FORCE_COLOR` ⇒ 强制开、`NO_COLOR` 优先于 `FORCE_COLOR`、关闭时原样返回 |
| `tests/doctor.test.ts`（38） | 各类 finding、keyword 四态、历史扫描聚合、错误码含义、`--fix` 边界（含"坏字段挡住写盘"的不崩溃/不落盘）、`--send` 的 code 回传、**两处假阴性的回归**、webhook 四态、缺 bin 的 executor |
| `tests/config-cmd.test.ts`（37） | list / set 白名单与类型校验 / 非空校验 / 严格整数 / `executors.<name>.bin` / `profile use`·`create`·`set`（含键约束与深拷贝） |
| `tests/config-issues.test.ts`（14） | `collectConfigIssues`：每条规则一个 code、每条 issue 带 fix、total（吃未校验 JSON 不抛错） |
| `tests/cli-env.test.ts`（12） | **进程级**回归：CLI 子命令必须加载 `$AGENT_EX_HOME/.env`（P0-1）；`config list` 真的渲染 `bin_ok`；未预期异常走兜底且无栈帧；`profile` 子命令；`--fix --send` 只发一张卡；**加载 store 模块不 require node:sqlite**（懒加载） |

全量：**286 passed / 23 files**，`tsc --noEmit` 0 error。

> ⚠️ 这个数字**不是无条件稳定**：`tests/cli-env.test.ts` 会 spawn `tsx` 子进程，vitest 默认 `testTimeout` 是 5s——并行满载时实测出现 `209 passed / 4 failed / 4 skipped`。已加 `testTimeout: 30_000`（§12.5）。

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
8. **`config.example.json` 当前不可信**（2026-10-23 决定**暂缓**修）：claude 的 bin 是别人的家目录路径，直接喂 `validateConfig()` 会抛 `not found or not executable`；且除 `keyword === BRAND` 外没有任何断言钉住它的形状。"把 bin 改成 `claude`"这一行**不构成修复**——它只是换成 PATH 解析，机器上没装 claude 时照样校验失败。真要修就一次修到位：路径用必然存在的 `node` 并注明"替换成你的 agent CLI" + `satisfies Config` 编译期钉形状 + 一条语义测试（executor 引用、`timeout_sec` 正整数、webhook 必须占位符；**不**断言 bin 存在）。
9. **不做 JSON Schema**（2026-10-23 决定）：Schema 只能表达形状，表达不了"`profile.executor` 必须存在""bin 必须可执行"这类跨字段关系，因此是 `collectConfigIssues()` 的严格子集，天然会漂。且 `$schema` 指向不稳定（相对路径落到 `~/.agent-ex/` 下不存在、绝对路径绑死机器、URL 需外部托管）。等 CLI 面稳定后，若仍需要编辑器补全，再以"schema 先跑形状、关系检查后跑"的派生形态引入，并用 fixture 双向钉。
10. **未使用的 executor 缺失会阻断启动**（待定）：`validateConfig()` 校验**全部** executor，所以哪怕默认 profile 用 claude 且它完全正常，只要残留一个不可用的 `opencode` executor，`loadConfig()` 依旧抛错、server 起不来。实测（2026-10-23）：default=claudecode（bin `/bin/ls` 可用）仍 `THREW: executor "opencode" bin "opencode" not found…`。候选修法：启动只硬校验默认 profile 引用的 executor，其余由 doctor 报 error、派发到该 profile 时再失败。**这会改变启动语义，尚未裁决**。
    - ⚠️ 本轮把 `config set executors.<name>.bin` 做成定点入口后，这条缺口的**可操作性**变好了（能定点改路径），但**启动仍会被它挡住** —— 未裁决的部分没变。
11. **`ZEN_FREE_PREFER` 是静态软偏好**（待定）：模型 id 每次 spawn 动态解析（2026-10-23 实测清单 85 个），但"挑哪个家族"是创建时写死的 CSV。实测：`mimo,nemotron,ling` → `mimo-v2.6-flash-free`，`deepseek` 前缀 → `deepseek-v4.1-flash-free`，**空值 → `beam-free`**（字母序第一，并非合理默认）。API 的 `created` 字段在全部条目上相同，没有可用的"新度/质量"信号。候选：① 内置默认改 `deepseek,mimo,glm,nemotron`；② 家族内按数字版本降序（否则 `deepseek-v4-*` 与 `deepseek-v4.1-*` 并存时字母序会选中旧版）；③ 给已有 profile 一个显式 `profile set` 入口（§12.1 已实现）。**①②尚未裁决**（③ 已落地：现在可以直接 `agent-ex profile set <profile> ZEN_FREE_PREFER deepseek,mimo,glm`）。

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

---

## 12. 后续变更（2026-10-23 定稿，**已实现**）

本轮只动 CLI 面与校验层，**`config.json` 结构不变、无数据迁移**。

### 12.1 CLI 按对象重组（D9）

```
config list                                # 快照：globals / executors / profiles / 默认
config set notify.dry_run false
config set notify.keyword agent-ex
config set defaults.timeout_sec 5400
config set executors.<name>.bin <path>     # 定点修复坏 bin（<name> 必须已存在）

profile list
profile use <name>                                     # 只切换，必须已存在
profile create <builtin> [--bin <path>] [--use]       # 物化预设；默认不切默认，--use 一步到位
profile set <name> <KEY> <value>           # profile env 字段（如 ZEN_FREE_PREFER）
```

规则：

- **`defaults.profile` 移出 `config set` 白名单**，切默认只保留 `profile use`——两个入口并存本身就是概念重复。
- `profile use` 遇到不存在的名字：命中内置名 → 提示 `profile create <name> --use`（一步到位）；否则列出现有名字。
- `profile create` 默认只创建，完成后打印下一条命令（`profile use …`）；**`--use` 让"物化 + 切默认"合为一条命令**（同一次写盘，不会留下半截配置）。
  - 为什么不让 `profile use` 自动物化：`create` 可能需要 `--bin`（`opencode` 常装在 `~/.opencode/bin`，不在 `PATH`），而 `use` 应当是**纯切换无副作用**——否则"只想切一下"也会往 config 里写新 profile 和 executor，与 D9 拆分的初衷相悖。
- **`profile create --bin <path>` 是必需的重载，不是可选装饰**：内置 executor（`opencode`）不在 `PATH` 时，`validateConfig` 会在落盘前拒绝，executor 条目因此不存在，而 §12.3 的 `executors.<name>.bin` 要求 name 已存在 ⇒ 用户被两条规则夹死。`useProfile` 里已有 `opts.bin`，只需接到 CLI。没有 `--bin` 且探测不到时，错误信息必须**直接给出** `profile create <builtin> --bin <path>`。
- **`profile set` 必须有键约束**（否则 D5/D10 的"防手抖"在 env 上开了更大的口子）：
  - key 匹配 `^[A-Z][A-Z0-9_]*$`，value 非空；
  - 拒绝 `NODE_OPTIONS`、`PATH`、`LD_*`、`DYLD_*`——这些是 worker 的启动/加载面，写进去等于允许任意代码执行或换掉解释器；
  - `OPENCODE_CONFIG_CONTENT` 单独校验：必须能 `JSON.parse` 且含 `model`；对内置 zen-free profile 还必须保留 `{model:zen-free}` 占位（否则动态解析被绕过，配置里又出现硬编码模型）；
  - 物化内置 profile 时必须**深拷贝** `BUILTIN_PROFILES` 的 `env`（当前 `config-cmd.ts:163` 共享引用，`profile set` 原地改会污染同进程里的常量）。
- **不做**：通用点路径（如 `profiles.x.env.Y` 任意写）、`profile remove`/`rename`、`config use` 兼容别名（当前几乎只有一个使用者，留 shim 只会让两套语义长期并存）。
- 迁移成本**不止**"CLI 分派 + 测试调用面"，完整清单见 §12.5；README 与 SKILL 必须与代码同一次提交。

### 12.2 校验单一真相源（`collectConfigIssues`）

**问题**：doctor 手写 4 类检查、`config.ts` 手写 8 条规则，两份各写各的。实测两处假阴性：

- `defaults.timeout_sec: "3600"` → **doctor 报"一切正常"、exit 0**，同一份配置 `loadConfig` 抛 `must be a positive integer`、server 起不来；
- `defaults: {}` → doctor **一条都不报**（自有检查是 `if (defProfile && …)`，字段缺失时不触发），`loadConfig` 抛 `defaults.profile "undefined" not found`。

```ts
export interface ConfigIssue { code: string; message: string; fix?: string }
export function collectConfigIssues(cfg: unknown): ConfigIssue[]  // total：吃未校验 JSON，绝不 throw
export function validateConfig(cfg: Config): void                 // 有 issue 即 throw issues[0].message（文案不变）
```

**签名必须是 `unknown`**：doctor 读的是磁盘上的原始 JSON，`defaults`/`notify` 可能整块缺失，函数不能假设已通过校验。

规则与 code **一一对应，一条不漏**（旧稿只列了 6 个 code，`executors.empty`/`profiles.empty` 和"`defaults.profile` 缺失"都没有归属）：

| code | 触发条件 |
| :--- | :--- |
| `executors.empty` | `executors` 缺失或空 |
| `profiles.empty` | `profiles` 缺失或空 |
| `executor.bin` | 某 executor 的 bin 缺失/非字符串/不可执行 |
| `profile.executor` | 某 profile 指向不存在的 executor |
| `defaults.profile` | **缺失**或指向不存在的 profile（两种都要报） |
| `notify.webhook` | webhook 缺失（形状问题见 §12.4） |
| `defaults.timeout_sec` | 非正整数 |

doctor 的去重必须**按实际产出**：维护 `emittedCodes`，只有"本次确实 push 了更详细 finding"的 code 才跳过。**不允许静态跳过名单**——静态名单本身就是第二份真相，`defaults.profile` 的漏报正是它造成的（名单里跳过、自有检查又因子段缺失不触发）。

`??= BRAND` 留在 `loadConfig`（归一化），**不能进 `collectConfigIssues`**：一旦把缺省填进去，keyword 的"字段缺失"态在 doctor 眼里永远等于 `BRAND`，info 档会消失。每个 issue 转 finding 时必须带 `fix`（可复制执行），否则 `timeout_sec` 会被标红却无从下手。

### 12.3 `executors.<name>.bin` 定点修复（D10 / Q3 更正）

键形状白名单：`executors.<name>.bin`，约束三条：

1. `<name>` 必须已存在于 `cfg.executors`——不静默创建，未知名字报错并列出现有 executor；
2. 值必须通过 `resolveBinPath()`——写一个不可执行的路径正是在重犯要修的错；
3. 不引入 `executors.*` 通配，其余路径仍拒绝。

doctor 的 fix 文案随之从"跑 `init`"改成定点命令；`init` 降为"多个 executor 一起改"时的备选。

与 §12.1 的互动：本键要求 name 已存在，因此"装了但不在 `PATH`"必须由 `profile create --bin` 解决——两条路径不能互相堵死。

### 12.4 报告与实际能力对齐

| 问题（实测） | 修法 |
| :--- | :--- |
| 默认 profile 不存在标了 `fixable: true`，但 `applyFixes` 没有这个分支，`--fix` 输出"没有可自动修复的问题" | `fixable` 由 `applyFixes` 的**能力注册表**派生（同一个 registry 既驱动修复又驱动标记），不再手写 |
| 明文 webhook 标 `fixable: true`，但 `applyFixes` 只处理 `^https://`；`{env:bad_lower}` 被报成"明文凭证泄露"，`--fix` 静默不动 | 拆成两种：**明文**（`^https?://`）才是凭证泄露且可修；**占位符形状不合规**（非 `{env:大写}`）单独判 error、只给文案不可修 |
| `doctor.ts:376` 的 fix 文案是 `agent-ex config use …`，§12.1 之后该命令不存在 | 改成 `agent-ex profile use <存在的 profile>`（进 §12.5 迁移清单，靠测试钉住文案可执行） |
| `--fix --send` 先发"修复前"的自检卡（可能注定被拒），再修 | 先修、再 `loadConfig` 复验、最后**只发一张**修复后的卡；卡里的 `code` 才是用户需要的结论 |
| CLI 错误边界仍打印栈帧（`8d2b2db` 只挡住了 Node 页脚） | `e instanceof Error ? e.message : e`；栈留给调试开关或不打印，测试断言输出不含 `at ` 栈行 |
| `parseInt` 宽松：`"3600abc"` → 3600、`"3.7"` → 3 | 先 `/^\d+$/` 再 `Number()`，非法输入直接拒绝 |

### 12.5 测试稳定性与迁移清单

**测试稳定性（实测）**：全量并行跑两次均为 `209 passed / 4 failed / 4 skipped`，失败的 4 条全是 `tests/cli-env.test.ts` 的 `Test timed out in 5000ms`；单独跑该文件 4/4 通过、约 1.3s。原因：它们 spawn `tsx` 子进程，而 `vitest.config.ts` 没有设 `testTimeout`，默认 5s 在满载并行时不够。这与 §9 刚修掉的"PATH 巧合"是同一类问题——"全绿"不能是某台机器空闲时的属性。修法：`testTimeout: 30_000`（或对该文件单独设），并让 §9 的全量数字只在干净 worktree 上引用。

**迁移清单（已与代码同批完成）**：

| 文件 | 改了什么 |
| :--- | :--- |
| `README.md` | `config use` → `profile use` / `profile create` / `profile set`；`config set` 白名单补 `executors.<name>.bin`、去掉 `defaults.profile` |
| `skills/agent-ex-dispatch/SKILL.md` | executor bin 的建议从"手改 config.json"改成 `agent-ex config set executors.<name>.bin <绝对路径>` |
| `src/doctor.ts` | fix 文案 → `agent-ex profile use <存在的 profile>`；executor bin 的 fix → `agent-ex config set executors.<name>.bin <绝对路径>` |
| `src/init.ts` 的 nextSteps | 补一句"或用定点命令：`agent-ex config set` / `agent-ex profile set`" |
| `src/cli.ts` | 新增 `runProfile`；`runConfig` 去掉 `use`；usage 文案同步 |
| `src/server.ts` | 分派 `profile` 子命令；错误边界只打 message |
| `tests/config-cmd.test.ts` | `use` 用例拆成 `use` / `create` 两组，并补 `profile set` 的键约束用例 |

### 12.6 验收（全部通过）

| 验收项 | 落地测试 |
| :--- | :--- |
| `collectConfigIssues` 每条规则一个 code、每条 issue 带 fix | `tests/config-issues.test.ts`（14 条） |
| `defaults.timeout_sec: "3600"` 与 `defaults: {}` 都被 doctor 报成 error | `tests/doctor.test.ts`（假阴性回归主用例） |
| doctor 只跳过**本次实际产出**的 code+subject | 同上（多个 executor 都有问题 ⇒ 两条都报） |
| `config set executors.<name>.bin`：未知名字/不可执行路径拒绝、合法路径写入 | `tests/config-cmd.test.ts` |
| `profile use` 不存在名字时不创建；`profile create` 默认不切默认、`--use` 才切 | `tests/config-cmd.test.ts` + `tests/cli-env.test.ts`（进程级） |
| `profile create --bin` 在 PATH 无 opencode 时能落地 | `tests/config-cmd.test.ts`（临时清空 PATH，精确复现"装了但不在 PATH"） |
| `profile set` 拒绝 `NODE_OPTIONS`/`PATH`/`LD_*`/`DYLD_*`、空值、坏 `OPENCODE_CONFIG_CONTENT` | `tests/config-cmd.test.ts` + `tests/cli-env.test.ts` |
| 物化后修改 profile env 不污染 `BUILTIN_PROFILES` | `tests/config-cmd.test.ts` |
| `fixable` 与 `applyFixes` 能力表一致；`{env:bad_lower}` 不被报成"明文" | `tests/doctor.test.ts` |
| `--fix --send` 只发一张修复后的卡 | `tests/cli-env.test.ts`（假飞书计数 `cardCount`） |
| CLI 错误输出不含栈帧；`"3600abc"` 被拒绝 | `tests/cli-env.test.ts` / `tests/config-cmd.test.ts` |

**全量**：301 passed / 24 files，`tsc --noEmit` 0 error。`vitest.config.ts` 已加 `testTimeout: 30_000`（§12.5 的稳定性问题）。

**变异验证**（逐个实跑，全部能转红）：

| 变异 | 结果 |
| :--- | :--- |
| findings 不排序（去掉 `RANK` 那两行） | 1 红（`首条是 error`） |
| doctor 不消费 `collectConfigIssues` | 2 红 |
| 静态跳过名单（替代动态去重） | 1 红（`timeout_sec` 漏报） |
| `profile set` 放开 `NODE_OPTIONS`/`PATH`/`LD_*` | 1 红 |
| `config set` 放开成通用点路径 | 11 红 |
| doctor 不保护"executor 缺 bin" | 1 红（且实测会崩） |
| `--fix --send` 回到"先发卡再修" | 1 红（发两张卡） |
| `profile use` 恢复隐式创建 | 1 红 |
| CLI 错误边界改回 `console.error(msg, e)` | 1 红（栈帧回来） |
| `store.ts` 改回顶层 `require("node:sqlite")` | 1 红（`SQLITE_LOADED=true`） |
| init 恢复"只探测到一个也问用哪个" | 4 红（答案序列错位 ⇒ readline 卡死超时） |
| init 恢复旧的 `detected:` 展示格式 | 1 红（输出含 `not found`） |
| 颜色在非 TTY 也开 | 2 红（管道/重定向场景） |
| 探测展示退回"只列找到的" | 2 红（找不到 claude 的那一行没了） |
| init 的那句话说回中文 | 1 红（文案语言断言） |
| yes/no 改回 `[N]` 形式 | 1 红 |
| 覆盖确认的长提示合回一行 | 1 红 |
| init-changes 的 removed 标记换回 `✗`（裸符号） | 2 红（裸符号扫描 + diff 语义断言） |
| doctor 的 summary 改回中文 | 1 红（doctor.ts 的 CJK 扫描） |
| 值变化用 `→` 而不是 `->` | 1 红（「`→` 只留给可复制的命令」） |

**实施顺序**：§12.2 → §12.4 → §12.1 + §12.5 迁移清单 → §12.3（已按此顺序完成）。

**实现中额外发现并修掉的 bug**（不在原评审清单里）：
1. **doctor 在"executor 缺 `bin` 字段"时直接崩**（`resolveBinPath(undefined)` → `Cannot read properties of undefined`）⇒ 一条 finding 都报不出来。体检工具在配置坏了的时候最不能崩——那正是它该出结论的时刻。已加保护 + 回归用例。
2. **`config set` 整数解析宽松**（§12.4 已列，本轮实装）：`"3600abc"` / `"3.7"` 现在被拒绝。
3. **SQLite 的实验性警告插进了 `init` 的提示符中间**（npm link 后手工验证时发现）：`server.ts` 顶层静态 import `submit.js` → `store.js` → **顶层** `require("node:sqlite")` ⇒ 任何子命令（包括根本不碰数据库的 `init` / `doctor` / `config`）都在启动时加载了 SQLite；Node 的 `ExperimentalWarning: SQLite is an experimental feature` 是**异步**打印的，正好落在 readline 的第一个提示符后面：
   ```
   Executor to configure (claude/opencode) [claude]: (node:71345) ExperimentalWarning: SQLite is an experimental feature…
   ```
   实测 init 全程**一个字节的数据库都没写**（没有 `tasks.db`），那条警告纯属噪音。修法两处：① `store.ts` 改成**懒加载**（真正要开库时才 `require`）；② `server.ts` 把 `submit`/`status`/`cancel`/`doctor` 改成 `main()` 内动态 import（`init`/`doctor`/`config` 不必加载 SDK、SQLite、runner 相关的全部模块）。
   > ⚠️ 回归断言不能只看子命令输出：`doctor` 立刻 `process.exit`，异步警告还没 flush 就被冲掉了（回退改动后 doctor 依然干净，只有交互式的 `init` 才看得见）。所以断言的是**更本质**的那件事——加载 store 模块后 `process.moduleLoadList` 里不该出现 sqlite。
4. **init 的 CLI 选择提示是白问，而且默认值指向没装的那个**（npm link 后手工验证时发现）：本机只装了 opencode，界面却是
   ```
   detected: claude=(not found)  opencode=/Users/wuruofan/.opencode/bin/opencode
   Executor to configure (claude/opencode) [claude]:
   ```
   三个问题：① 只探测到一个时"选哪个"**答案唯一**，问了是白问；② **默认值恒为 `claude`** —— 只装了 opencode 的人直接回车会配出一个**根本没装**的 executor，还得再手打一遍它的绝对路径；③ `detected:` 那行是给机器看的（"没找到"与"找到了"平铺在同一行），用户得自己分辨哪个可用。
   修法：`detectAgentClis()` 只返回**真正找到的**；`renderDetectedClis()` **两个候选都列**（找到=✓、没找到=✗ 并变暗）——只列找到的那个会让人看不出"另一个到底是没有、还是压根不支持"；**只找到一个时直接用它、不再问**，并说清"the only one installed; claude not found"；找到多个才问（默认第一个）；一个都没找到才退回到"问名字 + 要绝对路径"。
   > ⚠️ 探测函数做成**可注入**（`runInit(input, { which })`）：init 的问答流程会随"探测到几个 CLI"变化，若依赖开发机环境，测试就变成"这台机器恰好装了 X"的巧合（同 §9 的 PATH 巧合）。
5. **终端输出没有颜色**（同一轮手工验证时发现）：整个项目**零** ANSI 支持（grep 无命中），一屏输出里哪个是 error、哪个是次要信息全靠符号（`✗` `!` `✓` `·`）分辨，密度一高就糊成一团。
   修法：新增 `src/ansi.ts`（自写，不引依赖——着色需求就 6 个函数 + 一个开关，为此拉个库不划算）。开关规则按 no-color.org 惯例 + 常见约定：`NO_COLOR` 存在⇒关；`FORCE_COLOR` 非 "0"⇒强制开；否则**只在 stdout 是 TTY 时开**。最后一条最关键：输出被重定向到文件或管道时，转义序列只是噪音（实测 `agent-ex doctor > file` 与 `| cat -v` 的 ESC 数量均为 0）。
   着色范围：`init` 的探测展示与问答提示、`doctor` 的按级别着色（error 红 / warn 黄 / ok 绿 / info 暗）、`config`/`profile` 的成功与失败行。
   > ⚠️ **MCP 工具的返回值绝不能带转义序列**——那是 JSON 数据，不是给人看的终端输出。着色只加在 `cli.ts`（渲染层）与 `init.ts` 的交互输出上。
6. **init 的输出里混进了一句中文**（同一轮手工验证时发现）：`opencode: provider 由 opencode 自己的配置管理…` —— 而 init 向导的其它文案（问题、默认值提示、变更预告、next steps）**历来全是英文**，就这一句是中文，一屏里两种语言。
   修法：改成英文。**代码注释用中文没关系**（那是给开发者看的），但**用户看到的东西**要么全英文、要么全中文。
   > ~~顺带核了一遍：doctor 那一侧（`title`/`detail`/`summary`）是自洽的中文体系，与 init 的英文体系是两个独立界面，不冲突——`cli.ts` 里剩下的两处中文属于 doctor 界面，保持中文。~~
   > **该判断已被推翻**（见第 8 条）：一个工具的用户可见输出不该有两种语言，doctor 界面后来整体改成英文，`cli.ts` 里那两处中文也随之消失。
   > 回归防线：`tests/init.test.ts` 扫 `init.ts` 源码里所有 `console.log/error` 与 `ask(` 提示语，**不得出现中文字符**（注释行被排除）。
7. **init 的 yes/no 提问用错了形式，且长提示顶满终端**（同一轮手工验证时发现）：
   ```
   /tmp/agent-ex-test/config.json already exists. Re-running init REWRITES it (you will see exactly what changes before anything is written). Continue? [N]:
   ```
   两个问题：① **`[N]` 不是 Unix 惯例**——它只说"默认值是 N"，没说还能按什么；惯例是 `(y/N)`：**小写=可选的答案，大写=回车即取的默认值**，一眼看出"按 N 就是不"。② 一行长文本把路径、说明、问题全挤在一行，终端宽度不够时还会折行错位。
   修法：新增 `askYesNo(rl, prompt, defaultYes)` —— 显示 `(y/N)` / `(Y/n)`、返回 **boolean**（调用方不再各写一遍大小写/空串归一化，漏一处就是 bug）。非法输入按默认值处理并提示一句（**不重问**：重问要在 readline 里循环，管道/脚本场景下第二次 `question()` 会抛 "readline was closed"）。长提示拆成多行：路径一行、说明一行、问题另起。
   > ⚠️ 回归断言的坑：init 的输出走**两个通道**——说明文字走 `console.log`（**vitest 会拦截它**），提问走 readline（直接写 `process.stdout.write`）。只捕获一个通道会漏断言。
8. **符号是三套并存，且都有 emoji**（第 7 条修完后通读全部输出时发现）：`init-changes.ts` 用 `⚠️`（带 U+FE0F）当表头、`✗` 当"即将删除"、`→` 同时表示"值变成"和"可复制的命令"；`init.ts` 一句里混用 `✓` / `→` / `\u26a0`；`cli.ts` 又自带一份 `SEVERITY_STYLE`（与 doctor 的逻辑重复）。三个问题：
   - **emoji 的宽度不可控**：`⚠️` 带变体选择符，不同字体下占 1 或 2 列，对齐会歪；复制时还会带上不可见字符。
   - **`→` 一个符号两种语义**：用户无法判断"这后面的东西能不能粘进终端"。
   - **同一个概念在不同模块有不同符号**，改一处忘一处就是新一轮漂移。

   修法：
   - 新增 `src/marks.ts` 作为**唯一真相源**：`✗` error / `!` warn / `✓` ok / `·` info / `-` removed / `+` added / `±` changed；`SEVERITY_MARK` 把级别映射到「符号 + 着色函数」，`cli.ts` 删掉自己的 `SEVERITY_STYLE`。
   - **`→`（`CMD`）只留给可复制的命令**；值的前后变化一律用 ASCII `->`（`false -> true`），避免"这个箭头是命令还是变化"的歧义。
   - 变更预告按 **diff 语义**三段分类：新增 `+`、删除 `-`、改写 `±`（零学习成本，`git diff` 同款）。原先"即将删除"用 `✗` 是错的——它读起来像"出错了"，而实际是"将消失"。
   - 全部用户可见文案统一为英文（推翻第 6 条那条"doctor 保持中文"的判断）：`doctor.ts` 的 `title`/`detail`/`summary`、`FEISHU_ERRORS`、`config-cmd.ts` 的 `WRITABLE.desc` 与 `BUILTIN_PROFILES.desc`、`config.ts` 的 fix 串。
   - 回归防线 `tests/user-facing-text.test.ts`（11 条）：扫描 6 个 CLI 界面模块，**注释之外不得有 CJK**、不得出现裸符号（`✗✓⚠❓✅❌±` 只能来自 `marks.ts`）、符号必须是单码点且不是 emoji、`-`/`+`/`±` 的映射固定、`→` 只在 `CMD` 里出现。注释用中文不受影响——那是给开发者看的。
   > ⚠️ 扫描器自己要先剥注释：源码里 `"https://…"` 的 `//` 会被朴素实现当成注释起点。实现顺序必须是**先识别字符串、再识别注释**。
9. **命令面收尾：拼错的子命令会静默变成 MCP server**（逐条跑过全部子命令时发现）。
   ```
   $ agent-ex confg
   [agent-ex] mcp server ready (stdio)      # 挂在 stdio 上等输入，用户以为卡住了
   ```
   根因：`server.ts` 的分派只认 `init/doctor/config/profile`，其余一律进 `main()`（那是 MCP 客户端的无参启动路径）。修法：**有非选项参数但认不出** ⇒ 打印 `✗ Unknown command "confg"` + usage（exit 2）；无参仍走 MCP。另补 `--help`。
   同一轮还修了：
   - **findings 不排序**：`dry_run` 的 warn 排第一，真正的病灶（明文 webhook、旧关键词）被挤出首屏。现在按 error → warn → info → ok 排序（`tests/doctor.test.ts` 钉住"首条是 error"）。
   - **标题句首大小写不一致**：同一个列表里 `Keyword is…` 与 `executor "ghost" is unusable` 混排。规则统一为**标记后首字母大写**（`✗ Unknown key …` / `✗ Executor "ghost" bin is unusable`），`usage:` 保持小写（Unix 惯例）。
   - **`profile list` 的 `Profiles:` 后多一个空行**：空行只用于**段间分隔**，标题紧跟内容；`config list` 的四个小节已按此对齐。
   - **`--fix` 段尾多一个空行**（与 `renderDoctor` 自己的前导空行叠加成双空行），标题从 `--fix:` 改为加粗的 `Fixes:`。
   - **`config list` 首行 `config:` 与段标题不同级**：改为 `Config: <path>`（路径暗色）。
   - **缺 bin 的行只是普通文本**：`(missing — not executable)` 标红；`dry_run true` 的提示标黄（与 doctor 的 warn 同义）。
   - **`model` 直接打印整段 `OPENCODE_CONFIG_CONTENT`**（`{"model":"{model:zen-free}",…}` 撑满一行）：只取其中的 `model` 字段，解析失败才原样输出。
   - **`profile list` 把已物化的预设又列在"not in the config yet"下**：只列未物化的；全物化后整段消失（否则那句话是假话）。
   - **`profile create` 无法一步切换**：新增 `--use`（同一次写盘完成"物化 + 切默认"）。`profile use` 仍**只切换**——它不该写 profile/executor，且 `create` 可能需要 `--bin`（`opencode` 常在 `~/.opencode/bin`，不在 `PATH`）。`profile use <未创建的内置名>` 的错误信息直接给出 `create <name> --use`。
   - **`aborted.` 等句首小写**：`Aborted.` / `Using opencode …` / `Wrote <path>` / `Config valid` / `No binary path provided; aborting.`；`init` 的告警补 `!`、进度补 `·`、命令提示补 `→`。
