# AGENTS.md

把 AI 编程 Agent（Claude Code / OpenCode）当作**外部执行者**来协作的 MCP Server：派发后台任务、让外部 agent 独立出方案、相互 review。

## 文档分工（先读这条，别把东西写错地方）

| 文件 | 写什么 | 给谁看 |
| :--- | :--- | :--- |
| [`README.md`](README.md) | 怎么**用**：安装、配置、命令、MCP 工具、排错 | npm 用户 / GitHub 访客 |
| **AGENTS.md**（本文件） | 怎么**改**：硬约束、连带改动、测试与发布流程 | 改这个仓库的人 / coding agent |
| `docs/specs/` `docs/reviews/` `docs/plans/` `docs/designs/` | 深层设计、评审记录、实施计划 | 追溯「当初为什么这么定」 |

规则：**同一条事实只写一处**，另一处给链接；改了一处就同步另一处（见「改动时的连带规则」）。

## Setup commands

- Install deps: `npm install`
- Build: `npm run build`（`tsc` → `dist/`，附带生成 `dist/build-meta.json`）
- Test: `npm test`（Vitest，含 integration）
- Typecheck: `npm run typecheck`
- 开发模式跑 server: `npm run server`（`tsx src/server.ts`）
- 开发模式跑 init: `npm run init`（`tsx src/init.ts`）
- 装 dispatch skill（可选）: `./scripts/install-skill.sh`

## Project layout

- `src/` — 全部源码
  - `server.ts` — MCP server 入口 + 子命令分派（`init` / `doctor` / `config` / `profile`）
  - `runner.ts` · `spawn-runner.ts` — detached runner、进程树
  - `store.ts` — SQLite 状态机（`node:sqlite`）
  - `tools/` — MCP 工具实现（submit / status / cancel / version / restart / doctor）
  - `executors/` — agent CLI 适配（claude / opencode）
  - `config.ts` — 配置校验的**单一真相源**（`collectConfigIssues`）
  - `config-cmd.ts` — `config` / `profile` 子命令的纯函数
  - `init.ts` — 交互式向导
  - `doctor.ts` — 体检
  - `zen-free.ts` — zen 免费模型动态解析
- `tests/` — Vitest；`integration.test.ts` 真起 runner 跑完整任务生命周期
- `scripts/` — 构建与冒烟脚本
- `docs/` — spec / review / plan / design
- `skills/agent-ex-dispatch/` — dispatch skill（走 GitHub 分发，**不进 npm 包**）

## 硬约束（改代码前必读）

1. **init 的用户可见输出必须全英文。** `tests/init.test.ts` 会扫 `src/init.ts` 里所有 `console.log/error`、`ask()`、`rl.question()` 行，出现中文字符就红。代码注释用中文没关系。
2. **`config` / `profile` 的写入口是白名单**（`src/config-cmd.ts` 的 `WRITABLE` + `executors.<name>.bin`）。不要为了方便加通用点路径写入。
3. **profile env 禁写 `NODE_OPTIONS` / `PATH` / `LD_*` / `DYLD_*`**——它们是 worker 进程的启动/加载面（等价于任意代码执行）。
4. **`{model:zen-free}` 占位符不能被换成硬编码模型名**（`setProfileValue` 会拦）。free 模型集会轮换，配置里必须零硬引用。
5. **`init` 是全量覆盖式**：重跑会重写 `config.json`、丢掉其它 profile 与 `dry_run`。改单个字段一律走 `agent-ex config set` / `profile set`。
6. **校验只有一个真相源**：`src/config.ts` 的 `collectConfigIssues()` 同时被 `validateConfig()` 和 `doctor` 消费。别在 doctor 里另写一套检查。
7. **`server.ts` 顶层的 import 故意不全**：`submit/status/cancel/doctor` 在 `main()` 里动态 import。否则 `agent-ex init` 也会加载 `node:sqlite`，实验性警告会插进交互提示符中间。
8. **worker 的环境不继承 shell**：`buildAgentEnv()` 只给 `HOME` / `TMPDIR` / `PATH` + profile env（`{env:VAR}` 在此解析）。但 `HOME` 会传 ⇒ `~/.claude/settings.json` 里的 env 对 worker 仍然生效。

## 改动时的连带规则

| 你改了 | 还要同步 |
| :--- | :--- |
| MCP 工具（增/删/改名） | `tests/server-tools.test.ts` 的 6 工具断言、`scripts/smoke-stdio.mjs` 的 `PRODUCTION_TOOLS`、README「MCP 工具」表 |
| CLI 子命令 | `src/server.ts` 的 `USAGE`、`src/cli.ts` 的 usage 文案、README 对应章节 |
| 内置 profile / `ZEN_FREE_PREFER` | `src/config-cmd.ts` 的 `BUILTIN_PROFILES`、`config.example.json` |
| 品牌名（`BRAND`） | `config.example.json`、README（`tests/config.test.ts` 会钉住这两处） |
| 用户可见文案 | README 对应章节 |

## Testing instructions

