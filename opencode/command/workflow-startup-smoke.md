---
description: Run a deterministic startup-lane smoke test for classification, confirmation gating, and continuation
---

## Workflow Startup Smoke

Use the runtime wrappers directly so this smoke test remains deterministic and fast.

Smoke goal:
- prove startup classification writes durable artifacts
- prove the lane pauses in `awaiting-confirmation`
- prove resume reloads the saved startup summary without recomputing it
- prove confirmed continuation produces a downstream planning artifact through the startup lane lineage
- prove the default local durable store policy and context packet lineage remain coherent

Required flow:
1. Initialize workflow directories with `workflow_init`.
2. Use a fixed slug of `startup-smoke` and fixed paths:
   - handoff: `.opencode/handoffs/handoff-startup-smoke.json`
   - startup state: `.opencode/state/startup-startup-smoke.json`
3. Call `workflow_start_runtime(start)` with deterministic values:
   - `workflow_id=startup-smoke`
   - request text describing startup smoke
   - summary source `startup-smoke`
   - recommended next stage `ralplan`
   - fixed generated time values
4. Verify the resulting artifacts show:
   - startup status `awaiting-confirmation`
   - a startup summary with goal text and `recommended_next_stage`
   - a handoff with `startup_state_path` and aligned continuation metadata
5. Call `workflow_start_runtime(resume)` against the same handoff and verify it returns the same saved summary plus `next_expected_input=explicit confirmation or cancellation`.
6. Call `workflow_start_runtime(confirm)` against the same handoff and verify it returns an embedded `continued` result instead of requiring a second manual command.
7. If the confirm result did not embed `continued`, call `workflow_continue_runtime` on that handoff; otherwise reuse the embedded continuation. In either case verify startup continuation stays on the `ralplan` lineage. This may appear in one of two valid ways:
   - the immediate continuation result resolves to `stage: "ralplan"`, or
   - the continued handoff already advanced past planning and now records the `ralplan` lineage via `planning_session.resume_command` or the consensus-plan / task-graph artifacts.
8. Call `workflow_smoke_ralplan` with the same handoff to materialize the deterministic downstream planning artifact and graph without relying on a separate review continuation.
9. Verify these artifacts now exist:
   - `.opencode/state/startup-startup-smoke.json`
   - `.opencode/handoffs/handoff-startup-smoke.json`
   - `.opencode/plans/consensus-startup-smoke.md`
   - `.opencode/plans/graph-startup-smoke.json`
10. Summarize whether startup classification, confirmation pause, summary-preserving resume, and downstream continuation all passed. If any step fails, report the first failing stage and the artifact or runtime field that proves the failure.
