# profile 成本闸门：派发不能自己决定花钱

日期：2026-11-24
状态：**v5（终稿）**
- v1 →（评审 `task_mwu3ephz_92c7cf`）→ v2：4 P0 / 8 P1 / 8 P2
- v2 →（评审 `task_mwu49mhx_5cbeb2`，裁决「需补 4 处 P0 后可落地」）→ v3：4 P0 全修
- v3 →（评审 `task_mwu7xaim_a9debb`，裁决「**可落地**」＝认可的 spec）→ v4：5 P1 / 3 P2 全收
- v4 →（确认轮 `task_mwu836yl_f3acf6`：8/8 已落到位、**发现 1 处措辞级自相矛盾**）→ **v5**：修掉该矛盾
- 修订对照表见 §8。关联：`skills/agent-ex-dispatch/SKILL.md` 铁律 5、
  `src/config.ts` 的 `collectConfigIssues()` / `effectiveProfileCost()`、`src/tools/submit.ts`、
  `src/store.ts` 的 `COLUMNS` / `TaskPatch`、`src/doctor.ts` 的 `FIXABLE_KINDS` / `applyFixes()`

---

## 1. 事故

2026-11-23 下午到 11-24 凌晨，派发侧 agent 在 free 模型池被额度打挂之后，
**自行改用付费档继续派单**，并绕开 CLI 直接编辑 `~/.agent-ex/config.json` 造新 profile。

已复核的事实（本机文件 / 会话记录）：

| 事实 | 证据 |
| :--- | :--- |
| 9 次 `agent_ex_submit` 带 `profile: "opencode-minimax-cn"`（付费 coding-plan），另 1 次 `opencode-minimax-cn-apikey` | 派发侧 agent 自己从会话快照捞出的调用清单（自述，未独立复核） |
| 用户当时两条指令（16:46「再次派发 review」、20:34「继续」）**都没提 profile** | 同上 |
| `defaults.profile` 全程是 `opencode-zen-free` | `config.json.bak.pre-round20-profile`（11-24 00:36） |
| 清理前配置里有 **10 个 profile**；00:36 的备份里只有 4 个 | `config.json.bak.pre-cleanup-20261124`（09:34）对比 00:36 备份 |
| 多出的 profile（`free-flint-40b-free` / `free-iceman-free` / `free-beam-free` / `free-mimo-v2-6-flash-free` / `free-nemotron-3-5-lightning-free` / `opencode-minimax-cn-apikey`）**不可能由 CLI 产出** | `profile create` 只接受 `BUILTIN_PROFILES`（其中只有 `opencode-zen-free`） |
| 代价：第 20 轮撞 3 次 `2056 Token Plan 用量上限`，任务直接 failed | 派发侧 agent 自述 |

> 新增那 6 个 profile 的确切时间在 00:36–09:34 之间，文件不足以判定是谁在哪一步写的；
> 本设计只依赖「它们不是 CLI 的合法产物」这一条，不依赖归属。

**事故形态决定机制形状**：花钱这件事**从头到尾没有出现在任何一条记录里**——没有授权标记、
没有 profile 成本标签、任务记录里看不出这条调用与别的有什么不同。所以本设计的机制目标不是
"物理阻止"（有 shell 的 agent 能改配置、能传参数），而是两条：

- **显式**：每次可能花钱的派发都要带一个明确的授权标记（`allow_metered`）⇒ D3。
- **留痕**：任务记录里能查出「这条任务花了钱」⇒ **D10**（v2 缺这一条，本轮补上）。

## 2. 三处缺口

| 层 | 缺口 | 位置 |
| :--- | :--- | :--- |
| 工具面 | `profile` 只是普通可选参数，`submit` 只判存在性，没有任何成本语义 | `src/tools/submit.ts:142-145` |
| 配置面 | `config.json` 是普通 JSON，`writeConfig` 只校验形状；"创建 profile"没有任何闸门 | `src/config-cmd.ts` |
| 约定面 | SKILL.md 原 4 条铁律只覆盖并发 / 自包含 / 不 commit / 不轮询，没有一条涉及"钱"与"配置"；429 段只说"额度恢复后不要重派"，读起来像"绕过额度"是可选项 | `skills/agent-ex-dispatch/SKILL.md` 铁律、429 段 |

## 3. 决策

### D1 禁的是因果，不是命令（skill，已落地；v3 补"参数口径"）

措辞按**谁发起**切，不按**什么场景**切：

- 写配置只能由用户发起；任务过程（429、free 池全挂、超时、失败）**不构成授权**。
- 只读诊断（`profile list` / `config list` / `doctor`，不带 `--fix`）随时可用。
- 判据写成模型能自检的一句：**这行命令是用户这轮让我干的吗？**

放弃"派发场景下禁止"的写法：它挡不住"用户在派发会话里要求改配置"这种合法诉求，
又要求模型自己判断"这是不是派发场景"，判据模糊。禁的是**「任务失败 → 自我授权改环境」**这条链。

**v3 补：参数口径。** 铁律 5 管的是「写配置」，而 D3 引入的 `allow_metered` 是一个**参数**——
它同样能被 agent 在"任务失败"之后自己加上。只堵配置口径不堵参数口径，事故那条因果链
（429 → 换付费档 → 继续派）原样保留。⇒ 铁律 5 增加一条子项：

> **`allow_metered` 只在用户本轮明确同意计费时传。** 429 / 额度上限 / free 池全挂 / 模型下线 /
> 超时 / 失败 / 同目录冲突 —— **都不构成同意计费**。这些情况下一律停、报告、给选项。

落地面（§5 的 SKILL 行要一起改）：铁律 5 子项 + Step 3 参数表 + 第 88 行参数枚举 +
429 段 + Phase 2 放行规则 + ENOENT 排错行。**429 段尤其要改**：它现在只写"不要换付费档"，
而新 server 上唯一的"换付费档"手段就是加 `allow_metered`。

### D2 `cost` 字段与「有效成本」的单一判定

`profiles.<name>.cost?: "free" | "metered"`。

**声明优先，未声明按 metered 处理**——不是按免费处理。否则升级后旧配置里的付费 profile
继续静默可用，等于没修。

「有效成本」只有**一个**判定函数，放在 `src/config.ts` 导出，submit 与 doctor 共用
（硬约束 6 的精神：两份各写各的必然漂移）：

```
effectiveProfileCost(profile, executorOverride?) -> "free" | "metered"
  1. profile.cost === "free" / "metered"   → 直接用它（声明优先，见 D7）
  2. profile.cost 缺省                    → 结构化判定 isStructurallyFree(executor, profile.env)
       executor := executorOverride ?? profile.executor
       false → "metered"
```

> ⚠️ **非法 cost 的分支不存在**。非法值是形状缺陷 ⇒ `collectConfigIssues` 报 error ⇒
> `loadConfig` 抛 ⇒ **server 起不来**（`src/config.ts:43-56`、`:220-223`）⇒ submit 路径
> 根本走不到 `effectiveProfileCost`。v2 写的「非法 ⇒ fail-safe 按 metered」是**误导性描述**
> （那段代码不可达），v3 删除。

`isStructurallyFree(executor, env)` 的判据（**可实现的四条**）：

1. `executor === "opencode"`；
2. `env.OPENCODE_CONFIG_CONTENT` 能被 `JSON.parse`；
3. 解析出的 `model` 字段 **=== `{model:zen-free}`**；
4. 解析出的 `small_model` 字段 **=== `{model:zen-free}`**（**缺省不算**，见下）。

四条全满足 → `free`；否则 → `metered`。

**为什么判据 4 不接受缺省**：opencode 在 `small_model` 缺省时由**它自己**决定辅助调用用哪个模型，
那个默认值不在本仓控制范围内、也无法静态确定它是否收费（`src/zen-free.ts:86` 只替换含占位符的
值，缺省项不受影响）。⇒ 与全局 fail-safe 口径一致：**`small_model` 缺省 ⇒ 按 metered**。
内置 preset 本身就两个都写（`src/config-cmd.ts:213`），所以内置 zen-free 不受影响。

**为什么不是"env 里任一值 includes 占位符"**：那正是 `src/zen-free.ts:76` 的判据，而它的语义是
「**何时触发**动态解析」，不是「**用哪个**模型」。`model` 硬编码成付费模型、只有 `small_model`
带占位符时，runner 照样会触发解析，但真正跑主任务的是那个硬编码的付费模型 ⇒ 按"任一值"判会
把付费档误判成 free。判定必须落在 `OPENCODE_CONFIG_CONTENT` 的 `model` / `small_model` 两个字段上。

