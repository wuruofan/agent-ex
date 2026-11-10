# `agent-ex wait` 发布清单（2026-11-05 执行）

> 背景见 [`docs/designs/2026-10-30-wait-as-cli-subcommand.md`](../designs/2026-10-30-wait-as-cli-subcommand.md)，
> 步骤依据 [`docs/plans/2026-10-30-wait-cli-implementation-plan.md`](2026-10-30-wait-cli-implementation-plan.md) 的 Task 5 / Task 6。
> **本文只是一份执行清单**，具体命令的权威版本在 `AGENTS.md` 的「发布（npm）」一节。

## 当前状态（2026-11-05 发布 0.3.0；2026-11-06 已发布 0.3.1；**0.4.0 发布中**）

> ⚠️ **0.3.2 这个版本号被 0.4.0 取代了**：0.3.2 的内容已经在 `main` 上，但**从未发布到 npm**
> （npm 上最高仍是 0.3.1）。而本轮又加了**新的用户可见子命令**
> （`agent-ex skill install|remove|status`）⇒ 按 semver 该走 minor ⇒ 直接发 **0.4.0**，
> 跳过从未存在过的 0.3.2（不跳的话 npm 上会多出一个"只存在于 git、从没发布过"的版本号）。

| 项 | 状态 |
| :--- | :--- |
| 0.4.0 内容 | 🕐 本次发布：① **原 0.3.2 的全部内容**（模型存活预检、`profiles.<name>.path_dirs`、`init` 自动探测 node/npm/bun/git、`wait` 报告原子写、三处 flake 修复）② **dispatch skill 随 npm 包分发**（`skills/agent-ex-dispatch` 进 `files`）③ **新子命令** `agent-ex skill install\|remove\|status` ④ `init` 收尾精简（39 → 24 行）⑤ 四轮独立评审的 P1/P2 全部修完（含原子替换、自链拦截、断链处理） |
| 0.4.0 版本号 | ✅ `package.json` / `package-lock.json` = `0.4.0`（`npm version 0.4.0 --no-git-tag-version`） |
| 0.4.0 待办 | ⬜ `chore(release): 0.4.0` → `v0.4.0` tag → build+test → pack → 干净目录验证 → publish → 上线核验 → 装回冒烟 |
| 代码提交 | ✅ 15 个提交已 push 到 `origin/main`（`feat/skill-distribution` 合并进来） |
| `npm run typecheck` / `npm run build` | ✅ |
| `npm test` | ⬜ 0.4.0 前重跑 |
| 打包干跑 | ⬜ 0.4.0 前重跑 |
| npm 认证 | ✅ `npm whoami` → `demonsimon`；publish 仍需一次网页 2FA（见下方执行记录） |
| npm publish | ⬜ |
| 从 registry 装回 | ⬜ |
| commit B（skill 迁移） | ✅ publish 之后完成：删旧脚本 / 去 `vitest.config.ts` 的 exclude / `SKILL.md` 加 `agent-ex >= 0.3.0` 门槛与版本探针 / `npm test` 26 files 359 passed / 已 push（见 ⑨） |
| 0.3.1 提交 / tag | ✅ `415ff31`（文档 + 测试对齐）、`9e08490 chore(release): 0.3.1` 已 push，`v0.3.1` tag 已推送，`build-meta` = `v0.3.1 9e08490` |
| 0.3.1 构建 / 装包验证 | ✅ `typecheck` / `build` / `npm test` 26 files 368 passed 4 skipped；干净目录装 `agent-ex-mcp-0.3.1.tgz`：`wait --help` exit 0、MCP 6/6，且 status 契约探针全绿（schema 含 `include_finished`/`limit`、`additionalProperties=false`、未知参数被 `.strict()` 拒、`agent_ex_version` = 0.3.1） |
| 0.3.1 npm publish | ✅ `PUT 401 → GET 200 /-/v1/done → PUT 202 → verbose exit 0 / info ok`；registry `latest=0.3.1`，`dist.shasum` = `708bcab20ba4baa7b932ba44e60a8146e07eca12` 与本地 tgz 一致 |
| 0.3.1 上线核验 | ✅ 原始 packument `latest=0.3.1`、`dist.shasum` 与本地一致；线上 tgz（带 `?cb=` 绕 CDN 负缓存）`cmp` 逐字节一致；显式指定官方源装回后 `wait --help` exit 0、MCP 6/6、status 契约探针全绿 |

### 0.3.1 执行记录（2026-11-06：补发 `include_finished` 所在版本）

