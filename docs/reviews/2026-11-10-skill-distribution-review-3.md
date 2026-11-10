# 第三轮评审：skill 分发与子命令（011d7bb / ba079d8）

> 评审对象：`011d7bb fix(skill): close the second-round findings` + `ba079d8 refactor(skill): drop the linkHost helper`
> 前置：`4cc84de`（第二轮已审）、`882f88a`（初版）；spec：`docs/designs/2026-11-10-skill-distribution.md`
> 分支：`feat/skill-distribution`；评审日期：2026-11-10
> 方法：逐条核对第二轮修复 + 全新缺陷 hunting；全部结论都带实测命令/输出或 file:line。

## 结论

第二轮的 2 条 P1、3 条 P2、8 条 P3 **全部真实落地**，没有「声称修了其实没修」的项；
`npm run typecheck` 通过，`npm test` 500/501（唯一失败是预存在的 `tests/init-e2e.test.ts` flaky，与本特性无关）。
但本轮新发现 **2 条 P1**（其中 1 条是本轮 spec 新增句子与实现直接矛盾）、**2 条 P2**、若干 P3：

- **P1-a**：canonical 是**断链**时，默认 copy 安装必失败于 `ENOTDIR`（`replaceAtomically` 用
  `existsSync` 判断旧物是否存在，断链返回 false ⇒ 目录 rename 撞上占位的链接名）；
  而 doctor 对该状态给的修法正是 `agent-ex skill install` —— 又是一个「告警修不掉」的循环（与第二轮 P1-1 同型）。
- **P1-b**：本轮往 spec §4.3 新写了一句「canonical 与**宿主链**的改动都是原子替换」，
  但宿主链重指实现是 `rmSync` 后 `symlinkSync`（先删后建，非原子）—— spec 与实现二选一要改。

**建议：先别 push**，把 P1-a（一行改 `lstat`）与 P1-b（改实现或删 spec 那半句）修掉再推。

## 第一部分：上一轮修复的核对

基线：`git show 011d7bb`（第二轮 2P1+3P2+8P3）与 `ba079d8`（linkHost 死代码）。
环境：`npm run typecheck` 通过；`npm test` = 500 passed / 1 failed（`tests/init-e2e.test.ts` 预存在 flaky，
第二轮报告已记录，单跑也红，与 skill 无关）。所有 CLI 实测均用 `HOME=$(mktemp -d)` 隔离。