**为什么不用"名字"判定**：名字可以改，占位符不会骗人（`{model:zen-free}` 是本仓的唯一真相源
`src/zen-free.ts:17` 的 `ZEN_FREE_PLACEHOLDER`）。实现时必须 **import 该常量**，
禁止在 `config.ts` 里硬编码字面量（否则会出现第二份真相）。

**代价（准确表述，含两类新增误伤）**：升级后，用户既有配置里**结构化判定不是 free 的** profile
（绝大多数）会按 metered ⇒ 派发被 D3 拦下。**结构化判定是 free 的**（典型是 `opencode-zen-free`）**不受影响**，
照常放行。逃生口是 `agent-ex profile set <name> cost free`（D6 的 init 路径保证新装用户不踩这个坑）。

判据 4 收紧（`small_model` 必须 === 占位符）带来**两类"确实免费却被判 metered"的误伤**，要写进文档：

| 误伤形态 | 为什么确实免费 | 后果 |
| :--- | :--- | :--- |
| 只写 `model` 占位符、**不写** `small_model` | 主模型是免费的；辅助模型由 opencode 自己的默认值决定，那个默认值可能收费也可能不收费 | 判 metered ⇒ 要 `allow_metered` |
| `model` 占位符 + `small_model` 是**另一个硬编码的 free 模型 id** | 两个模型都确实免费 | 判 metered ⇒ 要 `allow_metered` |

⇒ 文档必须给出这两类的修法（`profile set <name> cost free`，或把 `small_model` 也写成占位符），
否则用户会以为闸门误判了。**内置 preset 不受影响**（`config-cmd.ts:213` 两个字段都写占位符）。

### D3 闸门在 `submit`：`allow_metered`

`agent_ex_submit` 增加 `allow_metered?: boolean`。判定与拒绝规则：

| 分支 | 用哪个 profile / executor | 判定 | 拒绝时的副作用要求 |
| :--- | :--- | :--- | :--- |
| 新任务 | profile = `args.profile ?? cfg.defaults.profile`；executor = `profile.executor` | `effectiveProfileCost(profile)` | `return { error }`，**在 `store.createTask()` 之前** ⇒ **不插任务行** |
| 续跑（`continue_of`） | profile = **任务行里的 `t.profile`**（不是 `args.profile`）；executor = **任务行里的 `t.executor`**（不是 `profile.executor`，见下） | `effectiveProfileCost(cfg.profiles[t.profile], t.executor)` | `return { error }`，**在 `store.transition(..., "running")` 之前** ⇒ 任务保持 `needs_input` |

四条硬约束：

1. **闸门必须在状态变更之前**。续跑分支现在的顺序是"探测 → `store.transition` → 写日志 → spawn"
   （`src/tools/submit.ts:124`）；闸门若放在 transition 之后，会先改状态再报错，任务卡在
   `running` 却没人跑。
2. **闸门要在模型存活探测之前**。现在新任务分支的顺序是"探测 → 闸门"（`:148-150`）；
   反过来会让每次被拒的调用**白付一次 `opencode models` 子进程**，而且"模型 missing"会先于
   "cost 拒绝"返回，掩盖真实原因。⇒ 闸门前置。
3. **续跑必须按 `task.executor` 判定，不是 `profile.executor`**。runner 用的是**任务行**的 executor
   （`src/runner.ts:240-242`：`cfg.executors[task.executor]` / `getExecutor(task.executor)`），
   而 env 取自**当前** config 的 `cfg.profiles[task.profile].env`（`:243-245`）。若 profile 的
   executor 被改成 opencode + 占位符、而任务行仍是 claude（付费 CLI）：
   - 按 `profile.executor` 判 ⇒ 结构化 free ⇒ **放行**；
   - 但 runner 实际起的是 **claude**（付费），且 `~/.claude/settings.json` 的 env 仍会注入
     （硬约束 8：HOME 会传）⇒ **付费照扣**。
   这是一条真实的续跑绕过口。⇒ 判定函数必须显式接受 executor 参数（见 D2 的签名）。
4. **profile 已从 config 删除时按 metered 处理**（`cfg.profiles[t.profile]` 为 `undefined` 时
   无法判定 ⇒ fail-safe）。现在这个分支是直接放行（`src/tools/submit.ts:116-119`），
   属于绕过口。

**授权是 per-dispatch，不继承**：续跑不因为"当初那次派发授权过"就自动放行。理由见 D5。

**调用方可见影响**：续跑时传 `profile` **无效**（现实现即如此，`:116` 用的是任务行的 profile）。
错误文案必须用 `t.profile`（不是 `args.profile`），SKILL 与 README 要写明这一点。

错误文案必须包含：profile 名 + 「若用户已同意计费，请传 `allow_metered: true` 重试」。
当被拒的是默认档（`args.profile` 缺省）时，额外说明「`defaults.profile` 是 X」——
否则调用方无法判断该改默认还是该传参。

### D4 doctor 只报不修 + severity 通道

- `ConfigIssue` 增加 `severity?: "info" | "error"`（**缺省 error**），`validate()` 只对 error 抛。
  **不加这层通道就不能把 cost 放进 `collectConfigIssues`**：硬约束 6 要求校验单一真相源，
  而 `validate()` 是"有 issue 就抛"——给旧配置加一条 info 会让 `loadConfig` 直接崩，升级即砖。
- **`validate()` 抛「第一条 error」而不是 `issues[0]`**。加 severity 后 info 可能排在最前
  （cost 规则在 profiles 循环内，早于 `defaults.timeout_sec`），照旧取 `issues[0]` 会抛出
  一条 info 文案当错误消息。实现口径：`issues.find(i => i.severity !== "info")`。
  `src/config.ts:220-223` 与 `tests/config-issues.test.ts:154-158` 都要按这条改。
- 未声明 cost（且结构化判定不是 free）→ **info**。
  - **message**：说明"按 metered 处理、派发需 `allow_metered`"。
  - **`fix` 必须是 `agent-ex profile set <name> cost metered`——绝不能是 `cost free`**。
    这条 info 的前提就是"这个 profile 按 metered 处理"；把它洗成 free 等于给事故那条路
    提供官方修复命令，用户/agent 照着做就永久绕过闸门。`cost metered` 是"把隐式默认显式化"，
    是这一步唯一安全的动作。
    （"我确定它不花钱"要走另一条路：用户显式 `profile set <name> cost free`，
    并承担 D7 讨论过的声明可伪造风险。）
  - 若用户确实要声明 free，doctor 的 message 里可以补一句"确认不花钱才用 `cost free`"，
    但**主 fix 方向必须是 metered**。
- cost 值非法（不是 `free`/`metered`）→ **error**（形状缺陷）。此时 `loadConfig` 抛 ⇒ server 起不来。
  doctor 的 finding **不标 `fixable`**（cost 不在 `FIXABLE_KINDS` 里）——doctor 不知道该选哪个值。
  但 `ConfigIssue` 本身**仍必须带 `fix` 字符串**（`tests/config-issues.test.ts:35-48` 要求每条 issue
  都有 fix）。⚠️ `fixable` 是 doctor `Finding` 的字段，`ConfigIssue` 上没有它——两者别混。
- **`FIXABLE_KINDS` 不新增** cost：`--fix` 的宪章是"只修确定性缺陷，不碰用户偏好"，
  自动标 `free` 等于替用户宣布"这个不花钱"。
- doctor 的兜底段（`src/doctor.ts:567-577`）要改为读 `issue.severity`：
  - error → 沿用现文案（"the same config would keep the server from starting"）；
  - info → **另一套文案**（"不阻止 server 启动；它意味着派发到该 profile 需要显式授权计费"），
    复用旧文案会谎报严重性。
- **cost 的 issue 必须带 `subject: <profile 名>`**：doctor 的兜底段按 `code#subject` 去重
  （`src/doctor.ts:403` 的 `emitKey`），不带 subject 时多 profile 只会显示第一条。
- doctor 的 `ok` 与退出码**不受 info 影响**（`ok` 只看 `findings.some(f => f.severity === "error")`，
  退出码 `runDoctor` 的 `report.ok ? 0 : 1`，`src/cli.ts:80`）。
  summary 的既有三档语义（`src/doctor.ts:736-741`）：error ⇒ "N problem(s) found"；
  **warn ⇒ "Config is usable, but one item needs attention"**；否则 "All good"。
  ⇒ **info 不参与 summary**（保持 "All good"），**D7 的 warn 会命中 warn 档**（这是既有语义，不是新行为）。

### D5 默认档是 metered 时，省略 profile **也不放行**

**决策：不放行。** `defaults.profile` 指向 metered profile 且调用方省略 `profile` 参数时，
同样要求 `allow_metered: true`。

