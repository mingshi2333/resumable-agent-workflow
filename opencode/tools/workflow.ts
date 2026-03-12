import { tool } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const handoffStatuses = [
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

const approvalStatuses = ["not-reviewed", "approved", "changes-requested", "waived"] as const
const startupStatuses = ["classified", "awaiting-confirmation", "confirmed", "cancelled"] as const
const verificationStatuses = ["passed", "failed", "expired", "cancelled"] as const
const archiveStatuses = ["completed", "failed", "expired", "cancelled"] as const

const reviewStatuses = ["approved", "changes-requested", "waived", "aborted", "expired", "cancelled"] as const
const reviewTypes = ["design", "proposal", "plan", "tasks", "code"] as const
const sessionKinds = ["interview", "planning", "review", "execution", "verification", "archive"] as const
const sessionModes = ["sync", "async"] as const
const sessionProviders = ["plannotator", "opencode", "external"] as const
const sessionStates = [
  "queued",
  "awaiting-input",
  "awaiting-reviewer",
  "in-progress",
  "completed",
  "expired",
  "cancelled",
  "failed",
] as const
const dispatchRequestStatuses = ["pending", "queued", "in-progress", "completed", "blocked", "failed", "cancelled"] as const
const sessionFields = ["planning_session", "review_session", "execution_session", "verification_session", "archive_session"] as const

const sessionSchema = tool.schema.object({
  kind: tool.schema.enum(sessionKinds),
  mode: tool.schema.enum(sessionModes),
  session_id: tool.schema.string(),
  provider: tool.schema.enum(sessionProviders),
  state: tool.schema.enum(sessionStates),
  requested_at: tool.schema.string(),
  started_at: tool.schema.string().nullable().optional(),
  last_activity_at: tool.schema.string().nullable().optional(),
  expires_at: tool.schema.string().nullable().optional(),
  resume_command: tool.schema.string().nullable().optional(),
  session_url: tool.schema.string().nullable().optional(),
  metadata: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
})

const startupBriefSchema = tool.schema.object({
  goal_summary: tool.schema.string().optional(),
  codebase_context: tool.schema.array(tool.schema.string()).optional(),
  likely_file_targets: tool.schema.array(tool.schema.string()).optional(),
  risks: tool.schema.array(tool.schema.string()).optional(),
  recommended_next_stage: tool.schema.string().optional(),
})

const startupConfirmationSchema = tool.schema.object({
  required: tool.schema.boolean().optional(),
  asked_at: tool.schema.string().nullable().optional(),
  decision: tool.schema.string().nullable().optional(),
  decided_at: tool.schema.string().nullable().optional(),
})

const startupResumeSchema = tool.schema.object({
  handoff_path: tool.schema.string().nullable().optional(),
  next_command_on_confirm: tool.schema.string().nullable().optional(),
  summary_source: tool.schema.string().nullable().optional(),
})

function baseDir(context: { worktree?: string; directory: string }) {
  const candidates = [context.worktree, context.directory, process.env.PWD, process.cwd()].filter(
    (value): value is string => !!value && value.trim().length > 0
  )

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (resolved !== path.parse(resolved).root) return resolved
  }

  return process.cwd()
}

function resolvePath(root: string, candidate: string) {
  return path.isAbsolute(candidate) ? candidate : path.join(root, candidate)
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T
  } catch {
    return null
  }
}

async function writeJsonFile(filePath: string, data: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

async function writeTextFile(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8")
}

async function removeFileIfExists(filePath: string) {
  await rm(filePath, { force: true })
}

async function textFileExists(filePath: string) {
  try {
    await readFile(filePath, "utf8")
    return true
  } catch {
    return false
  }
}

function nowIso() {
  return new Date().toISOString()
}

function isPendingSessionState(value: unknown) {
  return value === "queued" || value === "awaiting-input" || value === "awaiting-reviewer" || value === "in-progress"
}

function isTerminalSessionState(value: unknown) {
  return value === "completed" || value === "expired" || value === "cancelled" || value === "failed"
}

function defaultKindForField(field: typeof sessionFields[number]) {
  if (field === "planning_session") return "planning"
  if (field === "review_session") return "review"
  if (field === "verification_session") return "verification"
  if (field === "archive_session") return "archive"
  return "execution"
}

function currentSession(data: Record<string, unknown> | null, field: typeof sessionFields[number]) {
  return (data?.[field] as Record<string, unknown> | null | undefined) || null
}

function normalizeSessionSnapshot(
  field: typeof sessionFields[number],
  session: Record<string, unknown> | null,
  fallbackProvider: typeof sessionProviders[number] = "opencode"
) {
  if (!session) return null
  return {
    kind: (session.kind as string) || defaultKindForField(field),
    mode: (session.mode as string) || "async",
    session_id: (session.session_id as string) || "",
    provider: (session.provider as string) || fallbackProvider,
    state: (session.state as string) || "queued",
    requested_at: (session.requested_at as string) || nowIso(),
    started_at: (session.started_at as string | null | undefined) ?? null,
    last_activity_at: (session.last_activity_at as string | null | undefined) ?? null,
    expires_at: (session.expires_at as string | null | undefined) ?? null,
    resume_command: (session.resume_command as string | null | undefined) ?? null,
    session_url: (session.session_url as string | null | undefined) ?? null,
    metadata: (session.metadata as Record<string, unknown> | undefined) || {},
  }
}

function defaultReviewPathFromHandoff(root: string, handoffData: Record<string, unknown>) {
  const slug = (handoffData.slug as string) || "workflow"
  return path.join(root, workflowStoreBase(handoffData), "reviews", `review-${slug}.json`)
}

function defaultVerificationPathFromHandoff(root: string, handoffData: Record<string, unknown>) {
  const slug = (handoffData.slug as string) || "workflow"
  return path.join(root, workflowStoreBase(handoffData), "verifications", `verify-${slug}.json`)
}

function defaultArchivePathFromHandoff(root: string, handoffData: Record<string, unknown>) {
  const slug = (handoffData.slug as string) || "workflow"
  return path.join(root, workflowStoreBase(handoffData), "archives", `archive-${slug}.json`)
}

function defaultTaskGraphPathFromHandoff(root: string, handoffData: Record<string, unknown>) {
  const slug = (handoffData.slug as string) || "workflow"
  return path.join(root, workflowStoreBase(handoffData), "plans", `graph-${slug}.json`)
}

function defaultDispatchPlanPathFromHandoff(root: string, handoffData: Record<string, unknown>) {
  const slug = (handoffData.slug as string) || "workflow"
  return path.join(root, workflowStoreBase(handoffData), "executions", `dispatch-${slug}.json`)
}

function defaultStartupStatePathFromHandoff(root: string, handoffData: Record<string, unknown>) {
  const slug = (handoffData.slug as string) || "workflow"
  return path.join(root, workflowStoreBase(handoffData), "state", `startup-${slug}.json`)
}

function workflowStoreBase(data: Record<string, unknown> | null | undefined) {
  const policy = (data?.store_policy as Record<string, unknown> | undefined) || null
  const baseLocator = (policy?.base_locator as string | undefined) || ".opencode"
  return baseLocator.replace(/\/+$|\/+$/g, "") || ".opencode"
}

function ensureStorePolicy(data: Record<string, unknown>) {
  const existing = (data.store_policy as Record<string, unknown> | undefined) || {}
  return {
    policy_id: (existing.policy_id as string | undefined) || "local-fs-default",
    provider: (existing.provider as string | undefined) || "local-fs",
    durability: (existing.durability as string | undefined) || "durable",
    scope: (existing.scope as string | undefined) || "project-local",
    base_locator: (existing.base_locator as string | undefined) || ".opencode",
    layout_version: (existing.layout_version as string | undefined) || "1",
  }
}

function buildArtifactRef(data: Record<string, unknown>, role: string, locator: string | null | undefined) {
  if (!locator) return null
  const policy = ensureStorePolicy(data)
  return {
    role,
    provider: policy.provider,
    locator,
    base_locator: policy.base_locator,
    durability: policy.durability,
  }
}

function defaultContextPathFromHandoff(root: string, handoffData: Record<string, unknown>, stage: string, suffix?: string | null) {
  const slug = (handoffData.slug as string) || "workflow"
  const safeSuffix = suffix ? `-${suffix}` : ""
  return path.join(root, workflowStoreBase(handoffData), "context", `${stage}-${slug}${safeSuffix}.json`)
}

function attachArtifactRefs(data: Record<string, unknown>) {
  const next = { ...data }
  const artifactRefs = ((next.artifact_refs as Record<string, unknown> | undefined) || {}) as Record<string, unknown>
  const aliasMap: Array<[string, string]> = [
    ["handoff", typeof next.path === "string" ? (next.path as string) : null as unknown as string],
    ["startup_state", next.startup_state_path as string | undefined],
    ["runtime_spec", next.runtime_spec_path as string | undefined],
    ["consensus_plan", next.consensus_plan_path as string | undefined],
    ["task_graph", next.task_graph_path as string | undefined],
    ["dispatch_plan", next.dispatch_plan_path as string | undefined],
    ["review", next.review_path as string | undefined],
    ["verification", next.verification_path as string | undefined],
    ["archive", next.archive_path as string | undefined],
    ["approved_target", next.approved_artifact as string | undefined],
  ]
  for (const [role, locator] of aliasMap) {
    if (typeof locator === "string" && !(role in artifactRefs)) {
      artifactRefs[role] = buildArtifactRef(next, role, locator)
    }
  }
  next.store_policy = ensureStorePolicy(next)
  next.artifact_refs = artifactRefs
  return next
}

function withArtifactRole(data: Record<string, unknown>, role: string, locator: string | null | undefined) {
  if (!locator) return attachArtifactRefs(data)
  const next = attachArtifactRefs(data)
  const artifactRefs = ((next.artifact_refs as Record<string, unknown> | undefined) || {}) as Record<string, unknown>
  artifactRefs[role] = artifactRefs[role] || buildArtifactRef(next, role, locator)
  next.artifact_refs = artifactRefs
  return next
}

function stageContextPathForSession(root: string, handoffData: Record<string, unknown>, field: typeof sessionFields[number], suffix?: string | null) {
  const stageName =
    field === "planning_session"
      ? "planning"
      : field === "review_session"
        ? "review"
        : field === "execution_session"
          ? "execution"
          : field === "verification_session"
            ? "verification"
            : "archive"
  return defaultContextPathFromHandoff(root, handoffData, stageName, suffix)
}

async function writeStageContext(
  root: string,
  handoffData: Record<string, unknown>,
  field: typeof sessionFields[number],
  payload: Record<string, unknown>,
  suffix?: string | null
) {
  const contextPath = stageContextPathForSession(root, handoffData, field, suffix)
  await writeJsonFile(contextPath, {
    schema_version: "1",
    workflow_id: handoffData.workflow_id || null,
    slug: handoffData.slug || null,
    stage: defaultKindForField(field),
    generated_at: nowIso(),
    ...payload,
  })
  return path.relative(root, contextPath)
}

async function writeDispatchContexts(
  root: string,
  handoffData: Record<string, unknown>,
  dispatchRequests: ReturnType<typeof buildDispatchRequests>,
  payload: {
    execution_target: string | null
    task_graph_path: string | null
    approved_artifact: string | null
  }
) {
  for (const batch of dispatchRequests) {
    for (const request of batch.requests) {
      const contextPath = resolvePath(root, request.context_path as string)
      await writeJsonFile(contextPath, {
        schema_version: "1",
        workflow_id: handoffData.workflow_id || null,
        slug: handoffData.slug || null,
        stage: "execution-dispatch",
        generated_at: nowIso(),
        request_id: request.request_id,
        batch_id: request.batch_id,
        node_id: request.node_id,
        label: request.label,
        delegate_role: request.delegate_role,
        delegate_identity: request.delegate_identity,
        delegate_contract: request.delegate_contract,
        execution_target: payload.execution_target,
        task_graph_path: payload.task_graph_path,
        approved_artifact: payload.approved_artifact,
        store_policy: ensureStorePolicy(handoffData),
      })
    }
  }
}

function buildDelegateContract(args: {
  stage: string
  delegate_role: string
  delegate_identity: string
  subagent_type?: string | null
  delegate_mode: "orchestrator" | "specialist"
  context_mode: "artifact-backed" | "fresh-context"
  result_kind: string
  required_fields: string[]
}) {
  return {
    stage: args.stage,
    delegate_role: args.delegate_role,
    delegate_identity: args.delegate_identity,
    subagent_type: args.subagent_type || null,
    delegate_mode: args.delegate_mode,
    context_mode: args.context_mode,
    result_contract: {
      kind: args.result_kind,
      required_fields: args.required_fields,
    },
  }
}

function selectDispatchDelegate(label: string) {
  const lower = label.toLowerCase()
  if (lower.includes("archive") || lower.includes("archiv") || lower.includes("close") || lower.includes("closure")) {
    return { subagent_type: "general", delegate_role: "archiver" }
  }
  if (lower.includes("verify") || lower.includes("validation") || lower.includes("validator")) {
    return { subagent_type: "oracle", delegate_role: "verifier" }
  }
  if (lower.includes("review")) {
    return { subagent_type: "oracle", delegate_role: "reviewer" }
  }
  if (
    lower.includes("explore") ||
    lower.includes("inspect") ||
    lower.includes("facts") ||
    lower.includes("map ") ||
    lower.includes("mapping")
  ) {
    return { subagent_type: "explore", delegate_role: "explorer" }
  }
  if (
    lower.includes("compare") ||
    lower.includes("analy") ||
    lower.includes("score") ||
    lower.includes("roadmap") ||
    lower.includes("report")
  ) {
    return { subagent_type: "general", delegate_role: "analyst" }
  }
  return { subagent_type: "fixer", delegate_role: "implementer" }
}

function extractImplementationSteps(markdown: string) {
  const lines = markdown.split(/\r?\n/)
  const steps: string[] = []
  let inSection = false

  for (const line of lines) {
    if (/^##\s+Implementation Steps\s*$/i.test(line.trim())) {
      inSection = true
      continue
    }
    if (inSection && /^##\s+/.test(line.trim())) break
    if (!inSection) continue
    const match = line.match(/^\s*\d+\.\s+(.*)$/)
    if (match) steps.push(match[1].trim())
  }

  return steps
}

function parseStepAnnotations(stepText: string) {
  let remaining = stepText.trim()
  const metadata: { parallel_group: string | null; depends_on: string[] } = {
    parallel_group: null,
    depends_on: [],
  }

  while (remaining.startsWith("[")) {
    const match = remaining.match(/^\[(parallel|depends-on):([^\]]+)\]\s*(.*)$/i)
    if (!match) break
    const [, key, value, rest] = match
    if (key.toLowerCase() === "parallel") metadata.parallel_group = value.trim()
    if (key.toLowerCase() === "depends-on") {
      metadata.depends_on = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    }
    remaining = rest.trim()
  }

  return { label: remaining || stepText.trim(), metadata }
}

function buildTaskGraph(planContent: string, handoffData: Record<string, unknown>, planPath: string, generatedAt: string) {
  const slug = ((handoffData.slug as string) || "workflow").trim()
  const steps = extractImplementationSteps(planContent)
  const rawSteps = steps.length > 0 ? steps : ["Complete planned work and validate outcomes"]
  const nodes: Array<Record<string, unknown>> = []
  const edges: Array<Record<string, string>> = []
  const nodeIds = new Set<string>()
  let previousNodeId: string | null = null
  let serialAnchorId: string | null = null
  let openParallelNodeIds: string[] = []

  for (let index = 0; index < rawSteps.length; index += 1) {
    const stepId = `step-${index + 1}`
    const { label, metadata } = parseStepAnnotations(rawSteps[index])
    const explicitDeps = metadata.depends_on.filter((dep) => dep && dep !== stepId)
    const dependsOn = explicitDeps.length > 0
      ? explicitDeps
      : metadata.parallel_group
        ? serialAnchorId
          ? [serialAnchorId]
          : []
        : openParallelNodeIds.length > 0
          ? [...openParallelNodeIds]
          : previousNodeId
            ? [previousNodeId]
            : []

    nodes.push({
      id: stepId,
      label,
      kind: "step",
      parallel_group: metadata.parallel_group,
      depends_on: dependsOn,
    })
    nodeIds.add(stepId)

    for (const dep of dependsOn) {
      edges.push({ from: dep, to: stepId })
    }

    previousNodeId = stepId
    if (metadata.parallel_group) {
      openParallelNodeIds.push(stepId)
    } else {
      serialAnchorId = stepId
      openParallelNodeIds = []
    }
  }

  return {
    schema_version: "1",
    workflow_id: handoffData.workflow_id || slug,
    slug,
    generated_at: generatedAt,
    source_plan_path: planPath,
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges,
  }
}

function draftConsensusPlanTemplate(handoffData: Record<string, unknown>, generatedAt: string) {
  const slug = ((handoffData.slug as string | undefined) || "workflow").trim() || "workflow"
  const title = slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")

  return [
    `# ${title} Consensus Plan`,
    "",
    "## Requirements Summary",
    `- Draft created automatically at ${generatedAt} so planning remains resumable.`,
    `- Primary runtime spec: ${(handoffData.runtime_spec_path as string | undefined) || "(not set)"}`,
    `- Bound change id: ${(handoffData.change_id as string | undefined) || "(not set)"}`,
    "",
    "## Acceptance Criteria",
    "- Deliver a final consensus plan before leaving the planning stage.",
    "- Materialize a task graph from the final implementation steps.",
    "- Keep handoff and OpenSpec artifacts aligned with the approved planning output.",
    "",
    "## Implementation Steps",
    "1. Re-read the authoritative handoff, runtime spec, and OpenSpec context.",
    "2. Produce the final consensus plan content.",
    "3. Generate the task graph and promote the handoff to review-required.",
    "",
    "## Risks And Mitigations",
    "- Risk: planning stalls before the final artifact is written -> Mitigation: keep this durable draft on disk.",
    "",
    "## Verification Steps",
    "- Confirm the final consensus plan is written to the canonical path.",
    "- Confirm the task graph is generated from `## Implementation Steps`.",
    "",
    "## Planner/Architect/Critic Notes",
    "- Replace this draft with the real consensus output before calling `ralplan_runtime(result)`.",
    "",
  ].join("\n")
}

async function readTaskGraphFile(root: string, taskGraphPath: string | null | undefined) {
  if (!taskGraphPath) return null
  return readJsonFile<Record<string, unknown>>(resolvePath(root, taskGraphPath))
}

async function readDispatchArtifactFile(root: string, dispatchPlanPath: string | null | undefined) {
  if (!dispatchPlanPath) return null
  return readJsonFile<Record<string, unknown>>(resolvePath(root, dispatchPlanPath))
}

function deriveTaskGraphExecutionState(taskGraph: Record<string, unknown> | null, completedNodeIds: string[] = []) {
  const nodes = Array.isArray(taskGraph?.nodes) ? (taskGraph?.nodes as Array<Record<string, unknown>>) : []
  const completed = new Set(completedNodeIds)
  const readyNodeIds: string[] = []
  const remainingNodeIds: string[] = []
  const blockedNodeIds: string[] = []
  const readyParallelGroups: Record<string, string[]> = {}

  for (const node of nodes) {
    const nodeId = (node.id as string | undefined) || ""
    if (!nodeId || completed.has(nodeId)) continue
    const dependsOn = Array.isArray(node.depends_on) ? (node.depends_on as string[]) : []
    const allDepsMet = dependsOn.every((dep) => completed.has(dep))
    remainingNodeIds.push(nodeId)
    if (allDepsMet) {
      readyNodeIds.push(nodeId)
      const group = ((node.parallel_group as string | undefined) || "serial").trim() || "serial"
      if (!readyParallelGroups[group]) readyParallelGroups[group] = []
      readyParallelGroups[group].push(nodeId)
    } else {
      blockedNodeIds.push(nodeId)
    }
  }

  return {
    node_count: nodes.length,
    completed_node_ids: completedNodeIds,
    ready_node_ids: readyNodeIds,
    remaining_node_ids: remainingNodeIds,
    blocked_node_ids: blockedNodeIds,
    ready_parallel_groups: readyParallelGroups,
  }
}

function buildDispatchPlanFromGraphState(graphState: {
  node_count: number
  completed_node_ids: string[]
  ready_node_ids: string[]
  remaining_node_ids: string[]
  blocked_node_ids: string[]
  ready_parallel_groups: Record<string, string[]>
}) {
  const groups = Object.entries(graphState.ready_parallel_groups)
    .filter(([, nodeIds]) => nodeIds.length > 0)
    .map(([group, nodeIds], index) => ({
      batch_id: `batch-${index + 1}`,
      group,
      node_ids: nodeIds,
      mode: group === "serial" ? "serial" : "parallel",
    }))

  const parallelBatches = groups.filter((batch) => batch.mode === "parallel")
  const serialBatches = groups.filter((batch) => batch.mode === "serial")

  return {
    ready_batch_count: groups.length,
    ready_batches: groups,
    reconcile_required: parallelBatches.length > 1 || (parallelBatches.length > 0 && serialBatches.length > 0),
    reconcile_scope: parallelBatches.flatMap((batch) => batch.node_ids),
    next_dispatch_mode:
      parallelBatches.length > 0
        ? "parallel"
        : serialBatches.length > 0
          ? "serial"
          : "none",
  }
}

function buildDispatchRequests(
  slug: string,
  taskGraph: Record<string, unknown> | null,
  executionTarget: string | null,
  dispatchPlan: ReturnType<typeof buildDispatchPlanFromGraphState>,
  storeBase = ".opencode"
) {
  const nodes = Array.isArray(taskGraph?.nodes) ? (taskGraph?.nodes as Array<Record<string, unknown>>) : []
  const nodeMap = new Map(nodes.map((node) => [String(node.id || ""), node]))

  return dispatchPlan.ready_batches.map((batch) => {
    const requests = batch.node_ids.map((nodeId, index) => {
      const node = nodeMap.get(nodeId)
      const label = (node?.label as string | undefined) || nodeId
      const delegateSelection = selectDispatchDelegate(label)
      const delegateIdentity = `${delegateSelection.delegate_role}:${delegateSelection.subagent_type}`
      return {
        request_id: `${batch.batch_id}-${nodeId}`,
        batch_id: batch.batch_id,
        node_id: nodeId,
        label,
        subagent_type: delegateSelection.subagent_type,
        delegate_role: delegateSelection.delegate_role,
        delegate_identity: delegateIdentity,
        delegate_contract: buildDelegateContract({
          stage: "execution",
          delegate_role: delegateSelection.delegate_role,
          delegate_identity: delegateIdentity,
          subagent_type: delegateSelection.subagent_type,
          delegate_mode: "specialist",
          context_mode: "fresh-context",
          result_kind: "dispatch-result",
          required_fields: ["summary", "files_touched", "verification_commands", "verification_artifacts"],
        }),
        request_status: "pending",
        context_path: `${storeBase}/context/execution-${slug}-${batch.batch_id}-${nodeId}.json`,
        result_path: `${storeBase}/executions/results/${slug}-${batch.batch_id}-${nodeId}.json`,
        result_ref: {
          role: "dispatch-result",
          provider: "local-fs",
          locator: `${storeBase}/executions/results/${slug}-${batch.batch_id}-${nodeId}.json`,
          base_locator: storeBase,
          durability: "durable",
        },
        execution_target: executionTarget,
        prompt:
          `Execute DAG node ${nodeId}: ${label} as a fresh-context ${delegateSelection.delegate_role} delegate. ` +
          `Stay strictly within the approved execution target ${executionTarget || "(unspecified target)"}. ` +
          `Return a concise result covering work completed, files touched, verification run, and any blocker.`,
      }
    })

    return {
      batch_id: batch.batch_id,
      group: batch.group,
      mode: batch.mode,
      requests,
    }
  })
}

function buildReconcilePlan(
  dispatchPlan: ReturnType<typeof buildDispatchPlanFromGraphState>,
  dispatchRequests: ReturnType<typeof buildDispatchRequests>
) {
  const allRequestIds = dispatchRequests.flatMap((batch) => batch.requests.map((request) => request.request_id))
  return {
    reconcile_required: dispatchPlan.reconcile_required,
    reconcile_scope: dispatchPlan.reconcile_scope,
    verifier_hint: dispatchPlan.reconcile_required ? "run verifier after merging parallel outputs" : "verify serial batch output",
    expected_result_paths: dispatchRequests.flatMap((batch) => batch.requests.map((request) => request.result_path)),
    request_ids: allRequestIds,
  }
}

function materializeDispatchArtifact(
  handoffData: Record<string, unknown>,
  dispatchPlanPath: string,
  taskGraphPath: string | null,
  executionTarget: string | null,
  phase: string | null,
  dispatchPlan: ReturnType<typeof buildDispatchPlanFromGraphState>,
  dispatchRequests: ReturnType<typeof buildDispatchRequests>,
  reconcilePlan: ReturnType<typeof buildReconcilePlan>,
  completedNodeIds: string[],
  generatedAt: string
) {
  return {
    schema_version: "1",
    workflow_id: handoffData.workflow_id || handoffData.slug || "workflow",
    slug: handoffData.slug || "workflow",
    generated_at: generatedAt,
    store_policy: ensureStorePolicy(handoffData),
    dispatch_plan_path: dispatchPlanPath,
    task_graph_path: taskGraphPath,
    execution_target: executionTarget,
    phase,
    completed_node_ids: completedNodeIds,
    ...dispatchPlan,
    dispatch_requests: dispatchRequests,
    reconcile_plan: reconcilePlan,
  }
}

function summarizeDispatchRequests(dispatchRequests: Array<Record<string, unknown>>) {
  const flatRequests = dispatchRequests.flatMap((batch) =>
    Array.isArray(batch.requests) ? (batch.requests as Array<Record<string, unknown>>) : []
  )
  const statusOf = (request: Record<string, unknown>) => ((request.request_status as string | undefined) || "pending").trim()
  const completed = flatRequests.filter((request) => statusOf(request) === "completed")
  const blocked = flatRequests.filter((request) => ["blocked", "failed", "cancelled"].includes(statusOf(request)))
  const pending = flatRequests.filter((request) => ["pending", "queued", "in-progress"].includes(statusOf(request)))

  return {
    request_count: flatRequests.length,
    completed_request_ids: completed.map((request) => String(request.request_id || "")).filter(Boolean),
    blocked_request_ids: blocked.map((request) => String(request.request_id || "")).filter(Boolean),
    pending_request_ids: pending.map((request) => String(request.request_id || "")).filter(Boolean),
  }
}

function relativeIfAbsolute(root: string, candidate: string | null | undefined) {
  if (!candidate) return null
  return path.isAbsolute(candidate) ? path.relative(root, candidate) : candidate
}

function sameResolvedPath(root: string, left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false
  return resolvePath(root, left) === resolvePath(root, right)
}

function hasDelegateLaunchMarker(sessionOrRequest: Record<string, unknown> | null | undefined) {
  if (!sessionOrRequest) return false
  const metadata = (sessionOrRequest.metadata as Record<string, unknown> | undefined) || null
  return Boolean(
    (typeof sessionOrRequest.session_url === "string" && sessionOrRequest.session_url.trim()) ||
      (typeof sessionOrRequest.delegate_session_url === "string" && sessionOrRequest.delegate_session_url.trim()) ||
      (typeof metadata?.delegate_task_id === "string" && metadata.delegate_task_id.trim()) ||
      (typeof metadata?.delegate_launch_handle === "string" && metadata.delegate_launch_handle.trim()) ||
      (typeof sessionOrRequest.delegate_task_id === "string" && sessionOrRequest.delegate_task_id.trim()) ||
      (typeof sessionOrRequest.delegate_launch_handle === "string" && sessionOrRequest.delegate_launch_handle.trim())
  )
}

function parseIsoMs(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function latestKnownActivityMs(...values: unknown[]) {
  const timestamps = values.map(parseIsoMs).filter((value): value is number => value !== null)
  if (timestamps.length === 0) return null
  return Math.max(...timestamps)
}

function isStaleMs(lastSeenMs: number | null, nowMs: number, thresholdMs: number) {
  return lastSeenMs !== null && nowMs - lastSeenMs > thresholdMs
}

function summarizeStartupBrief(startupState: Record<string, unknown> | null) {
  const startupBrief = (startupState?.startup_brief as Record<string, unknown> | undefined) || null
  if (!startupBrief) return null

  const parts: string[] = []
  if (typeof startupBrief.goal_summary === "string" && startupBrief.goal_summary.trim()) {
    parts.push(startupBrief.goal_summary.trim())
  }
  if (Array.isArray(startupBrief.codebase_context) && startupBrief.codebase_context.length > 0) {
    parts.push(`context: ${(startupBrief.codebase_context as string[]).slice(0, 2).join("; ")}`)
  }
  if (Array.isArray(startupBrief.likely_file_targets) && startupBrief.likely_file_targets.length > 0) {
    parts.push(`files: ${(startupBrief.likely_file_targets as string[]).slice(0, 3).join(", ")}`)
  }
  if (Array.isArray(startupBrief.risks) && startupBrief.risks.length > 0) {
    parts.push(`risks: ${(startupBrief.risks as string[]).slice(0, 2).join("; ")}`)
  }

  return parts.length > 0 ? parts.join(" | ") : null
}

function defaultCommandForStage(stage: string | null | undefined, handoffRel: string) {
  if (!stage) return null
  if (stage === "deep-interview") return `/deep-interview ${handoffRel}`
  if (stage === "ralplan") return `/ralplan ${handoffRel}`
  if (stage === "review-bridge") return `/review-bridge ${handoffRel}`
  if (stage === "autopilot") return `/autopilot ${handoffRel}`
  if (stage === "workflow-verify") return `/workflow-verify ${handoffRel}`
  if (stage === "workflow-archive") return `/workflow-archive ${handoffRel}`
  return null
}

function buildWorkflowPhaseGraph(handoffData: Record<string, unknown>) {
  const nodes: string[] = []
  if (typeof handoffData.startup_state_path === "string") nodes.push("workflow-start")
  if (typeof handoffData.runtime_spec_path === "string") nodes.push("deep-interview")
  nodes.push("ralplan")
  if (handoffData.review_required_before_execution !== false) nodes.push("review-bridge")
  nodes.push("autopilot", "workflow-verify", "workflow-archive")
  const uniqueNodes = [...new Set(nodes)]
  return {
    graph_type: "phase-dag",
    current_stage: (handoffData.stage as string | undefined) || uniqueNodes[0] || null,
    next_stage: (handoffData.preferred_next_stage as string | undefined) || null,
    nodes: uniqueNodes.map((id, index) => ({ id, index })),
    edges: uniqueNodes.slice(0, -1).map((from, index) => ({ from, to: uniqueNodes[index + 1] })),
  }
}

function attachPhaseGraph(handoffData: Record<string, unknown>) {
  return attachArtifactRefs({
    ...handoffData,
    phase_graph: buildWorkflowPhaseGraph(handoffData),
  })
}

async function resolveWorkflowContinuation(
  root: string,
  args: { handoff_path?: string; artifact_path?: string; review_path?: string }
) {
  const resolved = args.handoff_path
    ? {
        handoffPath: resolvePath(root, args.handoff_path),
        handoffData: await readJsonFile<Record<string, unknown>>(resolvePath(root, args.handoff_path)),
      }
    : args.artifact_path
      ? await resolveHandoffFromArtifact(root, args.artifact_path)
      : { handoffPath: "", handoffData: null }
  const handoffPath = resolved.handoffPath
  const handoffData = resolved.handoffData
  if (!handoffData) {
    return { ok: false, error: `missing handoff: ${handoffPath || args.artifact_path || "unknown"}` }
  }

  const reviewPath = resolvePath(
    root,
    args.review_path ||
      (handoffData.review_path as string | undefined) ||
      relativeIfAbsolute(root, defaultReviewPathFromHandoff(root, handoffData)) ||
      defaultReviewPathFromHandoff(root, handoffData)
  )
  const reviewData = await readJsonFile<Record<string, unknown>>(reviewPath)
  const verificationPath = resolvePath(
    root,
    (handoffData.verification_path as string | undefined) ||
      relativeIfAbsolute(root, defaultVerificationPathFromHandoff(root, handoffData)) ||
      defaultVerificationPathFromHandoff(root, handoffData)
  )
  const verificationData = await readJsonFile<Record<string, unknown>>(verificationPath)
  const archivePath = resolvePath(
    root,
    (handoffData.archive_path as string | undefined) ||
      relativeIfAbsolute(root, defaultArchivePathFromHandoff(root, handoffData)) ||
      defaultArchivePathFromHandoff(root, handoffData)
  )
  const archiveData = await readJsonFile<Record<string, unknown>>(archivePath)
  const planningSession = normalizeSessionSnapshot("planning_session", currentSession(handoffData, "planning_session"))
  const reviewSession = normalizeSessionSnapshot("review_session", currentSession(handoffData, "review_session"), "opencode")
  const executionSession = normalizeSessionSnapshot("execution_session", currentSession(handoffData, "execution_session"))
  const verificationSession = normalizeSessionSnapshot("verification_session", currentSession(handoffData, "verification_session"), "opencode")
  const archiveSession = normalizeSessionSnapshot("archive_session", currentSession(handoffData, "archive_session"), "opencode")
  const handoffStatus = (handoffData.handoff_status as string | undefined) || "ready-for-planning"
  const handoffRel = relativeIfAbsolute(root, handoffPath) || handoffPath
  const reviewRel = relativeIfAbsolute(root, reviewData ? reviewPath : (handoffData.review_path as string | undefined))
  const verificationRel = relativeIfAbsolute(
    root,
    verificationData ? verificationPath : (handoffData.verification_path as string | undefined)
  )
  const archiveRel = relativeIfAbsolute(root, archiveData ? archivePath : (handoffData.archive_path as string | undefined))
  const startupStatePath = typeof handoffData.startup_state_path === "string"
    ? resolvePath(root, handoffData.startup_state_path)
    : null
  const startupState = startupStatePath ? await readJsonFile<Record<string, unknown>>(startupStatePath) : null
  const startupRel = relativeIfAbsolute(root, startupStatePath)
  const startupStatus = (startupState?.status as string | undefined) || null
  const startupBrief = (startupState?.startup_brief as Record<string, unknown> | undefined) || null
  const startupResume = (startupState?.resume as Record<string, unknown> | undefined) || null
  const startupSummary = summarizeStartupBrief(startupState)
  const preferredStartupStage =
    (handoffData.preferred_next_stage as string | undefined) ||
    (startupBrief?.recommended_next_stage as string | undefined) ||
    null
  const preferredStartupCommand =
    (handoffData.preferred_next_command as string | undefined) ||
    (startupResume?.next_command_on_confirm as string | undefined) ||
    defaultCommandForStage(preferredStartupStage, handoffRel)
  const startupContext = startupState
    ? {
        startup_state_path: startupRel || startupStatePath,
        startup_state_status: startupStatus,
        startup_brief: startupBrief,
        startup_summary: startupSummary,
        startup_confirmation_required: ((startupState.confirmation as Record<string, unknown> | undefined)?.required as boolean | undefined) || false,
        startup_summary_source: (startupResume?.summary_source as string | undefined) || null,
      }
    : {}
  const approvedArtifact =
    (handoffData.approved_artifact as string | undefined) ||
    (reviewData?.approved_artifact as string | undefined) ||
    null

  if (startupState && startupState.confirmation && startupState.status === "awaiting-confirmation") {
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: "workflow-start",
      operation: "resume",
      can_continue: false,
      reason: "startup confirmation is still required",
      artifact_path: handoffRel,
      command: preferredStartupCommand,
      preferred_next_stage: preferredStartupStage,
      startup_state: startupState,
      ...startupContext,
    }
  }

  if (startupStatus === "cancelled") {
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: "workflow-start",
      operation: null,
      can_continue: false,
      reason: "startup flow was cancelled",
      command: preferredStartupCommand,
      preferred_next_stage: preferredStartupStage,
      startup_state: startupState,
      ...startupContext,
    }
  }

  if (handoffStatus === "blocked") {
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: null,
      operation: null,
      can_continue: false,
      reason: "workflow is blocked",
      blocking_reason:
        (executionSession?.metadata.blocking_reason as string | undefined) ||
        ((reviewData?.blocking_issues as string[] | undefined)?.join("; ") || null),
      ...startupContext,
    }
  }

  if (handoffStatus === "completed") {
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: "done",
      operation: null,
      can_continue: false,
      reason: "workflow already completed",
      ...startupContext,
    }
  }

  if (handoffStatus === "ready-for-planning" || handoffStatus === "planned") {
    if (startupStatus === "confirmed" && preferredStartupStage === "deep-interview") {
      return {
        ok: true,
        handoff_path: handoffPath,
        handoff_status: handoffStatus,
        stage: "deep-interview",
        operation: "resume",
        can_continue: false,
        reason: "startup confirmed and ready for deep interview",
        artifact_path: handoffRel,
        command: preferredStartupCommand,
        ...startupContext,
      }
    }

    const operation = planningSession && !isTerminalSessionState(planningSession.state) ? "resume" : "start"
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: "ralplan",
      operation,
      can_continue: true,
      reason: operation === "resume" ? "planning still active in current flow" : "planning not started yet",
      artifact_path: handoffRel,
      command: preferredStartupStage === "ralplan" ? preferredStartupCommand : `/ralplan ${handoffRel}`,
      session: planningSession,
      ...startupContext,
    }
  }

  if (handoffStatus === "review-required") {
    const operation = reviewSession && !isTerminalSessionState(reviewSession.state) ? "resume" : "start"
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: "review-bridge",
      operation,
      can_continue: true,
      reason: operation === "resume" ? "review still active in current flow" : "review required before execution",
      artifact_path: handoffRel,
      review_path: reviewRel,
      command: `/review-bridge ${handoffRel}`,
      session: reviewSession,
      review_target:
        (reviewData?.review_target as string | undefined) ||
        (reviewSession?.metadata.review_target as string | undefined) ||
        (handoffData.consensus_plan_path as string | undefined) ||
        (handoffData.runtime_spec_path as string | undefined) ||
        null,
      ...startupContext,
    }
  }

  if (handoffStatus === "ready-for-execution" || handoffStatus === "executing") {
    const operation = executionSession && !isTerminalSessionState(executionSession.state) ? "resume" : "start"
    const artifactPath = reviewRel || handoffRel
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: "autopilot",
      operation,
      can_continue: true,
      reason: operation === "resume" ? "execution still active in current flow" : "execution is ready to start",
      artifact_path: artifactPath,
      approved_artifact: approvedArtifact,
      command: preferredStartupStage === "autopilot" ? preferredStartupCommand : `/autopilot ${artifactPath}`,
      session: executionSession,
      ...startupContext,
    }
  }

  if (handoffStatus === "ready-for-verification" || handoffStatus === "verifying") {
    const operation = verificationSession && !isTerminalSessionState(verificationSession.state) ? "resume" : "start"
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: "workflow-verify",
      operation,
      can_continue: true,
      reason: operation === "resume" ? "verification still active in current flow" : "verification is ready to start",
      artifact_path: handoffRel,
      verification_path: verificationRel,
      command: `/workflow-verify ${handoffRel}`,
      session: verificationSession,
      approved_artifact: approvedArtifact,
      verification_target:
        (verificationData?.verification_target as string | undefined) ||
        (handoffData.approved_artifact as string | undefined) ||
        (handoffData.consensus_plan_path as string | undefined) ||
        null,
      ...startupContext,
    }
  }

  if (handoffStatus === "ready-for-archive" || handoffStatus === "archiving") {
    const operation = archiveSession && !isTerminalSessionState(archiveSession.state) ? "resume" : "start"
    return {
      ok: true,
      handoff_path: handoffPath,
      handoff_status: handoffStatus,
      stage: "workflow-archive",
      operation,
      can_continue: true,
      reason: operation === "resume" ? "archive still active in current flow" : "archive is ready to start",
      artifact_path: handoffRel,
      archive_path: archiveRel,
      command: `/workflow-archive ${handoffRel}`,
      session: archiveSession,
      approved_artifact: approvedArtifact,
      ...startupContext,
    }
  }

  return {
    ok: true,
    handoff_path: handoffPath,
    handoff_status: handoffStatus,
    stage: null,
    operation: null,
    can_continue: false,
    reason: "no supervised continuation rule matched current handoff state",
    ...startupContext,
  }
}

