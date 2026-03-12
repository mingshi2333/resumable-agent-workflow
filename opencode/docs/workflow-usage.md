# Workflow 使用手册

这套 workflow 是“全局命令/skill/runtime + 项目本地 artifact”的结构：

- 全局部分放在当前配置目录：
  - `command/*.md`
  - `tools/workflow.ts`
  - `~/.claude/skills/*`
- 项目本地产物写在你当前打开的项目目录：
  - `.opencode/`
  - `openspec/`（如果项目启用了 OpenSpec）

其中 `.opencode/` 现在是默认的本地 durable store policy，不再被视为唯一可能的持久化后端。

也就是说：

```text
配置和运行时 = 全局复用
spec / handoff / review / execution artifact = 当前项目本地
```

## 1. 在其他项目里怎么启动

进入你的目标项目目录后启动 `opencode`：

```bash
cd /path/to/your/project
opencode
```

然后先初始化 workflow 目录：

```text
/workflow-init
```

这会在当前项目里准备：

```text
.opencode/specs/
.opencode/plans/
.opencode/executions/
.opencode/executions/results/
.opencode/handoffs/
.opencode/reviews/
.opencode/verifications/
.opencode/archives/
.opencode/state/
.opencode/sessions/
```

初始化后先做一次健康检查：

```text
/workflow-check
/workflow-check summary
```

## 2. 最常见的完整流程

### 需求还模糊

```text
/deep-interview "我要做一个 XXX 功能"
```

正常会自动往下走：

```text
deep-interview
-> handoff
-> ralplan
-> review-bridge
-> autopilot
-> workflow-verify
-> workflow-archive
```

### 新需求先走 startup lane

如果你想要更像 agent-team-lite 的启动体验，可以直接用：

```text
/workflow-start "我要做一个新的 XXX 能力"
```

正常路径会变成：

```text
workflow-start
-> startup exploration
-> startup brief
-> awaiting-confirmation
-> deep-interview / ralplan / autopilot
```

这里的关键点不是“立刻进下一阶段”，而是先自动做一次启动期探索，然后只给用户看一份整合后的 startup summary，再等待确认。

### 已经有明确的 plan / approved review

直接执行：

```text
/autopilot
```

它会自动从当前项目推断执行输入，优先级是：

1. 最新 approved `.opencode/reviews/review-*.json`
2. 最新 `.opencode/handoffs/handoff-*.json`
3. 最新 `.opencode/plans/consensus-*.md`
4. 当前 OpenSpec change
5. 最新 `.opencode/specs/*.md`

### 想只出计划

```text
/ralplan
```

### 想只做 review gate

```text
/review-bridge
```

## 3. 这套 workflow 在项目里会生成什么

### Runtime artifact

都写在当前项目自己的 `.opencode/` 下：

```text
.opencode/specs/       # deep-interview / runtime spec
.opencode/plans/       # consensus plan / graph
.opencode/executions/  # dispatch artifact
.opencode/executions/results/  # per-request result artifacts
.opencode/handoffs/    # workflow handoff state
.opencode/reviews/     # review disposition
.opencode/verifications/ # post-execution verification
.opencode/archives/    # final closure / archive records
.opencode/context/     # sealed phase context packets for delegated specialists
.opencode/state/       # startup brief / deep-interview / session scratch state
.opencode/sessions/    # session snapshots if needed
```

其中 startup lane 会新增一个核心产物：

```text
.opencode/state/startup-<slug>.json
```

它保存的是启动期 summary，而不是仅仅一个临时标记。P0 里至少会记录：

- `status=classified|awaiting-confirmation|confirmed|cancelled`
- `startup_brief.goal_summary`
- `startup_brief.codebase_context[]`
- `startup_brief.likely_file_targets[]`
- `startup_brief.risks[]`
- `startup_brief.recommended_next_stage`
- `confirmation.*`
- `resume.handoff_path`
- `resume.next_command_on_confirm`
- `resume.summary_source`

配对的 `.opencode/handoffs/handoff-<slug>.json` 会补一个 `startup_state_path`，这样 handoff 仍然是路由真相，startup state 负责保存完整 startup brief。

### OpenSpec artifact

如果项目里有 `openspec/AGENTS.md`，则还会写：

```text
openspec/changes/<change-id>/
```

## 4. `tools/workflow.ts` 到底是什么

它不是“只是做约束”的文件。

更准确地说，它是这套 workflow 的运行时控制面（runtime control plane）。

它负责的事情包括：

- 统一 handoff / review / execution 的 artifact 结构
- 创建和恢复 workflow session
- 驱动 `deep-interview -> ralplan -> review-bridge -> autopilot` 的状态转换
- 做 workflow validate / smoke / health check
- 生成 planning DAG、dispatch plan、dispatch requests
- 记录 subagent dispatch claim/result/reconcile metadata
- 保存 startup lane 的 brief、confirmation 状态和 continuation metadata

