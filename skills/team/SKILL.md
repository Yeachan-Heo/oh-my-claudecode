---
name: team
description: N coordinated agents on shared task list using Claude Code native teams
aliases: [swarm]
---

# Team Skill

Spawn N coordinated agents working on a shared task list using Claude Code's native team tools. Replaces the legacy `/swarm` skill (SQLite-based) with built-in team management, inter-agent messaging, and task dependencies -- no external dependencies required.

`swarm` is the compatibility alias for this canonical skill entrypoint.

## Usage

```
/oh-my-claudecode:team N:agent-type "task description"
/oh-my-claudecode:team "task description"
/oh-my-claudecode:team ralph "task description"
```

### Parameters

- **N** - Number of teammate agents (1-20). Optional; defaults to auto-sizing based on task decomposition.
- **agent-type** - OMC agent to spawn for the `team-exec` stage (e.g., executor, build-fixer, designer). Optional; defaults to stage-aware routing (see Stage Agent Routing below).
- **task** - High-level task to decompose and distribute among teammates
- **ralph** - Optional modifier. When present, wraps the team pipeline in Ralph's persistence loop (retry on failure, architect verification before completion). See Team + Ralph Composition below.

### Examples

```bash
/team 5:executor "fix all TypeScript errors across the project"
/team 3:build-fixer "fix build errors in src/"
/team 4:designer "implement responsive layouts for all page components"
/team "refactor the auth module with security review"
/team ralph "build a complete REST API for user management"
```

## Architecture

```
User: "/team 3:executor fix all TypeScript errors"
              |
              v
      [TEAM ORCHESTRATOR (Lead)]
              |
              +-- TeamCreate("fix-ts-errors")
              |       -> lead becomes team-lead@fix-ts-errors
              |
              +-- Analyze & decompose task into subtasks
              |       -> explore/architect produces subtask list
              |
              +-- TaskCreate x N (one per subtask)
              |       -> tasks #1, #2, #3 with dependencies
              |
              +-- TaskUpdate x N (pre-assign owners)
              |       -> task #1 owner=worker-1, etc.
              |
              +-- Task(team_name="fix-ts-errors", name="worker-1") x 3
              |       -> spawns teammates into the team
              |
              +-- Monitor loop
              |       <- SendMessage from teammates (auto-delivered)
              |       -> TaskList polling for progress
              |       -> SendMessage to unblock/coordinate
              |
              +-- Completion
                      -> SendMessage(shutdown_request) to each teammate
                      <- SendMessage(shutdown_response, approve: true)
                      -> TeamDelete("fix-ts-errors")
                      -> rm .omc/state/team-state.json
```

**Storage layout (managed by Claude Code):**
```
~/.claude/
  teams/fix-ts-errors/
    config.json          # Team metadata + members array
  tasks/fix-ts-errors/
    .lock                # File lock for concurrent access
    1.json               # Subtask #1
    2.json               # Subtask #2 (may be internal)
    3.json               # Subtask #3
    ...
```

## Staged Pipeline (Canonical Team Runtime)

Team execution follows a staged pipeline:

`team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)`

### Stage Agent Routing

Each pipeline stage uses **specialized agents** -- not just executors. The lead selects agents based on the stage and task characteristics.

| Stage | Required Agents | Optional Agents | Selection Criteria |
|-------|----------------|-----------------|-------------------|
| **team-plan** | `explore` (haiku), `planner` (opus) | `analyst` (opus), `architect` (opus) | Use `analyst` for unclear requirements. Use `architect` for systems with complex boundaries. |
| **team-prd** | `analyst` (opus) | `critic` (opus) | Use `critic` to challenge scope. |
| **team-exec** | `executor` (sonnet) | `deep-executor` (opus), `build-fixer` (sonnet), `designer` (sonnet), `writer` (haiku), `test-engineer` (sonnet) | Match agent to subtask type. Use `deep-executor` for complex autonomous work, `designer` for UI, `build-fixer` for compilation issues, `writer` for docs, `test-engineer` for test creation. |
| **team-verify** | `verifier` (sonnet) | `test-engineer` (sonnet), `security-reviewer` (sonnet), `code-reviewer` (opus), `quality-reviewer` (sonnet) | Always run `verifier`. Add `security-reviewer` for auth/crypto changes. Add `code-reviewer` for >20 files or architectural changes. Add `quality-reviewer` (model=haiku) for style/formatting checks. |
| **team-fix** | `executor` (sonnet) | `build-fixer` (sonnet), `debugger` (sonnet), `deep-executor` (opus) | Use `build-fixer` for type/build errors. Use `debugger` for regression isolation. Use `deep-executor` for complex multi-file fixes. |

**Routing rules:**

1. **The lead picks agents per stage, not the user.** The user's `N:agent-type` parameter only overrides the `team-exec` stage worker type. All other stages use stage-appropriate specialists.
2. **MCP providers complement Claude agents.** Route analysis/review to Codex (`ask_codex`) and UI/large-context work to Gemini (`ask_gemini`) when available. MCP workers are one-shot and don't participate in team communication.
3. **Cost mode affects model tier.** In downgrade: `opus` agents to `sonnet`, `sonnet` to `haiku` where quality permits. `team-verify` always uses at least `sonnet`.
4. **Risk level escalates review.** Security-sensitive or >20 file changes must include `security-reviewer` + `code-reviewer` (opus) in `team-verify`.