| 项 | 结论 | 证据 |
|---|---|---|
| P1-1 默认不链宿主的旧链必须重指 | **已修** | `src/skill.ts:998-1016`（指向别处 ⇒ 问/重指）与 `:1024-1030`（断链 ⇒ 修复）都在 `:1043-1048` 的 `linkByDefault === false` 跳过**之前**；跳过只落在「没有条目」分支。实测：codex 里先放旧链，`HOME=$D npx tsx src/server.ts skill install --yes` ⇒ `repointed …/.codex/skills/agent-ex-dispatch -> …/.agents/skills/agent-ex-dispatch`，`readlink` 已指向 canonical。宿主目录**不存在**时不创建：新 HOME 装完 `--yes` 后 `.codex/`、`.config/opencode/` 均未生成（`symlinkAt` 是唯一 mkdir 点，且在跳过之后）。 |
| ↳ 交互语义 vs spec §4.4 | **一致** | spec `:302-305`：「已有指向别处的链 → 提示…要不要重指 → **重指**（`--yes` 直接重指）；即便有自动桥接也必须重指」。实现：TTY 下 `makeConfirm` 真的提问（伪终端实测：`Repoint it? (Y/n):` → `y` → 重指；随后第二个问题 `Link the dispatch skill into Claude Code …? (Y/n):` 也正常答出，说明每个问题新建 readline 的写法在真 TTY 上可用）；`--yes` ⇒ `confirm` 恒真 ⇒ 直接重指 ✓；重指分支在 autoBridge 检查之前，带桥接机制的宿主同样会问 ✓。doctor 的修法（`install (it will ask whether to repoint them)`）现在成立：TTY 会问、`--yes` 直接修。 |
| P1-2 `--source` 自链拒绝 | **已修** | `src/skill.ts:325-329` `sourceWouldSelfLink`：字面相等 → 拒；canonical 是软链 → 放行（开发者路线）；否则 realpath 相等（别名路径）或 source 在 canonical 内 → 拒。调用点 `:785-790` 排在 SKILL.md 校验之前。实测（隔离 HOME）：① `--link --source <canonical>` ⇒ `✗ … is the canonical location itself … refusing to link it to itself`，exit 1，canonical 仍可读；② `/private/var/...` 别名路径 ⇒ 同样拒绝；③ `--source <canonical>/references` ⇒ 拒绝；④ 开发者路线（canonical 是软链、source=其目标）⇒ `skip (already linked to the source)` 幂等放行，copy 模式也能正常把软链换成拷贝。**未发现误杀**：软链 canonical 下所有合法 source（目标、目标的别名、目标子目录）都放行——因为 `isSymlinkPath` 提前 return false，`isInside` 分支根本不会碰到开发者路线。测试 `tests/skill.test.ts:394-430` 四条用例均实打实断言了拒绝/放行。 |
| P2-1 `replaceAtomically` 五条 | **已修**（② 的 rename-失败路径靠手工实测覆盖，见 P3-e） | `src/skill.ts:677-726`。① 新内容先在 tmp 上做（`:686` `build(tmp)` 先于一切 rename）✓；② 失败清 tmp——build 失败 `:689`、`rename(canonical,old)` 失败 `:699`、`rename(tmp,canonical)` 失败 `:706` 均 `rmSync(tmp)` ✓。实测两条：chmod 0555 让 build 失败（EACCES）⇒ `.agents/skills` 里零残留；`chflags uchg` canonical 让 `rename(canonical,old)` 失败（EPERM）⇒ 目录里只剩 `agent-ex-dispatch`，无 `.tmp.*`/`.old.*`，canonical 原封不动，解锁后重跑成功；③ `:697-701` 旧的挪不动 ⇒ canonical 原地不动、清 tmp、抛 ✓；④ `:708-721` 换位失败先回滚，回滚失败**不删 old** 并抛出带 `old` 路径的指引错误 ✓（代码核对，APFS 造不出该窗口）；⑤ `:725` 成功才 `rmSync(old)` ✓。保留意见：tmp/old 名带 pid，**SIGKILL 崩溃残留后续进程永远清不掉**（见第二部分 P3-a）。 |
| P2-2 切软链走 `linkAtomically` | **已修** | `src/skill.ts:734-736`。建链失败（build 阶段）⇒ canonical 没被碰过：`tests/skill.test.ts:597-608`（chmod 0555）断言失败后 `lstatSync(canonical).isSymbolicLink()===false` 且 SKILL.md 还在，通过。⚠️ 软链语义逐条核对：`renameSync(canonical, old)` 挪的是**链接本身**（rename 操作目录项，不跟目标）；`rmSync(old, {recursive:true})` 删的也是链接本身（rm 不跟软链）。实测：canonical 是指向 `$D/elsewhere` 的链，切链成功后 `elsewhere/data.txt` 仍在（`old target intact: keepme`）。 |
| P2-3 库 API 无 `yes`/`confirm` 抛错 | **已修** | `src/skill.ts:764-771`（install）与 `:1110-1117`（remove）：默认 confirm 在需要提问时 throw。实测 tsx eval：`removeSkill({userHome, source})` ⇒ 抛 `cannot ask interactively…` 且 canonical **仍在**；canonical 为 link-elsewhere 时 `installSkill({userHome, source})` ⇒ 抛错且链**未被重指**（`readlink === other`）。全仓调用方无一被打中：`src/skill-cmd.ts:209-228` 总是注入带 TTY 检查的 confirm；`tests/skill.test.ts` 每个调用都带 `yes` 或 `confirm`（grep 逐条核对）；`scripts/install-skill.sh` 走 CLI。测试 `tests/skill.test.ts:613-626` 两条断言抛错 + 断言磁盘未动。 |
| P3-1 doctor 早退 summary | **已修**（无回归测试） | `src/doctor.ts:350-356` 改为 `config.json is unusable — config-dependent checks were skipped`。实测（坏 config + skill 段）：输出同时含新 summary 与 skill 告警/绿条。`grep -rn "config-dependent" tests/` 无结果 —— 这条文案没有测试钉住。 |
| P3-2 spec/plan 的 `--yes` 旧语义 | **已修** | spec `:193`、`docs/plans/…implementation-plan.md:279` 均已改成「跳过所有询问（默认不链的宿主仍需 --target）」；`grep -rn "所有探测到的宿主" docs/ README.md src/` 只在旧评审报告里还有（作为历史引用）。 |
| P3-3 broken-link 进体检 | **已修** | `src/skill.ts:552-582` `mislinked` 含 `kind === "broken-link"`，detail 分「指向别处」「断链」两段；测试 `tests/skill.test.ts:558-568` 断言 `detail` 含 `broken`。 |
| P3-4 canonical 不存在时不说 kept | **已修** | `src/skill.ts:1164` `hostLinkFailed && existsSync(canonical)` 才走 kept 分支。 |
| P3-5 测试缺口 | **已修（有保留，见 P3-e）** | 新增 17 条测试（`git show 011d7bb --stat`：tests +206）；`pointsAtCanonical` 单测、reserved/excluded 表单测、库默认 confirm 单测均在且断言到位；`tests/skill-cli.test.ts:88,104` 补了 `rmSync(r.home)`（临时 HOME 不再泄漏）；相对 source 用例改用 `relative(process.cwd(), source)`（`:375-385`），不再依赖 cwd==仓库根。**保留意见**：`:566-596` 的「替换失败」用例 chmod 0555 实际命中的是 **build 失败**分支（cpSync 连 tmp 都建不了），注释声称的 `rename(canonical,old)` 失败路径并没有被测试钉住 —— 该路径我用 `chflags uchg` 手工验证过（无残留），但 CI 里没有守卫。 |
| P3-6 spec §4.6 样例 | **已修** | spec `:354` 不再打印体积、`:360` 补了链到别处的样例，与实现一致。 |
| P3-7 无用 re-export | **已修** | `src/skill-cmd.ts` 末尾 `export { collectSkillIssues, canonicalPath }` 已删（`011d7bb` diff），`grep -rn "from \"./skill-cmd" src/ tests/` 无任何调用方。 |
| P3-8 README 的 `--yes` 表述 | **已修** | `README.md:154-157`：`--yes` 是「所有问题答 yes」不是「所有宿主都链上」；默认不链宿主的旧链照样重指。与实现实测一致。 |
| `linkHost` 死代码（ba079d8） | **已修** | `git show ba079d8` 删 12 行；`grep -rn linkHost src/ tests/` 无残留；typecheck/测试全绿。 |

