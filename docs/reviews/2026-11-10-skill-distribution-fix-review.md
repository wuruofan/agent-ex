# 复审：skill 分发与子命令的评审修复（4cc84de）

> 评审对象：`4cc84de fix(skill): close the review findings in the skill install/remove flow`
> 上一版实现：`882f88a`；spec：`docs/designs/2026-11-10-skill-distribution.md`
> 分支：`feat/skill-distribution`；评审日期：2026-11-10

## 结论

18 条声称项**全部在代码里落地**（第 1 条按声明范围成立），没有出现「声称修了但没改」的情况。
但修复留下的两处门控仍有缺口，建议**先修再合并**：

- **P1-1**：默认不链的宿主（codex/opencode）上若已有一条**指向别处的旧链**，`install` 直接跳过、
  永不重指 —— 与 spec §4.4「已有指向别处的链必须重指（即便有自动桥接）」冲突；`doctor` 还会给出
  一条「install 会问你要不要重指」的**无效修法**。
- **P1-2**：`skill install --link --source <canonical 自己>`（或其别名）会**静默**把 canonical
  换成一条指向自己的断链并返回 0 —— 只有 `--target` 有自链检查，`--source` 没有。

另有 3 条 P2（tmp 泄漏、link 路线先删后建、库 API 默认 confirm 放行）和 8 条 P3（文档/测试/提示语）。
`npm run typecheck` 通过；`npm test` 除 `tests/init-e2e.test.ts` 一条**与本次改动无关**的预存在失败外全绿
（见文末「我没能验证的部分」）。