- 单元 + 集成：`npm test`（Vitest）
- 集成测试单独跑：`npm run test:integration`
- 类型检查：`npm run typecheck`
- 新增行为一律补测试，参考同目录已有的 `*.test.ts` 写法
- 冒烟：`node scripts/smoke-stdio.mjs [server.js 路径]`（默认用本仓库 `dist/`）——断言 6 个生产工具齐全且 TEST ONLY 工具未暴露
- 提交前全绿

## PR & commit conventions

- 分支从 `main` 切，不直接推 `main`
- Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `chore(release):`），英文正文；**不加** AI trailer（个人公开项目）
- 推 `main` 前确认工作区干净、`npm test` 全绿

## Security

- **密钥零落盘**：`config.json` 只放 `{env:VAR}` 占位符，真实密钥在 `$AGENT_EX_HOME/.env`（chmod 600，不进 git）
- worker 以「跳过权限确认」模式运行（claude `--dangerously-skip-permissions` / opencode `--auto`）——改默认权限行为前先想清楚
- **不要把 npm token / API key 贴进代码、文档、issue、聊天**。发版凭据只写在 `~/.npmrc` 或 CI secret
- 发布用的 npm token 一律**本机创建**，不要交给任何人（包括 AI 助手）

## 安装（从源码，开发者路线）

```bash
git clone https://github.com/wuruofan/agent-ex && cd agent-ex
npm install
npm run build        # tsc → 生成 dist/
npm run init         # 开发模式跑 init（tsx）
./scripts/install-skill.sh   # 可选：装 dispatch skill
```

## 发布（npm）

包名 `agent-ex-mcp`，MIT。发布配置已在 `package.json` 就位：

| 字段 | 值 | 说明 |
| :--- | :--- | :--- |
| `name` | `agent-ex-mcp` | 带 `-mcp` 规避 registry 包名相似度保护（`agent-ex` 撞已占用的 `agentex`） |
| `bin` | `agent-ex` → `dist/server.js` | **命令名不带 `-mcp`**：全局安装后 `agent-ex` 可直接跑 server |
| `files` | `dist` / `config.example.json` / `README.md` | 源码、`tests/`、`docs/` 不进包 |
| `publishConfig.registry` | `https://registry.npmjs.org` | 锁定发布目标为官方源（见下） |
| `prepublishOnly` | `build` + `test` | 发布前自动构建并跑全量测试，测试红则发布中止 |
| `engines.node` | `>=22.5` | 依赖 `node:sqlite`（server 与 runner 都要用） |

### 发布流程（按顺序做）

以下命令都在仓库根目录执行；`REPO=$(pwd)` 指向仓库根。示例版本号用 `0.3.0`，按实际要发的版本替换。

**① 认证**（每台机器做一次即可）

```bash
npm login --registry https://registry.npmjs.org
```

浏览器里登录并过 2FA → npm 把会话 token 写进 `~/.npmrc`。

**② 验证认证**

```bash
npm whoami --registry https://registry.npmjs.org     # 期望输出你的 npm 用户名
```

打不出用户名就别往下走——后面每一步都会以 E401 / E404 的形式失败（见「出错了怎么查」）。

**③ 改版本号**（`package.json` 与 `package-lock.json` 一起改）

```bash
npm version 0.3.0 --no-git-tag-version
```

**④ 提交 + 推送 + 打 tag**

```bash
git add -A && git commit -m "chore(release): 0.3.0" && git push origin main
git tag -a v0.3.0 -m "0.3.0" && git push origin v0.3.0
```

**⑤ 构建 + 全量测试**（`prepublishOnly` 也会跑，但先手动确认，别让发布当试验田）

```bash
npm run build && npm test
```

**⑥ 打包**

```bash
npm pack        # → agent-ex-mcp-0.3.0.tgz
```

**⑦ 把包装到干净目录里再测一次 —— 这步不能省**

```bash
REPO=$(pwd)
D=$(mktemp -d)
( cd "$D" \
  && npm init -y \
  && npm install "$REPO/agent-ex-mcp-0.3.0.tgz" \
  && ./node_modules/.bin/agent-ex --help                                                   # 子命令齐全？ \
  && node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js" ) # MCP 工具面
```

> 🔥 **为什么不能省**：0.1.0（2026-10-14 发布）就是漏了这步——当时的 CLI 层
> （`dist/cli.js` / `dist/config-cmd.js` / `dist/doctor.js`）**根本没进包**，
> 而 0.1.0 的 server 只认 `init`，其余子命令会被**静默吞成 MCP server**。
> **仓库里能跑 ≠ 包里能跑。装出来测的是包，不是仓库。**
>
> （上面用 `( … )` 子 shell 是有意的：不让临时目录改变当前工作目录，后面步骤的相对路径才不会失效。）

**⑧ 发布**

```bash
npm publish agent-ex-mcp-0.3.0.tgz --access public --registry https://registry.npmjs.org
```

> ⚠️ 国内常见的 `registry.npmmirror.com`（淘宝镜像）是**只读**的，不支持 `npm publish`，
> 也不提供注册/登录端点；带着它发布会在客户端就报 `ENEEDAUTH`。上面显式带了 `--registry` 就是为了这个。

