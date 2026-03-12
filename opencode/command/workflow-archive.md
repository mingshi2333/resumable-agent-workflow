---
description: Archive and close a verified workflow run
---

Run `workflow_archive_runtime` as the primary workflow surface for final closure.

Supervisor rule:
- the parent archive session is an orchestrator
- the actual archiver should run as a delegated specialist from `archive_session.metadata.context_path`
- use `background_task` / `background_output` for that specialist when running the normal path

Required behavior:
- infer the latest verified handoff when no argument is provided
- create or resume a structured `archive_session`
- write a durable archive artifact under `.opencode/archives/`
- mark the paired handoff `completed` only after the archive result is written

Normal path:
- `start`: `workflow_validate` -> `workflow_archive_runtime(start)`
- `resume`: `workflow_archive_runtime(resume)`
- `status`: `workflow_archive_runtime(status)`
- `result`: `workflow_archive_runtime(result)`
