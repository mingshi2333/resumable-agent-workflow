---
description: Run consensus planning from an OpenSpec change or deep-interview spec
---

Run `ralplan_runtime` as the primary workflow surface, then use the `ralplan` skill for the planning reasoning it orchestrates.

Supervisor rule:
- the parent flow is the planning orchestrator, not the planner itself
- create or resume the runtime session first
- read the persisted planning context packet from the session metadata
- launch the actual planner as a `background_task`
- persist the launched worker handle back onto `planning_session` via `session_update` (use `session_url` and `metadata.delegate_task_id` / `metadata.delegate_launch_handle` when available)
- wait with `background_output`
- refresh `metadata.delegate_last_output_at` while polling so resume/debug can distinguish a live worker from a stuck one
- only then call `ralplan_runtime(result)` with the delegate-produced final plan
- if `ralplan_runtime(start|resume)` returns a pending session but the canonical draft plan file is still missing, treat that as an orchestrator failure and repair it immediately instead of leaving the session silently queued
- if the planner delegate cannot be launched, mark the planning session `failed` or keep the handoff explicitly blocked/planned with a surfaced blocker; never leave a new session indefinitely `queued` with no worker and no durable draft

The command should operate with structured sync planning session semantics:
- resolve or infer the planning target
- create or resume a `planning_session`
- support `start|resume|status|result` style behavior through the workflow session helpers
- keep in-phase planning scratch optional while persisting the final planning outcome deterministically
- keep the user in the active planning flow while planning is still in progress
- automatically continue into `/review-bridge` after successful terminal planning unless a real blocker stops the workflow

Operation model:
- default invocation: `start-or-resume`
- explicit operations: `start`, `resume`, `status`, `result`
- `status` and `result` are read-oriented and must not create a new session

If no arguments are provided, infer the target from the current context in this order:
1. latest `.opencode/handoffs/handoff-*.json`
2. active OpenSpec change in the workspace
3. latest `.opencode/plans/plan-*.md`
4. latest `.opencode/specs/*.md`

If the inferred handoff exposes `startup_state_path`, reload the paired `.opencode/state/startup-<slug>.json` first and treat a confirmed startup brief as canonical planning input. Use the stored goal summary, codebase context, likely file targets, and risks so a startup-confirmed request can continue into planning without the user manually reframing it.

If no target can be inferred safely, ask the user which change, plan, or spec to use.

On session start or resume, return a structured result containing at least:
- `session_id`
- `session_status`
- `target_slug`
- `change_id` when available
- `consensus_plan_path`
- `next_expected_input`
- `resume_hint`

Follow the skill's full protocol: resolve the primary artifact, validate any incoming handoff state, read OpenSpec context first when available, create or resume a `planning_session`, keep draft-by-draft planning state phase-local when safe, produce the final consensus plan under `.opencode/plans/`, refresh `.opencode/handoffs/` to `review-required` only after the final plan is written, and keep OpenSpec valid.

When writing `## Implementation Steps`, support task-DAG annotations in step lines:
- `[parallel:<group>]` marks steps that may run in the same parallel group after the current serial anchor
- `[depends-on:step-1,step-2]` declares explicit dependencies by step id

Example:
- `1. Prepare shared inputs`
- `2. [parallel:ui] Implement UI changes`
- `3. [parallel:api] Implement API changes`
- `4. [depends-on:step-2,step-3] Reconcile and verify integration`

Helper wiring order:
- Prefer the dedicated `ralplan_runtime` wrapper for these operations.
- `start`: `workflow_validate` -> `ralplan_runtime(start)` -> continue planning work in the same active flow until a terminal planning result or a real blocker
- `resume`: `ralplan_runtime(resume)` -> continue planning work in the same active flow until a terminal planning result or a real blocker
- `status`: `ralplan_runtime(status)` only
- `result`: `ralplan_runtime(result)` -> `workflow_continue_runtime` to enter the next stage in the same flow; if terminal planning output exists, it materializes the final `consensus-*.md` state, a `graph-*.json` task DAG artifact, and updates the paired handoff

Stuck-session guard:
- a pending planning session must always have a durable draft plan
- `queued` or `awaiting-input` without a delegate marker is allowed briefly and should surface as a warning, not an immediate hard failure
- `in-progress` without a delegate marker is unhealthy and should be treated as a real failure
- stale pending sessions should surface as warnings first so the orchestrator can recover instead of over-constraining normal AI flow

Fresh-context rule:
- treat `planning_session.metadata.context_path` as the canonical planner input packet
- do not reconstruct planning scope from ambient chat when that context packet exists

If planning is still pending, keep:
- `handoff_status=planned`
- `planning_session.state=queued|awaiting-input|in-progress`

If a new planning session starts from a previously terminal planning state, clear stale final fields first as needed:
- keep or rewrite `consensus_plan_path` as the canonical output path
- reset `preferred_next_stage=ralplan`
- reset `preferred_next_command=/ralplan <handoff>`

Only terminal planning results may move the workflow from `planned` to `review-required`.

When a terminal successful planning result is produced in the normal execution path, continue directly into the next runtime-backed stage instead of stopping just to print `/review-bridge ...`.

If the active flow cannot continue synchronously, treat that as a workflow limitation to surface explicitly rather than silently falling back to an unnotified async handoff.
