---
description: Execute approved work from a consensus plan, OpenSpec change, or runtime spec
---

Run `autopilot_runtime` as the primary workflow surface, then use the `autopilot` skill for the execution reasoning it orchestrates.

Supervisor rule:
- the parent execution session is a thin orchestrator
- it claims ready work, launches one delegated specialist per dispatch request, waits for results, and serializes `execution_dispatch_result` writes
- specialist work should come from the persisted execution context / dispatch request packets, not reconstructed ambient chat
- after every `execution_dispatch_result`, the orchestrator must check whether the DAG has reached a terminal condition and immediately call `autopilot_runtime(result)` instead of leaving the session open
- when a worker is launched, persist its durable handle on the claimed request (`delegate_task_id`, `delegate_launch_handle`, `delegate_session_url`) so queued/in-progress work is resumable and diagnosable
- `queued` requests without a launch marker should surface as warnings first; only `in-progress` requests without a marker are hard-invalid
- stale queued or in-progress requests should surface as recoverable warnings before the orchestrator escalates them

The command should operate with structured sync execution session semantics:
- resolve or infer the approved execution artifact
- create or resume an `execution_session`
- support `start|resume|status|result` style behavior through the workflow session helpers
- persist execution progress in structured artifacts
- keep the user in the active execution flow while execution is still in progress
- automatically continue through execution phases until a terminal result is reached unless a real blocker stops the workflow
- after successful execution, continue into `workflow-verify` and then `workflow-archive` when the handoff phase DAG requires those stages

Operation model:
- default invocation: `start-or-resume`
- explicit operations: `start`, `resume`, `status`, `result`
- `status` and `result` are read-oriented and must not create a new session

If no arguments are provided, infer the primary artifact from the current context in this order:
1. latest approved `.opencode/reviews/review-*.json`
2. latest `.opencode/handoffs/handoff-*.json`
3. latest `.opencode/plans/consensus-*.md`
4. current OpenSpec change
5. latest `.opencode/specs/*.md`

If no artifact can be inferred safely, ask the user which approved plan or change to execute.

If the selected handoff exposes `startup_state_path`, reload the paired `.opencode/state/startup-<slug>.json` and carry the saved startup brief forward as execution context. Do not require the user to restate startup discoveries after confirmation and review have already written them to durable artifacts.

On session start or resume, return a structured result containing at least:
- `session_id`
- `session_status`
- `execution_target`
- `change_id` when available
- `phase`
- `task_graph_path` when available
- `task_graph_state` when available
- `dispatch_plan` when available
- `dispatch_requests` when available
- `reconcile_plan` when available
- `dispatch_summary` when available
- `next_expected_input`
- `resume_hint`

Follow the skill's full protocol: use OpenSpec-first resolution, validate handoff/review state before execution, enforce review gating from `.opencode/reviews/` when required, create or resume an `execution_session`, move the handoff to `executing` before long work starts, stay within the approved artifact's scope, implement the work, run verification, and always write a terminal handoff state before exit.

When startup-derived continuation metadata is present, keep `startup_state_path`, the stored startup summary source, and the aligned preferred next-stage metadata intact so execution remains resumable from the same startup lane lineage.

If the approved artifact or handoff exposes `task_graph_path`, prefer that graph as the execution decomposition source instead of reparsing the plan ad hoc.
When available, return graph-derived execution state such as ready nodes, remaining nodes, ready parallel groups, dispatch/reconcile metadata, executable subagent requests for the next ready batch, and the expected result paths needed for reconcile/verify.
Claim the next ready batch with `execution_dispatch_claim` before launching subagents; when `next_dispatch_mode=parallel`, claim all ready parallel batches together. Then write each subagent outcome back with `execution_dispatch_result`.
Parallel subagents may run concurrently, but their `execution_dispatch_result` write-backs should be serialized by the orchestrator to avoid artifact races.
Return `dispatch_summary` so the active flow can see which requests are still pending, completed, or blocked.
Prefer the `subagent_type` embedded in each `dispatch_request` instead of assuming all work should go to `fixer`.

Helper wiring order:
- Prefer the dedicated `autopilot_runtime` wrapper for these operations.
- `start`: `workflow_validate` -> `autopilot_runtime(start)` -> continue execution in the same active flow until a terminal result or a real blocker
- `resume`: `autopilot_runtime(resume)` -> continue execution in the same active flow until a terminal result or a real blocker
- `status`: `autopilot_runtime(status)` only
- `result`: `autopilot_runtime(result)` -> `workflow_continue_runtime` for verification/archive continuation; if terminal execution output exists, it materializes the post-execution handoff state and verification summary

Terminal closure rules:
- if `dispatch_summary.pending_request_ids=[]` and `task_graph_state.remaining_node_ids=[]`, immediately call `autopilot_runtime(result terminal_state=completed)`
- if `dispatch_summary.pending_request_ids=[]` and `dispatch_summary.blocked_request_ids` is non-empty, immediately call `autopilot_runtime(result terminal_state=failed)` with the blocker summary
- never leave `handoff_status=executing` once there is no ready work, no pending work, and no remaining DAG nodes

Fresh-context rule:
- treat `execution_session.metadata.context_path` and each dispatch request `context_path` as canonical worker input envelopes
- prefer delegated `background_task` execution over inline implementation whenever a dispatch request exists

If execution is still pending, keep:
- `handoff_status=executing`
- `execution_session.state=queued|awaiting-input|in-progress`

On terminal execution writes, update in this order:
- first `session_update(execution_session)` to a terminal state
- then update terminal execution metadata and verification fields
- then update the paired handoff to `completed` or `blocked`

Only terminal execution results may move the workflow to `completed` or `blocked`.

If the active flow cannot continue synchronously, surface the blocker explicitly instead of silently degrading into an unnotified async handoff.
