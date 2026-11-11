/**
 * `agent-ex skill` 的纯逻辑层测试。
 *
 * ⚠️ **不依赖开发机装了什么**：所有路径都注入临时目录（userHome / source 都是 mkdtemp 的），
 * 提问用注入的 confirm 回调，不模拟 TTY。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
  rmSync,
  readlinkSync,
  chmodSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  MARKER_FILE,
  SKILL_HOSTS,
  canonicalPath,
  collectSkillIssues,
  currentVersion,
  findHost,
  hashDir,
  hostConfigRoot,
  hostDir,
  hostPresent,
  inspectCanonical,
  inspectTarget,
  installSkill,
  linkableHosts,
  pointsAtCanonical,
  readMarker,
  removeSkill,
  resolveAgentSelection,
  resolveBundledSkillDir,
  skillStatus,
  workBuddyBridges,
  writeMarker,
} from "../src/skill.js";

let root: string;
let userHome: string;
let source: string;

/** 造一份假的 skill 源目录。 */
function makeSource(dir: string, body = "v1"): string {
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: agent-ex-dispatch\ndescription: test\n---\n\n# body ${body}\n`,
  );
  writeFileSync(join(dir, "references", "x.md"), `ref ${body}\n`);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-ex-skill-"));
  userHome = join(root, "home");
  source = makeSource(join(root, "src-skill"));
  mkdirSync(userHome, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 收集提问，供断言"问了什么"。 */
function recorder(answers: boolean[] = []) {
  const asked: string[] = [];
  return {
    asked,
    confirm: async (q: string, def: boolean): Promise<boolean> => {
      asked.push(q);
      const a = answers.length > 0 ? (answers.shift() as boolean) : def;
      return a;
    },
  };
}

describe("resolveBundledSkillDir / currentVersion", () => {
  it("解析到本仓库的 skills/agent-ex-dispatch（源码模式）", () => {
    const dir = resolveBundledSkillDir();
    expect(dir.endsWith(join("skills", "agent-ex-dispatch"))).toBe(true);
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
  });

  it("currentVersion 等于 package.json 的 version", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(currentVersion()).toBe(pkg.version);
  });
});

describe("hashDir", () => {
  it("同一目录两次调用结果相同；改一个文件后结果不同", () => {
    const a = hashDir(source);
    expect(a).toBeTruthy();
    expect(hashDir(source)).toBe(a);
    writeFileSync(join(source, "SKILL.md"), "changed\n");
    expect(hashDir(source)).not.toBe(a);
  });

  it("排除 marker 自己（否则写完 marker 永远对不上）", () => {
    const before = hashDir(source)!;
    writeFileSync(join(source, MARKER_FILE), JSON.stringify({ x: 1 }));
    expect(hashDir(source)).toBe(before);
  });

  it("目录不存在返回 null", () => {
    expect(hashDir(join(root, "nope"))).toBeNull();
  });
});

describe("marker 读写", () => {
  it("往返一致", () => {
    writeMarker(source, { skill: "agent-ex-dispatch", version: "1.2.3", sha: "abc", source: "/x" });
    expect(readMarker(source)).toEqual({
      skill: "agent-ex-dispatch",
      version: "1.2.3",
      sha: "abc",
      source: "/x",
    });
  });

  it("marker 损坏 / 形状不对 ⇒ null，不抛", () => {
    writeFileSync(join(source, MARKER_FILE), "{not json");
    expect(readMarker(source)).toBeNull();
    writeFileSync(join(source, MARKER_FILE), JSON.stringify({ version: 1 }));
    expect(readMarker(source)).toBeNull();
  });

  it("目录不存在 ⇒ null", () => {
    expect(readMarker(join(root, "nope"))).toBeNull();
  });
});

describe("inspectCanonical —— 六态", () => {
  const canonical = () => canonicalPath(userHome);

  it("missing", () => {
    expect(inspectCanonical(canonical(), source).state).toBe("missing");
  });

  it("link-to-source", () => {
    mkdirSync(join(userHome, ".agents/skills"), { recursive: true });
    symlinkSync(source, canonical(), "dir");
    expect(inspectCanonical(canonical(), source).state).toBe("link-to-source");
  });

  it("link-elsewhere", () => {
    const other = makeSource(join(root, "other-skill"));
    mkdirSync(join(userHome, ".agents/skills"), { recursive: true });
    symlinkSync(other, canonical(), "dir");
    expect(inspectCanonical(canonical(), source).state).toBe("link-elsewhere");
  });

  it("managed-copy（marker 在、版本落后 ⇒ updateAvailable）", () => {
    mkdirSync(canonical(), { recursive: true });
    writeFileSync(join(canonical(), "SKILL.md"), "x\n");
    writeMarker(canonical(), {
      skill: "agent-ex-dispatch",
      version: "0.0.1",
      sha: hashDir(canonical())!,
      source,
    });
    const info = inspectCanonical(canonical(), source);
    expect(info.state).toBe("managed-copy");
    expect(info.updateAvailable).toBe(true);
    expect(info.modified).toBe(false);
  });

  it("managed-copy 且被手改 ⇒ modified", () => {
    mkdirSync(canonical(), { recursive: true });
    writeFileSync(join(canonical(), "SKILL.md"), "x\n");
    writeMarker(canonical(), {
      skill: "agent-ex-dispatch",
      version: currentVersion(),
      sha: "deadbeef0000",
      source,
    });
    expect(inspectCanonical(canonical(), source).modified).toBe(true);
  });

  it("adoptable（无 marker 但内容与 bundled 相同）", () => {
    const canonicalDir = canonical();
    mkdirSync(join(canonicalDir, "references"), { recursive: true });
    writeFileSync(join(canonicalDir, "SKILL.md"), readFileSync(join(source, "SKILL.md")));
    writeFileSync(join(canonicalDir, "references/x.md"), readFileSync(join(source, "references/x.md")));
    expect(inspectCanonical(canonicalDir, source).state).toBe("adoptable");
  });

  it("foreign-dir（无 marker 且内容不同）", () => {
    const canonicalDir = canonical();
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, "SKILL.md"), "something else\n");
    expect(inspectCanonical(canonicalDir, source).state).toBe("foreign-dir");
  });
});

