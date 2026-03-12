---
description: Initialize local workflow runtime directories and readiness for deep-interview planning review and execution
allowed-tools: Bash(*), Read
---

## Workflow Initialization

!`sh -lc 'set -e; mkdir -p .opencode/state .opencode/specs .opencode/plans .opencode/executions .opencode/executions/results .opencode/handoffs .opencode/reviews .opencode/verifications .opencode/archives .opencode/context .opencode/sessions; printf "WORKFLOW INIT\n\n"; for d in .opencode/state .opencode/specs .opencode/plans .opencode/executions .opencode/executions/results .opencode/handoffs .opencode/reviews .opencode/verifications .opencode/archives .opencode/context .opencode/sessions; do printf "READY %s\n" "$d"; done; printf "\nDONE\n"'`

## Your task

Summarize what was initialized as the default local durable store policy, then recommend running `/workflow-check` if the user wants a post-init verification.
