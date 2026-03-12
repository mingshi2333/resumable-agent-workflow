---
description: Run a deterministic end-to-end smoke test of the local workflow state machine and command chain
---

## Workflow E2E Smoke

Use the runtime smoke helpers directly so this command stays deterministic and does not recursively invoke heavyweight slash commands.

Smoke goal:
- prove the runtime-wrapper-first main path works end to end
- prove active-flow continuation between planning, review, execution, verification, and archive terminal stages
- prove durable artifact materialization for handoff, review, verification, archive, plan, graph, and execution marker files

Required flow:
1. Initialize workflow directories with `workflow_init`.
2. Call `workflow_smoke_e2e` to run the deterministic sequence for `workflow-e2e-smoke`.
3. Verify the resulting terminal artifacts exist and are coherent:
   - `.opencode/specs/deep-interview-workflow-e2e-smoke.md`
   - `.opencode/handoffs/handoff-workflow-e2e-smoke.json`
   - `.opencode/plans/consensus-workflow-e2e-smoke.md`
   - `.opencode/plans/graph-workflow-e2e-smoke.json`
   - `.opencode/reviews/review-workflow-e2e-smoke.json`
   - `.opencode/verifications/verify-workflow-e2e-smoke.json`
   - `.opencode/archives/archive-workflow-e2e-smoke.json`
   - `.opencode/context/`
   - `.opencode/smoke/autopilot-ran.txt`
4. Verify the final handoff is completed and the review / verification / archive artifacts exist.
5. Summarize the smoke-test results stage by stage. If it fails, report the first blocking runtime stage and the artifact state that proves the failure.

Coverage expectations:
- `ralplan_runtime(start -> result)`
- `review_bridge_runtime(start -> result)`
- `workflow_continue_runtime` between stages
- `autopilot_runtime(start -> result)`
- `workflow_verify_runtime(start -> result)`
- `workflow_archive_runtime(start -> result)`
- hybrid boundary thinning where draft planning and pre-decision review artifacts stay optional until terminal outputs exist

This command should validate command -> runtime wrapper -> session state -> artifact materialization, but without shelling out to nested `opencode run --command ...` chains.

It should also prove the default local durable store policy and phase context packets remain coherent across the full phase DAG.