async function resolveHandoffFromArtifact(
  root: string,
  artifactPath: string
): Promise<{ handoffPath: string; handoffData: Record<string, unknown> | null }> {
  const resolved = resolvePath(root, artifactPath)
  const data = await readJsonFile<Record<string, unknown>>(resolved)
  if (!data) {
    return { handoffPath: resolved, handoffData: null }
  }
  const resume = (data.resume as Record<string, unknown> | undefined) || null
  const linkedHandoffPath =
    typeof data.handoff_path === "string"
      ? data.handoff_path
      : typeof resume?.handoff_path === "string"
        ? (resume.handoff_path as string)
        : null
  if (resolved.endsWith(".json") && linkedHandoffPath) {
    const handoffPath = resolvePath(root, linkedHandoffPath)
    return { handoffPath, handoffData: await readJsonFile<Record<string, unknown>>(handoffPath) }
  }
  return { handoffPath: resolved, handoffData: data }
}

export const init = tool({
  description: "Initialize .opencode workflow runtime directories",
  args: {},
  async execute(_args, context) {
    const root = baseDir(context)
    const dirs = [
      ".opencode/state",
      ".opencode/specs",
      ".opencode/plans",
      ".opencode/executions",
      ".opencode/executions/results",
      ".opencode/handoffs",
      ".opencode/reviews",
      ".opencode/verifications",
      ".opencode/archives",
      ".opencode/context",
      ".opencode/sessions",
      ".opencode/smoke",
    ]
    for (const dir of dirs) {
      await mkdir(path.join(root, dir), { recursive: true })
    }
    return JSON.stringify({ ok: true, root, dirs }, null, 2)
  },
})

export const handoff = tool({
  description: "Create or update a workflow handoff artifact deterministically",
  args: {
    path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    workflow_id: tool.schema.string().optional(),
    slug: tool.schema.string().optional(),
    stage: tool.schema.string().optional(),
    handoff_status: tool.schema.enum(handoffStatuses).optional(),
    last_transition: tool.schema.string().optional(),
    change_id: tool.schema.string().nullable().optional(),
    runtime_spec_path: tool.schema.string().nullable().optional(),
    plan_path: tool.schema.string().nullable().optional(),
    consensus_plan_path: tool.schema.string().nullable().optional(),
    task_graph_path: tool.schema.string().nullable().optional(),
    dispatch_plan_path: tool.schema.string().nullable().optional(),
    startup_state_path: tool.schema.string().nullable().optional(),
    review_path: tool.schema.string().nullable().optional(),
    verification_path: tool.schema.string().nullable().optional(),
    archive_path: tool.schema.string().nullable().optional(),
    approved_artifact: tool.schema.string().nullable().optional(),
    store_policy: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
    artifact_refs: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
    preferred_next_stage: tool.schema.string().optional(),
    preferred_next_command: tool.schema.string().optional(),
    review_required_before_execution: tool.schema.boolean().optional(),
    approval_status: tool.schema.enum(approvalStatuses).optional(),
    planning_session: sessionSchema.nullable().optional(),
    review_session: sessionSchema.nullable().optional(),
    execution_session: sessionSchema.nullable().optional(),
    verification_session: sessionSchema.nullable().optional(),
    archive_session: sessionSchema.nullable().optional(),
    execution_scope: tool.schema.array(tool.schema.string()).optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const filePath = resolvePath(root, args.path)
    const existing = (await readJsonFile<Record<string, unknown>>(filePath)) || { schema_version: "1" }
    const next = attachArtifactRefs(attachPhaseGraph({
      schema_version: "1",
      ...existing,
      ...Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined && value !== "")
      ),
      generated_at: args.generated_at || (existing.generated_at as string) || nowIso(),
    }))
    await writeJsonFile(filePath, next)
    return JSON.stringify({ ok: true, path: filePath, handoff: next }, null, 2)
  },
})

export const startup_state = tool({
  description: "Create or update a workflow startup-state artifact deterministically",
  args: {
    path: tool.schema.string().describe("Relative or absolute path to startup state json"),
    workflow_id: tool.schema.string().optional(),
    slug: tool.schema.string().optional(),
    request_text: tool.schema.string().optional(),
    created_at: tool.schema.string().optional(),
    status: tool.schema.enum(startupStatuses).optional(),
    startup_brief: startupBriefSchema.optional(),
    confirmation: startupConfirmationSchema.optional(),
    resume: startupResumeSchema.optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const filePath = resolvePath(root, args.path)
    const existing = (await readJsonFile<Record<string, unknown>>(filePath)) || { schema_version: "1" }
    const next = {
      schema_version: "1",
      ...existing,
      ...Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined && value !== "")
      ),
      created_at: args.created_at || (existing.created_at as string) || nowIso(),
      generated_at: args.generated_at || (existing.generated_at as string) || nowIso(),
    }
    await writeJsonFile(filePath, next)
    return JSON.stringify({ ok: true, path: filePath, startup_state: next }, null, 2)
  },
})

export const startup_runtime = tool({
  description: "Create, resume, confirm, cancel, or inspect workflow startup state",
  args: {
    operation: tool.schema.enum(["start", "resume", "confirm", "cancel", "status"] as const),
    handoff_path: tool.schema.string().optional(),
    startup_state_path: tool.schema.string().optional(),
    workflow_id: tool.schema.string().optional(),
    slug: tool.schema.string().optional(),
    request_text: tool.schema.string().optional(),
    goal_summary: tool.schema.string().optional(),
    codebase_context: tool.schema.array(tool.schema.string()).optional(),
    likely_file_targets: tool.schema.array(tool.schema.string()).optional(),
    risks: tool.schema.array(tool.schema.string()).optional(),
    recommended_next_stage: tool.schema.string().optional(),
    summary_source: tool.schema.string().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const now = args.generated_at || nowIso()
    const requestedHandoffPath = args.handoff_path ? resolvePath(root, args.handoff_path) : null
    const requestedHandoffData = requestedHandoffPath ? await readJsonFile<Record<string, unknown>>(requestedHandoffPath) : null
    const startupPathSeed =
      args.startup_state_path ||
      (requestedHandoffData?.startup_state_path as string | undefined) ||
      null
    const seededStartupPath = startupPathSeed ? resolvePath(root, startupPathSeed) : null
    const seededStartupData = seededStartupPath ? await readJsonFile<Record<string, unknown>>(seededStartupPath) : null
    const slug =
      args.slug ||
      (requestedHandoffData?.slug as string | undefined) ||
      (seededStartupData?.slug as string | undefined) ||
      (args.request_text || "workflow")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") ||
      "workflow"
    const storeBase = workflowStoreBase((requestedHandoffData as Record<string, unknown> | null | undefined) || seededStartupData)
    const handoffPath = requestedHandoffPath || resolvePath(root, path.join(storeBase, "handoffs", `handoff-${slug}.json`))
    const handoffData = requestedHandoffData || (await readJsonFile<Record<string, unknown>>(handoffPath)) || null
    const workflowId =
      args.workflow_id ||
      (handoffData?.workflow_id as string | undefined) ||
      (seededStartupData?.workflow_id as string | undefined) ||
      randomUUID()
    const startupPath = resolvePath(
      root,
      args.startup_state_path ||
        (handoffData?.startup_state_path as string | undefined) ||
        path.join(storeBase, "state", `startup-${slug}.json`)
    )
    const startupData = seededStartupPath === startupPath ? seededStartupData : await readJsonFile<Record<string, unknown>>(startupPath)
    const handoffRel = path.relative(root, handoffPath)
    const startupRel = path.relative(root, startupPath)
    const recommendedNextStage =
      args.recommended_next_stage ||
      (startupData?.startup_brief as Record<string, unknown> | undefined)?.recommended_next_stage as string | undefined ||
      (handoffData?.preferred_next_stage as string | undefined) ||
      "ralplan"
    const nextCommand = defaultCommandForStage(recommendedNextStage, handoffRel)
    const nextBrief = {
      goal_summary:
        args.goal_summary ||
        ((startupData?.startup_brief as Record<string, unknown> | undefined)?.goal_summary as string | undefined) ||
        args.request_text ||
        (startupData?.request_text as string | undefined) ||
        "Startup request",
      codebase_context:
        args.codebase_context ||
        ((startupData?.startup_brief as Record<string, unknown> | undefined)?.codebase_context as string[] | undefined) ||
        [],
      likely_file_targets:
        args.likely_file_targets ||
        ((startupData?.startup_brief as Record<string, unknown> | undefined)?.likely_file_targets as string[] | undefined) ||
        [],
      risks:
        args.risks || ((startupData?.startup_brief as Record<string, unknown> | undefined)?.risks as string[] | undefined) || [],
      recommended_next_stage: recommendedNextStage,
    }
    const existingConfirmation = (startupData?.confirmation as Record<string, unknown> | undefined) || {}

    if (args.operation === "status" || args.operation === "resume") {
      return JSON.stringify(
        {
          ok: !!startupData,
          operation: args.operation,
          handoff_path: handoffPath,
          startup_state_path: startupRel,
          startup_state: startupData,
          startup_summary: summarizeStartupBrief(startupData),
          next_stage: recommendedNextStage,
          next_command: nextCommand,
          next_expected_input:
            startupData?.status === "awaiting-confirmation" ? "explicit confirmation or cancellation" : null,
        },
        null,
        2
      )
    }

    if (args.operation === "start") {
      const nextStartupState = {
        schema_version: "1",
        workflow_id: workflowId,
        slug,
        store_policy: ensureStorePolicy(handoffData || { store_policy: { base_locator: storeBase } }),
        request_text: args.request_text || (startupData?.request_text as string | undefined) || "",
        created_at: (startupData?.created_at as string | undefined) || now,
        status: "awaiting-confirmation",
        startup_brief: nextBrief,
        confirmation: {
          required: true,
          asked_at: now,
          decision: null,
          decided_at: null,
        },
        resume: {
          handoff_path: handoffRel,
          next_command_on_confirm: nextCommand,
          summary_source: args.summary_source || "startup-runtime",
        },
        generated_at: now,
      }
      await writeJsonFile(startupPath, nextStartupState)

      const nextHandoff = attachPhaseGraph({
        schema_version: "1",
        ...handoffData,
        workflow_id: workflowId,
        slug,
        stage: (handoffData?.stage as string | undefined) || "workflow-start",
        handoff_status: (handoffData?.handoff_status as string | undefined) || "ready-for-planning",
        startup_state_path: startupRel,
        preferred_next_stage: recommendedNextStage,
        preferred_next_command: nextCommand,
        review_required_before_execution: (handoffData?.review_required_before_execution as boolean | undefined) ?? true,
        approval_status: (handoffData?.approval_status as string | undefined) || "not-reviewed",
        last_transition: "startup summary awaiting confirmation",
        generated_at: now,
      })
      await writeJsonFile(handoffPath, nextHandoff)

      return JSON.stringify(
        {
          ok: true,
          operation: args.operation,
          handoff_path: handoffPath,
          startup_state_path: startupRel,
          startup_state: nextStartupState,
          startup_summary: summarizeStartupBrief(nextStartupState),
          next_stage: recommendedNextStage,
          next_command: nextCommand,
          next_expected_input: "explicit confirmation or cancellation",
        },
        null,
        2
      )
    }

    if (!startupData) {
      return JSON.stringify({ ok: false, error: `missing startup state: ${startupPath}` }, null, 2)
    }

    const nextStatus = args.operation === "confirm" ? "confirmed" : "cancelled"
    const decision = args.operation === "confirm" ? "confirmed" : "cancelled"
    const nextStartupState = {
      ...startupData,
      store_policy: ensureStorePolicy(handoffData || { store_policy: { base_locator: storeBase } }),
      status: nextStatus,
      startup_brief: nextBrief,
      confirmation: {
        required: true,
        asked_at: (existingConfirmation.asked_at as string | undefined) || now,
        decision,
        decided_at: now,
      },
      resume: {
        handoff_path: handoffRel,
        next_command_on_confirm: nextCommand,
        summary_source:
          args.summary_source ||
          ((startupData.resume as Record<string, unknown> | undefined)?.summary_source as string | undefined) ||
          "startup-runtime",
      },
      generated_at: now,
    }
    await writeJsonFile(startupPath, nextStartupState)

    const nextHandoff = attachPhaseGraph({
      schema_version: "1",
      ...handoffData,
      workflow_id: workflowId,
      slug,
      stage: (handoffData?.stage as string | undefined) || "workflow-start",
      handoff_status: (handoffData?.handoff_status as string | undefined) || "ready-for-planning",
      startup_state_path: startupRel,
      preferred_next_stage: recommendedNextStage,
      preferred_next_command: nextCommand,
      review_required_before_execution: (handoffData?.review_required_before_execution as boolean | undefined) ?? true,
      approval_status: (handoffData?.approval_status as string | undefined) || "not-reviewed",
      last_transition:
        args.operation === "confirm" ? "startup confirmed for continuation" : "startup cancelled by user",
      generated_at: now,
    })
    await writeJsonFile(handoffPath, nextHandoff)

    return JSON.stringify(
      {
        ok: true,
        operation: args.operation,
        handoff_path: handoffPath,
        startup_state_path: startupRel,
        startup_state: nextStartupState,
        startup_summary: summarizeStartupBrief(nextStartupState),
        next_stage: recommendedNextStage,
        next_command: nextCommand,
        can_continue: args.operation === "confirm",
      },
      null,
      2
    )
  },
})

