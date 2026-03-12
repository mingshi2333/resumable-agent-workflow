#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--dry-run]

Installs this workflow package into the local OpenCode and Claude config directories.

Environment overrides:
  OPENCODE_DIR   Target OpenCode config directory (default: ~/.config/opencode)
  CLAUDE_DIR     Target Claude config directory (default: ~/.claude)
EOF
}

log() {
  printf '%s\n' "$1"
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

copy_tree() {
  local src="$1"
  local dest="$2"

  run mkdir -p "$dest"
  run cp -R "$src/." "$dest/"
}

copy_file() {
  local src="$1"
  local dest="$2"

  run mkdir -p "$(dirname "$dest")"
  run cp "$src" "$dest"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
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

for binary in bun jq opencode; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    printf 'Missing required binary: %s\n' "$binary" >&2
    exit 1
  fi
done

log "Installing resumable-agent-workflow"
log "- source: $ROOT_DIR"
log "- opencode target: $OPENCODE_DIR"
log "- claude target: $CLAUDE_DIR"

copy_tree "$ROOT_DIR/opencode/command" "$OPENCODE_DIR/command"
copy_tree "$ROOT_DIR/opencode/tools" "$OPENCODE_DIR/tools"
copy_file "$ROOT_DIR/opencode/oh-my-opencode-slim.json" "$OPENCODE_DIR/oh-my-opencode-slim.json"
copy_tree "$ROOT_DIR/claude/skills" "$CLAUDE_DIR/skills"

log ""
log "Install complete."
log "Recommended next steps:"
log "1. Run: bash scripts/verify-install.sh"
log "2. In a target repo, run: /workflow-init"
log "3. Then run: /workflow-check"
