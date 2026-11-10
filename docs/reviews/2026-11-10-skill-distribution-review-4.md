# 第四轮评审：skill 分发与子命令（4b9cf31）

> 评审对象：`4b9cf31 fix(skill): close the third-round review findings`
> 分支：`feat/skill-distribution`；spec：`docs/designs/2026-11-10-skill-distribution.md`
> 前序：`2026-11-10-skill-distribution-fix-review.md`（第一轮）、`2026-11-10-skill-distribution-review-3.md`（第三轮）
> 方法：逐条核对本轮四处修复 + 全新缺陷 hunting；所有结论都带实测命令/输出或精确 file:line。
> 实测环境：macOS / Node（本机），CLI 实测一律 `HOME=$(mktemp -d)` 隔离。

## 结论

`4b9cf31` 的四处主修复**方向都对、主路径都能复现为已修**（断链 canonical 可装、宿主链原子换位、`--target` 指进 canonical 被拒、备份清理失败不再算安装失败），`npm run typecheck` 通过。
但本轮又发现 **1 条 P1 + 2 条 P2**，其中 P1 是同一类"静默装出自指环"的**漏杀**（`--source` 走 canonical 内部的路径 + `--link`），与 spec §4.3 明文矛盾；另有 8 条 P3（含测试假通过、死导出、`remove` 残留与 README 承诺不一致）。

**建议：先别发版** —— 把 P1、两条 P2 修掉（都是一两处判定的问题），P3 至少修掉"测试假通过"与脚本空段回归。

**必须修（发版前）**：P1（`selfLinkReason` 漏杀）、P2-a（`--target` 别名绕过）、P2-b（脚本空段回归）。
**建议同时修**：P3 的"status 断链不标"、"宿主链原子测试假通过"、"`remove` 不报 `.old` 残留 vs README 承诺"。

## 第一部分：4b9cf31 四处修复的核对

| 项 | 结论 | 证据 |
|---|---|---|
| ① 占位探测改用 `lstat`（`pathOccupied`） | **已修**（主路径实测） | `src/skill.ts:325-332` 用 `lstatSync`；`:745` `hadOld = pathOccupied(canonical)`。实测：`ln -s $D/gone-target $D/.agents/skills/agent-ex-dispatch` 后 `HOME=$D npx tsx src/server.ts skill install --yes` ⇒ `installed … (copy of v0.3.2, replaced the old link)`，exit 0，目录里只剩实体拷贝；`install --link` 同链路也 exit 0 且 `readlink` 正确。旧的悬空链被挪成 `.old.<pid>` 后随成功路径删除（断链无数据，删掉正确；不存在"该留"的语义）。未发现 `pathOccupied` 带来的新误判：`replaceAtomically` 只在 missing / link / managed-copy / adoptable 四态被调用，`foreign-dir`（含普通文件）在 `:1045-1051` 提前中止，不会被 rename 挪走。 |
| ② 宿主链也走 `replaceAtomically` | **已修**（成功路径实测；失败路径无测试，见 P3-b） | 重指 `:1089`、断链修复 `:1104`、显式 `--target` 建链 `:1156` 都改成 `replaceAtomically(linkPath, tmp => symlinkSync(...))`。实测：codex/claude 目录先放旧链，`install --yes` ⇒ `repointed …`，`readlink` 已指 canonical，宿主目录 `ls -la` 无 `.tmp.*`/`.old.*`；旧链目标目录内容仍在（`rename` 搬的是链接本身；`rmSync(old,{recursive:true})` 不跟随软链——另用 `node -e` 单独验证：删链后 `target/data.txt` 仍在）。⚠️ 固定临时名落在宿主 skills 目录（`.agent-ex-dispatch.tmp.<pid>` / `.old.<pid>`）本身是隐藏文件，只在建链/失败的瞬间存在；成功路径立即删除，没有实测到宿主扫描到它，但这是新增的可见面（P3-c）。 |
| ③ `--target` 落进 canonical 的拦截 | **已修**（主路径实测）；但有一条**漏网**（见 P2-b） | `src/skill.ts:342-351` 先按路径 `isInside(linkPath, canonical)`、再按 `realpath(dirname(linkPath))` vs `realpath(canonical)`。实测：① `--target <canonical>/inner` ⇒ `✗ … would put a link inside the canonical location …`，exit 1，未建链；② 开发者路线（canonical 是软链、target=`<source>/references`）⇒ 同样拒绝；③ **误杀核对：合法的兄弟目录放行** —— `--target $D/.agents/skills/other-host` ⇒ 正常 `linked …/other-host/agent-ex-dispatch -> canonical`，exit 0。 |
| ④ `rmSync(old)` 失败不再算安装失败 | **已修**（实测复现） | `src/skill.ts:780-784` 把清理包进 `try/catch{}`。实测制造清理失败：装好后改 `SKILL.md` → `chflags uchg SKILL.md` → 再 `install --yes` ⇒ `restored … (replaced the modified copy with v0.3.2)`，**exit 0**，同时 `~/.agents/skills` 里留下 `.agent-ex-dispatch.old.<pid>`。后续 `remove --yes` 仍 exit 0，但既不删也不报这份 `.old`（见 P3-d）。 |