## 第一部分：18 条声称已修的项

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `copyAtomically` 失败回滚不再删唯一备份；cpSync 失败清理 tmp | 已修（按声明范围） | `src/skill.ts:612-653`：cpSync 在 try 内、失败 `rmSync(tmp)`；`rename(tmp,canonical)` 失败时尝试 `rename(old,canonical)`，回滚失败**不删 old** 并抛出带 `old` 路径的错误；成功后才 `rmSync(old)`（旧代码的 `finally` 已移除）。⚠️ 另有一条未覆盖的临时目录泄漏，见第二部分 P2-1。 |
| 2 | `--link --source <相对路径>` 解析为绝对路径；无 `SKILL.md` 提前拒绝 | 已修 | `src/skill.ts:681` `resolve(...)`；`src/skill.ts:692-695` 校验 `SKILL.md`。实测（隔离 HOME）：`HOME=$D tsx src/server.ts skill install --link --source skills/agent-ex-dispatch --yes` ⇒ `linked ... -> /Users/.../agent-ex/skills/agent-ex-dispatch`，`readlink` 为绝对路径且目标可读；`--source <空目录>` ⇒ `✗ skill source has no SKILL.md`，exit 1。单测：`tests/skill.test.ts:303-328`。 |
| 3 | 宿主链删失败时保留 canonical | 已修 | `src/skill.ts:1038-1058` 记录 `hostLinkFailed`；`src/skill.ts:1061-1069` 为真时 `skipped.push(canonical)` 并打印 `kept`，不删 canonical。单测：`tests/skill.test.ts:493-511`（chmod 555 让 unlink 失败）在本机通过。 |
| 4 | `tests/doctor.test.ts` 的 doctor 调用注入临时 `userHome` | 已修 | `grep -c 'doctor({' tests/doctor.test.ts` = 29；`grep` 显示**全部**调用都带 `userHome`（`tests/doctor.test.ts:55..534`）；`beforeEach` 创建并注入 `userHome`，`afterEach` 清理（`tests/doctor.test.ts:8-19`）。 |
| 5 | `--target` 不吞紧随选项，退出码 2 且不建目录 | 已修 | `src/skill-cmd.ts:53-68` 两个选项都检查 `v.startsWith("-")`。实测 `skill install --target --source x --yes` ⇒ `✗ --target needs a directory (got "--source")`，exit 2，cwd 无 `--source`/`--yes` 目录。单测：`tests/skill-cli.test.ts:80-97`。 |
| 6 | `yes` 生效；JSDoc 默认值改为 false | 已修 | `src/skill.ts:683-685` 默认 confirm 用 `yes ? true : def`；JSDoc 见 `src/skill.ts:579-586`（“默认 **false**”）。实测（tsx eval）：安装后手改 `SKILL.md`，再以 `{yes:true}` 调用 ⇒ 输出 `restored ...` 且内容被覆盖为源内容。 |
| 7 | 版本相同但内容被手改也会问 | 已修 | `src/skill.ts:826-844` 条件改为 `info.updateAvailable || info.modified`，并给出独立问题文案。单测 `tests/skill.test.ts:407-421` 通过（问句含 `local modifications`，否认后保留手改）。 |
| 8 | status 对指向别处的宿主链告警；doctor 有对应体检项 | 已修 | `src/skill-cmd.ts:144-154` 用 `pointsAtCanonical` 区分绿/黄并打印 `(not the canonical copy)`；`src/skill.ts:513-528` 新增 `skill.host-link-elsewhere`（warn）。单测：`tests/skill-cli.test.ts:131-147`、`tests/skill.test.ts:416-425`。 |
| 9 | config 坏掉时 doctor 仍有 skill 段 | 已修 | skill findings 移到读取 config 之前（`src/doctor.ts:324-336`），早退分支排序后返回（`src/doctor.ts:349-350`）。实测隔离 HOME + 坏 config：输出同时含 `✗ config.json is unusable` 与 `· Dispatch skill is not installed`。单测：`tests/doctor.test.ts:242-252`。 |
| 10 | codex/opencode 默认不建链、不提问 | 已修 | `src/skill.ts:95-96` `linkByDefault:false`；`src/skill.ts:902-907` 非显式时跳过并只打印 note。实测（隔离 HOME，三个宿主目录都存在）：install --yes 只给 claude 建链，codex/opencode 目录为空；`--target <codex>` 时才建。单测：`tests/skill.test.ts:365-382`。 |
| 11 | autoBridge 同时查 `.reserved-skill-names` 与 `.excluded-skill-names` | 已修（无回归测试） | `src/skill.ts:111-128` 循环两张表，命中任一返回 false。⚠️ 仓库内**没有**针对 reserved 表的测试（`grep -rn reserved tests` 无结果）。 |
| 12 | remove 拒绝删除时退出码非 0，并报出留下物 | 已修 | `src/skill.ts:1054,1066,1080,1091` 把留下物放进 `skipped`，`ok = errors.length===0 && skipped.length===0`；`src/skill-cmd.ts:117-119,228` 打印 `left in place` 并返回 1。实测：宿主目录里有实体 `agent-ex-dispatch` ⇒ `! left in place: ...`，exit 1；无残留时第二次 `remove --yes` ⇒ exit 0。单测：`tests/skill.test.ts:443-460`。 |
| 13 | canonical 阶段 I/O 失败退出码 1 而非 2 | 已修 | `src/skill.ts:721-729` `attempt()` 捕获写 I/O 错误进 `errors`，CLI 按 `r.ok` 返回 1（`src/skill-cmd.ts:206-217`）。实测：把 `~/.agents/skills` chmod 555 后 install --yes ⇒ `✗ install ...: EACCES`，exit 1，且 `.tmp.*` 已被清理。 |
| 14 | `install-skill.sh`：`~` 展开、空 env 段不炸、`agent-ex` PATH 检查 | 已修 | `scripts/install-skill.sh:41-55`（展开 `~`、丢空段、空数组前判长）；`:80-89`（runtime check）。用 macOS `/bin/bash` 3.2 实测：`AGENT_EX_SKILL_TARGETS=":"` ⇒ `ERROR: no target directory`，exit 1（未触发 unbound variable）；`"~/.alpha/skills::~/.beta/skills"` ⇒ 正确展开为两个绝对目录并建链，exit 0。 |
| 15 | README 三处过期描述（init 收尾、命令表、包体积 41%） | 已修 | README：`:79`、`:420-428`、`:670`、`:738` 已更新；`src/init.ts:398-399` 确实只打印 `agent-ex skill install`。实测 `npm pack` 当前 tarball = **219,577 B（≈215 KB）**，与 README 的 215 KB 一致；41% 由 (215-152)/152≈41.4% 推得，152 KB 基线**未在本轮重新打包验证**（需 checkout 882f88a 前的包）。 |
| 16 | `--source` 校验是不是 skill 目录 | 已修 | `src/skill.ts:692-695`；单测 `tests/skill.test.ts:303-308`；CLI 实测见第 2 条。 |
| 17 | 用户拒绝重指 canonical 后不建任何宿主链 | 已修 | `src/skill.ts:782-805` 拒绝时 `canonicalReady=false`；`src/skill.ts:892` 打印 `skip host links`，`:895` 与 `:970` 两处 `break`。单测 `tests/skill.test.ts:384-401` 断言出现 `skip     host links`。⚠️ 该测试的读链断言分辨不了「没动」和「重指后又改回」，但 `skip host links` 行是有效守卫（见 P3-5）。 |
| 18 | 非交互且无 `--yes` 在动手前拒绝（码 2，磁盘零改动） | 已修 | `src/skill-cmd.ts:190-199` 在调用 install/remove 之前拦截。实测 `HOME=$D tsx src/server.ts skill install`（stdin 非 TTY）⇒ `not a TTY — refusing to install without --yes`，exit 2，`$D/.agents` 不存在。单测：`tests/skill-cli.test.ts:99-122`。 |