describe("inspectTarget", () => {
  it("区分 link / dir / missing / broken-link", () => {
    const d = join(root, "targets");
    mkdirSync(d, { recursive: true });
    const link = join(d, "l");
    symlinkSync(join(root, "does-not-exist"), link);
    expect(inspectTarget(link).kind).toBe("broken-link");
    const real = join(d, "r");
    mkdirSync(real);
    expect(inspectTarget(real).kind).toBe("dir");
    expect(inspectTarget(join(d, "none")).kind).toBe("missing");
  });
});

describe("pointsAtCanonical", () => {
  it("同一条路径 ⇒ true；指向别处 ⇒ false；undefined ⇒ false", () => {
    const canonical = canonicalPath(userHome);
    expect(pointsAtCanonical(canonical, canonical)).toBe(true);
    expect(pointsAtCanonical(join(root, "elsewhere"), canonical)).toBe(false);
    expect(pointsAtCanonical(undefined, canonical)).toBe(false);
  });

  it("软链的 target 与 canonical 是同一条路径（realpath 之后）⇒ true", () => {
    const canonical = canonicalPath(userHome);
    // ⚠️ canonical 必须**真实存在**：realpath 解析悬空软链会失败 ⇒ 拿不到可比的目标
    mkdirSync(canonical, { recursive: true });
    symlinkSync(canonical, join(root, "alias"), "dir");
    expect(pointsAtCanonical(join(root, "alias"), canonical)).toBe(true);
  });
});

describe("workBuddyBridges —— 自动桥接的判定", () => {
  const hookPath = (): string => join(userHome, ".workbuddy/hooks/sync-agents-skills.sh");
  const tablePath = (name: string): string => join(userHome, ".workbuddy/skills", name);

  function withHook(): void {
    mkdirSync(join(userHome, ".workbuddy/hooks"), { recursive: true });
    writeFileSync(hookPath(), "#!/bin/sh\nexit 0\n");
  }

  it("hook 不在 ⇒ 不桥接", () => {
    expect(workBuddyBridges(userHome)).toBe(false);
  });

  it("hook 在 ⇒ 桥接", () => {
    withHook();
    expect(workBuddyBridges(userHome)).toBe(true);
  });

  it("reserved 表里点了我们的名字 ⇒ **不**桥接（hook 会跳过它）", () => {
    // 回归 P2-7：以前只查 excluded 表，漏了 reserved（builtin/plugin 占用）表
    withHook();
    mkdirSync(join(userHome, ".workbuddy/skills"), { recursive: true });
    writeFileSync(tablePath(".reserved-skill-names"), "# comment\nagent-ex-dispatch\n");
    expect(workBuddyBridges(userHome)).toBe(false);
  });

  it("excluded 表里点了我们的名字 ⇒ 不桥接", () => {
    withHook();
    mkdirSync(join(userHome, ".workbuddy/skills"), { recursive: true });
    writeFileSync(tablePath(".excluded-skill-names"), "agent-ex-dispatch\n");
    expect(workBuddyBridges(userHome)).toBe(false);
  });

  it("表里点的是别的名字 ⇒ 照旧桥接", () => {
    withHook();
    mkdirSync(join(userHome, ".workbuddy/skills"), { recursive: true });
    writeFileSync(tablePath(".reserved-skill-names"), "some-other-skill\n");
    expect(workBuddyBridges(userHome)).toBe(true);
  });
});

