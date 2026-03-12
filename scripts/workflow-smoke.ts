import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const smokeArtifacts = [
  ".opencode/handoffs/handoff-continuation-archive.json",
  ".opencode/handoffs/handoff-continuation-blocked.json",
  ".opencode/handoffs/handoff-continuation-completed.json",
  ".opencode/handoffs/handoff-continuation-execution.json",
  ".opencode/handoffs/handoff-continuation-review.json",
  ".opencode/handoffs/handoff-continuation-startup-deep.json",
  ".opencode/handoffs/handoff-continuation-startup-ralplan.json",
  ".opencode/handoffs/handoff-continuation-verification.json",
  ".opencode/handoffs/handoff-invalid-graph-smoke.json",
  ".opencode/plans/consensus-continuation-startup-ralplan.md",
  ".opencode/plans/consensus-invalid-graph-smoke.md",
  ".opencode/plans/graph-continuation-startup-ralplan.json",
  ".opencode/plans/graph-invalid-graph-smoke.json",
  ".opencode/context/execution-invalid-graph-smoke-batch-1-step-1.json",
  ".opencode/context/execution-invalid-graph-smoke.json",
  ".opencode/context/planning-continuation-startup-ralplan.json",
  ".opencode/context/planning-invalid-graph-smoke.json",
  ".opencode/reviews/review-continuation-execution.json",
  ".opencode/reviews/review-continuation-review.json",
  ".opencode/verifications/verification-continuation-archive.json",
  ".opencode/verifications/verification-continuation-verification.json",
  ".opencode/archives/archive-continuation-archive.json",
  ".opencode/state/startup-continuation-startup-deep.json",
  ".opencode/state/startup-continuation-startup-ralplan.json",
] as const

async function cleanupSmokeArtifacts(root: string) {
  await Promise.all(smokeArtifacts.map((relativePath) => rm(path.join(root, relativePath), { recursive: true, force: true })))
}

async function main() {
  const smoke = process.argv[2] || "continuation-matrix"
  const context = {
    directory: process.cwd(),
    worktree: process.cwd(),
  }

  if (!["continuation-matrix", "invalid-graph"].includes(smoke)) {
    throw new Error(`unknown workflow smoke: ${smoke}`)
  }

  const stubRoot = path.join(process.cwd(), "node_modules", "@opencode-ai")
  const stubDir = path.join(stubRoot, "plugin")
  await cleanupSmokeArtifacts(process.cwd())
  await mkdir(stubDir, { recursive: true })
  await writeFile(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "@opencode-ai/plugin", type: "module", exports: "./index.js" }, null, 2)
  )
  await writeFile(
    path.join(stubDir, "index.js"),
    [
      "function chain(value = {}) {",
      "  return {",
      "    ...value,",
      "    optional() { return this },",
      "    nullable() { return this },",
      "    describe() { return this },",
      "  }",
      "}",
      "",
      "function tool(definition) { return definition }",
      "tool.schema = {",
      "  object(shape) { return chain({ kind: 'object', shape }) },",
      "  enum(values) { return chain({ kind: 'enum', values }) },",
      "  string() { return chain({ kind: 'string' }) },",
      "  boolean() { return chain({ kind: 'boolean' }) },",
      "  array(item) { return chain({ kind: 'array', item }) },",
      "  record(key, value) { return chain({ kind: 'record', key, value }) },",
      "  any() { return chain({ kind: 'any' }) },",
      "}",
      "",
      "export { tool }",
      "",
    ].join('\n')
  )

  try {
    const workflowModule = await import(pathToFileURL(path.join(process.cwd(), "opencode/tools/workflow.ts")).href)
    const result = smoke === "continuation-matrix"
      ? JSON.parse(await workflowModule.smoke_continuation_matrix.execute({}, context)) as Record<string, unknown>
      : await runInvalidGraphSmoke(workflowModule, context)
    if (result.ok !== true) {
      process.stderr.write(`${JSON.stringify(result, null, 2)}\n`)
      process.exit(1)
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await cleanupSmokeArtifacts(process.cwd())
    await rm(stubRoot, { recursive: true, force: true })
  }
}

async function runInvalidGraphSmoke(workflowModule: Record<string, any>, context: { directory: string; worktree: string }) {
  const handoffRel = ".opencode/handoffs/handoff-invalid-graph-smoke.json"
  const invalidPlan = [
    "# Invalid Graph Smoke",
    "",
    "## Implementation Steps",
    "1. Prepare inputs",
    "2. [depends-on:missing-step] Broken dependency",
    "",
  ].join("\n")

  await workflowModule.init.execute({}, context)
  await workflowModule.handoff.execute(
    {
      path: handoffRel,
      workflow_id: "invalid-graph-smoke",
      slug: "invalid-graph-smoke",
      stage: "ralplan",
      handoff_status: "planned",
      preferred_next_stage: "ralplan",
      preferred_next_command: `/ralplan ${handoffRel}`,
      review_required_before_execution: true,
      approval_status: "not-reviewed",
      generated_at: "2026-03-12T00:00:00.000Z",
    },
    context
  )
  await workflowModule.session_start.execute(
    {
      handoff_path: handoffRel,
      session_field: "planning_session",
      provider: "opencode",
      mode: "sync",
      state: "in-progress",
      handoff_status_on_start: "planned",
    },
    context
  )

  const planningResult = JSON.parse(
    await workflowModule.ralplan_runtime.execute(
      {
        operation: "result",
        handoff_path: handoffRel,
        terminal_state: "completed",
        final_plan_content: invalidPlan,
        generated_at: "2026-03-12T00:00:00.000Z",
      },
      context
    )
  ) as Record<string, unknown>

  await workflowModule.handoff.execute(
    {
      path: handoffRel,
      handoff_status: "ready-for-execution",
      approved_artifact: ".opencode/plans/consensus-invalid-graph-smoke.md",
      approval_status: "approved",
      preferred_next_stage: "autopilot",
      preferred_next_command: `/autopilot ${handoffRel}`,
      generated_at: "2026-03-12T00:00:00.000Z",
    },
    context
  )

  const autopilotResult = JSON.parse(
    await workflowModule.autopilot_runtime.execute(
      {
        operation: "start",
        handoff_path: handoffRel,
        generated_at: "2026-03-12T00:00:00.000Z",
      },
      context
    )
  ) as Record<string, unknown>

  const planningLint = (planningResult.task_graph_lint as Record<string, unknown> | undefined) || null
  const invalidGraph = (autopilotResult.task_graph_state as Record<string, unknown> | undefined) || null
  return {
    ok:
      planningResult.ok === false &&
      planningResult.error === "materialized task graph is invalid; planning result was not promoted" &&
      planningLint?.ok === false &&
      autopilotResult.ok === false &&
      autopilotResult.error === "invalid task graph; autopilot refused to start execution" &&
      invalidGraph?.graph_valid === false,
    planning_result: planningResult,
    autopilot_result: autopilotResult,
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