## 第二部分：新发现的缺陷

严重度沿用任务口径：**P0** 会破坏用户数据 / 装出坏状态 / 静默失败 / 让已有测试变红；**P1** 与 spec/文档矛盾
或常见路径出错；**P2** 边界条件出错或错误信息误导；**P3** 风格、重复代码、测试缺口、文档措辞。

### P1-1 默认不链宿主上的「过期链」永远不会被 `install` 重指

**现象**：codex/opencode 目录里若已有一条指向别处的 `agent-ex-dispatch` 链，`install` 只打印
`note Codex is not linked by default ...`，不检查该链、不重指；`status` 持续告警，`doctor` 给出的修法
（`agent-ex skill install (it will ask whether to repoint them)`）**执行后仍然无效**。

**复现**（隔离 HOME，先正常装好 canonical，再放一条 codex 旧链）：

```bash
D=$(mktemp -d)
HOME="$D" npx tsx src/server.ts skill install --yes
mkdir -p "$D/.codex/skills" "$D/otherdir"; echo x > "$D/otherdir/SKILL.md"
ln -s "$D/otherdir" "$D/.codex/skills/agent-ex-dispatch"
HOME="$D" npx tsx src/server.ts skill install --yes      # → note Codex is not linked by default
readlink "$D/.codex/skills/agent-ex-dispatch"            # → 仍是 $D/otherdir
HOME="$D" npx tsx src/server.ts skill status | grep -i codex   # → ! ... (not the canonical copy)
HOME="$D" npx tsx src/server.ts doctor                   # → → agent-ex skill install (it will ask ...)
```

实测输出：

```
! /var/.../.codex/skills/agent-ex-dispatch -> /private/var/.../otherdir  (not the canonical copy)
! Some hosts link the dispatch skill to a different location
    → agent-ex skill install (it will ask whether to repoint them)
note Codex is not linked by default (use --target /var/.../.codex/skills if that host reads its own skills dir)
```

**原因**：`src/skill.ts:902-907` 在 `inspectTarget()` **之前**就对 `linkByDefault === false` 的宿主
`continue`，于是 `:916-931` 的「重指」分支和 `:939-943` 的「修复断链」分支对它们永远不可达。
而 spec §4.4 的「默认不链」只限定**没有链**的情形；「已有一条指向别处的链 ⇒ 必须重指」是独立一条，
且明确写了「即便该宿主有自动桥接机制，也必须重指」。