describe("install —— 拷贝路线", () => {
  it("missing ⇒ 装上、写 marker；第二次 ⇒ skip 且文件系统不变", async () => {
    const { confirm } = recorder();
    const r1 = await installSkill({ userHome, source, confirm });
    expect(r1.ok).toBe(true);
    const canonicalDir = canonicalPath(userHome);
    expect(lstatSync(canonicalDir).isDirectory()).toBe(true);
    expect(lstatSync(canonicalDir).isSymbolicLink()).toBe(false);
    const marker = readMarker(canonicalDir);
    expect(marker?.version).toBe(currentVersion());
    expect(marker?.sha).toBe(hashDir(canonicalDir));

    const before = hashDir(canonicalDir);
    const r2 = await installSkill({ userHome, source, confirm });
    expect(r2.ok).toBe(true);
    expect(r2.lines.some((l) => l.startsWith("skip"))).toBe(true);
    expect(hashDir(canonicalDir)).toBe(before);
  });

  it("版本落后 ⇒ 问“是否更新”；确认 ⇒ 升版；否认 ⇒ 不变", async () => {
    const { confirm, asked } = recorder([true]);
    const canonicalDir = canonicalPath(userHome);
    await installSkill({ userHome, source, confirm: async () => true });
    writeMarker(canonicalDir, {
      skill: "agent-ex-dispatch",
      version: "0.0.1",
      sha: hashDir(canonicalDir)!,
      source,
    });

    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(asked.some((q) => /Update\?/.test(q))).toBe(true);
    expect(readMarker(canonicalDir)?.version).toBe(currentVersion());
  });

  it("版本落后 + 用户否认 ⇒ 保持旧版", async () => {
    const { confirm, asked } = recorder([false]);
    const canonicalDir = canonicalPath(userHome);
    await installSkill({ userHome, source, confirm: async () => true });
    writeMarker(canonicalDir, {
      skill: "agent-ex-dispatch",
      version: "0.0.1",
      sha: hashDir(canonicalDir)!,
      source,
    });
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(asked.some((q) => /Update\?/.test(q))).toBe(true);
    expect(readMarker(canonicalDir)?.version).toBe("0.0.1");
  });

  it("foreign-dir ⇒ 中止，且目录内容一字未改", async () => {
    const canonicalDir = canonicalPath(userHome);
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, "SKILL.md"), "precious user data\n");
    const before = hashDir(canonicalDir);

    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not installed by agent-ex/);
    expect(hashDir(canonicalDir)).toBe(before);
    expect(readFileSync(join(canonicalDir, "SKILL.md"), "utf8")).toBe("precious user data\n");
  });

  it("adoptable ⇒ 认领（补 marker），不中止", async () => {
    const canonicalDir = canonicalPath(userHome);
    mkdirSync(join(canonicalDir, "references"), { recursive: true });
    writeFileSync(join(canonicalDir, "SKILL.md"), readFileSync(join(source, "SKILL.md")));
    writeFileSync(join(canonicalDir, "references/x.md"), readFileSync(join(source, "references/x.md")));

    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(r.lines.some((l) => l.startsWith("adopted"))).toBe(true);
    expect(readMarker(canonicalDir)?.version).toBe(currentVersion());
  });

  it("--target 指向 canonical 的父目录 ⇒ 拒绝（防自链）", async () => {
    const { confirm } = recorder();
    const r = await installSkill({
      userHome,
      source,
      confirm,
      targets: [join(userHome, ".agents/skills")],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/refusing to link it to itself/);
  });

  it("source 不是 skill 目录（没有 SKILL.md）⇒ 拒绝安装，什么都不落地", async () => {
    const bogus = join(root, "not-a-skill");
    mkdirSync(bogus, { recursive: true });
    writeFileSync(join(bogus, "readme.txt"), "nope\n");
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source: bogus, confirm });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/no SKILL\.md/);
    expect(existsSync(canonicalPath(userHome))).toBe(false);
  });

  it("source 是相对路径 ⇒ 解析成绝对路径（软链的字面 target 是相对链接所在目录解析的）", async () => {
    // 回归 P1-2：`--link --source <相对路径>` 曾装出**必然断掉**的链并返回 0。
    // ⚠️ 相对路径由 `relative(cwd, …)` 现算 ⇒ 不依赖 "cwd == 仓库根" 这种巧合。
    const { confirm } = recorder();
    const rel = relative(process.cwd(), source);
    expect(rel.startsWith("/")).toBe(false); // 确实是相对路径
    const r = await installSkill({ userHome, source: rel, mode: "link", confirm });
    expect(r.ok).toBe(true);
    const target = readlinkSync(canonicalPath(userHome));
    expect(target.startsWith("/")).toBe(true); // 绝对路径
    expect(existsSync(canonicalPath(userHome))).toBe(true); // 不是断链
  });

  it("source 就是 canonical 自己 ⇒ 拒绝（否则装出自指的断链却返回 0）", async () => {
    // 回归 P1-2（复审轮）：`--link --source <canonical>` 曾把 canonical 换成
    // 一条指向自己的软链 ⇒ 该路径不可读，而命令 exit 0。
    await installSkill({ userHome, source, yes: true });
    const canonical = canonicalPath(userHome);
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source: canonical, mode: "link", confirm });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/refusing to link it to itself/);
    // canonical 没被动过（还是原来那份拷贝）
    expect(lstatSync(canonical).isSymbolicLink()).toBe(false);
    expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
  });

  it("source 是 canonical 的别名路径（同一目录、写法不同）⇒ 也拒绝", async () => {
    await installSkill({ userHome, source, yes: true });
    const canonical = canonicalPath(userHome);
    // 用 `..` 拼一个指向同一目录的路径（不同写法、同一处）
    const alias = join(canonical, "..", "agent-ex-dispatch");
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source: alias, mode: "link", confirm });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/refusing to link it to itself/);
  });

  it("source 在 canonical 里面 ⇒ 拒绝（会形成环）", async () => {
    await installSkill({ userHome, source, yes: true });
    const inner = join(canonicalPath(userHome), "references");
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source: inner, mode: "link", confirm });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/refusing to link it to itself/);
  });

  it("开发者路线（canonical 是软链、source 是它的目标）⇒ **不**被自链检查误伤", async () => {
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, mode: "link", confirm });
    expect(r.ok).toBe(true);
    expect(lstatSync(canonicalPath(userHome)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(canonicalPath(userHome))).toBe(source);
  });

  /**
   * 回归（第四轮评审 P1）：source 的**真实位置**落在 canonical 里面 ⇒ 拒绝。
   * 复现 A：canonical 是软链（开发者路线），source 走 canonical 的子目录
   * → 换位后 canonical 指向自己的子树 ⇒ ELOOP、路径不可读，而命令 exit 0。
   */
  it("source 在 canonical 里面（经 canonical 的软链）⇒ 拒绝", async () => {
    const repoSkill = makeSource(join(root, "repo-skill"));
    mkdirSync(join(repoSkill, "sub"), { recursive: true });
    writeFileSync(join(repoSkill, "sub", "SKILL.md"), "---\nname: x\n---\n");
    mkdirSync(join(userHome, ".agents/skills"), { recursive: true });
    symlinkSync(repoSkill, canonicalPath(userHome), "dir");

    const { confirm } = recorder();
    const r = await installSkill({
      userHome,
      source: join(canonicalPath(userHome), "sub"),
      mode: "link",
      confirm,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/inside the canonical location/);
    // canonical 没被换成自指环
    expect(readlinkSync(canonicalPath(userHome))).toBe(repoSkill);
  });

  /**
   * 回归（第四轮评审 P1，复现 B）：source 是一个**指向 canonical 内部**的软链
   * ⇒ 真实位置在 canonical 里面 ⇒ 拒绝（字面路径看不出来，只有 realpath 看得出来）。
   */
  it("source 是指向 canonical 内部的软链 ⇒ 拒绝", async () => {
    await installSkill({ userHome, source, yes: true });
    const canonical = canonicalPath(userHome);
    mkdirSync(join(canonical, "sub"), { recursive: true });
    writeFileSync(join(canonical, "sub", "SKILL.md"), "---\nname: x\n---\n");
    const alias = join(root, "alias-to-sub");
    symlinkSync(join(canonical, "sub"), alias, "dir");

    const { confirm } = recorder();
    const r = await installSkill({ userHome, source: alias, mode: "link", confirm });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/inside the canonical location/);
  });
});

