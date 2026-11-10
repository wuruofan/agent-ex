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

ARGS=()
for t in "${TARGETS[@]}"; do
  ARGS+=(--target "$t")
done

echo "Canonical skill: $REPO_ROOT/skills/$SKILL_NAME"
echo "Extra targets:"
printf '  - %s\n' "${TARGETS[@]}"
echo

# 用 tsx 跑源码（开发者的 source of truth，改完即时生效，不要求先 build）。
if [ -x "$REPO_ROOT/node_modules/.bin/tsx" ]; then
  exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/src/server.ts" skill install --link \
    --source "$REPO_ROOT/skills/$SKILL_NAME" "${ARGS[@]}"
fi

echo "ERROR: tsx not found. Run 'npm install' in $REPO_ROOT first." >&2
exit 1