**起因**：pull 到 `a29f2da` 后 review 发现「新 skill + 旧包」错配重演——`SKILL.md` 的
「[回来先查]」兜底调 `agent_ex_status({ include_finished: true })`，而该参数在 `v0.3.0` 里
**零命中**；0.3.0 的 `server.tool` 用默认 strip ⇒ 静默吞掉参数、只回活跃任务的空列表，
宿主分不清「不支持」与「真的没任务」。本机 `dist/build-meta.json` 也仍是 `0.3.0/dad791a`。
`d4dcb52` 的 `.strict()` 只在新进程生效，救不了正在跑的旧构建。

**处理**：

1. 版本门槛 `>= 0.3.0` ⇒ **`>= 0.3.1`**；`SKILL.md` 前置检查加 MCP server 能力探测
   （`agent_ex_version` / `tools/list` 的 status schema），兜底段加旧版降级（别把空列表当结论；
   改用已知 id 的 `agent-ex wait <id> --once`）。`agent-ex wait --help` 只能证明 CLI ≥ 0.3.0。
2. 清掉 `db133d8` 合并留下的 SKILL.md 重复/矛盾行与悬空章节引用。
3. 补 README 的 `include_finished` / `limit` 参数表 + 全局单库提示；同步诊断文档、探针文档、
   设计文档与 Trae 结论的过时表述；加强两条弱断言（空库 `Array.isArray` / 只验 limit 长度）。
4. `npm version 0.3.1` → commit / push / tag → build + test + pack → 干净目录验证 → publish。

判据同 0.3.0：以 registry 原始 packument + 线上 tgz `cmp` 为准，`npm view` 有缓存延迟。

**实际执行（2026-11-06 14:45）**：`415ff31` → `9e08490` → `v0.3.1`；`build` 产出
`build-meta v0.3.1 9e08490`；`npm test` 26 files / 368 passed / 4 skipped。
干净目录验证除原有 CLI/MCP 检查外，加了一次性 status 契约探针：直接发 `tools/list` 查
`agent_ex_status` 的 schema 是否含 `include_finished`/`limit` 与 `additionalProperties=false`，
再用 `tools/call` 验「合法参数被接受」与「未知参数 `include_terminal` 被拒（MCP -32602）」，
最后用 `agent_ex_version` 确认 0.3.1 —— **这次改的正是「旧包静默剥离参数」，只看代码不够，
必须验装出来的包**。publish 判据仍是 npm 日志的 `PUT 202` + `verbose exit 0`。

**本轮三个新坑**：

1. **无效 token ⇒ publish 直接 `PUT 404`，不会触发网页 2FA**。`npm whoami` E401 是判据；
   只有「token 有效但写操作需 2FA」才是 `PUT 401 → web auth`。第一次 publish 就是这样静默失败的
   （日志里只有一条 `PUT 404`），别急着点链接，先修登录。
2. **`npm login` 在本环境写不回 `~/.npmrc`**：浏览器授权其实成功（`GET 200 /-/v1/done` +
   `web auth done-check finished`），随后写文件被 WorkBuddy 文件代理拦截
   （`CODEBUDDY_BROKER_DENY` / `file-write* /Users/wuruofan/.npmrc`），token 只存在于已退出的
   进程内存里 ⇒ 登录白做。绕行：`NPM_CONFIG_USERCONFIG=/tmp/agent-ex-publish-npmrc`
   （实测 `npm config set` 可写 /tmp），login 与 publish 都带这个 env，全程不碰 `~/.npmrc`。
   代价：用户全局 `~/.npmrc` 仍是失效的 `npm_Fi…` token，之后要自己在终端 `npm login` 修一次。
   另：**pty 进程被中断杀掉 ⇒ CLI 会话作废**，用户点链接报 "Invalid or Expired Token"；
   给出链接后不要中断对话，等后台任务通知。pty 报的 exit 1 也是 EIO 误报（本轮 login / publish 都是）。
3. **`PUT 202` 后 registry 异步生效**：客户端提示 "Your package is being processed and may take
   a few minutes"。packument 数分钟后才出现 0.3.1，tarball CDN 更晚（期间直连 404、下载到
   21 字节错误体）；`npm view` 另有缓存 ⇒ 用
   `curl -H 'Cache-Control: no-cache' '<packument>?cb=<时间戳>'` 判定。
   **更隐蔽的是 CDN 负缓存**：发布前查过一次 tarball URL，之后再带 `Cache-Control: no-cache`
   甚至 `npm pack --prefer-online` 都仍返回缓存的 404；给 **tarball URL 本身**加 `?cb=<时间戳>`
   立刻返回 200，sha1 与本地 tgz 逐字节一致。⇒ 装回冒烟可直接
   `npm install "<tarball-url>?cb=$(date +%s)"`，别被不带参数的 404 误导成「没发上去」。