### Stage Entry/Exit Criteria

- **team-plan**
  - Entry: Team invocation is parsed and orchestration starts.
  - Agents: `explore` scans codebase, `planner` creates task graph, optionally `analyst`/`architect` for complex tasks.
  - Exit: decomposition is complete and a runnable task graph is prepared.
- **team-prd**
  - Entry: scope is ambiguous or acceptance criteria are missing.
  - Agents: `analyst` extracts requirements, optionally `critic`.
  - Exit: acceptance criteria and boundaries are explicit.
- **team-exec**
  - Entry: `TeamCreate`, `TaskCreate`, assignment, and worker spawn are complete.
  - Agents: workers spawned as the appropriate specialist type per subtask (see routing table).
  - Exit: execution tasks reach terminal state for the current pass.
- **team-verify**
  - Entry: execution pass finishes.
  - Agents: `verifier` + task-appropriate reviewers (see routing table).
  - Exit (pass): verification gates pass with no required follow-up.
  - Exit (fail): fix tasks are generated and control moves to `team-fix`.
- **team-fix**
  - Entry: verification found defects/regressions/incomplete criteria.
  - Agents: `executor`/`build-fixer`/`debugger` depending on defect type.
  - Exit: fixes are complete and flow returns to `team-exec` then `team-verify`.

### Verify/Fix Loop and Stop Conditions

Continue `team-exec -> team-verify -> team-fix` until:
1. verification passes and no required fix tasks remain, or
2. work reaches an explicit terminal blocked/failed outcome with evidence.

`team-fix` is bounded by max attempts. If fix attempts exceed the configured limit, transition to terminal `failed` (no infinite loop).

### Stage Handoff Convention

When transitioning between stages, important context — decisions made, alternatives rejected, risks identified — lives only in the lead's conversation history. If the lead's context compacts or agents restart, this knowledge is lost.

**Each completing stage MUST produce a handoff document before transitioning.**

The lead writes handoffs to `.omc/handoffs/<stage-name>.md`.

#### Handoff Format

```markdown
## Handoff: <current-stage> → <next-stage>
- **Decided**: [key decisions made in this stage]
- **Rejected**: [alternatives considered and why they were rejected]
- **Risks**: [identified risks for the next stage]
- **Files**: [key files created or modified]
- **Remaining**: [items left for the next stage to handle]
```

#### Handoff Rules

1. **Lead reads previous handoff BEFORE spawning next stage's agents.** The handoff content is included in the next stage's agent spawn prompts, ensuring agents start with full context.
2. **Handoffs accumulate.** The verify stage can read all prior handoffs (plan → prd → exec) for full decision history.
3. **On team cancellation, handoffs survive** in `.omc/handoffs/` for session resume. They are not deleted by `TeamDelete`.
4. **Handoffs are lightweight.** 10-20 lines max. They capture decisions and rationale, not full specifications (those live in deliverable files like DESIGN.md).

#### Example

```markdown
## Handoff: team-plan → team-exec
- **Decided**: Microservice architecture with 3 services (auth, api, worker). PostgreSQL for persistence. JWT for auth tokens.
- **Rejected**: Monolith (scaling concerns), MongoDB (team expertise is SQL), session cookies (API-first design).
- **Risks**: Worker service needs Redis for job queue — not yet provisioned. Auth service has no rate limiting in initial design.
- **Files**: DESIGN.md, TEST_STRATEGY.md
- **Remaining**: Database migration scripts, CI/CD pipeline config, Redis provisioning.
```

### Resume and Cancel Semantics

- **Resume:** restart from the last non-terminal stage using staged state + live task status. Read `.omc/handoffs/` to recover stage transition context.
- **Cancel:** `/oh-my-claudecode:cancel` requests teammate shutdown, waits for responses (best effort), marks phase `cancelled` with `active=false`, captures cancellation metadata, then deletes team resources and clears/preserves Team state per policy. Handoff files in `.omc/handoffs/` are preserved for potential resume.
- Terminal states are `complete`, `failed`, and `cancelled`.

## Workflow

### Phase 1: Parse Input

- Extract **N** (agent count), validate 1-20
- Extract **agent-type**, validate it maps to a known OMC subagent
- Extract **task** description

### Phase 2: Analyze & Decompose

Use `explore` or `architect` (via MCP or agent) to analyze the codebase and break the task into N subtasks:

- Each subtask should be **file-scoped** or **module-scoped** to avoid conflicts
- Subtasks must be independent or have clear dependency ordering
- Each subtask needs a concise `subject` and detailed `description`
- Identify dependencies between subtasks (e.g., "shared types must be fixed before consumers")

### Phase 3: Create Team

Call `TeamCreate` with a slug derived from the task:

```json
{
  "team_name": "fix-ts-errors",
  "description": "Fix all TypeScript errors across the project"
}
```

