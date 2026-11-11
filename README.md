# agent-ex

**Dispatch and review with *external* agents.**

> English README · [中文版 →](https://github.com/wuruofan/agent-ex/blob/main/docs/README.zh-CN.md)

`agent-ex` is an **MCP server** that treats AI coding agents (Claude Code, OpenCode, …) as
*external executors*. You dispatch a self-contained ticket; the agent works in a detached
background process and writes its result back to a SQLite-backed task store — so a long job
never blocks your own conversation.

- The npm package is [`agent-ex-mcp`](https://www.npmjs.com/package/agent-ex-mcp);
  the command it installs is **`agent-ex`**. (The `-mcp` suffix only avoids the registry's
  package-name-similarity rejection for `agent-ex`.)
- The data directory is `~/.agent-ex` (override with `AGENT_EX_HOME`).

Three collaboration shapes — all of them are just a different `submit` prompt, **no extra tool**:

| Shape | How |
| :--- | :--- |
| **Delegate implementation** | `submit(prompt=<self-contained ticket>)` → the worker does the job → `agent-ex wait` brings back the result |
| **Draft a plan independently** | `submit(prompt="read docs/ and the code, write a design to docs/plans/x.md")` |
| **Cross-review** | `submit(prompt="review docs/plans/x.md, list concrete problems by feasibility / gaps / contradictions")` |

## Features

- **External executors** — tasks run in a detached process tree; poll with `status`, stop with `cancel`.
- **Task state machine** — `queued → running → (needs_input → running → …) → completed | failed | cancelled`, up to 5 continuation rounds.
- **Multi-agent, multi-provider** — built-in `claude` and `opencode` executors; each profile carries its own env, model and PATH additions.
- **`needs_input` continuation** — when the agent asks a question the task parks in `needs_input`; feed the answer back with `submit(continue_of=…)`.
- **Transient-error retry** — 429 / 529 / 5xx / connection resets are retried (3 attempts, backoff 30s → 60s). Timeouts and hard failures are never retried.
- **Feishu (Lark) notifications** — a card is pushed when a task reaches a terminal state; `dry_run` lets you debug without sending.
- **No secrets in `config.json`** — the config only holds `{env:VAR}` placeholders; the real values live in `$AGENT_EX_HOME/.env` (mode 600, never in git).
- **Self-diagnosis** — `version` reports the build's `gitSha`; `restart` makes the server exit so the host respawns it with the current build. Running workers are unaffected.

## Requirements

- Node.js **>= 22.5** (the server and the runner both use `node:sqlite`)
- A local agent CLI — `claude` or `opencode`

## Security

Workers run with the agent CLI's **permission prompts skipped** (`claude --dangerously-skip-permissions`,
`opencode --auto`). There is no second confirmation. Use it on your own machine, in directories you trust,
and think about what permissions you are handing the worker.

## Install

```bash
npm i -g agent-ex-mcp
# or, without installing:
npx -y agent-ex-mcp@latest init
```

## Quick start

```bash
agent-ex init
```

`init` is interactive: it detects the agent CLIs, asks for the provider and the keys, writes
`config.json` + `.env`, and then **prints a ready-to-paste MCP registration snippet**.
Copy it into your MCP client config (Trae: `TRAE SOLO CN/User/mcp.json`; WorkBuddy: `~/.workbuddy/mcp.json`):

```jsonc
{
  "mcpServers": {
    "agent-ex": {
      "command": "/abs/path/to/node",          // printed by init
      "args": ["/abs/path/to/node_modules/agent-ex-mcp/dist/server.js"]
    }
  }
}
```

> **Use absolute paths.** MCP clients spawn the server **without inheriting your shell `PATH`**,
> and `node_modules/.bin` is only injected for `npm run` / `npx`. With `PATH=/usr/bin:/bin`,
> a bare `"command": "agent-ex"` fails with `command not found`; an absolute path works.
> `init` prints the exact absolute paths it used — just copy them.
>
> ```bash
> which node        # e.g. /Users/<you>/.nvm/versions/node/v24.18.0/bin/node
> ```

After that, just say "dispatch X to a background worker" in your conversation. When the task
reaches a terminal state you get a Feishu notification (if you configured a webhook).

`init` re-runs are **full overwrites** of `config.json` — to change a single setting use
`agent-ex config set` / `agent-ex profile set` instead. Details:
[init guide](https://github.com/wuruofan/agent-ex/blob/main/docs/user-guide/init.md).

## Optional: install the dispatch skill

The MCP tools are the low-level capability. The **dispatch skill** is the convention layered on top:
when to delegate, how to write a self-contained ticket, why two *write* tasks must not run in the
same directory, how to continue a `needs_input` task — and when not to delegate at all.

The skill ships **inside the npm package**, so installing it is one command:

```bash
agent-ex skill install
```

It does three things:

1. copies `skills/agent-ex-dispatch` into `~/.agents/skills/agent-ex-dispatch`
   (the shared directory of the Agent Skills spec);
2. writes `.agent-ex-skill.json` next to it, recording the **version** and a content fingerprint —
   `agent-ex skill status` and `agent-ex doctor` use it to tell "which version is installed";
3. symlinks it into every host that is present on this machine and should have it
   (Claude Code, Cursor, Windsurf, Trae, Trae CN, GitHub Copilot, Gemini CLI, OpenCode, Droid,
   Amp, Qwen Code, MiniMax Code, CodeBuddy, WorkBuddy).

Things worth knowing:

- **Version stays in sync with the CLI** — the skill's version *is* the `agent-ex-mcp` version that
  shipped it. Published packages are immutable, so an installed skill always matches your CLI.
  Re-run `agent-ex skill install` after upgrading; it asks before replacing anything.
- **It never overwrites foreign content** — if the target path already holds a real directory that
  agent-ex did not install, the command aborts and changes nothing.
- **Hosts that bridge themselves are skipped** — WorkBuddy only scans `~/.workbuddy/skills`, but most
  WorkBuddy installs ship an auto-bridge script (`~/.workbuddy/hooks/sync-agents-skills.sh`) that
  mirrors `~/.agents/skills` itself. Without that script, name it explicitly:
  `agent-ex skill install --agent workbuddy`.
- **Hosts that read the shared directory are never linked** — Codex, Cline and Zed read
  `~/.agents/skills` itself, so a link could only point back at the canonical copy.
  `agent-ex skill status` lists them as "reads ~/.agents/skills — no link needed".
- **Pick hosts yourself with `--agent`** — by default agent-ex links the hosts it finds on this
  machine (their config directory exists: `~/.claude`, `~/.cursor`, `~/.config/opencode`, …).
  `--agent <name>` restricts the install to the hosts you name and links them without asking:

  ```bash
  agent-ex skill install --agent cursor --agent claude-code   # ids and aliases both work
  agent-ex skill install --agent '*'                          # every host that needs a link
  agent-ex skill remove --agent cursor                        # that host only; the rest stays
  ```

  An unknown name is an error — nothing gets written.
- **Non-interactive shells refuse to run it** (exit code 2) unless you pass `--yes`:
  `install` / `remove` create, re-point and delete things. `--yes` means "answer every question
  with yes", **not** "link every host".

Inspect with `agent-ex skill status` (read-only), uninstall with `agent-ex skill remove`.

## CLI commands

`agent-ex` is both the MCP server and the entry point for a few operational commands:

| Command | What it does |
| :--- | :--- |
| `agent-ex init` | Interactive onboarding (detects CLIs, writes `config.json` + `.env`). Re-running overwrites `config.json`; it lists the diff and asks first, and backs up the old file. |
| `agent-ex doctor` | Health check: aggregates the evidence for "does the notification path work" into a verdict + cause + copy-pasteable fix. **Read-only.** |
| `agent-ex doctor --fix` | Auto-fixes *deterministic* defects (empty keyword, stale brand name, a plaintext webhook left in `config.json`). Never touches `dry_run` (that is your preference) nor a custom keyword (that is your bot's UI). |
| `agent-ex doctor --send` | Additionally sends a self-test card whose body deliberately contains no product name. |
| `agent-ex config list` | Shows profiles / executors / notify / defaults. |
| `agent-ex config set <key> <value>` | Changes one field. Whitelist: `notify.dry_run`, `notify.keyword`, `defaults.timeout_sec`, and `executors.<name>.bin`. |
| `agent-ex profile list` | Lists all profiles (marks the default one). |
| `agent-ex profile use <profile>` | Switches the default profile. |
| `agent-ex profile create <built-in> [--bin <path>]` | Materialises a built-in preset (`opencode-zen-free` — a zero-key opencode free-model profile). Creates only; does not switch. |
| `agent-ex profile set <profile> <KEY> <value>` | Changes a profile's env, or `executor` (which executor it uses), or `path_dirs` (extra absolute PATH directories for the worker). |
| `agent-ex wait <task_id>` | Blocks until the task is terminal (or needs input) and prints the worker's final report. |
| `agent-ex skill install` | Installs the dispatch skill from the package and links it into the hosts that should have it. `--agent <name>` restricts it to the hosts you name. |
| `agent-ex skill remove` | Uninstalls: removes the host symlinks and the installed copy. **Only symlinks** — a real directory is never touched; the exit code is non-zero if anything was left behind. |
| `agent-ex skill status` | Read-only: where it is installed, which version, which hosts are not linked yet. |

There is a matching `agent_ex_doctor` MCP tool, so an agent can diagnose itself without you
copy-pasting commands.

### `agent-ex wait`

```bash
agent-ex wait task_abc123                    # wait for a terminal state or needs_input
agent-ex wait task_abc123 --once             # check once and return
agent-ex wait task_abc123 --max-wait-sec 900 # pick your own window
```

stdout is machine-readable `KEY=VALUE`; the **exit code is the contract**:
`0` terminal, `5` needs_input (not terminal — answer and wait again on the same id),
`2` timeout, `3` not found, `6` database unreadable (an environment problem, not a task problem),
`4` bad arguments. Full contract:
[task lifecycle](https://github.com/wuruofan/agent-ex/blob/main/docs/user-guide/state-machine.md).

## MCP tools

| Tool | Arguments | Returns |
| :--- | :--- | :--- |
| `agent_ex_submit` | `prompt` (required), `project_path`, `profile`, `continue_of`, `timeout_sec` | `{ task_id, status, rounds }` |
| `agent_ex_status` | `task_id`, `include_finished` (0.3.1+), `limit` | task fields; `question` when `needs_input` |
| `agent_ex_cancel` | `task_id` (required) | current state (idempotent on terminal tasks) |
| `agent_ex_version` | — | `{ version, gitSha, buildTime }` |
| `agent_ex_doctor` | `send` (optional) | findings with severity / detail / fix |
| `agent_ex_restart` | — | the server exits; the host respawns it |

> Tool names are sometimes prefixed by the host (e.g. `mcp__agent-ex__agent_ex_submit`).

The server is stateless — everything lives in `tasks.db`. `restart` does not affect running workers
(they live in their own process groups) nor other live server instances.

## Configuration

```jsonc
{
  "executors": {
    "claude":   { "bin": "/abs/path/to/claude", "extra_flags": ["--dangerously-skip-permissions"] },
    "opencode": { "bin": "/abs/path/to/opencode", "extra_flags": ["--auto"] }
  },
  "profiles": {
    "minimax-3": {
      "executor": "claude",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "{env:MINIMAX_API_KEY}",
        "ANTHROPIC_MODEL": "MiniMax-M3[1m]"
      }
    }
  },
  "notify": {
    "feishu_webhook_url": "{env:FEISHU_WEBHOOK_URL}",
    "dry_run": true,
    "keyword": "agent-ex"
  },
  "defaults": { "profile": "minimax-3", "timeout_sec": 3600 }
}
```

| Field | What it does |
| :--- | :--- |
| `executors.<name>.bin` | Where the agent CLI lives — **a bare command name or an absolute path both work**. |
| `profiles.<name>.env` | Environment for the agent process. `{env:VAR}` placeholders are resolved at task runtime. **Never put `PATH` / `NODE_OPTIONS` / `LD_*` / `DYLD_*` here** — that is the worker's process-loading surface, i.e. arbitrary code execution. |
| `profiles.<name>.path_dirs` | Extra **absolute** directories appended to the worker's `PATH`. This is the only supported way to extend the worker's PATH. |
| `notify.dry_run` | `true` (default) prints the card to stderr instead of sending it. |
| `notify.keyword` | The keyword appended to every card. Defaults to `agent-ex`; it must match the keyword registered on the bot side. |
| `defaults.profile` / `defaults.timeout_sec` | Default profile, and the per-round timeout in seconds. |

Secrets never live in `config.json`: write `{env:VAR}` placeholders there and the real values into
`$AGENT_EX_HOME/.env` (mode 600, auto-loaded by the server at startup).

Full reference — every field, `{model:zen-free}`, the `[1m]` context-window trick, `path_dirs`,
the write whitelist:
[configuration guide](https://github.com/wuruofan/agent-ex/blob/main/docs/user-guide/configuration.md).

## Notifications

Notifications go to a Feishu (Lark) **custom bot** webhook. The tool only supports the
"keyword" security mode — **do not enable signature verification**, the tool does not send
`timestamp`/`sign` and every card would be rejected.

Verify the path with a self-test card instead of a real task report:

```bash
agent-ex doctor --send
```

| Feishu `code` | Meaning |
| :--- | :--- |
| `0` | delivered |
| `19024` | keyword mismatch — the bot's keyword and `notify.keyword` disagree |
| `19021` | signature verification failed — the bot has "加签" enabled; turn it off |
| `19001` | the webhook URL itself is invalid — copy a new one |
| `19022` | IP allow-list rejected the call |

Full walkthrough (bot setup, the security-mode matrix, every error code):
[notifications guide](https://github.com/wuruofan/agent-ex/blob/main/docs/user-guide/notifications.md).

## Troubleshooting

| Symptom | Likely cause |
| :--- | :--- |
| `executor "claude" bin "…" not found or not executable` | Wrong path, or the file is not `+x`. A bare name is resolved against `process.env.PATH`. |
| Task fails with `failed to spawn runner: … ENOENT` | The directory holding `bin` has no executable. The worker's `PATH` is rebuilt from `dirname(bin)` + `path_dirs` + system dirs — `/opt/homebrew/bin` is not included unless you declare it in `path_dirs`. |
| `{env:VAR}` fails with `not found in process environment` | The key is neither in `.env` nor exported to the server process. Add it to `$AGENT_EX_HOME/.env` and restart the server. |
| Feishu sends nothing | `notify.dry_run` is still `true`; or the webhook is missing; or the bot has signature verification enabled (`code=19021`). |
| Behaviour did not change after editing code | The MCP host reuses a long-lived server process. Rebuild, then `restart`, then check `gitSha` with `version`. |
| The skill is installed but the host does not load it | Run `agent-ex skill status` to see which hosts are not linked, then `agent-ex skill install --agent <host>`. |

## Documentation

| Document | Contents |
| :--- | :--- |
| [中文版 README](https://github.com/wuruofan/agent-ex/blob/main/docs/README.zh-CN.md) | The same guide in Chinese |
| [配置详解](https://github.com/wuruofan/agent-ex/blob/main/docs/user-guide/configuration.md) | Every `config.json` field, secrets, model resolution, worker PATH |
| [飞书通知详解](https://github.com/wuruofan/agent-ex/blob/main/docs/user-guide/notifications.md) | Bot setup, security modes, error codes |
| [任务生命周期与状态机](https://github.com/wuruofan/agent-ex/blob/main/docs/user-guide/state-machine.md) | State machine, continuation, `agent-ex wait` contract |
| [init 详解](https://github.com/wuruofan/agent-ex/blob/main/docs/user-guide/init.md) | The onboarding wizard step by step |
| [AGENTS.md](https://github.com/wuruofan/agent-ex/blob/main/AGENTS.md) | Maintainer guide: hard constraints, release process |
| [CHANGELOG.md](https://github.com/wuruofan/agent-ex/blob/main/CHANGELOG.md) | Version history |

## License

MIT