**为什么算缺陷**：这是 spec 明文要求的行为；且 `collectSkillIssues`（`src/skill.ts:515-528`）**没有**
过滤 `linkByDefault === false`，所以 doctor 主动把这些链报成 warn 并给出一个不成立的修法 —— 用户会陷在
「告警 → 按提示修 → 还在告警」的循环里。唯一出路是 `--target <dir>`（实测可修，但这层信息没写进任何提示）。

**建议**：把 `linkByDefault === false` 的跳过移到「条目缺失」分支（即 `:946-952` 之后），
已有 `link`/`broken-link` 仍走重指/修复；或者反过来，在 `collectSkillIssues` 里也排除它们，并同步 spec/README。
二选一，别像现在这样两处口径相反。补一条回归测试（default-off 宿主 + 过期链）。

### P1-2 `--link --source <canonical 自己>` 静默装出自指断链并返回 0

**现象**：`skill install --link --source ~/.agents/skills/agent-ex-dispatch` 会把 canonical 删掉，
再在原位建一条指向它自己的软链；命令打印 `linked ...`、退出码 0，但该路径已不可读（自指循环）。

**复现**：

```bash
D=$(mktemp -d)
HOME="$D" npx tsx src/server.ts skill install --yes
C="$D/.agents/skills/agent-ex-dispatch"
HOME="$D" npx tsx src/server.ts skill install --link --source "$C" --yes
# → linked   .../.agents/skills/agent-ex-dispatch -> .../.agents/skills/agent-ex-dispatch
# → exit 0
ls -ld "$C"                       # → lrwxr-xr-x ... agent-ex-dispatch -> .../agent-ex-dispatch
[ -e "$C/SKILL.md" ] || echo BROKEN   # → BROKEN
```

**原因**：`src/skill.ts:681-710` 只对 `--target` 做了自链检查（`:702-710`），`--source` 只校验
「存在 / 有 SKILL.md」；随后 `managed-copy`（`:813-817`）或 `adoptable`（`:857-861`）在 `--link` 模式下
先 `rmSync(canonical)` 再 `linkHost(dirname(canonical), source)`，而 `source` 正是 canonical 本身。
用 canonical 的别名/软链路径传入同样命中（比较的是字符串，不是 realpath）。

**为什么算缺陷**：这是「装出坏状态 + 静默返回 0」，也是 `--target` 已有防御的同类问题在 `--source` 上的漏网；
按「静默装出坏状态」口径可以记 P0，但触发需要显式把 `--source` 指向 canonical，故列 P1。

**建议**：在写盘前加与 `--target` 对称的检查：`realOrSelf(source) === realOrSelf(canonical)` ⇒
`refusing to link it to itself`；补一条测试（直接传 canonical + 传别名各一）。

### P2-1 `copyAtomically` 在 `rename(canonical, old)` 失败时泄漏 `.tmp.<pid>`

**现象**：`cpSync` 成功后，若把旧 canonical 移走这一步失败（例如 canonical 被 `chflags uchg`），
函数抛出原始错误，但临时副本留在父目录里；canonical 本身保持完好。下次运行是**另一个 pid**，
`copyAtomically` 只清理自己 pid 的 `.tmp`，旧残留**永远清不掉**。

**复现**：

```bash
D=$(mktemp -d); HOME="$D" npx tsx src/server.ts skill install --yes
C="$D/.agents/skills/agent-ex-dispatch"
echo "hand edited" >> "$C/SKILL.md"
chflags uchg "$C"
HOME="$D" npx tsx src/server.ts skill install --yes; echo "exit=$?"
ls -a "$D/.agents/skills"      # → .  ..  .agent-ex-dispatch  .agent-ex-dispatch.tmp.176
chflags nouchg "$C"
```

实测：`✗ install ...: EPERM ...`，exit 1，目录里残留 `.agent-ex-dispatch.tmp.<pid>`。