export const review = tool({
  description: "Create or update a workflow review artifact deterministically",
  args: {
    path: tool.schema.string().describe("Relative or absolute path to review.json"),
    workflow_id: tool.schema.string().optional(),
    slug: tool.schema.string().optional(),
    change_id: tool.schema.string().nullable().optional(),
    review_target: tool.schema.string().optional(),
    review_type: tool.schema.enum(reviewTypes).optional(),
    status: tool.schema.enum(reviewStatuses).optional(),
    blocking_issues: tool.schema.array(tool.schema.string()).optional(),
    approved_artifact: tool.schema.string().nullable().optional(),
    handoff_path: tool.schema.string().optional(),
    review_session: sessionSchema.nullable().optional(),
    decision_at: tool.schema.string().nullable().optional(),
    decision_by: tool.schema.string().nullable().optional(),
    session_events: tool.schema
      .array(
        tool.schema.object({
          at: tool.schema.string(),
          type: tool.schema.string(),
          actor: tool.schema.string().nullable().optional(),
          note: tool.schema.string().nullable().optional(),
        })
      )
      .optional(),
    notes: tool.schema.array(tool.schema.string()).optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const filePath = resolvePath(root, args.path)
    const existing = (await readJsonFile<Record<string, unknown>>(filePath)) || { schema_version: "1" }
    const next = {
      schema_version: "1",
      ...existing,
      ...Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined && value !== "")
      ),
      generated_at: args.generated_at || (existing.generated_at as string) || nowIso(),
    }
    await writeJsonFile(filePath, next)
    return JSON.stringify({ ok: true, path: filePath, review: next }, null, 2)
  },
})

