# MCP 唤醒通道探针 —— 测宿主会不会被 server 的主动通知叫醒

**文档编号**：probe-mcp-wake-channel
**状态**：✅ **2026-10-21 P7 已在 Trae 实测，Q3 = 否**（日志与判定见 `2026-10-20-trae-no-wake-channel.md` §9）。本文与 `probe-prompt-for-trae.md` 作为**复验 runbook** 保留，探针与自检脚本可随时重跑。
**问题**：Trae 上「后台进程完成 → 宿主开新 turn」实测不存在（见 `2026-10-20-trae-no-wake-channel.md` P2）。
MCP 协议本身有 server→client 的主动通道，**实测不能替代宿主唤醒**：`client_capabilities: {}` 让 sampling 在协议层就不可用，logging / resources 通知虽发出、宿主零反应，三条通道都未产生新 turn。

---

## 1. 这个探针要回答什么

**不是**「通知有没有送达」（送达不等于叫醒），而是三个可分离的事实：

| # | 命题 | 怎么判 |
| :--- | :--- | :--- |
| Q1 | 客户端在 initialize 时声明了什么能力？ | 探针日志的 `client_initialized.client_capabilities` |
| Q2 | 三条主动通道各自的结果是什么？ | `logging_sent` / `resource_updated_sent` / `sampling_replied` 或 `sampling_failed` |
| Q3 | **宿主有没有因此产生新的 turn？** | 探针在推送之后如果收到**新的**请求（`tools/call` 等），说明有东西被触发了；**日志时间线 + 调用内容是直接证据** |

Q3 是唯一决定性的。Q1/Q2 只说明「协议层可用了」。

---

## 2. 三条被测的通道

| 通道 | MCP 方法 | 性质 | 依赖 |
| :--- | :--- | :--- | :--- |
| **logging** | `notifications/message` | fire-and-forget，客户端不必回 | server 须声明 `capabilities.logging` |
| **resources/updated** | `notifications/resources/updated` | fire-and-forget | server 须声明 `capabilities.resources` |
| **sampling** | `sampling/createMessage` | **server 请求客户端跑一次 LLM**，等回结果 | **客户端须声明 `capabilities.sampling`**，否则 SDK 直接抛 `Client does not support sampling` |

**为什么 sampling 值得单独试**：它比 notification 强——notification 只是推一条消息，
而 sampling 是**一次有响应的请求**，客户端必须真的跑一次模型。若 Trae 实现了 sampling，
说明宿主有「让模型跑起来」的执行器。

⚠️ **但 sampling ≠ 唤醒主 agent**：它拿到的是**客户端模型的一次调用**，
**不一定带着当前会话的历史**（前序任务事实 / plan 约束 / 用户期间发言）。
这正是 SKILL.md 明确不许外包的那部分。⇒ **即便 sampling 成功，loop 的价值也打折**，
这一点要在结论里说清楚，不能拿「sampling 通了」当「loop 通了」。

---

## 3. 文件

| 文件 | 作用 |
| :--- | :--- |
| `scripts/probes/mcp-wake-probe.mjs` | 探针本体，一个独立 MCP server |
| `scripts/probes/smoke-wake-probe.mjs` | **探针自检**：用模拟 client 驱动它，证明「探针能发、客户端能收、采样能被响应」。已通过（见 §5） |

探针暴露一个工具：

```
probe_fire(delay_ms?: number, note?: string)
```

- 立即回结果（工具调用必须先成功，否则宿主可能走失败路径不看后续）
- 延后 `delay_ms`（默认 3000）后依次发三条通道
- 每一次尝试写进 probe log

**证据文件**：`~/.agent-ex/probe-wake.log`（JSONL，每行带 `epoch_ms` + `seq`）。
可用环境变量 `PROBE_LOG` 覆盖路径。

---

## 4. 在 Trae 上怎么跑

### 4.1 注册探针为 MCP server

编辑 `/Users/meow/Library/Application Support/Trae CN/User/mcp.json`，
在 `mcpServers` 下**新增一项**（不要动现有的 `agent-ex`）：

```json
{
  "mcpServers": {
    "agent-ex": { "...": "保持原样" },
    "mcp-wake-probe": {
      "command": "/Users/meow/.nvm/versions/node/v24.18.0/bin/node",
      "args": ["/Users/meow/workspace/agent-flow-ex/scripts/probes/mcp-wake-probe.mjs"]
    }
  }
}
```

⚠️ 该文件在 Trae 的 `resourceAuthorization.filesystem.readWrite` 白名单里，**可写**。
node 路径已验证存在（v24.18.0）。SDK 是本仓库的 `node_modules/@modelcontextprotocol/sdk@1.30.0`
—— 探针用相对 import 解析，**必须从仓库目录启动**（`args` 里用的是绝对脚本路径，
node 会按脚本所在目录逐级向上找 `node_modules`，因此能找到仓库的 SDK）。