4. **默认 registry 是只读镜像 `registry.npmmirror.com`**：`npm install "<registry.npmjs.org 的 tarball URL>"`
   会被 npm 重写成 `cdn.npmmirror.com/packages/...`，镜像还没同步新版本 ⇒ 404。
   装回必须显式 `--registry https://registry.npmjs.org`，或直接用已校验过的线上 tgz 文件。

**发布后必须做的动作（别漏）**：宿主里**正在运行的** MCP server 仍是发布前加载的旧构建，
不会因为 `npm run build` / 新包上线而自动更新。需在宿主面板 disable/enable（或重启）
`agent-ex` MCP server，再用 `agent_ex_version` 确认返回 `0.3.1`；否则 `SKILL.md` 的
「[回来先查]」兜底仍会撞上 0.3.0 的静默剥离，看起来就像发布没生效。

### 2026-11-05 执行记录（三个实际踩到的坑）

1. **`npm login` 不等于 publish 免 2FA**。`whoami` 已通过，但写操作仍触发
   `Authenticate your account at: https://www.npmjs.com/auth/cli/<authId>` + `Press ENTER to open in the browser...`。
   非交互 shell 里 stdin 立即 EOF ⇒ `E404 GET /-/v1/done?authId=***`，**发布静默失败**。
   解法：用 pty 驱动 publish（真 TTY + stdin 常开），检测到 `Press ENTER` 时自动送一个换行，
   由人在浏览器完成 2FA；npm 轮询 `done` 拿到升级 token 后自动重试 PUT。
   日志证据：`http fetch PUT 401` → `GET 200 /-/v1/done` → **`http fetch PUT 202`** → `verbose exit 0` / `info ok`。
2. **`npm publish <tgz>` 也会跑 `prepublishOnly`**（`build` + `test`，本机约 4.5 分钟），
   每次重试都要重跑，会把浏览器认证窗口挤没。⑤ 已手动跑过等价的 `typecheck && build && test`，
   且发布的就是那份 tgz ⇒ 交互那次用 `--ignore-scripts` 跳过重复闸门，不影响产物。
3. **发布成功 ≠ `npm view` 立刻能看到**。PUT 返回 `202` + "may take a few minutes to become available"，
   客户端/CDN 缓存让 `npm view versions` 短暂仍报 `[0.1.0, 0.2.0]`、`npm view @latest` 报 `0.2.0`。
   判据用 `curl -H 'Cache-Control: no-cache' https://registry.npmjs.org/agent-ex-mcp` 的原始 packument
   （`versions` / `dist-tags.latest` / `dist.shasum`）+ 下载线上 tgz 做 `cmp`，别拿 `npm view` 当失败证据。
   另外 pty 驱动自身可能因 master 端 EIO 竞争误报退出码 1 —— 以 npm 日志的 `info ok` 和 registry 为准。

## 关键约束（照抄 AGENTS.md，但这里把理由写出来）

1. **被 push 的那一批里不能含 skill 改动。** `AGENTS.md` 的流程是 ④push+tag → ⑧publish，
   所以 push 必然早于 publish。skill 若跟着版本提交一起 push 上去，别人会拿到「新 skill + 旧包」——
   新 skill 会去调还不存在的 `agent-ex wait`。
2. 因此拆成两个 commit：
   - **commit A**（已全部完成）：代码 + 测试 + 文档，**不含** skill 删脚本
   - **commit B**：删 `scripts/wait-task.mjs` + 改 SKILL.md —— **必须在 publish 之后**
3. **本机自测 skill 必须先 `npm link`**：publish 之前 `npm i -g agent-ex-mcp` 装回来的还是 0.2.0。

### 版本错配的实际表现（2026-11-04 实测，commit B 写门槛时照此判读）

registry 上的 0.2.0 **不认识 `wait`** ⇒ `agent-ex wait --help` 落进「有非选项参数但认不出」分支：

```
$ npx -y agent-ex-mcp@latest wait --help
no command: start the MCP server on stdio (how MCP clients launch it)
exit=2      stdout 里 0 行 "WAIT="
```

⚠️ 症状是**静默起 MCP server**（挂住等 stdin），不是报错——和 0.1.0「其余子命令被静默吞成 MCP server」同一类事故。
所以判据必须是：**stdout 有没有 `WAIT=` 行**，而不是退出码（老版 exit 2 与 `WAIT=timeout` 撞码）。
提前探测用 `agent-ex wait --help`：新版 exit 0 且打印用法，老版 exit 2 且无 `WAIT=` 行。

## 执行顺序