**原因**：`src/skill.ts:612-653` 只在 `cpSync` 失败的分支里 `rmSync(tmp)`（`:620-622`）；
`:628-629` 的 `renameSync(canonical, old)` 若抛错，没有 `finally`/`catch` 清理 tmp（旧代码的 `finally` 在本次修复中被删掉了）。

**建议**：把「cpSync + 两次 rename」整体包进 `try/catch`，`catch` 里无条件 `rmSync(tmp, {force:true})`；
成功路径保持今天的「先备份、失败回滚、回滚失败留 old」语义。补一条失败路径测试
（chmod/chflags 或用可注入的 fs）。

### P2-2 link 路线切换「先删 canonical 再建链」，建链失败即永久丢失安装

**位置**：`src/skill.ts:813-817`（`managed-copy`）与 `:857-861`（`adoptable`）：
`rmSync(canonical, {recursive:true,force:true})` 之后才 `linkHost(...)`。

若 `symlinkSync` 失败（父目录不可写、文件系统不支持软链、并发占位等），canonical 已经没了，
`attempt` 只把错误记进 `errors`，**没有备份可回滚**——而 copy 路线恰恰修好了这一点（`copyAtomically` 留 `.old`）。
这与本次修复的「不能删唯一备份」精神相悖。

**说明**：本条是**代码推理**，未在 APFS 上复现出「rm 成功但 symlink 失败」的窗口。

**建议**：先在临时名建链，成功后原子 `rename` 覆盖 canonical；失败则保留原目录。
或建链前把 canonical 重命名为 `.old.<pid>`，成功后删除，失败回滚。

### P2-3 库 API 的默认 `confirm` 是「放行」而不是「询问」，`removeSkill` 的 JSDoc 与实际相反

**现象**：

- `removeSkill({userHome, source})`（不传 `yes`/`confirm`）会**直接删除** canonical 和所有宿主链，
  而 `RemoveOptions.yes` 的注释写的是「跳过确认（一律执行）。默认 false」——读者会以为 false 会先问。
- `installSkill({userHome, source})` 在 canonical 是 `link-elsewhere` 时会**静默重指**（默认问题答案是 yes）。

**复现**（tsx eval，两个都在隔离临时目录里跑）：

```ts
// removeSkill：删掉后 canonical 不存在
await removeSkill({ userHome: home, source: src });
// installSkill：link-elsewhere 被替换成 copy
const r = await installSkill({ userHome: home, source: src });
// → ok true, "installed ... (copy of v0.3.2, replaced the old link)"
```

**原因**：`src/skill.ts:685` 与 `:1016` 的默认实现是 `(async (_q, def) => (yes ? true : def))`；
`removeSkill` 用 `def = true` 调 `confirm`（`:1022-1027`），所以 `yes` 缺省时等同于「同意」。
CLI 侧安全，因为 `src/skill-cmd.ts` 总是注入带 TTY 检查的 `confirm`；问题只出在程序化调用。

**建议**：默认 `confirm` 改为「没有显式 `yes` 就不执行破坏性动作」（返回 false / 直接 abort），
或至少把 `RemoveOptions` 的注释改成「false 时按默认值（=执行）」。

### P3-1 `doctor` 早退的 summary 已与事实不符

`src/doctor.ts:350` 仍返回 `config.json is unusable — the rest could not be checked`，但 skill 段
（`src/doctor.ts:324-338`）已经在早退**之前**跑完并打印。实测（坏 config + skill 告警）输出：

```
config.json is unusable — the rest could not be checked

✗ config.json is unusable
! Some hosts link the dispatch skill to a different location   ← 明明检查了
✓ Dispatch skill is installed and up to date
```

建议改成 `config-dependent checks were skipped` 之类。

### P3-2 spec / plan 里 `--yes` 的旧语义还在

- `docs/designs/2026-11-10-skill-distribution.md` §4.1（约 193 行）：`--yes 跳过所有询问，给所有探测到的宿主建链`。
- `docs/plans/2026-11-10-skill-distribution-implementation-plan.md:279` 同样表述。