**Response:**
```json
{
  "team_name": "fix-ts-errors",
  "team_file_path": "~/.claude/teams/fix-ts-errors/config.json",
  "lead_agent_id": "team-lead@fix-ts-errors"
}
```

The current session becomes the team lead (`team-lead@fix-ts-errors`).

Write OMC state using the `state_write` MCP tool for proper session-scoped persistence:

```
state_write(mode="team", active=true, current_phase="team-plan", state={
  "team_name": "fix-ts-errors",
  "agent_count": 3,
  "agent_types": "executor",
  "task": "fix all TypeScript errors",
  "fix_loop_count": 0,
  "max_fix_loops": 3,
  "linked_ralph": false,
  "stage_history": "team-plan"
})
```

> **Note:** The MCP `state_write` tool transports all values as strings. Consumers must coerce `agent_count`, `fix_loop_count`, `max_fix_loops` to numbers and `linked_ralph` to boolean when reading state.

**State schema fields:**

| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Whether team mode is active |
| `current_phase` | string | Current pipeline stage: `team-plan`, `team-prd`, `team-exec`, `team-verify`, `team-fix` |
| `team_name` | string | Slug name for the team |
| `agent_count` | number | Number of worker agents |
| `agent_types` | string | Comma-separated agent types used in team-exec |
| `task` | string | Original task description |
| `fix_loop_count` | number | Current fix iteration count |
| `max_fix_loops` | number | Maximum fix iterations before failing (default: 3) |
| `linked_ralph` | boolean | Whether team is linked to a ralph persistence loop |
| `stage_history` | string | Comma-separated list of stage transitions with timestamps |

**Update state on every stage transition:**

```
state_write(mode="team", current_phase="team-exec", state={
  "stage_history": "team-plan:2026-02-07T12:00:00Z,team-prd:2026-02-07T12:01:00Z,team-exec:2026-02-07T12:02:00Z"
})
```

**Read state for resume detection:**

```
state_read(mode="team")
```

If `active=true` and `current_phase` is non-terminal, resume from the last incomplete stage instead of creating a new team.

### Phase 4: Create Tasks

Call `TaskCreate` for each subtask. Set dependencies with `TaskUpdate` using `addBlockedBy`.

```json
// TaskCreate for subtask 1
{
  "subject": "Fix type errors in src/auth/",
  "description": "Fix all TypeScript errors in src/auth/login.ts, src/auth/session.ts, and src/auth/types.ts. Run tsc --noEmit to verify.",
  "activeForm": "Fixing auth type errors"
}
```

**Response stores a task file (e.g. `1.json`):**
```json
{
  "id": "1",
  "subject": "Fix type errors in src/auth/",
  "description": "Fix all TypeScript errors in src/auth/login.ts...",
  "activeForm": "Fixing auth type errors",
  "owner": "",
  "status": "pending",
  "blocks": [],
  "blockedBy": []
}
```

For tasks with dependencies, use `TaskUpdate` after creation:

```json
// Task #3 depends on task #1 (shared types must be fixed first)
{
  "taskId": "3",
  "addBlockedBy": ["1"]
}
```

**Pre-assign owners from the lead** to avoid race conditions (there is no atomic claiming):

```json
// Assign task #1 to worker-1
{
  "taskId": "1",
  "owner": "worker-1"
}
```

### Phase 5: Spawn Teammates

Spawn N teammates using `Task` with `team_name` and `name` parameters. Each teammate gets the team worker preamble (see below) plus their specific assignment.

```json
{
  "subagent_type": "oh-my-claudecode:executor",
  "team_name": "fix-ts-errors",
  "name": "worker-1",
  "prompt": "<worker-preamble + assigned tasks>"
}
```

**Response:**
```json
{
  "agent_id": "worker-1@fix-ts-errors",
  "name": "worker-1",
  "team_name": "fix-ts-errors"
}
```

**Side effects:**
- Teammate added to `config.json` members array
- An **internal task** is auto-created (with `metadata._internal: true`) tracking the agent lifecycle
- Internal tasks appear in `TaskList` output -- filter them when counting real tasks

**IMPORTANT:** Spawn all teammates in parallel (they are background agents). Do NOT wait for one to finish before spawning the next.

### Phase 6: Monitor

The lead orchestrator monitors progress through two channels:

1. **Inbound messages** -- Teammates send `SendMessage` to `team-lead` when they complete tasks or need help. These arrive automatically as new conversation turns (no polling needed).

2. **TaskList polling** -- Periodically call `TaskList` to check overall progress:
   ```
   #1 [completed] Fix type errors in src/auth/ (worker-1)
   #3 [in_progress] Fix type errors in src/api/ (worker-2)
   #5 [pending] Fix type errors in src/utils/ (worker-3)
   ```
   Format: `#ID [status] subject (owner)`

**Coordination actions the lead can take:**

- **Unblock a teammate:** Send a `message` with guidance or missing context
- **Reassign work:** If a teammate finishes early, use `TaskUpdate` to assign pending tasks to them and notify via `SendMessage`
- **Handle failures:** If a teammate reports failure, reassign the task or spawn a replacement

#### Task Watchdog Policy

Monitor for stuck or failed teammates:

