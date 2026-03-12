---
description: Validate workflow handoff and review artifacts against the local state machine
allowed-tools: Read
---

## Workflow Artifact Validation

Use `workflow_validate` as the authoritative validator instead of duplicating the state machine in inline jq.

Normal path:
- require a handoff path
- optionally accept a review path
- call `workflow_validate` with the supplied artifacts
- report the first hard failure when `ok=false`
- otherwise summarize warnings before declaring the artifacts valid

Session-aware notes:

- pending planning sessions are valid while `handoff_status=planned`
- pending review sessions are valid while `handoff_status=review-required`
- pending execution sessions are valid while `handoff_status=executing`
- terminal execution sessions are required before `ready-for-verification`
- pending verification sessions are valid while `handoff_status=verifying`
- completed verification sessions are required before `ready-for-archive` and `archiving`
- pending archive sessions are valid while `handoff_status=archiving`
- `ready-for-execution` must not carry a pending `review_session`
- `blocked` must not carry a still-pending `review_session`
- `blocked` must not carry a still-pending `verification_session`
- `blocked` must not carry a still-pending `archive_session`
- `review-required` must not carry a still-pending `planning_session`
- `completed` must not carry a still-pending `execution_session`
- invalid task graphs are hard failures and must not be promoted past planning
- when both handoff and review artifacts contain `review_session`, their `session_id` values must match
- a final `review.json` must carry a terminal `review_session` when that field is present

## Your task

Summarize whether the supplied artifacts are valid. If invalid, report the first hard failure and the expected next correction.