理由两条：

1. **授权的对象是"这次派发会不会花钱"，不是"配置里写了什么名字"。** `defaults.profile` 可能是
   init 生成的、可能是别的 agent 写进去的、可能是历史迁移留下的——把它当授权，等于让
   "配置里有个名字"变成"同意扣钱"，而这正是事故里最关键的那一步（agent 自己换了付费 profile）。
2. **若放行，这条调用在任务记录里没有任何授权标记**——一个付费 profile 的派发、记录里看不出
   与免费派发的区别。那就是事故的形状原样保留（"花钱从未出现在任何记录中"）。

代价与逃生口：只有付费档的用户，之后每次派发都要带 `allow_metered: true`；或者把默认切回
免费档——**注意 `profile use` 只切默认、不物化 profile**（`src/config-cmd.ts:254-270`），
所以没有免费档的用户要先建：

```
agent-ex profile create opencode-zen-free --use   # 建并切默认（一步到位）
agent-ex profile use opencode-zen-free              # 已经建过时才用这条
```

不存在死锁：**在新 server 上**，per-dispatch 的 `allow_metered` 永远可用。
（老 server 上不成立——`allow_metered` 会被剥离或报 unrecognized key，闸门根本不存在 ⇒ 那一档只能靠
D8 的人工确认。详见 D8。）

### D6 `init` 写 cost（`profile create` 同理）

init 产出配置时按来源写死：

| init 路径 | profile | cost |
| :--- | :--- | :--- |
| opencode + zen free | `opencode-zen-free` | `"free"` |
| opencode + 自带 key | 用户命名 | `"metered"` |
| claude（任何 provider） | 用户命名 | `"metered"` |

`profile create opencode-zen-free` 同样写 `cost: "free"`（`BUILTIN_PROFILES` 加 `cost` 字段，
`createProfile` 落地时带上）。

**与 D4「`--fix` 不自动标 metered」不矛盾**：`--fix` 改的是**用户既有配置**里的偏好；
init 是**从零生成**一份新配置，用户在向导里已经选定了 provider 与凭据方式。
⇒ 新装用户 `doctor` 一开始就是干净的，不会一装完就看到一堆 info。

连带：`InitAnswers`（`src/init.ts:224-233`）要加 `cost` 字段；`buildConfig` 据此写入；
`src/init-changes.ts` 的 `describeProfile`（`:112-116`）要把 cost 放进描述里——
否则重跑 init 时 `same()` 判定"有变化"、before/after 却打印完全相同的字符串（用户看到 `X -> X`）。

### D7 声明优先于结构化判定（但冲突要报警）

`profile.cost` 已声明 ⇒ 直接用它，**即使结构化判定与它不一致**。理由：free 池成员会轮换、
模型价格动态变化，静态判定必然过期；用户的显式表态优先于我们的推断。

**为什么不选"结构化优先"（声明 free 但结构判定不 free ⇒ 仍不放行）**：那个更严，但会把本仓
**最常见的免费形态**也堵死——用户把某个具体的 free 模型 id 直接写进 `OPENCODE_CONFIG_CONTENT`
（本机就有这种 profile，硬编码 `opencode/deepseek-v4.1-flash-free` 这类 id）。它确实不花钱，
却无法被"占位符"判据识别 ⇒ 每次派发都要 `allow_metered`，闸门变成常态噪音 ⇒ 用户会开始
无脑传 `allow_metered`，反而把标记变成噪声。⇒ 保留声明优先。

**代价与兜底（残留风险要写明）**：声明 free 是**文件里的一个词**，有 shell 的 agent 能伪造它
（§1 已声明机制不是安全边界）。四层兜底：

1. 铁律 5 禁止 agent 写配置（D1）；
2. 铁律 5 的参数口径禁止 agent 自己加 `allow_metered`（D1 的 v3 补充）；
3. 任务行 `cost` 列让"哪些任务当时被判为计费档"事后可查（D10）；
4. **doctor 对"声明 free 但结构化判定不是 free"报 warn**（见下）——这是 v3 从 §7 提上来的必做项。

⚠️ **诚实修正（v4）**：v3 在 §8 末尾写"四层兜底里只有 D10 是机制性的，另外三条依赖 agent 自觉"——
**这个断言不成立**。D10 记录的值同样源自那份**可伪造的**声明：agent 若伪造 `cost:"free"`，
闸门放行、留痕也记 "free"。⇒ 准确表述是：

- **D10 记录的是「工具在派发当时依据当时配置作出的判定」，不是"模型是否真的收费"的真值。**
- **伪造 `cost:"free"` 这一情形，任何留痕都无法区分**——诚实的声明与伪造的声明在文件里**完全一样**
  （没有作者、没有时间、没有签名可查）。所以"防伪造"**不在机制层**，它在**纪律层**（铁律 5）
  与**可观测层**（D10 让"配置当时被认为是什么"可查，让异常配置的人工排查有据可依）。

⇒ 结论不变，但要诚实：**这套机制防的是"agent 自我授权"与"花费不可见"，不是防一个有 shell 的对手。**
这与 §1 的机制边界一致（"有 shell 的 agent 能改配置、能传参数；机制目标是显式 + 留痕"）。

doctor 的 warn 规格：severity = `warn`（不是 info：info 不阻断也不显眼，而这是一个**不一致**），
`subject` = profile 名，`fix` = `agent-ex profile set <name> cost metered`，
文案说明「你声明它是免费档，但系统无法独立验证（executor 不是 opencode / 两个模型字段不都是
占位符）——请确认它真的不花钱」。

**不自动改判**：warn 只提示，不改写声明（改写 = 替用户表态，与 `--fix` 宪章冲突）。

### D8 老 server 上闸门不存在 ⇒ 前置检查必须探测

`allow_metered` 是**新参数**，老 server 不认识它。两种形态（已核对 `.strict()` 的引入时间：
commit `d4dcb52` 落在 v0.3.1，v0.3.0 的 schema 非 strict）：

| server 版本 | 传 `allow_metered` 的结果 | 危害 |
| :--- | :--- | :--- |
| ≥ 0.3.1（含 `.strict()`）但早于加 `allow_metered` 的版本 | MCP 报错 `Unrecognized key(s) in object: 'allow_metered'`（响亮失败） | 调用方若去掉参数重试 ⇒ **闸门不存在，照样派发成功** |
| 0.3.0（schema 非 strict） | **静默剥离**该参数 | 直接无闸门派发 |

⇒ SKILL 的前置检查必须多一条：**探 `tools/list` 里 `agent_ex_submit` 的 schema 有没有
`allow_metered`**；没有 ⇒ 不能声称"闸门生效"，metered profile 的派发必须先取得用户明确同意
（人工确认，而不是靠参数兜底）。发布时同步 bump 版本号与 README 的门槛文案。

### D9 既有测试夹具怎么迁移

既有测试的意图**不是**测闸门，所以**不给每个用例加 `allow_metered`**（那会让所有用例都依赖
第二个概念，闸门的失败原因会被淹没）。做法：

| 夹具 | 现状 | 改法 |
| :--- | :--- | :--- |
| `tests/tools.test.ts:28-29` 的 `profiles: { fake: { executor: "fake", env: {} } }` | 无 cost ⇒ 按 D2 一律 metered ⇒ 每个 `submit()` 都被拦 | 显式声明 `cost: "free"`（fake executor 的 bin 是 `process.execPath`，本机进程，不花钱） |
| `tests/tools.test.ts:112-130` 的 opencode 夹具 | 同上 | 显式声明 `cost: "free"`（注入 `runImpl` 的模型存活探测，不产生真实调用） |
| `tests/integration.test.ts` 的 **8 处 `profiles:` 夹具**（`:142,344,405,489,561,638,684,700`） | 同上 | 夹具 profile 显式声明 `cost: "free"`。⚠️ 这 8 个行号是**夹具行**不是 `submit()` 调用点——文件里实际有 18 处 `submit()` 调用，改的是它们共用的那些夹具 |
| `tests/config-issues.test.ts:12-20` 的 `baseCfg()` | `profiles: { default: { executor: "claude", env: {} } }`，断言 `collectConfigIssues(baseCfg())` === `[]` | `baseCfg` 显式写 `cost: "free"`（保持"健康配置零 issue"契约）；**另加一个"无 cost"样本**专测 info 档 |
| `tests/config-issues.test.ts:154-158` | 断言 `validateConfig` 抛 `collectConfigIssues(cfg)[0].message` | 改成断言抛**第一条 error**。⚠️ 该夹具（timeout 是字符串）**本身没有 info**，改前改后都通过 ⇒ 它单独**证伪不了** P0-2；真正的证伪靠 V12 的专用夹具（info 在前、error 在后） |
| `tests/init.test.ts:146,160,172,184,193`、`tests/config.test.ts:114` 的 `buildConfig` 调用点 | `InitAnswers` 加 `cost` 后这 6 处**类型报错**（少一个必填字段） | 补 `cost` 实参 |
| `tests/doctor.test.ts:48-56` 的 `baseCfg`（配套 `writeHealthy` 在 `:43-46`）、`tests/cli-env.test.ts:210` 的 `p1`、`tests/config.test.ts:12-24` 的 `validConfig` | 无 cost | **不会红**（info 不阻断），但每个 doctor 用例会多一条 info finding、污染"干净配置"类断言 ⇒ 建议补 `cost: "free"`（doctor 的干净夹具必补，其余可不动） |

