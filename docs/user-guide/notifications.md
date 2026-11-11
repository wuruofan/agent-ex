# 飞书通知详解（agent-ex）

> 本文是 [`agent-ex-mcp`](https://www.npmjs.com/package/agent-ex-mcp) 的**深度章节**：
> 任务终态怎么推送、关键词闸门怎么匹配、飞书返回的 `code` 怎么读。
> 只想知道「为什么没收到通知」的，看 §4 的 code 表就够。

关联实现：`src/notifier.ts`（卡片构造与 POST）、`src/doctor.ts`（体检与失败归因）、
`src/config.ts`（`notify.*` 校验）。

---

## 1. 建机器人、拿 webhook

在目标群里：**群设置 → 群机器人 → 添加机器人 → 自定义机器人**（不是应用机器人）。
创建后复制形如

```
https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

的地址。**这串地址本身就是凭证**（谁拿到都能往群里发消息），不要贴进公开仓库或 issue。
放进 `$AGENT_EX_HOME/.env`：

```bash
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
```

`config.json` 里只写占位符 `"{env:FEISHU_WEBHOOK_URL}"`，真实值永不进 config。

## 2. 安全设置：与本工具的匹配关系

自定义机器人有三种安全设置，**本工具只支持「自定义关键词」这一种**：

| 安全设置 | agent-ex 是否支持 | 说明 |
| :--- | :--- | :--- |
| **自定义关键词** | ✅ 支持 | 消息里必须包含登记的词，否则被拒收。缺省词 = `agent-ex`。 |
| **加签**（secret） | ❌ **不支持** | 需要在请求里带 `timestamp` + `sign`，本工具不发送（`src/notifier.ts` 的 `post()` 只发裸 payload）⇒ 勾选后必然收不到。 |
| **IP 白名单** | ❌ 不支持 | 需要登记调用方出口 IP，且各家 webhook 服务商规则不同，本工具不校验。 |

> ⚠️ **别勾选加签**。它是最常见的误配：卡片一律被拒，但日志里的报错不指向加签，很难自查（见 §4）。

配置关键词时，**填的词必须与卡片正文里出现的词一致**。本工具缺省把 `agent-ex` 追加到卡片末尾的一行小字
（`notifier.ts` 的 `buildFeishuCard`，`text_size: "notation"`），因此机器人侧的关键词填 `agent-ex` 即可。
若你在 `config.json` 里自定义了 `notify.keyword`，**两边都要跟着改**。

这行小字同时标出这张卡是**哪个 profile、哪个模型**跑出来的，形如
`agent-ex  ·  opencode-zen-free  ·  opencode/mimo-v2.6-flash-free`（关键词在前，值之间用 `·` 分隔，
不加字段名）。模型取「真的跑起来的那个」：`{model:zen-free}` 这种动态占位符会显示 spawn 前解析出的真实模型 id；
profile 里压根没声明模型时（opencode 可以走它自己的全局配置）这一格直接省略，不编一个假模型名。
一张群里几张同样格式的卡靠这行才能区分，排查「同一份 prompt 为什么这次结果差」时先看它。

## 3. 打开真实发送

`notify.dry_run` **缺省是 `true`**（只把卡片打到 stderr，不 POST）。链路验证通过后改成 `false` 才会真发。

```bash
agent-ex config set notify.dry_run false
```

## 4. 验证（别拿真实任务报告当探针）

```bash
agent-ex doctor --send
```

这条命令会发一张**正文刻意不含产品名**的自检卡，并打印飞书返回的 `code` 与含义。
（想先看配置体检而不真发消息，跑 `agent-ex doctor` —— 它只读，不改任何东西。）

失败时看 stderr 的 `code`：

| `code` | 含义 | 处置 |
| :--- | :--- | :--- |
| `0` | 已投递（注意飞书出错也返 HTTP 200，**判定必须看 `code`，不能看 HTTP 状态码**） | — |
| `19024` | 关键词校验失败 | 机器人侧的关键词与 `notify.keyword` 不一致。⚠️ **闸门是对整张卡片做子串匹配**——worker 的报告正文里只要偶然出现该词，卡也能过。配置错了却可能长期「看起来正常」，所以**只认自检卡**。 |
| `19021` | **签名校验失败**（或时间戳距今超过 1 小时） | 机器人勾选了「加签」而本工具不发送 `timestamp`/`sign` ⇒ **去机器人安全设置里取消勾选加签**。 |
| `19022` | IP 校验失败 | 机器人勾选了「IP 白名单」而本机出口 IP 不在其中 ⇒ 取消勾选，或把出口 IP 加进白名单。 |
| `19001` | **webhook token 无效**（地址本身失效：机器人被删/重建/地址轮换） | ⚠️ 与 `19024` **修法完全不同**：这个要**换 webhook 地址**（去机器人后台重新复制，更新 `.env` 里的 `FEISHU_WEBHOOK_URL`），改关键词没用。 |
| `9499` | 请求体格式错误 | 卡片 JSON 不合 schema。注意官方限制：**请求体不得超过 20 KB**。 |
| `11232` | 触发限流 | 单机器人 **100 次/分钟、5 次/秒**；密集派发会撞上，尽量避开整点/半点发送。 |
| 其他 / 无 `code` | 网络或服务端问题 | 检查出口网络与代理。 |

> 本工具每次失败会重试 3 次（退避 1s / 4s），所以日志里出现 3 行同样的 `code` 是正常的。
>
> **机器人不在群**没有专属错误码——webhook 地址与群绑定，飞书通常**静默丢弃**。要换群必须重建机器人并换新地址。

> `doctor` 还会扫 `logs/runner-*.log` 里**历史上**的拒收记录并按 `code` 聚合 ——
> 2026-10-13→10-15 那次连续 23 个任务零通知，证据当时就已经躺在日志里，只是没人看。现在一条命令就能看到。

## 5. 通知在什么时候发

| 事件 | 发不发 |
| :--- | :--- |
| 任务终态（`completed` / `failed` / `cancelled`） | ✅ 发 |
| 任务进入 `needs_input` | ❌ 不发（还没终态，等答复完再续跑） |
| 配额告警 | ✅ 实时发 |
| `doctor --send` 自检卡 | ✅ 发（正文不含产品名，避免关键词闸门假通过） |

卡片正文包含 worker 的最终报告摘要与「哪个 profile / 哪个模型跑出来的」那行小字。