describe("install —— 软链路线（开发者）", () => {
  it("建软链且**不写 marker**（不能弄脏仓库）", async () => {
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, mode: "link", confirm });
    expect(r.ok).toBe(true);
    const canonicalDir = canonicalPath(userHome);
    expect(lstatSync(canonicalDir).isSymbolicLink()).toBe(true);
    expect(existsSync(join(canonicalDir, MARKER_FILE))).toBe(false);
  });

  it("已是指向 source 的软链 ⇒ skip（幂等）", async () => {
    const { confirm } = recorder();
    await installSkill({ userHome, source, mode: "link", confirm: async () => true });
    const r = await installSkill({ userHome, source, mode: "link", confirm });
    expect(r.lines.some((l) => l.startsWith("skip"))).toBe(true);
  });
});

describe("宿主链接", () => {
  it("给本机装了的宿主建链；指向别处的链被重指", async () => {
    // claude 目录存在 ⇒ 被探测到
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(claudeDir, { recursive: true });
    // 预先放一条指向别处的链
    const elsewhere = makeSource(join(root, "elsewhere"));
    symlinkSync(elsewhere, join(claudeDir, "agent-ex-dispatch"), "dir");

    const { confirm, asked } = recorder([true]);
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(asked.some((q) => /Repoint it\?/.test(q))).toBe(true);
    expect(readlinkSync(join(claudeDir, "agent-ex-dispatch"))).toBe(canonicalPath(userHome));
  });

  it("在场判据是宿主的**配置根目录**，不是它的 skills 目录", async () => {
    // ~/.claude 存在、~/.claude/skills 还没有 ⇒ 宿主在场 ⇒ 装完顺手把 skills 目录建出来。
    // （反过来拿 skills 目录当判据 ⇒ 装过一次就永远"在场"，没装过的宿主反而被漏掉。）
    const claude = SKILL_HOSTS.find((h) => h.id === "claude")!;
    mkdirSync(join(userHome, ".claude"), { recursive: true });

    const { confirm, asked } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(asked.some((q) => /Claude Code/.test(q))).toBe(true);
    expect(readlinkSync(join(hostDir(userHome, claude), "agent-ex-dispatch"))).toBe(
      canonicalPath(userHome),
    );
  });

  it("本机没装的宿主 ⇒ 不打扰（连目录都不建）", async () => {
    const { confirm, asked } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(asked.every((q) => !/Link the dispatch skill/.test(q))).toBe(true);
    expect(existsSync(join(userHome, ".claude"))).toBe(false);
    expect(existsSync(join(userHome, ".cursor"))).toBe(false);
  });

  /**
   * 回归（2026-11-11 独立复核 P2-2）：给没装的宿主建链会**连带建出它的配置根目录**
   * （`~/.cursor` ⊃ `~/.cursor/skills`）⇒ 之后它永远"在场" ⇒ 普通 install 也会去链它。
   * ⇒ 配置根里**只有我们自己建的那点东西**时，判为"不在场"。
   */
  it("我们自己建出来的宿主目录不算「在场」（不会把没装的宿主变成装了）", async () => {
    const cursor = SKILL_HOSTS.find((h) => h.id === "cursor")!;
    // 装一个没装 Cursor 的机器：显式点名建链
    const r = await installSkill({ userHome, source, agents: ["cursor"], yes: true });
    expect(r.ok).toBe(true);
    expect(existsSync(join(hostDir(userHome, cursor), "agent-ex-dispatch"))).toBe(true);
    // ⚠️ 但它**不在场**（~/.cursor 里只有我们自己建的那条链）
    expect(hostPresent(userHome, cursor)).toBe(false);

    // 用户真装了 Cursor（配置根里有别的东西）⇒ 在场
    writeFileSync(join(userHome, ".cursor", "settings.json"), "{}\n");
    expect(hostPresent(userHome, cursor)).toBe(true);
  });

  it("普通 install 不会去链「我们自己建过、但用户没装」的宿主", async () => {
    const cursor = SKILL_HOSTS.find((h) => h.id === "cursor")!;
    await installSkill({ userHome, source, agents: ["cursor"], yes: true });
    // 把 cursor 的链删掉（模拟用户自己清理了），再跑一次普通 install
    rmSync(join(hostDir(userHome, cursor), "agent-ex-dispatch"), { force: true });
    const { confirm, asked } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(asked.some((q) => /Cursor/.test(q))).toBe(false);
    expect(existsSync(join(hostDir(userHome, cursor), "agent-ex-dispatch"))).toBe(false);
  });

  it("直读共享目录的宿主（codex / cline / zed）⇒ **永远不建链**", async () => {
    // 它们读的就是 ~/.agents/skills ⇒ 给它们"建链"等于链到 canonical 自己，
    // 卸载时还会把 canonical 当成宿主链删掉。
    for (const id of ["codex", "cline", "zed"]) {
      const host = SKILL_HOSTS.find((h) => h.id === id)!;
      mkdirSync(hostConfigRoot(userHome, host), { recursive: true });
    }
    const { confirm, asked } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    // 共享目录里只有 canonical 一条
    expect(
      readdirSync(join(userHome, ".agents/skills")).filter((n) => n !== "agent-ex-dispatch"),
    ).toEqual([]);
    expect(asked.some((q) => /Codex|Cline|Zed/.test(q))).toBe(false);
  });

  it("宿主上**已有一条指向别处的旧链** ⇒ 照样重指（spec §4.4）", async () => {
    // 回归 P1-1（复审轮）：以前「默认不链」的判断在 inspectTarget **之前**就 continue 了，
    // 于是旧链永远不重指 ⇒ status/doctor 永远告警，而告警给的修法还修不了。
    const host = SKILL_HOSTS.find((h) => h.id === "opencode")!;
    mkdirSync(hostDir(userHome, host), { recursive: true });
    const elsewhere = makeSource(join(root, "stale-opencode"));
    symlinkSync(elsewhere, join(hostDir(userHome, host), "agent-ex-dispatch"), "dir");

    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(readlinkSync(join(hostDir(userHome, host), "agent-ex-dispatch"))).toBe(
      canonicalPath(userHome),
    );
    expect(r.lines.some((l) => /repointed/.test(l))).toBe(true);
  });

  it("用户拒绝重指 canonical ⇒ **一个宿主链都不建**（别链到不是 bundled skill 的目录上）", async () => {
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(claudeDir, { recursive: true });
    const elsewhere = makeSource(join(root, "elsewhere"));
    symlinkSync(elsewhere, join(claudeDir, "agent-ex-dispatch"), "dir");
    // canonical 指向别处
    mkdirSync(join(userHome, ".agents/skills"), { recursive: true });
    symlinkSync(elsewhere, canonicalPath(userHome), "dir");

    const { confirm, asked } = recorder([false]); // 拒绝重指
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(asked.some((q) => /Repoint it\?/.test(q))).toBe(true);
    // 宿主链没有被建/重指
    expect(readlinkSync(join(claudeDir, "agent-ex-dispatch"))).toBe(elsewhere);
    expect(r.lines.some((l) => /skip     host links/.test(l))).toBe(true);
  });
});