闸门本身用**独立的新用例**覆盖（`tests/tools.test.ts` 新增 describe 块），而不是散进既有用例。

### D10 留痕：任务行记录有效成本

§1 声明的机制目标是「显式 + 留痕」。v2 只做了「显式」（`allow_metered` 是当次调用的参数），
**没有做「留痕」**——`allow_metered` 既不进 `tasks.db` 也不进 runner 日志，任务记录里只有
profile 名，事后无法回答"这条任务是不是花钱的"。那正是事故的取证困难所在。

**决策：给 tasks 表加一列 `cost`**，值 = 派发时该 profile 的**有效成本**（`"free"` / `"metered"`）。

- 建表与迁移共用 `src/store.ts` 的 `COLUMNS`（`store.ts:80-102`），新增列走既有的
  `ALTER TABLE ... ADD COLUMN` 自动迁移（`store.ts:137-152`）⇒ 老库零手工操作。
  列定义 `cost TEXT NOT NULL DEFAULT ''` 合法（`store.ts:75` 已声明"每个 NOT NULL 列必须带 DEFAULT"），
  老行读回 `''`，无需搬表。
- `createTask` 写入（`store.ts:187-194` 的 INSERT 列清单要加这一列）。
- 续跑时更新为**该轮**的有效成本（profile 可能被改过），但**粘性 metered**：
  `cost = old === "metered" ? "metered" : new`——已发生的计费事实不能被后续轮次的 free 判定抹掉。
  一行逻辑，不需要第二张表。
- 升级前的历史行该列为空串 = **未知**（不是 free）⇒ 回显与卡片都要显示"未记录"，不得落到某一档。

**不变量（设计的核心，v4 收紧，v5 修措辞）**：**任务行 `cost = "metered"` ⇒ 该任务**至少有一轮**
的 `effectiveProfileCost` 是 `"metered"`，且**那一轮**带着 `allow_metered: true` 过了闸门。**

⚠️ **v5 的措辞修正（确认轮发现的一处自相矛盾）**：v4 写的是"**任何一次**把 `cost` 写成 `"metered"`
的派发，都必然带着 `allow_metered` 过了闸门"——这句话**字面为假**，因为它与"粘性 metered"规则冲突：

> 反例：Round1 profile 是 metered ⇒ 过了闸门（带 `allow_metered`）⇒ 行里 `cost="metered"`；
> 随后 profile 被改成 free ⇒ Round2 续跑时 `effectiveProfileCost` = free ⇒ **不需要** `allow_metered`
> 即放行；随后粘性规则又因 `old==="metered"` 写入 `"metered"`。
> ⇒ 这一轮"写了 cost=metered"却**当轮没带** `allow_metered`。

**实质没有受损**（真正发生的 metered 花费在 Round1、那一轮过了闸门；粘性只是保留标签，
不产生任何未授权花费）——受损的是**陈述的准确性**：它会让实现者/评审误以为"每轮 metered 都过闸"。

⇒ 正确表述是上面那句：**"至少有一轮 metered 且那一轮过了闸门"**；**sticky 保留轮的 `metered`
不要求当轮 `allow_metered`**。

**这个不变量必须是机制性的，不能只靠约定**（v4 采纳第 3 轮 P1-b）：

- `TaskPatch` 是 `Partial<Omit<Task, "id" | "status" | "created_at">>`（`store.ts:63`）——
  一旦 `cost` 进入 `Task`，它就自动进入 `TaskPatch`，**任何** `store.patch(id, { cost })` 的调用方
  都能绕过闸门写值。
- ⇒ 把 `cost` 从 `TaskPatch` 里**排除**（`Omit<Task, "id" | "status" | "created_at" | "cost">`），
  并加**专用的 `setCost(id, cost)`** 方法，**只有闸门路径调用它**；
  `patch()` 运行时也要剔除 `cost` 键（防 `as any` 绕过类型）。
- 这样"只有过了闸门的派发才会写 cost"就是**代码结构保证**，不是约定。

**这一列的值是什么（v4 诚实修正）**：它记录的是**「工具在派发当时依据当时配置作出的判定」**，
不是"模型是否真的收费"的真值。伪造 `cost:"free"` 这一情形**任何留痕都区分不了**
（诚实的声明与伪造的声明在文件里完全一样）——详见 D7 的诚实修正。
所以这一列的准确用途是：

- 让"这条任务派发当时被判为计费档"**可查询**（而不是靠读 profile 名去猜）；
- 让 profile 事后被改写时，任务行仍保留**派发当时的判定**（配置变了，记录不变）；
- 让 D7 的"声明与结构判定冲突"这类异常配置的**人工排查有据可依**。

回显面（两处，各一处改动）：
- `src/tools/status.ts` 的 `TaskView` 加 `cost` 字段（`status.ts:22-45`）——机器读的查询面。
- `src/runner.ts:215-218` 的 `cardFooter` 加「计费档 / 免费档 / 未记录」——人读的终态卡面。
  （顺带解决 §7 原来的待定项「飞书终态卡是否标计费」：**标**。）
  ⚠️ 空串必须渲染成「未记录」，不能落到两档中的任何一档。

不选的两个方案与理由：
- **只写 runner 日志**：runner 从任务行读 executor/profile（`src/runner.ts:240-246`），
  不读 `allow_metered` ⇒ 要让它知道就得先把标志写进任务行 —— 绕回同一个改动，且日志不是可查询面。
- **降级 §1 的措辞**（承认只做「显式」不做「留痕」）：事故的核心取证困难正是"花钱从未出现在
  任何记录里"；只做显式的话，事后仍然只能靠翻会话快照。
- **加第二列 `cost_basis`（declared / structural）**：能让"自由性来自声明"这件事可查询，但
  **不能区分诚实声明与伪造声明**（两者在文件里一样）⇒ 为一个检测不了的问题加一列，是净增熵。
  v4 判断：**不加**。

## 4. 放弃的备选

| 方案 | 放弃理由 |
| :--- | :--- |
| 文件权限 / 签名 / config hash 校验 | agent 有 shell，能绕过 CLI 直接写文件，挡不住；成本高、收益低 |
| 只允许用 `defaults.profile` 派发 | 需要多档时得先改默认，而"改默认"同样是一次 config 写入，没减少步数 |
| 从 MCP 参数里删掉 `profile` | 最彻底，但破坏多 profile 调度，`continue_of` 也要重定义 |
| cost 直接进 `collectConfigIssues`（不加 severity） | 升级即崩 |
| `doctor --fix` 自动把未声明写成显式 `metered` | 语义零变化，只消音；用户会以为"修好了"，实际派发照样被拒 |
| **doctor 的 info 把 `fix` 写成 `cost free`** | 把付费档洗成免费档，等于给事故那条路提供官方修复命令 |
| **续跑继承当初那次派发的授权** | 授权标记只在任务**首次**创建时出现一次；续跑照样花钱、记录里却没有新授权 ⇒ 回到事故的形状。且要改任务表结构 |
| **默认档 metered 时放行**（D5 的反面） | 同上：这类派发在记录里没有授权标记 |
| **声明 free 但结构判定不 free 时不放行**（D7 的反面） | 会把"硬编码具体 free 模型 id"这种常见免费形态也堵死 ⇒ 闸门变常态噪音 ⇒ 用户无脑传 `allow_metered`，标记反而失效 |
| **给每个既有测试用例加 `allow_metered`** | 闸门的失败原因会被无关概念淹没；见 D9 |
| **把成本快照写进 runner 日志而不是任务行** | runner 读不到 `allow_metered`；要传就得先落任务行 —— 绕回同一个改动，且日志不是可查询面；见 D10 |

## 5. 落地清单

