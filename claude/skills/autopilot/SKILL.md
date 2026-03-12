---
name: autopilot
description: OpenSpec-first autonomous execution wrapper
---

<Purpose>
Autopilot executes approved work from a formal artifact. In this local setup, it prefers an approved review disposition or a validated OpenSpec change / consensus plan derived from that change, and only falls back to `.opencode/specs/` when OpenSpec is unavailable.
</Purpose>

<Use_When>
- User wants end-to-end execution from an approved change or plan
- Deep-interview or plan has already produced a formal artifact
- Work spans planning, implementation, QA, and validation
</Use_When>

<Do_Not_Use_When>
- The request is still vague enough for `deep-interview`
- The user only wants planning or review
- The task is a single focused fix better suited to `ralph`
</Do_Not_Use_When>

<Execution_Policy>
- Prefer approved review dispositions, then handoff artifacts, then `.opencode/plans/consensus-*.md`, then OpenSpec change context, then `.opencode/specs/*.md`
- Read OpenSpec proposal/tasks/design/delta specs before any implementation when OpenSpec is present
- Treat OpenSpec acceptance criteria as authoritative
- Do not invent scope beyond the formal artifact
- Only mark OpenSpec tasks complete with fresh implementation evidence
- If review is required and there is no approved review disposition, redirect to `review-bridge` instead of executing
- Refuse invalid handoff states such as `ready-for-planning`, `planned`, or `review-required`
- Execution sessions are resumable and must be represented through `execution_session`
- Once gating passes, create or resume `execution_session` and write `handoff_status=executing` immediately before any long-running reads, subagents, or implementation work
- Always write a terminal handoff state (`completed` or `blocked`) before exit when a handoff artifact exists
- Continue automatically through execution phases until a terminal result is reached unless a real blocker stops the workflow
- If `task_graph_path` is available on the handoff or session metadata, treat it as the preferred dependency map for execution ordering and verification scoping
- Use graph-derived state (`ready_node_ids`, `remaining_node_ids`, `ready_parallel_groups`) to decide what can execute now versus what must wait or reconcile later
- If `dispatch_plan.ready_batches` contains multiple parallel batches, launch one specialist per dispatch request using the embedded `subagent_type`, then reconcile their outputs before marking the phase complete
- If `dispatch_requests` are present, treat them as the canonical execution prompt source for spawned specialists instead of inventing ad hoc task prompts
- If `reconcile_plan` is present, use its `expected_result_paths` and `request_ids` as the required merge/verification checklist before declaring a batch complete
- Claim the next ready dispatch batch with `execution_dispatch_claim` before spawning subagents so request ownership/status is durable
- After each `execution_dispatch_result`, immediately recompute terminal conditions from `dispatch_summary` and `task_graph_state` instead of waiting for a separate manual closeout step
- Persist delegate launch markers per request whenever available (`delegate_task_id`, `delegate_launch_handle`, `delegate_session_url`, `delegate_last_output_at`) so queued and in-progress execution remains resumable
- Treat queued requests without launch markers as recoverable warnings; only fail hard when a request is marked `in-progress` but still cannot prove a launched delegate
</Execution_Policy>

<Steps>
1. Resolve the primary artifact in this order:
   - approved review disposition in `.opencode/reviews/`
   - handoff artifact in `.opencode/handoffs/`
   - consensus plan in `.opencode/plans/`
   - explicit OpenSpec `change-id` or `openspec/changes/<change-id>/`
   - fallback runtime spec in `.opencode/specs/`
2. Parse `change-id` explicitly:
   - If the input is a bare kebab-case token and `openspec/changes/<token>/` exists, use it as the `change-id`
   - If the input is a path under `openspec/changes/<id>/...`, derive `<id>` from the path
   - If both a consensus plan and a change are available, prefer the consensus plan but keep the derived `change-id` for write-back
3. If a review or handoff artifact exists, read it first and honor its `approved_artifact`, `change_id`, `review_required_before_execution`, and `approval_status` fields.
4. If review is required and the latest review status is neither `approved` nor `waived`, stop immediately and redirect to `review-bridge` instead of continuing with exploratory work.
5. If a handoff artifact exists and `handoff_status` is not `ready-for-execution`, `executing`, or `completed`, stop immediately or redirect instead of executing.
6. If a handoff artifact exists and gating passed, create or resume a structured `execution_session` and set `handoff_status=executing` plus a descriptive `last_transition` before any long-running reads, subagents, or implementation work.
7. If OpenSpec is present, read:
     - `openspec/AGENTS.md`
     - `openspec/project.md`
     - `proposal.md`
     - `tasks.md`
     - `design.md` when present
     - affected delta specs
