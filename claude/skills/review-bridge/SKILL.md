---
name: review-bridge
description: OpenSpec-aware local review gate before execution
---

<Purpose>
Review Bridge adds a local review gate on top of the workflow. It starts from the runtime review session, launches a reviewer subagent to inspect the target plus sibling context, and writes the structured review decision back through the workflow runtime.
</Purpose>

<Use_When>
- A formal change exists and should be reviewed before execution
- `ralplan` has produced a plan and the next step should be approval or correction
- The user wants a local review of `proposal.md`, `design.md`, `tasks.md`, or a consensus plan
</Use_When>

<Do_Not_Use_When>
- The request is still vague and needs `deep-interview`
- No reviewable artifact exists yet
- The user explicitly wants to skip review and accept the risk
</Do_Not_Use_When>

<Execution_Policy>
- This skill is loaded by `/review-bridge`, but it must execute in runtime-first mode: call `review_bridge_runtime(start|resume|status|result)` before any review reasoning.
- Use a local reviewer subagent inside this skill; do not depend on `plannotator`.
- Keep `handoff_status=review-required` while a review session is pending.
- Only final review decisions may create or finalize `.opencode/reviews/review-*.json`.
- After a successful terminal review result, automatically continue into the selected runtime-backed execution stage unless a real blocker requires a stop.
- If OpenSpec files change, re-run `openspec validate <change-id> --strict`.
- Reviewer-subagent output must be structured and deterministic enough to map into `review_bridge_runtime(result)` without asking the user to restate the decision.
</Execution_Policy>

<Steps>
1. Call `review_bridge_runtime(start|resume)` first for the resolved handoff or artifact.
2. If the runtime wrapper is blocked or no review target can be inferred safely, stop and surface the blocker.
3. Launch a reviewer subagent automatically using `task`.
   - Prefer `oracle` for design/proposal/plan review unless the task is trivial.
   - The reviewer prompt must include:
     - the review target path
     - the current handoff path when available
     - the original runtime spec or consensus plan context
     - the rubric: goal alignment, constraints/non-goals preserved, acceptance criteria quality, and execution readiness
   - Require the reviewer to return only a structured final payload containing:
     - `decision=approved|changes-requested|waived`
     - `review_type=<design|proposal|plan|tasks|code>`
     - `blocking_issues[]`
     - `notes[]`
     - `approved_artifact` when approved or waived
4. Read the review target and relevant sibling context when needed to prepare the reviewer or verify its conclusion:
   - `proposal.md`
   - `design.md` when present
   - `tasks.md`
   - relevant delta specs
   - `.opencode/plans/consensus-*.md` or `.opencode/plans/plan-*.md`
5. Validate the reviewer-subagent output locally before writing it back:
   - `approved` means the artifact is ready to execute
   - `changes-requested` means real gaps remain and `blocking_issues[]` is non-empty
   - `waived` is allowed only when the user explicitly requests bypassing review or the flow is a synthetic smoke case
6. Immediately call `review_bridge_runtime(result)` with:
   - `handoff_path`
   - `review_target`
   - `review_type`
   - `decision`
   - `approved_artifact` for `approved|waived`
   - `blocking_issues` for `changes-requested`
   - `notes`
7. If the result is `approved` or `waived`, allow the runtime to continue automatically into execution.
8. If the reviewer-subagent fails, times out, or returns malformed output, keep the review session pending or block explicitly; do not silently invent a decision.
</Steps>

<Tool_Usage>
- Use `read` for the reviewed artifact and sibling context.
- Use `task` to launch the reviewer subagent with a strict structured-output rubric.
- Use `bash` for `openspec validate <change-id> --strict` when OpenSpec files changed.
- Use `review_bridge_runtime` as the primary wrapper for review session orchestration and final write-back.
- Use workflow validation after terminal review writes.
- Use `question` only if you truly cannot infer which artifact to review.
</Tool_Usage>

<Final_Checklist>
- [ ] Review anchored to a concrete artifact and, when available, a `change-id`
- [ ] Final decision written through `review_bridge_runtime(result)`
- [ ] Review disposition saved under `.opencode/reviews/`
- [ ] Handoff artifact updated to a valid post-review state
- [ ] Execution handoff uses the same reviewed artifact or change
</Final_Checklist>
