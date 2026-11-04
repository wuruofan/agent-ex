# `agent-ex wait` 发布清单（2026-11-05 执行）

> 背景见 [`docs/designs/2026-10-30-wait-as-cli-subcommand.md`](../designs/2026-10-30-wait-as-cli-subcommand.md)，
> 步骤依据 [`docs/plans/2026-10-30-wait-cli-implementation-plan.md`](2026-10-30-wait-cli-implementation-plan.md) 的 Task 5 / Task 6。
> **本文只是一份执行清单**，具体命令的权威版本在 `AGENTS.md` 的「发布（npm）」一节。

## 当前状态（2026-11-04 21:20 核对）

| 项 | 状态 |
| :--- | :--- |
| 代码提交 | 11 个未推送提交（`f7fcbd5` … `7616134`） |
| `npm test` | ✅ 26 files / 359 passed / 4 skipped |
| `npm run typecheck` | ✅ |
| `npm run build` | ✅ |
| 打包干跑 | ✅ 装进干净目录后 CLI 子命令齐全、MCP 工具面 6/6、`wait` 端到端跑通 |
| `package.json` 版本 | `0.2.0` ⇒ **发布时改成 `0.3.0`** |
| npm 认证 | ⏳ 未验证（明天在电脑旁做） |

## 关键约束（照抄 AGENTS.md，但这里把理由写出来）

1. **被 push 的那一批里不能含 skill 改动。** `AGENTS.md` 的流程是 ④push+tag → ⑧publish，
   所以 push 必然早于 publish。skill 若跟着版本提交一起 push 上去，别人会拿到「新 skill + 旧包」——
   新 skill 会去调还不存在的 `agent-ex wait`。
2. 因此拆成两个 commit：
   - **commit A**（已全部完成）：代码 + 测试 + 文档，**不含** skill 删脚本
   - **commit B**：删 `scripts/wait-task.mjs` + 改 SKILL.md —— **必须在 publish 之后**
3. **本机自测 skill 必须先 `npm link`**：publish 之前 `npm i -g agent-ex-mcp` 装回来的还是 0.2.0。

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