实现与 §4.1 下方「补充三条」已经是「`--yes` 不给默认不链的宿主建链」。同一份 spec 自相矛盾。
建议把 usage 行改成「跳过所有询问（默认不链的宿主仍需 `--target`）」。

### P3-3 `doctor` 不报「断掉的宿主链」，只有 `status` 报

`collectSkillIssues` 只收集 `kind === "link"` 且目标不等于 canonical 的「指向别处」（`src/skill.ts:515-517`），
以及 `kind === "missing"` 的「漏链」（`:530-537`）；`broken-link` 两边都不落。`status` 会标黄，doctor 静默。
实测：把宿主链改成悬空 symlink 后，`status` 显示 `!`，`doctor` 只有「已安装」绿条。
建议把 `broken-link` 并入 `mislinked` 或新增 `skill.host-link-broken`。

### P3-4 `remove` 在 canonical 本就不存在时仍报「kept … deleting it now would leave them dangling」

**复现**：canonical 不存在，宿主目录里有一条链且目录被 chmod 555 导致 unlink 失败：

```
kept     .../.agents/skills/agent-ex-dispatch (some host links could not be removed — deleting it now would leave them dangling)
! left in place: .../.agents/skills/agent-ex-dispatch
✗ .../.claude/skills/agent-ex-dispatch: EACCES ...
exit=1
```

退出码正确（确实有东西没删掉），但「kept」和「left in place」指向一个从未存在的路径，措辞误导。
建议先 `inspectCanonical`，仅在它存在时才说「kept」。

### P3-5 测试缺口 / 脆弱点

- **没有** `copyAtomically` 失败/回滚路径的测试 —— 这恰是本次最高风险的一处修复（第 1 条）。
- **没有** autoBridge 查 `.reserved-skill-names` 的测试（`grep -rn reserved tests` 无结果）。
- `tests/skill-cli.test.ts:77-91` 的 `--target` 用例只删了 `work`，`runSkillCli` 建出的临时 `r.home` 未清理（泄漏）。
- `tests/skill.test.ts:317-328` 的「相对 source」依赖 cwd == 仓库根；换目录跑会红。
- P2-3 的库默认 `confirm` 行为（不传 `confirm` 的破坏性默认）无测试。
- `pointsAtCanonical` 没有直接单测（只被 install/status 间接覆盖）。

### P3-6 spec §4.6 的 `status` 样例含体积，实现只打印 sha

`docs/designs/2026-11-10-skill-distribution.md:338` 样例是 `(v0.3.2, 132 KB, sha a1b2c3d4e5f6)`，
实现只打印 `(vX, sha ...)`。属预存在的不一致，建议要么补体积、要么改样例。

### P3-7 `src/skill-cmd.ts:236` 的 re-export 无人使用

`export { collectSkillIssues, canonicalPath };` 在文件末尾；`src/` 与 `tests/` 里没有从这个模块 import
这两个符号的调用方（都直接从 `./skill` / `../src/skill` 取）。删掉即可。

### P3-8 README 对 `--yes` 的描述略过头

`README.md`「可选：安装 dispatch skill」末尾写「`--yes` 会建链、会重指、会覆盖」，但按第 10 条修复，
`--yes` **不会**给 codex/opencode 建链。建议补一句「默认不链的宿主仍需 `--target`」。
同节「自动桥接的宿主不建链」也应说明「但已有旧链时仍会重指」（spec §4.4 的要求）。

## 我没能验证的部分

- **152 KB 基线**：本轮只对当前工作区 `npm pack` 得到 219,577 B；没有 checkout 到 `882f88a` 之前的提交
  重新打包，所以「41%」是按 (215-152)/152 推算的，基线本身未复验。
- **全量 `npm test` 的绝对绿色**：本机 `tests/init-e2e.test.ts > yes/no 型提问用 (y/N)` 失败；
  该用例单独跑也失败，且 `4cc84de` 未改 `src/init.ts`，判断为预存在/环境问题，但需要看 CI 的权威结果。