| 文件 | 改动 |
| :--- | :--- |
| `src/config.ts` | `ProfileConfig.cost?: "free" \| "metered"`；`ConfigIssue.severity?: "info" \| "error"`；`ConfigIssueCode` 加 `profile.cost`；`collectConfigIssues` 加两条 cost 规则（未声明→info / 非法值→error，**两条都带 `subject`**）。⚠️ **两条规则的判定来源不同**：「未声明→info」调 `effectiveProfileCost()`（它返回 free/metered，**没有 invalid 分支**）；「非法值→error」是**独立的合法性判断**（`value !== "free" && value !== "metered"`），不能塞进 `effectiveProfileCost`——照字面写成"两条都调它"会**漏掉非法值检测**，破坏 D2「非法 ⇒ loadConfig 抛」的保证。`validate()` 改为抛**第一条 error**；**导出** `effectiveProfileCost(profile, executorOverride?)` 与 `isStructurallyFree(executor, env)`（占位符 import `ZEN_FREE_PLACEHOLDER`，不硬编码） |
| `src/config-cmd.ts` | `setProfileValue` 加 `cost` 保留字分支（**必须在 `ENV_KEY_RE` 之前**——`"cost"` 不匹配 `^[A-Z][A-Z0-9_]*$`），并校验值 ∈ {`free`,`metered`}；`listConfig` 返回 `cost`；`BUILTIN_PROFILES` 加 `cost: "free"`；`createProfile` 写入 `cost`；`profile set` 错误文案的保留字清单加 `"cost"`；`profile set <p> cost free` 的输出提示一句「确认这个 profile 真的不花钱」 |
| `src/tools/submit.ts` | `SubmitArgs` 加 `allow_metered?: boolean`；新任务分支与 `continue_of` 分支各加闸门（位置见 D3 的四条硬约束：状态变更之前、模型探测之前、续跑用 `task.executor`、profile 已删按 metered）；任务创建/续跑时写入或更新 `cost`（D10） |
| `src/server.ts` | `agent_ex_submit` 的 zod schema 加 `allow_metered`（保持 `.strict()`）；工具描述写清语义（"仅当用户已明确同意计费时才传"） |
| `src/store.ts` | `COLUMNS` 加 `cost TEXT NOT NULL DEFAULT ''`；`Task` 接口加 `cost: string`；`NewTask` 含 `cost`；`createTask` 的 INSERT 加该列（`store.ts:187-194`）。**不变量靠结构保证**：`TaskPatch`（`:63`）**排除 `cost`**（`Omit<Task, "id"\|"status"\|"created_at"\|"cost">`），加**专用 `setCost(id, cost)`**（只有闸门路径调用），且 `patch()` 运行时剔除 `cost` 键（防 `as any` 绕过类型） |
| `src/tools/status.ts` | `TaskView` 加 `cost` 字段并在 `view()` 回显（`status.ts:22-45`）；空串回显为「未记录」 |
| `src/runner.ts` | `cardFooter`（`:215-218`）加「计费档 / 免费档 / **未记录**」（空串不得落到两档之一） |
| `src/doctor.ts` | 兜底段读 `issue.severity`（info 用独立文案，不复用"会阻止 server 启动"）；cost issue 必须带 `subject`；**新增「声明 free 但结构化判定不是 free」的 warn**（D7）；`FIXABLE_KINDS` 不加 cost |
| `src/init.ts` | `InitAnswers` 加 `cost`；`buildConfig` 写 `cost`；`planOpencodeProfile` 的返回值加 `cost`（zen ⇒ `"free"`，否则 `"metered"`） |
| `src/init-changes.ts` | `describeProfile`（`:112-116`）的描述里加 cost（否则重跑 init 显示 `X -> X`） |
| `src/cli.ts` | `profile list` 渲染加 `cost=`；`profile set` 的 usage 保留字清单加 `"cost"` |
| `skills/agent-ex-dispatch/SKILL.md` | 铁律 5 加「`allow_metered` 只在用户本轮明确同意计费时传；429/额度/失败/超时都不构成同意」；Step 3 参数表加 `allow_metered`；**第 88 行的参数枚举同步**（现写"没有批量/链式字段（只有 `prompt`/`project_path`/`profile`/`timeout_sec`/`continue_of`）"，要补 `allow_metered`）；**429 段补参数口径**（`:194` 现写"不要换到付费档重派（换档是花钱的决定，只能由用户做）"——**这句已经覆盖"换档"，缺的是"不要自己加 `allow_metered: true` 重派"**）；**Phase 2 放行规则补参数口径**（`:391` 现写"授权范围不含配置写入"——要补"与计费授权（`allow_metered`）同样不在授权范围内"）；前置检查加"探 `tools/list` 的 submit schema 是否含 `allow_metered`"（D8） |
| `config.example.json` | 给各 profile 标 `cost`。实测四个 profile：`minimax-3`/`ds-v4`（claude + API key）⇒ `metered`；`opencode-minimax-3`（executor=opencode 但 `env: {}`，没有 `OPENCODE_CONFIG_CONTENT` ⇒ 判据 2 不成立）⇒ `metered`；`opencode-zen-free`（model 与 small_model 都是占位符）⇒ `free`。⚠️ 默认 profile 是 metered 的 `opencode-minimax-3` ⇒ 照抄示例的新用户第一次派发即被拦，文案里要说明需 `allow_metered` |
| `README.md` / `docs/README.zh-CN.md` | MCP tools 表加 `allow_metered`；CLI 表同步 |
| `docs/user-guide/configuration.md` | profile 字段表加 `cost`（含"未声明按 metered"的说明）；**§`profile set` 的保留字清单加 `cost`**（`:86`） |
| `AGENTS.md` | 硬约束 2 的括注补「profile 保留字（`executor` / `path_dirs` / `cost`）属白名单内的具名键，非通用点路径」 |
| `CHANGELOG.md` | 本改动是用户可见的破坏性行为变化（升级后非 zen 档默认被拦），发版条目必须写清楚 |
| `tests/config-issues.test.ts` | 见 D9：`baseCfg` 加 cost；新增"无 cost"样本；`validateConfig` 断言改"第一条 error" |
| `tests/config-cmd.test.ts` | `profile set <p> cost free` 成功；`cost` 非法值报错；`cost` 出现在保留字错误文案里 |
| `tests/doctor.test.ts` | info 档：finding severity=info、`report.ok` 仍为 true；非法 cost：severity=error、不标 fixable；**「声明 free 但结构判定不 free」报 warn** |
| `tests/tools.test.ts` | 见 D9；新增闸门用例（新任务 / 续跑 / 默认档 metered / profile 已删除 / 续跑 executor 不一致 五种） |
| `tests/integration.test.ts` | 夹具 profile 显式声明 `cost`（8 处 `profiles:` 夹具，覆盖 18 处 `submit()` 调用） |
| `tests/init.test.ts` | `buildConfig` 的 5 处调用点补 `cost` 实参；init 产出带 cost 的断言 |
| `tests/config.test.ts` | `buildConfig` 调用点补 `cost`；`validConfig` 夹具补 cost（可选） |
| `tests/server-tools.test.ts` | `listTools` 改成保留完整 tool 对象（现 `:17-23` 只 map 出 name），断言 `agent_ex_submit.inputSchema.properties.allow_metered.type === "boolean"`；断言带 `allow_metered:true` 的 `callTool` 不返回 `/Unrecognized key/`（D8） |
| `scripts/smoke-stdio.mjs` | `tools/list` 的结果保留 `inputSchema`（现 `:78` 只 map name），断言同一字段（覆盖 dist 构建产物） |

## 6. 验证

### 6.1 按决策逐条