小结：**15 项全部「已修」，无「未修」**；P3-5 一条带覆盖保留（见上）。

## 第二部分：新发现的缺陷

严重度口径：**P0** = 破坏用户数据 / 装出坏状态 / 静默失败；**P1** = 功能与 spec/文档矛盾，或常见路径出错；
**P2** = 边界/健壮性问题；**P3** = 措辞、可读性、一致性、测试缺口。

### P1

- **canonical 是断链时默认 copy 安装必失败 `ENOTDIR`，doctor 给的修法（`skill install`）修不掉这个告警** — `src/skill.ts:693`
  现象：canonical 为悬空软链（开发者路线的目标被删/仓库移走后很常见），跑默认 `skill install --yes`：

  ```bash
  D=$(mktemp -d); mkdir -p "$D/.agents/skills"
  ln -s "$D/gone-target" "$D/.agents/skills/agent-ex-dispatch"
  HOME="$D" npx tsx src/server.ts skill install --yes; echo "exit=$?"
  ```

  实际输出（exit 1）：
  ```
  ✗ install …/.agents/skills/agent-ex-dispatch: ENOTDIR: not a directory,
    rename '….tmp.78437' -> '…/.agents/skills/agent-ex-dispatch'
  ```
  同一状态下 `doctor` 报 `! Dispatch skill is linked to another location`，fix 是
  `→ agent-ex skill install (it will ask whether to repoint it)` —— 正是这条会 ENOTDIR 的命令。
  为什么是缺陷：`replaceAtomically` 用 `existsSync(canonical)` 判断旧物是否存在，而 `existsSync`
  **跟随**软链 —— 断链返回 false ⇒ 不把占位的链接名挪开 ⇒ `rename(目录, 软链)` 撞出 ENOTDIR。
  这与第二轮 P1-1 完全同型：doctor 主动报的告警，install 修不掉，用户陷在循环里
  （唯一出路是 `remove` 后重装或 `install --link`，两条路都没写进任何提示）。
  附带：`status` 对 canonical 也只打印 `[link -> /…/gone-target]`，不像宿主链那样标 `broken link`
  （`src/skill-cmd.ts:139`），用户看不出它已经断了。
  建议修法：`hadOld` 改用 `lstatSync` 探测（名字被占位就算有，不跟随），或 rename 前对
  `isSymlinkPath(canonical)` 先挪开；补一条「断链 canonical + copy install」的回归测试，
  顺手在 status 的 canonical 标签上补 broken 判定。

