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

  it("宿主目录下的实体目录 ⇒ 拒绝删", async () => {
    const claudeDir = hostDir(userHome, SKILL_HOSTS.find((h) => h.id === "claude")!);
    mkdirSync(join(claudeDir, "agent-ex-dispatch"), { recursive: true });
    const r = await removeSkill({ userHome, source, yes: true });
    expect(r.ok).toBe(true);
    expect(r.lines.join(" ")).toMatch(/not a symlink/);
    expect(existsSync(join(claudeDir, "agent-ex-dispatch"))).toBe(true);
  });

  it("canonical 是 foreign-dir ⇒ 拒绝删", async () => {
    const canonicalDir = canonicalPath(userHome);
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, "SKILL.md"), "user data\n");
    const r = await removeSkill({ userHome, source, yes: true });
    expect(r.ok).toBe(true);
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