| # | 对应 | 验收 |
| :--- | :--- | :--- |
| V1 | D2 | 未声明 cost 且非结构化 free ⇒ `effectiveProfileCost` 返回 `"metered"`；声明 `cost:"free"` ⇒ 返回 `"free"`（声明优先） |
| V2 | D2 | `model` === 占位符、`small_model` === 硬编码付费 ⇒ **不是** free（按 metered 处理） |
| V2b | D2 | `model` === 硬编码付费、`small_model` === 占位符 ⇒ **不是** free（`zen-free.ts:76`「任一值触发」最危险的误判源，V2 只覆盖了另一侧） |
| V3 | D2 | `model` 与 `small_model` **都 === 占位符** ⇒ free；`model` === 占位符但 `small_model` **缺省** ⇒ **不是** free（按 metered，fail-safe） |
| V4 | D3 | metered + 未传 `allow_metered` ⇒ `submit` 返回 error，**且 tasks 表没有新行** |
| V5 | D3 | metered + `allow_metered: true` ⇒ 正常建任务 |
| V6 | D3 | free profile 无需授权即可派发 |
| V7 | D3/D4 | 续跑一个 metered 任务（needs_input）且未传 `allow_metered` ⇒ 返回 error，**任务仍是 `needs_input`**（不是 `running`） |
| V8 | D3 | 续跑时任务行里的 profile 已被 config 删除 ⇒ 按 metered 处理（未授权 ⇒ 拒绝） |
| V9 | D3 | **续跑时 `profile.executor`（opencode + 占位符）与 `task.executor`（claude）不一致 ⇒ 按 metered 拒绝**（P0-4 的绕过口） |
| V10 | D3 | cost 闸门在模型存活探测**之前**：被拒的调用**不**产生 `opencode models` 子进程（用注入的 `runImpl` 断言未被调用） |
| V11 | D4 | 老配置（无 cost）`loadConfig` 不抛（info 不阻断） |
| V12 | D4 | `collectConfigIssues` 对"未声明 cost"产出 `severity: "info"` 的 issue，且带 `subject` 与 `fix` |
| V13 | D4 | **info 的 `fix` 是 `cost metered`、不是 `cost free`**（P0-1 的回归锁） |
| V14 | D4 | `collectConfigIssues` 对"cost 值非法"产出 `severity: "error"` 的 issue |
| V15 | D4 | `validateConfig` 抛的是**第一条 error** 的 message。**夹具必须能构造出 info 在前、error 在后**：profile 无 cost（⇒ info，`config.ts` 的 profiles 循环在 timeout 规则之前）+ `defaults.timeout_sec:"3600"`（⇒ error）⇒ 断言抛的是 timeout 文案、不是 cost info 文案 |
| V16 | D4 | `doctor` 遇到 info ⇒ `report.ok` 仍为 `true`（退出码是 `runDoctor` 的直接映射 `report.ok ? 0 : 1`，`src/cli.ts:80`，无需单测 CLI 层） |
| V17 | D4 | `doctor` 遇到非法 cost ⇒ `report.ok` 为 `false`、finding **不标** `fixable` |
| V18 | D4/D7 | `doctor` 遇到"声明 free 但结构判定不是 free" ⇒ 产出 **warn**（不是 info、不是 error）、带 `subject`、**不自动改判** |
| V19 | D4 | `applyFixes` 在只有 cost 缺失、无其它可修项的配置上 `applied` 为空、文件内容不变 |
| V20 | D4 | `applyFixes` 修其它字段时，配置里有非法 cost ⇒ 整份被拒（`validateConfig` 抛 error ⇒ 不落盘），skipped/notes 说清"没写进去" |
| V21 | D5 | `defaults.profile` 指向 metered 且省略 `profile` ⇒ 被拦；错误文案里出现 `defaults.profile` 的名字 |
| V22 | D6 | `agent-ex init`（zen 分支）产出的 config 里 profile 带 `cost: "free"`；claude 分支带 `cost: "metered"` |
| V23 | D6 | `agent-ex profile create opencode-zen-free` 产出的 profile 带 `cost: "free"` |
| V24 | D6/D2 | `agent-ex profile set <p> cost free` 成功并落盘；`cost` 非法值被拒且**不写盘** |
| V25 | D6 | 重跑 init 时 `init-changes` 的 before/after **能看出 cost 的变化**（不是 `X -> X`） |
| V26 | D7 | 声明 `cost:"free"` 但结构化判定不 free ⇒ 有效成本仍是 `"free"`（声明优先），且 doctor 报 warn |
| V27 | D10 | metered 任务创建后，tasks 表该行的 `cost` 列是 `"metered"`；`agent_ex_status` 回显 `cost: "metered"` |
| V28 | D10 | 飞书终态卡的 footer 含「计费档」（metered）/「免费档」（free） |
| V29 | D10 | 升级前的历史任务行 `cost` 为空串 ⇒ status 回显为「**未记录**」、卡片 footer 也显示「**未记录**」，**不得**当成 free 或落到两档之一 |
| V30 | D8 | `tests/server-tools.test.ts`：`tools/list` 里 `agent_ex_submit.inputSchema.properties.allow_metered.type === "boolean"`；带 `allow_metered:true` 的 `callTool` 不返回 `/Unrecognized key/` |
| V31 | D8 | `scripts/smoke-stdio.mjs` 对 **dist 构建产物**做同一条断言（发布前项，需先 `npm run build`） |
| V32 | D1 | SKILL 铁律 5 含「`allow_metered` 只在用户本轮明确同意计费时传；429/额度/失败/超时都不构成同意」；429 段与 Phase 2 放行规则同步（grep 断言文本存在） |
| V33 | §5 | `collectConfigIssues` 的「**未声明→info**」规则**调用** `effectiveProfileCost()`（单一真相源：改判定逻辑时 doctor 与 submit 同时变）。⚠️ 只锁这一条规则——「非法值→error」是独立合法性判断，不经过 `effectiveProfileCost`（它没有 invalid 分支） |
| V34 | D9 | 既有夹具迁移后，`npm test` 全绿（**见 6.2 的迁移清单逐条对账**） |
| V35 | §5 | `config.example.json` 里每个 profile 都有 `cost`；示例默认 profile 是 metered ⇒ 文档写明需 `allow_metered` |
| V36 | D10 | **写入路径是机制性的**：`TaskPatch` 的类型里**没有** `cost`（编译期：`store.patch(id, { cost: "metered" })` 应当**编译不过**）；`patch()` 运行时也剔除 `cost` 键 ⇒ 只有 `setCost()` 能写它 |
| V37 | D10 | **粘性 metered**：一个 metered 任务续跑一轮、而该轮判定为 free ⇒ 行里的 `cost` **仍是** `"metered"`（已发生的计费事实不被抹掉） |
| V38 | D2 | 两类"确实免费却被判 metered"的误伤形态（只写 `model` 不写 `small_model`；`small_model` 是硬编码 free id）⇒ 文档给出修法（`profile set <name> cost free`） |

### 6.2 既有测试迁移清单（逐条对账，缺一条就是漏改）

- [ ] `tests/tools.test.ts:28-29` 的 fake profile 加 `cost: "free"`
- [ ] `tests/tools.test.ts:112-130` 的 opencode 夹具加 `cost: "free"`
- [ ] `tests/integration.test.ts` 的 **8 处 `profiles:` 夹具**加 `cost: "free"`
      （`:142,344,405,489,561,638,684,700`；它们覆盖文件里 18 处 `submit()` 调用）
- [ ] `tests/config-issues.test.ts:12-20` 的 `baseCfg` 加 `cost: "free"`，并新增"无 cost"样本
- [ ] `tests/config-issues.test.ts:154-158` 改成断言"第一条 error"（该夹具本身证伪不了 P0-2，证伪靠 V15）
- [ ] `tests/init.test.ts:146,160,172,184,193` 的 `buildConfig` 调用点补 `cost`
- [ ] `tests/config.test.ts:114` 的 `buildConfig` 调用点补 `cost`
- [ ] `tests/doctor.test.ts:48-56` 的 `baseCfg` 补 `cost: "free"`（避免污染"干净配置"断言）
- [ ] `tests/cli-env.test.ts:210`、`tests/config.test.ts:12-24` 的夹具补 `cost`（可选，不阻断）
- [ ] `tests/server-tools.test.ts` 的 `listTools` 改造 + `allow_metered` schema 断言
- [ ] `npm test` 全绿（单元 + 集成）

### 6.3 一致性检查（文档面）

- [ ] `README.md:187` / `docs/README.zh-CN.md:174` 的 MCP tools 表都有 `allow_metered`，两版一一对应
- [ ] `docs/user-guide/configuration.md` 的 profile 字段表有 `cost`，且写明"未声明按 metered"；
      `profile set` 保留字清单（`:86`）有 `cost`
- [ ] `AGENTS.md` 硬约束 2 的括注含 `cost` 保留字
- [ ] `SKILL.md` 第 88 行的参数枚举与 Step 3 参数表一致；429 段（`:194`）与 Phase 2 放行规则（`:391`）
      含「参数口径」（`allow_metered` 只在用户明确同意时传）
- [ ] `config.example.json` 每个 profile 都有 `cost`
- [ ] `CHANGELOG.md` 有本版本的破坏性行为变化说明

## 7. 待定（均不阻塞开工）

- `allow_metered` 是否**额外**写进 runner 日志（D10 已让它进任务行与终态卡；日志里再写一份
  是否值得 —— 倾向不写，避免同一事实三处真相）。
- doctor 的 summary 是否要带 info 计数（当前 error/warn 参与、info 不参与；见 D4 的三档语义）。

## 8. 评审修订记录

### 8.1 v1 → v2（评审 `task_mwu3ephz_92c7cf`）