- **Max in-progress age**: If a task stays `in_progress` for more than 5 minutes without messages, send a status check
- **Suspected dead worker**: No messages + stuck task for 10+ minutes → reassign task to another worker
- **Reassign threshold**: If a worker fails 2+ tasks, stop assigning new tasks to it

### Phase 6.5: Stage Transitions (State Persistence)

On every stage transition, update OMC state:

```
// Entering team-exec after planning
state_write(mode="team", current_phase="team-exec", state={
  "stage_history": "team-plan:T1,team-prd:T2,team-exec:T3"
})

// Entering team-verify after execution
state_write(mode="team", current_phase="team-verify")

// Entering team-fix after verify failure
state_write(mode="team", current_phase="team-fix", state={
  "fix_loop_count": 1
})
```

This enables:
- **Resume**: If the lead crashes, `state_read(mode="team")` reveals the last stage and team name for recovery
- **Cancel**: The cancel skill reads `current_phase` to know what cleanup is needed
- **Ralph integration**: Ralph can read team state to know if the pipeline completed or failed

### Phase 7: Completion

When all real tasks (non-internal) are completed or failed:

1. **Verify results** -- Check that all subtasks are marked `completed` via `TaskList`
2. **Shutdown teammates** -- Send `shutdown_request` to each active teammate:
   ```json
   {
     "type": "shutdown_request",
     "recipient": "worker-1",
     "content": "All work complete, shutting down team"
   }
   ```
3. **Await responses** -- Each teammate responds with `shutdown_response(approve: true)` and terminates
4. **Delete team** -- Call `TeamDelete` to clean up:
   ```json
   { "team_name": "fix-ts-errors" }
   ```
   Response:
   ```json
   {
     "success": true,
     "message": "Cleaned up directories and worktrees for team \"fix-ts-errors\"",
     "team_name": "fix-ts-errors"
   }
   ```
5. **Clean OMC state** -- Remove `.omc/state/team-state.json`
6. **Report summary** -- Present results to the user

## Agent Preamble

When spawning teammates, include this preamble in the prompt to establish the work protocol. Adapt it per teammate with their specific task assignments.

```
You are a TEAM WORKER in team "{team_name}". Your name is "{worker_name}".
You report to the team lead ("team-lead").

== WORK PROTOCOL ==

1. CLAIM: Call TaskList to see your assigned tasks (owner = "{worker_name}").
   Pick the first task with status "pending" that is assigned to you.
   Call TaskUpdate to set status "in_progress":
   {"taskId": "ID", "status": "in_progress", "owner": "{worker_name}"}

2. WORK: Execute the task using your tools (Read, Write, Edit, Bash).
   Do NOT spawn sub-agents. Do NOT delegate. Work directly.

3. COMPLETE: When done, mark the task completed:
   {"taskId": "ID", "status": "completed"}

4. REPORT: Notify the lead via SendMessage:
   {"type": "message", "recipient": "team-lead", "content": "Completed task #ID: <summary of what was done>", "summary": "Task #ID complete"}

5. NEXT: Check TaskList for more assigned tasks. If you have more pending tasks, go to step 1.
   If no more tasks are assigned to you, notify the lead:
   {"type": "message", "recipient": "team-lead", "content": "All assigned tasks complete. Standing by.", "summary": "All tasks done, standing by"}

6. SHUTDOWN: When you receive a shutdown_request, respond with:
   {"type": "shutdown_response", "request_id": "<from the request>", "approve": true}

== BLOCKED TASKS ==
If a task has blockedBy dependencies, skip it until those tasks are completed.
Check TaskList periodically to see if blockers have been resolved.

== ERRORS ==
If you cannot complete a task, report the failure to the lead:
{"type": "message", "recipient": "team-lead", "content": "FAILED task #ID: <reason>", "summary": "Task #ID failed"}
Do NOT mark the task as completed. Leave it in_progress so the lead can reassign.

== RULES ==
- NEVER spawn sub-agents or use the Task tool
- ALWAYS use absolute file paths
- ALWAYS report progress via SendMessage to "team-lead"
- Use SendMessage with type "message" only -- never "broadcast"
```

## Communication Patterns

### Teammate to Lead (task completion report)

```json
{
  "type": "message",
  "recipient": "team-lead",
  "content": "Completed task #1: Fixed 3 type errors in src/auth/login.ts and 2 in src/auth/session.ts. All files pass tsc --noEmit.",
  "summary": "Task #1 complete"
}
```

### Lead to Teammate (reassignment or guidance)

```json
{
  "type": "message",
  "recipient": "worker-2",
  "content": "Task #3 is now unblocked. Also pick up task #5 which was originally assigned to worker-1.",
  "summary": "New task assignment"
}
```

### Broadcast (use sparingly -- sends N separate messages)

```json
{
  "type": "broadcast",
  "content": "STOP: shared types in src/types/index.ts have changed. Pull latest before continuing.",
  "summary": "Shared types changed"
}
```

### Shutdown Protocol (BLOCKING)

**CRITICAL: Steps must execute in exact order. Never call TeamDelete before shutdown is confirmed.**

