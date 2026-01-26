---
description: N coordinated agents on shared task list with SQLite-based atomic claiming
aliases: [swarm-agents]
---

# Swarm Command

[SWARM MODE ACTIVATED]

Spawn N coordinated agents working on a shared task list with SQLite-based atomic claiming. Like a dev team tackling multiple files in parallel—fast, reliable, and with full fault tolerance.

## User's Request

{{ARGUMENTS}}

## Usage Pattern

```
/oh-my-claudecode:swarm N:agent-type "task description"
```

### Parameters

- **N** - Number of agents (1-5, enforced by Claude Code limit)
- **agent-type** - Agent to spawn (e.g., executor, build-fixer, architect)
- **task** - High-level task to decompose and distribute

### Examples

```bash
/oh-my-claudecode:swarm 5:executor "fix all TypeScript errors"
/oh-my-claudecode:swarm 3:build-fixer "fix build errors in src/"
/oh-my-claudecode:swarm 4:designer "implement responsive layouts for all components"
/oh-my-claudecode:swarm 2:architect "analyze and document all API endpoints"
```

## Architecture

```
User: "/swarm 5:executor fix all TypeScript errors"
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

From `{{ARGUMENTS}}`, extract:
- N (agent count, validate <= 5)
- agent-type (executor, build-fixer, etc.)
- task description

### 2. Create Task Pool
- Analyze codebase based on task
- Break into file-specific subtasks
- Initialize SQLite database with task pool
- Each task gets: id, description, status (pending), and metadata columns

### 3. Spawn Agents
- Launch N agents via Task tool
- Set `run_in_background: true` for all
- Each agent connects to the SQLite database
- Agents enter claiming loop automatically

**Important:** Use worker preamble when spawning agents to prevent sub-agent recursion:

```typescript
import { wrapWithPreamble } from '../agents/preamble.js';

const prompt = wrapWithPreamble(`Your task: ${taskDescription}`);
```

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

#### `tasks` Table Schema
```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending: waiting to be claimed
    -- claimed: claimed by an agent, in progress
    -- done: completed successfully
    -- failed: completed with error
  claimed_by TEXT,                  -- agent ID that claimed this task
  claimed_at INTEGER,               -- Unix timestamp when claimed
  completed_at INTEGER,             -- Unix timestamp when completed
  result TEXT,                      -- Optional result/output from task
  error TEXT                        -- Error message if task failed
);
```

#### `heartbeats` Table Schema
```sql
CREATE TABLE heartbeats (
  agent_id TEXT PRIMARY KEY,
  last_heartbeat INTEGER NOT NULL,  -- Unix timestamp of last heartbeat
  current_task_id TEXT              -- Task agent is currently working on
);
```

#### `swarm_session` Table Schema
```sql
CREATE TABLE swarm_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  agent_count INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

## Task Claiming Protocol (Detailed)

### Atomic Claim Operation with SQLite

The core strength of the implementation is transactional atomicity:

```typescript
function claimTask(agentId: string): ClaimResult {
  // Transaction ensures only ONE agent succeeds
  const claimTransaction = db.transaction(() => {
    // Step 1: Find first pending task
    const task = db.prepare(
      'SELECT id, description FROM tasks WHERE status = "pending" ORDER BY id LIMIT 1'
    ).get();

    if (!task) {
      return { success: false, reason: 'No pending tasks' };
    }

    // Step 2: Attempt claim (will only succeed if status is still 'pending')
    const result = db.prepare(
      'UPDATE tasks SET status = "claimed", claimed_by = ?, claimed_at = ? WHERE id = ? AND status = "pending"'
    ).run(agentId, Date.now(), task.id);

    if (result.changes === 0) {
      // Another agent claimed it between SELECT and UPDATE - try next
      return { success: false, reason: 'Task was claimed by another agent' };
    }

    // Step 3: Update heartbeat to show we're alive and working
    db.prepare(
      'INSERT OR REPLACE INTO heartbeats (agent_id, last_heartbeat, current_task_id) VALUES (?, ?, ?)'
    ).run(agentId, Date.now(), task.id);

    return { success: true, taskId: task.id, description: task.description };
  });

  return claimTransaction();  // Atomic execution
}
```