小结：**四条声称修复全部真实落地**，无"声称修了其实没修"。但 ③ 的判定在"canonical 尚不存在 + 路径别名"时可被绕过，且 `--source` 侧的"在 canonical 里面"判定仍不完整（P1/P2）。

## 第二部分：新发现的缺陷

### P0

无。

### P1

- **`selfLinkReason` 对"source 在 canonical 里面"的判定只用了字面路径（`isInside`）/ 对软链 canonical 直接放行 ⇒ 仍能静默装出自指环并返回 0** — `src/skill.ts:375-381`

  机制：真正落盘的是 `linkAtomically(canonical, source)`（`:959` / `:986` / `:1027`），它把 `source` **原样**写进软链字面 target（`:794`）。只要 `source` 的字面路径**穿过 canonical**（或穿过一个指向 canonical 内部的软链），换位后 canonical 就变成指向"自己子树"的链 ⇒ `ELOOP`；而 `selfLinkReason` 在 canonical 是软链时 `if (isSymlinkPath(canonical)) return null;`（`:377`）直接放行，在 canonical 是实体目录时 `isInside` 只做字面比较（`:379`，不 realpath），两处都漏。

  复现 A（canonical 是开发者路线的软链；source 走 canonical 的子目录）：
  ```bash
  D=$(mktemp -d); R=$D/repo-skill; mkdir -p $R/sub
  printf -- '---\nname: x\n---\n' | tee $R/SKILL.md > $R/sub/SKILL.md
  mkdir -p $D/.agents/skills; ln -s $R $D/.agents/skills/agent-ex-dispatch
  HOME=$D npx tsx src/server.ts skill install --link \
    --source $D/.agents/skills/agent-ex-dispatch/sub --yes; echo "exit=$?"
  readlink $D/.agents/skills/agent-ex-dispatch
  cat $D/.agents/skills/agent-ex-dispatch/SKILL.md
  ```
  实际输出：`linked … -> …/agent-ex-dispatch/sub`，**exit=0**；随后读 `SKILL.md` 得到
  `Too many levels of symbolic links`。

  复现 B（用户路线：canonical 是实体拷贝；source 是一个**指向 canonical 内部的软链**）：
  ```bash
  D=$(mktemp -d); HOME=$D npx tsx src/server.ts skill install --yes >/dev/null
  C=$D/.agents/skills/agent-ex-dispatch; mkdir -p $C/sub
  printf -- '---\nname: x\n---\n' > $C/sub/SKILL.md; ln -s $C/sub $D/alias
  HOME=$D npx tsx src/server.ts skill install --link --source $D/alias --yes; echo "exit=$?"
  readlink $C; cat $C/SKILL.md
  ```
  实际输出：`linked … -> …/alias`，**exit=0**；`cat` 同样 `Too many levels of symbolic links`。

  为什么算缺陷：spec §4.3（`docs/designs/2026-11-10-skill-distribution.md:281-283`）明文
  「`source` 等于 canonical（哪怕是别名路径）**或在 canonical 里面，一律拒绝**」；这里 source
  的**真实位置**就在 canonical 里面，却被放行，并装出"canonical 不可读却返回 0"的坏状态
  （与第二轮 P1-2、第三轮 P1-a 同一类）。可达性依赖调用方显式给一个带 `SKILL.md` 的子目录/软链
  （真实 bundled skill 的 `references/` 没有 `SKILL.md`，故默认 source 不会命中），但修复思路要对称：
  建议把 `selfLinkReason` 的包含判定改成 **realpath 比 realpath**：
  - canonical 是软链时：`realOrSelf(source)` **严格在** `realOrSelf(canonical)` 里面 ⇒ 拒绝（等于放行，那是合法开发者路线）；
  - canonical 是实体目录时：`isInside(realOrSelf(source), realOrSelf(canonical))`（现在只用字面 `isInside`）。
  或者更简单：建链前把 `source` 统一 `realpathSync` 再写进软链（repro A 里 `canonical/sub` 的真实路径仍落在 canonical 内，故仍需上面的包含判定）。
  补两条回归测试（repro A / B）。