export const execution_dispatch_result = tool({
  description: "Record a dispatch request result and update reconcile metadata",
  args: {
    handoff_path: tool.schema.string().optional(),
    dispatch_plan_path: tool.schema.string().optional(),
    request_id: tool.schema.string(),
    request_status: tool.schema.enum(dispatchRequestStatuses),
    summary: tool.schema.string().optional(),
    blocker: tool.schema.string().optional(),
    files_touched: tool.schema.array(tool.schema.string()).optional(),
    verification_commands: tool.schema.array(tool.schema.string()).optional(),
    verification_artifacts: tool.schema.array(tool.schema.string()).optional(),
    delegate_task_id: tool.schema.string().optional(),
    delegate_launch_handle: tool.schema.string().optional(),
    delegate_session_url: tool.schema.string().nullable().optional(),
    delegate_started_at: tool.schema.string().optional(),
    delegate_last_output_at: tool.schema.string().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const now = args.generated_at || nowIso()
    const resolved = args.handoff_path
      ? {
          handoffPath: resolvePath(root, args.handoff_path),
          handoffData: await readJsonFile<Record<string, unknown>>(resolvePath(root, args.handoff_path)),
        }
      : { handoffPath: "", handoffData: null }
    const handoffPath = resolved.handoffPath
    const handoffData = resolved.handoffData
    const dispatchPlanPath = resolvePath(
      root,
      args.dispatch_plan_path ||
        (handoffData?.dispatch_plan_path as string | undefined) ||
        (handoffData ? defaultDispatchPlanPathFromHandoff(root, handoffData) : "")
    )
    const dispatchArtifact = await readJsonFile<Record<string, unknown>>(dispatchPlanPath)
    if (!dispatchArtifact) {
      return JSON.stringify({ ok: false, error: `missing dispatch artifact: ${dispatchPlanPath}` }, null, 2)
    }

    const dispatchRequests = Array.isArray(dispatchArtifact.dispatch_requests)
      ? (dispatchArtifact.dispatch_requests as Array<Record<string, unknown>>)
      : []
    let matched = false
    let matchedResultPath: string | null = null
    let matchedNodeId: string | null = null
    let matchedDelegateIdentity: string | null = null
    let matchedDelegateContract: Record<string, unknown> | null = null
    let matchedContextPath: string | null = null
    const nextDispatchRequests = dispatchRequests.map((batch) => {
      const requests = Array.isArray(batch.requests) ? (batch.requests as Array<Record<string, unknown>>) : []
      return {
        ...batch,
        requests: requests.map((request) => {
          if (request.request_id !== args.request_id) return request
          matched = true
          matchedResultPath = typeof request.result_path === "string" ? request.result_path : null
          matchedNodeId = typeof request.node_id === "string" ? request.node_id : null
          matchedDelegateIdentity = typeof request.delegate_identity === "string" ? request.delegate_identity : null
          matchedContextPath = typeof request.context_path === "string" ? request.context_path : null
          matchedDelegateContract =
            request.delegate_contract && typeof request.delegate_contract === "object"
              ? (request.delegate_contract as Record<string, unknown>)
              : null
          return {
            ...request,
            request_status: args.request_status,
            completed_at: ["completed", "blocked", "failed", "cancelled"].includes(args.request_status) ? now : null,
            summary: args.summary || null,
            blocker: args.blocker || null,
            files_touched: args.files_touched || [],
            verification_commands: args.verification_commands || [],
            verification_artifacts: args.verification_artifacts || [],
            delegate_task_id: args.delegate_task_id || request.delegate_task_id || null,
            delegate_launch_handle: args.delegate_launch_handle || request.delegate_launch_handle || null,
            delegate_session_url:
              args.delegate_session_url !== undefined
                ? args.delegate_session_url
                : (request.delegate_session_url as string | null | undefined) ?? null,
            delegate_started_at: args.delegate_started_at || request.delegate_started_at || null,
            delegate_last_output_at: args.delegate_last_output_at || now,
          }
        }),
      }
    })

    if (!matched) {
      return JSON.stringify({ ok: false, error: `unknown dispatch request: ${args.request_id}` }, null, 2)
    }

    const dispatchSummary = summarizeDispatchRequests(nextDispatchRequests)
    const currentCompletedNodeIds = Array.isArray(
      ((handoffData?.execution_session as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined)
        ?.completed_node_ids
    )
      ? ((((handoffData?.execution_session as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined)
          ?.completed_node_ids as string[]) || [])
      : Array.isArray(dispatchArtifact.completed_node_ids)
        ? ((dispatchArtifact.completed_node_ids as string[]) || [])
        : []
    const updatedCompletedNodeIds =
      args.request_status === "completed" && matchedNodeId && !currentCompletedNodeIds.includes(matchedNodeId)
        ? [...currentCompletedNodeIds, matchedNodeId]
        : currentCompletedNodeIds
    const taskGraphPath =
      (handoffData?.task_graph_path as string | undefined) || (dispatchArtifact.task_graph_path as string | undefined) || null
    const taskGraphData = await readTaskGraphFile(root, taskGraphPath)
    const shouldAdvance =
      dispatchSummary.pending_request_ids.length === 0 &&
      dispatchSummary.blocked_request_ids.length === 0 &&
      !!taskGraphData

    let graphState: ReturnType<typeof deriveTaskGraphExecutionState> | null = null
    let advancedDispatchPlan: ReturnType<typeof buildDispatchPlanFromGraphState> | null = null
    let advancedDispatchRequests: ReturnType<typeof buildDispatchRequests> | null = null
    if (shouldAdvance && taskGraphData) {
      const advancedGraphState = deriveTaskGraphExecutionState(taskGraphData, updatedCompletedNodeIds)
      const nextPlan = buildDispatchPlanFromGraphState(advancedGraphState)
      const nextRequests = buildDispatchRequests(
        String(dispatchArtifact.slug || handoffData?.slug || "workflow"),
        taskGraphData,
        (dispatchArtifact.execution_target as string | undefined) || null,
        nextPlan,
        workflowStoreBase((handoffData as Record<string, unknown> | null | undefined) || dispatchArtifact)
      )
      graphState = advancedGraphState
      advancedDispatchPlan = nextPlan
      advancedDispatchRequests = nextRequests
    }
    const advancedDispatchSummary = advancedDispatchRequests ? summarizeDispatchRequests(advancedDispatchRequests) : null
    const nextReconcilePlan = advancedDispatchRequests
      ? {
          ...buildReconcilePlan(advancedDispatchPlan, advancedDispatchRequests),
          status: advancedDispatchSummary && advancedDispatchSummary.pending_request_ids.length > 0 ? "pending" : "ready",
          completed_request_ids: [],
          blocked_request_ids: [],
          pending_request_ids: advancedDispatchSummary?.pending_request_ids || [],
        }
      : {
          ...(dispatchArtifact.reconcile_plan as Record<string, unknown> | undefined),
          status:
            dispatchSummary.blocked_request_ids.length > 0
              ? "blocked"
              : dispatchSummary.pending_request_ids.length > 0
                ? "pending"
                : "ready",
          completed_request_ids: dispatchSummary.completed_request_ids,
          blocked_request_ids: dispatchSummary.blocked_request_ids,
          pending_request_ids: dispatchSummary.pending_request_ids,
        }

    if (matchedResultPath) {
      const absoluteResultPath = resolvePath(root, matchedResultPath)
      await writeJsonFile(absoluteResultPath, {
        schema_version: "1",
        workflow_id: dispatchArtifact.workflow_id || handoffData?.workflow_id || null,
        slug: dispatchArtifact.slug || handoffData?.slug || null,
        generated_at: now,
        request_id: args.request_id,
        delegate_identity: matchedDelegateIdentity,
        delegate_contract: matchedDelegateContract,
        context_path: matchedContextPath,
        request_status: args.request_status,
        summary: args.summary || null,
        blocker: args.blocker || null,
        files_touched: args.files_touched || [],
        verification_commands: args.verification_commands || [],
        verification_artifacts: args.verification_artifacts || [],
        delegate_task_id: args.delegate_task_id || null,
        delegate_launch_handle: args.delegate_launch_handle || null,
        delegate_session_url: args.delegate_session_url ?? null,
        delegate_started_at: args.delegate_started_at || null,
        delegate_last_output_at: args.delegate_last_output_at || now,
      })
    }

    const nextDispatchArtifact = {
      ...dispatchArtifact,
      generated_at: now,
      completed_node_ids: updatedCompletedNodeIds,
      ready_batch_count: advancedDispatchPlan ? advancedDispatchPlan.ready_batch_count : dispatchArtifact.ready_batch_count,
      ready_batches: advancedDispatchPlan ? advancedDispatchPlan.ready_batches : dispatchArtifact.ready_batches,
      reconcile_required: advancedDispatchPlan ? advancedDispatchPlan.reconcile_required : dispatchArtifact.reconcile_required,
      reconcile_scope: advancedDispatchPlan ? advancedDispatchPlan.reconcile_scope : dispatchArtifact.reconcile_scope,
      next_dispatch_mode: advancedDispatchPlan ? advancedDispatchPlan.next_dispatch_mode : dispatchArtifact.next_dispatch_mode,
      dispatch_requests: advancedDispatchRequests || nextDispatchRequests,
      request_summary: advancedDispatchSummary || dispatchSummary,
      reconcile_plan: nextReconcilePlan,
    }
    await writeJsonFile(dispatchPlanPath, nextDispatchArtifact)

    if (handoffData?.execution_session) {
      const nextExecutionMetadata: Record<string, unknown> = {
        ...((handoffData.execution_session as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
        dispatch_plan_path: path.relative(root, dispatchPlanPath),
        dispatch_requests: advancedDispatchRequests || nextDispatchRequests,
        dispatch_summary: advancedDispatchSummary || dispatchSummary,
        reconcile_plan: nextReconcilePlan,
        completed_node_ids: updatedCompletedNodeIds,
      }
      if (graphState) {
        nextExecutionMetadata["task_graph_state"] = graphState
      }
      if (advancedDispatchPlan) {
        nextExecutionMetadata["dispatch_plan"] = advancedDispatchPlan
      }
      const nextHandoff = attachPhaseGraph({
        ...handoffData,
        dispatch_plan_path: path.relative(root, dispatchPlanPath),
        execution_session: {
          ...((handoffData.execution_session as Record<string, unknown> | undefined) || {}),
          metadata: nextExecutionMetadata,
        },
        generated_at: now,
      })
      await writeJsonFile(handoffPath, nextHandoff)
    }

    const effectiveDispatchSummary = advancedDispatchSummary || dispatchSummary
    const effectiveGraphState = graphState || (taskGraphData ? deriveTaskGraphExecutionState(taskGraphData, updatedCompletedNodeIds) : null)
    let terminalExecution: Record<string, unknown> | null = null

    if (handoffData?.execution_session && handoffPath) {
      const noPending = effectiveDispatchSummary.pending_request_ids.length === 0
      const hasBlocked = effectiveDispatchSummary.blocked_request_ids.length > 0
      const noRemaining = !!effectiveGraphState && effectiveGraphState.remaining_node_ids.length === 0

      if (noPending && hasBlocked) {
        terminalExecution = JSON.parse(
          await autopilot_runtime.execute(
            {
              operation: "result",
              handoff_path: path.relative(root, handoffPath),
              terminal_state: "failed",
              phase: "blocked",
              result_summary: args.summary || `dispatch batch ${args.request_id} ended with blocked work`,
              blocking_reason: args.blocker || `blocked dispatch requests: ${effectiveDispatchSummary.blocked_request_ids.join(", ")}`,
              verification_commands: args.verification_commands || [],
              verification_artifacts: args.verification_artifacts || [],
            },
            context
          )
        ) as Record<string, unknown>
      } else if (noPending && noRemaining) {
        terminalExecution = JSON.parse(
          await autopilot_runtime.execute(
            {
              operation: "result",
              handoff_path: path.relative(root, handoffPath),
              terminal_state: "completed",
              phase: "done",
              result_summary: "all dispatch requests completed and the DAG has no remaining nodes",
              verification_summary: "autopilot dispatch batches completed without pending or blocked requests",
              verification_commands: args.verification_commands || [],
              verification_artifacts: args.verification_artifacts || [],
            },
            context
          )
        ) as Record<string, unknown>
      }
    }

    return JSON.stringify(
      {
        ok: true,
        dispatch_plan_path: dispatchPlanPath,
        request_id: args.request_id,
        request_status: args.request_status,
        request_summary: dispatchSummary,
        reconcile_plan: nextReconcilePlan,
        result_path: matchedResultPath,
        terminal_execution: terminalExecution,
      },
      null,
      2
    )
  },
})

export const execution_dispatch_claim = tool({
  description: "Claim the next ready dispatch batch before launching subagents",
  args: {
    handoff_path: tool.schema.string().optional(),
    dispatch_plan_path: tool.schema.string().optional(),
    batch_id: tool.schema.string().optional(),
    request_status: tool.schema.enum(dispatchRequestStatuses).optional(),
    delegate_task_id: tool.schema.string().optional(),
    delegate_launch_handle: tool.schema.string().optional(),
    delegate_session_url: tool.schema.string().nullable().optional(),
    delegate_started_at: tool.schema.string().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const now = args.generated_at || nowIso()
    const resolved = args.handoff_path
      ? {
          handoffPath: resolvePath(root, args.handoff_path),
          handoffData: await readJsonFile<Record<string, unknown>>(resolvePath(root, args.handoff_path)),
        }
      : { handoffPath: "", handoffData: null }
    const handoffPath = resolved.handoffPath
    const handoffData = resolved.handoffData
    const dispatchPlanPath = resolvePath(
      root,
      args.dispatch_plan_path ||
        (handoffData?.dispatch_plan_path as string | undefined) ||
        (handoffData ? defaultDispatchPlanPathFromHandoff(root, handoffData) : "")
    )
    const dispatchArtifact = await readJsonFile<Record<string, unknown>>(dispatchPlanPath)
    if (!dispatchArtifact) {
      return JSON.stringify({ ok: false, error: `missing dispatch artifact: ${dispatchPlanPath}` }, null, 2)
    }

    const dispatchRequests = Array.isArray(dispatchArtifact.dispatch_requests)
      ? (dispatchArtifact.dispatch_requests as Array<Record<string, unknown>>)
      : []
    const readyBatches = Array.isArray(dispatchArtifact.ready_batches)
      ? (dispatchArtifact.ready_batches as Array<Record<string, unknown>>)
      : []
    const claimableBatchIds = args.batch_id
      ? [args.batch_id]
      : readyBatches
          .filter((batch) => {
            const batchId = batch.batch_id as string | undefined
            const requestContainer = dispatchRequests.find((requestBatch) => requestBatch.batch_id === batchId)
            const requests = Array.isArray(requestContainer?.requests)
              ? (requestContainer?.requests as Array<Record<string, unknown>>)
              : []
            return requests.some((request) => ((request.request_status as string | undefined) || "pending") === "pending")
          })
          .filter((batch) => {
            const mode = (batch.mode as string | undefined) || "serial"
            return dispatchArtifact.next_dispatch_mode === "parallel" ? mode === "parallel" : mode === dispatchArtifact.next_dispatch_mode || mode === "serial"
          })
          .map((batch) => String(batch.batch_id || ""))
          .filter(Boolean)

    if (claimableBatchIds.length === 0) {
      return JSON.stringify({ ok: true, dispatch_plan_path: dispatchPlanPath, claimed: false, reason: "no ready pending batch" }, null, 2)
    }

    const claimStatus = args.request_status || "queued"
    const nextDispatchRequests = dispatchRequests.map((batch) => {
      if (!claimableBatchIds.includes(String(batch.batch_id || ""))) return batch
      const requests = Array.isArray(batch.requests) ? (batch.requests as Array<Record<string, unknown>>) : []
      return {
        ...batch,
        requests: requests.map((request) =>
          ((request.request_status as string | undefined) || "pending") === "pending"
            ? {
                ...request,
                request_status: claimStatus,
                claimed_at: now,
                delegate_task_id: args.delegate_task_id || request.delegate_task_id || null,
                delegate_launch_handle: args.delegate_launch_handle || request.delegate_launch_handle || null,
                delegate_session_url:
                  args.delegate_session_url !== undefined
                    ? args.delegate_session_url
                    : (request.delegate_session_url as string | null | undefined) ?? null,
                delegate_started_at: args.delegate_started_at || request.delegate_started_at || null,
              }
            : request
        ),
      }
    })

    const dispatchSummary = summarizeDispatchRequests(nextDispatchRequests)
    const nextReconcilePlan = {
      ...(dispatchArtifact.reconcile_plan as Record<string, unknown> | undefined),
      status: dispatchSummary.pending_request_ids.length > 0 ? "pending" : "ready",
      completed_request_ids: dispatchSummary.completed_request_ids,
      blocked_request_ids: dispatchSummary.blocked_request_ids,
      pending_request_ids: dispatchSummary.pending_request_ids,
    }
    const nextDispatchArtifact = {
      ...dispatchArtifact,
      generated_at: now,
      dispatch_requests: nextDispatchRequests,
      request_summary: dispatchSummary,
      reconcile_plan: nextReconcilePlan,
    }
    await writeJsonFile(dispatchPlanPath, nextDispatchArtifact)

    if (handoffData?.execution_session) {
      const nextHandoff = attachPhaseGraph({
        ...handoffData,
        dispatch_plan_path: path.relative(root, dispatchPlanPath),
        execution_session: {
          ...((handoffData.execution_session as Record<string, unknown> | undefined) || {}),
          metadata: {
            ...((handoffData.execution_session as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
            dispatch_plan_path: path.relative(root, dispatchPlanPath),
            dispatch_requests: nextDispatchRequests,
            dispatch_summary: dispatchSummary,
            reconcile_plan: nextReconcilePlan,
          },
        },
        generated_at: now,
      })
      await writeJsonFile(handoffPath, nextHandoff)
    }

    const claimedBatches = nextDispatchRequests.filter((batch) => claimableBatchIds.includes(String(batch.batch_id || "")))
    return JSON.stringify(
      {
        ok: true,
        dispatch_plan_path: dispatchPlanPath,
        batch_id: claimableBatchIds.length === 1 ? claimableBatchIds[0] : null,
        batch_ids: claimableBatchIds,
        claim_status: claimStatus,
        claimed: true,
        claimed_batch: claimableBatchIds.length === 1 ? claimedBatches[0] || null : null,
        claimed_batches: claimedBatches,
        request_summary: dispatchSummary,
        reconcile_plan: nextReconcilePlan,
      },
      null,
      2
    )
  },
})

export const session_start = tool({
  description: "Create or resume a workflow stage session deterministically",
  args: {
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    session_field: tool.schema.enum(sessionFields),
    provider: tool.schema.enum(sessionProviders).optional(),
    mode: tool.schema.enum(sessionModes).optional(),
    state: tool.schema.enum(sessionStates).optional(),
    handoff_status_on_start: tool.schema.enum(handoffStatuses).optional(),
    resume_command: tool.schema.string().nullable().optional(),
    session_url: tool.schema.string().nullable().optional(),
    metadata: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
    force_new: tool.schema.boolean().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = (await readJsonFile<Record<string, unknown>>(handoffPath)) || { schema_version: "1" }
    const existing = currentSession(handoffData, args.session_field)
    const normalizedExisting = normalizeSessionSnapshot(args.session_field, existing, args.provider || "opencode")
    const shouldReuse =
      !args.force_new &&
      normalizedExisting &&
      normalizedExisting.session_id &&
      !isTerminalSessionState(normalizedExisting.state)

    const session = shouldReuse
      ? {
          ...normalizedExisting,
          last_activity_at: args.generated_at || nowIso(),
          resume_command:
            args.resume_command !== undefined ? args.resume_command : normalizedExisting.resume_command,
          session_url: args.session_url !== undefined ? args.session_url : normalizedExisting.session_url,
          metadata: {
            ...normalizedExisting.metadata,
            ...(args.metadata || {}),
          },
        }
      : {
          kind: defaultKindForField(args.session_field),
          mode: args.mode || "async",
          session_id: randomUUID(),
          provider: args.provider || "opencode",
          state: args.state || "queued",
          requested_at: args.generated_at || nowIso(),
          started_at: null,
          last_activity_at: args.generated_at || nowIso(),
          expires_at: null,
          resume_command: args.resume_command ?? null,
          session_url: args.session_url ?? null,
          metadata: args.metadata || {},
        }

    const next = {
      schema_version: "1",
      ...handoffData,
      [args.session_field]: session,
      generated_at: args.generated_at || (handoffData.generated_at as string) || nowIso(),
    } as Record<string, unknown>

    if (args.handoff_status_on_start) next.handoff_status = args.handoff_status_on_start
    await writeJsonFile(handoffPath, next)

    return JSON.stringify(
      {
        ok: true,
        handoff_path: handoffPath,
        session_field: args.session_field,
        resumed: shouldReuse,
        session,
        handoff_status: next.handoff_status || null,
        approval_status: next.approval_status || null,
      },
      null,
      2
    )
  },
})

export const session_update = tool({
  description: "Update a workflow stage session deterministically",
  args: {
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    session_field: tool.schema.enum(sessionFields),
    state: tool.schema.enum(sessionStates).optional(),
    started_at: tool.schema.string().nullable().optional(),
    last_activity_at: tool.schema.string().nullable().optional(),
    expires_at: tool.schema.string().nullable().optional(),
    resume_command: tool.schema.string().nullable().optional(),
    session_url: tool.schema.string().nullable().optional(),
    metadata: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = await readJsonFile<Record<string, unknown>>(handoffPath)
    if (!handoffData) {
      return JSON.stringify({ ok: false, error: `missing handoff: ${handoffPath}` }, null, 2)
    }
    const existing = normalizeSessionSnapshot(args.session_field, currentSession(handoffData, args.session_field))
    if (!existing) {
      return JSON.stringify(
        { ok: false, error: `missing session field on handoff: ${args.session_field}` },
        null,
        2
      )
    }

    const session = {
      ...existing,
      state: args.state || existing.state,
      started_at: args.started_at !== undefined ? args.started_at : existing.started_at,
      last_activity_at: args.last_activity_at !== undefined ? args.last_activity_at : nowIso(),
      expires_at: args.expires_at !== undefined ? args.expires_at : existing.expires_at,
      resume_command: args.resume_command !== undefined ? args.resume_command : existing.resume_command,
      session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
      metadata: {
        ...existing.metadata,
        ...(args.metadata || {}),
      },
    }

    const next = {
      schema_version: "1",
      ...handoffData,
      [args.session_field]: session,
      generated_at: args.generated_at || (handoffData.generated_at as string) || nowIso(),
    }
    await writeJsonFile(handoffPath, next)
    return JSON.stringify({ ok: true, handoff_path: handoffPath, session_field: args.session_field, session }, null, 2)
  },
})

export const session_status = tool({
  description: "Read workflow stage session status deterministically",
  args: {
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    session_field: tool.schema.enum(sessionFields),
    review_path: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = await readJsonFile<Record<string, unknown>>(handoffPath)
    const reviewData = args.review_path
      ? await readJsonFile<Record<string, unknown>>(resolvePath(root, args.review_path))
      : null
    const session = normalizeSessionSnapshot(args.session_field, currentSession(handoffData, args.session_field))

    return JSON.stringify(
      {
        ok: !!handoffData,
        handoff_path: handoffPath,
        session_field: args.session_field,
        session,
        session_pending: session ? isPendingSessionState(session.state) : null,
        session_terminal: session ? isTerminalSessionState(session.state) : null,
        handoff_status: handoffData?.handoff_status || null,
        approval_status: handoffData?.approval_status || null,
        review_status: reviewData?.status || null,
        result_ready:
          args.session_field === "review_session"
            ? !!reviewData
            : session
              ? isTerminalSessionState(session.state)
              : false,
      },
      null,
      2
    )
  },
})

export const session_result = tool({
  description: "Read a terminal workflow stage session result deterministically",
  args: {
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    session_field: tool.schema.enum(sessionFields),
    review_path: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = await readJsonFile<Record<string, unknown>>(handoffPath)
    const session = normalizeSessionSnapshot(args.session_field, currentSession(handoffData, args.session_field))
    const reviewData = args.review_path
      ? await readJsonFile<Record<string, unknown>>(resolvePath(root, args.review_path))
      : null

    let resultReady = false
    let outcome: string | null = null
    if (args.session_field === "review_session") {
      resultReady = !!reviewData
      outcome = (reviewData?.status as string | undefined) || null
    } else if (session && isTerminalSessionState(session.state)) {
      resultReady = true
      outcome = session.state
    }

    return JSON.stringify(
      {
        ok: !!handoffData,
        handoff_path: handoffPath,
        session_field: args.session_field,
        result_ready: resultReady,
        outcome,
        handoff_status: handoffData?.handoff_status || null,
        approval_status: handoffData?.approval_status || null,
        approved_artifact: handoffData?.approved_artifact || null,
        review_path: handoffData?.review_path || null,
        session,
        review: reviewData,
      },
      null,
      2
    )
  },
})

export const review_bridge_runtime = tool({
  description: "Run structured review-bridge session orchestration against workflow artifacts",
  args: {
    operation: tool.schema.enum(["start", "resume", "status", "result"] as const),
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    review_path: tool.schema.string().optional(),
    review_target: tool.schema.string().optional(),
    review_type: tool.schema.enum(reviewTypes).optional(),
    provider: tool.schema.enum(sessionProviders).optional(),
    decision: tool.schema.enum(reviewStatuses).optional(),
    approved_artifact: tool.schema.string().nullable().optional(),
    blocking_issues: tool.schema.array(tool.schema.string()).optional(),
    decision_by: tool.schema.string().nullable().optional(),
    notes: tool.schema.array(tool.schema.string()).optional(),
    session_url: tool.schema.string().nullable().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = await readJsonFile<Record<string, unknown>>(handoffPath)
    if (!handoffData) {
      return JSON.stringify({ ok: false, error: `missing handoff: ${handoffPath}` }, null, 2)
    }

    const reviewPath = args.review_path
      ? resolvePath(root, args.review_path)
      : defaultReviewPathFromHandoff(root, handoffData)
    const now = args.generated_at || nowIso()
    const existing = normalizeSessionSnapshot("review_session", currentSession(handoffData, "review_session"), args.provider || "opencode")
    const reviewContextPath = await writeStageContext(root, handoffData, "review_session", {
      review_target: args.review_target || handoffData.consensus_plan_path || handoffData.runtime_spec_path || null,
      review_type: args.review_type || "plan",
      approved_artifact: handoffData.approved_artifact || null,
      startup_state_path: handoffData.startup_state_path || null,
    })

    if (args.operation === "status") {
      const reviewData = await readJsonFile<Record<string, unknown>>(reviewPath)
      const reviewTarget =
        (reviewData?.review_target as string | undefined) ||
        (existing?.metadata.review_target as string | undefined) ||
        args.review_target ||
        null
      return JSON.stringify(
        {
          ok: true,
          operation: args.operation,
          handoff_path: handoffPath,
          review_path: reviewData ? reviewPath : null,
          review_target: reviewTarget,
          review_type: (reviewData?.review_type as string | undefined) || args.review_type || null,
          session: existing,
          handoff_status: handoffData.handoff_status || null,
          approval_status: handoffData.approval_status || null,
          review_status: reviewData?.status || null,
          result_ready: !!reviewData,
          next_expected_input: reviewData ? null : "reviewer subagent decision",
          resume_hint: existing?.resume_command || null,
        },
        null,
        2
      )
    }

    if (args.operation === "result") {
      if (!args.decision) {
        const reviewData = await readJsonFile<Record<string, unknown>>(reviewPath)
        return JSON.stringify(
          {
            ok: true,
            operation: args.operation,
            handoff_path: handoffPath,
            review_path: reviewData ? reviewPath : null,
            result_ready: !!reviewData,
            session: existing,
            review: reviewData,
          },
          null,
          2
        )
      }

      if (!existing) {
        return JSON.stringify({ ok: false, error: "missing review_session on handoff" }, null, 2)
      }

      const terminalState =
        args.decision === "aborted"
          ? "failed"
          : args.decision === "expired"
            ? "expired"
            : args.decision === "cancelled"
              ? "cancelled"
              : "completed"
      const terminalSession = {
        ...existing,
        state: terminalState,
        last_activity_at: now,
        session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
          metadata: {
            ...existing.metadata,
            review_target: (existing.metadata.review_target as string | undefined) || args.review_target || null,
            review_method: (existing.metadata.review_method as string | undefined) || "reviewer-subagent",
            reviewer_agent: (existing.metadata.reviewer_agent as string | undefined) || "oracle",
            reviewer_status: "completed",
            delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "review-orchestrator:runtime",
            context_path: (existing.metadata.context_path as string | undefined) || reviewContextPath,
            delegate_status: "completed",
            delegate_contract:
              (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "review",
                delegate_role: "review-orchestrator",
                delegate_identity: "review-orchestrator:runtime",
                delegate_mode: "orchestrator",
                context_mode: "artifact-backed",
                result_kind: "structured-review-decision",
                required_fields: ["decision", "blocking_issues", "notes"],
              }),
            delegate_target_contract:
              (existing.metadata.delegate_target_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "review",
                delegate_role: "reviewer",
                delegate_identity: "reviewer:oracle",
                subagent_type: "oracle",
                delegate_mode: "specialist",
                context_mode: "fresh-context",
                result_kind: "structured-review-decision",
                required_fields: ["decision", "blocking_issues", "notes"],
              }),
          },
        }

      const approvedArtifact = args.decision === "approved" || args.decision === "waived"
        ? (args.approved_artifact || handoffData.approved_artifact || handoffData.consensus_plan_path || handoffData.runtime_spec_path || null)
        : null

      const reviewData = withArtifactRole({
        schema_version: "1",
        workflow_id: handoffData.workflow_id,
        slug: handoffData.slug,
        change_id: handoffData.change_id ?? null,
        review_target:
          args.review_target ||
          (terminalSession.metadata.review_target as string | undefined) ||
          handoffData.consensus_plan_path ||
          handoffData.runtime_spec_path ||
          "",
        review_type: args.review_type || "plan",
        status: args.decision,
        blocking_issues: args.blocking_issues || [],
        approved_artifact: approvedArtifact,
        handoff_path: handoffPath,
        review_session: terminalSession,
        decision_at: now,
        decision_by: args.decision_by || context.agent,
        session_events: [
          {
            at: now,
            type: "completed",
            actor: args.decision_by || context.agent,
            note: `review decision ${args.decision}`,
          },
        ],
        notes: args.notes || [],
        generated_at: now,
      }, "review", path.isAbsolute(reviewPath) ? path.relative(root, reviewPath) : reviewPath)
      await writeJsonFile(reviewPath, reviewData)

      const nextHandoff = attachPhaseGraph({
        schema_version: "1",
        ...handoffData,
        stage: "review-bridge",
        handoff_status: args.decision === "approved" || args.decision === "waived" ? "ready-for-execution" : "blocked",
        last_transition: `review-bridge result ${args.decision}`,
        review_path: path.isAbsolute(reviewPath) ? path.relative(root, reviewPath) : reviewPath,
        approved_artifact: approvedArtifact,
        approval_status: args.decision === "approved" ? "approved" : args.decision === "waived" ? "waived" : "changes-requested",
        review_session: terminalSession,
        preferred_next_stage: args.decision === "approved" || args.decision === "waived" ? "autopilot" : "review-bridge",
        preferred_next_command:
          args.decision === "approved" || args.decision === "waived"
            ? `/autopilot ${path.isAbsolute(reviewPath) ? path.relative(root, reviewPath) : reviewPath}`
            : `/review-bridge ${path.isAbsolute(handoffPath) ? path.relative(root, handoffPath) : handoffPath}`,
        generated_at: now,
      })
      await writeJsonFile(handoffPath, nextHandoff)
      const shouldContinue = args.decision === "approved" || args.decision === "waived"
      const continued = shouldContinue
        ? JSON.parse(
            await workflow_continue_runtime.execute(
              {
                handoff_path: path.isAbsolute(handoffPath) ? path.relative(root, handoffPath) : handoffPath,
                review_path: path.isAbsolute(reviewPath) ? path.relative(root, reviewPath) : reviewPath,
              },
              context
            )
          )
        : null
      return JSON.stringify({ ok: true, operation: args.operation, handoff: nextHandoff, review: reviewData, continued }, null, 2)
    }

    const shouldReuse = !!existing && !isTerminalSessionState(existing.state)
    if (args.operation === "resume" && !shouldReuse) {
      return JSON.stringify({ ok: false, error: "no pending review_session to resume" }, null, 2)
    }

    const session = shouldReuse
      ? {
          ...existing,
          mode: "sync",
          state: existing.state === "awaiting-input" ? "awaiting-input" : "awaiting-reviewer",
          last_activity_at: now,
          session_url: args.session_url !== undefined ? args.session_url : existing?.session_url,
          metadata: {
            ...existing.metadata,
            review_target: args.review_target || (existing.metadata.review_target as string | undefined) || null,
            review_method: (existing.metadata.review_method as string | undefined) || "reviewer-subagent",
            reviewer_agent: (existing.metadata.reviewer_agent as string | undefined) || "oracle",
            reviewer_status: "pending",
            delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "review-orchestrator:runtime",
            context_path: (existing.metadata.context_path as string | undefined) || reviewContextPath,
            delegate_status: "pending",
            delegate_contract:
              (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "review",
                delegate_role: "review-orchestrator",
                delegate_identity: "review-orchestrator:runtime",
                delegate_mode: "orchestrator",
                context_mode: "artifact-backed",
                result_kind: "structured-review-decision",
                required_fields: ["decision", "blocking_issues", "notes"],
              }),
            delegate_target_contract:
              (existing.metadata.delegate_target_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "review",
                delegate_role: "reviewer",
                delegate_identity: "reviewer:oracle",
                subagent_type: "oracle",
                delegate_mode: "specialist",
                context_mode: "fresh-context",
                result_kind: "structured-review-decision",
                required_fields: ["decision", "blocking_issues", "notes"],
              }),
          },
        }
      : {
          kind: "review",
          mode: "sync",
          session_id: randomUUID(),
          provider: args.provider || "opencode",
          state: "awaiting-reviewer",
          requested_at: now,
          started_at: now,
          last_activity_at: now,
          expires_at: null,
          resume_command: `/review-bridge ${path.isAbsolute(handoffPath) ? path.relative(root, handoffPath) : handoffPath}`,
          session_url: args.session_url ?? null,
          metadata: {
            review_target: args.review_target || handoffData.consensus_plan_path || handoffData.runtime_spec_path || null,
            review_method: "reviewer-subagent",
            reviewer_agent: "oracle",
            reviewer_status: "pending",
            delegate_identity: "review-orchestrator:runtime",
            context_path: reviewContextPath,
            delegate_status: "pending",
            delegate_contract: buildDelegateContract({
              stage: "review",
              delegate_role: "review-orchestrator",
              delegate_identity: "review-orchestrator:runtime",
              delegate_mode: "orchestrator",
              context_mode: "artifact-backed",
              result_kind: "structured-review-decision",
              required_fields: ["decision", "blocking_issues", "notes"],
            }),
            delegate_target_contract: buildDelegateContract({
              stage: "review",
              delegate_role: "reviewer",
              delegate_identity: "reviewer:oracle",
              subagent_type: "oracle",
              delegate_mode: "specialist",
              context_mode: "fresh-context",
              result_kind: "structured-review-decision",
              required_fields: ["decision", "blocking_issues", "notes"],
            }),
          },
      }

    const nextHandoff = attachPhaseGraph({
      schema_version: "1",
      ...handoffData,
      stage: "review-bridge",
      handoff_status: "review-required",
      last_transition: shouldReuse ? "review-bridge session resumed" : "review-bridge session started",
      review_path: shouldReuse ? handoffData.review_path || null : null,
      approved_artifact: shouldReuse ? handoffData.approved_artifact || null : null,
      approval_status: shouldReuse ? handoffData.approval_status || "not-reviewed" : "not-reviewed",
      review_session: session,
      preferred_next_stage: "review-bridge",
      preferred_next_command: `/review-bridge ${path.isAbsolute(handoffPath) ? path.relative(root, handoffPath) : handoffPath}`,
      generated_at: now,
    })

    if (!shouldReuse) {
      nextHandoff.review_path = null
      nextHandoff.approved_artifact = null
      nextHandoff.approval_status = "not-reviewed"
    }

    await writeJsonFile(handoffPath, nextHandoff)

    return JSON.stringify(
      {
        ok: true,
        operation: args.operation,
        resumed: shouldReuse,
        handoff_path: handoffPath,
        review_path: nextHandoff.review_path,
        review_target: session.metadata.review_target,
        review_type: args.review_type || "plan",
        session,
        handoff_status: nextHandoff.handoff_status,
        approval_status: nextHandoff.approval_status,
        result_ready: false,
        next_expected_input: "reviewer subagent decision",
        resume_hint: session.resume_command,
      },
      null,
      2
    )
  },
})

export const ralplan_runtime = tool({
  description: "Run structured ralplan session orchestration against workflow artifacts",
  args: {
    operation: tool.schema.enum(["start", "resume", "status", "result"] as const),
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    consensus_plan_path: tool.schema.string().nullable().optional(),
    change_id: tool.schema.string().nullable().optional(),
    final_plan_content: tool.schema.string().optional(),
    terminal_state: tool.schema.enum(["completed", "failed", "expired", "cancelled"] as const).optional(),
    phase: tool.schema.string().optional(),
    summary: tool.schema.string().optional(),
    session_url: tool.schema.string().nullable().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = await readJsonFile<Record<string, unknown>>(handoffPath)
    if (!handoffData) {
      return JSON.stringify({ ok: false, error: `missing handoff: ${handoffPath}` }, null, 2)
    }

    const now = args.generated_at || nowIso()
    const canonicalPlanPath = resolvePath(
      root,
      args.consensus_plan_path ||
        (handoffData.consensus_plan_path as string | undefined) ||
        `${workflowStoreBase(handoffData)}/plans/consensus-${(handoffData.slug as string) || "workflow"}.md`
    )
    const canonicalTaskGraphPath = resolvePath(
      root,
      (handoffData.task_graph_path as string | undefined) || defaultTaskGraphPathFromHandoff(root, handoffData)
    )
    const existing = normalizeSessionSnapshot("planning_session", currentSession(handoffData, "planning_session"))
    const planningContextPath = await writeStageContext(root, handoffData, "planning_session", {
      runtime_spec_path: handoffData.runtime_spec_path || null,
      startup_state_path: handoffData.startup_state_path || null,
      change_id: args.change_id !== undefined ? args.change_id : handoffData.change_id ?? null,
      target_plan_path: path.relative(root, canonicalPlanPath),
      target_graph_path: path.relative(root, canonicalTaskGraphPath),
    })

    if (args.operation === "status") {
      return JSON.stringify(
        {
          ok: true,
          operation: args.operation,
          handoff_path: handoffPath,
          consensus_plan_path: path.relative(root, canonicalPlanPath),
          task_graph_path: (await textFileExists(canonicalTaskGraphPath)) ? path.relative(root, canonicalTaskGraphPath) : null,
          session: existing,
          handoff_status: handoffData.handoff_status || null,
          approval_status: handoffData.approval_status || null,
          result_ready: !!existing && isTerminalSessionState(existing.state),
        },
        null,
        2
      )
    }

    if (args.operation === "result") {
      if (!args.terminal_state) {
        return JSON.stringify(
          {
            ok: true,
            operation: args.operation,
            handoff_path: handoffPath,
            consensus_plan_path: path.relative(root, canonicalPlanPath),
            task_graph_path: (await textFileExists(canonicalTaskGraphPath)) ? path.relative(root, canonicalTaskGraphPath) : null,
            result_ready: !!existing && isTerminalSessionState(existing.state),
            session: existing,
          },
          null,
          2
        )
      }

      if (!existing) {
        return JSON.stringify({ ok: false, error: "missing planning_session on handoff" }, null, 2)
      }

      let finalPlanPath: string | null = null
      let finalTaskGraphPath: string | null = null
      let taskGraph: ReturnType<typeof buildTaskGraph> | null = null

      if (args.terminal_state === "completed") {
        let finalPlanContent = args.final_plan_content || null
        if (finalPlanContent) {
          await writeTextFile(canonicalPlanPath, finalPlanContent)
        } else if (!(await textFileExists(canonicalPlanPath))) {
          finalPlanContent = "# Consensus Plan\n"
          await writeTextFile(canonicalPlanPath, finalPlanContent)
        } else {
          finalPlanContent = await readFile(canonicalPlanPath, "utf8")
        }

        taskGraph = buildTaskGraph(finalPlanContent || "# Consensus Plan\n", handoffData, path.relative(root, canonicalPlanPath), now)
        await writeJsonFile(canonicalTaskGraphPath, taskGraph)
        finalPlanPath = path.relative(root, canonicalPlanPath)
        finalTaskGraphPath = path.relative(root, canonicalTaskGraphPath)
      }

      const terminalSession = {
        ...existing,
        state: args.terminal_state,
        last_activity_at: now,
        session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
          metadata: {
            ...existing.metadata,
            phase: args.phase || (args.terminal_state === "completed" ? "done" : "blocked"),
            consensus_plan_path: finalPlanPath,
            task_graph_path: finalTaskGraphPath,
            task_graph_node_count: taskGraph?.node_count || 0,
            summary: args.summary || null,
            context_path: (existing.metadata.context_path as string | undefined) || planningContextPath,
            delegate_status: "completed",
            delegate_task_id: (existing.metadata.delegate_task_id as string | undefined) || null,
            delegate_launch_handle: (existing.metadata.delegate_launch_handle as string | undefined) || null,
            delegate_started_at: (existing.metadata.delegate_started_at as string | undefined) || null,
            delegate_last_output_at: (existing.metadata.delegate_last_output_at as string | undefined) || now,
            delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "planning-orchestrator:runtime",
            delegate_contract:
              (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "planning",
                delegate_role: "planning-orchestrator",
                delegate_identity: "planning-orchestrator:runtime",
                delegate_mode: "orchestrator",
                context_mode: "artifact-backed",
                result_kind: "consensus-plan",
                required_fields: ["consensus_plan_path", "task_graph_path", "summary"],
              }),
            delegate_target_contract:
              (existing.metadata.delegate_target_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "planning",
                delegate_role: "planner",
                delegate_identity: "planner:background",
                delegate_mode: "specialist",
                context_mode: "fresh-context",
                result_kind: "consensus-plan",
                required_fields: ["consensus_plan_path", "task_graph_path", "summary"],
              }),
          },
        }

      const nextHandoff = attachPhaseGraph({
        schema_version: "1",
        ...handoffData,
        stage: "ralplan",
        change_id: args.change_id !== undefined ? args.change_id : handoffData.change_id ?? null,
        consensus_plan_path: finalPlanPath,
        task_graph_path: finalTaskGraphPath,
        plan_path: handoffData.plan_path || path.relative(root, canonicalPlanPath),
        handoff_status: args.terminal_state === "completed" ? "review-required" : "planned",
        last_transition: `ralplan result ${args.terminal_state}`,
        planning_session: terminalSession,
        preferred_next_stage: args.terminal_state === "completed" ? "review-bridge" : "ralplan",
        preferred_next_command:
          args.terminal_state === "completed"
            ? `/review-bridge ${path.relative(root, handoffPath)}`
            : `/ralplan ${path.relative(root, handoffPath)}`,
        generated_at: now,
      })
      await writeJsonFile(handoffPath, nextHandoff)
      const continued = args.terminal_state === "completed"
        ? JSON.parse(
            await workflow_continue_runtime.execute(
              {
                handoff_path: path.isAbsolute(handoffPath) ? path.relative(root, handoffPath) : handoffPath,
              },
              context
            )
          )
        : null
      return JSON.stringify({ ok: true, operation: args.operation, handoff: nextHandoff, continued }, null, 2)
    }

    const shouldReuse = !!existing && !isTerminalSessionState(existing.state)
    if (args.operation === "resume" && !shouldReuse) {
      return JSON.stringify({ ok: false, error: "no pending planning_session to resume" }, null, 2)
    }

    const session = shouldReuse
      ? {
          ...existing,
          mode: "sync",
          state: "in-progress",
          last_activity_at: now,
          session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
          metadata: {
            ...existing.metadata,
            phase: args.phase || existing.metadata.phase || "planner",
            consensus_plan_path: path.relative(root, canonicalPlanPath),
            task_graph_path: path.relative(root, canonicalTaskGraphPath),
            context_path: (existing.metadata.context_path as string | undefined) || planningContextPath,
            delegate_status: "pending",
            delegate_task_id: (existing.metadata.delegate_task_id as string | undefined) || null,
            delegate_launch_handle: (existing.metadata.delegate_launch_handle as string | undefined) || null,
            delegate_started_at: (existing.metadata.delegate_started_at as string | undefined) || null,
            delegate_last_output_at: (existing.metadata.delegate_last_output_at as string | undefined) || null,
            delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "planning-orchestrator:runtime",
            delegate_contract:
              (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "planning",
                delegate_role: "planning-orchestrator",
                delegate_identity: "planning-orchestrator:runtime",
                delegate_mode: "orchestrator",
                context_mode: "artifact-backed",
                result_kind: "consensus-plan",
                required_fields: ["consensus_plan_path", "task_graph_path", "summary"],
              }),
            delegate_target_contract:
              (existing.metadata.delegate_target_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "planning",
                delegate_role: "planner",
                delegate_identity: "planner:background",
                delegate_mode: "specialist",
                context_mode: "fresh-context",
                result_kind: "consensus-plan",
                required_fields: ["consensus_plan_path", "task_graph_path", "summary"],
              }),
          },
        }
      : {
          kind: "planning",
          mode: "sync",
          session_id: randomUUID(),
          provider: "opencode",
          state: "queued",
          requested_at: now,
          started_at: now,
          last_activity_at: now,
          expires_at: null,
          resume_command: `/ralplan ${path.relative(root, handoffPath)}`,
          session_url: args.session_url ?? null,
          metadata: {
            phase: args.phase || "drafting",
            consensus_plan_path: path.relative(root, canonicalPlanPath),
            task_graph_path: path.relative(root, canonicalTaskGraphPath),
            context_path: planningContextPath,
            delegate_status: "pending",
            delegate_task_id: null,
            delegate_launch_handle: null,
            delegate_started_at: null,
            delegate_last_output_at: null,
            delegate_identity: "planning-orchestrator:runtime",
            delegate_contract: buildDelegateContract({
              stage: "planning",
              delegate_role: "planning-orchestrator",
              delegate_identity: "planning-orchestrator:runtime",
              delegate_mode: "orchestrator",
              context_mode: "artifact-backed",
              result_kind: "consensus-plan",
              required_fields: ["consensus_plan_path", "task_graph_path", "summary"],
            }),
            delegate_target_contract: buildDelegateContract({
              stage: "planning",
              delegate_role: "planner",
              delegate_identity: "planner:background",
              delegate_mode: "specialist",
              context_mode: "fresh-context",
              result_kind: "consensus-plan",
              required_fields: ["consensus_plan_path", "task_graph_path", "summary"],
            }),
          },
        }

    if (!shouldReuse) {
      await removeFileIfExists(canonicalPlanPath)
      await removeFileIfExists(canonicalTaskGraphPath)
    }

    if (!(await textFileExists(canonicalPlanPath))) {
      await writeTextFile(canonicalPlanPath, draftConsensusPlanTemplate(handoffData, now))
    }

    const nextHandoff = attachPhaseGraph({
      schema_version: "1",
      ...handoffData,
      stage: "ralplan",
      change_id: args.change_id !== undefined ? args.change_id : handoffData.change_id ?? null,
      consensus_plan_path: null,
      task_graph_path: null,
      plan_path: handoffData.plan_path || path.relative(root, canonicalPlanPath),
      handoff_status: "planned",
      last_transition: shouldReuse ? "ralplan session resumed" : "ralplan session started",
      planning_session: session,
      preferred_next_stage: "ralplan",
      preferred_next_command: `/ralplan ${path.relative(root, handoffPath)}`,
      generated_at: now,
    })
    await writeJsonFile(handoffPath, nextHandoff)
    return JSON.stringify(
      {
        ok: true,
        operation: args.operation,
        resumed: shouldReuse,
        handoff_path: handoffPath,
        consensus_plan_path: path.relative(root, canonicalPlanPath),
        task_graph_path: path.relative(root, canonicalTaskGraphPath),
        session,
        handoff_status: nextHandoff.handoff_status,
        result_ready: false,
      },
      null,
      2
    )
  },
})

