# doctor / config 评审

> 评审人：DeepSeek-V4.1-Flash（Trae）
> 日期：2026-10-22
> 评审对象：[`docs/specs/2026-10-16-doctor-and-config.md`](../specs/2026-10-16-doctor-and-config.md)（🟡 待评审）+ 8 个未提交文件的实现
> 范围：`src/doctor.ts`、`src/config-cmd.ts`、`src/init-changes.ts`、`src/cli.ts`、`src/server.ts`（doctor/config 分派）、`src/config.ts`（validateConfig）、`src/init.ts`（写盘前校验/备份）、`src/store.ts`（列迁移）
> 测试状态：**196 passed / 20 files**、`tsc --noEmit` 0 error（本次评审复跑确认）
> 目标：回答 spec §8 的 Q1-Q6，并把实现中「spec 没覆盖到」的缺陷挑出来

## 评审方法

所有主张都附**可复现的实测输出**（复现命令见 §附录）。对 spec 的每条主张，都对照运行时代码验证了一遍，而不只看注释——本仓库的历史教训正是「注释说明 ≠ 实际行为」（`notifier.ts` 的 dry-run 曾长期被当成"配好了"）。

## 结论摘要

| 判定 | 项 |
| :--- | :--- |
| ✅ 可接受，无需改动 | D1-D8 决策、schema 迁移、init 三项修复、`--fix` 不动 `dry_run`、`.env` 不覆盖已有变量 |
| 🔴 P0-1 | `doctor --send` 在**文档化配置下必然失败**（CLI 路径不加载 `.env`），且同一轮里自相矛盾 |
| 🟠 P1-2 | `keyword ≠ BRAND ⇒ error` 规则**过宽且与 `brand.ts` 的设计声明冲突**；`--fix` 会覆掉用户与机器人侧一致的合法自定义词 |
| 🟠 P1-3 | `--fix` 把明文 webhook 写进 `.env` 时**没 chmod**，实测留在 `644`；spec §3.2 声称 600 |
| 🟡 P2-4 | `--send` 未把飞书 `code` 纳入结论（spec §3.3 未落实），agent 侧拿不到码 |
| 🟡 P2-5 | `listConfig` 的 `bin_ok` 恒为 `true`；`config list` 不显示 profile 的 `env` |
| 🟡 P2-6 | `applyFixes(home, report)` 的 `report` 参数从未使用 |
| 🟡 P2-7 | `setConfigValue` 用两处 `as` 强制转换绕过类型；`keyword` 无非空校验 |
| 🟡 P2-8 | 历史失败的聚合单位混用（"N 个任务" vs 尝试次数），且只给出一个码的修法 |

---

## 🔴 P0 — 必须修复

### 1. `server.ts:118-122` — CLI 子命令路径不加载 `.env`，`doctor --send` 必然失败

**证据**（同一份 config，密钥按 init 的默认方式只放在 `.env`）：

```
--- A) doctor（只读）---
✓ webhook 地址已配置
    FEISHU_WEBHOOK_URL 在 .env里          ← 同一轮里说"已配置"

--- B) doctor --send ---
✓ webhook 地址已配置
    FEISHU_WEBHOOK_URL 在 .env里
✗ 自检卡发送失败
    env placeholder {env:FEISHU_WEBHOOK_URL} not found in process environment
    → 检查 FEISHU_WEBHOOK_URL 是否有效     ← 同一轮里又说"发送失败：环境变量没有"
```

把同一个变量改成 shell 里 export 后重跑，发送链路立刻正常（命中伪造 token 的 `19001` 拒收）：

```
=== (2) same, but exported in the shell env ===
✗ 自检卡被拒收
    飞书返回非 0 code，详见 stderr 里的 [notifier] feishu rejected 行。
```

