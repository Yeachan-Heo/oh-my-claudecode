---
description: N coordinated agents on shared task list using Claude Code native teams
aliases: [team-agents, team-mode]
---

# Team Command

[TEAM MODE ACTIVATED]

Spawn N coordinated agents working on a shared task list using Claude Code's native TeamCreate, SendMessage, and TaskCreate tools. Like a dev team with real-time communication—fast, reliable, and with built-in coordination.

## User's Request

{{ARGUMENTS}}

## Usage Patterns

### Standard Mode (1-5 agents)
```
/oh-my-claudecode:team N:agent-type "task description"
```

### Parameters

- **N** - Number of agents (1-5, Claude Code background task limit)
- **agent-type** - Agent to spawn (e.g., executor, build-fixer, architect)
- **task** - High-level task to decompose and distribute

### Examples

```bash
/oh-my-claudecode:team 5:executor "fix all TypeScript errors"
/oh-my-claudecode:team 3:build-fixer "fix build errors in src/"
/oh-my-claudecode:team 4:designer "implement responsive layouts for all components"
/oh-my-claudecode:team 2:architect "analyze and document all API endpoints"
```

## Architecture

```
User: "/team 5:executor fix all TypeScript errors"
              |
              v
      [TEAM ORCHESTRATOR]
              |
     TeamCreate("fix-ts-errors")
              |
    TaskCreate × N (one per subtask)
              |
   Task(team_name) × 5
              |
   +--+--+--+--+--+
   |  |  |  |  |
   v  v  v  v  v
  T1 T2 T3 T4 T5   ← teammates
   |  |  |  |  |
   TaskList → claim → work → complete
   |  |  |  |  |
   SendMessage → team lead
```

**Key Features:**
- Native Claude Code team tools (TeamCreate/SendMessage/TaskCreate)
- Real-time inter-agent messaging (DMs and broadcasts)
- Built-in task dependencies (blocks/blockedBy)
- Graceful shutdown protocol
- Zero external dependencies (no SQLite needed)

## ENFORCEMENT (CRITICAL - HARD RULES)

### Mandatory Tool Sequence

**EVERY TEAM MODE SESSION MUST FOLLOW THIS EXACT SEQUENCE:**

1. **TeamCreate()** - MUST be called FIRST before any Task agents
2. **TaskCreate() × N** - Create all subtasks on the shared task list
3. **Task(team_name=..., name=...) × N** - Spawn teammates WITH both team_name and name parameters
4. **Monitor** - Track progress via TaskList + receive automatic SendMessage from teammates
5. **SendMessage(type="shutdown_request") × N** - Graceful shutdown each teammate
6. **TeamDelete()** - Clean up team resources

**SKIPPING ANY STEP = NOT TEAM MODE.**

### ANTI-PATTERNS (NEVER DO THIS)

❌ **Launching Task agents without calling TeamCreate first**
   - If you skip TeamCreate, you're doing ultrawork, NOT team mode

❌ **Using run_in_background without team_name parameter**
   - That's parallel ultrawork, not team coordination

❌ **Skipping TaskCreate and having agents self-organize**
   - Defeats the purpose of shared task list coordination

❌ **Skipping shutdown_request / TeamDelete cleanup**
   - Leaves zombie team state and orphaned task lists

❌ **Using Task tool without the `name` parameter**
   - Teammates need names for messaging - name identifies them in SendMessage

❌ **Spawning agents then claiming "team mode complete" without cleanup**
   - You MUST call SendMessage(shutdown_request) and TeamDelete

### Mode Distinction

```
┌─────────────────────────────────────────────────────────────┐
│ TEAM MODE = TeamCreate + TaskCreate + Task(team_name, name) │
│           + SendMessage + TeamDelete                         │
│                                                              │
│ ULTRAWORK = Task(run_in_background) without team infra      │
│                                                              │
│ If you skip TeamCreate, you are doing ULTRAWORK, NOT TEAM.  │
└─────────────────────────────────────────────────────────────┘
```

### Tool Call Requirements

**Task tool for teammates MUST include:**
- `team_name` - Links agent to team's shared task list
- `name` - Identifies agent for messaging (e.g., "agent-1", "executor-2", "fixer-a")

**Example:**
```typescript
Task(
  subagent_type="oh-my-claudecode:executor",
  team_name="fix-issues",
  name="agent-1",
  prompt="Fix TypeScript errors in src/commands/"
)
```