### P2

- **`--target` = canonical 的别名路径、且 canonical 尚不存在时，`samePath` / `realOrSelf` 对"不存在路径"退化成字面比较 ⇒ 绕过 `isSame`/`inside` 拦截，在 canonical 内部建出自指环，exit 0** — `src/skill.ts:342-351, 865`

  机制：`linkPathInsideCanonical` 的 realpath 归一在路径**不存在**时 `realOrSelf` 退回 `resolve()`（`:276-282`），
  而校验发生在安装**之前**。若 `$HOME` 本身经别名访问（macOS 典型：`/var/...` vs `/private/var/...`），
  canonical 的字面路径与用户传入的 `--target`（同一目录的另一写法）在 realpath 层面相等，但两条路径当时都不存在 ⇒
  `samePath(dir, canonical)`（`:865`）和 `linkPathInsideCanonical` 都判 false。

  复现（隔离 HOME，canonical 不存在）：
  ```bash
  D=$(mktemp -d); P=$(cd "$D" && pwd -P)     # HOME=$D 是 /var/...，P 是 /private/var/...
  HOME=$D npx tsx src/server.ts skill install \
    --target "$P/.agents/skills/agent-ex-dispatch" --yes; echo "exit=$?"
  ls -la "$D/.agents/skills/agent-ex-dispatch"
  ```
  实际输出（exit=0）：
  ```
  installed /var/.../.agents/skills/agent-ex-dispatch (copy of v0.3.2)
  linked    /private/.../.agents/skills/agent-ex-dispatch/agent-ex-dispatch -> /var/.../.agents/skills/agent-ex-dispatch
  ```
  canonical 目录里出现 `agent-ex-dispatch -> <canonical 自己>` 的环；`hashDir` 跳过软链 ⇒ status/doctor 不会报。
  这与第三轮 P2-a 要防的"装好的 skill 目录里建出指向自己祖先的环"完全同型，只是走别名 + canonical 不存在的时间窗。
  建议：把 `canonical` 与 `dir` 都按"最近的存在祖先"做 realpath 归一后再比较（或先对 canonical 的父目录做 `realpathSync`，再拼 `SKILL_NAME`），别让"不存在"退化成字面比较。补一条别名 HOME 的回归测试。
  （同一根因的另一个更良性表现：`--target` 传 canonical 父目录的别名时不会被 `dir === dirname(canonical)` 挡住，但最终落到 canonical 本体 ⇒ 被 `dir/file` 分支跳过，无坏状态。）

- **`scripts/install-skill.sh` 的"相对路径按 `$HOME` 展开"跑在空段判断之前 ⇒ env 里的空段（`":"`、`"a::b"`、结尾 `:`）不再是空段，而被展开成 `$HOME/`，会在用户 HOME 下建出 `agent-ex-dispatch` 链** — `scripts/install-skill.sh:44-57`

  机制：`:44-52` 先 `case "$t" in /*) ;; *) t="$HOME/$t";; esac`，**之后**才 `[ -n "$t" ] || continue`。
  空串不匹配 `/*` ⇒ 变成 `"$HOME/"`（非空）⇒ 被保留。第三轮 P3-c 修复前，空段是先 `continue` 掉的。
  脚本头注释（`:36-40`）与第三轮报告都声明"空段会被丢掉"，现在是假的。

  复现（隔离 HOME；脚本是开发者路线入口，不入 npm 包，但本仓库开发者会用）：
  ```bash
  D=$(mktemp -d); HOME=$D AGENT_EX_SKILL_TARGETS=":" /bin/bash scripts/install-skill.sh; echo "exit=$?"
  ls -la $D
  ```
  实际输出：不再报 `ERROR: no target directory`、**exit=0**，并且真的建了：
  ```
  Extra targets:
    - /var/.../<tmp>/                      ← 空段变成了 $HOME/
  linked   /var/.../<tmp>/.agents/skills/agent-ex-dispatch -> /Users/.../skills/agent-ex-dispatch
  linked   /var/.../<tmp>/agent-ex-dispatch -> /var/.../<tmp>/.agents/skills/agent-ex-dispatch   ← 落在 HOME 根
  ```
  建议：把空段判断放到 `~`/相对展开**之前**（先 `[ -n "$t" ] || continue`，再展开），并把 `~user`（当前 `t="${t/#\~/$HOME}"` 只认裸 `~`）顺带说明为不支持。补一条 `AGENT_EX_SKILL_TARGETS="a::b"` 的测试（现在没有脚本级测试）。