describe("--agent：点名宿主", () => {
  it("只给点名的宿主建链（不问）", async () => {
    const claude = SKILL_HOSTS.find((h) => h.id === "claude")!;
    const cursor = SKILL_HOSTS.find((h) => h.id === "cursor")!;
    mkdirSync(join(userHome, ".claude"), { recursive: true });
    mkdirSync(join(userHome, ".cursor"), { recursive: true });

    const { confirm, asked } = recorder();
    const r = await installSkill({ userHome, source, agents: ["claude"], confirm });
    expect(r.ok).toBe(true);
    expect(readlinkSync(join(hostDir(userHome, claude), "agent-ex-dispatch"))).toBe(
      canonicalPath(userHome),
    );
    expect(existsSync(join(hostDir(userHome, cursor), "agent-ex-dispatch"))).toBe(false);
    // 显式点名 ⇒ 不问
    expect(asked.some((q) => /Link the dispatch skill/.test(q))).toBe(false);
  });

  it("id、别名、大小写都认（claude / claude-code / CLAUDE-CODE）", () => {
    expect(findHost("claude")?.id).toBe("claude");
    expect(findHost("claude-code")?.id).toBe("claude");
    expect(findHost("CLAUDE-CODE")?.id).toBe("claude");
    expect(findHost("github-copilot")?.id).toBe("copilot");
    expect(findHost("nope")).toBeNull();
  });

  it("认不出来的名字 ⇒ 报错，**磁盘一动不动**", async () => {
    const r = await installSkill({ userHome, source, agents: ["nope"], yes: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unknown host/);
    // ⚠️ 名字认不出来就别装：半份安装比报错更糟。
    expect(existsSync(canonicalPath(userHome))).toBe(false);
  });

  it("--agent '*' ⇒ 全部需要建链的宿主", async () => {
    const r = await installSkill({ userHome, source, agents: ["*"], yes: true });
    expect(r.ok).toBe(true);
    for (const host of linkableHosts()) {
      // ⚠️ 自动桥接的宿主（WorkBuddy）自己会桥接 ⇒ '*' 不给它建多余的链（见下面那条用例）
      if (host.autoBridge?.(userHome)) continue;
      expect(existsSync(join(hostDir(userHome, host), "agent-ex-dispatch"))).toBe(true);
    }
    // 直读共享目录的那几家不参与（建链等于链到 canonical 自己）⇒ 共享目录里只有 canonical
    expect(
      readdirSync(join(userHome, ".agents/skills")).filter((n) => n !== "agent-ex-dispatch"),
    ).toEqual([]);
  });

  it("--agent '*' ⇒ 自动桥接的宿主不建多余的链；**点名**时又建", async () => {
    const workbuddy = SKILL_HOSTS.find((h) => h.id === "workbuddy")!;
    // 装一个假的桥接 hook
    mkdirSync(join(userHome, ".workbuddy/hooks"), { recursive: true });
    writeFileSync(
      join(userHome, ".workbuddy/hooks/sync-agents-skills.sh"),
      "#!/bin/sh\nexit 0\n",
    );

    const r = await installSkill({ userHome, source, agents: ["*"], yes: true });
    expect(r.ok).toBe(true);
    expect(existsSync(join(hostDir(userHome, workbuddy), "agent-ex-dispatch"))).toBe(false);
    expect(r.lines.join(" ")).toMatch(/bridges/);

    // ⚠️ 显式点名 ⇒ 以用户为准：他点名了就是要一条链
    const r2 = await installSkill({ userHome, source, agents: ["workbuddy"], yes: true });
    expect(r2.ok).toBe(true);
    expect(existsSync(join(hostDir(userHome, workbuddy), "agent-ex-dispatch"))).toBe(true);
  });

  it("--agent 点名直读共享目录的宿主 ⇒ 只提示，不建链", async () => {
    const r = await installSkill({ userHome, source, agents: ["codex"], yes: true });
    expect(r.ok).toBe(true);
    expect(readdirSync(join(userHome, ".agents/skills")).filter((n) => n !== "agent-ex-dispatch")).toEqual(
      [],
    );
  });
});

describe("remove --agent", () => {
  it("只删点名的宿主；canonical 与别的宿主留着", async () => {
    const claude = SKILL_HOSTS.find((h) => h.id === "claude")!;
    const cursor = SKILL_HOSTS.find((h) => h.id === "cursor")!;
    await installSkill({ userHome, source, agents: ["claude", "cursor"], yes: true });

    const r = await removeSkill({ userHome, source, agents: ["claude"], yes: true });
    expect(r.ok).toBe(true);
    expect(existsSync(join(hostDir(userHome, claude), "agent-ex-dispatch"))).toBe(false);
    expect(existsSync(join(hostDir(userHome, cursor), "agent-ex-dispatch"))).toBe(true);
    // ⚠️ --agent 是**宿主过滤器**，不是全量卸载 ⇒ canonical 留着
    expect(existsSync(canonicalPath(userHome))).toBe(true);
  });

  it("直读共享目录的宿主 ⇒ 不会被当成宿主链删掉（canonical 不受影响）", async () => {
    await installSkill({ userHome, source, yes: true });
    const r = await removeSkill({ userHome, source, agents: ["codex"], yes: true });
    expect(r.ok).toBe(true);
    expect(existsSync(canonicalPath(userHome))).toBe(true);
    expect(r.lines.join(" ")).toMatch(/reads the shared directory/);
  });
});

describe("版本与内容指纹", () => {
  it("版本相同但**内容被手改** ⇒ 也要问（不能静默覆盖用户的修改）", async () => {
    await installSkill({ userHome, source, yes: true });
    // 改掉 canonical 里的一个文件（marker 记录的 sha 随即对不上）
    writeFileSync(join(canonicalPath(userHome), "SKILL.md"), "---\nname: x\n---\n\nhand edited\n");

    const { confirm, asked } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(asked.some((q) => /local modifications/.test(q))).toBe(true);
    // 用户否认 ⇒ 保持用户的修改
    expect(readFileSync(join(canonicalPath(userHome), "SKILL.md"), "utf8")).toContain("hand edited");
    expect(r.lines.some((l) => /kept v/.test(l))).toBe(true);
  });

  it("宿主链指向别处（不是 canonical）⇒ status / doctor 要报出来", async () => {
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(claudeDir, { recursive: true });
    const elsewhere = makeSource(join(root, "elsewhere2"));
    symlinkSync(elsewhere, join(claudeDir, "agent-ex-dispatch"), "dir");

    const issues = collectSkillIssues({ userHome, source });
    const mis = issues.find((i) => i.code === "skill.host-link-elsewhere");
    expect(mis?.severity).toBe("warn");
    expect(mis?.detail).toContain(elsewhere);
  });

  it("宿主链**断掉**（目标没了）⇒ doctor 也要报（以前只有 status 报）", async () => {
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(claudeDir, { recursive: true });
    // 指向一个不存在的目录 ⇒ 断链
    symlinkSync(join(root, "gone"), join(claudeDir, "agent-ex-dispatch"), "dir");

    const issues = collectSkillIssues({ userHome, source });
    const mis = issues.find((i) => i.code === "skill.host-link-elsewhere");
    expect(mis?.severity).toBe("warn");
    expect(mis?.detail).toMatch(/broken/);
  });

  it("canonical 自己是断链 ⇒ status 要标出来（不能只打印 `[link -> …]`）", async () => {
    mkdirSync(join(userHome, ".agents/skills"), { recursive: true });
    symlinkSync(join(root, "gone-canonical"), canonicalPath(userHome), "dir");
    const st = skillStatus({ userHome, source });
    expect(st.canonical.broken).toBe(true);
  });
});

describe("原子替换与失败路径", () => {
  /**
   * 回归（第三轮评审 P1-a）：canonical 是**悬空软链**时（开发者路线的目标被删很常见），
   * 旧的判断用 `existsSync`（**跟随**软链）⇒ 返回 false ⇒ 不把占位的链接名挪开
   * ⇒ `rename(目录, 悬空软链)` 报 ENOTDIR ⇒ 安装必失败，
   * 而 doctor 给的修法恰恰是 `agent-ex skill install` ⇒ 告警永远修不掉。
   */
  it("canonical 是断链 ⇒ 照样装得上（不是 ENOTDIR）", async () => {
    mkdirSync(join(userHome, ".agents/skills"), { recursive: true });
    symlinkSync(join(root, "gone-target"), canonicalPath(userHome), "dir");
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(lstatSync(canonicalPath(userHome)).isSymbolicLink()).toBe(false);
    expect(existsSync(join(canonicalPath(userHome), "SKILL.md"))).toBe(true);
  });

  it("canonical 是断链 + 切软链 ⇒ 也装得上", async () => {
    mkdirSync(join(userHome, ".agents/skills"), { recursive: true });
    symlinkSync(join(root, "gone-target"), canonicalPath(userHome), "dir");
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, mode: "link", confirm });
    expect(r.ok).toBe(true);
    expect(lstatSync(canonicalPath(userHome)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(canonicalPath(userHome))).toBe(source);
  });

  /**
   * 回归（第三轮评审 P1-b）：宿主链的重指 / 断链修复也必须是**原子替换**，
   * 不能「先删后建」——建链失败就只剩"链没了"。
   */
  it("宿主链重指是原子替换（旧的链在换位成功前一直在）", async () => {
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(claudeDir, { recursive: true });
    const elsewhere = makeSource(join(root, "stale-host"));
    symlinkSync(elsewhere, join(claudeDir, "agent-ex-dispatch"), "dir");

    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    expect(readlinkSync(join(claudeDir, "agent-ex-dispatch"))).toBe(canonicalPath(userHome));
    // 宿主目录里不留临时文件
    expect(readdirSync(claudeDir).filter((n) => n.startsWith("."))).toEqual([]);
  });

  /**
   * 回归（第四轮评审 P3：原子替换的测试只测了成功路径 = 假通过）：
   * 换位**失败**时，旧链必须还在（不是"先删后建"）。
   */
  it("宿主链换位失败 ⇒ 旧链还在（旧链不是先删掉的）", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 无视权限
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(claudeDir, { recursive: true });
    const elsewhere = makeSource(join(root, "stale-host2"));
    symlinkSync(elsewhere, join(claudeDir, "agent-ex-dispatch"), "dir");

    chmodSync(claudeDir, 0o555); // 目录不可写 ⇒ 建新链失败
    try {
      const { confirm } = recorder();
      const r = await installSkill({ userHome, source, confirm });
      expect(r.ok).toBe(false);
      // ⚠️ 旧链还在，还指向原来的地方
      expect(readlinkSync(join(claudeDir, "agent-ex-dispatch"))).toBe(elsewhere);
    } finally {
      chmodSync(claudeDir, 0o755);
    }
  });

  /**
   * 回归（第三轮评审 P2-a）：`--target` 指到 canonical **里面** ⇒
   * copy 模式会在装好的 skill 目录里建出指向自己祖先的环；
   * link 模式 + canonical 是软链 ⇒ 软链落进**源码树**。
   */
  it("--target 指进 canonical 里面 ⇒ 拒绝", async () => {
    await installSkill({ userHome, source, yes: true });
    const inner = join(canonicalPath(userHome), "inner");
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, confirm, targets: [inner] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/inside the canonical location/);
    expect(existsSync(join(inner, "agent-ex-dispatch"))).toBe(false);
  });

  it("--target 指进 canonical 的软链目标（源码树）⇒ 拒绝", async () => {
    // canonical 是软链 ⇒ 它的真实位置是 source；--target 指到 source 里面就会写穿源码树
    await installSkill({ userHome, source, mode: "link", yes: true });
    const { confirm } = recorder();
    const r = await installSkill({
      userHome,
      source,
      mode: "link",
      confirm,
      targets: [join(source, "references")],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/inside the canonical location/);
    expect(existsSync(join(source, "references", "agent-ex-dispatch"))).toBe(false);
  });

  /**
   * 回归（第四轮评审 P2-a）：`--target` 用 canonical 的**别名路径**
   * （macOS 上 /var vs /private/var），而 canonical **还不存在** ⇒
   * realpath 退化成字面比较 ⇒ 绕过拦截 ⇒ 在 canonical 内建出自指环。
   */
  it("--target 用 canonical 的别名路径（canonical 尚不存在）⇒ 拒绝", async () => {
    // userHome 在 tmpdir 下；macOS 上 tmpdir 的真实路径是 /private/var/... ⇒ 天然是别名
    const aliasHome = realpathSync(userHome);
    expect(aliasHome).not.toBe(userHome);
    const aliasCanonical = join(aliasHome, ".agents/skills/agent-ex-dispatch");
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source, confirm, targets: [aliasCanonical] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/canonical location/);
    expect(existsSync(join(aliasCanonical, "agent-ex-dispatch"))).toBe(false);
  });

  /**
   * 回归（P2-1）：`rename(canonical, old)` 失败时旧实现会**泄漏** `.tmp.<pid>`，
   * 而临时名带 pid ⇒ 下次运行（另一个 pid）永远清不掉。
   */
  it("替换失败 ⇒ 不留临时目录，canonical 原封不动", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 无视权限
    await installSkill({ userHome, source, yes: true });
    const skillsDir = join(userHome, ".agents/skills");
    const canonical = canonicalPath(userHome);
    // ⚠️ 先把内容改掉（marker 的 sha 对不上）⇒ 这次 install 会真的去替换
    writeFileSync(join(canonical, "SKILL.md"), "hand edited\n");
    chmodSync(skillsDir, 0o555); // 目录不可写 ⇒ rename 必然失败
    try {
      const r = await installSkill({ userHome, source, yes: true });
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
      // canonical 还在、内容没变
      expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
      // ⚠️ 父目录里没有残留的临时目录（.tmp.<pid> / .old.<pid>）
      expect(readdirSync(skillsDir).filter((n) => n.startsWith("."))).toEqual([]);
    } finally {
      chmodSync(skillsDir, 0o755);
    }
  });

  /**
   * 回归（P2-2）：link 路线以前是「先 rm canonical，再建链」——
   * symlinkSync 失败就**永久丢了这份安装**（连备份都没有）。
   */
  it("切成软链失败 ⇒ 原来那份拷贝还在（不是删了再建）", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 无视权限
    await installSkill({ userHome, source, yes: true });
    const canonical = canonicalPath(userHome);
    const skillsDir = join(userHome, ".agents/skills");
    chmodSync(skillsDir, 0o555); // 目录不可写 ⇒ symlinkSync 失败
    try {
      const r = await installSkill({ userHome, source, mode: "link", yes: true });
      expect(r.ok).toBe(false);
      // ⚠️ 拷贝还在，没被删掉
      expect(lstatSync(canonical).isSymbolicLink()).toBe(false);
      expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
    } finally {
      chmodSync(skillsDir, 0o755);
    }
  });
});