## Verification Gate

**Before claiming team mode is complete, verify ALL of:**

1. ✅ TeamCreate was called (team config exists at `~/.claude/teams/{team-name}/config.json`)
2. ✅ All TaskCreate tasks show `status=completed` in TaskList
3. ✅ All teammates received `shutdown_request` via SendMessage
4. ✅ TeamDelete was called to clean up team resources

**If ANY verification fails → CONTINUE WORKING until all pass.**

## Staged Pipeline (Canonical Team Runtime)

Team mode runs as a staged pipeline:

`team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)`

### Stage Entry/Exit Criteria

1. **team-plan**
   - **Entry:** `/oh-my-claudecode:team ...` is invoked and orchestration begins.
   - **Exit:** task decomposition is complete, team slug is chosen, and an execution-ready task graph is defined.

2. **team-prd**
   - **Entry:** request is broad/ambiguous or needs explicit acceptance criteria before execution.
   - **Exit:** scope, acceptance criteria, and task boundaries are explicit enough for deterministic execution.

3. **team-exec**
   - **Entry:** `TeamCreate` is complete, tasks are created/assigned, workers are spawned.
   - **Exit:** all non-internal tasks reach terminal status (`completed` or explicitly failed/blocked for handoff).

4. **team-verify**
   - **Entry:** execution reaches a terminal pass for current task set.
   - **Exit (pass):** verification gates pass (task outcomes, checks/tests required by scope, no unresolved blockers).
   - **Exit (fail):** verifier emits fix tasks and transitions to `team-fix`.

5. **team-fix (loop)**
   - **Entry:** `team-verify` identifies defects, regressions, or incomplete acceptance criteria.
   - **Exit:** fix tasks complete, then return to `team-exec` and re-enter `team-verify`.

### Verify/Fix Loop Policy

- Continue looping `team-exec -> team-verify -> team-fix` until either:
  1. verification passes with no required follow-up work, or
  2. work reaches an explicit terminal blocked/failed outcome with evidence.
- `team-fix` is bounded by a max-attempt policy; if fix attempts exceed the configured bound, transition to terminal `failed` (no infinite loop).
- Do not report completion while required fixes remain pending.

### Resume Semantics

- On restart, Team mode should detect existing team state and resume from the last incomplete stage.
- Resume source of truth is the staged state file plus current task reality (`TaskList` statuses, active members, pending fix tasks).
- If execution finished but verification is incomplete, resume at `team-verify`.
- If verification failed and fixes exist, resume at `team-fix`.

### Cancel Behavior

`/oh-my-claudecode:cancel` during Team mode should:

1. send `shutdown_request` to active teammates,
2. wait for `shutdown_response` (best effort within timeout policy),
3. set staged phase to `cancelled`, `active=false`, and capture cancellation metadata,
4. run `TeamDelete` to remove team/task infrastructure,
5. clear Team staged state files (or preserve resumable metadata when configured).

Cancellation is a terminal state (`cancelled`) and stops further stage transitions.

## Workflow

### 1. Parse Input

From `{{ARGUMENTS}}`, extract:
- N (agent count, validate <= 5)
- agent-type (executor, build-fixer, etc.)
- task description

### 2. Analyze & Decompose Task
- Explore codebase to understand scope
- Break into N independent subtasks
- Identify file ownership per subtask

### 3. Create Team & Tasks
- TeamCreate with descriptive name
- TaskCreate for each subtask (with dependencies if needed)

### 4. Spawn Teammates
- Launch N agents via Task tool with BOTH `team_name` AND `name` parameters
- Each teammate: TaskList → claim → work → complete → report

**Example:**
```typescript
Task(
  subagent_type="oh-my-claudecode:executor",
  team_name="fix-issues",
  name="agent-1",
  prompt="Fix TypeScript errors in src/commands/"
)
```

### 5. Monitor & Coordinate
- Track progress via TaskList
- Receive automatic messages from teammates
- Send guidance/coordination messages as needed

### 6. Completion & Cleanup
- Verify all tasks completed
- SendMessage(shutdown_request) to each teammate
- TeamDelete to clean up

## Cancellation

Use unified cancel command:
```
/oh-my-claudecode:cancel
```

## Output

Report when complete:
- Total tasks completed
- Tasks per agent
- Total time elapsed
- Summary of changes made