### P3

- **`status` 对"断链的 canonical"仍只打印 `[link -> …]`，不标 broken（第三轮 P1-a 的附带项，未修）** — `src/skill-cmd.ts:129-139`
  实测：canonical 为悬空软链时 `HOME=$D npx tsx src/server.ts skill status` 输出
  `canonical …/agent-ex-dispatch  [link -> …/gone-target]`，无任何 broken/警告标记；而宿主链断链是有 `! broken link` 的（`:164-165`）。
  建议给 `CanonicalInfo` 加 `broken?: boolean` 或在 `printStatus` 里 `c.target && !existsSync(c.target)` 时标黄。

- **宿主链原子替换的回归测试只验证成功路径，"旧的链在换位成功前一直在"这句没有被测试证明** — `tests/skill.test.ts:595-607`
  该用例只断言重指后 `readlink` 正确、目录里无点文件；没有任何失败注入去证明"symlinkSync/rename 失败时旧链仍在"。这是测试名/注释**超出实际断言**（假通过的典型）。建议用只读父目录或可注入 fs 让 `rename(tmp, linkPath)` 失败，断言旧 `readlink` 仍在。

- **`replaceAtomically` 的临时名/备份名带 pid，且现在也被宿主链复用 ⇒ 宿主 skills 目录里会出现隐藏的 `.agent-ex-dispatch.tmp.<pid>` / `.old.<pid>`** — `src/skill.ts:732-733`
  成功路径会立即删掉；但"清理失败被容忍"（`:780-784`）或进程被杀时，宿主目录会留下隐藏文件/目录。真实宿主是否会把 `.` 开头的条目当 skill 扫描**未验证**；按现有约定（dotfile）大概率忽略。建议在 spec 的"已知限制"里补一句"宿主目录同样可能有这份残留"，或把宿主链的临时名做成不带 skill 名的随机名以降低被扫到的概率（代价：并发隔离仍成立）。

- **`remove` 既不删也不报 `.old.<pid>` 残留，与 README/spec 的"只要还有东西留在原地，退出码就是非 0"字面冲突** — `src/skill.ts:1211-1267`、`README.md:432`、spec §4.1 补充三条
  实测（见第一部分 ④）：`install` 因 `rmSync(old)` 失败留下 `.agent-ex-dispatch.old.<pid>` 后，`remove --yes` 输出 `removed … (installed copy)`、**exit 0**，`~/.agents/skills` 里仍有那份 `.old`。
  `.old` 是内部备份而非用户数据，可以不算"失败"；但按 README 字面"只要还有东西留在原地"就是非 0。要么让 `remove` 顺手清掉本工具命名的 `.tmp.*`/`.old.*`（可只清非当前 pid 的、或按前缀清），要么把文档改成"不包含 agent-ex 自己的备份残留"。

- **`USAGE` 对所有子命令无条件列出 `--target` / `--link`，与 spec §4.1 的"status 不接受 `--target`"以及新的 status 拒绝逻辑自相矛盾** — `src/skill-cmd.ts:29-38, 190-193`
  实测 `agent-ex skill status --target /tmp` 的报错后紧跟的 usage 仍写 `--target <dir> extra host directory to link into`；`status --link` 也被静默接受（spec 只允许 `status [--source <dir>]`）。建议把 usage 按子命令拆开，或在该行标注 `(install/remove only)`；顺手把 `status --link` 也拒绝。

- **`sourceWouldSelfLink` 已成死导出** — `src/skill.ts:362-364`
  `grep -rn sourceWouldSelfLink src/ tests/` 只有定义处；调用点已改为 `selfLinkReason`（`:844`）。`ba079d8` 刚清掉 `linkHost` 死代码，这里又留下一个。要么删掉，要么让测试直接测它（目前没有测试 import 它）。

