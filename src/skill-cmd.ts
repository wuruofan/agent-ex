/**
 * `agent-ex skill` 的 CLI 入口 —— `install` / `remove` / `status`。
 *
 * 为什么独立成模块而不是放进 `src/cli.ts`：`cli.ts:8` 静态 import `./doctor.js`
 * → `model-check.js` → `executors/types.js` → claude/opencode/fake。
 * 把 `runSkill` 放那儿会让一个**纯文件操作**拖进整套 executor 依赖
 * （不违反 AGENTS 硬约束 7 的字面禁令，但违反"每个分支都要用且便宜"的精神）。
 *
 * 这个模块只 import `skill.ts` + node 内置 ⇒ 轻。
 */
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  SKILL_NAME,
  canonicalPath,
  collectSkillIssues,
  installSkill,
  removeSkill,
  skillStatus,
  type ConfirmFn,
  type SkillActionResult,
} from "./skill.js";
import { ansi } from "./ansi.js";
import { MARK } from "./marks.js";

const USAGE = [
  `usage: agent-ex skill <install|remove|status> [options]`,
  "",
  "options:",
  "  --target <dir>   extra host directory to link into (repeatable)",
  "  --source <dir>   skill source directory (default: the bundled copy)",
  "  --link           developer route: symlink the source instead of copying it",
  "  --yes            answer every question with yes (required in non-interactive shells)",
  "  -h, --help       show this help",
].join("\n");

interface ParsedArgs {
  sub: string;
  targets: string[];
  source?: string;
  link: boolean;
  yes: boolean;
  help: boolean;
  error?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { sub: "", targets: [], link: false, yes: false, help: false };
  const rest = [...args];
  while (rest.length > 0) {
    const a = rest.shift()!;
    if (a === "--target") {
      const v = rest.shift();
      if (!v) {
        out.error = "--target needs a directory";
        return out;
      }
      out.targets.push(v);
    } else if (a === "--source") {
      const v = rest.shift();
      if (!v) {
        out.error = "--source needs a directory";
        return out;
      }
      out.source = v;
    } else if (a === "--link") {
      out.link = true;
    } else if (a === "--yes" || a === "-y") {
      out.yes = true;
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    } else if (a.startsWith("-")) {
      out.error = `unknown option "${a}"`;
      return out;
    } else if (!out.sub) {
      out.sub = a;
    } else {
      out.error = `unexpected argument "${a}"`;
      return out;
    }
  }
  return out;
}

/**
 * 提问回调。
 *
 * 非交互环境（管道 / CI）且没给 `--yes` ⇒ **拒绝**，不猜。
 * `install --yes` 会给宿主建链/重指，`remove --yes` 会删链删目录 —— 这些不该在 CI 里静默发生。
 */
function makeConfirm(yes: boolean): ConfirmFn {
  return async (question: string, defaultYes: boolean): Promise<boolean> => {
    if (yes) return true;
    if (!process.stdin.isTTY) {
      throw new Error(
        `cannot ask interactively (not a TTY): "${question}"\n` +
          `Re-run with --yes to answer yes to every question.`,
      );
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const hint = defaultYes ? "(Y/n)" : "(y/N)";
      const ans = (await rl.question(`${question} ${hint}: `)).trim().toLowerCase();
      if (ans === "") return defaultYes;
      return ans === "y" || ans === "yes";
    } finally {
      rl.close();
    }
  };
}

function printResult(r: SkillActionResult): void {
  for (const l of r.lines) console.log(`  ${l}`);
  for (const e of r.errors) console.error(`${ansi.red(MARK.error)} ${e}`);
}

function printStatus(userHome: string, source?: string): number {
  const st = skillStatus({ userHome, source });
  console.log(`\n${ansi.bold("Skill:")} ${SKILL_NAME}`);
  console.log(`  bundled   ${st.bundled.dir}  ${ansi.dim(`(v${st.bundled.version}, sha ${st.bundled.sha ?? "-"})`)}`);
  const c = st.canonical;
  const label =
    c.state === "missing"
      ? ansi.dim("not installed")
      : c.state === "managed-copy"
        ? `[copy v${c.marker?.version}]`
        : c.state === "adoptable"
          ? "[present, not installed by agent-ex]"
          : c.state === "foreign-dir"
            ? ansi.yellow("[not managed by agent-ex]")
            : `[link -> ${c.target}]`;
  let extra = "";
  if (c.updateAvailable) extra = ansi.yellow(`  UPDATE AVAILABLE (${c.marker?.version} -> ${st.bundled.version})`);
  else if (c.state === "managed-copy") extra = ansi.dim("  up-to-date");
  if (c.modified) extra += ansi.yellow("  LOCAL MODIFICATIONS");
  console.log(`  canonical ${c.path}  ${label}${extra}`);
  console.log(`\n${ansi.bold("Hosts:")}`);
  for (const h of st.hosts) {
    const p = h.state.path;
    if (h.state.kind === "link") {
      console.log(`  ${ansi.green(MARK.ok)} ${p}  ${ansi.dim(`-> ${h.state.target}`)}`);
    } else if (h.state.kind === "missing") {
      const note = h.autoBridge ? ansi.dim("  (auto-bridges ~/.agents/skills — no link needed)") : "";
      console.log(`  ${ansi.dim(MARK.info)} ${p}  ${ansi.dim("not linked")}${note}`);
    } else if (h.state.kind === "broken-link") {
      console.log(`  ${ansi.yellow(MARK.warn)} ${p}  ${ansi.dim("broken link")}`);
    } else {
      console.log(`  ${ansi.yellow(MARK.warn)} ${p}  ${ansi.dim("exists, not a symlink")}`);
    }
  }
  console.log("");
  return 0;
}

export async function runSkill(args: string[]): Promise<number> {
  const p = parseArgs(args);
  if (p.help || (!p.sub && args.length === 0)) {
    console.log(USAGE);
    return p.help ? 0 : 2;
  }
  if (p.error) {
    console.error(`${ansi.red(MARK.error)} ${p.error}\n\n${USAGE}`);
    return 2;
  }
  if (p.sub !== "install" && p.sub !== "remove" && p.sub !== "status") {
    console.error(`${ansi.red(MARK.error)} Unknown subcommand "${p.sub}"\n\n${USAGE}`);
    return 2;
  }

  const userHome = homedir();
  const confirm = makeConfirm(p.yes);

  try {
    if (p.sub === "status") {
      return printStatus(userHome, p.source);
    }

    if (p.sub === "install") {
      const r = await installSkill({
        userHome,
        source: p.source,
        mode: p.link ? "link" : "copy",
        targets: p.targets,
        yes: p.yes,
        confirm,
      });
      printResult(r);
      return r.ok ? 0 : 1;
    }

    // remove
    const r = await removeSkill({
      userHome,
      source: p.source,
      targets: p.targets,
      yes: p.yes,
      confirm,
    });
    printResult(r);
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error(`${ansi.red(MARK.error)} ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

/** 给 doctor 用的薄封装（保持 skill 逻辑只在一处）。 */
export { collectSkillIssues, canonicalPath };
