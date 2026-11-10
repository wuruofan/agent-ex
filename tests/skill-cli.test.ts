/**
 * `agent-ex skill` 的**进程级** CLI 行为测试。
 *
 * 为什么必须是进程级：三条被钉住的行为都依赖进程状态，单元测试测不出来——
 *   - 非 TTY 判定（`process.stdin.isTTY`）；
 *   - `os.homedir()` 决定的 canonical 位置（`~/.agents/skills/agent-ex-dispatch`）；
 *   - 命令行参数解析（`--target` 吞掉紧随的选项）。
 *
 * ⚠️ **不碰开发机的真实 home**：子进程的 HOME 被指到临时目录。
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

interface RunResult {
  out: string;
  code: number;
}

/** 在隔离的 HOME 里跑一条 CLI 命令。`cwd` 默认用临时目录（避免在仓库里留下垃圾）。 */
async function runSkillCli(
  args: string[],
  opts: { cwd?: string; home?: string } = {},
): Promise<RunResult & { home: string }> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "aex-skill-cli-"));
  const cwd = opts.cwd ?? home;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete (env as Record<string, string | undefined>).AGENT_EX_HOME;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxCli, join(repoRoot, "src", "server.ts"), ...args],
      { env, encoding: "utf8", timeout: 60_000, cwd },
    );
    return { out: stdout + stderr, code: 0, home };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.code ?? -1, home };
  }
}

describe("agent-ex skill（CLI 路径）", () => {
  it("install --yes ⇒ 装到 ~/.agents/skills 并写 marker；status 看得到；remove 收干净", async () => {
    // ⚠️ 三条命令必须跑在**同一个** HOME 里（canonical 位置由 HOME 决定）
    const home = mkdtempSync(join(tmpdir(), "aex-skill-cli-"));
    try {
      const r = await runSkillCli(["skill", "install", "--yes"], { home });
      expect(r.code).toBe(0);
      const canonical = join(home, ".agents/skills/agent-ex-dispatch");
      expect(existsSync(join(canonical, "SKILL.md"))).toBe(true);
      expect(existsSync(join(canonical, ".agent-ex-skill.json"))).toBe(true);

      const s = await runSkillCli(["skill", "status"], { home });
      expect(s.code).toBe(0);
      expect(s.out).toContain("agent-ex-dispatch");

      const rm = await runSkillCli(["skill", "remove", "--yes"], { home });
      expect(rm.code).toBe(0);
      expect(existsSync(canonical)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * 回归（P2-1）：`--target` 曾把**紧随的选项**当成目录吞掉
   * ⇒ 真的在当前目录里建出一个叫 "--source" 的目录。
   */
  it("--target 后面紧跟另一个选项 ⇒ 报用法错误，且不建出那个名字的目录", async () => {
    const work = mkdtempSync(join(tmpdir(), "aex-skill-cli-opt-"));
    const r = await runSkillCli(["skill", "install", "--target", "--source", "x", "--yes"], { cwd: work });
    try {
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/--target needs a directory/);
      // 工作目录里没多出 "--source" / "--yes" 这两个目录
      expect(readdirSync(work)).not.toContain("--source");
      expect(readdirSync(work)).not.toContain("--yes");
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  /**
   * 回归（P2-14）：非交互环境（管道 / CI）里没有 `--yes` 时**直接拒绝**，
   * 而且是**在动手之前**拒绝 —— 之前的顺序是"先写 canonical，再抛错"。
   */
  it("非 TTY 且没有 --yes ⇒ 拒绝执行（退出码 2），磁盘上什么都没有", async () => {
    const r = await runSkillCli(["skill", "install"]);
    try {
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/not a TTY/);
      // 一个字节都没落地
      expect(existsSync(join(r.home, ".agents"))).toBe(false);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  it("remove 非 TTY 且没有 --yes ⇒ 同样拒绝（不留半删状态）", async () => {
    const r = await runSkillCli(["skill", "remove"]);
    try {
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/not a TTY/);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  it("status 是只读的：非 TTY 下也能跑，且不创建任何目录", async () => {
    const r = await runSkillCli(["skill", "status"]);
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain("not installed");
      expect(existsSync(join(r.home, ".agents"))).toBe(false);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  });

  /** 回归（P2-4）：指向**别处**的宿主链不能标成"正常"（绿勾）。 */
  it("status 里链到别处的宿主要标出来（不是绿勾）", async () => {
    const home = mkdtempSync(join(tmpdir(), "aex-skill-cli-"));
    try {
      const r = await runSkillCli(["skill", "install", "--yes"], { home });
      expect(r.code).toBe(0);
      // 手工放一条指向别处的宿主链
      const hostDir = join(home, ".claude/skills");
      mkdirSync(hostDir, { recursive: true });
      const other = join(home, "other-skill");
      mkdirSync(other, { recursive: true });
      symlinkSync(other, join(hostDir, "agent-ex-dispatch"), "dir");

      const s = await runSkillCli(["skill", "status"], { home });
      expect(s.code).toBe(0);
      expect(s.out).toContain("not the canonical copy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