- **本轮往 spec §4.3 新写的一句话与实现直接矛盾：宿主链改动并非原子替换** — `docs/designs/2026-11-10-skill-distribution.md:285` vs `src/skill.ts:1010-1011,1026-1027`
  现象：`011d7bb` 给 spec 新增了
  「⚠️ canonical **与宿主链**的改动都是**原子替换**（先在临时名上做好新内容，再换位，失败回滚）」。
  但宿主链的重指（`:1010-1011`）与断链修复（`:1026-1027`）都是 `rmSync(linkPath)` **之后**才
  `symlinkAt(...)` —— 先删后建；`symlinkSync` 一旦失败，旧链已经没了、新链没建上，
  只记一条 error（这正是本轮给 canonical 修掉的 P2-2 同款问题，宿主链这条线没享受到）。
  为什么按 P1 记：这是本轮修复自己写进 spec 的行为承诺，与实现二选一必须改，属「功能与 spec 矛盾」。
  实际后果有限（丢的本来就是要被替换的坏链、且 error 会报出来），所以不是 P0。
  建议修法：二选一——① 把宿主链重指/修复也改成 `replaceAtomically(linkPath, tmp => symlinkSync(canonical, tmp))`
  （与 canonical 路径统一，顺手把 `rmSync+symlinkAt` 收编）；② 至少把 spec 那半句改成
  「canonical 的改动是原子替换；宿主链重指是先删后建」。别让文档承诺一个不存在的保证。

### P2

- **`--target` 可以指向 canonical 内部：在已安装的 skill 目录里静默建出自指链，甚至写穿进源码树** — `src/skill.ts:800-808`
  现象：`--target` 的自链检查只挡了「等于 canonical」与「等于 canonical 的父目录」，**没挡 canonical 的子目录**
  （`--source` 侧本轮刚按 spec §4.3 补了「canonical 的子目录一律拒绝」，target 侧没有对称防线）。
  复现 A（copy 模式，自指环，status/doctor 全程无告警）：
  ```bash
  D=$(mktemp -d); HOME="$D" npx tsx src/server.ts skill install --yes
  C="$D/.agents/skills/agent-ex-dispatch"
  HOME="$D" npx tsx src/server.ts skill install --target "$C/inner" --yes; echo "exit=$?"
  # → linked …/agent-ex-dispatch/inner/agent-ex-dispatch -> …/agent-ex-dispatch   exit=0
  ```
  `hashDir` 跳过软链 ⇒ 内容 hash 不变 ⇒ `status` 既不报 LOCAL MODIFICATIONS、doctor 也无任何告警，
  一个指向自己祖先的环被静默留在 skill 目录里（递归扫描型加载器会绕圈）。
  复现 B（`--link` + canonical 是软链 ⇒ **写穿进 skill 源码树**，实测）：
  ```bash
  # canonical -> <repo>/skills/agent-ex-dispatch（开发者路线）
  HOME="$D" npx tsx src/server.ts skill install --link \
    --target "$D/.agents/skills/agent-ex-dispatch/references" --yes
  # → 在 <repo>/skills/agent-ex-dispatch/references/ 下建出 agent-ex-dispatch 软链，exit 0
  ```
  我用这条命令实测时，它真的在本仓库 `skills/agent-ex-dispatch/references/` 里落了一条软链
  （已清理，`git status` 恢复干净）——即 `--target` 能把文件写到 home 之外的任意树里，全程静默。
  建议修法：target 检查补一条 `isInside(join(dir, SKILL_NAME), canonical)`（linkPath 落在 canonical
  里面 ⇒ 拒绝），与 source 侧对称；补两条回归测试（copy 自指环 / link 写穿）。
  顺带：`--target` 传 canonical 父目录的**别名路径**（`/private` 前缀）也不被
  `dir === dirname(canonical)` 挡住（string 比较），实测后果 benign（落到 skipped/already-points），
  但同属比较没走 realpath，可一并收进 `samePath`。