- **P2-2 的数据丢失窗口**：APFS 上无法稳定制造「`rmSync` 成功、`symlinkSync` 失败」，仅有代码推理。
- **真实宿主行为**：Claude Code / Trae / WorkBuddy / Codex / OpenCode 是否真的读取 `~/.agents/skills`
  或各自的 skills 目录，只用假目录验证了路径与链接逻辑，没有在真实宿主里确认加载效果。
- **Windows**：软链需要额外权限，未在 Windows 上运行。
- **`--source` 相对路径解析基准**：实现按 **cwd** 解析显式相对路径（默认 bundled 才按模块位置）。
  测试依赖 cwd==仓库根；是否要把「显式相对路径也按某个固定基准」写进 README，未定，未验证。

---

## 附：修复状态（2026-11-10，维护者回填）

本报告的 P1/P2/P3 已逐条处理（commit 见 `git log --oneline feat/skill-distribution`）。
处理方式与取舍：

| 编号 | 处理 | 说明 |
|---|---|---|
| P1-1 | 已修 | 「默认不链」只管**没有条目**的情形；已有旧链（link / broken-link）一律重指。选了报告给的第一种方案（`collectSkillIssues` 继续报这些链），因为告警必须配一个有效的修法。 |
| P1-2 | 已修 | 加了与 `--target` 对称的 `--source` 自链检查（等于 canonical / 别名路径 / canonical 的子目录都拒），并把检查排在 SKILL.md 校验之前。开发者路线（canonical 是软链、source 是它的目标）不受影响。 |
| P2-1 | 已修 | `copyAtomically` 泛化成 `replaceAtomically(canonical, build)`：临时名上做好新内容再换位，任何失败路径都清 tmp。 |
| P2-2 | 已修 | 切成软链改走 `linkAtomically`（先建好新链再换位），不再"先删 canonical 再建链"。 |
| P2-3 | 已修 | 库 API 的默认 `confirm` 改为**拒绝执行并抛错**（`yes` 缺省且没注入 confirm 时）。CLI 层行为不变（总是注入带 TTY 检查的 confirm）。 |
| P3-1 | 已修 | 早退 summary 改成 "config-dependent checks were skipped"。 |
| P3-2 | 已修 | spec §4.1 与 plan 的 `--yes` 表述改成「跳过所有询问（默认不链的宿主仍需 --target）」。 |
| P3-3 | 已修 | `broken-link` 并入 `skill.host-link-elsewhere` 体检项。 |
| P3-4 | 已修 | canonical 不存在时不再报 "kept"。 |
| P3-5 | 已修 | 补了 copyAtomically 失败路径、reserved/excluded 表、`pointsAtCanonical`、库默认 confirm 的测试；CLI 测试的临时 HOME 泄漏与"相对 source 依赖 cwd == 仓库根"也一并修了。 |
| P3-6 | 已修 | spec §4.6 的样例改成与实现一致（不打印体积），并补了"链到别处"的样例。 |
| P3-7 | 已修 | 删掉 `skill-cmd.ts` 里没人用的 re-export。 |
| P3-8 | 已修 | README 补了 `--yes` 的准确语义与"旧链照样重指"。 |

**报告里没能验证、也仍未验证的部分**（本轮同样没解决）：

- 「152 KB 基线」未重新打包复验（41% 仍是按 (215-152)/152 推算）。
- `replaceAtomically` 的「旧副本挪得开、但新内容换不上去」那个回滚失败分支（old 留在原处并报错）
  仍只有代码推理、没有可复现的用例 —— APFS 上稳定造不出这个窗口。
- 真实宿主是否真的读 `~/.agents/skills` / 各自的 skills 目录，没在真实宿主里验证过。
- 报告提到本机 `tests/init-e2e.test.ts` 有一条失败：维护者复跑（单独跑 + 全量跑）**均通过**，
  判断是该用例猴补丁 `process.stdout.write` 造成的既有偶发，与本次改动无关；未深究。
