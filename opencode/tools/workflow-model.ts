export const SCHEMA_VERSION = "1" as const

export const handoffStatuses = [
  "ready-for-planning",
  "planned",
  "review-required",
  "ready-for-execution",
  "ready-for-verification",
  "verifying",
  "ready-for-archive",
  "archiving",
  "executing",
  "completed",
  "blocked",
] as const

export const approvalStatuses = ["not-reviewed", "approved", "changes-requested", "waived"] as const
export const startupStatuses = ["classified", "awaiting-confirmation", "confirmed", "cancelled"] as const
export const verificationStatuses = ["passed", "failed", "expired", "cancelled"] as const
export const archiveStatuses = ["completed", "failed", "expired", "cancelled"] as const
export const reviewStatuses = ["approved", "changes-requested", "waived", "aborted", "expired", "cancelled"] as const
export const reviewTypes = ["design", "proposal", "plan", "tasks", "code"] as const
export const sessionKinds = ["interview", "planning", "review", "execution", "verification", "archive"] as const
export const sessionModes = ["sync", "async"] as const
export const sessionProviders = ["plannotator", "opencode", "external"] as const
export const sessionStates = [
  "queued",
  "awaiting-input",
  "awaiting-reviewer",
  "in-progress",
  "completed",
  "expired",
  "cancelled",
  "failed",
] as const
export const dispatchRequestStatuses = ["pending", "queued", "in-progress", "completed", "blocked", "failed", "cancelled"] as const
export const sessionFields = ["planning_session", "review_session", "execution_session", "verification_session", "archive_session"] as const

export const workflowRuntimeNames = {
  workflow_start: "workflow_start_runtime",
  ralplan: "ralplan_runtime",
  review_bridge: "review_bridge_runtime",
  autopilot: "autopilot_runtime",
  workflow_verify: "workflow_verify_runtime",
  workflow_archive: "workflow_archive_runtime",
  workflow_supervisor: "workflow_supervisor_runtime",
  workflow_continue: "workflow_continue_runtime",
} as const
