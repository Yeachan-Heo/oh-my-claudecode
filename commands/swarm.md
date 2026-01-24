---
description: N coordinated agents with atomic task claiming from shared pool
aliases: [swarm-agents]
---

# Swarm Command

[SWARM MODE ACTIVATED]

Spawn N coordinated agents working on a shared task list with atomic claiming. Like a dev team tackling multiple files in parallel.

## User's Request

{{ARGUMENTS}}

## Usage Pattern

```
/oh-my-claudecode:swarm N:agent-type "task description"
```

### Parameters

- **N** - Number of agents (1-5, enforced by Claude Code limit)
- **agent-type** - Agent to spawn (executor, build-fixer, designer, etc.)
- **task** - High-level task to decompose and distribute

### Examples

```
/oh-my-claudecode:swarm 5:executor "fix all TypeScript errors"
/oh-my-claudecode:swarm 3:build-fixer "fix build errors in src/"
/oh-my-claudecode:swarm 4:designer "implement responsive layouts for all components"
/oh-my-claudecode:swarm 2:architect "analyze and document all API endpoints"
```

## How It Works

```
User: /swarm 5:executor "fix all TypeScript errors"
              |
              v
      [SWARM ORCHESTRATOR]
              |
   +--+--+--+--+--+
   |  |  |  |  |
   v  v  v  v  v
  E1 E2 E3 E4 E5
   |  |  |  |  |
   +--+--+--+--+
          |
          v
   [SHARED TASK LIST]
   - Fix a.ts (claimed E1)
   - Fix b.ts (done E2)
   - Fix c.ts (claimed E3)
   - Fix d.ts (pending)
   ...
```

## Workflow

### 1. Parse Input

From `{{ARGUMENTS}}`, extract:
- N (agent count, validate <= 5)
- agent-type (executor, build-fixer, etc.)
- task description

### 2. Create Task List

1. Analyze codebase based on task
2. Break into file-specific subtasks
3. Initialize `.omc/state/swarm-tasks.json` with all subtasks
4. Each task gets: id, file, description, status, owner, timestamp

### 3. Spawn Agents

Launch N agents via Task tool:
- Set `run_in_background: true` for all
- Each agent receives:
  - Reference to shared task list
  - Claiming protocol instructions
  - Completion criteria

### 4. Task Claiming Protocol

Each agent follows this loop:

```
LOOP:
  1. Read swarm-tasks.json
  2. Find first task with status="pending"
  3. Atomically claim task (set status="claimed", add owner, timestamp)
  4. Execute task
  5. Mark task as "done"
  6. GOTO LOOP (until no pending tasks)
```

**Atomic Claiming:**
- Read current task status
- If "pending", claim it (set owner, timeout)
- If already claimed, try next task
- Timeout: 5 minutes per task
- Timed-out tasks auto-release to "pending"

### 5. Progress Tracking

Orchestrator monitors via TaskOutput:
- Shows live stats: claimed/done/pending counts
- Reports which agent is working on which file
- Detects idle agents (no pending tasks)

### 6. Completion

Exit when:
- All tasks marked "done"
- All agents idle (no pending tasks)
- User cancels via `/cancel`

## State Files

### `.omc/swarm-state.json`
Session-level state:

```json
{
  "session_id": "swarm-20260124-143022",
  "agent_count": 5,
  "agent_type": "executor",
  "task_description": "fix all TypeScript errors",
  "status": "active",
  "started_at": "2026-01-24T14:30:22Z",
  "agents": [
    {"id": "agent-1", "background_task_id": "task_abc", "status": "working"},
    {"id": "agent-2", "background_task_id": "task_def", "status": "working"}
  ]
}
```

### `.omc/state/swarm-tasks.json`
Shared task list:

```json
{
  "tasks": [
    {
      "id": "task-001",
      "file": "src/utils/validation.ts",
      "description": "Fix type errors in validation helpers",
      "status": "claimed",
      "owner": "agent-1",
      "claimed_at": "2026-01-24T14:30:25Z",
      "timeout_at": "2026-01-24T14:35:25Z"
    },
    {
      "id": "task-002",
      "file": "src/components/Header.tsx",
      "description": "Fix missing prop types",
      "status": "done",
      "owner": "agent-2",
      "claimed_at": "2026-01-24T14:30:26Z",
      "completed_at": "2026-01-24T14:32:15Z"
    },
    {
      "id": "task-003",
      "file": "src/api/client.ts",
      "description": "Add return type annotations",
      "status": "pending",
      "owner": null
    }
  ],
  "stats": {
    "total": 15,
    "pending": 8,
    "claimed": 5,
    "done": 2
  }
}
```

## Agent Instructions Template

Each spawned agent receives:

```markdown
You are agent {id} in a swarm of {N} {agent-type} agents.

**Your Task:** {task_description}

**Shared Task List:** .omc/state/swarm-tasks.json

**Your Loop:**
1. Read swarm-tasks.json
2. Find first task with status="pending"
3. Claim it atomically (set status="claimed", owner="{id}", timeout)
4. Execute the task
5. Mark status="done", set completed_at
6. Repeat until no pending tasks

**Claiming Protocol:**
- Read file, check status="pending"
- Update status="claimed", add your ID
- Set timeout_at = now + 5 minutes
- Write file back
- If file changed between read/write, retry

**Completion:**
When no pending tasks remain, exit cleanly.
```

## Constraints

- **Max Agents:** 5 (Claude Code background task limit)
- **Claim Timeout:** 5 minutes per task
- **Auto-Release:** Timed-out claims automatically released
- **Heartbeat:** Recommended every 60 seconds

## Error Handling

- **Agent Crash:** Task auto-releases after timeout
- **State Corruption:** Orchestrator validates and repairs
- **No Pending Tasks:** Agent exits cleanly
- **All Agents Idle:** Orchestrator concludes session

## Cancellation

Use unified cancel command:
```
/oh-my-claudecode:cancel
```

This:
- Stops orchestrator monitoring
- Signals all background agents to exit
- Preserves partial progress in swarm-tasks.json
- Marks session as "cancelled"

## Use Cases

### Fix All Type Errors
```
/swarm 5:executor "fix all TypeScript type errors"
```
Spawns 5 executors, each claiming and fixing individual files.

### Implement UI Components
```
/swarm 3:designer "implement Material-UI styling for all components"
```
Spawns 3 designers, each styling different component files.

### Security Audit
```
/swarm 4:security-reviewer "review all API endpoints for vulnerabilities"
```
Spawns 4 security reviewers, each auditing different endpoints.

### Documentation Sprint
```
/swarm 2:writer "add JSDoc comments to all exported functions"
```
Spawns 2 writers, each documenting different modules.

## Benefits

- **Parallel Execution:** N agents work simultaneously
- **Auto-Balancing:** Fast agents claim more tasks
- **Fault Tolerance:** Timeouts prevent deadlocks
- **Progress Visibility:** Live stats on claimed/done/pending
- **Scalable:** Works for 10s to 100s of subtasks

## Output

Report when complete:
- Total tasks completed
- Tasks per agent (performance comparison)
- Total time elapsed
- Final verification status
- Summary of changes made
