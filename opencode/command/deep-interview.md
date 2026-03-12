---
description: Run a Socratic deep interview and hand off to the next runtime-backed workflow stage
---

Load the `deep-interview` skill and execute it with the user's input as `{{ARGUMENTS}}`.

If no arguments are provided, ask the user: `What's the idea you'd like to explore?`

Follow the skill's full protocol: initialize state, run the interview loop with ambiguity scoring, activate challenge modes at the configured round thresholds, crystallize the spec when the ambiguity threshold is met, write `.opencode/handoffs/handoff-*.json` using the workflow handoff template semantics, present the execution bridge, and continue into the selected runtime-backed command path instead of requiring the user to manually retype the next command.

When the incoming artifact already includes startup-derived context, treat that startup brief as first-class input instead of asking the user to restate it. In particular:
- if the handoff exposes `startup_state_path`, reload the paired `.opencode/state/startup-<slug>.json`
- use the stored startup summary, likely file targets, and risks as the initial deep-interview context
- preserve continuation through the same handoff so startup confirmation can flow directly into deep interview without manual reframing

If a planning context packet already exists on the same handoff lineage, prefer that sealed packet over ambient chat reconstruction.