export const autopilot_runtime = tool({
  description: "Run structured autopilot execution session orchestration against workflow artifacts",
  args: {
    operation: tool.schema.enum(["start", "resume", "status", "result"] as const),
    handoff_path: tool.schema.string().optional().describe("Relative or absolute path to handoff.json"),
    artifact_path: tool.schema.string().optional().describe("Handoff or approved review artifact path"),
    phase: tool.schema.string().optional(),
    terminal_state: tool.schema.enum(["completed", "failed", "expired", "cancelled"] as const).optional(),
    execution_target: tool.schema.string().optional(),
    verification_summary: tool.schema.string().optional(),
    verification_commands: tool.schema.array(tool.schema.string()).optional(),
    verification_artifacts: tool.schema.array(tool.schema.string()).optional(),
    result_summary: tool.schema.string().optional(),
    blocking_reason: tool.schema.string().optional(),
    session_url: tool.schema.string().nullable().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const resolved = args.handoff_path
      ? { handoffPath: resolvePath(root, args.handoff_path), handoffData: await readJsonFile<Record<string, unknown>>(resolvePath(root, args.handoff_path)) }
      : args.artifact_path
        ? await resolveHandoffFromArtifact(root, args.artifact_path)
        : { handoffPath: "", handoffData: null }
    const handoffPath = resolved.handoffPath
    const handoffData = resolved.handoffData
    if (!handoffData) {
      return JSON.stringify({ ok: false, error: `missing handoff: ${handoffPath || args.artifact_path || "unknown"}` }, null, 2)
    }

    const now = args.generated_at || nowIso()
    const existing = normalizeSessionSnapshot("execution_session", currentSession(handoffData, "execution_session"))
    const target =
      args.execution_target ||
      (handoffData.approved_artifact as string | undefined) ||
      (handoffData.consensus_plan_path as string | undefined) ||
      (handoffData.runtime_spec_path as string | undefined) ||
      null
    const taskGraphPath = (handoffData.task_graph_path as string | undefined) || null
    const dispatchPlanPath =
      (handoffData.dispatch_plan_path as string | undefined) ||
      (existing?.metadata.dispatch_plan_path as string | undefined) ||
      relativeIfAbsolute(root, defaultDispatchPlanPathFromHandoff(root, handoffData))
    const taskGraphData = await readTaskGraphFile(root, taskGraphPath)
    const storedDispatchArtifact = await readDispatchArtifactFile(root, dispatchPlanPath)
    const completedNodeIds = Array.isArray(existing?.metadata.completed_node_ids)
      ? (existing?.metadata.completed_node_ids as string[])
      : Array.isArray(storedDispatchArtifact?.completed_node_ids)
        ? (storedDispatchArtifact?.completed_node_ids as string[])
        : []
    const graphState = deriveTaskGraphExecutionState(taskGraphData, completedNodeIds)
    const computedDispatchPlan = buildDispatchPlanFromGraphState(graphState)
    const computedDispatchRequests = buildDispatchRequests(
      (handoffData.slug as string) || "workflow",
      taskGraphData,
      target,
      computedDispatchPlan,
      workflowStoreBase(handoffData)
    )
    const computedReconcilePlan = buildReconcilePlan(computedDispatchPlan, computedDispatchRequests)
    const dispatchPlan =
      (storedDispatchArtifact
        ? {
            ready_batch_count: storedDispatchArtifact.ready_batch_count,
            ready_batches: storedDispatchArtifact.ready_batches,
            reconcile_required: storedDispatchArtifact.reconcile_required,
            reconcile_scope: storedDispatchArtifact.reconcile_scope,
            next_dispatch_mode: storedDispatchArtifact.next_dispatch_mode,
          }
        : (existing?.metadata.dispatch_plan as Record<string, unknown> | undefined)) || computedDispatchPlan
    const dispatchRequests =
      (Array.isArray(storedDispatchArtifact?.dispatch_requests)
        ? (storedDispatchArtifact?.dispatch_requests as Array<Record<string, unknown>>)
        : (existing?.metadata.dispatch_requests as Array<Record<string, unknown>> | undefined)) || computedDispatchRequests
    const reconcilePlan =
      (storedDispatchArtifact?.reconcile_plan as Record<string, unknown> | undefined) ||
      (existing?.metadata.reconcile_plan as Record<string, unknown> | undefined) ||
      computedReconcilePlan
    const dispatchSummary = summarizeDispatchRequests(dispatchRequests)
    const executionPhase = (existing?.metadata.phase as string | undefined) || args.phase || null
    const executionContextPath = await writeStageContext(root, handoffData, "execution_session", {
      execution_target: target,
      task_graph_path: taskGraphPath,
      dispatch_plan_path: dispatchPlanPath,
      approved_artifact: handoffData.approved_artifact || null,
      ready_batch_count: (dispatchPlan as Record<string, unknown>).ready_batch_count || 0,
    })
    const dispatchArtifact = materializeDispatchArtifact(
      handoffData,
      dispatchPlanPath || `.opencode/executions/dispatch-${(handoffData.slug as string) || "workflow"}.json`,
      taskGraphPath,
      target,
      executionPhase,
      dispatchPlan as ReturnType<typeof buildDispatchPlanFromGraphState>,
      dispatchRequests as ReturnType<typeof buildDispatchRequests>,
      reconcilePlan as ReturnType<typeof buildReconcilePlan>,
      completedNodeIds,
      now
    )
    await writeDispatchContexts(root, handoffData, dispatchRequests as ReturnType<typeof buildDispatchRequests>, {
      execution_target: target,
      task_graph_path: taskGraphPath,
      approved_artifact: (handoffData.approved_artifact as string | undefined) || null,
    })
    const nextExpectedInputFor = (session: ReturnType<typeof normalizeSessionSnapshot> | null) => {
      if (!session) return null
      if (session.state === "queued") return graphState.ready_node_ids.length > 0 ? "dispatch ready DAG nodes" : "execution kickoff"
      if (session.state === "awaiting-input") return "execution input"
      if (session.state === "in-progress") return graphState.ready_node_ids.length > 0 ? "execute or reconcile ready DAG nodes" : "execution progress or terminal result"
      return null
    }

    if (args.operation === "status") {
      return JSON.stringify(
        {
          ok: true,
          operation: args.operation,
          handoff_path: handoffPath,
          execution_target: target,
          change_id: handoffData.change_id || null,
          phase: executionPhase,
          task_graph_path: taskGraphPath,
          task_graph_state: taskGraphData ? graphState : null,
          dispatch_plan_path: dispatchPlanPath,
          dispatch_plan: taskGraphData ? dispatchPlan : null,
          dispatch_requests: taskGraphData ? dispatchRequests : null,
          reconcile_plan: taskGraphData ? reconcilePlan : null,
          dispatch_summary: taskGraphData ? dispatchSummary : null,
          session_id: existing?.session_id || null,
          session_status: existing?.state || null,
          session: existing,
          handoff_status: handoffData.handoff_status || null,
          approval_status: handoffData.approval_status || null,
          result_ready: !!existing && isTerminalSessionState(existing.state),
          next_expected_input: nextExpectedInputFor(existing),
          resume_hint: existing?.resume_command || null,
        },
        null,
        2
      )
    }

    if (args.operation === "result") {
      if (!args.terminal_state) {
        return JSON.stringify(
          {
            ok: true,
            operation: args.operation,
            handoff_path: handoffPath,
            execution_target: target,
            change_id: handoffData.change_id || null,
            phase: executionPhase,
            task_graph_path: taskGraphPath,
            task_graph_state: taskGraphData ? graphState : null,
            dispatch_plan_path: dispatchPlanPath,
            dispatch_plan: taskGraphData ? dispatchPlan : null,
            dispatch_requests: taskGraphData ? dispatchRequests : null,
            reconcile_plan: taskGraphData ? reconcilePlan : null,
            dispatch_summary: taskGraphData ? dispatchSummary : null,
            result_ready: !!existing && isTerminalSessionState(existing.state),
            session_id: existing?.session_id || null,
            session_status: existing?.state || null,
            session: existing,
            next_expected_input: nextExpectedInputFor(existing),
            resume_hint: existing?.resume_command || null,
          },
          null,
          2
        )
      }

      if (!existing) {
        return JSON.stringify({ ok: false, error: "missing execution_session on handoff" }, null, 2)
      }

      const terminalSession = {
        ...existing,
        state: args.terminal_state,
        last_activity_at: now,
        session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
        metadata: {
          ...existing.metadata,
          phase: args.phase || (args.terminal_state === "completed" ? "done" : "blocked"),
          execution_target: target,
          verification_summary: args.verification_summary || null,
          verification_commands: args.verification_commands || [],
          verification_artifacts: args.verification_artifacts || [],
          result_summary: args.result_summary || null,
          blocking_reason: args.blocking_reason || null,
          task_graph_path: taskGraphPath,
          task_graph_state: taskGraphData ? graphState : null,
          dispatch_plan_path: dispatchPlanPath,
          dispatch_plan: taskGraphData ? dispatchPlan : null,
          dispatch_requests: taskGraphData ? dispatchRequests : null,
          reconcile_plan: taskGraphData ? reconcilePlan : null,
          dispatch_summary: taskGraphData ? dispatchSummary : null,
          context_path: (existing.metadata.context_path as string | undefined) || executionContextPath,
          delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "execution-orchestrator:runtime",
          delegate_contract:
            (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
            buildDelegateContract({
              stage: "execution",
              delegate_role: "execution-orchestrator",
              delegate_identity: "execution-orchestrator:runtime",
              delegate_mode: "orchestrator",
              context_mode: "artifact-backed",
              result_kind: "execution-state",
              required_fields: ["dispatch_requests", "dispatch_summary", "reconcile_plan"],
            }),
        },
      }

      if (dispatchPlanPath) {
        await writeJsonFile(resolvePath(root, dispatchPlanPath), dispatchArtifact)
      }

      const nextHandoff = attachPhaseGraph({
        schema_version: "1",
        ...handoffData,
        stage: "autopilot",
        dispatch_plan_path: dispatchPlanPath,
        handoff_status: args.terminal_state === "completed" ? "ready-for-verification" : "blocked",
        last_transition: `autopilot result ${args.terminal_state}`,
        execution_session: terminalSession,
        preferred_next_stage: args.terminal_state === "completed" ? "workflow-verify" : "autopilot",
        preferred_next_command:
          args.terminal_state === "completed"
            ? `/workflow-verify ${path.relative(root, handoffPath)}`
            : `/autopilot ${path.relative(root, handoffPath)}`,
        generated_at: now,
      })
      await writeJsonFile(handoffPath, nextHandoff)
      const continued = args.terminal_state === "completed"
        ? JSON.parse(
            await workflow_continue_runtime.execute(
              {
                handoff_path: path.relative(root, handoffPath),
              },
              context
            )
          )
        : null
      return JSON.stringify(
        {
          ok: true,
          operation: args.operation,
          handoff: nextHandoff,
          session_id: terminalSession.session_id,
          session_status: terminalSession.state,
          execution_target: target,
          change_id: handoffData.change_id || null,
          phase: terminalSession.metadata.phase || null,
          next_expected_input: null,
          resume_hint: terminalSession.resume_command,
          continued,
        },
        null,
        2
      )
    }

    const shouldReuse = !!existing && !isTerminalSessionState(existing.state)
    if (args.operation === "resume" && !shouldReuse) {
      return JSON.stringify({ ok: false, error: "no pending execution_session to resume" }, null, 2)
    }

    const session = shouldReuse
      ? {
          ...existing,
          mode: "sync",
          state: "in-progress",
          last_activity_at: now,
          session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
          metadata: {
            ...existing.metadata,
            phase: args.phase || existing.metadata.phase || "executing",
            execution_target: target,
            task_graph_path: taskGraphPath,
            task_graph_state: taskGraphData ? graphState : null,
            dispatch_plan_path: dispatchPlanPath,
            dispatch_plan: taskGraphData ? dispatchPlan : null,
            dispatch_requests: taskGraphData ? dispatchRequests : null,
            reconcile_plan: taskGraphData ? reconcilePlan : null,
            dispatch_summary: taskGraphData ? dispatchSummary : null,
            completed_node_ids: completedNodeIds,
            context_path: (existing.metadata.context_path as string | undefined) || executionContextPath,
            delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "execution-orchestrator:runtime",
            delegate_contract:
              (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "execution",
                delegate_role: "execution-orchestrator",
                delegate_identity: "execution-orchestrator:runtime",
                delegate_mode: "orchestrator",
                context_mode: "artifact-backed",
                result_kind: "execution-state",
                required_fields: ["dispatch_requests", "dispatch_summary", "reconcile_plan"],
              }),
          },
        }
      : {
          kind: "execution",
          mode: "sync",
          session_id: randomUUID(),
          provider: "opencode",
          state: "queued",
          requested_at: now,
          started_at: now,
          last_activity_at: now,
          expires_at: null,
          resume_command: `/autopilot ${path.relative(root, handoffPath)}`,
          session_url: args.session_url ?? null,
          metadata: {
            phase: args.phase || "executing",
            execution_target: target,
            task_graph_path: taskGraphPath,
            task_graph_state: taskGraphData ? graphState : null,
            dispatch_plan_path: dispatchPlanPath,
            dispatch_plan: taskGraphData ? dispatchPlan : null,
            dispatch_requests: taskGraphData ? dispatchRequests : null,
            reconcile_plan: taskGraphData ? reconcilePlan : null,
            dispatch_summary: taskGraphData ? dispatchSummary : null,
            completed_node_ids: completedNodeIds,
            context_path: executionContextPath,
            delegate_identity: "execution-orchestrator:runtime",
            delegate_contract: buildDelegateContract({
              stage: "execution",
              delegate_role: "execution-orchestrator",
              delegate_identity: "execution-orchestrator:runtime",
              delegate_mode: "orchestrator",
              context_mode: "artifact-backed",
              result_kind: "execution-state",
              required_fields: ["dispatch_requests", "dispatch_summary", "reconcile_plan"],
            }),
          },
        }

    if (dispatchPlanPath) {
      await writeJsonFile(resolvePath(root, dispatchPlanPath), dispatchArtifact)
    }

    const nextHandoff = attachPhaseGraph({
      schema_version: "1",
      ...handoffData,
      stage: "autopilot",
      dispatch_plan_path: dispatchPlanPath,
      handoff_status: "executing",
      last_transition: shouldReuse ? "autopilot session resumed" : "autopilot session started",
      execution_session: session,
      preferred_next_stage: "autopilot",
      preferred_next_command: `/autopilot ${path.relative(root, handoffPath)}`,
      generated_at: now,
    })
    await writeJsonFile(handoffPath, nextHandoff)
    return JSON.stringify(
      {
        ok: true,
        operation: args.operation,
        resumed: shouldReuse,
        handoff_path: handoffPath,
        execution_target: target,
        change_id: handoffData.change_id || null,
        phase: session.metadata.phase || null,
        task_graph_path: taskGraphPath,
        task_graph_state: taskGraphData ? graphState : null,
        dispatch_plan_path: dispatchPlanPath,
        dispatch_plan: taskGraphData ? dispatchPlan : null,
        dispatch_requests: taskGraphData ? dispatchRequests : null,
        reconcile_plan: taskGraphData ? reconcilePlan : null,
        dispatch_summary: taskGraphData ? dispatchSummary : null,
        session_id: session.session_id,
        session_status: session.state,
        session,
        handoff_status: nextHandoff.handoff_status,
        result_ready: false,
        next_expected_input: nextExpectedInputFor(session),
        resume_hint: session.resume_command,
      },
      null,
      2
    )
  },
})

export const verify_runtime = tool({
  description: "Run structured verification session orchestration against workflow artifacts",
  args: {
    operation: tool.schema.enum(["start", "resume", "status", "result"] as const),
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    verification_path: tool.schema.string().optional(),
    verification_target: tool.schema.string().optional(),
    decision: tool.schema.enum(verificationStatuses).optional(),
    blocking_issues: tool.schema.array(tool.schema.string()).optional(),
    notes: tool.schema.array(tool.schema.string()).optional(),
    verification_summary: tool.schema.string().optional(),
    verification_commands: tool.schema.array(tool.schema.string()).optional(),
    verification_artifacts: tool.schema.array(tool.schema.string()).optional(),
    session_url: tool.schema.string().nullable().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = await readJsonFile<Record<string, unknown>>(handoffPath)
    if (!handoffData) return JSON.stringify({ ok: false, error: `missing handoff: ${handoffPath}` }, null, 2)

    const verificationPath = args.verification_path
      ? resolvePath(root, args.verification_path)
      : defaultVerificationPathFromHandoff(root, handoffData)
    const now = args.generated_at || nowIso()
    const existing = normalizeSessionSnapshot("verification_session", currentSession(handoffData, "verification_session"), "opencode")
    const target =
      args.verification_target ||
      (handoffData.approved_artifact as string | undefined) ||
      (handoffData.consensus_plan_path as string | undefined) ||
      (handoffData.runtime_spec_path as string | undefined) ||
      null
    const verificationContextPath = await writeStageContext(root, handoffData, "verification_session", {
      verification_target: target,
      approved_artifact: handoffData.approved_artifact || null,
      review_path: handoffData.review_path || null,
      dispatch_plan_path: handoffData.dispatch_plan_path || null,
    })

    if (args.operation === "status") {
      const verificationData = await readJsonFile<Record<string, unknown>>(verificationPath)
      return JSON.stringify(
        {
          ok: true,
          operation: args.operation,
          handoff_path: handoffPath,
          verification_path: verificationData ? verificationPath : null,
          verification_target: target,
          session: existing,
          handoff_status: handoffData.handoff_status || null,
          result_ready: !!verificationData,
          next_expected_input: verificationData ? null : "verification decision",
          resume_hint: existing?.resume_command || null,
        },
        null,
        2
      )
    }

    if (args.operation === "result") {
      if (!args.decision) {
        const verificationData = await readJsonFile<Record<string, unknown>>(verificationPath)
        return JSON.stringify({ ok: true, operation: args.operation, handoff_path: handoffPath, verification: verificationData }, null, 2)
      }
      if (!existing) return JSON.stringify({ ok: false, error: "missing verification_session on handoff" }, null, 2)

      const terminalState = args.decision === "passed" ? "completed" : args.decision === "failed" ? "failed" : args.decision
      const terminalSession = {
        ...existing,
        state: terminalState,
        last_activity_at: now,
        session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
        metadata: {
          ...existing.metadata,
          verification_target: target,
          verification_status: args.decision,
          verification_summary: args.verification_summary || null,
          verification_commands: args.verification_commands || [],
          verification_artifacts: args.verification_artifacts || [],
          blocking_issues: args.blocking_issues || [],
          context_path: (existing.metadata.context_path as string | undefined) || verificationContextPath,
          delegate_status: "completed",
          delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "verification-orchestrator:runtime",
          delegate_contract:
            (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
            buildDelegateContract({
              stage: "verification",
              delegate_role: "verification-orchestrator",
              delegate_identity: "verification-orchestrator:runtime",
              delegate_mode: "orchestrator",
              context_mode: "artifact-backed",
              result_kind: "verification-report",
              required_fields: ["verification_summary", "verification_commands", "verification_artifacts"],
            }),
          delegate_target_contract:
            (existing.metadata.delegate_target_contract as Record<string, unknown> | undefined) ||
            buildDelegateContract({
              stage: "verification",
              delegate_role: "verifier",
              delegate_identity: "verifier:oracle",
              subagent_type: "oracle",
              delegate_mode: "specialist",
              context_mode: "fresh-context",
              result_kind: "verification-report",
              required_fields: ["verification_summary", "verification_commands", "verification_artifacts"],
            }),
        },
      }

      const verificationData = withArtifactRole({
        schema_version: "1",
        workflow_id: handoffData.workflow_id,
        slug: handoffData.slug,
        change_id: handoffData.change_id ?? null,
        verification_target: target,
        status: args.decision,
        blocking_issues: args.blocking_issues || [],
        handoff_path: handoffPath,
        verification_session: terminalSession,
        notes: args.notes || [],
        generated_at: now,
      }, "verification", path.relative(root, verificationPath))
      await writeJsonFile(verificationPath, verificationData)

      const nextHandoff = attachPhaseGraph({
        schema_version: "1",
        ...handoffData,
        stage: "workflow-verify",
        verification_path: path.relative(root, verificationPath),
        handoff_status: args.decision === "passed" ? "ready-for-archive" : "blocked",
        last_transition: `workflow-verify result ${args.decision}`,
        verification_session: terminalSession,
        preferred_next_stage: args.decision === "passed" ? "workflow-archive" : "workflow-verify",
        preferred_next_command:
          args.decision === "passed"
            ? `/workflow-archive ${path.relative(root, handoffPath)}`
            : `/workflow-verify ${path.relative(root, handoffPath)}`,
        generated_at: now,
      })
      await writeJsonFile(handoffPath, nextHandoff)
      const continued =
        args.decision === "passed"
          ? JSON.parse(
              await workflow_continue_runtime.execute(
                {
                  handoff_path: path.relative(root, handoffPath),
                },
                context
              )
            )
          : null
      return JSON.stringify({ ok: true, operation: args.operation, handoff: nextHandoff, verification: verificationData, continued }, null, 2)
    }

    const shouldReuse = !!existing && !isTerminalSessionState(existing.state)
    if (args.operation === "resume" && !shouldReuse) {
      return JSON.stringify({ ok: false, error: "no pending verification_session to resume" }, null, 2)
    }

    const session = shouldReuse
      ? {
          ...existing,
          mode: "sync",
          state: "in-progress",
          last_activity_at: now,
          session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
          metadata: {
            ...existing.metadata,
            verification_target: target,
            context_path: (existing.metadata.context_path as string | undefined) || verificationContextPath,
            delegate_status: "pending",
            delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "verification-orchestrator:runtime",
            delegate_contract:
              (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "verification",
                delegate_role: "verification-orchestrator",
                delegate_identity: "verification-orchestrator:runtime",
                delegate_mode: "orchestrator",
                context_mode: "artifact-backed",
                result_kind: "verification-report",
                required_fields: ["verification_summary", "verification_commands", "verification_artifacts"],
              }),
            delegate_target_contract:
              (existing.metadata.delegate_target_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "verification",
                delegate_role: "verifier",
                delegate_identity: "verifier:oracle",
                subagent_type: "oracle",
                delegate_mode: "specialist",
                context_mode: "fresh-context",
                result_kind: "verification-report",
                required_fields: ["verification_summary", "verification_commands", "verification_artifacts"],
              }),
          },
        }
      : {
          kind: "verification",
          mode: "sync",
          session_id: randomUUID(),
          provider: "opencode",
          state: "queued",
          requested_at: now,
          started_at: now,
          last_activity_at: now,
          expires_at: null,
          resume_command: `/workflow-verify ${path.relative(root, handoffPath)}`,
          session_url: args.session_url ?? null,
          metadata: {
            verification_target: target,
            context_path: verificationContextPath,
            delegate_status: "pending",
            delegate_identity: "verification-orchestrator:runtime",
            delegate_contract: buildDelegateContract({
              stage: "verification",
              delegate_role: "verification-orchestrator",
              delegate_identity: "verification-orchestrator:runtime",
              delegate_mode: "orchestrator",
              context_mode: "artifact-backed",
              result_kind: "verification-report",
              required_fields: ["verification_summary", "verification_commands", "verification_artifacts"],
            }),
            delegate_target_contract: buildDelegateContract({
              stage: "verification",
              delegate_role: "verifier",
              delegate_identity: "verifier:oracle",
              subagent_type: "oracle",
              delegate_mode: "specialist",
              context_mode: "fresh-context",
              result_kind: "verification-report",
              required_fields: ["verification_summary", "verification_commands", "verification_artifacts"],
            }),
          },
        }

    const nextHandoff = attachPhaseGraph({
      schema_version: "1",
      ...handoffData,
      stage: "workflow-verify",
      verification_path: handoffData.verification_path || null,
      handoff_status: "verifying",
      last_transition: shouldReuse ? "workflow-verify session resumed" : "workflow-verify session started",
      verification_session: session,
      preferred_next_stage: "workflow-verify",
      preferred_next_command: `/workflow-verify ${path.relative(root, handoffPath)}`,
      generated_at: now,
    })
    await writeJsonFile(handoffPath, nextHandoff)

    return JSON.stringify(
      {
        ok: true,
        operation: args.operation,
        resumed: shouldReuse,
        handoff_path: handoffPath,
        verification_path: nextHandoff.verification_path,
        verification_target: target,
        session,
        handoff_status: nextHandoff.handoff_status,
        result_ready: false,
        next_expected_input: "verification decision",
        resume_hint: session.resume_command,
      },
      null,
      2
    )
  },
})

