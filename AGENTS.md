# AGENTS.md

把 AI 编程 Agent（Claude Code / OpenCode）当作**外部执行者**来协作的 MCP Server：派发后台任务、让外部 agent 独立出方案、相互 review。

## 文档分工（别把东西写错地方）

| 文件 | 写什么 |
| :--- | :--- |
| [`README.md`](README.md) | 怎么**用**（安装 / 配置 / 命令 / MCP 工具 / 排错）。**英文**，npm 页面与 GitHub 共用这一份 |
| [`docs/README.zh-CN.md`](docs/README.zh-CN.md) | README 中文版，章节一一对应 |
| [`docs/user-guide/`](docs/user-guide/) | 用户手册深度章节（config 全字段 / 飞书通知 / 状态机与 wait 契约 / init 流程） |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本历史（每个版本号只发布一次；同时是 GitHub Release 正文） |
| **AGENTS.md**（本文件） | 怎么**改**：硬约束、连带改动、测试与发布流程 |
| `docs/specs/` `docs/reviews/` `docs/plans/` `docs/designs/` | 深层设计与归因（「当初为什么这么定」） |

规则：**同一条事实只写一处**，另一处给链接。

- **npm 包页面的 README = 仓库根 `README.md`，逐字节相同** ⇒ 想改 npm 页面就改它。
- npm 按项目根的目录顺序 glob `{README,README.*}` 取 README（不按文件名排序）⇒ 项目根**只能有一个** README，中文版放 `docs/`。

## Setup commands

- Install deps: `npm install`
- Build: `npm run build`（`tsc` → `dist/`，附带生成 `dist/build-meta.json`）
- Test: `npm test`（Vitest，含 integration）· Typecheck: `npm run typecheck`
- 开发模式：`npm run server`（`tsx src/server.ts`）· `npm run init`（`tsx src/init.ts`）
- 装 dispatch skill（可选）: `./scripts/install-skill.sh`

## Project layout

- `src/` — 全部源码
  - `server.ts` — MCP server 入口 + 子命令分派（`init` / `doctor` / `config` / `profile` / `wait`）
  - `runner.ts` · `spawn-runner.ts` — detached runner、进程树
  - `store.ts` — SQLite 状态机（`node:sqlite`）
  - `wait.ts` — 阻塞等待（只读打开 / 副本降级 / 预算推导）+ stdout 契约
  - `report.ts` — 从 runner 日志提取最终报告（复用 executor 的 `parseEvent`）
  - `tools/` — MCP 工具（submit / status / cancel / version / restart / doctor）
  - `executors/` — agent CLI 适配（claude / opencode）
  - `config.ts` — 配置校验的**单一真相源**（`collectConfigIssues`）
  - `config-cmd.ts` — `config` / `profile` 子命令的纯函数
  - `init.ts` — 交互式向导 · `doctor.ts` — 体检 · `zen-free.ts` — zen 免费模型动态解析
- `tests/` — Vitest；`integration.test.ts` 真起 runner 跑完整生命周期
- `scripts/` — 构建与冒烟脚本
- `docs/` — spec / review / plan / design / **user-guide**
- `skills/agent-ex-dispatch/` — dispatch skill（**随 npm 包分发**；开发时用 `./scripts/install-skill.sh` 软链）

## 硬约束（改代码前必读）