describe("库 API 的默认行为", () => {
  it("removeSkill 不给 yes / confirm ⇒ **拒绝执行**（不静默删东西）", async () => {
    // 回归 P2-3：以前默认 confirm 按默认值（=是）放行 ⇒ 程序化误用会静默删掉安装。
    await installSkill({ userHome, source, yes: true });
    await expect(removeSkill({ userHome, source })).rejects.toThrow(/cannot ask interactively/);
    expect(existsSync(canonicalPath(userHome))).toBe(true);
  });

  it("installSkill 不给 yes / confirm、但需要提问时 ⇒ 拒绝执行", async () => {
    // canonical 指向别处 ⇒ 会问"要不要重指"；没人能答 ⇒ 抛错，不静默重指。
    const elsewhere = makeSource(join(root, "elsewhere3"));
    mkdirSync(join(userHome, ".agents/skills"), { recursive: true });
    symlinkSync(elsewhere, canonicalPath(userHome), "dir");
    await expect(installSkill({ userHome, source })).rejects.toThrow(/cannot ask interactively/);
    expect(readlinkSync(canonicalPath(userHome))).toBe(elsewhere);
  });
});

describe("remove", () => {
  it("删掉宿主软链（不论它指向哪）并删掉 managed copy", async () => {
    const { confirm } = recorder();
    await installSkill({ userHome, source, confirm: async () => true });
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync(canonicalPath(userHome), join(claudeDir, "agent-ex-dispatch"), "dir");

    const r = await removeSkill({ userHome, source, yes: true });
    expect(r.ok).toBe(true);
    expect(existsSync(join(claudeDir, "agent-ex-dispatch"))).toBe(false);
    expect(existsSync(canonicalPath(userHome))).toBe(false);
  });

  it("宿主目录下的实体目录 ⇒ 拒绝删，且**结果不是成功**", async () => {
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(join(claudeDir, "agent-ex-dispatch"), { recursive: true });
    const r = await removeSkill({ userHome, source, yes: true });
    // ⚠️ 东西还在原地 ⇒ 不能报"卸载成功"（2026-11-10 评审 P2-8：静默 exit 0 会骗人）。
    expect(r.ok).toBe(false);
    expect(r.skipped).toContain(join(claudeDir, "agent-ex-dispatch"));
    expect(r.lines.join(" ")).toMatch(/not a symlink/);
    expect(existsSync(join(claudeDir, "agent-ex-dispatch"))).toBe(true);
  });

  it("canonical 是 foreign-dir ⇒ 拒绝删，且**结果不是成功**", async () => {
    const canonicalDir = canonicalPath(userHome);
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, "SKILL.md"), "user data\n");
    const r = await removeSkill({ userHome, source, yes: true });
    expect(r.ok).toBe(false);
    expect(r.skipped).toContain(canonicalDir);
    expect(r.lines.join(" ")).toMatch(/not installed by agent-ex/);
    expect(existsSync(canonicalDir)).toBe(true);
  });

  it("canonical 是软链 ⇒ 只删链接，不删 target", async () => {
    await installSkill({ userHome, source, mode: "link", yes: true });
    const r = await removeSkill({ userHome, source, yes: true });
    expect(r.ok).toBe(true);
    expect(existsSync(canonicalPath(userHome))).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  it("卸载时顺手清掉安装过程留下的临时物（否则「卸载干净」是假的）", async () => {
    await installSkill({ userHome, source, yes: true });
    // 模拟一次被 kill 的安装留下的残留
    const skillsDir = join(userHome, ".agents/skills");
    const leftover = join(skillsDir, ".agent-ex-dispatch.old.99999");
    mkdirSync(leftover, { recursive: true });
    const tmpLeft = join(skillsDir, ".agent-ex-dispatch.tmp.99999");
    mkdirSync(tmpLeft, { recursive: true });

    const r = await removeSkill({ userHome, source, yes: true });
    expect(r.ok).toBe(true);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(tmpLeft)).toBe(false);
    expect(existsSync(canonicalPath(userHome))).toBe(false);
  });

  it("--target 只删那个目录，**不删 canonical**", async () => {
    const { confirm } = recorder();
    await installSkill({ userHome, source, confirm: async () => true });
    const extra = join(root, "extra-host");
    mkdirSync(extra, { recursive: true });
    symlinkSync(canonicalPath(userHome), join(extra, "agent-ex-dispatch"), "dir");

    const r = await removeSkill({ userHome, source, targets: [extra], yes: true });
    expect(r.ok).toBe(true);
    expect(existsSync(join(extra, "agent-ex-dispatch"))).toBe(false);
    expect(existsSync(canonicalPath(userHome))).toBe(true);
  });

  /**
   * 回归（P1-3）：宿主链删不掉时，**canonical 也不能删**。
   *
   * 先链后 canonical 的理由：留着 canonical，断的只是链；
   * 删了 canonical 还留着链，断的是整份 skill。
   */
  it("宿主链删不掉 ⇒ canonical 也保留（不留断链）", async () => {
    // root 无视权限 ⇒ 这个场景在 root 下测不了
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    await installSkill({ userHome, source, yes: true });
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync(canonicalPath(userHome), join(claudeDir, "agent-ex-dispatch"), "dir");
    chmodSync(claudeDir, 0o555); // 目录不可写 ⇒ unlink 必然失败
    try {
      const r = await removeSkill({ userHome, source, yes: true });
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
      // canonical 还在（没被顺手删掉）
      expect(existsSync(canonicalPath(userHome))).toBe(true);
      expect(r.lines.join(" ")).toMatch(/kept/);
    } finally {
      chmodSync(claudeDir, 0o755);
    }
  });
});