export const archive_runtime = tool({
  description: "Run structured archive session orchestration against workflow artifacts",
  args: {
    operation: tool.schema.enum(["start", "resume", "status", "result"] as const),
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    archive_path: tool.schema.string().optional(),
    summary: tool.schema.string().optional(),
    notes: tool.schema.array(tool.schema.string()).optional(),
    terminal_state: tool.schema.enum(archiveStatuses).optional(),
    session_url: tool.schema.string().nullable().optional(),
    generated_at: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = await readJsonFile<Record<string, unknown>>(handoffPath)
    if (!handoffData) return JSON.stringify({ ok: false, error: `missing handoff: ${handoffPath}` }, null, 2)

    const archivePath = args.archive_path ? resolvePath(root, args.archive_path) : defaultArchivePathFromHandoff(root, handoffData)
    const now = args.generated_at || nowIso()
    const existing = normalizeSessionSnapshot("archive_session", currentSession(handoffData, "archive_session"), "opencode")
    const archiveContextPath = await writeStageContext(root, handoffData, "archive_session", {
      approved_artifact: handoffData.approved_artifact || null,
      review_path: handoffData.review_path || null,
      verification_path: handoffData.verification_path || null,
      dispatch_plan_path: handoffData.dispatch_plan_path || null,
    })

    if (args.operation === "status") {
      const archiveData = await readJsonFile<Record<string, unknown>>(archivePath)
      return JSON.stringify(
        {
          ok: true,
          operation: args.operation,
          handoff_path: handoffPath,
          archive_path: archiveData ? archivePath : null,
          session: existing,
          handoff_status: handoffData.handoff_status || null,
          result_ready: !!archiveData,
          next_expected_input: archiveData ? null : "archive result",
          resume_hint: existing?.resume_command || null,
        },
        null,
        2
      )
    }

    if (args.operation === "result") {
      if (!args.terminal_state) {
        const archiveData = await readJsonFile<Record<string, unknown>>(archivePath)
        return JSON.stringify({ ok: true, operation: args.operation, handoff_path: handoffPath, archive: archiveData }, null, 2)
      }
      if (!existing) return JSON.stringify({ ok: false, error: "missing archive_session on handoff" }, null, 2)

      const terminalSession = {
        ...existing,
        state: args.terminal_state,
        last_activity_at: now,
        session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
        metadata: {
          ...existing.metadata,
          summary: args.summary || null,
          context_path: (existing.metadata.context_path as string | undefined) || archiveContextPath,
          delegate_status: "completed",
          delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "archive-orchestrator:runtime",
          delegate_contract:
            (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
            buildDelegateContract({
              stage: "archive",
              delegate_role: "archive-orchestrator",
              delegate_identity: "archive-orchestrator:runtime",
              delegate_mode: "orchestrator",
              context_mode: "artifact-backed",
              result_kind: "archive-record",
              required_fields: ["summary", "notes"],
            }),
          delegate_target_contract:
            (existing.metadata.delegate_target_contract as Record<string, unknown> | undefined) ||
            buildDelegateContract({
              stage: "archive",
              delegate_role: "archiver",
              delegate_identity: "archiver:general",
              subagent_type: "general",
              delegate_mode: "specialist",
              context_mode: "fresh-context",
              result_kind: "archive-record",
              required_fields: ["summary", "notes"],
            }),
        },
      }

      const archiveData = withArtifactRole({
        schema_version: "1",
        workflow_id: handoffData.workflow_id,
        slug: handoffData.slug,
        change_id: handoffData.change_id ?? null,
        status: args.terminal_state,
        handoff_path: handoffPath,
        archive_session: terminalSession,
        summary: args.summary || null,
        notes: args.notes || [],
        generated_at: now,
      }, "archive", path.relative(root, archivePath))
      await writeJsonFile(archivePath, archiveData)

      const nextHandoff = attachPhaseGraph({
        schema_version: "1",
        ...handoffData,
        stage: "workflow-archive",
        archive_path: path.relative(root, archivePath),
        handoff_status: args.terminal_state === "completed" ? "completed" : "blocked",
        last_transition: `workflow-archive result ${args.terminal_state}`,
        archive_session: terminalSession,
        preferred_next_stage: args.terminal_state === "completed" ? "done" : "workflow-archive",
        preferred_next_command: args.terminal_state === "completed" ? "" : `/workflow-archive ${path.relative(root, handoffPath)}`,
        generated_at: now,
      })
      await writeJsonFile(handoffPath, nextHandoff)
      return JSON.stringify({ ok: true, operation: args.operation, handoff: nextHandoff, archive: archiveData }, null, 2)
    }

    const shouldReuse = !!existing && !isTerminalSessionState(existing.state)
    if (args.operation === "resume" && !shouldReuse) {
      return JSON.stringify({ ok: false, error: "no pending archive_session to resume" }, null, 2)
    }

    const session = shouldReuse
      ? {
          ...existing,
          mode: "sync",
          state: "in-progress",
          last_activity_at: now,
          session_url: args.session_url !== undefined ? args.session_url : existing.session_url,
          metadata: {
            ...existing.metadata,
            context_path: (existing.metadata.context_path as string | undefined) || archiveContextPath,
            delegate_status: "pending",
            delegate_identity: (existing.metadata.delegate_identity as string | undefined) || "archive-orchestrator:runtime",
            delegate_contract:
              (existing.metadata.delegate_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "archive",
                delegate_role: "archive-orchestrator",
                delegate_identity: "archive-orchestrator:runtime",
                delegate_mode: "orchestrator",
                context_mode: "artifact-backed",
                result_kind: "archive-record",
                required_fields: ["summary", "notes"],
              }),
            delegate_target_contract:
              (existing.metadata.delegate_target_contract as Record<string, unknown> | undefined) ||
              buildDelegateContract({
                stage: "archive",
                delegate_role: "archiver",
                delegate_identity: "archiver:general",
                subagent_type: "general",
                delegate_mode: "specialist",
                context_mode: "fresh-context",
                result_kind: "archive-record",
                required_fields: ["summary", "notes"],
              }),
          },
        }
      : {
          kind: "archive",
          mode: "sync",
          session_id: randomUUID(),
          provider: "opencode",
          state: "queued",
          requested_at: now,
          started_at: now,
          last_activity_at: now,
          expires_at: null,
          resume_command: `/workflow-archive ${path.relative(root, handoffPath)}`,
          session_url: args.session_url ?? null,
          metadata: {
            context_path: archiveContextPath,
            delegate_status: "pending",
            delegate_identity: "archive-orchestrator:runtime",
            delegate_contract: buildDelegateContract({
              stage: "archive",
              delegate_role: "archive-orchestrator",
              delegate_identity: "archive-orchestrator:runtime",
              delegate_mode: "orchestrator",
              context_mode: "artifact-backed",
              result_kind: "archive-record",
              required_fields: ["summary", "notes"],
            }),
            delegate_target_contract: buildDelegateContract({
              stage: "archive",
              delegate_role: "archiver",
              delegate_identity: "archiver:general",
              subagent_type: "general",
              delegate_mode: "specialist",
              context_mode: "fresh-context",
              result_kind: "archive-record",
              required_fields: ["summary", "notes"],
            }),
          },
        }

    const nextHandoff = attachPhaseGraph({
      schema_version: "1",
      ...handoffData,
      stage: "workflow-archive",
      archive_path: handoffData.archive_path || null,
      handoff_status: "archiving",
      last_transition: shouldReuse ? "workflow-archive session resumed" : "workflow-archive session started",
      archive_session: session,
      preferred_next_stage: "workflow-archive",
      preferred_next_command: `/workflow-archive ${path.relative(root, handoffPath)}`,
      generated_at: now,
    })
    await writeJsonFile(handoffPath, nextHandoff)

    return JSON.stringify(
      {
        ok: true,
        operation: args.operation,
        resumed: shouldReuse,
        handoff_path: handoffPath,
        archive_path: nextHandoff.archive_path,
        session,
        handoff_status: nextHandoff.handoff_status,
        result_ready: false,
        next_expected_input: "archive result",
        resume_hint: session.resume_command,
      },
      null,
      2
    )
  },
})

export const workflow_supervisor_runtime = tool({
  description: "Resolve the next workflow stage to continue in the active flow",
  args: {
    handoff_path: tool.schema.string().optional().describe("Relative or absolute path to handoff.json"),
    artifact_path: tool.schema.string().optional().describe("Handoff or approved review artifact path"),
    review_path: tool.schema.string().optional().describe("Optional explicit review artifact path"),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const result = await resolveWorkflowContinuation(root, args)
    return JSON.stringify(result, null, 2)
  },
})

export const workflow_continue_runtime = tool({
  description: "Advance the workflow into the next stage in the active flow",
  args: {
    handoff_path: tool.schema.string().optional().describe("Relative or absolute path to handoff.json"),
    artifact_path: tool.schema.string().optional().describe("Handoff or approved review artifact path"),
    review_path: tool.schema.string().optional().describe("Optional explicit review artifact path"),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const next = await resolveWorkflowContinuation(root, args)
    const nextState = next as Record<string, unknown>
    if (
      nextState.ok !== true ||
      nextState.can_continue !== true ||
      typeof nextState.stage !== "string" ||
      typeof nextState.operation !== "string"
    ) {
      return JSON.stringify(next, null, 2)
    }

    if (nextState.stage === "ralplan") {
      const result = JSON.parse(
        await ralplan_runtime.execute(
          {
            operation: nextState.operation as "start" | "resume",
            handoff_path: nextState.artifact_path as string,
          },
          context
        )
      ) as Record<string, unknown>
      return JSON.stringify({ ok: true, next, continued: result }, null, 2)
    }

    if (nextState.stage === "review-bridge") {
      const result = JSON.parse(
        await review_bridge_runtime.execute(
          {
            operation: nextState.operation as "start" | "resume",
            handoff_path: nextState.artifact_path as string,
            review_path: (nextState.review_path as string | undefined) || undefined,
            review_target: (nextState.review_target as string | undefined) || undefined,
          },
          context
        )
      ) as Record<string, unknown>
      return JSON.stringify({ ok: true, next, continued: result }, null, 2)
    }

    if (nextState.stage === "autopilot") {
      const result = JSON.parse(
        await autopilot_runtime.execute(
          {
            operation: nextState.operation as "start" | "resume",
            artifact_path: nextState.artifact_path as string,
          },
          context
        )
      ) as Record<string, unknown>
      return JSON.stringify({ ok: true, next, continued: result }, null, 2)
    }

    if (nextState.stage === "workflow-verify") {
      const result = JSON.parse(
        await verify_runtime.execute(
          {
            operation: nextState.operation as "start" | "resume",
            handoff_path: nextState.artifact_path as string,
          },
          context
        )
      ) as Record<string, unknown>
      return JSON.stringify({ ok: true, next, continued: result }, null, 2)
    }

    if (nextState.stage === "workflow-archive") {
      const result = JSON.parse(
        await archive_runtime.execute(
          {
            operation: nextState.operation as "start" | "resume",
            handoff_path: nextState.artifact_path as string,
          },
          context
        )
      ) as Record<string, unknown>
      return JSON.stringify({ ok: true, next, continued: result }, null, 2)
    }

    return JSON.stringify({ ok: false, error: `unsupported continuation stage: ${nextState.stage}` }, null, 2)
  },
})