**Step 1: Verify completion**
```
Call TaskList — verify all real tasks (non-internal) are completed or failed.
```

**Step 2: Request shutdown from each teammate**

**Lead sends:**
```json
{
  "type": "shutdown_request",
  "recipient": "worker-1",
  "content": "All work complete, shutting down team"
}
```

**Step 3: Wait for responses (BLOCKING)**
- Wait up to 30s per teammate for `shutdown_response`
- Track which teammates confirmed vs timed out
- If a teammate doesn't respond within 30s: log warning, mark as unresponsive

**Teammate receives and responds:**
```json
{
  "type": "shutdown_response",
  "request_id": "shutdown-1770428632375@worker-1",
  "approve": true
}
```

After approval:
- Teammate process terminates
- Teammate auto-removed from `config.json` members array
- Internal task for that teammate completes

**Step 4: TeamDelete — only after ALL teammates confirmed or timed out**
```json
{ "team_name": "fix-ts-errors" }
```

**Step 5: Orphan scan**

Check for agent processes that survived TeamDelete:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-orphans.mjs" --team-name fix-ts-errors
```

This scans for processes matching the team name whose config no longer exists, and terminates them (SIGTERM → 5s wait → SIGKILL). Supports `--dry-run` for inspection.

**Shutdown sequence is BLOCKING:** Do not proceed to TeamDelete until all teammates have either:
- Confirmed shutdown (`shutdown_response` with `approve: true`), OR
- Timed out (30s with no response)

**IMPORTANT:** The `request_id` is provided in the shutdown request message that the teammate receives. The teammate must extract it and pass it back. Do NOT fabricate request IDs.

## MCP Workers (Hybrid Roles)

The team skill supports **hybrid execution** combining Claude agent teammates with external MCP workers (Codex and Gemini CLIs). Both types can make code changes -- they differ in capabilities and cost.

### Execution Modes

Tasks are tagged with an execution mode during decomposition:

| Execution Mode | Provider | Capabilities |
|---------------|----------|-------------|
| `claude_worker` | Claude agent | Full Claude Code tool access (Read/Write/Edit/Bash/Task). Best for tasks needing Claude's reasoning + iterative tool use. |
| `mcp_codex` | Codex CLI (`ask_codex`) | Full filesystem access in working_directory. Runs autonomously. Best for code review, security analysis, refactoring, architecture. |
| `mcp_gemini` | Gemini CLI (`ask_gemini`) | Full filesystem access + 1M token context. Runs autonomously. Best for UI/frontend work, large-scale changes, documentation. |

### How MCP Workers Operate

Codex and Gemini CLIs run in full-auto mode with filesystem access. They are **autonomous executors**, not just analysts:

1. Lead writes task instructions to a `prompt_file`
2. Lead calls `ask_codex` or `ask_gemini` with `working_directory` set to the project root
3. The CLI reads files, makes changes, runs commands -- all within the working directory
4. Results/summary are written to `output_file`
5. Lead reads the output, marks the task complete, and feeds results to dependent tasks

**Key difference from Claude teammates:**
- MCP workers operate via CLI, not Claude Code's tool system
- They cannot use TaskList/TaskUpdate/SendMessage (no team awareness)
- They run as one-shot autonomous jobs, not persistent teammates
- The lead manages their lifecycle (spawn, monitor, collect results)

### When to Route Where

| Task Type | Best Route | Why |
|-----------|-----------|-----|
| Iterative multi-step work | Claude teammate | Needs tool-mediated iteration + team communication |
| Code review / security audit | Codex MCP | Specialized, cheaper than Claude opus |
| Architecture analysis / planning | Codex MCP | External perspective, strong analytical reasoning |
| Refactoring (well-scoped) | Codex MCP | Autonomous execution, good at structured transforms |
| UI/frontend implementation | Gemini MCP | 1M context window, design expertise, can edit many files |
| Large-scale documentation | Gemini MCP | Writing expertise + large context for consistency |
| Visual/image analysis | Gemini MCP | Multimodal capability |
| Build/test iteration loops | Claude teammate | Needs Bash tool + iterative fix cycles |
| Tasks needing team coordination | Claude teammate | Needs SendMessage for status updates |

### Example: Hybrid Team with MCP Executors

```
/team 3:executor "refactor auth module with security review"

