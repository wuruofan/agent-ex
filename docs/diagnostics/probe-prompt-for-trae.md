# 给 Trae 的探针执行 prompt（直接复制粘贴）

下面这段是**给 Trae 里那个 agent 看的**（不是给我看的）。整段复制到 Trae 对话框发送即可。

---

## 复制这一段 ↓↓↓

**任务：注册并运行一个 MCP 探针，用来测「宿主会不会被 MCP server 的主动通知叫醒」。**

背景一句话：Trae 在后台进程完成后**不会**自动开新 turn（已实测，见
`docs/diagnostics/2026-10-20-trae-no-wake-channel.md`）。MCP 协议本身有 server→client 的
主动通道，**2026-10-21 P7 已实测不能替代宿主唤醒（Q3 = 否，见 `2026-10-20-trae-no-wake-channel.md` §9）**。本次是按同一 runbook 做**复验**：确认换了会话 / 重启 Trae 之后结论是否仍成立。

请按顺序做下面 4 步。**每一步做完都要把实际输出贴出来**，不要凭想象总结。

### 第 1 步：注册探针为 MCP server

编辑文件 `/Users/meow/Library/Application Support/Trae CN/User/mcp.json`。

**只新增一项，不要改动或删除现有的 `agent-ex`。** 目标结构：

```json
{
  "mcpServers": {
    "agent-ex": {
      "command": "/Users/meow/.nvm/versions/node/v24.18.0/bin/node",
      "args": ["/Users/meow/workspace/agent-flow-ex/dist/server.js"]
    },
    "mcp-wake-probe": {
      "command": "/Users/meow/.nvm/versions/node/v24.18.0/bin/node",
      "args": ["/Users/meow/workspace/agent-flow-ex/scripts/probes/mcp-wake-probe.mjs"]
    }
  }
}
```

写完把文件完整内容贴出来。

### 第 2 步：确认探针文件在位

用 Read 工具读一下 `/Users/meow/workspace/agent-flow-ex/scripts/probes/mcp-wake-probe.mjs`，
**只确认文件存在且非空**，不用贴全文。报告行数即可。

> 如果 Read 也被拒（报 `Toolhost terminal commands must be routed through the agent runtime`
> 或类似的宿主路由错误），**立刻停下，把这个错误原样贴出来**——那本身就是一条重要结论，
> 说明该宿主读不到仓库路径，探针没法用这种方式跑。

### 第 3 步：让 Trae 重新加载 MCP 配置

Trae 会缓存 MCP 工具清单（缓存目录在 `~/.trae-cn/mcps/<session>/<agent>/<server>/tools/`）。
新增 server 后必须让它重新拉取，否则工具不可见。

请你在 MCP 面板里把新加的 `mcp-wake-probe` 启用一次（如果面板有 disable → enable 的开关，
就 disable 再 enable）。**如果你没有操作面板的能力**，直接说明「需要用户在面板里手动启用」，
并把配置写好停在这一步——**不要跳过这步直接调用工具**，跳过了工具一定不可见。

### 第 4 步：调用探针

调用 `mcp-wake-probe` 的 `probe_fire` 工具：

- `delay_ms` = `5000`
- `note` = `"trae-wake-test"`

调完之后，**什么都不要做，等 60 秒**，然后报告：

1. 界面上**有没有自动出现新的 agent 动作或回复**（不是你主动发消息触发的）？
   - 有 → 明确说「**出现了自动的新 turn**」，并贴出那个新 turn 的内容
   - 没有 → 明确说「**没有自动的新 turn**」
2. 把探针日志贴出来：
   ```
   Read /Users/meow/.agent-ex/probe-wake.log
   ```
   （如果读不了，用终端 `cat` 同一个路径）

### 判定标准（照着判，不要自行发挥）

| 现象 | 结论 |
| :--- | :--- |
| 探针日志有 `logging_sent` / `resource_updated_sent` / `sampling_replied`，但**界面无自动新 turn** | 通知送到了，但**宿主不把通知翻译成新 turn** ⇒ MCP 通知**替代不了宿主唤醒** |
| 探针日志**没有** `sampling_replied`，而是 `sampling_skipped`（或 `sampling_failed` 且报 "Client does not support sampling"） | Trae 客户端**没声明 sampling 能力** ⇒ 这条更强的通道也不可用 |
| 界面**出现了自动的新 turn**，且新 turn 里提到 `WAKE_PROBE_LOGGING` 或 `WAKE_PROBE_SAMPLING_OK` | **宿主确实被叫醒了** ⇒ MCP 主动通道可用，Trae 下真自动 loop 成为可能 |

**重要**：如果界面上没出现自动新 turn，**不要重发消息去「戳一下」让它反应**——
那一戳会污染证据（分不清是通知叫醒的还是你叫醒的）。直接如实报告「没有自动的新 turn」。

### 最后请给出总结

用一段话回答这三个问题：

1. Trae 客户端在 initialize 时声明了什么能力？（看探针日志里的 `client_initialized.client_capabilities`）
2. 三条通道（logging / resources/updated / sampling）各自结果如何？
3. **宿主有没有因此产生新的 turn？**（这是决定性的一条）

---

## 复制这一段 ↑↑↑

---

## 给你的补充说明（不用复制给 Trae）

**这次探测的局限，先说在前面：**

1. **它只能测「主动推送」这条路**。如果 Trae 不把 notification 翻译成新 turn，
   那结论就是「Trae 下 loop 只能是用户回话时推进一轮」——这是当前设计已经覆盖的
   （昨天写进 SKILL.md 的「[回来先查]」兜底）。

2. **sampling 成功 ≠ loop 成功**。sampling 拿到的是客户端模型的一次调用，
   **不一定带着当前会话的历史**（前序任务事实 / plan 约束 / 用户期间发言）——
   而这恰恰是 SKILL.md 明确不许外包的部分。所以即便 sampling 通了，
   loop 的价值也打折。报告里我会把这两件事分开记。

3. **如果你现在不方便在 Trae 里跑**，也可以等下次在电脑边时再说。这份 prompt 和探针
   都已经在仓库里了（`scripts/probes/`），随时可用，不是一次性消耗品。

**探针的可靠性**：我先用模拟 MCP client 做了自检（`scripts/probes/smoke-wake-probe.mjs`），
三条通道全绿。过程中修掉了两个真 bug（sampling 响应挂错方向、initialize 与 initialized
不能同批发），所以如果 Trae 那次跑失败，可以确定问题在宿主侧而不是探针写错了。