1. **init 的用户可见输出必须全英文。** `tests/init.test.ts` 扫 `src/init.ts` 里所有 `console.log/error`、`ask()`、`rl.question()` 行，出现中文就红。代码注释可以是中文。
2. **`config` / `profile` 的写入口是白名单**（`src/config-cmd.ts` 的 `WRITABLE` + `executors.<name>.bin`；`profile set` 的保留字是 `executor` / `path_dirs` / `cost`，其余 key 当 env 变量名）。不要加通用点路径写入。
3. **profile env 禁写 `NODE_OPTIONS` / `PATH` / `LD_*` / `DYLD_*`**——它们是 worker 的启动/加载面（等价于任意代码执行）。受控 PATH 只来自 `profile.path_dirs`（绝对目录列表，只能走 `profile set`）。
4. **`{model:zen-free}` 不能被换成硬编码模型名**（`setProfileValue` 会拦）：free 模型集会轮换，配置里必须零硬引用。
5. **`init` 是全量覆盖式**：重跑会重写 `config.json`、丢掉其它 profile 与 `dry_run`。改单个字段一律走 `config set` / `profile set`。
6. **校验只有一个真相源**：`collectConfigIssues()` 同时被 `validateConfig()` 和 `doctor` 消费，别在 doctor 里另写一套。
7. **`server.ts` 顶层 import 必须「每个分支都用且便宜」**：目前只留 `env-file` / `brand` / `ansi` / `marks`；MCP SDK、zod、`submit/status/cancel/doctor/wait` 全在分支里动态 import。原因：① 启动税——MCP SDK 拖进几百个模块，`agent-ex wait` 每次白付（实测 6s → 0.9s）；② SQLite 噪音——静态 import `store` 会让 `init` 也加载 SQLite，实验性警告异步插进交互提示符。
8. **worker 环境不继承 shell**：`buildAgentEnv()` 只给 `HOME` / `TMPDIR` / `PATH` + profile env（`{env:VAR}` 在此解析），PATH 完全自建、不读 `process.env.PATH`。注意 `HOME` 会传 ⇒ `~/.claude/settings.json` 里的 env 对 worker 仍生效；`profile.path_dirs` 是 worker PATH 的唯一受控来源（插在 executor bin 之后、系统目录之前）。

## 改动时的连带规则

| 你改了 | 还要同步 |
| :--- | :--- |
| MCP 工具（增/删/改名） | `tests/server-tools.test.ts` 的 6 工具断言、`scripts/smoke-stdio.mjs` 的 `PRODUCTION_TOOLS`、README×2 的「MCP tools」表 |
| CLI 子命令 | `src/server.ts` 的 `USAGE`、`src/cli.ts` 的 usage、README×2 的「CLI commands」表 |
| 内置 profile / `ZEN_FREE_PREFER` | `src/config-cmd.ts` 的 `BUILTIN_PROFILES`、`config.example.json` |
| profile 的 `cost` 字段 | `config.example.json` 的每个 profile、`docs/user-guide/configuration.md` 字段表、README×2 配置字段表 |
| 品牌名（`BRAND`） | `config.example.json`、README（`tests/config.test.ts` 钉住——README 里必须出现 `"keyword": "agent-ex"`） |
| MCP Registry 元数据 | `server.json` 的两个 `version` 与 `package.json` 同版本、`name` 与 `mcpName` 逐字一致、`packages[0].identifier` 是 npm 包名；发版时手动 bump（步骤 ③）并走 ⑩；`tests/config.test.ts` 钉住 |
| 用户可见文案 | README 对应章节 + `docs/README.zh-CN.md` 对应章节 + `docs/user-guide/` 相关篇 |
| README（英文） | 中文版章节一一对应；深度内容只写 `docs/user-guide/`，README 只给摘要 + 链接 |
| 宿主表（`src/skill.ts` 的 `SKILL_HOSTS`） | README×2 的宿主名、`src/skill-cmd.ts` 的 `USAGE`（自动生成，别手抄）。目录与「在场判据」对着 `npx skills`（vercel-labs/skills）核，别凭印象写 |

## Testing instructions

- 单元 + 集成：`npm test` · 单独跑集成：`npm run test:integration` · 类型检查：`npm run typecheck`
- 新增行为一律补测试，参考同目录 `*.test.ts` 写法
- 冒烟：`node scripts/smoke-stdio.mjs [server.js 路径]`（默认本仓库 `dist/`）——断言 6 个生产工具齐全、TEST ONLY 工具未暴露
- 提交前全绿

## PR & commit conventions

- 分支从 `main` 切，不直接推 `main`
- Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `chore(release):`），英文正文；**不加** AI trailer
- 推 `main` 前确认工作区干净、`npm test` 全绿