Task decomposition:
#1 [mcp_codex] Security review of current auth code -> output to .omc/research/auth-security.md
#2 [mcp_codex] Refactor auth/login.ts and auth/session.ts (uses #1 findings)
#3 [mcp_gemini] Redesign auth UI components (login form, session indicator)
#4 [claude_worker] Update auth tests + fix integration issues
#5 [mcp_codex] Final code review of all changes
```

The lead runs #1 (Codex analysis), then #2 and #3 in parallel (Codex refactors backend, Gemini redesigns frontend), then #4 (Claude teammate handles test iteration), then #5 (final Codex review).

### MCP Pre-flight Analysis (Optional)

For large ambiguous tasks, run analysis before team creation:

1. Call `ToolSearch("mcp")` to discover deferred MCP tools (required before first use)
2. Call `ask_codex` (planner role) with task description + codebase context
3. Use the analysis to produce better task decomposition
4. Create team and tasks with enriched context

If ToolSearch finds no MCP tools, skip MCP pre-flight and use Claude agents instead.

This is especially useful when the task scope is unclear and benefits from external reasoning before committing to a specific decomposition.

## Monitor Enhancement: Outbox Auto-Ingestion

The lead can proactively ingest outbox messages from MCP workers using the outbox reader utilities, enabling event-driven monitoring without relying solely on `SendMessage` delivery.

### Outbox Reader Functions

**`readNewOutboxMessages(teamName, workerName)`** -- Read new outbox messages for a single worker using a byte-offset cursor. Each call advances the cursor, so subsequent calls only return messages written since the last read. Mirrors the inbox cursor pattern from `readNewInboxMessages()`.

**`readAllTeamOutboxMessages(teamName)`** -- Read new outbox messages from ALL workers in a team. Returns an array of `{ workerName, messages }` entries, skipping workers with no new messages. Useful for batch polling in the monitor loop.

**`resetOutboxCursor(teamName, workerName)`** -- Reset the outbox cursor for a worker back to byte 0. Useful when re-reading historical messages after a lead restart or for debugging.

### Using `getTeamStatus()` in the Monitor Phase

The `getTeamStatus(teamName, workingDirectory, heartbeatMaxAgeMs?)` function provides a unified snapshot combining:

- **Worker registration** -- Which MCP workers are registered (from shadow registry / config.json)
- **Heartbeat freshness** -- Whether each worker is alive based on heartbeat age
- **Task progress** -- Per-worker and team-wide task counts (pending, in_progress, completed)
- **Current task** -- Which task each worker is actively executing
- **Recent outbox messages** -- New messages since the last status check

Example usage in the monitor loop:

```typescript
const status = getTeamStatus('fix-ts-errors', workingDirectory);

for (const worker of status.workers) {
  if (!worker.isAlive) {
    // Worker is dead -- reassign its in-progress tasks
  }
  for (const msg of worker.recentMessages) {
    if (msg.type === 'task_complete') {
      // Mark task complete, unblock dependents
    } else if (msg.type === 'task_failed') {
      // Handle failure, possibly retry or reassign
    } else if (msg.type === 'error') {
      // Log error, check if worker needs intervention
    }
  }
}

if (status.taskSummary.pending === 0 && status.taskSummary.inProgress === 0) {
  // All work done -- proceed to shutdown
}
```

### Event-Based Actions from Outbox Messages

| Message Type | Action |
|-------------|--------|
| `task_complete` | Mark task completed, check if blocked tasks are now unblocked, notify dependent workers |
| `task_failed` | Increment failure sidecar, decide retry vs reassign vs skip |
| `idle` | Worker has no assigned tasks -- assign pending work or begin shutdown |
| `error` | Log the error, check `consecutiveErrors` in heartbeat for quarantine threshold |
| `shutdown_ack` | Worker acknowledged shutdown -- safe to remove from team |
| `heartbeat` | Update liveness tracking (redundant with heartbeat files but useful for latency monitoring) |

This approach complements the existing `SendMessage`-based communication by providing a pull-based mechanism for MCP workers that cannot use Claude Code's team messaging tools.

## Error Handling

### Teammate Fails a Task

1. Teammate sends `SendMessage` to lead reporting the failure
2. Lead decides: retry (reassign same task to same or different worker) or skip
3. To reassign: `TaskUpdate` to set new owner, then `SendMessage` to the new owner

### Teammate Gets Stuck (No Messages)

1. Lead detects via `TaskList` -- task stuck in `in_progress` for too long
2. Lead sends `SendMessage` to the teammate asking for status
3. If no response, consider the teammate dead
4. Reassign the task to another worker via `TaskUpdate`

### Dependency Blocked

1. If a blocking task fails, the lead must decide whether to:
   - Retry the blocker
   - Remove the dependency (`TaskUpdate` with modified blockedBy)
   - Skip the blocked task entirely
2. Communicate decisions to affected teammates via `SendMessage`

### Teammate Crashes

1. Internal task for that teammate will show unexpected status
2. Teammate disappears from `config.json` members
3. Lead reassigns orphaned tasks to remaining workers
4. If needed, spawn a replacement teammate with `Task(team_name, name)`

## Team + Ralph Composition

When the user invokes `/team ralph`, says "team ralph", or combines both keywords, team mode wraps itself in Ralph's persistence loop. This provides:

- **Team orchestration** -- multi-agent staged pipeline with specialized agents per stage
- **Ralph persistence** -- retry on failure, architect verification before completion, iteration tracking

### Activation

Team+Ralph activates when:
1. User invokes `/team ralph "task"` or `/oh-my-claudecode:team ralph "task"`
2. Keyword detector finds both `team` and `ralph` in the prompt
3. Hook detects `MAGIC KEYWORD: RALPH` alongside team context

### State Linkage

Both modes write their own state files with cross-references:

```
// Team state (via state_write)
state_write(mode="team", active=true, current_phase="team-plan", state={
  "team_name": "build-rest-api",
  "linked_ralph": true,
  "task": "build a complete REST API"
})