export const validate = tool({
  description: "Validate workflow handoff/review artifacts against local state rules",
  args: {
    handoff_path: tool.schema.string().describe("Relative or absolute path to handoff.json"),
    review_path: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path)
    const handoffData = await readJsonFile<Record<string, unknown>>(handoffPath)
    const errors: string[] = []
    const warnings: string[] = []
    const nowMs = Date.now()
    const planningQueuedStaleMs = 15 * 60 * 1000
    const planningInProgressStaleMs = 30 * 60 * 1000
    const dispatchQueuedStaleMs = 15 * 60 * 1000
    const dispatchInProgressStaleMs = 30 * 60 * 1000

    if (!handoffData) {
      errors.push(`missing handoff: ${handoffPath}`)
    } else {
      if (handoffData.schema_version !== "1") errors.push("handoff schema_version must be 1")
      if (typeof handoffData.workflow_id !== "string") errors.push("handoff workflow_id missing")
      if (typeof handoffData.slug !== "string") errors.push("handoff slug missing")
      const storePolicy = (handoffData.store_policy as Record<string, unknown> | undefined) || null
      if (storePolicy) {
        if (typeof storePolicy.provider !== "string") errors.push("store_policy.provider invalid")
        if (typeof storePolicy.base_locator !== "string") errors.push("store_policy.base_locator invalid")
      }
      const artifactRefs = (handoffData.artifact_refs as Record<string, unknown> | undefined) || null
      if (artifactRefs) {
        for (const [role, ref] of Object.entries(artifactRefs)) {
          if (!ref || typeof ref !== "object") {
            errors.push(`artifact_refs.${role} invalid`)
            continue
          }
          if (typeof (ref as Record<string, unknown>).locator !== "string") {
            errors.push(`artifact_refs.${role}.locator invalid`)
          }
          if (typeof (ref as Record<string, unknown>).provider !== "string") {
            errors.push(`artifact_refs.${role}.provider invalid`)
          }
        }
      }
      if (!handoffStatuses.includes((handoffData.handoff_status as typeof handoffStatuses[number]) || "ready-for-planning")) {
        errors.push("handoff_status invalid")
      }
      if (!approvalStatuses.includes((handoffData.approval_status as typeof approvalStatuses[number]) || "not-reviewed")) {
        errors.push("approval_status invalid")
      }

      let startupData: Record<string, unknown> | null = null
      const startupStatePathValue = handoffData.startup_state_path
      if (startupStatePathValue != null && typeof startupStatePathValue !== "string") {
        errors.push("startup_state_path invalid")
      }
      if (typeof startupStatePathValue === "string") {
        const startupStatePath = resolvePath(root, startupStatePathValue)
        startupData = await readJsonFile<Record<string, unknown>>(startupStatePath)
        if (!startupData) {
          errors.push(`missing startup state: ${startupStatePath}`)
        } else {
          if (startupData.schema_version !== "1") errors.push("startup state schema_version must be 1")
          if (typeof startupData.workflow_id !== "string") errors.push("startup state workflow_id missing")
          if (typeof startupData.slug !== "string") errors.push("startup state slug missing")
          if (typeof startupData.request_text !== "string") errors.push("startup state request_text missing")
          if (typeof startupData.created_at !== "string") errors.push("startup state created_at missing")
          if (!startupStatuses.includes((startupData.status as typeof startupStatuses[number]) || "classified")) {
            errors.push("startup state status invalid")
          }

          const startupBrief = (startupData.startup_brief as Record<string, unknown> | undefined) || null
          if (!startupBrief || typeof startupBrief.goal_summary !== "string") {
            errors.push("startup state startup_brief.goal_summary missing")
          }
          if (!Array.isArray(startupBrief?.codebase_context)) {
            errors.push("startup state startup_brief.codebase_context missing")
          }
          if (!Array.isArray(startupBrief?.likely_file_targets)) {
            errors.push("startup state startup_brief.likely_file_targets missing")
          }
          if (!Array.isArray(startupBrief?.risks)) {
            errors.push("startup state startup_brief.risks missing")
          }
          if (typeof startupBrief?.recommended_next_stage !== "string") {
            errors.push("startup state startup_brief.recommended_next_stage missing")
          }

          const confirmation = (startupData.confirmation as Record<string, unknown> | undefined) || null
          if (!confirmation || typeof confirmation.required !== "boolean") {
            errors.push("startup state confirmation.required missing")
          }
          const resume = (startupData.resume as Record<string, unknown> | undefined) || null
          if (!resume || typeof resume.handoff_path !== "string") {
            errors.push("startup state resume.handoff_path missing")
          }
          if (!resume || typeof resume.next_command_on_confirm !== "string") {
            errors.push("startup state resume.next_command_on_confirm missing")
          }
          if (!resume || typeof resume.summary_source !== "string") {
            errors.push("startup state resume.summary_source missing")
          }

          if (startupData.workflow_id !== handoffData.workflow_id) {
            errors.push("workflow_id mismatch between handoff and startup state")
          }
          if (startupData.slug !== handoffData.slug) {
            errors.push("slug mismatch between handoff and startup state")
          }
          if (!sameResolvedPath(root, resume?.handoff_path as string | undefined, handoffPath)) {
            errors.push("startup state resume.handoff_path must point to handoff")
          }
          if (
            typeof startupBrief?.recommended_next_stage === "string" &&
            typeof handoffData.preferred_next_stage === "string" &&
            startupBrief.recommended_next_stage !== handoffData.preferred_next_stage
          ) {
            errors.push("startup recommended_next_stage must align with handoff preferred_next_stage")
          }
          if (
            typeof resume?.next_command_on_confirm === "string" &&
            typeof handoffData.preferred_next_command === "string" &&
            resume.next_command_on_confirm !== handoffData.preferred_next_command
          ) {
            errors.push("startup next_command_on_confirm must align with handoff preferred_next_command")
          }
          if (
            startupData.status === "awaiting-confirmation" &&
            handoffData.handoff_status !== "ready-for-planning" &&
            handoffData.handoff_status !== "planned"
          ) {
            errors.push("awaiting-confirmation startup state cannot advance beyond planning handoff states")
          }
          if (
            startupData.status === "confirmed" &&
            confirmation?.decision != null &&
            confirmation.decision !== "confirmed"
          ) {
            errors.push("confirmed startup state requires confirmation.decision=confirmed")
          }
          if (
            startupData.status === "cancelled" &&
            confirmation?.decision != null &&
            confirmation.decision !== "cancelled"
          ) {
            errors.push("cancelled startup state requires confirmation.decision=cancelled")
          }
        }
      }

      const handoffPlanningSession = handoffData.planning_session as Record<string, unknown> | null | undefined
      const handoffExecutionSession = handoffData.execution_session as Record<string, unknown> | null | undefined
      const handoffVerificationSession = handoffData.verification_session as Record<string, unknown> | null | undefined
      const handoffArchiveSession = handoffData.archive_session as Record<string, unknown> | null | undefined

      for (const [label, session] of [
        ["planning_session", handoffPlanningSession],
        ["review_session", handoffData.review_session as Record<string, unknown> | null | undefined],
        ["execution_session", handoffExecutionSession],
        ["verification_session", handoffVerificationSession],
        ["archive_session", handoffArchiveSession],
      ] as const) {
        if (!session) continue
        if (!sessionKinds.includes((session.kind as typeof sessionKinds[number]) || "review")) {
          errors.push(`handoff ${label}.kind invalid`)
        }
        if (!sessionModes.includes((session.mode as typeof sessionModes[number]) || "async")) {
          errors.push(`handoff ${label}.mode invalid`)
        }
        if (!sessionProviders.includes((session.provider as typeof sessionProviders[number]) || "opencode")) {
          errors.push(`handoff ${label}.provider invalid`)
        }
        if (!sessionStates.includes((session.state as typeof sessionStates[number]) || "queued")) {
          errors.push(`handoff ${label}.state invalid`)
        }
        const metadata = (session.metadata as Record<string, unknown> | undefined) || null
        const delegateTargetContract = (metadata?.delegate_target_contract as Record<string, unknown> | undefined) || null
        const contextMode = (delegateTargetContract?.context_mode as string | undefined) || null
        const contextPath = (metadata?.context_path as string | undefined) || null
        if (contextMode === "fresh-context") {
          if (!contextPath) {
            errors.push(`handoff ${label} requires metadata.context_path for fresh-context delegate flow`)
          } else {
            const resolvedContextPath = resolvePath(root, contextPath)
            const contextData = await readJsonFile<Record<string, unknown>>(resolvedContextPath)
            if (!contextData) errors.push(`missing context artifact for ${label}: ${contextPath}`)
          }
        }
      }

      const handoffReviewSession = handoffData.review_session as Record<string, unknown> | null | undefined

      if (
        handoffData.review_required_before_execution === true &&
        handoffData.handoff_status === "ready-for-execution" &&
        handoffData.approval_status !== "approved" &&
        handoffData.approval_status !== "waived"
      ) {
        errors.push("ready-for-execution requires approved or waived approval_status")
      }
      if (
        handoffData.handoff_status === "ready-for-execution" &&
        handoffReviewSession &&
        isPendingSessionState(handoffReviewSession.state)
      ) {
        errors.push("ready-for-execution cannot have a pending review_session")
      }
      if (
        handoffData.handoff_status === "ready-for-execution" &&
        (!handoffData.review_path || typeof handoffData.review_path !== "string")
      ) {
        errors.push("ready-for-execution requires review_path")
      }
      if (
        handoffData.handoff_status === "ready-for-execution" &&
        (!handoffData.approved_artifact || typeof handoffData.approved_artifact !== "string")
      ) {
        errors.push("ready-for-execution requires approved_artifact")
      }
      if (
        handoffData.handoff_status === "blocked" &&
        handoffReviewSession &&
        isPendingSessionState(handoffReviewSession.state)
      ) {
        errors.push("blocked handoff cannot have a still-pending review_session")
      }
      if (
        handoffData.handoff_status === "blocked" &&
        handoffVerificationSession &&
        isPendingSessionState(handoffVerificationSession.state)
      ) {
        errors.push("blocked handoff cannot have a still-pending verification_session")
      }
      if (
        handoffData.handoff_status === "blocked" &&
        handoffArchiveSession &&
        isPendingSessionState(handoffArchiveSession.state)
      ) {
        errors.push("blocked handoff cannot have a still-pending archive_session")
      }
      if (
        handoffData.handoff_status === "review-required" &&
        handoffPlanningSession &&
        isPendingSessionState(handoffPlanningSession.state)
      ) {
        errors.push("review-required cannot have a still-pending planning_session")
      }
      if (
        handoffData.handoff_status === "planned" &&
        handoffPlanningSession &&
        isTerminalSessionState(handoffPlanningSession.state) &&
        handoffPlanningSession.state === "completed" &&
        (!handoffData.consensus_plan_path || typeof handoffData.consensus_plan_path !== "string")
      ) {
        errors.push("completed planning_session requires consensus_plan_path")
      }
      if (
        handoffData.handoff_status === "planned" &&
        handoffPlanningSession &&
        isPendingSessionState(handoffPlanningSession.state) &&
        (!handoffData.plan_path || typeof handoffData.plan_path !== "string" || !(await textFileExists(resolvePath(root, handoffData.plan_path))))
      ) {
        errors.push("planned handoff with pending planning_session requires a durable draft plan on disk")
      }
      if (
        handoffData.handoff_status === "planned" &&
        handoffPlanningSession &&
        handoffPlanningSession.state === "in-progress" &&
        !hasDelegateLaunchMarker(handoffPlanningSession)
      ) {
        errors.push("in-progress planning_session requires a durable delegate launch marker (session_url, delegate_task_id, or delegate_launch_handle)")
      }
      if (handoffData.handoff_status === "planned" && handoffPlanningSession && isPendingSessionState(handoffPlanningSession.state)) {
        const planningLastSeenMs = latestKnownActivityMs(
          handoffPlanningSession.last_activity_at,
          handoffPlanningSession.started_at,
          handoffPlanningSession.requested_at,
          ((handoffPlanningSession.metadata as Record<string, unknown> | undefined) || {}).delegate_last_output_at,
          ((handoffPlanningSession.metadata as Record<string, unknown> | undefined) || {}).delegate_started_at
        )
        if (
          ["queued", "awaiting-input", "awaiting-reviewer"].includes((handoffPlanningSession.state as string) || "queued") &&
          !hasDelegateLaunchMarker(handoffPlanningSession)
        ) {
          warnings.push("pending planning_session has no delegate launch marker yet; this is allowed briefly but may indicate slow orchestration if it persists")
        }
        if (
          ["queued", "awaiting-input", "awaiting-reviewer"].includes((handoffPlanningSession.state as string) || "queued") &&
          !hasDelegateLaunchMarker(handoffPlanningSession) &&
          isStaleMs(planningLastSeenMs, nowMs, planningQueuedStaleMs)
        ) {
          warnings.push("pending planning_session has no delegate launch marker and appears stale; consider relaunching or marking the planner blocked")
        }
        if (
          handoffPlanningSession.state === "in-progress" &&
          isStaleMs(planningLastSeenMs, nowMs, planningInProgressStaleMs)
        ) {
          warnings.push("in-progress planning_session appears stale; verify the planner delegate is still producing output before keeping it live")
        }
      }
      if (handoffData.consensus_plan_path && typeof handoffData.consensus_plan_path === "string") {
        const requiresDurablePlan =
          handoffData.handoff_status !== "planned" ||
          (handoffPlanningSession &&
            isTerminalSessionState(handoffPlanningSession.state) &&
            handoffPlanningSession.state === "completed")
        if (requiresDurablePlan && !(await textFileExists(resolvePath(root, handoffData.consensus_plan_path)))) {
          errors.push(`missing consensus plan: ${resolvePath(root, handoffData.consensus_plan_path)}`)
        }
      }
      if (handoffData.task_graph_path && typeof handoffData.task_graph_path === "string") {
        const taskGraphPath = resolvePath(root, handoffData.task_graph_path)
        const taskGraphData = await readJsonFile<Record<string, unknown>>(taskGraphPath)
        if (!taskGraphData) {
          errors.push(`missing task graph: ${taskGraphPath}`)
        } else {
          if (taskGraphData.schema_version !== "1") errors.push("task graph schema_version must be 1")
          if (typeof taskGraphData.workflow_id !== "string") errors.push("task graph workflow_id missing")
          if (typeof taskGraphData.slug !== "string") errors.push("task graph slug missing")
        }
      }
      if (handoffData.dispatch_plan_path && typeof handoffData.dispatch_plan_path === "string") {
        const dispatchPlanPath = resolvePath(root, handoffData.dispatch_plan_path)
        const dispatchPlanData = await readJsonFile<Record<string, unknown>>(dispatchPlanPath)
        if (!dispatchPlanData) {
          errors.push(`missing dispatch plan: ${dispatchPlanPath}`)
        } else {
          if (dispatchPlanData.schema_version !== "1") errors.push("dispatch plan schema_version must be 1")
          if (typeof dispatchPlanData.workflow_id !== "string") errors.push("dispatch plan workflow_id missing")
          if (typeof dispatchPlanData.slug !== "string") errors.push("dispatch plan slug missing")
          const dispatchRequests = Array.isArray(dispatchPlanData.dispatch_requests)
            ? (dispatchPlanData.dispatch_requests as Array<Record<string, unknown>>)
            : []
          for (const batch of dispatchRequests) {
            const requests = Array.isArray(batch.requests) ? (batch.requests as Array<Record<string, unknown>>) : []
            for (const request of requests) {
              const requestStatus = (request.request_status as string | undefined) || "pending"
              const resultPath = request.result_path as string | undefined
              const requestLastSeenMs = latestKnownActivityMs(
                request.completed_at,
                request.claimed_at,
                request.delegate_last_output_at,
                request.delegate_started_at
              )
              if (requestStatus === "queued" && !hasDelegateLaunchMarker(request)) {
                warnings.push(`dispatch request ${request.request_id || "(unknown)"} is queued without a delegate launch marker; allow briefly, but watch for orchestration lag`)
              }
              if (requestStatus === "queued" && !hasDelegateLaunchMarker(request) && isStaleMs(requestLastSeenMs, nowMs, dispatchQueuedStaleMs)) {
                warnings.push(`dispatch request ${request.request_id || "(unknown)"} is stale in queued state without a delegate launch marker`)
              }
              if (requestStatus === "in-progress" && !hasDelegateLaunchMarker(request)) {
                errors.push(`dispatch request ${request.request_id || "(unknown)"} requires a delegate launch marker while in-progress`)
              }
              if (requestStatus === "in-progress" && isStaleMs(requestLastSeenMs, nowMs, dispatchInProgressStaleMs)) {
                warnings.push(`dispatch request ${request.request_id || "(unknown)"} appears stale while in-progress; verify the worker is still alive before leaving it active`)
              }
              if (requestStatus === "completed" && resultPath) {
                const resultData = await readJsonFile<Record<string, unknown>>(resolvePath(root, resultPath))
                if (!resultData) errors.push(`missing dispatch result: ${resultPath}`)
              }
            }
          }
          if (
            handoffData.handoff_status === "completed" &&
            Array.isArray((dispatchPlanData.request_summary as Record<string, unknown> | undefined)?.pending_request_ids) &&
            (((dispatchPlanData.request_summary as Record<string, unknown> | undefined)?.pending_request_ids as string[]) || []).length > 0
          ) {
            errors.push("completed handoff cannot reference a dispatch plan with pending requests")
          }
        }
      }
      if (
        handoffData.handoff_status === "executing" &&
        handoffExecutionSession &&
        !isPendingSessionState(handoffExecutionSession.state)
      ) {
        errors.push("executing handoff requires a pending execution_session")
      }
      if (handoffData.handoff_status === "executing" && handoffExecutionSession) {
        const executionMetadata = (handoffExecutionSession.metadata as Record<string, unknown> | undefined) || null
        const executionTaskGraphState = (executionMetadata?.task_graph_state as Record<string, unknown> | undefined) || null
        const executionDispatchSummary = (executionMetadata?.dispatch_summary as Record<string, unknown> | undefined) || null
        const remainingNodeIds = Array.isArray(executionTaskGraphState?.remaining_node_ids)
          ? (executionTaskGraphState?.remaining_node_ids as string[])
          : []
        const pendingRequestIds = Array.isArray(executionDispatchSummary?.pending_request_ids)
          ? (executionDispatchSummary?.pending_request_ids as string[])
          : []
        if (remainingNodeIds.length === 0 && pendingRequestIds.length === 0) {
          errors.push("executing handoff cannot have zero remaining nodes and zero pending requests; write a terminal execution result")
        }
      }
      if (
        handoffData.handoff_status === "ready-for-verification" &&
        handoffExecutionSession &&
        !isTerminalSessionState(handoffExecutionSession.state)
      ) {
        errors.push("ready-for-verification requires a terminal execution_session")
      }
      if (
        handoffData.handoff_status === "ready-for-verification" &&
        handoffVerificationSession &&
        isPendingSessionState(handoffVerificationSession.state)
      ) {
        errors.push("ready-for-verification cannot have a still-pending verification_session")
      }
      if (
        handoffData.handoff_status === "verifying" &&
        handoffVerificationSession &&
        !isPendingSessionState(handoffVerificationSession.state)
      ) {
        errors.push("verifying handoff requires a pending verification_session")
      }
      if (
        handoffData.handoff_status === "ready-for-archive" &&
        (!handoffData.verification_path || typeof handoffData.verification_path !== "string")
      ) {
        errors.push("ready-for-archive requires verification_path")
      }
      if (
        handoffData.handoff_status === "ready-for-archive" &&
        handoffVerificationSession &&
        (!isTerminalSessionState(handoffVerificationSession.state) || handoffVerificationSession.state !== "completed")
      ) {
        errors.push("ready-for-archive requires a completed verification_session")
      }
      if (
        handoffData.handoff_status === "archiving" &&
        handoffArchiveSession &&
        !isPendingSessionState(handoffArchiveSession.state)
      ) {
        errors.push("archiving handoff requires a pending archive_session")
      }
      if (
        handoffData.handoff_status === "completed" &&
        handoffExecutionSession &&
        !isTerminalSessionState(handoffExecutionSession.state)
      ) {
        errors.push("completed handoff requires a terminal execution_session")
      }
      const phaseGraphNodes = Array.isArray((handoffData.phase_graph as Record<string, unknown> | undefined)?.nodes)
        ? (((handoffData.phase_graph as Record<string, unknown>).nodes as Array<Record<string, unknown>>) || []).map((node) => String(node.id || ""))
        : []
      if (
        handoffData.handoff_status === "completed" &&
        phaseGraphNodes.includes("workflow-archive") &&
        (!handoffData.archive_path || typeof handoffData.archive_path !== "string")
      ) {
        errors.push("completed archive-enabled handoff requires archive_path")
      }
      if (
        handoffData.handoff_status === "completed" &&
        phaseGraphNodes.includes("workflow-archive") &&
        handoffArchiveSession &&
        (!isTerminalSessionState(handoffArchiveSession.state) || handoffArchiveSession.state !== "completed")
      ) {
        errors.push("completed archive-enabled handoff requires a completed archive_session")
      }
      if (
        handoffData.handoff_status === "blocked" &&
        handoffExecutionSession &&
        isPendingSessionState(handoffExecutionSession.state)
      ) {
        errors.push("blocked handoff cannot have a still-pending execution_session")
      }
      if (handoffData.verification_path && typeof handoffData.verification_path === "string") {
        const verificationPath = resolvePath(root, handoffData.verification_path)
        const verificationData = await readJsonFile<Record<string, unknown>>(verificationPath)
        if (!verificationData) {
          errors.push(`missing verification: ${verificationPath}`)
        } else if (!verificationStatuses.includes((verificationData.status as typeof verificationStatuses[number]) || "failed")) {
          errors.push("verification status invalid")
        }
      }
      if (handoffData.archive_path && typeof handoffData.archive_path === "string") {
        const archivePath = resolvePath(root, handoffData.archive_path)
        const archiveData = await readJsonFile<Record<string, unknown>>(archivePath)
        if (!archiveData) {
          errors.push(`missing archive: ${archivePath}`)
        } else if (!archiveStatuses.includes((archiveData.status as typeof archiveStatuses[number]) || "failed")) {
          errors.push("archive status invalid")
        }
      }
    }

    let reviewData: Record<string, unknown> | null = null
    if (args.review_path) {
      const reviewPath = resolvePath(root, args.review_path)
      reviewData = await readJsonFile<Record<string, unknown>>(reviewPath)
      if (!reviewData) {
        errors.push(`missing review: ${reviewPath}`)
      } else {
        if (reviewData.schema_version !== "1") errors.push("review schema_version must be 1")
        if (typeof reviewData.workflow_id !== "string") errors.push("review workflow_id missing")
        if (typeof reviewData.slug !== "string") errors.push("review slug missing")
        if (!reviewStatuses.includes((reviewData.status as typeof reviewStatuses[number]) || "aborted")) {
          errors.push("review status invalid")
        }
        const reviewSession = reviewData.review_session as Record<string, unknown> | null | undefined
        if (reviewSession) {
          if (!sessionKinds.includes((reviewSession.kind as typeof sessionKinds[number]) || "review")) {
            errors.push("review review_session.kind invalid")
          }
          if (!sessionModes.includes((reviewSession.mode as typeof sessionModes[number]) || "async")) {
            errors.push("review review_session.mode invalid")
          }
          if (!sessionProviders.includes((reviewSession.provider as typeof sessionProviders[number]) || "plannotator")) {
            errors.push("review review_session.provider invalid")
          }
          if (!sessionStates.includes((reviewSession.state as typeof sessionStates[number]) || "completed")) {
            errors.push("review review_session.state invalid")
          }
          if (!isTerminalSessionState(reviewSession.state)) {
            errors.push("review review_session must be terminal when review artifact exists")
          }
        }
        if (
          handoffData &&
          reviewData &&
          handoffData.workflow_id !== reviewData.workflow_id
        ) {
          errors.push("workflow_id mismatch between handoff and review")
        }
        if (handoffData && reviewData && handoffData.slug !== reviewData.slug) {
          errors.push("slug mismatch between handoff and review")
        }
        if (
          handoffData &&
          reviewData &&
          (handoffData.review_session as Record<string, unknown> | undefined)?.session_id &&
          reviewSession?.session_id &&
          (handoffData.review_session as Record<string, unknown>).session_id !== reviewSession.session_id
        ) {
          errors.push("review_session session_id mismatch between handoff and review")
        }
      }
    }

    return JSON.stringify(
      {
        ok: errors.length === 0,
        handoff_path: handoffPath,
        review_path: args.review_path ? resolvePath(root, args.review_path) : null,
        errors,
        warnings,
        handoff_status: handoffData?.handoff_status || null,
        approval_status: handoffData?.approval_status || null,
        startup_status:
          ((typeof handoffData?.startup_state_path === "string"
            ? await readJsonFile<Record<string, unknown>>(resolvePath(root, handoffData.startup_state_path as string))
            : null)?.status as string | undefined) || null,
        review_status: reviewData?.status || null,
      },
      null,
      2
    )
  },
})

export const smoke_marker = tool({
  description: "Write a deterministic smoke marker file for workflow execution tests",
  args: {
    path: tool.schema
      .string()
      .optional()
      .describe("Relative or absolute marker path, defaults to .opencode/smoke/autopilot-ran.txt"),
    content: tool.schema.string().optional().describe("Marker file content"),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const filePath = resolvePath(root, args.path || ".opencode/smoke/autopilot-ran.txt")
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, `${args.content || `autopilot smoke marker ${nowIso()}`}\n`, "utf8")
    return JSON.stringify({ ok: true, path: filePath }, null, 2)
  },
})

export const smoke_ralplan = tool({
  description: "Run the deterministic ralplan smoke fast path for workflow-e2e-smoke",
  args: {
    handoff_path: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path || ".opencode/handoffs/handoff-workflow-e2e-smoke.json")
    const existingHandoff = (await readJsonFile<Record<string, unknown>>(handoffPath)) || { schema_version: "1" }
    const slug =
      (existingHandoff.slug as string | undefined) ||
      path.basename(handoffPath, ".json").replace(/^handoff-/, "") ||
      "workflow-e2e-smoke"
    const workflowId =
      (existingHandoff.workflow_id as string | undefined) ||
      slug
    const handoffRel = path.relative(root, handoffPath)
    const specPath = resolvePath(root, `.opencode/specs/deep-interview-${slug}.md`)
    const planPath = resolvePath(root, `.opencode/plans/consensus-${slug}.md`)
    const graphPath = resolvePath(root, `.opencode/plans/graph-${slug}.json`)
    const now = nowIso()
    const finalPlanContent =
      `# Consensus Plan: ${slug}\n\n` +
      "## Implementation Steps\n\n" +
      "1. Keep all work inside `.opencode/`.\n" +
      "2. Advance handoff to review-required.\n" +
      "3. Materialize deterministic planning artifacts for the smoke path.\n"

    await writeTextFile(
      specPath,
      `# Deep Interview ${slug}\n\n## Purpose\nExercise the deterministic workflow artifact flow entirely inside \.opencode\/.\n`
    )
    await writeTextFile(planPath, finalPlanContent)

    const nextHandoffSeed = attachPhaseGraph({
      schema_version: "1",
      ...existingHandoff,
      workflow_id: workflowId,
      slug,
      stage: "ralplan",
      handoff_status: "review-required",
      last_transition: "smoke ralplan completed",
      consensus_plan_path: path.relative(root, planPath),
      task_graph_path: path.relative(root, graphPath),
      plan_path: path.relative(root, planPath),
      review_path: null,
      approved_artifact: null,
      approval_status: "not-reviewed",
      review_session: null,
      preferred_next_stage: "review-bridge",
      preferred_next_command: `/review-bridge ${handoffRel}`,
      planning_session: {
        kind: "planning",
        mode: "sync",
        session_id:
          (existingHandoff.planning_session as Record<string, unknown> | undefined)?.session_id || randomUUID(),
        provider: "opencode",
        state: "completed",
        requested_at:
          (existingHandoff.planning_session as Record<string, unknown> | undefined)?.requested_at || now,
        started_at:
          (existingHandoff.planning_session as Record<string, unknown> | undefined)?.started_at || now,
        last_activity_at: now,
        expires_at: null,
        resume_command: `/ralplan ${handoffRel}`,
        session_url: null,
        metadata: {
          ...(((existingHandoff.planning_session as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined) || {}),
          phase: "done",
          consensus_plan_path: path.relative(root, planPath),
          task_graph_path: path.relative(root, graphPath),
          summary: "smoke ralplan completed",
        },
      },
      generated_at: now,
    })
    const taskGraph = buildTaskGraph(finalPlanContent, nextHandoffSeed, path.relative(root, planPath), now)
    ;(nextHandoffSeed.planning_session as Record<string, unknown>).metadata = {
      ...(((nextHandoffSeed.planning_session as Record<string, unknown>).metadata as Record<string, unknown>) || {}),
      task_graph_node_count: taskGraph.node_count,
    }

    await writeJsonFile(graphPath, taskGraph)
    await writeJsonFile(handoffPath, nextHandoffSeed)
    if (typeof existingHandoff.startup_state_path === "string") {
      const startupStatePath = resolvePath(root, existingHandoff.startup_state_path)
      const startupState = await readJsonFile<Record<string, unknown>>(startupStatePath)
      if (startupState) {
        await writeJsonFile(startupStatePath, {
          ...startupState,
          startup_brief: {
            ...((startupState.startup_brief as Record<string, unknown> | undefined) || {}),
            recommended_next_stage: "review-bridge",
          },
          resume: {
            ...((startupState.resume as Record<string, unknown> | undefined) || {}),
            handoff_path: handoffRel,
            next_command_on_confirm: `/review-bridge ${handoffRel}`,
          },
          generated_at: now,
        })
      }
    }

    return JSON.stringify(
      {
        ok: true,
        handoff_path: handoffPath,
        plan_path: planPath,
        graph_path: graphPath,
        handoff_status: nextHandoffSeed.handoff_status,
      },
      null,
      2
    )
  },
})

export const smoke_review = tool({
  description: "Run the deterministic review-bridge smoke fast path for workflow-e2e-smoke",
  args: {
    handoff_path: tool.schema.string().optional(),
    review_path: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path || ".opencode/handoffs/handoff-workflow-e2e-smoke.json")
    const reviewPath = resolvePath(root, args.review_path || ".opencode/reviews/review-workflow-e2e-smoke.json")
    const started = JSON.parse(
      await review_bridge_runtime.execute(
        {
          operation: "start",
          handoff_path: path.relative(root, handoffPath),
          review_path: path.relative(root, reviewPath),
          review_target: ".opencode/plans/consensus-workflow-e2e-smoke.md",
          review_type: "plan",
        },
        context
      )
    )
    const completed = JSON.parse(
      await review_bridge_runtime.execute(
        {
          operation: "result",
          handoff_path: path.relative(root, handoffPath),
          review_path: path.relative(root, reviewPath),
          decision: "waived",
          review_target: ".opencode/plans/consensus-workflow-e2e-smoke.md",
          review_type: "plan",
          approved_artifact: ".opencode/plans/consensus-workflow-e2e-smoke.md",
          decision_by: "workflow-smoke",
          notes: ["Deterministic smoke waiver for workflow-e2e-smoke."],
        },
        context
      )
    )
    return JSON.stringify({ ok: true, handoff_path: handoffPath, review_path: reviewPath, started, completed }, null, 2)
  },
})

export const smoke_autopilot = tool({
  description: "Run the deterministic autopilot smoke fast path for workflow-e2e-smoke",
  args: {
    handoff_path: tool.schema.string().optional(),
    marker_path: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffPath = resolvePath(root, args.handoff_path || ".opencode/handoffs/handoff-workflow-e2e-smoke.json")
    const markerPath = resolvePath(root, args.marker_path || ".opencode/smoke/autopilot-ran.txt")
    await writeTextFile(markerPath, `autopilot smoke marker ${nowIso()}`)
    const started = JSON.parse(
      await autopilot_runtime.execute(
        {
          operation: "start",
          handoff_path: path.relative(root, handoffPath),
          execution_target: ".opencode/plans/consensus-workflow-e2e-smoke.md",
        },
        context
      )
    )
    const completed = JSON.parse(
      await autopilot_runtime.execute(
        {
          operation: "result",
          handoff_path: path.relative(root, handoffPath),
          terminal_state: "completed",
          verification_summary: "Smoke marker written.",
          verification_artifacts: [".opencode/smoke/autopilot-ran.txt"],
          result_summary: "smoke autopilot completed",
        },
        context
      )
    )
    return JSON.stringify({ ok: true, handoff_path: handoffPath, marker_path: markerPath, started, completed }, null, 2)
  },
})

export const smoke_dispatch = tool({
  description: "Run deterministic dispatch claim/result smoke coverage",
  args: {
    dispatch_plan_path: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const dispatchPlanPath = resolvePath(root, args.dispatch_plan_path || ".opencode/executions/dispatch-claim-smoke.json")
    const initialRequestId = "batch-1-step-1"
    const initialResultPath = ".opencode/executions/results/dispatch-claim-smoke-batch-1-step-1.json"
    const resultPath = path.join(root, initialResultPath)
    await removeFileIfExists(resultPath)
    await writeJsonFile(dispatchPlanPath, {
      schema_version: "1",
      workflow_id: "dispatch-claim-smoke",
      slug: "dispatch-claim-smoke",
      generated_at: nowIso(),
      dispatch_plan_path: ".opencode/executions/dispatch-claim-smoke.json",
      task_graph_path: ".opencode/plans/graph-agent-teams-lite-comparison.json",
      execution_target: ".opencode/plans/consensus-agent-teams-lite-comparison.md",
      phase: "executing",
      ready_batch_count: 1,
      ready_batches: [
        {
          batch_id: "batch-1",
          group: "serial",
          node_ids: ["step-1"],
          mode: "serial",
        },
      ],
      dispatch_requests: [
        {
          batch_id: "batch-1",
          group: "serial",
          mode: "serial",
          requests: [
            {
              request_id: initialRequestId,
              batch_id: "batch-1",
              node_id: "step-1",
              label: "Synthetic dispatch claim smoke request.",
              subagent_type: "fixer",
              request_status: "pending",
              result_path: initialResultPath,
              execution_target: ".opencode/plans/consensus-agent-teams-lite-comparison.md",
              prompt: "Synthetic dispatch claim smoke prompt.",
            },
          ],
        },
      ],
      reconcile_plan: {
        reconcile_required: false,
        reconcile_scope: [],
        verifier_hint: "verify serial batch output",
        expected_result_paths: [initialResultPath],
        request_ids: [initialRequestId],
        status: "pending",
        completed_request_ids: [],
        blocked_request_ids: [],
        pending_request_ids: [initialRequestId],
      },
      reconcile_required: false,
      reconcile_scope: [],
      next_dispatch_mode: "serial",
      request_summary: {
        request_count: 1,
        completed_request_ids: [],
        blocked_request_ids: [],
        pending_request_ids: [initialRequestId],
      },
    })

    const claimed = JSON.parse(
      await execution_dispatch_claim.execute(
        {
          dispatch_plan_path: path.relative(root, dispatchPlanPath),
        },
        context
      )
    ) as Record<string, unknown>

    const completed = JSON.parse(
      await execution_dispatch_result.execute(
        {
          dispatch_plan_path: path.relative(root, dispatchPlanPath),
          request_id: initialRequestId,
          request_status: "completed",
          summary: "dispatch smoke completed",
          verification_artifacts: [initialResultPath],
        },
        context
      )
    ) as Record<string, unknown>

    const resultData = await readJsonFile<Record<string, unknown>>(resultPath)
    return JSON.stringify(
      {
        ok: !!resultData,
        dispatch_plan_path: dispatchPlanPath,
        result_path: resultPath,
        claimed,
        completed,
      },
      null,
      2
    )
  },
})

