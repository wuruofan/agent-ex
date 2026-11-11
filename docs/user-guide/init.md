# `agent-ex init` 详解（agent-ex）

> 本文是 [`agent-ex-mcp`](https://www.npmjs.com/package/agent-ex-mcp) 的**深度章节**：
> 交互式向导每一步问什么、重跑会覆盖什么、怎么安全地只改一个字段。
> 命令速查见仓库根 [README](../../README.md) 的「Quick start」一节。

关联实现：`src/init.ts`（向导本体）、`src/config.ts`（`loadConfig` / `validateConfig`）、
`src/env-file.ts`（`.env` 写入）。

---

## 1. 跑起来

```bash
npm i -g agent-ex-mcp
agent-ex init
```

免安装试跑：

```bash
npx -y agent-ex-mcp@latest init
```

> 仓库开发者用 `npm run init`（= `tsx src/init.ts`）。
> **init 的用户可见输出全英文**（有测试钉住：`tests/init.test.ts` 扫 `src/init.ts` 里所有
> `console.log/error` / `ask()` / `rl.question()` 行，出现中文字符就红）。

## 2. 交互流程

以 claude executor 为例：

1. **用哪个 agent CLI**（`claude` / `opencode`，自动探测并提示检测到的路径）；
   bin 用检测到的绝对路径（回车即采用）。
2. **profile 名**（默认 `default`；**opencode + zen free 时默认 `opencode-zen-free`**，见 §4）。
3. **provider 预设**（`minimax` / `deepseek` / `custom`）：
   - **预设**：内置 base_url + 默认模型 + 对应密钥变量名（`MINIMAX_API_KEY` / `DEEPSEEK_API_KEY`）。
     检测到该环境变量时**掩码展示**（`sk-…wXYZ`）并问 `Use this value? [Y/n]`——`Enter`/`Y` 直接采用；
     `n` 后粘贴新值，或 `Enter` 跳过。
   - **custom**：只问 `ANTHROPIC_BASE_URL` 与模型名；密钥**只粘贴**（无标准变量名可检测），
     占位符变量名从 profile 名派生（如 `myprov` → `MYPROV_API_KEY`）。
4. **飞书 webhook**：检测到 `FEISHU_WEBHOOK_URL` 同样 `[Y/n]` 确认，否则粘贴或跳过（仍生成占位符 + `dry_run`）。
5. **默认超时秒数**。

结束后：

- 写 `config.json`（**只含 `{env:VAR}` 占位符**，零明文）并自动用 `loadConfig()` 自校验；
- 把确认/粘贴到的密钥写进 `$AGENT_EX_HOME/.env`（**chmod 600**，幂等——同值不重写）；
- 若密钥最终没进 `.env`，会打印 ⚠ 提醒「运行时必须有该变量，否则任务失败」；
- 打印收尾指引：`AGENT_EX_HOME` 怎么设、**可直接粘贴的 MCP 注册片段（绝对路径）**、
  dispatch skill 的安装命令（`agent-ex skill install`）、
  **以及怎么打开真实通知**（`config set notify.dry_run false` + `doctor --send`）。

## 3. 已有 `config.json` 时 `init` 的行为

1. 开头先问一次「要重写吗」（此时还不知道会改成什么样，只是给个廉价退出点）；
2. **问答结束后、写盘前**，把新旧配置的差异逐项列出来（哪些 profile 会消失、哪些字段被改写），
   并解释后果（例：`notify.dry_run false → true` 意味着终态通知不再投递），让你**知情同意**；
3. 你同意后：先校验新配置（**校验不过就不写盘**，旧 config 原封不动），
   再把旧 config 备份成 `config.json.bak.<时间戳>`，最后才写入。

> `.env` 是**增量合并**（只补/更新采集到的 key），所以重跑 `init` **不会丢密钥**。
>
> ⚠️ 但 `init` 是**全量覆盖**的：只想改一个字段（比如开通知）请用 `agent-ex config set`，
> 别重跑 `init` —— 那会把其它 profile 一起刷掉。

## 4. opencode 的 zen free 分支

opencode executor 不询问 provider——它由 opencode 自己的配置管理
（`opencode auth login` / `opencode.json`），agent-ex 只负责拉起。

opencode 分支会多问一句 `Use opencode zen free model (auto-resolving, no key needed)`（默认 Yes）：

- 选 Yes 时写的是**内置 preset** `{model:zen-free}` 占位符 + `ZEN_FREE_PREFER`，
  profile 名默认取内置名 **`opencode-zen-free`**。
- 这样 `init` 产出的 profile 与 `agent-ex profile create opencode-zen-free` **同名同 env**——
  之后再跑 `profile create` 会得到「已存在」而不是多出一个同义但名字不同的 profile。
- 名字仍可自己改（改了名 env 不变：env 描述的是「用哪套模型配置」，不是「叫什么」）。

`{model:zen-free}` 的解析机制见《[配置详解](configuration.md) §6》。

## 5. init 之后的体检

```bash
agent-ex doctor          # 只读体检：config / executor bin / 历史通知失败
agent-ex doctor --send   # 额外实发一张自检卡，验证真实投递
```

体检结论与通知排错见《[飞书通知详解](notifications.md)》。
