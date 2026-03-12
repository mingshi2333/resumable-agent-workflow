---
description: Check workflow artifact consistency, environment health, and runtime-wrapper drift
---

Run a workflow health check against the current project.

Operation model:
- default invocation: full health check
- `summary`: compact red/yellow/green conclusion and next-step guidance only

Normal path:
1. Inspect the latest workflow artifacts in this order:
   - latest `.opencode/handoffs/handoff-*.json`
   - linked `.opencode/reviews/review-*.json`
2. If a latest handoff exists, run `workflow_validate` against it, including the linked review artifact when present.
3. Check that required runtime directories exist:
   - `.opencode/state`
   - `.opencode/specs`
   - `.opencode/plans`
   - `.opencode/executions`
   - `.opencode/executions/results`
   - `.opencode/handoffs`
   - `.opencode/reviews`
   - `.opencode/verifications`
   - `.opencode/archives`
   - `.opencode/context`
   - `.opencode/sessions`
4. Check required binaries are available:
   - `bun`
   - `jq`
   - `opencode`
5. Check required command files exist:
   - `command/workflow-start.md`
   - `command/deep-interview.md`
   - `command/ralplan.md`
   - `command/review-bridge.md`
   - `command/autopilot.md`
   - `command/workflow-verify.md`
   - `command/workflow-archive.md`
   - `command/workflow-init.md`
   - `command/workflow-validate.md`
   - `command/workflow-check.md`
6. Check required runtime helper exports exist in `opencode/tools/workflow.ts` (installed as `tools/workflow.ts`):
   - `export const startup_state`
   - `export const workflow_start_runtime`
   - `export const ralplan_runtime`
   - `export const review_bridge_runtime`
   - `export const autopilot_runtime`
   - `export const workflow_verify_runtime`
   - `export const workflow_archive_runtime`
   - `export const execution_dispatch_claim`
   - `export const execution_dispatch_result`
   - `export const smoke_continuation_matrix`
   - `export const workflow_supervisor_runtime`
   - `export const workflow_continue_runtime`
   - `export const session_start`
   - `export const session_status`
   - `export const session_result`
7. Run documentation drift checks:
   - `command/workflow-start.md` contains both `startup-<slug>.json` and `awaiting-confirmation`
   - `command/workflow-e2e-smoke.md` contains `runtime-wrapper-first main path`
   - `command/review-bridge.md` contains both `review-bridge` and `{{ARGUMENTS}}`
   - `command/ralplan.md` contains `ralplan_runtime`
   - `command/autopilot.md` contains `autopilot_runtime`
   - `command/workflow-start.md` contains `workflow_start_runtime`
   - `command/workflow-verify.md` contains `workflow_verify_runtime`
   - `command/workflow-archive.md` contains `workflow_archive_runtime`
   - `command/ralplan.md`, `command/review-bridge.md`, `command/autopilot.md`, `command/workflow-verify.md`, and `command/workflow-archive.md` mention `background_task`
   - `~/.claude/skills/deep-interview/SKILL.md` contains `runtime-backed command paths`

Evaluation rules:
- hard blocker: missing required artifact, failed `workflow_validate`, missing required directory/binary/helper export
- soft warning: no current handoff, no linked review on latest handoff, or wording drift checks fail
- green: no hard blockers and no warnings
- yellow: no hard blockers but one or more warnings
- red: one or more hard blockers

Output rules:
- In default mode, summarize hard blockers first, then soft warnings, then the most useful next steps.
- In `summary` mode, preserve the compact red/yellow/green conclusion and next-step guidance.
- If there is no next action, say: `No immediate action needed. Continue with the next workflow stage.`
