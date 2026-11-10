#!/usr/bin/env bash
#
# install-skill.sh — 开发者路线：把仓库里的 dispatch skill 链到宿主目录。
#
# 实现已经收敛到 src/skill.ts（与 `agent-ex skill install` 是同一套逻辑），
# 这个脚本只做转发 —— 避免 bash 与 TS 两份实现各自漂移。
#
# 与旧版脚本的差异（**有意的破坏性变更**）：
#   - 旧版把 skill 软链到 ~/.agents/skills + ~/.workbuddy/skills；
#     现在 ~/.agents/skills/agent-ex-dispatch 就是 canonical（由 --link 直接建），
#     所以默认的额外目标只剩 ~/.workbuddy/skills。
#   - 旧版的默认目标列表里含 ~/.agents/skills —— 那个位置现在是 canonical 本身，
#     传进去会变成自链，所以**不再**作为 --target 传。
#
# 用法：
#   ./install-skill.sh                         # 默认：额外链到 ~/.workbuddy/skills
#   ./install-skill.sh ~/.some/other/skills    # 显式指定额外目标
#   AGENT_EX_SKILL_TARGETS="a:b" ./install-skill.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_NAME="agent-ex-dispatch"

# 目标优先级：位置参数 > AGENT_EX_SKILL_TARGETS > 默认
TARGETS=()
if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
elif [ -n "${AGENT_EX_SKILL_TARGETS:-}" ]; then
  IFS=':' read -ra TARGETS <<< "$AGENT_EX_SKILL_TARGETS"
else
  TARGETS=("$HOME/.workbuddy/skills")
fi

# 展开开头的 ~ 并丢掉空段。
#   - ~ 展开：位置参数里的 ~ 由**调用方**的 shell 展开，但 AGENT_EX_SKILL_TARGETS
#     里的 ~ 是变量值、调用方不会展开 ⇒ 不在这里展开的话会真的建出一个叫 "~" 的目录。
#   - 空段：env 值写成 "a::b" 或以 ":" 结尾时，IFS 切分会产生空串；
#     空串传给 --target 会被当成"当前目录"，装出一个 ./agent-ex-dispatch。
#   - 相对路径按 **$HOME** 展开（不是 cwd！）：CLI 侧 `resolve()` 按 cwd 解析，
#     而这个脚本常在仓库根跑 ⇒ 相对路径会把目录建进**源码树**（2026-11-10 第三轮评审 P3-c）。
EXPANDED=()
for t in "${TARGETS[@]}"; do
  t="${t/#\~/$HOME}"
  case "$t" in
    /*) ;;                       # 已经是绝对路径
    *)  t="$HOME/$t" ;;           # 相对路径按 $HOME 展开
  esac
  [ -n "$t" ] || continue
  EXPANDED+=("$t")
done

# ⚠️ **判空必须在数组赋值之前**：macOS 自带的 bash 3.2 在 `set -u` 下展开**空数组**
#    会报 "EXPANDED[@]: unbound variable"（bash 4.4 才修的）。实测：
#    AGENT_EX_SKILL_TARGETS=":" ⇒ 旧写法直接崩在数组赋值那一行。
if [ "${#EXPANDED[@]}" -eq 0 ]; then
  echo "ERROR: no target directory (check AGENT_EX_SKILL_TARGETS)" >&2
  exit 1
fi
TARGETS=("${EXPANDED[@]}")

ARGS=()
for t in "${TARGETS[@]}"; do
  ARGS+=(--target "$t")
done

echo "Canonical skill: $REPO_ROOT/skills/$SKILL_NAME"
echo "Extra targets:"
printf '  - %s\n' "${TARGETS[@]}"
echo

# 用 tsx 跑源码（开发者的 source of truth，改完即时生效，不要求先 build）。
# ⚠️ --yes：这个脚本是"开发者路线"的一次性动作，交互提问在 CI/脚本里会直接失败。
# 交互式重指（链到别处）由 `agent-ex skill install` 本身处理，不走这个脚本。
# ⚠️ 用 `|| rc=$?` 而不是 `set -e` 直接中断：装链失败也要把下面的运行时检查打出来。
rc=0
if [ -x "$REPO_ROOT/node_modules/.bin/tsx" ]; then
  "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/src/server.ts" skill install --link --yes \
    --source "$REPO_ROOT/skills/$SKILL_NAME" "${ARGS[@]}" || rc=$?
else
  echo "ERROR: tsx not found. Run 'npm install' in $REPO_ROOT first." >&2
  exit 1
fi

# The skill's wait step is no longer a bundled script. Make sure the CLI exists.
echo
if command -v agent-ex >/dev/null 2>&1; then
  echo "Runtime check: 'agent-ex' found. Verify the version with: agent-ex wait --help"
  echo "  (exit 0 + 'usage: agent-ex wait <task_id>' means >= 0.3.0; exit 2 means an old package)"
else
  echo "Runtime check: 'agent-ex' NOT on PATH — the skill's wait step needs agent-ex-mcp >= 0.3.0."
  echo "  For this checkout:  npm link      # run from the repo root"
  echo "  For a normal install: npm i -g agent-ex-mcp"
fi

exit "$rc"
