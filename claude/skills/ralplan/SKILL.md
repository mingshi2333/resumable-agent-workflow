---
name: ralplan
description: Consensus-planning wrapper alias for the local plan skill
---

<Purpose>
Ralplan is the consensus alias for the local `plan` skill. It uses the same OpenSpec-first input contract, but always runs the planning flow in reviewed consensus mode before execution handoff.
</Purpose>

<Use_When>
- User says `ralplan`
- The next step should be consensus planning on top of an OpenSpec change or deep-interview output
- The task is architectural, cross-cutting, or high risk
</Use_When>

<Behavior>
- Resolve input exactly like `plan`
- Prefer validated OpenSpec change context over runtime specs
- Apply the same existing-change update rules as `plan`
- Persist a draft consensus artifact and handoff update BEFORE any long Planner/Architect/Critic pass
- Planning sessions are resumable and must be represented through `planning_session`
- Run Planner -> Architect -> Critic sequentially
- Save the resulting plan to `.opencode/plans/consensus-<change-id-or-slug>.md`
- Refresh `.opencode/handoffs/handoff-<change-id-or-slug>.json` so the next stage can consume an explicit contract
- Set `handoff_status=review-required` before leaving the consensus stage
- Treat the consensus plan as the preferred handoff artifact for `autopilot`, `ralph`, or `team`
- If the consensus loop is interrupted or times out, keep the draft plan on disk and leave the handoff in `planned` instead of pretending review can start
</Behavior>

<Execution_Policy>
- Resolve or infer the target slug/change-id first
- Create or resume a structured `planning_session` before long planning passes
- Before spawning any long-running review pass, write a draft plan file with the required section headers
- Before spawning any long-running review pass, update the handoff artifact to `planned` with the current draft path
- Keep `handoff_status=planned` while the planning session is pending
- A pending planning session is only healthy when a durable draft plan exists and a real planner delegate has been launched
- Persist delegate launch markers on `planning_session` whenever available (`session_url`, `metadata.delegate_task_id`, `metadata.delegate_launch_handle`, `metadata.delegate_last_output_at`)
- Treat missing delegate markers in `queued` or `awaiting-input` as soft warnings first; reserve hard failure for `in-progress` sessions that still cannot prove a running delegate
- After each Planner/Architect/Critic pass, refresh the draft plan with the latest merged result
- Only switch the handoff to `review-required` after the final consensus plan is fully written
- After a successful terminal planning result, automatically continue into the next runtime-backed stage unless review/input/blockers require a stop
</Execution_Policy>

<Session_Model>
- `start`: create a new `planning_session`, persist the draft plan path, and return resumable state immediately
- `resume`: continue the same `planning_session` by `session_id` or handoff target instead of restarting from scratch
- `status`: report the current planning session state, phase, and draft/final plan paths without advancing the workflow
- `result`: only surface a terminal result after the planning session completes or fails
</Session_Model>

<Steps>
1. Resolve the planning target from handoff, change-id, plan, or runtime spec.
2. Determine the operation mode:
   - default: `start-or-resume`
   - explicit operations: `start`, `resume`, `status`, `result`
   - `status` and `result` must never create a new planning session.
3. For `start` or `start-or-resume`:
   - validate any incoming handoff first
   - if the handoff already has a pending `planning_session`, reuse it
   - otherwise call `ralplan_runtime(start)`
   - set `stage=ralplan` and `handoff_status=planned`
   - establish the canonical `consensus_plan_path`
   - persist a draft consensus plan before long planner passes begin
4. For `resume`:
   - call `ralplan_runtime(resume)` first
   - if the session is still pending, reuse the same `session_id`
   - refresh `last_activity_at` and `metadata.phase` with `session_update(planning_session)`
   - continue from the latest known phase rather than restarting from scratch
   - if the canonical draft plan is missing after start/resume, recreate it immediately before continuing
5. For `status`:
   - call `ralplan_runtime(status)`
   - report `session_id`, `session_state`, `handoff_status`, `consensus_plan_path`, and planning phase metadata
   - do not advance workflow state
6. For `result`:
   - call `ralplan_runtime(result)`
   - if the session is not terminal, return `result_ready=false` with `resume_command`
   - if the session is terminal, continue to final plan write and handoff promotion
7. Run Planner -> Architect -> Critic sequentially only for `start` or `resume`, updating the draft plan after each pass.
8. Final write order must be deterministic:
   - first `session_update(planning_session)` to a terminal state
   - then ensure the final consensus plan is fully written
   - then update the paired handoff to `review-required`
   - then run workflow validation
9. Only terminal successful planning results may move the workflow from `planned` to `review-required`.
10. In the normal execution path, a successful planning result should immediately hand off to `review-bridge` instead of stopping merely to print the next command.
11. If planning fails, expires, or is cancelled, keep the handoff at `planned` or move it to `blocked` with a clear reason, but never pretend review can begin.
12. If a fresh planning session returns `queued` without a draft artifact, repair or surface it immediately. If it returns `queued` without a launched planner delegate, treat that as a soft warning first and only escalate when the session becomes stale or incorrectly claims `in-progress`.
</Steps>

<Final_Checklist>
- [ ] OpenSpec change or fallback runtime spec resolved
- [ ] Pending planning work remains resumable via `planning_session`
- [ ] Consensus review completed sequentially
- [ ] Draft consensus artifact was persisted before long review passes
- [ ] Final consensus plan saved to `.opencode/plans/`
- [ ] Handoff artifact refreshed for the reviewed plan
- [ ] Handoff artifact requires review before execution
- [ ] OpenSpec remains valid after any change updates
</Final_Checklist>