你可以把它理解成：

```text
command/*.md = 命令入口和协议
skills/*     = agent 行为与推理协议
tools/workflow.ts = 真正的 runtime / 状态机 / artifact control plane
```

所以它的作用不是“只约束模型怎么做”，而是：

- 定义这套 workflow 的真实状态机
- 决定 artifact 怎么写
- 决定 session 怎么继续
- 决定 execution dispatch 怎么 claim / result / reconcile
- 决定 startup lane 怎么暂停、确认、恢复

如果没有 `tools/workflow.ts`，命令和 skill 仍然能说“应该怎么做”，但不会有现在这么强的：

- 可恢复
- 可校验
- 可审计
- 可继续执行
- 可落盘的控制面

## 5. 新项目推荐用法

进入项目后建议这样开始：

```text
/workflow-init
/workflow-check summary
/deep-interview "我要做一个最小但真实的 XXX 功能"
```

如果你已经知道需求很明确，也可以直接：

```text
/ralplan
```

然后自动走 review / execution。

如果你希望先自动探索一下代码和风险，再决定是否继续，优先用：

```text
/workflow-start "我要做一个新的 XXX 能力"
```

这样中间会有一个明确的 confirmation checkpoint，而不是一开始就把用户直接推入 planning。

## 6. 什么时候要重启客户端

如果你刚更新过这些文件：

- `command/*.md`
- `tools/workflow.ts`
- `~/.claude/skills/*`

建议重启一次 `opencode`，这样命令入口和 skill 文本一定会刷新。

## 7. 当前这套 workflow 已经具备什么

当前已具备：

- startup lane artifact contract（`startup-<slug>.json` + `startup_state_path`）
- sync-first planning / review / execution
- thin orchestrator + specialist-first phase packets
- explicit verify / archive closure stages after execution
- local reviewer-subagent review gate
- planning DAG artifact
- execution dispatch artifact
- stage context packet artifact
- dispatch claim / result / reconcile metadata
- parallel batch advancement smoke

## 8. startup lane 里的角色分工

startup lane 的目标不是复制一个全新的系统，而是在当前 runtime 里把启动阶段分工清楚：

- orchestrator：负责 request 分类、artifact 写入、startup summary 汇总、confirmation checkpoint、后续路由
- explorer：负责本地代码和 OpenSpec 上下文探索
- mapper：负责把用户目标映射到现有 workflow seam、命令入口、artifact contract、可能改动文件
- planner bridge：把已确认的 startup brief 无缝交给 `deep-interview`、`ralplan` 或直接执行路径

也就是说，主会话在 startup 阶段更像 coordinator，而不是把所有分析都 inline 做完。

## 8.5 stage delegate contract

为了把 orchestrator 和 specialist 的边界写进 artifact，现在 planning / review / execution 会带一层 delegate contract 元数据：

- planning session: `planning-orchestrator:runtime` -> `planner:background`
- review session: `review-orchestrator:runtime` -> `reviewer:oracle`
- execution session: `execution-orchestrator:runtime`
- verification session: `verification-orchestrator:runtime` -> `verifier:oracle`
- archive session: `archive-orchestrator:runtime` -> `archiver:general`
- execution dispatch request: 根据任务内容落到 `explorer` / `analyst` / `implementer` / `verifier` / `archiver`

这些 metadata 的目的不是炫技，而是把三件事固定下来：

- 当前阶段到底是薄 orchestrator 还是 specialist
- 这段工作是否要求 fresh-context 执行
- 结果最少必须回写哪些 envelope 字段，才能继续 reconcile / validate / resume

## 8.6 hybrid artifact boundary

`ralplan -> review-bridge` 这条边现在支持一个更轻的 hybrid artifact policy：

- planning 过程里的 draft 不再默认落成长期 durable `consensus-*.md`
- review 过程里的中间往返不要求形成 durable review artifact
- 仍然保留最终 `consensus-plan`
- 仍然保留最终 `review decision`
- 仍然保留最终 task graph，作为下游 execution 的兼容产物

也就是说，这条边的“恢复真相”现在更偏向：

```text
handoff + final consensus-plan + final review decision + final graph
```

而不是依赖 planning / review 的每一步中间产物都长期保留。

## 9. confirmation checkpoint 为什么重要

startup lane 的 checkpoint 在 P0 是硬要求：

- 自动探索先发生
- 给用户的是一份合成后的 summary，不是原始搜索噪音
- workflow 在 `awaiting-confirmation` 暂停
- 只有用户确认后，才进入 `deep-interview` / `ralplan` / `autopilot`
- 如果中断，恢复时直接读取保存好的 startup state，而不是重做整段启动分析

也就是说，在新项目里，它已经不是“只有 prompt 约定”，而是一套真实可落盘、可验证、可恢复的 workflow runtime。
