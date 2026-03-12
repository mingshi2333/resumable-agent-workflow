#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
REPO_ONLY=0

usage() {
  cat <<'EOF'
Usage: scripts/verify-install.sh [--repo-only]

Checks that the source repo contains the expected packaging assets.
Without --repo-only, it also verifies the installed files in the local environment.

Environment overrides:
  OPENCODE_DIR   Target OpenCode config directory (default: ~/.config/opencode)
  CLAUDE_DIR     Target Claude config directory (default: ~/.claude)
EOF
}

check_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    printf 'Missing file: %s\n' "$path" >&2
    exit 1
  fi
}

for arg in "$@"; do
  case "$arg" in
    --repo-only)
      REPO_ONLY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

check_file "$ROOT_DIR/README.md"
check_file "$ROOT_DIR/package.json"
check_file "$ROOT_DIR/tsconfig.json"
check_file "$ROOT_DIR/scripts/install.sh"
check_file "$ROOT_DIR/opencode/tools/workflow.ts"
check_file "$ROOT_DIR/opencode/command/deep-interview.md"
check_file "$ROOT_DIR/opencode/command/workflow-check.md"
check_file "$ROOT_DIR/claude/skills/deep-interview/SKILL.md"

if [[ "$REPO_ONLY" -eq 1 ]]; then
  printf 'Repository packaging check passed.\n'
  exit 0
fi

for binary in bun jq opencode; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    printf 'Missing required binary: %s\n' "$binary" >&2
    exit 1
  fi
done

check_file "$OPENCODE_DIR/tools/workflow.ts"
check_file "$OPENCODE_DIR/command/deep-interview.md"
check_file "$OPENCODE_DIR/command/workflow-check.md"
check_file "$OPENCODE_DIR/oh-my-opencode-slim.json"
check_file "$CLAUDE_DIR/skills/deep-interview/SKILL.md"
check_file "$CLAUDE_DIR/skills/ralplan/SKILL.md"
check_file "$CLAUDE_DIR/skills/review-bridge/SKILL.md"
check_file "$CLAUDE_DIR/skills/autopilot/SKILL.md"

printf 'Install verification passed.\n'
