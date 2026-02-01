---
name: swarm
description: N coordinated agents on shared task list with SQLite-based atomic claiming
---

# Swarm Skill

Spawn N coordinated agents working on a shared task list with SQLite-based atomic claiming. Like a dev team tackling multiple files in parallel—fast, reliable, and with full fault tolerance.

## Usage

```
/swarm N "task description"
```

### Parameters

- **N** - Number of agents (1-5, enforced by Claude Code limit)
- **task** - High-level task to decompose and distribute

### Examples

```bash
/swarm 5 "fix all TypeScript errors"
/swarm 3 "fix build errors in src/"
/swarm 4 "implement responsive layouts for all components"
/swarm 2 "analyze and document all API endpoints"
```

## Architecture

```
User: "/swarm 5 fix all TypeScript errors"
              |
              v
      [SWARM ORCHESTRATOR]
              |
   +--+--+--+--+--+
   |  |  |  |  |
   v  v  v  v  v
  A1 A2 A3 A4 A5
   |  |  |  |  |
   +--+--+--+--+
          |
          v
    [SQLITE DATABASE]
    ┌─────────────────────┐
    │ tasks table         │
    ├─────────────────────┤
    │ id, description     │
    │ status (pending,    │
    │   claimed, done,    │
    │   failed)           │
    │ claimed_by, claimed_at
    │ completed_at, result│
    │ error               │
    ├─────────────────────┤
    │ heartbeats table    │
    │ (agent monitoring)  │
    └─────────────────────┘
```

**Key Features:**
- SQLite transactions ensure only one agent can claim a task
- Lease-based ownership with automatic timeout and recovery
- Heartbeat monitoring for detecting dead agents
- Full ACID compliance for task state

## Workflow

### 1. Parse Input
- Extract N (agent count)
- Extract task description
- Validate N <= 5

### 2. Create Task Pool
- Analyze codebase based on task
- Break into file-specific subtasks
- Initialize SQLite database with task pool
- Each task gets: id, description, status (pending), and metadata columns

### 3. Spawn Agents
- Launch N agents via Task tool with `subagent_type: "general-purpose"`
- Set `run_in_background: true` for all
- Each agent connects to the SQLite database
- Agents enter claiming loop automatically

### 3.1. Agent Preamble (IMPORTANT)

When spawning swarm agents, ALWAYS wrap the task with the worker preamble to prevent recursive sub-agent spawning:

```typescript
// When spawning each agent:
const agentPrompt = `
SWARM WORKER ${n}

Connect to swarm at ${cwd}/.omc/state/swarm.db
Claim tasks with claimTask('agent-${n}')
Complete work with completeTask() or failTask()
Send heartbeat every 60 seconds
Exit when hasPendingWork() returns false

CRITICAL: Execute tasks directly using tools (Read, Write, Edit, Bash)
Do NOT spawn sub-agents (prevents recursive agent storms)
Report results with absolute file paths
`;

Task({
  subagent_type: 'general-purpose',
  model: 'sonnet',
  prompt: agentPrompt,
  run_in_background: true
});
```

The worker preamble ensures agents:
- Execute tasks directly using tools (Read, Write, Edit, Bash)
- Do NOT spawn sub-agents (prevents recursive agent storms)
- Report results with absolute file paths

### 4. Task Claiming Protocol (SQLite Transactional)
Each agent follows this loop:

```
LOOP:
  1. Call claimTask(agentId)
  2. SQLite transaction:
     - Find first pending task
     - UPDATE status='claimed', claimed_by=agentId, claimed_at=now
     - INSERT/UPDATE heartbeat record
     - Atomically commit (only one agent succeeds)
  3. Execute task
  4. Call completeTask(agentId, taskId, result) or failTask()
  5. GOTO LOOP (until hasPendingWork() returns false)
```

**Atomic Claiming Details:**
- SQLite `IMMEDIATE` transaction prevents race conditions
- Only agent updating the row successfully gets the task
- Heartbeat automatically updated on claim
- If claim fails (already claimed), agent retries with next task
- Lease Timeout: 5 minutes per task
- If timeout exceeded + no heartbeat, cleanupStaleClaims releases task back to pending

### 5. Heartbeat Protocol
- Agents call `heartbeat(agentId)` every 60 seconds (or custom interval)
- Heartbeat records: agent_id, last_heartbeat timestamp, current_task_id
- Orchestrator runs cleanupStaleClaims every 60 seconds
- If heartbeat is stale (>5 minutes old) and task claimed, task auto-releases

### 6. Progress Tracking
- Orchestrator monitors via TaskOutput
- Shows live progress: pending/claimed/done/failed counts
- Active agent count via getActiveAgents()
- Reports which agent is working on which task via getAgentTasks()
- Detects idle agents (all tasks claimed by others)

### 7. Completion
Exit when ANY of:
- isSwarmComplete() returns true (all tasks done or failed)
- All agents idle (no pending tasks, no claimed tasks)
- User cancels via `/oh-my-claudecode:cancel`

## Storage

### SQLite Database (`.omc/state/swarm.db`)

The swarm uses a single SQLite database stored at `.omc/state/swarm.db`. This provides:
- **ACID compliance** - All task state transitions are atomic
- **Concurrent access** - Multiple agents query/update safely
- **Persistence** - State survives agent crashes
- **Query efficiency** - Fast status lookups and filtering

## Key Parameters

- **Max Agents:** 5 (enforced by Claude Code background task limit)
- **Lease Timeout:** 5 minutes (default, configurable)
- **Heartbeat Interval:** 60 seconds (recommended)
- **Cleanup Interval:** 60 seconds
- **Database:** SQLite (stored at `.omc/state/swarm.db`)

## Valid Agent Types

| Type | Use For |
|------|---------|
| `general-purpose` | All swarm workers (DEFAULT) |
| `Explore` | Codebase exploration |
| `Plan` | Architecture analysis |
| `Bash` | Shell commands only |

**Model tiers:**
| Model | Use For |
|-------|---------|
| `haiku` | Simple tasks, quick fixes |
| `sonnet` | Standard implementation (DEFAULT) |
| `opus` | Complex analysis |

## Error Handling & Recovery

### Agent Crash
- Task is claimed but agent stops sending heartbeats
- After 5 minutes of no heartbeat, cleanupStaleClaims() releases the task
- Task returns to 'pending' status for another agent to claim

### All Agents Idle
- Orchestrator detects via `getActiveAgents() === 0` or `hasPendingWork() === false`
- Triggers final cleanup and marks swarm as complete

## Cancel Swarm

User can cancel via `/oh-my-claudecode:cancel`:
- Stops orchestrator monitoring
- Signals all background agents to exit
- Preserves partial progress in SQLite database

## Use Cases

### 1. Fix All Type Errors
```
/swarm 5 "fix all TypeScript type errors"
```
Spawns 5 general-purpose agents, each claiming and fixing individual files.

### 2. Implement UI Components
```
/swarm 3 "implement Material-UI styling for all components in src/components/"
```
Spawns 3 agents, each styling different component files.

### 3. Security Audit
```
/swarm 4 "review all API endpoints for vulnerabilities"
```
Spawns 4 agents, each auditing different endpoints.

### 4. Documentation Sprint
```
/swarm 2 "add JSDoc comments to all exported functions"
```
Spawns 2 agents, each documenting different modules.

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Delete state files on completion - do NOT just set `active: false`**

When all tasks are done:

```bash
# Delete swarm state files
rm -f .omc/state/swarm-state.json
rm -f .omc/state/swarm-tasks.json
rm -f .omc/state/swarm-claims.json
```
