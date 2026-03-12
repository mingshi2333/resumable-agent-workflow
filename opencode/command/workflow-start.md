---
description: Start or resume the coordinator-style startup lane for a substantial new request
---

Run `workflow_start_runtime` as the primary workflow surface for the startup lane.

Operation model:
- default invocation: `start-or-resume`
- explicit operations:
  - `confirm <handoff>`
  - `cancel <handoff>`
  - `status <handoff>`
  - `<handoff>` means `resume`
  - any other non-empty argument means `start`

If no arguments are provided, ask the user: `What substantial request should I start the workflow for?`

Required behavior:
- On `start`, initialize the startup lane under `.opencode/` and persist:
  - `.opencode/state/startup-<slug>.json`
  - paired `.opencode/handoffs/handoff-<slug>.json`
- The startup artifact must include:
  - `status=awaiting-confirmation`
  - a startup brief with goal summary, codebase context, likely file targets, risks, and `recommended_next_stage`
  - confirmation metadata
  - resume metadata with the next command
- The paired handoff must include:
  - `startup_state_path`
  - aligned `preferred_next_stage`
  - aligned `preferred_next_command`
  - startup-oriented `last_transition`
- On `resume` or `status`, reload the saved startup state and present the stored startup summary instead of recomputing startup analysis.
- persist startup as the first sealed context packet in the broader phase DAG lineage so downstream stages can continue without manual reframing.
- On `confirm`, call `workflow_start_runtime(confirm)` first, then follow exactly one continuation path in this order: use the embedded `continued` result when present, else call `workflow_continue_runtime`, else fall back to the stored next-stage command path. Do not require the user to manually retype the next command.
- On `cancel`, call `workflow_start_runtime(cancel)`, persist the cancelled state, and stop cleanly.

Execution rules:
- Prefer the same brownfield context already captured in durable artifacts over asking the user to restate the request.
- When starting from a new request, gather lightweight local context before finalizing the startup brief whenever that can be done safely.
- When confirmation has already been recorded, resuming from the handoff should immediately continue into the stored next stage.
- If continuation cannot proceed synchronously, surface the blocker explicitly and leave the handoff in a valid resumable state.

Continuation rules:
- Preserve existing stage identities for `deep-interview`, `ralplan`, `review-bridge`, and `autopilot`.
- Treat the startup lane as a routing and summary layer, not a replacement for downstream workflow stages.
- Prefer runtime-backed continuation over reconstructing ad hoc routing from chat context.