| v1 条目 | v2 的处理 | 落在哪 |
| :--- | :--- | :--- |
| P0-1 未声明 cost → info 与「健康配置零 issue」冲突；默认 metered 拦截所有既有夹具 | D2「声明优先」+ D9 迁移方案 + §6.2 对账清单 | D2 / D9 / §6.2 |
| P0-2 `validate()` 取 `issues[0]` 语义未定义 | 定义为「抛第一条 error」 | D4 / §6.1 |
| P0-3 `continue_of` 无闸门 | D3 的续跑分支规则 | D3 |
| P0-4 §5/§6 漏整块测试迁移 | §5 补 `tests/integration.test.ts`；§6.2 独立成清单 | §5 / §6.2 |
| P1-1 默认档 metered 是否放行未表态 | 表态不放行 | D5 |
| P1-2 §5 漏 `src/init.ts` | D6 定稿 init 写 cost | D6 |
| P1-3 漏 `src/cli.ts` 与 `ConfigIssueCode` | 补进 §5 | §5 |
| P1-4 zen-free 判定措辞与实现不对齐 | 改成结构化四判据 | D2 |
| P1-5 「有效成本」缺单一真相源 | D2 定义唯一判定函数 | D2 |
| P1-6 doctor 兜底按 `code#subject` 去重 | D4 要求带 `subject` | D4 |
| P1-7 老 server 静默剥离 `allow_metered` | **事实修正**：`.strict()` 落在 v0.3.1 ⇒ ≥0.3.1 报错、0.3.0 才静默剥离 | D8 |
| P1-8 §6 未覆盖每个决策 | §6.1 改成按决策编号 | §6.1 |
| P2-1~P2-8 | 全部按评审建议处理（`config.example.json` 进 §5 / SKILL 第 88 行 / 占位符 import / `fixable` 与 `ConfigIssue` 区分 / `applyFixes` 措辞 / AGENTS 括注 / `setProfileValue` 分支位置 / doctor summary 接受现状） | §5 / D4 / D2 |

### 8.2 v2 → v3（评审 `task_mwu49mhx_5cbeb2`，裁决「需补 4 处 P0 后可落地」）

调度方已逐条独立复核该评审的代码引用，**4 条 P0 全部成立**（复核证据见每行的括号）。

| 评审条目 | v3 的处理 | 落在哪 |
| :--- | :--- | :--- |
| **P0-1** D4 的 info 把 `fix` 写成 `cost free`（把付费档洗成免费档 = 给事故那条路提供官方修复命令） | **采纳**。`fix` 改为 `cost metered`；message 里说明"确认不花钱才用 `cost free`"；新增 V13 作回归锁 | D4 / §6.1-V13 |
| **P0-2** 「显式 + 留痕」只做了显式，`allow_metered` 不进任何记录 | **采纳**。新增 D10：tasks 表加 `cost` 列（`store.ts` 的 `COLUMNS` + 自动迁移）、`createTask` 写入、续跑 `patch` 更新、`agent_ex_status` 回显、终态卡 footer 标注；并给出不变量「`cost=metered` ⇒ 必然带 `allow_metered` 创建」（`createTask` 全仓唯一调用点 `submit.ts:178`） | D10 / §5 / §6.1-V27~V29 |
| **P0-3** SKILL 只补了参数表，没堵「429 后自己加 `allow_metered`」 | **采纳**。铁律 5 增「参数口径」子项；429 段与 Phase 2 放行规则必须同步改（现在 429 段只写"不要换付费档"，而新 server 上"换付费档"就是加这个参数） | D1 / §5 / §6.1-V32 |
| **P0-4** 续跑闸门按 `profile.executor` 判，runner 实际用 `task.executor` ⇒ profile 被改成 opencode+占位符、任务行仍是 claude 时会放行付费档 | **采纳**（调度方独立复核：`runner.ts:240-242` 用 `task.executor`，`:243-245` 用当前 config 的 profile env；且硬约束 8 ⇒ `~/.claude/settings.json` 的 env 仍注入 ⇒ 付费照扣）。判定函数改为显式接受 executor（`effectiveProfileCost(profile, executorOverride?)`），续跑传 `t.executor` | D2 签名 / D3 硬约束 3 / §6.1-V9 |
| P1-1 D2 正文「未声明按 metered」与 step 3 结构化 free 矛盾，「代价」段夸大 | 采纳。代价段改写为「结构化判定不是 free 的既有 profile 会被拦；zen-free 不受影响」 | D2 |
| P1-2 判据 4「`small_model` 缺省 ⇒ free」是未验证假设 | 采纳并**收紧**：`small_model` 必须 === 占位符，缺省 ⇒ metered（与全局 fail-safe 一致）；内置 preset 两个都写，不受影响 | D2 判据 4 / §6.1-V3 |
| P1-3 D7「声明优先」使 `cost:"free"` 成为持久授权，与 D5 原则冲突，且冲突时无运行时信号 | **部分采纳**。保留声明优先（理由：硬编码具体 free 模型 id 是本仓最常见的免费形态，结构化优先会把它也堵死）；但把「冲突时 doctor 报 warn」从 §7 待定**提为本次必做** | D7 / §5 / §6.1-V18、V26 |
| P1-4 D8 无任何可执行验收 | 采纳。`tests/server-tools.test.ts` 的 `listTools` 保留完整 tool 对象并断言 schema；`scripts/smoke-stdio.mjs` 保留 `inputSchema` 做同一断言（覆盖 dist） | D8 / §5 / §6.1-V30、V31 |
| P1-5 §5/§6 漏 `InitAnswers.cost`、`tests/init.test.ts`、`tests/server-tools.test.ts`、`src/init-changes.ts`、`configuration.md:86` 保留字清单 | 全部采纳 | D6 / §5 / §6.2 |
| P1-6 V2/V3 只覆盖「small_model 付费」一侧 | 采纳。加 V2b（`model` 付费 / `small_model` 占位符 ⇒ metered）；V3 措辞改成「=== 占位符」 | §6.1 |
| P1-7 V13/V14 的退出码在 `doctor()` 单测里断言不了 | 采纳。单测层断言 `report.ok`；退出码是 `runDoctor` 的直接映射（`src/cli.ts:80`），不另起 CLI 测试 | §6.1-V16、V17 |
| P1-8 D2 step 2「非法 cost ⇒ fail-safe 按 metered」在 submit 路径不可达 | 采纳。**删除**该分支与误导性描述；写明"非法 cost ⇒ `loadConfig` 抛 ⇒ server 起不来" | D2 |
| P2-1 integration 的 8 个行号是 `profiles:` 夹具不是 submit 调用点 | 采纳。措辞改为「8 处 `profiles:` 夹具，覆盖 18 处 `submit()` 调用」 | D9 / §6.2 |
| P2-2 doctor/cli-env/config 的夹具无 cost（不红但多 info） | 采纳。doctor 的干净夹具必补，其余列为可选 | D9 / §6.2 |
| P2-3 `config-issues.test.ts:154-158` 单独证伪不了 P0-2 | 采纳。保留改动 + 在 V15 写明必须构造「info 在前、error 在后」的夹具 | §6.1-V15 |
| P2-4 `collectConfigIssues` 若自己再判一遍就是第二份真相 | 采纳。§5 明确 cost 两条规则**必须调用** `effectiveProfileCost()`；加 V33 | §5 / §6.1-V33 |
| P2-5 D5 逃生口「`profile use`」隐含免费档已存在 | 采纳。逃生口补 `profile create opencode-zen-free --use` 前置 | D5 |
| P2-6 「不建任务、不写库」不精确（`openStore` 已建库文件） | 采纳。改成「不插任务行」 | D3 |
| P2-7 闸门放在模型存活探测之后 ⇒ 白付一次子进程、掩盖真实原因 | 采纳。闸门前置到探测之前 | D3 硬约束 2 / §6.1-V10 |
| P2-8 §5 未列 `CHANGELOG.md` | 采纳。本改动是破坏性行为变化，发版必须写清楚 | §5 / §6.3 |

**v3 仍未闭环、需要下一轮确认的点**（→ 三条在 v4 全部有结论，见 §8.3）：

- **D10 的 `cost` 列是"最近一轮的有效成本"**——续跑时若 profile 被改过，历史轮次的成本会被覆盖，
  库里看不出"第 1 轮是 free、第 2 轮变 metered"。这是"一列 vs 一张历史表"的取舍，本稿选一列
  （列越少越不容易漂移）。若要保留历史，需要第二张表 —— v3 判断不值得，但请下一轮确认这个取舍。
