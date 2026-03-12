---
description: Start runtime-backed local review bridge flow before execution
---

Load the `review-bridge` skill and execute it with the user's input as `{{ARGUMENTS}}`.

If no arguments are provided, infer the review target from the current context in this order:
1. latest `.opencode/handoffs/handoff-*.json`
2. current OpenSpec change
3. latest `.opencode/plans/consensus-*.md`
4. latest `.opencode/plans/plan-*.md`

If no review target can be inferred safely, ask the user which artifact should be reviewed first.

Follow the skill's full protocol, with this mandatory runtime-first rule:
- before doing any review reasoning, call `review_bridge_runtime(start|resume|status|result)` as the primary workflow surface
- on the normal `start` and `resume` path, create or resume the review session through the runtime wrapper, automatically launch a reviewer subagent, and let that reviewer produce the structured decision
- only use fallback behavior when the runtime wrapper is blocked, no target can be inferred safely, or a terminal review result now requires sibling artifact updates

Required behavior:
- keep structured sync review session semantics
- persist handoff/review state in workflow artifacts
- launch a reviewer subagent that evaluates the review target against the original workflow goal, constraints, acceptance criteria, and execution readiness
- produce a structured terminal `decision=approved|changes-requested|waived|aborted|expired|cancelled`
- immediately convert that terminal decision into `review_bridge_runtime(result)` so `.opencode/reviews/review-*.json` and the paired handoff are written automatically
- after successful terminal review, automatically continue into the next runtime-backed execution stage instead of requiring the user to retype the next command

Supervisor rule:
- the parent session is a review orchestrator
- the actual reviewer runs as a delegated specialist, ideally via `background_task`
- use `review_session.metadata.context_path` as the sealed review packet for that specialist

Startup continuation rules:
- if the handoff exposes `startup_state_path`, preserve that linkage while review is in progress instead of dropping startup-derived context
- prefer the startup-confirmed handoff as the routing source for continuation metadata so approval can keep flowing into `/autopilot` without rebuilding the startup summary from chat alone