**Why SQLite Transactions Work:**
- `db.transaction()` uses `IMMEDIATE` locking
- Prevents other agents from modifying rows between SELECT and UPDATE
- All-or-nothing atomicity: claim succeeds completely or fails completely
- No race conditions, no lost updates

### Lease Timeout & Auto-Release

Tasks are automatically released if claimed too long without heartbeat:

```typescript
function cleanupStaleClaims(leaseTimeout: number = 5 * 60 * 1000) {
  // Default 5-minute timeout
  const cutoffTime = Date.now() - leaseTimeout;

  const cleanupTransaction = db.transaction(() => {
    // Find claimed tasks where:
    // 1. Claimed longer than timeout, OR
    // 2. Agent hasn't sent heartbeat in that time
    const staleTasks = db.prepare(`
      SELECT t.id
      FROM tasks t
      LEFT JOIN heartbeats h ON t.claimed_by = h.agent_id
      WHERE t.status = 'claimed'
        AND t.claimed_at < ?
        AND (h.last_heartbeat IS NULL OR h.last_heartbeat < ?)
    `).all(cutoffTime, cutoffTime);

    // Release each stale task back to pending
    for (const staleTask of staleTasks) {
      db.prepare('UPDATE tasks SET status = "pending", claimed_by = NULL, claimed_at = NULL WHERE id = ?')
        .run(staleTask.id);
    }

    return staleTasks.length;
  });

  return cleanupTransaction();
}
```