- **换位成功后 `rmSync(old)` 若抛错 ⇒ 安装实际已成功却报失败（exit 1），并留下 `.old.<pid>`** — `src/skill.ts:725`
  现象（代码推理）：`:725` 的 `rmSync(old, …)` 在所有 try/catch 之外。走到这里时新内容已经在
  canonical 上（安装**已经成功**），但 rm 一旦抛（权限/标志位翻转等），错误会冒到 `attempt` ⇒
  `errors` 非空 ⇒ `ok=false` ⇒ exit 1，同时 `.old.<pid>` 残留 —— 而 tmp 名带 pid，下个进程清不掉。
  这违背 `replaceAtomically` 自己的注释承诺（「失败时 canonical 原封不动」——此处 canonical 已经动了却报失败）。
  触发概率低（与 rename 同一目录、同一权限面），故列 P2；建议把这一步降级为
  `try { rmSync(old) } catch {}`（或记进 `lines` 而非 `errors`）：新内容在位，备份残留不是失败。

### P3

- **SIGKILL 崩溃窗口的 tmp/old 永久残留，且 `.old` 里的唯一副本对后续逻辑不可见** — `src/skill.ts:680-683`
  tmp/old 名带 pid（本意是并发隔离），代价是**只有本进程能清**：崩溃在 `rename(canonical,old)` 与
  `rename(tmp,canonical)` 之间 ⇒ canonical 缺失、唯一副本躺在 `.old.<pid>` 里，而 `inspectCanonical`
  只看 canonical 本体 ⇒ 下次 install 按 missing 装新份，旧备份永远孤儿（tmp 同理）。
  本轮的「任何失败路径清 tmp」只覆盖抛异常的路径，不覆盖被 kill 的进程。
  建议：install 开头顺手 `readdirSync(parent)` 清掉属于**其它** pid 的陈旧 `.tmp.*`/`.old.*`
  （或把 old 也一并挪进一个固定名的 `backup/` 目录再按内容判断）。

- **`install-skill.sh` 的相对 target 按 cwd 解析，会把目录建进当前目录** — `scripts/install-skill.sh:31` + `src/skill.ts:801`
  实测：`AGENT_EX_SKILL_TARGETS="a::b" /bin/bash scripts/install-skill.sh`（在仓库根跑）⇒
  在**仓库根**建出 `a/ agent-ex-dispatch` 与 `b/ agent-ex-dispatch`（exit 0；我已清理）。
  脚本对 `~` 做了展开（`:43`）却不处理相对路径；CLI 侧 `resolve(t)` 按 cwd 解析是 Node 惯例，
  但脚本作为「开发者路线入口」应把非绝对路径按 `$REPO_ROOT`/`$HOME` 兜底，或在用法里声明必须绝对。
  （bash 3.2 边界本身没问题：`":"` ⇒ `ERROR: no target directory` exit 1；`a::b` 正确切段；
  `~/.a::~/.b` 正确展开建链 exit 0 —— 均实测。）

- **自链拒绝的报错文案对「子目录」不准确** — `src/skill.ts:787`
  `--source <canonical>/references` 被拒时打印
  `… is the canonical location itself (…)` —— 它不是 canonical 自己，是**在里面**。
  拒绝本身正确（spec §4.3 要求），文案应区分 `is the canonical location` / `is inside it`。

- **`skip host links (… is not a usable install …)` 在两个分支与事实不符** — `src/skill.ts:983`
  `link-to-source` 换拷贝失败（旧链还在、仍指向 bundled source）与 `adoptable` 写 marker 失败
  （目录内容就是 bundled skill）都会 `canonicalReady=false` ⇒ 打印「不是可用安装」并跳过所有宿主链。
  跳过本身是保守选择（写失败了先别拉宿主下水）可以接受，但这两条分支里 canonical **确实可用**，
  文案误导；`adoptable` 的注释（`:966`「无论认领还是跳过，目录里就是 bundled 内容」）也与
  marker 写失败即 break 的行为自相矛盾。

- **`rename(canonical, old)` 失败路径其实没有回归测试钉住** — `tests/skill.test.ts:566-596`
  用例注释写「chmod 0555 ⇒ rename 必然失败」，但 chmod 后 `build(tmp)`（cpSync 建 tmp）就先失败了，
  命中的是 build-失败分支；真正会泄漏 tmp 的 `rename(canonical,old)` 失败路径（本轮手工用
  `chflags uchg` 验证过无残留）在测试套件里没有守卫。把 chmod 换成「目录可写但对 canonical rename
  不可」的手段（uchg/只读挂载/可注入 fs），或至少改掉误导性注释。