describe("--agent 的取值解析", () => {
  it("别名归一到宿主 id；重复的只算一次", () => {
    expect(resolveAgentSelection(["claude-code", "CLAUDE"]).ids).toEqual(["claude"]);
    expect(resolveAgentSelection(["github-copilot"]).ids).toEqual(["copilot"]);
    expect(resolveAgentSelection(["claude", "claude-code"]).ids).toEqual(["claude"]);
  });

  it("'*' = 全部；认不出来的单独报出来", () => {
    expect(resolveAgentSelection(["*"]).all).toBe(true);
    expect(resolveAgentSelection(["nope"]).unknown).toEqual(["nope"]);
    expect(resolveAgentSelection([]).ids).toEqual([]);
  });
});

describe("status / doctor 的 skill 段", () => {
  it("status 只读：调用前后目录内容不变", () => {
    const before = hashDir(source);
    skillStatus({ userHome, source });
    expect(hashDir(source)).toBe(before);
    expect(existsSync(join(userHome, ".agents"))).toBe(false);
  });

  it("直读共享目录的宿主**不算**「链到别处」（开发者路线下 canonical 是软链）", async () => {
    // canonical 是软链 ⇒ 直读共享目录的宿主那条"链"就是 canonical 自己，
    // 它的目标不等于 canonicalAbs ⇒ 不排除的话会被误报成"链到别处"。
    await installSkill({ userHome, source, mode: "link", yes: true });
    const issues = collectSkillIssues({ userHome, source });
    expect(issues.find((i) => i.code === "skill.host-link-elsewhere")).toBeUndefined();
  });

  it("本机装了的宿主没链接 ⇒ 报「没链进去」；没装的宿主不报", async () => {
    mkdirSync(join(userHome, ".claude"), { recursive: true });
    const issues = collectSkillIssues({ userHome, source });
    const unlinked = issues.find((i) => i.code === "skill.hosts-unlinked");
    expect(unlinked?.detail).toContain("Claude Code");
    // 没装的宿主不该出现在告警里
    expect(unlinked?.detail).not.toContain("Cursor");
  });

  it("未安装 ⇒ info（不是 error）", () => {
    const issues = collectSkillIssues({ userHome, source });
    const miss = issues.find((i) => i.code === "skill.missing");
    expect(miss?.severity).toBe("info");
    expect(issues.every((i) => i.severity !== "error")).toBe(true);
  });

  it("版本落后 ⇒ warn", async () => {
    await installSkill({ userHome, source, confirm: async () => true });
    const canonicalDir = canonicalPath(userHome);
    writeMarker(canonicalDir, {
      skill: "agent-ex-dispatch",
      version: "0.0.1",
      sha: hashDir(canonicalDir)!,
      source,
    });
    const issues = collectSkillIssues({ userHome, source });
    const out = issues.find((i) => i.code === "skill.outdated");
    expect(out?.severity).toBe("warn");
  });
});