// Ralph state (via state_write)
state_write(mode="ralph", active=true, iteration=1, max_iterations=10, current_phase="execution", state={
  "linked_team": true,
  "team_name": "build-rest-api"
})
```

### Execution Flow

1. Ralph outer loop starts (iteration 1)
2. Team pipeline runs: `team-plan -> team-prd -> team-exec -> team-verify`
3. If `team-verify` passes: Ralph runs architect verification (STANDARD tier minimum)
4. If architect approves: both modes complete, run `/oh-my-claudecode:cancel`
5. If `team-verify` fails OR architect rejects: team enters `team-fix`, then loops back to `team-exec -> team-verify`
6. If fix loop exceeds `max_fix_loops`: Ralph increments iteration and retries the full pipeline
7. If Ralph exceeds `max_iterations`: terminal `failed` state

### Cancellation

Cancel either mode cancels both:
- **Cancel Ralph (linked):** Cancel Team first (graceful shutdown), then clear Ralph state
- **Cancel Team (linked):** Clear Team, mark Ralph iteration cancelled, stop loop

See Cancellation section below for details.

## Idempotent Recovery

If the lead crashes mid-run, the team skill should detect existing state and resume:

1. Check `~/.claude/teams/` for teams matching the task slug
2. If found, read `config.json` to discover active members
3. Resume monitor mode instead of creating a duplicate team
4. Call `TaskList` to determine current progress
5. Continue from the monitoring phase

This prevents duplicate teams and allows graceful recovery from lead failures.

## Comparison: Team vs Legacy Swarm

| Aspect | Team (Native) | Swarm (Legacy SQLite) |
|--------|--------------|----------------------|
| **Storage** | JSON files in `~/.claude/teams/` and `~/.claude/tasks/` | SQLite in `.omc/state/swarm.db` |
| **Dependencies** | `better-sqlite3` not needed | Requires `better-sqlite3` npm package |
| **Task claiming** | `TaskUpdate(owner + in_progress)` -- lead pre-assigns | SQLite IMMEDIATE transaction -- atomic |
| **Race conditions** | Possible if two agents claim same task (mitigate by pre-assigning) | None (SQLite transactions) |
| **Communication** | `SendMessage` (DM, broadcast, shutdown) | None (fire-and-forget agents) |
| **Task dependencies** | Built-in `blocks` / `blockedBy` arrays | Not supported |
| **Heartbeat** | Automatic idle notifications from Claude Code | Manual heartbeat table + polling |
| **Shutdown** | Graceful request/response protocol | Signal-based termination |
| **Agent lifecycle** | Auto-tracked via internal tasks + config members | Manual tracking via heartbeat table |
| **Progress visibility** | `TaskList` shows live status with owner | SQL queries on tasks table |
| **Conflict prevention** | Owner field (lead-assigned) | Lease-based claiming with timeout |
| **Crash recovery** | Lead detects via missing messages, reassigns | Auto-release after 5-min lease timeout |
| **State cleanup** | `TeamDelete` removes everything | Manual `rm` of SQLite database |

**When to use Team over Swarm:** Always prefer `/team` for new work. It uses Claude Code's built-in infrastructure, requires no external dependencies, supports inter-agent communication, and has task dependency management.

## Cancellation

The `/oh-my-claudecode:cancel` skill handles team cleanup:

1. Read team state via `state_read(mode="team")` to get `team_name` and `linked_ralph`
2. Send `shutdown_request` to all active teammates (from `config.json` members)
3. Wait for `shutdown_response` from each (15s timeout per member)
4. Call `TeamDelete` to remove team and task directories
5. Clear state via `state_clear(mode="team")`
6. If `linked_ralph` is true, also clear ralph: `state_clear(mode="ralph")`

### Linked Mode Cancellation (Team + Ralph)

When team is linked to ralph, cancellation follows dependency order:

- **Cancel triggered from Ralph context:** Cancel Team first (graceful shutdown of all teammates), then clear Ralph state. This ensures workers are stopped before the persistence loop exits.
- **Cancel triggered from Team context:** Clear Team state, then mark Ralph as cancelled. Ralph's stop hook will detect the missing team and stop iterating.
- **Force cancel (`--force`):** Clears both `team` and `ralph` state unconditionally via `state_clear`.

If teammates are unresponsive, `TeamDelete` may fail. In that case, the cancel skill should wait briefly and retry, or inform the user to manually clean up `~/.claude/teams/{team_name}/` and `~/.claude/tasks/{team_name}/`.

## Configuration

Optional settings via `.omc-config.json`:

```json
{
  "team": {
    "maxAgents": 20,
    "defaultAgentType": "executor",
    "monitorIntervalMs": 30000,
    "shutdownTimeoutMs": 15000
  }
}
```

- **maxAgents** - Maximum teammates (default: 20)
- **defaultAgentType** - Agent type when not specified (default: `executor`)
- **monitorIntervalMs** - How often to poll `TaskList` (default: 30s)
- **shutdownTimeoutMs** - How long to wait for shutdown responses (default: 15s)

> **Note:** Team members do not have a hardcoded model default. Each teammate is a separate Claude Code session that inherits the user's configured model. Since teammates can spawn their own subagents, the session model acts as the orchestration layer while subagents can use any model tier.

## State Cleanup

On successful completion:

1. `TeamDelete` handles all Claude Code state:
   - Removes `~/.claude/teams/{team_name}/` (config)
   - Removes `~/.claude/tasks/{team_name}/` (all task files + lock)
2. OMC state cleanup via MCP tools:
   ```
   state_clear(mode="team")
   ```
   If linked to Ralph:
   ```
   state_clear(mode="ralph")
   ```
3. Or run `/oh-my-claudecode:cancel` which handles all cleanup automatically.

**IMPORTANT:** Call `TeamDelete` only AFTER all teammates have been shut down. `TeamDelete` will fail if active members (besides the lead) still exist in the config.

## Git Worktree Integration

MCP workers can operate in isolated git worktrees to prevent file conflicts between concurrent workers.

### How It Works

1. **Worktree creation**: Before spawning a worker, call `createWorkerWorktree(teamName, workerName, repoRoot)` to create an isolated worktree at `.omc/worktrees/{team}/{worker}` with branch `omc-team/{teamName}/{workerName}`.

2. **Worker isolation**: Pass the worktree path as the `workingDirectory` in the worker's `BridgeConfig`. The worker operates exclusively in its own worktree.

3. **Merge coordination**: After a worker completes its tasks, use `checkMergeConflicts()` to verify the branch can be cleanly merged, then `mergeWorkerBranch()` to merge with `--no-ff` for clear history.

4. **Team cleanup**: On team shutdown, call `cleanupTeamWorktrees(teamName, repoRoot)` to remove all worktrees and their branches.

### API Reference

| Function | Description |
|----------|-------------|
| `createWorkerWorktree(teamName, workerName, repoRoot, baseBranch?)` | Create isolated worktree |
| `removeWorkerWorktree(teamName, workerName, repoRoot)` | Remove worktree and branch |
| `listTeamWorktrees(teamName, repoRoot)` | List all team worktrees |
| `cleanupTeamWorktrees(teamName, repoRoot)` | Remove all team worktrees |
| `checkMergeConflicts(workerBranch, baseBranch, repoRoot)` | Non-destructive conflict check |
| `mergeWorkerBranch(workerBranch, baseBranch, repoRoot)` | Merge worker branch (--no-ff) |
| `mergeAllWorkerBranches(teamName, repoRoot, baseBranch?)` | Merge all completed workers |

### Important Notes

- `createSession()` in `tmux-session.ts` does NOT handle worktree creation — worktree lifecycle is managed separately via `git-worktree.ts`
- Worktrees are NOT cleaned up on individual worker shutdown — only on team shutdown, to allow post-mortem inspection
- Branch names are sanitized via `sanitizeName()` to prevent injection
- All paths are validated against directory traversal

## Gotchas

1. **Internal tasks pollute TaskList** -- When a teammate is spawned, the system auto-creates an internal task with `metadata._internal: true`. These appear in `TaskList` output. Filter them when counting real task progress. The subject of an internal task is the teammate's name.

2. **No atomic claiming** -- Unlike SQLite swarm, there is no transactional guarantee on `TaskUpdate`. Two teammates could race to claim the same task. **Mitigation:** The lead should pre-assign owners via `TaskUpdate(taskId, owner)` before spawning teammates. Teammates should only work on tasks assigned to them.

3. **Task IDs are strings** -- IDs are auto-incrementing strings ("1", "2", "3"), not integers. Always pass string values to `taskId` fields.

4. **TeamDelete requires empty team** -- All teammates must be shut down before calling `TeamDelete`. The lead (the only remaining member) is excluded from this check.

5. **Messages are auto-delivered** -- Teammate messages arrive to the lead as new conversation turns. No polling or inbox-checking is needed for inbound messages. However, if the lead is mid-turn (processing), messages queue and deliver when the turn ends.

6. **Teammate prompt stored in config** -- The full prompt text is stored in `config.json` members array. Do not put secrets or sensitive data in teammate prompts.

7. **Members auto-removed on shutdown** -- After a teammate approves shutdown and terminates, it is automatically removed from `config.json`. Do not re-read config expecting to find shut-down teammates.

8. **shutdown_response needs request_id** -- The teammate must extract the `request_id` from the incoming shutdown request JSON and pass it back. The format is `shutdown-{timestamp}@{worker-name}`. Fabricating this ID will cause the shutdown to fail silently.

9. **Team name must be a valid slug** -- Use lowercase letters, numbers, and hyphens. Derive from the task description (e.g., "fix TypeScript errors" becomes "fix-ts-errors").

10. **Broadcast is expensive** -- Each broadcast sends a separate message to every teammate. Use `message` (DM) by default. Only broadcast for truly team-wide critical alerts.

11. **MCP workers are one-shot, not persistent** -- Codex and Gemini CLIs have full filesystem access and CAN make code changes. However, they run as autonomous one-shot jobs -- they cannot use TaskList/TaskUpdate/SendMessage. The lead must manage their lifecycle: write prompt_file, call MCP, read output_file, mark task complete. They don't participate in team communication like Claude teammates do.