**⑨ 发布后核验**

```bash
# ⚠️ 必须加 --prefer-online：npm 的本地元数据缓存会在发布后继续返回旧包文档，
#    表现成「明明发出去了，npm view / npm install 却说没有这个版本」
npm view agent-ex-mcp versions --registry https://registry.npmjs.org --prefer-online
npm view agent-ex-mcp@latest version --registry https://registry.npmjs.org --prefer-online

# 线上产物 == 本地构建产物？（registry 的 dist.shasum 是 sha1，不是 sha256）
curl -sS -o /tmp/reg.tgz https://registry.npmjs.org/agent-ex-mcp/-/agent-ex-mcp-0.3.0.tgz
shasum -a 1 /tmp/reg.tgz                          # 应等于 registry 的 dist.shasum
cmp /tmp/reg.tgz ./agent-ex-mcp-0.3.0.tgz          # 应完全一致
```

**⑩ 从 registry 装回来再冒烟一次**（确认用户真正装到的那一份是对的）

```bash
REPO=$(pwd)
D=$(mktemp -d)
( cd "$D" \
  && npm init -y \
  && npm install agent-ex-mcp@0.3.0 --registry https://registry.npmjs.org --prefer-online \
  && node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js" )
```

### 出错了怎么查

| 报错 | 真实含义 | 对策 |
| :--- | :--- | :--- |
| `E404 … could not be found or you do not have permission` | **多半不是包不存在**——npmjs.org 对「无权限的 PUT」故意回 404（不回 403），不泄露包是否存在 | 查 token 本身：`curl -H "Authorization: Bearer $TOK" https://registry.npmjs.org/-/whoami`。回 401 = token 失效/被撤销/权限范围不含该包；回 200 = token 有效，问题在权限 |
| `E401 Unauthorized` | token 根本不被官方源接受（过期、被撤、或 scope 不含该包） | 重做步骤 ① `npm login --registry https://registry.npmjs.org` |
| `EOTP … requires a one-time password` | 账号开了 2FA，写操作要过认证 | 见下一小节，或改用 granular token |

#### EOTP：网页认证怎么在非交互环境里走完

npm 的网页认证流程是：CLI 打印一个 `https://www.npmjs.com/auth/cli/<authId>` 链接 →
你在浏览器里登录并过 2FA → CLI 轮询 `https://registry.npmjs.org/-/v1/done?authId=…` 取回升级后的 token → 自动重试发布。

两个坑（2026-10-26 实测）：

1. **非 TTY 下 npm 会把 authId 打码成 `***`**（为了不把凭据写进 CI 日志）。想拿到真链接，得给它一个伪终端：
   ```bash
   script -q /dev/null npm publish agent-ex-mcp-0.3.0.tgz --access public --registry https://registry.npmjs.org
   ```
2. **stdin 必须保持打开**。`( sleep 9; printf '\n' ) | script …` 这种写法在 ENTER 之后立刻 EOF，
   会把 npm 的轮询循环掐断、发布**静默失败**（日志里既没有成功标记也没有错误标记）。
   要么让管道多挂一会儿，要么干脆自己在终端里跑（最省事）。

### 该用哪种凭据

| 方式 | 能力 | 适用 |
| :--- | :--- | :--- |
| `npm login` 得到的会话 token | 直接发布，但**每次发布都要过 2FA**（EOTP） | **本机手动发版首选**（步骤 ①）。token 只写在 `~/.npmrc`，不进仓库 |
| granular token + `read-write` + `bypass-2fa` | 直接发布，无需 2FA | 脚本化发版。⚠️ npm 提示**直发型 bypass-2fa token 将于 2027 年 1 月停止工作** |
| granular token + `read-write-stage-only` | 发布进**暂存队列**，需在 npm 界面确认后才公开；且**不能覆盖已发布版本** | 想要一道人工闸门时 |
| [Trusted Publisher（OIDC）](https://docs.npmjs.com/trusted-publishers) | 免长期密钥 | CI 首选。要求 npm CLI ≥ 11.5.1、Node ≥ 22.14，且**无法创建新包**（包存在后才能配） |

创建 granular token（**只在本机执行，不要把输出贴进任何地方**）：

```bash
npm token create --bypass-2fa --expires 90 --packages-all --packages-and-scopes-permission read-write
# 或 npm token create --packages-all --packages-and-scopes-permission read-write-stage-only
```

> 🔒 **凭据卫生**：token 只写在 `~/.npmrc`（或 CI 的 secret）里，**不要贴进聊天、issue、commit、日志**。
> 一旦贴出来就当已泄露——`npm token revoke <id>` 撤销（`npm token list` 查 id），
> 换一枚新的用 `npm token create`（`npm token list` **只列 granular token**，不列 `npm login` 的会话 token）。
> 注意 `npm token revoke` 本身也要过 2FA——撤销不掉的场合，直接去 npm 网站的 Access Tokens 页删。