8. If the artifact is still too vague, update the handoff to `blocked` and redirect to `deep-interview` or `plan` instead of executing blind.
9. Produce or refine an implementation plan only as needed to execute the approved artifact.
10. If `task_graph_path` is present, read the graph and use it to organize execution order, parallelizable groups, and verification boundaries.
11. If `dispatch_plan` is present:
   - execute `serial` batches in order
   - execute `parallel` batches with multiple `task(...)` calls in parallel when safe
   - call `execution_dispatch_claim` before launching the chosen batch
   - prefer `dispatch_requests[*].subagent_type` and `dispatch_requests[*].prompt` as the exact subagent launch contract
   - write or expect per-request results at `dispatch_requests[*].result_path`
   - call `execution_dispatch_result` for each completed or blocked request
   - if multiple parallel subagents finish together, collect their outputs first and write them back sequentially through `execution_dispatch_result`
    - reconcile outputs for any batch set that requires merge or verification before advancing, using `reconcile_plan`
    - if there are no pending requests and no remaining DAG nodes, call `autopilot_runtime(result)` immediately with a terminal success state
    - if there are no pending requests but blocked requests remain, call `autopilot_runtime(result)` immediately with a terminal failure state
12. Implement the work.
13. Run build/test/verification appropriate to the project.
14. If execution completes cleanly and a handoff artifact exists, set `handoff_status=completed` with a short success transition note.
15. If execution is interrupted, times out, or finds a blocker and a handoff artifact exists, set `handoff_status=blocked` with a short blocker note before exit.
16. `tasks.md` write-back convention when OpenSpec is present:
   - Mark `- [x]` only after fresh evidence confirms the task is complete
   - Preserve numbering and existing wording unless the task itself needs revision
   - Append newly discovered implementation work as new unchecked items instead of silently folding it into an existing completed task
   - If a task is blocked, leave it unchecked and note the blocker in adjacent planning/progress output rather than falsely completing it
   - Re-run `openspec validate <change-id> --strict` after editing any OpenSpec artifact
</Steps>

<Session_Model>
- `start`: create a new `execution_session` after review gating passes and return resumable execution state
- `resume`: continue the same `execution_session` by `session_id` or handoff instead of restarting the full executor path
- `status`: report the current execution session state, phase, progress summary, and blocker/result availability without mutating workflow state
- `result`: only surface a terminal execution result after the session has completed, failed, expired, or been cancelled
</Session_Model>

<Steps_Execution_Session>
- Determine the operation mode:
  - default: `start-or-resume`
  - explicit operations: `start`, `resume`, `status`, `result`
  - `status` and `result` must never create a new execution session
- For `start` or `start-or-resume`:
  - validate handoff/review state first
  - if a pending `execution_session` already exists, reuse it
  - otherwise call `autopilot_runtime(start)`
  - set `stage=autopilot` and `handoff_status=executing`
  - initialize `execution_session.metadata` with target, phase, and verification placeholders
- For `resume`:
  - call `autopilot_runtime(resume)` first
  - if the session is still pending, reuse the same `session_id`
  - refresh `last_activity_at`, `metadata.phase`, and progress summary with `session_update(execution_session)`
  - continue from the latest known execution phase rather than restarting blindly
- For `status`:
  - call `autopilot_runtime(status)`
  - report `session_id`, `session_state`, `handoff_status`, execution phase, progress summary, and blocker/result availability
  - do not mutate workflow state
- For `result`:
  - call `autopilot_runtime(result)`
  - if the session is not terminal, return `result_ready=false` with `resume_command`
  - if the session is terminal, continue to terminal handoff materialization
- Execution work should run only for `start` or `resume`, not for `status` or `result`
- Terminal write order must be deterministic:
  - first `session_update(execution_session)` to a terminal state
  - then persist verification/result metadata
  - then update the paired handoff to `completed` or `blocked`
  - then run final workflow validation
- A non-terminal execution session with zero pending requests and zero remaining nodes is invalid and should be repaired or failed immediately.
- `blocked` is a handoff outcome, not an execution session state; execution session terminal states remain `completed|failed|expired|cancelled`
</Steps_Execution_Session>

<Tool_Usage>
- Use `read` for plans and OpenSpec files
- Use `bash` for project verification and `openspec validate` if OpenSpec files were updated
- Use `task(subagent_type="fixer")` or direct editing for concrete implementation work
- Use `lsp_diagnostics` before finalizing code changes when possible
</Tool_Usage>

<Final_Checklist>
- [ ] Primary artifact resolved with OpenSpec-first ordering
- [ ] Review gating honored before execution
- [ ] Invalid handoff states were rejected
- [ ] Handoff moved to `executing` before long work started
- [ ] Handoff moved to a terminal state before exit
- [ ] Scope matches the formal artifact
- [ ] Relevant verification commands run
- [ ] `tasks.md` was only checked off with fresh evidence when OpenSpec was present
- [ ] OpenSpec files remain valid if touched
</Final_Checklist>

<Advanced>
## Change-ID Resolution

- Bare kebab-case token -> use as `change-id` only if the matching directory exists
- OpenSpec file path -> derive `change-id` from the enclosing `openspec/changes/<id>/`
- Consensus plan + change -> execute from the plan, write back against the change
</Advanced>
