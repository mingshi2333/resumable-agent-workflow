---
description: Validate workflow handoff and review artifacts against the local state machine
allowed-tools: Bash(jq:*), Bash(test:*), Bash(printf:*), Read
---

## Workflow Artifact Validation

!`sh -lc 'handoff="$1"; review="$2"; if [ -z "$handoff" ]; then printf "usage: /workflow-validate <handoff.json> [review.json]\n"; exit 1; fi; if [ ! -f "$handoff" ]; then printf "missing handoff: %s\n" "$handoff"; exit 1; fi; jq -e '"'"'.schema_version == "1" and (.workflow_id|type=="string") and (.slug|type=="string") and (.stage|type=="string") and (.handoff_status|IN("ready-for-planning","planned","review-required","ready-for-execution","executing","completed","blocked")) and (.preferred_next_stage|type=="string") and (.preferred_next_command|type=="string") and (.review_required_before_execution|type=="boolean") and (.approval_status|IN("not-reviewed","approved","changes-requested","waived"))'"'"' "$handoff" >/dev/null || { printf "invalid handoff schema\n"; exit 1; }; status=$(jq -r .handoff_status "$handoff"); need_review=$(jq -r .review_required_before_execution "$handoff"); approval=$(jq -r .approval_status "$handoff"); if [ "$need_review" = "true" ] && [ "$status" = "ready-for-execution" ] && [ "$approval" != "approved" ] && [ "$approval" != "waived" ]; then printf "handoff invalid: ready-for-execution requires approved or waived approval_status\n"; exit 1; fi; if [ -n "$review" ]; then if [ ! -f "$review" ]; then printf "missing review: %s\n" "$review"; exit 1; fi; jq -e '"'"'.schema_version == "1" and (.workflow_id|type=="string") and (.slug|type=="string") and (.review_target|type=="string") and (.review_type|IN("design","proposal","plan","tasks","code")) and (.status|IN("approved","changes-requested","waived","aborted")) and (.blocking_issues|type=="array") and (.notes|type=="array")'"'"' "$review" >/dev/null || { printf "invalid review schema\n"; exit 1; }; h_id=$(jq -r .workflow_id "$handoff"); r_id=$(jq -r .workflow_id "$review"); h_slug=$(jq -r .slug "$handoff"); r_slug=$(jq -r .slug "$review"); [ "$h_id" = "$r_id" ] || { printf "workflow_id mismatch\n"; exit 1; }; [ "$h_slug" = "$r_slug" ] || { printf "slug mismatch\n"; exit 1; }; r_status=$(jq -r .status "$review"); if [ "$status" = "ready-for-execution" ] && [ "$r_status" != "approved" ] && [ "$r_status" != "waived" ]; then printf "state mismatch: ready-for-execution requires approved or waived review\n"; exit 1; fi; fi; printf "workflow-artifacts-valid\n"' sh "$ARGUMENTS"`

Session-aware notes:

- pending planning sessions are valid while `handoff_status=planned`
- pending review sessions are valid while `handoff_status=review-required`
- pending execution sessions are valid while `handoff_status=executing`
- `ready-for-execution` must not carry a pending `review_session`
- `blocked` must not carry a still-pending `review_session`
- `review-required` must not carry a still-pending `planning_session`
- `completed` must not carry a still-pending `execution_session`
- when both handoff and review artifacts contain `review_session`, their `session_id` values must match
- a final `review.json` must carry a terminal `review_session` when that field is present

## Your task

Summarize whether the supplied artifacts are valid. If invalid, report the first hard failure and the expected next correction.
