---
description: Verify executed workflow outputs before archival closure
---

Run `workflow_verify_runtime` as the primary workflow surface for post-execution verification.

Supervisor rule:
- the parent verification session is an orchestrator
- the actual verifier should run as a delegated specialist from `verification_session.metadata.context_path`
- use `background_task` / `background_output` for that specialist when running the normal path

Required behavior:
- infer the latest executable handoff when no argument is provided
- create or resume a structured `verification_session`
- verify the approved artifact or execution output against the workflow goal, acceptance criteria, and execution evidence
- write a durable verification artifact under `.opencode/verifications/`
- on `passed`, automatically continue into `workflow-archive` without requiring manual re-entry
- on `failed`, block the handoff and record blocking issues for follow-up

Normal path:
- `start`: `workflow_validate` -> `workflow_verify_runtime(start)`
- `resume`: `workflow_verify_runtime(resume)`
- `status`: `workflow_verify_runtime(status)`
- `result`: `workflow_verify_runtime(result)` -> `workflow_continue_runtime`