- **脚本的相对 target 与 CLI 的相对 target 语义不一致，且没有任何文档说明** — `scripts/install-skill.sh:41-49` vs `src/skill.ts:864`
  脚本按 `$HOME` 解析相对路径，CLI 按 cwd 解析。第三轮 P3-c 的动机（脚本常在仓库根跑）成立，但这是两个入口的可观察差异；脚本头注释只对维护者可见。建议在 README 的"开发者路线"里补一句"脚本里相对路径按 `$HOME` 解析"，或让脚本对相对路径直接报错要求写绝对路径（更省心）。

- **新测试未覆盖 `rmSync(old)` 失败被容忍这条修复** — `tests/skill.test.ts:564-685`
  该修复只用代码阅读/本轮手工 `chflags uchg` 验证过（见第一部分 ④），测试套件里没有守卫。建议补一条"清理失败 ⇒ ok=true 且 canonical 内容已是新版"的用例（可用 `chflags`，或用可控的 fs 注入）。

## 我没能验证的部分

- **宿主真实加载行为**：Claude Code / WorkBuddy / Trae / Codex / OpenCode 是否真的会扫描 `~/.claude/skills` 等目录、是否会把 `.` 开头的临时条目当 skill —— 仍只用假目录验证了链接逻辑，没在真实宿主里确认。
- **`.tmp`/`.old` 的宿主扫描面**（P3-c）：没有真实宿主可测，只能按"dotfile 通常被忽略"推断。
- **`rename(tmp, linkPath)` 失败 → 回滚** 的宿主链分支：APFS 上没构造出"第一次 rename 成功、第二次失败"的稳定窗口（宿主链这条线本轮只验证了成功路径），只有代码核对。
- **Windows**（软链权限）未测。
- **`bash 3.2` 空数组**：本机 `/bin/bash` 3.2.57 验证 `${#arr[@]}` 对空数组不报错（`len=0`，exit 0）；但空段回归后 `EXPANDED` 实际不再会为空，`:57` 的判空已成死分支。
- **全量 `npm test`**：本机 `506 passed / 1 failed`，唯一红是 `tests/init-e2e.test.ts > yes/no 型提问用 (y/N)`（预存在的 flaky，前两轮已记录，与 skill 无关）；提交信息写"507 tests pass"，与本地不一致（该用例单跑/全量都红）。`npm run typecheck` 通过。
- **152 KB 打包基线**沿袭前几轮，仍未重新 `npm pack` 复验。

---

## 附：修复状态（2026-11-10，维护者回填）

| 编号 | 处理 | 说明 |
|---|---|---|
| P1（`selfLinkReason` 漏杀 canonical 内部的 source） | 已修 | 包含判定改成**真实位置**（realpath）：source 的真实位置落在 canonical 真实位置里面 ⇒ 拒绝；开发者路线（canonical 是软链、source 就是它的目标）放行。补了复现 A / B 两条回归测试。 |
| P2-a（`--target` 别名路径绕过拦截） | 已修 | 路径比较统一走 `realish()`：把**最近的已存在祖先**做 realpath 再拼剩下的段 ⇒ 别名（`/var` vs `/private/var`）与不存在的路径都能归一。补了别名 HOME 的回归测试。 |
| P2-b（脚本空段被展开成 `$HOME/`） | 已修 | 空段判断挪到展开**之前**；补了两条脚本级测试（空段报错、相对路径按 `$HOME` 展开）。 |
| P3（status 不标断链 canonical） | 已修 | `CanonicalInfo.broken` + status 显示 `[broken link -> …]`。 |
| P3（宿主链原子替换测试只测成功路径 = 假通过） | 已修 | 补了失败路径：宿主目录不可写 ⇒ 换位失败 ⇒ **旧链还在**。 |
| P3（`remove` 不清 `.old.<pid>` 残留，与 README 冲突） | 已修 | 卸载时顺手清掉 agent-ex 自己的临时物（`.agent-ex-dispatch.tmp.*` / `.old.*`）。 |

**关于「507 tests pass」**：维护者本地全量跑是 507/0 全绿；评审机器上是 506/1，
唯一红的是**预存在**的 `tests/init-e2e.test.ts` flaky（该用例猴补丁 `process.stdout.write`，
并发写 stdout 时会偶发抓不到提示语），与本特性无关。