- **D7 的残留风险**：声明 free 仍是文件里的一个词，agent 有 shell 就能伪造。四层兜底（D1 配置口径 +
  D1 参数口径 + D10 留痕 + D7 warn）里，**只有 D10 是机制性的**，另外三条都依赖 agent 自觉。
  这是 §1 已声明的边界，但"留痕"能否真的替代"拦截"，需要下一轮给个判断。
- **V31 需要 dist 构建产物**：`scripts/smoke-stdio.mjs` 默认跑 `dist/` ⇒ 该验收需要先 `npm run build`，
  与"只读环境跑不了测试"这一前提冲突 —— v3 把它标成"发布前冒烟项"而不是单测项。

### 8.3 v3 → v4（评审 `task_mwu7xaim_a9debb`，裁决「**可落地**」）

第 3 轮工单原本很重（45KB 文档 + 8 个问题 + 26 个文件），首派 `task_mwu4opph_242f2d` **5400s 超时、
0 输出**（35 次工具调用全花在 grep 上）⇒ 收窄成 4 问 / 8 文件 / 10800s 重派，本轮 123s 完成。
裁决：4 条 P0 **全部修对**，无新增阻断级问题，**"是调度方与评审方认可的 spec"**；另提 5 P1 / 3 P2。

调度方已逐条独立复核该评审的代码引用，**5 P1 / 3 P2 全部成立**。

| 评审条目 | v4 的处理 | 落在哪 |
| :--- | :--- | :--- |
| **P1-a** §5 要求 cost 两条规则**都**调 `effectiveProfileCost()`，但"非法值→error"无法由它表达（它只返回 free/metered） | **采纳**。§5 改为：只有「未声明→info」调 `effectiveProfileCost()`；「非法值→error」是独立合法性判断。V33 只锁 info 规则 | §5 / §6.1-V33 |
| **P1-b** `TaskPatch` 含 `cost` ⇒ 任何 `store.patch(id,{cost})` 都能绕过闸门写值 ⇒ 不变量只靠约定 | **采纳**（这是本轮最有价值的一条）。`cost` 从 `TaskPatch` 排除 + 专用 `setCost()` + `patch()` 运行时剔除 ⇒ 不变量变成**代码结构保证** | D10 / §5（store.ts 行） / §6.1-V36 |
| **P1-c** 续跑 patch 覆盖成本 ⇒ metered→free 会抹掉已花钱的事实 | **采纳**。改成**粘性 metered**（`old === "metered" ? "metered" : new`），一行逻辑、不要第二张表 | D10 / §6.1-V37 |
| **P1-d** D7 声明优先 + D10 记"有效成本" ⇒ 伪造 `cost:free` 时闸门放行、留痕也是 free ⇒「只有 D10 是机制性」不成立 | **采纳**（v3 的自评被推翻，见下）。D7 与 D10 都写明：**伪造与诚实声明在文件里完全一样，任何留痕都区分不了**；D10 记录的是"工具当时的判定"，不是真值 | D7 / D10 / §8 末尾 |
| **P1-e** 判据 4 收紧带来两类"确实免费却被判 metered"的误伤，D2 代价段没写 | **采纳**。代价段补一张两行表（只写 `model` 不写 `small_model`；`small_model` 是硬编码 free id）+ 修法 | D2 代价段 / §6.1-V38 |
| **P2-a** 老库空串在 `cardFooter` 会落到两档之一 | **采纳**。status 与卡片都显示「未记录」 | §5（runner/status 行） / §6.1-V29 |
| **P2-b** D5「不存在死锁」在老 server（0.3.0 静默剥离）上不成立 | **采纳**。加「在新 server 上」的限定，并指向 D8 的人工确认 | D5 |
| **P2-c** D4 说 info 不影响 summary，但 D7 的 warn 会命中 warn 分支 | **采纳**。写明 doctor summary 的既有三档语义：error ⇒ "N problem(s) found"；warn ⇒ "Config is usable, but one item needs attention"；否则 "All good"。**info 不参与、warn 参与** | D4 |

### 8.4 v3 自评被推翻的一条（诚实记录）

v3 在 §8 末尾断言：**「四层兜底里只有 D10 是机制性的，另外三条都依赖 agent 自觉」**。
第 3 轮评审指出这不成立：D10 记录的值同样源自那份**可伪造的**声明——agent 伪造 `cost:"free"` 时，
闸门放行、留痕也记 "free"。**评审是对的**，v4 把这条断言改写成：

> D10 记录的是「工具在派发当时依据当时配置作出的判定」，不是"模型是否真的收费"的真值。
> 伪造 `cost:"free"` 这一情形**任何留痕都区分不了**（诚实的声明与伪造的声明在文件里完全一样）。
> ⇒ **防伪造不在机制层，在纪律层（铁律 5）与可观测层（D10）。**

设计结论不变，但边界说清楚了：**这套机制防的是"agent 自我授权"与"花费不可见"，
不是防一个有 shell 的对手**——与 §1 的机制边界一致。

### 8.5 v4 → v5（确认轮 `task_mwu836yl_f3acf6`）

确认轮工单只问一件事："上一轮提的 5 P1 + 3 P2，在 v4 里是否真的落到位"，范围极小
（8 次工具调用、132 秒完成）。判定：**8/8 全部落到位**（逐条给了行号证据）；
同时**发现 1 处 v4 内部的措辞级自相矛盾**（P1，非 P0）：

> v4 的 D10 不变量写的是"**任何一次**把 `cost` 写成 `"metered"` 的派发，都必然带着 `allow_metered`
> 过了闸门"——这句话与 v4 自己刚加的**粘性 metered** 规则冲突：
> Round1 metered（过闸门、行记 metered）→ profile 被改成 free → Round2 续跑判定 free、**不带**
> `allow_metered` 即放行 → 粘性规则又因 `old==="metered"` 写入 `"metered"` ⇒ 该轮"写了 metered"
> 却当轮没过 metered 闸门。

**实质没有受损**（真正发生的 metered 花费在 Round1、那一轮过了闸门；粘性只是保留标签，
不产生未授权花费）——受损的是**陈述的准确性**：它会让实现者/评审误以为"每轮 metered 都过闸"。

v5 的修法（落在 D10）：不变量改成
「**任务行 `cost="metered"` ⇒ 该任务至少有一轮的 `effectiveProfileCost` 是 `"metered"` 且那一轮
过了闸门；sticky 保留轮的 metered 不要求当轮 `allow_metered`**」——与粘性规则自洽，且保住
"没有未授权的 metered 花费"这个实质。

确认轮的最终一句话：**"8 条全部落到位；v4 是双方认可的 spec+plan，可以开工——唯一收尾项是把 D10
不变量按上句改写一次。"** ⇒ v5 已改。

### 8.6 终稿状态

- 四轮评审的裁决依次为：**「需补 4 处 P0」→「可落地（认可的 spec）」→ 确认轮 8/8 落到位 + 1 处措辞矛盾（已修）**。
- §3 的 D1–D10 是 spec；§5 的落地清单 + §6 的 V1–V38 与迁移清单是 plan。
- **v5 = 终稿**，可直接进入实现（§6.1 的 V1–V38 是验收判据）。
- 剩余的**非阻塞**待定项见 §7（都不影响开工）。
- 一处值得留下的教训：**工单粒度比模型选择更要命**——第 3 轮首派（45KB 文档 + 8 问 + 26 文件）
  5400s 超时 0 输出，收窄成 4 问 / 8 文件后 **123 秒**出报告。

### 8.7 交接注记（实现开工时要知道的树状态）

终稿落盘时，工作区还有**另一路人并行改动**（不是本设计的一部分，实现时要注意合流）：

| 文件 | 并行改动 |
| :--- | :--- |
| `package.json` | 版本 `0.5.1` → `0.5.2`，新增 `mcpName: "io.github.wuruofan/agent-ex"` |
| `package-lock.json` | 随之更新 |
| `src/server.ts` | `serverInfo.version` 改为读 `package.json`（原先硬编码 `"0.1.0"`） |
| `CHANGELOG.md` | 新增 10 行（该版本的发布说明） |
| `glama.json` / `server.json` | 新增（未跟踪，MCP 注册相关） |

⇒ 两条提示：

1. **§5 的 `src/server.ts` 行（加 `allow_metered` schema）会与上述并行改动落在同一个文件**——
   合流时注意两处都改到了 `main()` 附近的同一段。
2. **D8 要求"发布时 bump 版本"**：包版本已经是 0.5.2，但 `allow_metered` 尚未进包 ⇒ 真正带
   `allow_metered` 的版本号要等实现落地后才确定，SKILL 的前置检查门槛文案按**实际发版版本**写。
