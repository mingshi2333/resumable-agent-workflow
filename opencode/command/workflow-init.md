---
description: Initialize local workflow runtime directories and readiness for deep-interview planning review and execution
allowed-tools: Bash(*), Read
---

## Workflow Initialization

!`sh -lc 'set -e; mkdir -p .opencode/state .opencode/specs .opencode/plans .opencode/executions .opencode/executions/results .opencode/handoffs .opencode/reviews .opencode/verifications .opencode/archives .opencode/context .opencode/sessions; printf "WORKFLOW INIT\n\n"; for d in .opencode/state .opencode/specs .opencode/plans .opencode/executions .opencode/executions/results .opencode/handoffs .opencode/reviews .opencode/verifications .opencode/archives .opencode/context .opencode/sessions; do printf "READY %s\n" "$d"; done; if [ -f openspec/AGENTS.md ]; then printf "OPENSPEC already initialized\n"; elif command -v openspec >/dev/null 2>&1; then if openspec init --tools opencode . >/dev/null 2>&1; then printf "OPENSPEC initialized for opencode\n"; else status=$?; printf "OPENSPEC init failed (exit %s)\n" "$status"; exit "$status"; fi; else printf "OPENSPEC skipped (binary unavailable)\n"; fi; printf "\nDONE\n"'`

## Your task

Summarize what was initialized as the default local durable store policy, include whether OpenSpec was already present, initialized, or skipped, then recommend running `/workflow-check` if the user wants a post-init verification.