- **doctor 早退 summary 的新文案没有测试** — `grep -rn "config-dependent" tests/` 无结果
  （P3-1 的修复只有我的手工实测背书，改回去不会有人发现）。

- **doctor 对纯断链的宿主给的 fix 文案说 "repoint"** — `src/skill.ts:580`
  实际 install 对断链是直接 repair、**不问**（`:1024-1030`）；文案
  `it will ask whether to repoint them` 对断链情形不精确（结果没错，措辞误导）。

- **`skill status` 接受 `--target` 但静默忽略** — `src/skill-cmd.ts:124-171`
  spec §4.1 写 status「只读，无参数」，实现对 `--target` 照单全收、打印状态后返回 0。
  无害但与 spec 字面不符；要么拒绝、要么 usage 里只列 `--source`。

### 我没能验证的部分

- **`rename(tmp, canonical)` 失败 → 回滚 → 回滚也失败** 的分支（old 保留并报路径）：APFS 上造不出
  「第一次 rename 成功、第二次必然失败」的窗口，只有代码核对（与第二轮相同）。
- **SIGKILL 中途崩溃**的残留行为：没有真的 kill 过进程，P3-a 是代码推理（`existsSync`/pid 命名的行为已单独实测）。
- **P2（rmSync(old) 抛错）**：同样只有代码推理，未构造出权限场景。
- **真实宿主加载**：Claude Code / Codex / OpenCode 是否真的读这些路径，仍只用假目录验证了链路逻辑。
- **TTY 提问**用 macOS `script` 伪终端模拟（两问连答成功），不是真实终端 App 的行为。
- **Windows**（软链权限）未测；`bash 3.2` 只测了 `~`、空段、相对值三种 env 形态，没测 `~user` 展开。
- **全量 `npm test` 的唯一红**是预存在的 `tests/init-e2e.test.ts` flaky（第二轮已记录，与本特性无关）；
  需要 CI 的权威结果。
- **152 KB 打包基线**沿袭第二轮仍未复验（本轮未重新 `npm pack` 对比）。

---

## 附：修复状态（2026-11-10，维护者回填）

本轮的两条 P1 与两条 P2 已修（另附 P3 的文案与脚本边界）：

| 编号 | 处理 | 说明 |
|---|---|---|
| P1-a（断链 canonical ⇒ ENOTDIR） | 已修 | `replaceAtomically` 的占位探测从 `existsSync`（**跟随**软链）改成 `lstat`（名字被占就算有）。实测：断链 canonical + `install --yes` 现在正常装上（exit 0）。 |
| P1-b（spec 说宿主链原子替换，实现是先删后建） | 已修（改实现） | 宿主链的重指 / 断链修复 / 显式 `--target` 建链都改走 `replaceAtomically` —— 旧的链在换位成功前一直在。 |
| P2-a（`--target` 指进 canonical） | 已修 | 新增检查：链接位置落在 canonical 路径里面、或落在 canonical 的 realpath 里面（开发者路线下 = 源码树），一律拒绝。 |
| P2-b（`rmSync(old)` 抛错 ⇒ 报失败） | 已修 | 备份清理失败**不算安装失败**（新内容已经就位，报失败是撒谎）⇒ 降级为静默保留。 |
| P3-c（脚本的相对 target 建进 cwd） | 已修 | `install-skill.sh` 把相对路径按 **`$HOME`** 展开（不是 cwd —— 脚本常在仓库根跑）。 |
| P3-d（自链报错文案） | 已修 | 区分「就是 canonical 自己」与「在 canonical 里面」。 |
| P3-e（"skip host links" 文案与事实不符） | 已修 | 按实际情况说「canonical 没更新成功」/「canonical 仍指向别处」。 |
| P3-f（doctor summary 没测试） | 已修 | 补了断言。 |
| P3-g（断链的 fix 文案说 repoint） | 已修 | 改成「repoint or repair」。 |
| P3-h（`status` 收 `--target` 却默默忽略） | 已修 | 改成用法错误（退出码 2）。 |

**仍未解决、已写进 spec 的已知限制**（P3-a）：
临时名带 pid（并发隔离的代价）⇒ 进程被 SIGKILL 时 `.tmp.<pid>` / `.old.<pid>` 会残留，
后续进程清不掉（内容无害：新内容已就位，残留只是一份多余备份）。
没有做"按 mtime 清陈旧残留"——那会误伤并发中的另一个安装。