**How Recovery Works:**
1. Orchestrator calls cleanupStaleClaims() every 60 seconds
2. If agent hasn't sent heartbeat in 5 minutes, task is auto-released
3. Another agent picks up the orphaned task
4. Original agent can continue working (it doesn't know it was released)
5. When original agent tries to mark task as done, verification fails safely

## API Reference

### Core API Functions

#### `startSwarm(config: SwarmConfig): Promise<boolean>`
Initialize the swarm with task pool and start cleanup timer.

#### `stopSwarm(deleteDatabase?: boolean): boolean`
Stop the swarm and optionally delete the database.

#### `claimTask(agentId: string): ClaimResult`
Claim the next pending task. Returns `{ success, taskId, description, reason }`.

#### `completeTask(agentId: string, taskId: string, result?: string): boolean`
Mark a task as done. Only succeeds if agent still owns the task.

#### `failTask(agentId: string, taskId: string, error: string): boolean`
Mark a task as failed with error details.

#### `heartbeat(agentId: string): boolean`
Send a heartbeat to indicate agent is alive. Call every 60 seconds during long-running tasks.

#### `cleanupStaleClaims(leaseTimeout?: number): number`
Manually trigger cleanup of expired claims. Called automatically every 60 seconds.

#### `hasPendingWork(): boolean`
Check if there are unclaimed tasks available.

#### `isSwarmComplete(): boolean`
Check if all tasks are done or failed.

#### `getSwarmStats(): SwarmStats | null`
Get task counts and timing info.

### Configuration (SwarmConfig)

```typescript
interface SwarmConfig {
  agentCount: number;           // Number of agents (1-5)
  tasks: string[];              // Task descriptions
  agentType?: string;           // Agent type (default: 'executor')
  leaseTimeout?: number;        // Milliseconds (default: 5 min)
  heartbeatInterval?: number;   // Milliseconds (default: 60 sec)
  cwd?: string;                 // Working directory
}
```

### Types

```typescript
interface SwarmTask {
  id: string;
  description: string;
  status: 'pending' | 'claimed' | 'done' | 'failed';
  claimedBy: string | null;
  claimedAt: number | null;
  completedAt: number | null;
  error?: string;
  result?: string;
}

interface ClaimResult {
  success: boolean;
  taskId: string | null;
  description?: string;
  reason?: string;
}

interface SwarmStats {
  totalTasks: number;
  pendingTasks: number;
  claimedTasks: number;
  doneTasks: number;
  failedTasks: number;
  activeAgents: number;
  elapsedTime: number;
}
```

## Key Parameters

- **Max Agents:** 5 (enforced by Claude Code background task limit)
- **Lease Timeout:** 5 minutes (default, configurable)
  - Tasks claimed longer than this without heartbeat are auto-released
- **Heartbeat Interval:** 60 seconds (recommended)
  - Agents should call `heartbeat()` at least this often
  - Prevents false timeout while working on long tasks
- **Cleanup Interval:** 60 seconds
  - Orchestrator automatically runs `cleanupStaleClaims()` to release orphaned tasks
- **Database:** SQLite (stored at `.omc/state/swarm.db`)
  - One database per swarm session
  - Survives agent crashes
  - Provides ACID guarantees

## Error Handling & Recovery

### Agent Crash
- Task is claimed but agent stops sending heartbeats
- After 5 minutes of no heartbeat, cleanupStaleClaims() releases the task
- Task returns to 'pending' status for another agent to claim
- Original agent's incomplete work is safely abandoned

### Task Completion Failure
- Agent calls `completeTask()` but is no longer the owner (was released)
- The update silently fails (no agent matches in WHERE clause)
- Agent can detect this by checking return value
- Agent should log error and continue to next task

### Database Unavailable
- `startSwarm()` returns false if database initialization fails
- `claimTask()` returns `{ success: false, reason: 'Database not initialized' }`
- Check `isSwarmReady()` before proceeding

### All Agents Idle
- Orchestrator detects via `getActiveAgents() === 0` or `hasPendingWork() === false`
- Triggers final cleanup and marks swarm as complete
- Remaining failed tasks are preserved in database

### No Tasks Available
- `claimTask()` returns success=false with reason 'No pending tasks available'
- Agent should check `hasPendingWork()` before looping
- Safe for agent to exit cleanly when no work remains

## Cancellation

Use unified cancel command:
```
/oh-my-claudecode:cancel
```

This:
- Stops orchestrator monitoring
- Signals all background agents to exit
- Preserves partial progress in database
- Marks session as "cancelled"

## Use Cases

### Fix All Type Errors
```
/oh-my-claudecode:swarm 5:executor "fix all TypeScript type errors"
```
Spawns 5 executors, each claiming and fixing individual files.

### Implement UI Components
```
/oh-my-claudecode:swarm 3:designer "implement Material-UI styling for all components"
```
Spawns 3 designers, each styling different component files.

### Security Audit
```
/oh-my-claudecode:swarm 4:security-reviewer "review all API endpoints for vulnerabilities"
```
Spawns 4 security reviewers, each auditing different endpoints.

### Documentation Sprint
```
/oh-my-claudecode:swarm 2:writer "add JSDoc comments to all exported functions"
```
Spawns 2 writers, each documenting different modules.

## Benefits of SQLite-Based Implementation

### Atomicity & Safety
- **Race-Condition Free:** SQLite transactions guarantee only one agent claims each task
- **No Lost Updates:** ACID compliance means state changes are durable
- **Orphan Prevention:** Expired claims are automatically released without manual intervention

### Performance
- **Fast Queries:** Indexed lookups on task status and agent ID
- **Concurrent Access:** Multiple agents read/write without blocking
- **Minimal Lock Time:** Transactions are microseconds, not seconds

### Reliability
- **Crash Recovery:** Database survives agent failures
- **Automatic Cleanup:** Stale claims don't block progress
- **Lease-Based:** Time-based expiration prevents indefinite hangs

### Developer Experience
- **Simple API:** Just `claimTask()`, `completeTask()`, `heartbeat()`
- **Full Visibility:** Query any task or agent status at any time
- **Easy Debugging:** SQL queries show exact state without decoding JSON

### Scalability
- **10s to 1000s of Tasks:** SQLite handles easily
- **Full Task Retention:** Complete history in database for analysis
- **Extensible Schema:** Add custom columns for task metadata

## Output

Report when complete:
- Total tasks completed
- Tasks per agent (performance comparison)
- Total time elapsed
- Final verification status
- Summary of changes made
