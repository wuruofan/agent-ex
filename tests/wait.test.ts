import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
// vitest 的 vite resolver 会剥掉 "node:sqlite" 前缀（Failed to load url sqlite）——
// 与 src/store.ts:4-8 / tests/store.test.ts 同一约定，别改成顶层 import
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskReader, sourceSig, runWait, deriveMaxWait } from "../src/wait.js";

const SCHEMA = `CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, project_path TEXT,
  log_path TEXT, files_changed TEXT, started_at INTEGER, ended_at INTEGER, error TEXT,
  question TEXT, timeout_sec INTEGER)`;

/** 遗留 WAL 库：干净关闭后目录里只剩 tasks.db（无 -wal/-shm）⇒ 只读读者无法建 shm ⇒ 直读必失败。 */
function legacyWalHome(status = "running") {
  const root = mkdtempSync(join(tmpdir(), "af-wait-db-"));
  const home = join(root, "home");
  const copy = join(root, "copy");
  mkdirSync(home);
  mkdirSync(copy);
  const dbPath = join(home, "tasks.db");
  const d = new DatabaseSync(dbPath);
  d.exec(SCHEMA);
  d.exec("PRAGMA journal_mode=WAL");
  d.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("task_x", status, "/tmp/p", join(root, "r.jsonl"), "[]", 1000, null, null, null, 3600);
  d.close();
  return { root, home, copy, dbPath };
}

describe("sourceSig", () => {
  it("覆盖 db + -wal + -journal 三个文件", () => {
    const { dbPath, root } = legacyWalHome();
    const sig = sourceSig(dbPath);
    expect(sig.split("|")).toHaveLength(3);
    expect(sig).toContain("gone");          // -wal / -journal 不存在时记 gone
    rmSync(root, { recursive: true, force: true });
  });
});