## Security

- **密钥零落盘**：`config.json` 只放 `{env:VAR}` 占位符，真实密钥在 `$AGENT_EX_HOME/.env`（chmod 600，不进 git）
- worker 以「跳过权限确认」运行（claude `--dangerously-skip-permissions` / opencode `--auto`）——改默认权限前先想清楚
- **不要把 npm token / API key 贴进代码、文档、issue、聊天**；凭据只写 `~/.npmrc` 或 CI secret，npm token 一律本机创建

## 安装（从源码）

```bash
git clone https://github.com/wuruofan/agent-ex && cd agent-ex
npm install && npm run build    # tsc → dist/
npm run init                    # 开发模式跑 init（tsx）
./scripts/install-skill.sh      # 可选：装 dispatch skill
```

## 发布（npm）

包名 `agent-ex-mcp`，MIT。关键字段：

| 字段 | 值 | 说明 |
| :--- | :--- | :--- |
| `name` | `agent-ex-mcp` | 带 `-mcp` 规避包名相似度保护（`agent-ex` 撞已占用的 `agentex`） |
| `bin` | `agent-ex` → `dist/server.js` | 命令名不带 `-mcp` |
| `files` | `dist` / `skills/agent-ex-dispatch` / `config.example.json` / `server.json` / `README.md` | 源码、`tests/`、`docs/` 不进包 |
| `publishConfig.registry` | `https://registry.npmjs.org` | 锁定官方源 |
| `prepublishOnly` | `build` + `test` | 测试红则发布中止 |
| `engines.node` | `>=22.5` | 依赖 `node:sqlite` |

### 发布流程（按顺序做；示例版本号 0.3.0，替换成实际版本）

**① 认证**（每台机器一次）→ **② 验证**

```bash
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org     # 打不出用户名就别往下走
```

**③ 写 CHANGELOG + 改版本号**

`CHANGELOG.md` 顶部加 `## X.Y.Z（YYYY-MM-DD）`：一句概括 + 要点列表。**只写用户可见的变化与迁移动作**（每条一到两行）；归因与实测细节放 `docs/designs/`，别塞进来。

```bash
npm version 0.3.0 --no-git-tag-version    # 改 package.json 与 package-lock.json
```

⚠️ `npm version` 不碰 `server.json`：它的两个 `version` 必须手动同步（Registry 同版本不可重发，漏改会让 ⑩ 失败；`tests/config.test.ts` 会在测试阶段先拦）。

**④ 提交 + 推送 + 打 tag**（CHANGELOG 与版本号必须在同一次提交里）

```bash
git add -A && git commit -m "chore(release): 0.3.0" && git push origin main
git tag -a v0.3.0 -m "0.3.0" && git push origin v0.3.0
```

> ⚠️ **之后不能再有 commit**：tag 打在 release commit 上，⑤⑥ 打包与 ⑧ 发布用的都是当前工作区 ⇒ 再提交会让 tag 指向比发布物旧的树。要改就在 ④ 之前改。

**⑤ 构建 + 全量测试**（别让发布当试验田）

```bash
npm run build && npm test
```

**⑥ 打包 → ⑦ 装进干净目录再测一次（不能省）**

```bash
REPO=$(pwd); D=$(mktemp -d)
( cd "$D" && npm init -y && npm install "$REPO/agent-ex-mcp-0.3.0.tgz" \
  && ./node_modules/.bin/agent-ex --help \
  && node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js" )
```

> **仓库里能跑 ≠ 包里能跑**：0.1.0 就是漏了这步——CLI 层没进包，其余子命令被静默吞成 MCP server。子 shell 是有意的，别改变当前工作目录。

**⑧ 发布**

```bash
npm publish agent-ex-mcp-0.3.0.tgz --access public --registry https://registry.npmjs.org
```

> `registry.npmmirror.com`（淘宝镜像）只读，不支持 publish，会报 `ENEEDAUTH`。

**⑨ 核验**

