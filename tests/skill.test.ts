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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MARKER_FILE,
  SKILL_HOSTS,
  canonicalPath,
  collectSkillIssues,
  currentVersion,
  hashDir,
  hostDir,
  inspectCanonical,
  inspectTarget,
  installSkill,
  readMarker,
  removeSkill,
  resolveBundledSkillDir,
  skillStatus,
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
    // 用仓库里真实存在的相对路径来测：cwd 就是仓库根。
    const { confirm } = recorder();
    const r = await installSkill({ userHome, source: "skills/agent-ex-dispatch", mode: "link", confirm });
    expect(r.ok).toBe(true);
    const target = readlinkSync(canonicalPath(userHome));
    expect(target.startsWith("/")).toBe(true); // 绝对路径
    expect(existsSync(canonicalPath(userHome))).toBe(true); // 不是断链
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
  it("给探测到的宿主建链；指向别处的链被重指", async () => {
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

  it("宿主目录不存在 ⇒ 不打扰（不 mkdir）", async () => {
    const { confirm, asked } = recorder();
    await installSkill({ userHome, source, confirm });
    expect(asked.every((q) => !/Link the dispatch skill/.test(q))).toBe(true);
  });

  it("默认不链的宿主（codex / opencode）⇒ 不建链，也不问", async () => {
    // 这两个宿主的 skills 目录在机器上存在，但**未验证**它们会读自己的目录
    // （codex 直接读共享目录 ~/.agents/skills）⇒ 不能默认给它们建链。
    for (const id of ["codex", "opencode"]) {
      const host = SKILL_HOSTS.find((h) => h.id === id)!;
      mkdirSync(hostDir(userHome, host), { recursive: true });
    }
    const { confirm, asked } = recorder();
    const r = await installSkill({ userHome, source, confirm });
    expect(r.ok).toBe(true);
    for (const id of ["codex", "opencode"]) {
      const host = SKILL_HOSTS.find((h) => h.id === id)!;
      expect(existsSync(join(hostDir(userHome, host), "agent-ex-dispatch"))).toBe(false);
    }
    expect(asked.some((q) => /Codex|OpenCode/.test(q))).toBe(false);
    expect(r.lines.some((l) => /not linked by default/.test(l))).toBe(true);
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

describe("status / doctor 的 skill 段", () => {
  it("status 只读：调用前后目录内容不变", () => {
    const before = hashDir(source);
    skillStatus({ userHome, source });
    expect(hashDir(source)).toBe(before);
    expect(existsSync(join(userHome, ".agents"))).toBe(false);
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