describe("runWait 参数与用法", () => {
  it("--help 打印用法并 exit 0", async () => {
    const r = await runWait(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("agent-ex wait");
  });

  it("缺 task_id ⇒ exit 4", async () => {
    const r = await runWait([]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("task_id");
  });

  it("未知选项 ⇒ exit 4", async () => {
    const r = await runWait(["task_x", "--bogus"]);
    expect(r.exitCode).toBe(4);
  });

  it("--interval-sec 必须 > 0 ⇒ exit 4", async () => {
    const r = await runWait(["task_x", "--interval-sec", "0"]);
    expect(r.exitCode).toBe(4);
  });

  it("--max-wait-sec 必须 >= 0 ⇒ exit 4", async () => {
    const r = await runWait(["task_x", "--max-wait-sec", "-1"]);
    expect(r.exitCode).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// runWait 按状态分组（43 条断言的落点；合成 HOME，绝不碰真实 ~/.agent-ex）
// ---------------------------------------------------------------------------

interface Row {
  status: string;
  question?: string | null;
  error?: string | null;
  timeout_sec?: number;
  log?: string[];
  files?: string[];
  started_at?: number | null;
  ended_at?: number | null;
}

/** claude 形状的一行 assistant 日志（与老测试同款 mock）。 */
const asst = (text: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

function makeHome(row: Row): string {
  const home = mkdtempSync(join(tmpdir(), "af-wait-run-"));
  const db = new DatabaseSync(join(home, "tasks.db"));
  db.exec(SCHEMA);
  const logPath = join(home, "task.jsonl");
  writeFileSync(logPath, (row.log ?? []).join("\n") + "\n");
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "task_t1", row.status, "/tmp/proj", logPath, JSON.stringify(row.files ?? []),
    row.started_at ?? 1000, row.ended_at ?? null, row.error ?? null,
    row.question ?? null, row.timeout_sec ?? 3600,
  );
  db.close();
  return home;
}

const OPENCODE_FLAT = (text: string) => JSON.stringify({ type: "text", text });
const OPENCODE_PART = (text: string) => JSON.stringify({ type: "text", part: { type: "text", text } });

describe("runWait 状态与输出", () => {
  it("终态 + 短报告：内联 REPORT_TEXT，不给 REPORT_HEAD", async () => {
    const home = makeHome({ status: "completed", log: [asst("## 报告\n改完 2 个文件，0 fail。")] });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^WAIT=terminal$/m);
    expect(r.stdout).toMatch(/^REPORT_TEXT=.*0 fail/m);
    expect(r.stdout).not.toMatch(/^REPORT_HEAD=/m);
    rmSync(home, { recursive: true, force: true });
  });

  it("终态 + 长报告：REPORT_OUTLINE + REPORT_HEAD，无 REPORT_TEXT；stdout 字节数 < 报告文件字节数", async () => {
    const body = "## 摘要\n结论一\n## 验收\n0 fail\n" + "正文".repeat(800);   // > 1200 字符
    const home = makeHome({ status: "completed", log: [asst(body)] });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^REPORT_OUTLINE=摘要 \| 验收/m);
    expect(r.stdout).toMatch(/^REPORT_HEAD=/m);
    expect(r.stdout).not.toMatch(/^REPORT_TEXT=/m);
    const reportPath = /^REPORT_PATH=(.*)$/m.exec(r.stdout)![1];
    const reportBytes = (await import("node:fs")).statSync(reportPath).size;
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(reportBytes);
    rmSync(home, { recursive: true, force: true });
  });

  it("终态报告文件内容 = 最长 assistant 块，且不含 compaction 摘要", async () => {
    const compact = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "摘要".repeat(3000) }] } });
    const home = makeHome({ status: "completed", log: [asst("真报告正文"), compact] });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    const reportPath = /^REPORT_PATH=(.*)$/m.exec(r.stdout)![1];
    expect((await import("node:fs")).readFileSync(reportPath, "utf8")).toBe("真报告正文");
    rmSync(home, { recursive: true, force: true });
  });

  it("opencode 两种形状都能取出报告", async () => {
    for (const line of [OPENCODE_FLAT("oc 报告"), OPENCODE_PART("嵌套报告")]) {
      const home = makeHome({ status: "completed", log: [line] });
      const r = await runWait(["task_t1", "--home", home, "--once"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^REPORT_TEXT=/m);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("needs_input：exit 5 + QUESTION 带上问句，且 digest 三件套全部缺席；REPORT_PATH 仍输出", async () => {
    const home = makeHome({
      status: "needs_input", question: "timeout_sec 取哪个值？",
      log: [asst("## 进展\n已完成 3 处修复。")],
    });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toMatch(/^WAIT=needs_input$/m);
    expect(r.stdout).toMatch(/^STATUS=needs_input$/m);
    expect(r.stdout).toMatch(/^QUESTION=timeout_sec 取哪个值/m);
    expect(r.stdout).toMatch(/^REPORT_PATH=/m);
    expect(r.stdout).not.toMatch(/^REPORT_(OUTLINE|TEXT|HEAD)=/m);
    rmSync(home, { recursive: true, force: true });
  });

  it("启动时已是 needs_input：exit 5（不是 2）", async () => {
    const home = makeHome({ status: "needs_input" });
    const r = await runWait(["task_t1", "--home", home]);
    expect(r.exitCode).toBe(5);
    rmSync(home, { recursive: true, force: true });
  });

  it("needs_input 要快醒：sleep 只被调用 0 次（首轮就返回）", async () => {
    const home = makeHome({ status: "needs_input" });
    let sleeps = 0;
    const r = await runWait(["task_t1", "--home", home], { sleep: async () => { sleeps++; } });
    expect(r.exitCode).toBe(5);
    expect(sleeps).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  it("timeout：exit 2，无 QUESTION、无 LOG_PATH/REPORT_*", async () => {
    const home = makeHome({ status: "running", log: [asst("working")] });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/^WAIT=timeout$/m);
    expect(r.stdout).not.toMatch(/^QUESTION=/m);
    expect(r.stdout).not.toMatch(/^LOG_PATH=/m);
    expect(r.stdout).not.toMatch(/^REPORT_/m);
    rmSync(home, { recursive: true, force: true });
  });

  it("--once 查非终态：exit 2（不进入轮询）", async () => {
    const home = makeHome({ status: "running" });
    let sleeps = 0;
    const r = await runWait(["task_t1", "--home", home, "--once"], { sleep: async () => { sleeps++; } });
    expect(r.exitCode).toBe(2);
    expect(sleeps).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  it("not_found：exit 3，仅 3 行且没有 MAX_WAIT_SEC", async () => {
    const home = makeHome({ status: "running" });
    const r = await runWait(["task_missing", "--home", home, "--once"]);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe("TASK_ID=task_missing\nSTATUS=unknown\nWAIT=not_found\n");
    rmSync(home, { recursive: true, force: true });
  });

  it("db_unreadable：exit 6，绝不伪装成 not_found；stderr 指向环境问题与 --copy-dir", async () => {
    const { root, home, copy, dbPath } = legacyWalHome("running");
    chmodSync(home, 0o555);
    chmodSync(copy, 0o555);
    const r = await runWait(["task_x", "--home", home, "--copy-dir", copy]);
    expect(r.exitCode).toBe(6);
    expect(r.stdout).toBe("TASK_ID=task_x\nSTATUS=unknown\nWAIT=db_unreadable\n");
    expect(r.stderr).toContain("environment problem");
    expect(r.stderr).toContain("--copy-dir");
    chmodSync(home, 0o755);
    chmodSync(copy, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it("预算：timeout_sec=120 ⇒ MAX_WAIT_SEC=570；--max-wait-sec 30 ⇒ 30；0 ⇒ 字面量 never；无 timeout_sec ⇒ 7200", async () => {
    const a = makeHome({ status: "running", timeout_sec: 120 });
    expect((await runWait(["task_t1", "--home", a, "--once"])).stdout).toMatch(/^MAX_WAIT_SEC=570$/m);
    rmSync(a, { recursive: true, force: true });

    const b = makeHome({ status: "running", timeout_sec: 3600 });
    expect((await runWait(["task_t1", "--home", b, "--once", "--max-wait-sec", "30"])).stdout)
      .toMatch(/^MAX_WAIT_SEC=30$/m);
    expect((await runWait(["task_t1", "--home", b, "--once", "--max-wait-sec", "0"])).stdout)
      .toMatch(/^MAX_WAIT_SEC=never$/m);
    rmSync(b, { recursive: true, force: true });

    const c = makeHome({ status: "running", timeout_sec: 0 });   // deriveMaxWait 对非正数回退默认
    expect((await runWait(["task_t1", "--home", c, "--once"])).stdout).toMatch(/^MAX_WAIT_SEC=7200$/m);
    rmSync(c, { recursive: true, force: true });
  });

  it("ELAPSED_SEC = (ended_at ?? now) - started_at；终态行含人工等待，不改 DB", async () => {
    const started = 1_000_000;
    const ended = 1_000_905;   // 多轮含人工答复等待：5 + 900 ⇒ 905
    const home = makeHome({ status: "completed", started_at: started, ended_at: ended });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.stdout).toMatch(/^ELAPSED_SEC=905$/m);
    rmSync(home, { recursive: true, force: true });
  });

  it("QUESTION 不改退出码：终态行仍可能带上一轮 question，exit 0 与 WAIT=terminal 不受影响", async () => {
    const home = makeHome({ status: "completed", question: "上一轮的问题？" });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^WAIT=terminal$/m);
    expect(r.stdout).toMatch(/^QUESTION=上一轮的问题/m);
    rmSync(home, { recursive: true, force: true });
  });

  it("ERROR 单行化输出在 FILES_CHANGED 之后", async () => {
    const home = makeHome({ status: "failed", error: "boom\n  with  spaces" });
    const r = await runWait(["task_t1", "--home", home, "--once"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.indexOf("ERROR=boom with spaces")).toBeGreaterThan(lines.indexOf("FILES_CHANGED=0"));
    rmSync(home, { recursive: true, force: true });
  });

  it("--report-out 写失败仍输出 REPORT_PATH（该路径可能不存在）", async () => {
    const home = makeHome({ status: "completed", log: [asst("报告")] });
    const r = await runWait(["task_t1", "--home", home, "--once",
      "--report-out", join(home, "no-such-dir", "report.md")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^REPORT_PATH=/m);
    expect(r.stderr).toContain("could not write report");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("runWait 只读沙箱（copy 降级）与续跑", () => {
  it("copy 降级：DB_SOURCE=copy、stderr 说明、退出时副本目录被清掉", async () => {
    const { root, home, copy, dbPath } = legacyWalHome("completed");
    // 前置断言：干净关闭的 WAL 库目录里只有 tasks.db（WAL 静置），直读必失败才有意义
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(home)).toEqual(["tasks.db"]);
    chmodSync(home, 0o555);
    const r = await runWait(["task_x", "--home", home, "--copy-dir", copy]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^DB_SOURCE=copy$/m);
    expect(r.stderr).toContain("reading a copy under");
    // 退出时副本目录被清掉：copy 根目录里不再有任何 wait 残留
    expect(readdirSync(copy)).toEqual([]);
    chmodSync(home, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it("D1 端到端：copy 模式下，源库推进后 wait 必须醒来而不是 timeout", async () => {
    const { root, home, copy, dbPath } = legacyWalHome("running");
    // 先把目录改只读再启动 wait：fixture 已干净关闭，目录里只剩 tasks.db ⇒ 只读读者建不了 -shm ⇒ 直读必失败。
    // ⚠️ 写侧动作不能在只读目录里做：WAL 写连接要建 -shm，0o555 下 new DatabaseSync 直接抛
    // "unable to open database file"——所以放在 sleep 回调里：先恢复权限 → 改库 → 关闭 → 再恢复只读。
    chmodSync(home, 0o555);
    let polls = 0;
    const sleep = async () => {
      polls++;
      if (polls === 1) {
        chmodSync(home, 0o755);
        const w = new DatabaseSync(dbPath);
        w.prepare("UPDATE tasks SET status='completed', ended_at=? WHERE id='task_x'")
          .run(Math.floor(Date.now() / 1000));
        w.close();
        chmodSync(home, 0o555);   // 恢复只读：后续轮询继续走 copy 重拷路径
      }
    };
    const r = await runWait(["task_x", "--home", home, "--copy-dir", copy,
      "--interval-sec", "1", "--max-wait-sec", "30"], { sleep });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^STATUS=completed$/m);
    expect(r.stdout).toMatch(/^WAIT=terminal$/m);
    chmodSync(home, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it("续跑：同一 id 重起，第二次 wait 读到新状态 exit 0，报告文件被新报告覆盖", async () => {
    const { root, home, copy, dbPath } = legacyWalHome("running");
    chmodSync(home, 0o555);
    const out = join(root, "report.md");
    const first = await runWait(["task_x", "--home", home, "--copy-dir", copy, "--once", "--report-out", out]);
    expect(first.exitCode).toBe(2);   // 还在 running ⇒ timeout
    chmodSync(home, 0o755);
    const w = new DatabaseSync(dbPath);
    w.prepare("UPDATE tasks SET status='completed', ended_at=? WHERE id='task_x'")
      .run(Math.floor(Date.now() / 1000));
    w.close();
    chmodSync(home, 0o555);

    const second = await runWait(["task_x", "--home", home, "--copy-dir", copy, "--report-out", out]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/^WAIT=terminal$/m);
    expect((await import("node:fs")).readFileSync(out, "utf8")).toBe("");   // running 时日志为空 ⇒ 覆盖为空串
    chmodSync(home, 0o755);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("deriveMaxWait", () => {
  it("timeout_sec=120 ⇒ 3*120+90+120=570；非正数 ⇒ 7200", () => {
    expect(deriveMaxWait(120)).toBe(570);
    expect(deriveMaxWait(0)).toBe(7200);
    expect(deriveMaxWait(Number.NaN)).toBe(7200);
  });
});

describe("TaskReader", () => {
  it("直读成功时不产生副本", () => {
    const { root, home, copy, dbPath } = legacyWalHome("completed");
    const r = new TaskReader(dbPath, copy);
    expect(r.read("task_x")?.status).toBe("completed");
    expect(r.dbSource).toBe("direct");
    r.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("直读失败时降级为副本，并把 dbSource 标成 copy", () => {
    const { root, home, copy, dbPath } = legacyWalHome("completed");
    chmodSync(home, 0o555);            // 沙箱：目录禁写 ⇒ 只读读者建不了 -shm
    const r = new TaskReader(dbPath, copy);
    expect(r.read("task_x")?.status).toBe("completed");
    expect(r.dbSource).toBe("copy");
    r.close();
    chmodSync(home, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it("D1：副本模式下，源库变了之后 read() 必须看到新状态（老实现会一直返回旧值）", () => {
    const { root, home, copy, dbPath } = legacyWalHome("running");
    chmodSync(home, 0o555);
    const r = new TaskReader(dbPath, copy);
    expect(r.read("task_x")?.status).toBe("running");     // 第一次读：走 copy 路径
    expect(r.dbSource).toBe("copy");

    // 模拟"写者在沙箱外推进任务"：放开写权限 → 改源库 → 立刻恢复只读
    chmodSync(home, 0o755);
    const w = new DatabaseSync(dbPath);
    w.prepare("UPDATE tasks SET status='completed', ended_at=? WHERE id='task_x'")
      .run(Math.floor(Date.now() / 1000));
    w.close();
    // ⚠️ 必须恢复 0555 再读：不恢复的话直读会成功、dbSource 悄悄变回 "direct"，
    // 这条用例就退化成"直读恢复"、**根本没走重拷副本那段**（写完 -wal 会被 checkpoint 删掉）。
    chmodSync(home, 0o555);

    expect(r.read("task_x")?.status).toBe("completed");    // ← D1 修复点：老实现在这里仍是 "running"
    expect(r.dbSource).toBe("copy");                       // 证明这次确实走了"重建副本"而不是直读
    r.close();
    chmodSync(home, 0o755);   // home 还是 0555，先恢复再清 root，否则清理删不动目录内容
    rmSync(root, { recursive: true, force: true });
  });

  it("两处都读不了时抛异常（上层映射成 db_unreadable，绝不伪装成 not_found）", () => {
    const { root, home, copy, dbPath } = legacyWalHome("running");
    chmodSync(home, 0o555);
    chmodSync(copy, 0o555);
    const r = new TaskReader(dbPath, copy);
    expect(() => r.read("task_x")).toThrow();
    r.close();
    chmodSync(home, 0o755);
    chmodSync(copy, 0o755);
    rmSync(root, { recursive: true, force: true });
  });
});