```bash
npm view agent-ex-mcp versions --registry https://registry.npmjs.org --prefer-online   # 必须带 --prefer-online
curl -sS -o /tmp/reg.tgz https://registry.npmjs.org/agent-ex-mcp/-/agent-ex-mcp-0.3.0.tgz
shasum -a 1 /tmp/reg.tgz && cmp /tmp/reg.tgz ./agent-ex-mcp-0.3.0.tgz               # 与 dist.shasum 一致
```

**⑩ 发布到 MCP Registry**（`registry.modelcontextprotocol.io`，只存元数据）

> **顺序不能反**：Registry 会去 npm 拉**已发布**的包读 `mcpName`，与 `server.json.name` 逐字比对 ⇒ 必须先完成 ⑧。0.5.1 及以前没有 `mcpName`，过不了这关。

```bash
mcp-publisher validate server.json      # 不需要登录，但要联网拉 schema
mcp-publisher login github              # device flow，只能授权个人命名空间 io.github.wuruofan/*
mcp-publisher publish server.json
curl -sS "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.wuruofan/agent-ex"
```

> 版本发布后**不可改**；撤下用 `mcp-publisher status --status deprecated --message "…" io.github.wuruofan/agent-ex 0.6.0`（flag 在位置参数前）。清单改了只能发新版本号。

**⑪ 从 registry 装回来冒烟**

```bash
REPO=$(pwd); D=$(mktemp -d)
( cd "$D" && npm init -y \
  && npm install agent-ex-mcp@0.3.0 --registry https://registry.npmjs.org --prefer-online \
  && node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js" )
```

**⑫ 发 GitHub Release**（全绿之后；失败可安全重试）

```bash
V=0.3.0
node scripts/release-notes.mjs "$V" > /tmp/release-notes.md   # 从 CHANGELOG 派生，不手写第二份
gh release create "v$V" --verify-tag --title "$V" --notes-file /tmp/release-notes.md
```

### 出错了怎么查

| 报错 | 真实含义 | 对策 |
| :--- | :--- | :--- |
| `E404 … not found or you do not have permission` | 多半不是包不存在——npmjs.org 对无权限的 PUT 故意回 404 | `curl -H "Authorization: Bearer $TOK" https://registry.npmjs.org/-/whoami`：401 = token 失效/权限不含该包；200 = 问题在权限 |
| `E401 Unauthorized` | token 不被官方源接受 | 重做 ① |
| `EOTP` | 账号开了 2FA | 见下，或改用 granular token |

**EOTP 的两个坑**：① 非 TTY 下 npm 把 authId 打码成 `***`，要真链接得给伪终端（`script -q /dev/null npm publish …`）；② stdin 必须保持打开，`( sleep 9; printf '\n' ) | script …` 会在 ENTER 后 EOF，掐断轮询并**静默失败**。最省事是在终端里手动跑。

### 该用哪种凭据

| 方式 | 能力 | 适用 |
| :--- | :--- | :--- |
| `npm login` 会话 token | 直接发布，每次过 2FA | 本机手动发版首选；token 只写 `~/.npmrc` |
| granular + `read-write` + `bypass-2fa` | 直接发布，无需 2FA | 脚本化；npm 提示直发型 bypass-2fa token 2027-01 停止工作 |
| granular + `read-write-stage-only` | 进暂存队列，需网页确认；不能覆盖已发布版本 | 想要人工闸门 |
| [Trusted Publisher（OIDC）](https://docs.npmjs.com/trusted-publishers) | 免长期密钥 | CI；要求 npm CLI ≥ 11.5.1、Node ≥ 22.14，且无法创建新包 |

```bash
npm token create --bypass-2fa --expires 90 --packages-all --packages-and-scopes-permission read-write
```

> 🔒 token 只写 `~/.npmrc`（或 CI secret），**绝不贴进聊天、issue、commit、日志**。泄露了立即 `npm token revoke <id>`（`npm token list` 只列 granular token）；`revoke` 也要过 2FA，不行就去网页删。
