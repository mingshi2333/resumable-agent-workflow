#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
REPO_ONLY=0

COMMAND_FILES=(
  "workflow-start.md"
  "deep-interview.md"
  "ralplan.md"
  "review-bridge.md"
  "autopilot.md"
  "workflow-verify.md"
  "workflow-archive.md"
  "workflow-init.md"
  "workflow-validate.md"
  "workflow-check.md"
  "workflow-startup-smoke.md"
  "workflow-e2e-smoke.md"
)

SKILL_DIRS=(
  "deep-interview"
  "ralplan"
  "review-bridge"
  "autopilot"
)

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

check_contains() {
  local path="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$path"; then
    printf 'Missing expected content in %s: %s\n' "$path" "$needle" >&2
    exit 1
  fi
}

check_command_dir() {
  local dir="$1"
  for command_file in "${COMMAND_FILES[@]}"; do
    check_file "$dir/$command_file"
  done
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
check_file "$ROOT_DIR/scripts/workflow-smoke.ts"
check_file "$ROOT_DIR/opencode/tools/workflow.ts"
check_file "$ROOT_DIR/opencode/tools/workflow-model.ts"
check_file "$ROOT_DIR/opencode/docs/workflow-usage.md"
check_command_dir "$ROOT_DIR/opencode/command"
for skill_dir in "${SKILL_DIRS[@]}"; do
  check_file "$ROOT_DIR/claude/skills/$skill_dir/SKILL.md"
done

for export_name in \
  'export const startup_state' \
  'export const workflow_start_runtime' \
  'export const ralplan_runtime' \
  'export const review_bridge_runtime' \
  'export const autopilot_runtime' \
  'export const workflow_verify_runtime' \
  'export const workflow_archive_runtime' \
  'export const execution_dispatch_claim' \
  'export const execution_dispatch_result' \
  'export const smoke_continuation_matrix' \
  'export const workflow_supervisor_runtime' \
  'export const workflow_continue_runtime' \
  'export const session_start' \
  'export const session_status' \
  'export const session_result'
do
  check_contains "$ROOT_DIR/opencode/tools/workflow.ts" "$export_name"
done

check_contains "$ROOT_DIR/opencode/command/workflow-start.md" 'workflow_start_runtime'
check_contains "$ROOT_DIR/opencode/command/workflow-start.md" 'workflow_continue_runtime'
check_contains "$ROOT_DIR/opencode/command/workflow-verify.md" 'workflow_verify_runtime'
check_contains "$ROOT_DIR/opencode/command/workflow-archive.md" 'workflow_archive_runtime'
check_contains "$ROOT_DIR/opencode/command/workflow-startup-smoke.md" 'workflow_start_runtime(confirm)'
check_contains "$ROOT_DIR/opencode/command/workflow-startup-smoke.md" 'workflow_continue_runtime'
check_contains "$ROOT_DIR/opencode/command/workflow-init.md" 'openspec init --tools opencode .'
check_contains "$ROOT_DIR/opencode/docs/workflow-usage.md" 'bash scripts/install.sh'
check_contains "$ROOT_DIR/opencode/docs/workflow-usage.md" '/workflow-init'
check_contains "$ROOT_DIR/opencode/docs/workflow-usage.md" 'openspec init --tools opencode .'
check_contains "$ROOT_DIR/opencode/docs/workflow-usage.md" '`commands/*.md`'

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
check_file "$OPENCODE_DIR/tools/workflow-model.ts"
check_file "$OPENCODE_DIR/docs/workflow-usage.md"
check_command_dir "$OPENCODE_DIR/commands"
check_command_dir "$OPENCODE_DIR/command"
check_file "$OPENCODE_DIR/oh-my-opencode-slim.json"
for skill_dir in "${SKILL_DIRS[@]}"; do
  check_file "$CLAUDE_DIR/skills/$skill_dir/SKILL.md"
done

check_contains "$OPENCODE_DIR/docs/workflow-usage.md" '`commands/*.md`'
check_contains "$OPENCODE_DIR/commands/workflow-check.md" '~/.config/opencode/commands'
check_contains "$OPENCODE_DIR/commands/workflow-check.md" '~/.config/opencode/tools/workflow.ts'
check_contains "$OPENCODE_DIR/command/workflow-check.md" '~/.config/opencode/commands'
check_contains "$OPENCODE_DIR/command/workflow-check.md" '~/.config/opencode/tools/workflow.ts'

bun scripts/workflow-smoke.ts continuation-matrix >/dev/null
bun scripts/workflow-smoke.ts invalid-graph >/dev/null

printf 'Install verification passed.\n'
