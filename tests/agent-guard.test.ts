// agent-guard 的单测：真起进程，验证「runner 退出前 agent 确实死了」。
//
// 为什么值得单测（而不是只靠集成测试）：这个守卫的唯一价值就是「进程真的没了」，
// 而「进程没了」只有对着真进程验才算数。集成测试只能覆盖 runner 接的那几条路径，
// 守卫本身的语义（等它死、连后代一起死、没登记时是 no-op）在这里直接测。
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attachAgent, detachAgent, killAgentTreeSync, liveAgentPid, terminateAgentTree } from "../src/agent-guard.js";
import { isPsAvailable } from "../src/proc-tree.js";

/** ps 不可用时拿不到后代快照（逃逸子进程可能漏杀）⇒ 依赖后代的用例显式跳过。 */
const psRequired = isPsAvailable() ? it : it.skip;

function spawnSleeper(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  return { pid, kill: () => { try { child.kill("SIGKILL"); } catch { /* 已死 */ } } };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pid: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

describe("agent-guard", () => {
  it("terminateAgentTree ⇒ 子进程真的死了", async () => {
    const sleeper = spawnSleeper();
    try {
      attachAgent(sleeper.pid);
      expect(liveAgentPid()).toBe(sleeper.pid);
      await terminateAgentTree(1000);
      // 契约：返回时 agent 已经不在了（不是「之后再补一刀」）
      expect(alive(sleeper.pid)).toBe(false);
    } finally {
      sleeper.kill();
      detachAgent();
    }
  });

  it("killAgentTreeSync ⇒ 子进程真的死了", async () => {
    const sleeper = spawnSleeper();
    try {
      attachAgent(sleeper.pid);
      killAgentTreeSync();
      // SIGKILL 是**送达**即生效，但进程要等 Node 回收后才真正消失（zombie 期间
      // kill(pid,0) 仍成功）⇒ 这里轮询等它消失，而不是查完就断言。
      expect(await waitGone(sleeper.pid)).toBe(true);
    } finally {
      sleeper.kill();
      detachAgent();
    }
  });

  psRequired("连后代一起死（agent 派生的子进程不能漏）", async () => {
    // 子进程再派一个孙进程并把 pid 写出来
    const gcPidfile = join(tmpdir(), `afex-guard-gc-${process.pid}.pid`);
    const child = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(process.env.GC_PIDFILE, String(g.pid));
      setInterval(() => {}, 1000);
    `], { stdio: "ignore", env: { ...process.env, GC_PIDFILE: gcPidfile } });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !existsSync(gcPidfile)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(gcPidfile)).toBe(true);
    const gcPid = Number(readFileSync(gcPidfile, "utf8"));
    try {
      attachAgent(child.pid!);
      await terminateAgentTree(1000);
      expect(alive(child.pid!)).toBe(false);
      expect(await waitGone(gcPid)).toBe(true);
    } finally {
      try { process.kill(gcPid, "SIGKILL"); } catch { /* 已死 */ }
      try { process.kill(child.pid!, "SIGKILL"); } catch { /* 已死 */ }
      try { rmSync(gcPidfile, { force: true }); } catch { /* 已删 */ }
      detachAgent();
    }
  });

  it("没登记 agent 时是 no-op（不会误杀别的进程）", async () => {
    detachAgent();
    expect(liveAgentPid()).toBeNull();
    await terminateAgentTree(500);
    killAgentTreeSync();
    expect(liveAgentPid()).toBeNull();
  });
});