### 4.2 让 Trae 重新加载 MCP

Trae 缓存 MCP 工具清单（实测：`~/.trae-cn/mcps/<session>/<agent>/<server>/tools/*.json`）。
**新增 server 后需要宿主重新拉取**，否则工具不可见。做法：MCP 面板里 disable → enable，
或重启 Trae。

> 📌 这条缓存事实也解释了 `2026-10-20-trae-no-wake-channel.md` §6 里的
> 「`mcp_agent-ex` 报 not found」：那个会话的缓存目录里只有旧名 `mcp_agent-flow-ex`。
> **是缓存没刷新，不是 server 坏了。**

### 4.3 触发

在 Trae 里对 agent 说一句让它调用探针工具，例如：

> 调用 `mcp-wake-probe` 的 `probe_fire` 工具，delay_ms 设 5000，note 写 "trae-wake-test"。

### 4.4 关键：触发之后**别急着说话**

**这才是整个探针的核心。** 探针在 5 秒后推送通知。

- 如果 Trae **自动**开了一个新 turn（界面上出现新的 agent 动作/回复）⇒ **宿主被叫醒了** ✅
- 如果界面**什么都没发生**，直到你手动发一句话才有反应 ⇒ **通知没被翻译成新 turn** ❌

**必须把「有没有自动出现新 turn」和「探针日志」两边的证据放在一起看**。
只看探针日志会误判——它只能证明「通知发出去了」，证不了「agent 醒了」。

---

## 5. 探针自检（已通过，2026-10-21）

在模拟 client 上跑 `scripts/probes/smoke-wake-probe.mjs`，全绿：

```
 ok   server_ready
 ok   client_initialized        ← 读到 client_capabilities = {"sampling":{},"roots":{"listChanged":true}}
 ok   tool_called
 ok   logging_sent
 ok   resource_updated_sent
 ok   sampling_replied          ← 拿到 WAKE_PROBE_SAMPLING_OK
 ok   sampling handled by client
ALL PASS
```

⇒ **探针本身的三条通道都能走通**。Trae 那次跑如果失败，可以确定问题在宿主侧而非探针侧。

### 5.1 自检过程中修掉的两个真 bug（都是探针的，不是宿主的）

1. **自检脚本把 sampling 响应挂错了方向** —— `sampling/createMessage` 是 server→client 的**请求**，
   client 的回应走 **server.stdout → client.stdin** 这一路；原来挂在 `server.stdin.write` 上，
   永远等不到。挂到 `server.stdout` 的 data 事件才对。
2. **initialize 与 `notifications/initialized` 不能同一批发** —— SDK 的 `_oninitialize` 是异步的，
   `capabilities` 在它 resolve 之后才落到 `_clientCapabilities`。同批发的话
   `getClientCapabilities()` 返回 `undefined` ⇒ 探针会误判「客户端不支持 sampling」并跳过采样。
   ⇒ **探针必须等 initialize 的响应回来再发 initialized**；自检脚本已按此改。

> 第 2 条对**真实 Trae 客户端同样适用**（它自己会按协议顺序来），但如果 Trae 的实现
> 提前触发 `oninitialized`，探针日志里 `client_capabilities: null` 就是证据。

---

## 6. 结论（2026-10-21 P7 已填）

完整日志、观测窗口与判定边界见 `2026-10-20-trae-no-wake-channel.md` §9；这里只留速查。

- [x] Q1 客户端能力声明：`client_capabilities: {}` —— Trae 不声明 sampling / roots / elicitation。
- [x] Q2 三条通道结果：logging 发出成功（`logging_sent`）/ resources 发出成功（`resource_updated_sent`）/ sampling **握手阶段即排除**（`sampling_skipped`，客户端未声明能力）。
- [x] Q3 是否自动产生新 turn：**否**。`delay_ms=5000` 之后 60s 静默窗口内探针无新入站请求、会话无非用户触发的 turn；探针进程仍存活、stdin 未断 ⇒ 不是「送达失败」。

⇒ **Q3 = 否**：Trae 下只能走**方案 A（兜底查询）**，loop 退化为「用户每次回话推进一轮」，不是真自动 loop。MCP 侧再加工也改变不了这件事——**能力在宿主，不在 server**。

> 复验：本探针与 `probe-prompt-for-trae.md` 保留用于换会话 / 升级 Trae 后重跑；判定方法见 §2/§3，宿主侧两个坑（`delay_ms` 类型、嵌套 `run_mcp` 不可见）见 §9.5。