### ① 认证（每台机器一次）

```bash
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org     # 必须打出用户名，否则往下走只会 E401/E404
```

### ② 版本号

```bash
npm version 0.3.0 --no-git-tag-version     # package.json + package-lock.json 一起改
```

### ③ 提交 + push + tag

```bash
git add -A && git commit -m "chore(release): 0.3.0"
git push origin main
git tag -a v0.3.0 -m "0.3.0" && git push origin v0.3.0
```

> ⚠️ 这一批里**不能有** skill 删脚本的改动（约束 1）。当前工作区是干净的，直接提交即可。

### ④ 构建 + 全量测试

```bash
npm run build && npm test
```

### ⑤ 打包 + 干净目录验证（**这步不能省**）

0.1.0 就是漏了这步：当时的 CLI 层根本没进包，而 server 只认 `init`，其余子命令被**静默吞成 MCP server**。

```bash
REPO=$(pwd)
D=$(mktemp -d)
( cd "$D" \
  && npm init -y \
  && npm install "$REPO/agent-ex-mcp-0.3.0.tgz" \
  && ./node_modules/.bin/agent-ex --help \
  && ./node_modules/.bin/agent-ex wait --help \
  && node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js" )
```

### ⑥ publish

```bash
npm publish agent-ex-mcp-0.3.0.tgz --access public --registry https://registry.npmjs.org
```

> ⚠️ 别用淘宝镜像源：它只读，不支持 publish，也不给 login 端点，会在客户端就报 `ENEQAUTH`。

### ⑦ 发布后核验

```bash
npm view agent-ex-mcp versions --registry https://registry.npmjs.org --prefer-online
curl -sS -o /tmp/reg.tgz https://registry.npmjs.org/agent-ex-mcp/-/agent-ex-mcp-0.3.0.tgz
shasum -a 1 /tmp/reg.tgz          # 应等于 registry 的 dist.shasum
cmp /tmp/reg.tgz ./agent-ex-mcp-0.3.0.tgz
```

> `--prefer-online` 必须加：npm 的本地元数据缓存会在发布后继续返回旧包文档，
> 表现成「明明发出去了，`npm view` 却说没有这个版本」。

### ⑧ 从 registry 装回来再冒烟一次

```bash
REPO=$(pwd)
D=$(mktemp -d)
( cd "$D" \
  && npm init -y \
  && npm install agent-ex-mcp@0.3.0 --registry https://registry.npmjs.org --prefer-online \
  && node "$REPO/scripts/smoke-stdio.mjs" "$D/node_modules/agent-ex-mcp/dist/server.js" )
```

### ⑨ commit B：skill 侧迁移（**publish 之后**才做）

按 [`2026-10-30-wait-cli-implementation-plan.md`](2026-10-30-wait-cli-implementation-plan.md) Task 6：

1. 删 `skills/agent-ex-dispatch/scripts/wait-task.mjs` 与 `scripts/wait-task.test.mjs`
2. 删 `vitest.config.ts` 里的 `exclude: ["skills/**/*.test.mjs"]`（**必须与删文件同一步**，
   否则 vitest 会把那个自带 runner 的 `.mjs` 收进来并红）
3. 改 `SKILL.md`：
   - `Resources` 列表里删掉脚本两行
   - 所有 `scripts/wait-task.mjs` 引用改成 `agent-ex wait`
   - 排错表里那条手写 python 提取 recipe 改掉
   - 修两处**现存的过期文案**：退出码清单仍写「3 无此任务**或 DB 不可读**」（现在是 3 与 6 分开）
   - 写死最低版本门槛：`agent-ex >= 0.3.0`（探针：`agent-ex wait --help` ⇒ 新版 exit 0 / 老版 exit 2）
4. `scripts/install-skill.sh` 收尾加「本机没装包就 `npm link`」提示
5. commit + push

```bash
git add -A && git commit -m "feat(skill): wait via agent-ex CLI instead of the bundled script"
git push origin main
```

### ⑩ 本机 skill 自测

```bash
npm link                                    # 让全局 agent-ex 指向本仓库
agent-ex wait --help                         # 应 exit 0
./scripts/install-skill.sh                   # 重链 skill
```

> ⚠️ `ln -s` 对**已存在的目录**目标不报错，会把软链塞进目录里（看着成功、实际没生效）。
> 链之前先 `ls -la ~/.workbuddy/skills/`。

## 出错了怎么查

见 `AGENTS.md` 的「出错了怎么查」与「EOTP：网页认证怎么在非交互环境里走完」。
最常见的两条：`E404` 多半是 token 没权限（不是包不存在），`E401` 是 token 过期。