**根因**：`loadEnvFile()` 只在 [`main()`](file:///Users/wuruofan/mine/rfw/agent-ex/src/server.ts#L20) 里调用；子命令分支 [`server.ts:118-122`](file:///Users/wuruofan/mine/rfw/agent-ex/src/server.ts#L118-L122) 直接 `import("./cli.js")` 执行，从不加载 `.env`。全仓库 `loadEnvFile` 只有一个调用点（`grep -rn loadEnvFile src/` 只返回定义处与 `server.ts:20`）。

```bash
$ grep -rn "loadEnvFile" src/
src/env-file.ts:33:export function loadEnvFile(home: string = agentExHome()): void {
src/server.ts:13:import { loadEnvFile } from "./env-file.js";
src/server.ts:20:  loadEnvFile();
```

**为什么是 P0**：`--send` 是 spec 立论的核心——「拿真实任务报告当探针是无效验证」（§3.3），唯一的有效验证手段就是自检卡。它在 init 默认产出的配置形态（密钥在 `.env`）下**必然报错**，而报错原因还指向错误的方向（"检查 FEISHU_WEBHOOK_URL 是否有效"，实际它有效）。用户会去改一个没坏的东西。

**为什么 MCP 侧看不出来**：`agent_ex_doctor` 跑在 server 进程里，`main()` 已经加载过 `.env`，所以 agent 自查是通的。于是 [`cli.ts:4-6`](file:///Users/wuruofan/mine/rfw/agent-ex/src/cli.ts#L4-L6) 那句「CLI 与 MCP 工具的行为**必然一致**——不会出现"命令行说通了、agent 查出来不通"」被这个 bug 直接推翻（现状恰好相反：agent 查得通，命令行查不通）。

**建议**：把 `loadEnvFile()` 提到子命令分派之前（一行），两个子命令同时受益。顺带让 `--fix` 写 `.env` 后的解析也走同一条路径。

---

## 🟠 P1 — 设计/正确性问题

### 2. `doctor.ts:222-235` — `keyword ≠ BRAND ⇒ error` 过宽，`--fix` 会破坏本来能通的配置

**实测**：用户把关键词设成与机器人侧登记一致的 `my-bot-word`（一个完全合法的自定义词）：

```
--- L) user deliberately set a CUSTOM keyword consistent with their robot ---
✗ 关键词与当前产品名不一致
    notify.keyword = "my-bot-word"，而产品名是 "agent-ex"。…若机器人登记的是 "agent-ex"，卡片会被拒收（19024）。
    → agent-ex config set notify.keyword agent-ex
--- M) doctor --fix on that config ---
--fix:
  ✓ notify.keyword: my-bot-word → agent-ex
raw notify after fix: {"feishu_webhook_url":"{env:FEISHU_WEBHOOK_URL}","keyword":"agent-ex"}
```

`--fix` 手起刀落把一个**能投递**的配置改成了**不能投递**（机器人仍登记 `my-bot-word`）。这不是假想：`brand.ts` 明确把 keyword 的最终决定权留给用户：

> `brand.ts:10-12`：「keyword 的缺省值由此派生…**用户显式写 keyword 仍然优先——那是机器人侧登记词的选择权，属于用户界面，不该被默认值夺走。**」

也就是说 `brand.ts` 的声明与 `doctor.ts` 的规则**互相矛盾**：一个说"用户显式值优先"，另一个把任何非 BRAND 的值判为 error 并自动覆写。

**19024 的证据强度**：那 69 次拒收只证明"**陈旧产品名**是错的"（live config 留着 `agent-flow-ex`），**不证明任何 ≠BRAND 都错**。规则从证据外推过头了。

**建议（见 §裁决清单 2）**：把「≠BRAND」拆成两种情形：
- 缺失 / 空串 → 保持 error + `fixable`（这确实是"客观上错了"）；
- 其他非 BRAND 值 → 降为 **warn**，只提示 `--fix` 会改成什么、并说明"若你的机器人登记的就是这个词，请忽略本提示"；若要保留自动修，把覆写范围收窄到**已知的旧品牌名白名单**（如 `agent-flow-ex`）。

### 3. `doctor.ts:160` — `--fix` 写 `.env` 未 chmod，实测权限留在 644

spec §3.2 写的是「原值写入 `.env`（`chmod 600`）」，实现只给了 `mode` 选项：

```
--- K) .env chmod semantics in --fix ---
before: -rw-r--r--
--fix:
  ✓ notify.feishu_webhook_url: 明文 → {env:FEISHU_WEBHOOK_URL}（原值已写入 .env）
after:  -rw-r--r--  content: EXISTING=1|FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/PLAINTEXT|
```

`writeFileSync(path, data, { mode })` 的 mode **只在创建新文件时生效**；而 `.env` 在 init 之后几乎总是已存在（`uid` 保留旧权限）。同仓库已有正确写法可参照：

```ts
// src/init.ts:154-155
writeFileSync(envPath, body, { mode: 0o600 });
chmodSync(envPath, 0o600);      // ← applyFixes 缺的就是这一行
```

讽刺点在于：这个修复项的**卖点就是凭证卫生**（"config 可能被提交/同步，webhook 地址本身就是凭证"），结果把凭证从 644 的 config.json 挪进 644 的 `.env`，防护强度没变。

**建议**：`chmodSync(envPath, 0o600)`，与 `init.ts` 对齐。

---

## 🟡 P2 — 细节

### 4. `doctor.ts:312-324` — `--send` 未把飞书 `code` 纳入结论

spec §3.3：「发一张…自检卡，**把飞书返回的 `code` 纳入结论**」。实现只拿到布尔量：

```ts
const sent = await sendFeishuCard(url, card, { dryRun: false });
if (sent) { … } else { findings.push({ severity:"error", title:"自检卡被拒收",
  detail:"飞书返回非 0 code，详见 stderr 里的 [notifier] feishu rejected 行。" }); }
```

`code` 此刻**就在手上**（`notifier.ts:51` 打印过它），却只留在 stderr。对 CLI 用户是"多看一眼"，对 MCP 侧是**拿不到**——`agent_ex_doctor({send:true})` 的 JSON 里没有码，agent 无法据此区分"改关键词"（19024）与"换 webhook 地址"（19001），而这恰恰是 `FEISHU_ERRORS` 这张表存在的理由。建议 `sendFeishuCard` 增加返回码的变体（或让 doctor 传入收集回调），把 `code`/`msg` 写进 `detail`。

### 5. `config-cmd.ts:60` — `bin_ok` 恒为 `true`；`config list` 不显示 profile env

```ts
executors: Object.entries(c.executors ?? {}).map(([name, e]) => ({ name, bin: e.bin, bin_ok: true })),
```

字段名承诺"bin 是否可用"，实现是无条件 `true`，且 CLI（[`cli.ts:62-63`](file:///Users/wuruofan/mine/rfw/agent-ex/src/cli.ts#L62-L63)）从不打印它。同一件事 `doctor` 已经用 `resolveBinPath()` 做对了（`doctor.ts:278-287`）——这里应当复用，否则它就是个骗人的字段。另：`config list` 不显示 profile 的 `env`，于是 Q5 里 `ZEN_FREE_PREFER` 的语义（空 = 不挑食）在界面上不可见，用户无从知道自己能否改。

### 6. `doctor.ts:136` — `applyFixes(home, report)` 的 `report` 从未使用

签名暗示"按 findings 修复"，实现是重新读盘、重算条件。调用方 `cli.ts:35` 传了报告，读代码的人会以为修复受 `fixable` 约束。要么删掉该参数，要么改成"只修 `fixable === true` 的 finding"（后者更好：能把"哪些问题被修了、哪些不修"直接对齐到用户看到的清单）。

### 7. `config-cmd.ts:95-96` — 两处 `as` 绕过类型；`keyword` 无非空校验

```ts
if (group === "notify") c.notify[field as "dry_run"] = value as never;
else if (group === "defaults") c.defaults[field as "profile"] = value as never;
```

把一个 `string` 塞进声明为 `boolean` 的 `dry_run`，靠 `as never` 让 TS 闭嘴。运行时是对的（类型在 `WRITABLE` 里由 `spec.type` 保证），但类型系统在这一层**完全失效**——将来 `WRITABLE` 改坏，编译期不会有任何提示。

配套问题是输入校验的缺口，实测：

```
--- C) config set notify.keyword '' (empty) ---
✓ notify.keyword = ""          ← 接受了
--- E) keyword after C (raw file) ---
{"feishu_webhook_url":"{env:FEISHU_WEBHOOK_URL}","keyword":""}
```

空串正是**唯一真正会触发 19024 的配置态**（`notifier.ts:106` `if (keyword)` 为假 ⇒ 卡片里根本没有关键词元素 ⇒ 闸门必然匹配不到），而 `config set` 亲手把它写了出来。`doctor` 随后报「**缺失** ⇒ 必然拒收」——诊断结论对空串成立、对字段缺失却**不成立**（见下条实测）。建议：`string` 类型补非空校验，并把 doctor 的文案区分「未设置（运行时会自动填 BRAND）」与「显式设为空」两种情形。

**实测：字段缺失时 doctor 的断言是错的**

```
--- I) keyword field ABSENT: doctor verdict ---
✗ 未配置关键词
    notify.keyword 缺失 ⇒ 飞书「自定义关键词」闸门必然拒收。
--- J) what loadConfig does with an absent keyword (runtime truth) ---
runtime keyword = "agent-ex"
card contains keyword element = true
```

`loadConfig` 会 `??= BRAND`（[`config.ts:45`](file:///Users/wuruofan/mine/rfw/agent-ex/src/config.ts#L45)），所以字段缺失时卡片**是带关键词元素**的、闸门**能过**。doctor 在这里把"缺失"说成"必然拒收"，与它正在诊断的那套运行时行为不一致（严重度也偏高：真实故障面是"机器人登记词 ≠ BRAND"，不是"字段没写"）。

### 8. `doctor.ts:295-306` — 聚合单位混用 + 只给一个码的修法

live 实测输出：

```
! 历史上有 24 个任务的通知被拒收
    code=19001 ×3（webhook token 无效…），code=19024 ×69（关键词校验失败…）。最近一次：task_mv9ni381_2f9a53。
    → 让 config 的 notify.keyword 与机器人「安全设置 → 自定义关键词」一致
```

- `24` 是**含拒收记录的日志数**，`×69`/`×3` 是**尝试次数**（每次失败重试 3 次都会各留一行，`notifier.ts:51` 在循环里），一句话里混了两种单位；
- 只把"次数最多"的码的修法作为 `→` 输出：本例给了 19024（改关键词），但历史里同时存在 19001，而它的处置是**换 webhook 地址**（`FEISHU_ERRORS` 自己写了"改关键词无用"）。按次数取 `worst` 会正好漏掉"最需要人动手"的那个。

建议：文案区分"受影响任务数 / 拒收次数"，并列出**每个码各自的修法**（或全部码都不给 fix，只说"见 FEISHU_ERRORS"）。

---

## ✅ 已验证无问题（同样附证据）

| 项 | 验证方式与结果 |
| :--- | :--- |
| schema 迁移对真实库是 no-op | 复制 live `tasks.db`（21 列 / 48 行）用新代码打开：列数、行数、全行 SHA 前后**完全一致**（`a83ed6efcc2d4fa0`），`prompt` 的 `dflt_value` 仍是 `null`，文件大小同为 593920 —— `ADD COLUMN` 确实不重写已有列 |
| 迁移真能补齐旧库 | 构造只有 `id`/`status` 的旧库：19 列一次性补齐，旧行读回 `prompt=""`、`files_changed=[]`、`role="worker"`、`notify_failed=false`（全靠 `DEFAULT`，符合 §6.3 的硬限制） |
| `--fix` 不动 `dry_run` | live 库 `dry_run=false` 经 `doctor --fix` 后保持不变（D3 守住） |
| `.env` 已有同名变量不覆盖 | 实测 `.env` 里已有 `FEISHU_WEBHOOK_URL` 时不写、只进 `skipped` |
| 空串关键词能被 `--fix` 救回 | `config set notify.keyword ""` 后 `doctor --fix` → `→ agent-ex`，二次体检转 ok |
| 历史失败记 warn 不阻断 | live 跑出 24 个拒收记录，`ok:true`、exit 0（D4 守住） |
| `--fix` 后自动复检 | 实测修复后重新渲染一次报告，`exit` 反映修复后状态 |

---

## §8 待评审问题：逐条结论

| # | 结论 | 依据 |
| :--- | :--- | :--- |
| **Q1** 历史失败记 warn 是否可接受 | **接受，记 warn**（保持 D4）。但必须同时修 P2-8：当前文案把"受影响任务数"与"尝试次数"混在一句，且只给一个码的修法，容易把用户引到无效动作上 | live 实测：19024 ×69 与 19001 ×3 并存，二者修法互斥 |
| **Q2** `--fix` 改 keyword 是否越权 | **越权，需收窄**。实测 `--fix` 把用户与机器人侧一致的 `my-bot-word` 覆写成 `agent-ex`，把能投递的配置改成不能投递；且与 `brand.ts:10-12`「用户显式值优先」的声明冲突。19024 的证据只支持"陈旧产品名是错的" | 见 P1-2 的实测 L/M |
| **Q3** `config set` 白名单是否够用 | **够**（四个键覆盖了实测的所有需求，拒绝通用点路径是对的）。但要补两点：`string` 类型做非空校验（否则 `config set notify.keyword ""` 能造出必然 19024 的状态）；`config set` 走全量 `validateConfig` 时，无关的坏 executor 会挡住这一键的修改，错误信息应说明"是整体校验拦下的" | 见 P2-7 实测 C/E |
| **Q4** doctor 是否默认发卡 | **不默认**（保持 D2）。`--send` 会真实 POST 到群；MCP 侧 `agent_ex_doctor` 由 agent 自行调用，默认发送等于让 agent 有权刷群。只读默认 + 显式 `--send` 是正确的成本结构 | 实测 `--send` 真实发出请求（命中远端 19001 拒收） |
| **Q5** `ZEN_FREE_PREFER` 默认值 | **保留 `mimo,nemotron,ling`**（⚠️ **2026-10-26 已被 spec §8 的 Q5 取代**：拉实时清单发现 `ling` 已在上游消失，内置默认改为 `deepseek,glm,mimo`；本行保留为评审当时的结论记录）。理由是它是**软偏好**：`pickZenFreeModel` 命中前缀就用、未命中直接退回 `candidates[0]`，清单过期只会退化为"不挑食"，不可能导致任务失败；因此"挑哪个"的默认偏好不影响可用性。唯一要补的是可见性——`config list` 应显示 profile env，否则用户不知道这行存在（P2-5） | `zen-free.ts:40-50` + `:83-84` 的 fail-safe 路径 |
| **Q6** 迁移是否支持改列类型 | **不做**（保持现状）。独立验证：真实库打开前后逐字节不变；`ADD COLUMN` 的语义天然只增不改，需要改类型时再引入重建表 + `user_version`（spec §10.2 已记为缺口）。预先付"搬 45 行 + 回滚窗口"的复杂度没有当前收益 | 见 §已验证 前两行 |

---

## 流程偏离的处置建议

spec §9 已如实记录「实现先于 spec」。建议**不追溯改写**，而是：

1. 本评审把结论回填 spec：状态 `🟡 待评审` → `✅ 已评审（见本文件）`，并在 §8 表内把 Q1-Q6 的结论替换为上面的裁决；
2. 约定同类改动（新增子命令 / 改配置写入语义 / 动 schema）后续先出 spec 再过评审，再落实现；
3. 本次的 P0/P1 修复，按下面裁决清单确认后**单独一个 commit**落地，与已完成的实现分开（便于回溯"实现先于 spec"的那批变更）。

---

## 裁决清单（需你点头，我不擅自开工）

| # | 待决 | 我的推荐 |
| :--- | :--- | :--- |
| 1 | P0-1 修法 | 在 `server.ts` 子命令分派之前 `loadEnvFile()`（一行，doctor 与 config 同时受益） |
| 2 | P1-2 修法 | 「缺失/空串」保持 error + fixable；「其他 ≠BRAND」降为 warn 并去掉 `fixable`（或收窄为已知旧品牌名白名单） |
| 3 | P1-3 修法 | `--fix` 补 `chmodSync(envPath, 0o600)`，与 `init.ts:155` 对齐 |
| 4 | P2-4 修法 | 让发送路径回传 `code`，写进 finding 的 `detail`（CLI 与 MCP 同收益） |
| 5 | 是否现在动手 | 建议先把 spec 状态与 Q1-Q6 结论回填，再一次性修 1-4，然后跑全量 + 变异验证 |
| 6 | 提交方式 | 普通项目：**英文 commit、不加 AI trailer**，提交信息先给你确认 |

---

## 附录：复现命令

```bash
# 1) P0-1：在临时 home 里放一份"密钥只在 .env"的 config
T=$(mktemp -d /tmp/aex-review-XXXX); mkdir -p "$T/logs"
cat > "$T/config.json" <<'JSON'
{ "executors": { "fake": { "bin": "node" } },
  "profiles": { "p1": { "executor": "fake", "env": {} } },
  "notify": { "feishu_webhook_url": "{env:FEISHU_WEBHOOK_URL}", "keyword": "agent-ex" },
  "defaults": { "profile": "p1", "timeout_sec": 60 } }
JSON
printf 'FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/FAKE\n' > "$T/.env"

AGENT_EX_HOME="$T" npx tsx src/server.ts doctor          # ✓ webhook 地址已配置
AGENT_EX_HOME="$T" npx tsx src/server.ts doctor --send   # ✗ env placeholder not found
FEISHU_WEBHOOK_URL=... AGENT_EX_HOME="$T" npx tsx src/server.ts doctor --send  # 正常发出

# 2) P1-2：自定义关键词被 --fix 覆写
#    把 config 的 notify.keyword 换成 "my-bot-word" 后
AGENT_EX_HOME="$T" npx tsx src/server.ts doctor --fix

# 3) P2-7：空串关键词可写入 + 缺失字段的运行时真相
AGENT_EX_HOME="$T" npx tsx src/server.ts config set notify.keyword ""
AGENT_EX_HOME="$T" npx tsx -e "import {loadConfig} from './src/config.ts'; console.log(loadConfig().notify.keyword)"

# 4) 迁移 no-op 与旧库补齐：见 §已验证 的两次实测（复制库比对 hash / 构造两列旧库）
```

---

## 处置结论（2026-10-22）

本评审提出的 P0-1 / P1-2 / P1-3 / P2-4 已全部修复，Q1-Q6 的裁决与逐条处置见
[`docs/specs/2026-10-16-doctor-and-config.md`](../specs/2026-10-16-doctor-and-config.md) §8 与 §11。

其中 **P1-2 的修法比本评审的建议更窄**，理由是评审自己给的证据链指向更窄的结论：
`loadConfig` 的 `??= BRAND` 意味着 **keyword 字段缺失时运行时是填 BRAND 的**（评审 §P2-7 的实测 J 已证明），
所以"缺失 ⇒ 必然拒收"不成立；而**显式空串**才是唯一能证明投递不了的配置态（`??=` 不替换空串）。
最终落地为四态判定（见 spec §3.1 的表格）。