export const smoke_dispatch_parallel = tool({
  description: "Run deterministic parallel dispatch claim/result advancement smoke",
  args: {},
  async execute(_args, context) {
    const root = baseDir(context)
    const graphPath = path.join(root, ".opencode/plans/graph-parallel-dispatch-smoke.json")
    const dispatchPath = path.join(root, ".opencode/executions/dispatch-parallel-dispatch-smoke.json")
    await writeJsonFile(graphPath, {
      schema_version: "1",
      workflow_id: "parallel-dispatch-smoke",
      slug: "parallel-dispatch-smoke",
      generated_at: nowIso(),
      source_plan_path: ".opencode/plans/consensus-agent-teams-lite-comparison.md",
      node_count: 4,
      edge_count: 4,
      nodes: [
        { id: "step-1", label: "Prepare shared execution context.", kind: "step", parallel_group: null, depends_on: [] },
        { id: "step-2", label: "Parallel workstream alpha.", kind: "step", parallel_group: "alpha", depends_on: ["step-1"] },
        { id: "step-3", label: "Parallel workstream beta.", kind: "step", parallel_group: "beta", depends_on: ["step-1"] },
        { id: "step-4", label: "Reconcile parallel outputs.", kind: "step", parallel_group: null, depends_on: ["step-2", "step-3"] },
      ],
      edges: [
        { from: "step-1", to: "step-2" },
        { from: "step-1", to: "step-3" },
        { from: "step-2", to: "step-4" },
        { from: "step-3", to: "step-4" },
      ],
    })
    await writeJsonFile(dispatchPath, {
      schema_version: "1",
      workflow_id: "parallel-dispatch-smoke",
      slug: "parallel-dispatch-smoke",
      generated_at: nowIso(),
      dispatch_plan_path: ".opencode/executions/dispatch-parallel-dispatch-smoke.json",
      task_graph_path: ".opencode/plans/graph-parallel-dispatch-smoke.json",
      execution_target: ".opencode/plans/consensus-agent-teams-lite-comparison.md",
      phase: "executing",
      completed_node_ids: ["step-1"],
      ready_batch_count: 2,
      ready_batches: [
        { batch_id: "batch-1", group: "alpha", node_ids: ["step-2"], mode: "parallel" },
        { batch_id: "batch-2", group: "beta", node_ids: ["step-3"], mode: "parallel" },
      ],
      dispatch_requests: [
        {
          batch_id: "batch-1",
          group: "alpha",
          mode: "parallel",
          requests: [
            {
              request_id: "batch-1-step-2",
              batch_id: "batch-1",
              node_id: "step-2",
              label: "Parallel workstream alpha.",
              subagent_type: "fixer",
              request_status: "pending",
              result_path: ".opencode/executions/results/parallel-dispatch-smoke-batch-1-step-2.json",
              execution_target: ".opencode/plans/consensus-agent-teams-lite-comparison.md",
              prompt: "Synthetic parallel dispatch smoke alpha request.",
            },
          ],
        },
        {
          batch_id: "batch-2",
          group: "beta",
          mode: "parallel",
          requests: [
            {
              request_id: "batch-2-step-3",
              batch_id: "batch-2",
              node_id: "step-3",
              label: "Parallel workstream beta.",
              subagent_type: "fixer",
              request_status: "pending",
              result_path: ".opencode/executions/results/parallel-dispatch-smoke-batch-2-step-3.json",
              execution_target: ".opencode/plans/consensus-agent-teams-lite-comparison.md",
              prompt: "Synthetic parallel dispatch smoke beta request.",
            },
          ],
        },
      ],
      reconcile_plan: {
        reconcile_required: true,
        reconcile_scope: ["step-2", "step-3"],
        verifier_hint: "run verifier after merging parallel outputs",
        expected_result_paths: [
          ".opencode/executions/results/parallel-dispatch-smoke-batch-1-step-2.json",
          ".opencode/executions/results/parallel-dispatch-smoke-batch-2-step-3.json",
        ],
        request_ids: ["batch-1-step-2", "batch-2-step-3"],
        status: "pending",
        completed_request_ids: [],
        blocked_request_ids: [],
        pending_request_ids: ["batch-1-step-2", "batch-2-step-3"],
      },
      reconcile_required: true,
      reconcile_scope: ["step-2", "step-3"],
      next_dispatch_mode: "parallel",
      request_summary: {
        request_count: 2,
        completed_request_ids: [],
        blocked_request_ids: [],
        pending_request_ids: ["batch-1-step-2", "batch-2-step-3"],
      },
    })
    await execution_dispatch_claim.execute({ dispatch_plan_path: ".opencode/executions/dispatch-parallel-dispatch-smoke.json" }, context)
    await execution_dispatch_result.execute(
      {
        dispatch_plan_path: ".opencode/executions/dispatch-parallel-dispatch-smoke.json",
        request_id: "batch-1-step-2",
        request_status: "completed",
        summary: "parallel alpha smoke completed",
      },
      context
    )
    await execution_dispatch_result.execute(
      {
        dispatch_plan_path: ".opencode/executions/dispatch-parallel-dispatch-smoke.json",
        request_id: "batch-2-step-3",
        request_status: "completed",
        summary: "parallel beta smoke completed",
      },
      context
    )
    const finalDispatch = await readJsonFile<Record<string, unknown>>(dispatchPath)
    const nextRequests = Array.isArray(finalDispatch?.dispatch_requests)
      ? (finalDispatch?.dispatch_requests as Array<Record<string, unknown>>)
      : []
    const nextNodeIds = nextRequests.flatMap((batch) =>
      Array.isArray(batch.requests)
        ? (batch.requests as Array<Record<string, unknown>>).map((request) => request.node_id as string)
        : []
    )
    return JSON.stringify(
      {
        ok: nextNodeIds.includes("step-4"),
        dispatch_plan_path: dispatchPath,
        next_node_ids: nextNodeIds,
      },
      null,
      2
    )
  },
})

export const smoke_e2e = tool({
  description: "Run the entire deterministic workflow-e2e-smoke sequence and validate terminal artifacts",
  args: {},
  async execute(_args, context) {
    const root = baseDir(context)
    await init.execute({}, context)
    await removeFileIfExists(path.join(root, ".opencode/handoffs/handoff-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/reviews/review-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/verifications/verify-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/archives/archive-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/smoke/autopilot-ran.txt"))
    await removeFileIfExists(path.join(root, ".opencode/specs/deep-interview-workflow-e2e-smoke.md"))
    await removeFileIfExists(path.join(root, ".opencode/plans/consensus-workflow-e2e-smoke.md"))
    await removeFileIfExists(path.join(root, ".opencode/plans/graph-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/executions/dispatch-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/context/planning-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/context/review-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/context/execution-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/context/verification-workflow-e2e-smoke.json"))
    await removeFileIfExists(path.join(root, ".opencode/context/archive-workflow-e2e-smoke.json"))
    await handoff.execute(
      {
        path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
        workflow_id: "7df05dd1-2d5b-4fe2-a2ae-7eef99460f4d",
        slug: "workflow-e2e-smoke",
        stage: "deep-interview",
        handoff_status: "ready-for-planning",
        last_transition: "initialized-from-workflow-smoke-tool",
        runtime_spec_path: ".opencode/specs/deep-interview-workflow-e2e-smoke.md",
        preferred_next_stage: "ralplan",
        preferred_next_command: "/ralplan .opencode/handoffs/handoff-workflow-e2e-smoke.json",
        review_required_before_execution: true,
        approval_status: "not-reviewed",
        planning_session: null,
        review_session: null,
        execution_session: null,
        verification_session: null,
        archive_session: null,
        review_path: null,
        verification_path: null,
        archive_path: null,
        approved_artifact: null,
        execution_scope: [".opencode/"],
      },
      context
    )
    await writeTextFile(
      path.join(root, ".opencode/specs/deep-interview-workflow-e2e-smoke.md"),
      "# Deep Interview Workflow E2E Smoke\n\n## Goal\n\nExercise runtime wrappers end to end.\n"
    )

    const ralplanStart = JSON.parse(
      await ralplan_runtime.execute(
        {
          operation: "start",
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
        },
        context
      )
    ) as Record<string, unknown>
    const draftPlanExistsBeforeResult = await textFileExists(path.join(root, ".opencode/plans/consensus-workflow-e2e-smoke.md"))
    const draftGraphExistsBeforeResult = await textFileExists(path.join(root, ".opencode/plans/graph-workflow-e2e-smoke.json"))
    const ralplanStatus = JSON.parse(
      await ralplan_runtime.execute(
        {
          operation: "status",
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
        },
        context
      )
    ) as Record<string, unknown>
    const ralplanResume = JSON.parse(
      await ralplan_runtime.execute(
        {
          operation: "resume",
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
          phase: "critic",
        },
        context
      )
    ) as Record<string, unknown>
    const ralplanDone = JSON.parse(
      await ralplan_runtime.execute(
        {
          operation: "result",
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
          terminal_state: "completed",
          final_plan_content:
            "# Consensus Plan: Workflow E2E Smoke\n\n## Implementation Steps\n\n1. Keep all work inside `.opencode/`.\n2. Advance handoff via runtime wrappers.\n3. Waive review for the synthetic smoke case.\n4. Complete autopilot runtime and write an execution marker.\n5. Run workflow verification.\n6. Archive the verified result.\n",
          summary: "ralplan runtime smoke completed",
        },
        context
      )
    ) as Record<string, unknown>
    const smokeHandoff = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".opencode/handoffs/handoff-workflow-e2e-smoke.json")
    )
    const smokePlan = await readFile(path.join(root, ".opencode/plans/consensus-workflow-e2e-smoke.md"), "utf8")
    const smokeGraphPath = path.join(root, ".opencode/plans/graph-workflow-e2e-smoke.json")
    if (!(await textFileExists(smokeGraphPath)) && smokeHandoff) {
      const taskGraph = buildTaskGraph(smokePlan, smokeHandoff, ".opencode/plans/consensus-workflow-e2e-smoke.md", nowIso())
      await writeJsonFile(smokeGraphPath, taskGraph)
    }
    const reviewStart = (ralplanDone.continued as Record<string, unknown> | undefined) || null
    const reviewStatus = JSON.parse(
      await review_bridge_runtime.execute(
        {
          operation: "status",
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
        },
        context
      )
    ) as Record<string, unknown>
    const reviewArtifactExistsBeforeDecision = await textFileExists(path.join(root, ".opencode/reviews/review-workflow-e2e-smoke.json"))
    const reviewDone = JSON.parse(
      await review_bridge_runtime.execute(
        {
          operation: "result",
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
          decision: "waived",
          review_target: ".opencode/plans/consensus-workflow-e2e-smoke.md",
          review_type: "plan",
          approved_artifact: ".opencode/plans/consensus-workflow-e2e-smoke.md",
          notes: ["Deterministic smoke waiver for workflow-e2e-smoke."],
        },
        context
      )
    ) as Record<string, unknown>
    const autopilotStart = (reviewDone.continued as Record<string, unknown> | undefined) || null

    const markerPath = path.join(root, ".opencode/smoke/autopilot-ran.txt")
    await writeTextFile(markerPath, `autopilot smoke marker ${nowIso()}`)
    const autopilotDone = JSON.parse(
      await autopilot_runtime.execute(
        {
          operation: "result",
          artifact_path: ".opencode/reviews/review-workflow-e2e-smoke.json",
          terminal_state: "completed",
          verification_summary: "Smoke marker written.",
          verification_artifacts: [".opencode/smoke/autopilot-ran.txt"],
          result_summary: "autopilot runtime smoke completed",
        },
        context
      )
    ) as Record<string, unknown>
    const afterAutopilot = JSON.parse(
      await workflow_continue_runtime.execute(
        {
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
        },
        context
      )
    ) as Record<string, unknown>
    const verifyDone = JSON.parse(
      await verify_runtime.execute(
        {
          operation: "result",
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
          decision: "passed",
          verification_summary: "Synthetic verification passed.",
          verification_artifacts: [".opencode/smoke/autopilot-ran.txt"],
          notes: ["Deterministic verification for workflow-e2e-smoke."],
        },
        context
      )
    ) as Record<string, unknown>
    const afterVerify = JSON.parse(
      await workflow_continue_runtime.execute(
        {
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
        },
        context
      )
    ) as Record<string, unknown>
    const archiveDone = JSON.parse(
      await archive_runtime.execute(
        {
          operation: "result",
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
          terminal_state: "completed",
          summary: "Synthetic archive completed.",
          notes: ["Deterministic archive for workflow-e2e-smoke."],
        },
        context
      )
    ) as Record<string, unknown>

    const result = JSON.parse(
      await validate.execute(
        {
          handoff_path: ".opencode/handoffs/handoff-workflow-e2e-smoke.json",
          review_path: ".opencode/reviews/review-workflow-e2e-smoke.json",
        },
        context
      )
    ) as { ok: boolean; errors: string[] }

    const finalHandoff = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".opencode/handoffs/handoff-workflow-e2e-smoke.json")
    )
    const taskGraphPath = path.join(root, ".opencode/plans/graph-workflow-e2e-smoke.json")
    return JSON.stringify(
      {
        ok:
          result.ok &&
          finalHandoff?.handoff_status === "completed" &&
          draftPlanExistsBeforeResult === false &&
          draftGraphExistsBeforeResult === false &&
          reviewArtifactExistsBeforeDecision === false,
        draft_plan_exists_before_result: draftPlanExistsBeforeResult,
        draft_graph_exists_before_result: draftGraphExistsBeforeResult,
        review_artifact_exists_before_decision: reviewArtifactExistsBeforeDecision,
        handoff_status: finalHandoff?.handoff_status || null,
        approval_status: finalHandoff?.approval_status || null,
        marker_path: path.join(root, ".opencode/smoke/autopilot-ran.txt"),
        review_path: path.join(root, ".opencode/reviews/review-workflow-e2e-smoke.json"),
        verification_path: path.join(root, ".opencode/verifications/verify-workflow-e2e-smoke.json"),
        archive_path: path.join(root, ".opencode/archives/archive-workflow-e2e-smoke.json"),
        task_graph_path: taskGraphPath,
        ralplan_start: ralplanStart,
        ralplan_status: ralplanStatus,
        ralplan_resume: ralplanResume,
        ralplan_result: ralplanDone,
        review_start: reviewStart,
        review_status: reviewStatus,
        review_result: reviewDone,
        after_ralplan: reviewStart,
        after_review: autopilotStart,
        autopilot_start: autopilotStart,
        autopilot_result: autopilotDone,
        after_autopilot: afterAutopilot,
        verify_result: verifyDone,
        after_verify: afterVerify,
        archive_result: archiveDone,
        errors: result.errors,
      },
      null,
      2
    )
  },
})

export const smoke_ralplan_failure = tool({
  description: "Run deterministic failure-state smoke coverage for ralplan_runtime",
  args: {
    terminal_state: tool.schema.enum(["failed", "expired", "cancelled"] as const),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffRel = ".opencode/handoffs/handoff-ralplan-failure-smoke.json"
    await handoff.execute(
      {
        path: handoffRel,
        workflow_id: `ralplan-failure-${args.terminal_state}`,
        slug: `ralplan-failure-${args.terminal_state}`,
        stage: "deep-interview",
        handoff_status: "ready-for-planning",
        last_transition: "failure smoke initialized",
        runtime_spec_path: `.opencode/specs/deep-interview-ralplan-failure-${args.terminal_state}.md`,
        preferred_next_stage: "ralplan",
        preferred_next_command: `/ralplan ${handoffRel}`,
        review_required_before_execution: true,
        approval_status: "not-reviewed",
        planning_session: null,
        review_session: null,
        execution_session: null,
        execution_scope: [".opencode/"],
      },
      context
    )
    const started = JSON.parse(
      await ralplan_runtime.execute({ operation: "start", handoff_path: handoffRel }, context)
    ) as Record<string, unknown>
    const resumed = JSON.parse(
      await ralplan_runtime.execute({ operation: "resume", handoff_path: handoffRel, phase: "critic" }, context)
    ) as Record<string, unknown>
    const result = JSON.parse(
      await ralplan_runtime.execute(
        { operation: "result", handoff_path: handoffRel, terminal_state: args.terminal_state, summary: `ralplan ${args.terminal_state}` },
        context
      )
    ) as Record<string, unknown>
    const handoffPath = path.join(root, handoffRel)
    const finalHandoff = await readJsonFile<Record<string, unknown>>(handoffPath)
    const finalPlanExists = await textFileExists(path.join(root, `.opencode/plans/consensus-ralplan-failure-${args.terminal_state}.md`))
    const finalTaskGraphExists = await textFileExists(path.join(root, `.opencode/plans/graph-ralplan-failure-${args.terminal_state}.json`))
    const resumeAfterTerminal = JSON.parse(
      await ralplan_runtime.execute({ operation: "resume", handoff_path: handoffRel }, context)
    ) as Record<string, unknown>
    return JSON.stringify(
      {
        ok:
          started.ok === true &&
          resumed.resumed === true &&
          finalHandoff?.handoff_status === "planned" &&
          (finalHandoff?.planning_session as Record<string, unknown> | undefined)?.state === args.terminal_state &&
          finalPlanExists === false &&
          finalTaskGraphExists === false &&
          typeof resumeAfterTerminal.error === "string",
        terminal_state: args.terminal_state,
        started,
        resumed,
        result,
        final_handoff: finalHandoff,
        final_plan_exists: finalPlanExists,
        final_task_graph_exists: finalTaskGraphExists,
        resume_after_terminal: resumeAfterTerminal,
      },
      null,
      2
    )
  },
})

export const smoke_review_failure = tool({
  description: "Run deterministic failure-state smoke coverage for review_bridge_runtime",
  args: {
    terminal_state: tool.schema.enum(["aborted", "expired", "cancelled"] as const).optional(),
  },
  async execute(args, context) {
    const root = baseDir(context)
    const handoffRel = ".opencode/handoffs/handoff-review-failure-smoke.json"
    const reviewRel = ".opencode/reviews/review-review-failure-smoke.json"
    const terminalState = args.terminal_state || "aborted"
    await handoff.execute(
      {
        path: handoffRel,
        workflow_id: "review-failure-smoke",
        slug: "review-failure-smoke",
        stage: "ralplan",
        handoff_status: "review-required",
        last_transition: "failure smoke initialized",
        runtime_spec_path: ".opencode/specs/deep-interview-review-failure-smoke.md",
        consensus_plan_path: ".opencode/plans/consensus-review-failure-smoke.md",
        preferred_next_stage: "review-bridge",
        preferred_next_command: `/review-bridge ${handoffRel}`,
        review_required_before_execution: true,
        approval_status: "not-reviewed",
        planning_session: {
          kind: "planning",
          mode: "sync",
          session_id: "session-planning-review-failure-smoke",
          provider: "opencode",
          state: "completed",
          requested_at: nowIso(),
          started_at: nowIso(),
          last_activity_at: nowIso(),
          expires_at: null,
          resume_command: `/ralplan ${handoffRel}`,
          session_url: null,
          metadata: { phase: "done", consensus_plan_path: ".opencode/plans/consensus-review-failure-smoke.md" },
        },
        review_session: null,
        execution_session: null,
        execution_scope: [".opencode/"],
      },
      context
    )
    await writeTextFile(path.join(root, ".opencode/plans/consensus-review-failure-smoke.md"), "# Review Failure Smoke\n")
    const started = JSON.parse(
      await review_bridge_runtime.execute(
        { operation: "start", handoff_path: handoffRel, review_path: reviewRel, review_target: ".opencode/plans/consensus-review-failure-smoke.md", review_type: "plan" },
        context
      )
    ) as Record<string, unknown>
    const result = JSON.parse(
      await review_bridge_runtime.execute(
        {
          operation: "result",
          handoff_path: handoffRel,
          review_path: reviewRel,
          decision: terminalState,
          review_target: ".opencode/plans/consensus-review-failure-smoke.md",
          review_type: "plan",
          blocking_issues: [`review ${terminalState} in smoke`],
          notes: [`review failure smoke ${terminalState}`],
        },
        context
      )
    ) as Record<string, unknown>
    const validated = JSON.parse(
      await validate.execute({ handoff_path: handoffRel, review_path: reviewRel }, context)
    ) as Record<string, unknown>
    return JSON.stringify(
      {
        ok:
          started.ok === true &&
          validated.ok === true &&
          (result.handoff as Record<string, unknown> | undefined)?.handoff_status === "blocked" &&
          (result.review as Record<string, unknown> | undefined)?.status === terminalState,
        terminal_state: terminalState,
        started,
        result,
        validated,
      },
      null,
      2
    )
  },
})

export const smoke_autopilot_failure = tool({
  description: "Run deterministic failure-state smoke coverage for autopilot_runtime",
  args: {
    terminal_state: tool.schema.enum(["failed", "expired", "cancelled"] as const),
  },
  async execute(args, context) {
    const handoffRel = ".opencode/handoffs/handoff-autopilot-failure-smoke.json"
    await handoff.execute(
      {
        path: handoffRel,
        workflow_id: `autopilot-failure-${args.terminal_state}`,
        slug: `autopilot-failure-${args.terminal_state}`,
        stage: "review-bridge",
        handoff_status: "ready-for-execution",
        last_transition: "failure smoke initialized",
        runtime_spec_path: `.opencode/specs/deep-interview-autopilot-failure-${args.terminal_state}.md`,
        consensus_plan_path: `.opencode/plans/consensus-autopilot-failure-${args.terminal_state}.md`,
        review_path: `.opencode/reviews/review-autopilot-failure-${args.terminal_state}.json`,
        approved_artifact: `.opencode/plans/consensus-autopilot-failure-${args.terminal_state}.md`,
        preferred_next_stage: "autopilot",
        preferred_next_command: `/autopilot ${handoffRel}`,
        review_required_before_execution: true,
        approval_status: "approved",
        planning_session: null,
        review_session: {
          kind: "review",
          mode: "sync",
          session_id: `session-review-autopilot-failure-${args.terminal_state}`,
          provider: "plannotator",
          state: "completed",
          requested_at: nowIso(),
          started_at: nowIso(),
          last_activity_at: nowIso(),
          expires_at: null,
          resume_command: `/review-bridge ${handoffRel}`,
          session_url: null,
          metadata: { review_target: `.opencode/plans/consensus-autopilot-failure-${args.terminal_state}.md` },
        },
        execution_session: null,
        execution_scope: [".opencode/"],
      },
      context
    )
    const started = JSON.parse(
      await autopilot_runtime.execute({ operation: "start", handoff_path: handoffRel }, context)
    ) as Record<string, unknown>
    const resumed = JSON.parse(
      await autopilot_runtime.execute({ operation: "resume", handoff_path: handoffRel, phase: "verifying" }, context)
    ) as Record<string, unknown>
    const result = JSON.parse(
      await autopilot_runtime.execute(
        {
          operation: "result",
          handoff_path: handoffRel,
          terminal_state: args.terminal_state,
          verification_summary: `autopilot ${args.terminal_state}`,
          blocking_reason: `blocking ${args.terminal_state}`,
          result_summary: `execution ${args.terminal_state}`,
        },
        context
      )
    ) as Record<string, unknown>
    const resumeAfterTerminal = JSON.parse(
      await autopilot_runtime.execute({ operation: "resume", handoff_path: handoffRel }, context)
    ) as Record<string, unknown>
    return JSON.stringify(
      {
        ok:
          started.ok === true &&
          resumed.resumed === true &&
          (result.handoff as Record<string, unknown> | undefined)?.handoff_status === "blocked" &&
          typeof resumeAfterTerminal.error === "string",
        terminal_state: args.terminal_state,
        started,
        resumed,
        result,
        resume_after_terminal: resumeAfterTerminal,
      },
      null,
      2
    )
  },
})
