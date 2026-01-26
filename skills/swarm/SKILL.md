---
name: swarm
description: N coordinated agents on shared task list with SQLite-based atomic claiming
---

# Swarm Skill

Spawn N coordinated agents working on a shared task list with SQLite-based atomic claiming. Like a dev team tackling multiple files in parallel—fast, reliable, and with full fault tolerance.

## Usage

```
/swarm N:agent-type "task description"
```

### Parameters

- **N** - Number of agents (1-5, enforced by Claude Code limit)
- **agent-type** - Agent to spawn (e.g., executor, build-fixer, architect)
- **task** - High-level task to decompose and distribute

### Examples

```bash
/swarm 5:executor "fix all TypeScript errors"
/swarm 3:build-fixer "fix build errors in src/"
/swarm 4:designer "implement responsive layouts for all components"
/swarm 2:architect "analyze and document all API endpoints"
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
- Extract N (agent count)
- Extract agent-type
- Extract task description
- Validate N <= 5

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

### 3.1. Agent Preamble (IMPORTANT)

When spawning swarm agents, ALWAYS wrap the task with the worker preamble to prevent recursive sub-agent spawning:

```typescript
import { wrapWithPreamble } from '../agents/preamble.js';

// When spawning each agent:
const agentPrompt = wrapWithPreamble(`
Connect to swarm at ${cwd}/.omc/state/swarm.db
Claim tasks with claimTask('agent-${n}')
Complete work with completeTask() or failTask()
Send heartbeat every 60 seconds
Exit when hasPendingWork() returns false
`);

Task({
  subagent_type: 'oh-my-claudecode:executor',
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

#### `session` Table Schema
```sql
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  agent_count INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  active INTEGER DEFAULT 1
);
```

## Task Claiming Protocol (Detailed)

### Atomic Claim Operation with SQLite

The core strength of the new implementation is transactional atomicity:

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

Agents interact with the swarm via a TypeScript API:

### Initialization

```typescript
import { startSwarm, connectToSwarm } from './swarm';

// Orchestrator starts the swarm
await startSwarm({
  agentCount: 5,
  tasks: ['fix a.ts', 'fix b.ts', ...],
  leaseTimeout: 5 * 60 * 1000,      // 5 minutes (default)
  heartbeatInterval: 60 * 1000      // 60 seconds (default)
});

// Agents join existing swarm
await connectToSwarm(process.cwd());
```

### Agent Loop Pattern

```typescript
import {
  claimTask,
  completeTask,
  failTask,
  heartbeat,
  hasPendingWork,
  disconnectFromSwarm
} from './swarm';

const agentId = 'agent-1';

// Main work loop
while (hasPendingWork()) {
  // Claim next task
  const claim = claimTask(agentId);

  if (!claim.success) {
    console.log('No tasks available:', claim.reason);
    break;
  }

  const { taskId, description } = claim;
  console.log(`Agent ${agentId} working on: ${description}`);

  try {
    // Do the work...
    const result = await executeTask(description);

    // Mark complete
    completeTask(agentId, taskId, result);
    console.log(`Agent ${agentId} completed task ${taskId}`);

  } catch (error) {
    // Mark failed
    failTask(agentId, taskId, error.message);
    console.error(`Agent ${agentId} failed on ${taskId}:`, error);
  }

  // Send heartbeat every 60 seconds (while working on long tasks)
  heartbeat(agentId);
}

// Cleanup
disconnectFromSwarm();
```

### Core API Functions

#### `startSwarm(config: SwarmConfig): Promise<boolean>`
Initialize the swarm with task pool and start cleanup timer.

```typescript
const success = await startSwarm({
  agentCount: 5,
  tasks: ['task 1', 'task 2', 'task 3'],
  leaseTimeout: 5 * 60 * 1000,
  heartbeatInterval: 60 * 1000
});
```

#### `stopSwarm(deleteDatabase?: boolean): boolean`
Stop the swarm and optionally delete the database.

```typescript
stopSwarm(true);  // Delete database on cleanup
```

#### `claimTask(agentId: string): ClaimResult`
Claim the next pending task. Returns `{ success, taskId, description, reason }`.

```typescript
const claim = claimTask('agent-1');
if (claim.success) {
  console.log(`Claimed: ${claim.description}`);
}
```

#### `completeTask(agentId: string, taskId: string, result?: string): boolean`
Mark a task as done. Only succeeds if agent still owns the task.

```typescript
completeTask('agent-1', 'task-1', 'Fixed the bug');
```

#### `failTask(agentId: string, taskId: string, error: string): boolean`
Mark a task as failed with error details.

```typescript
failTask('agent-1', 'task-1', 'Could not compile: missing dependency');
```

#### `heartbeat(agentId: string): boolean`
Send a heartbeat to indicate agent is alive. Call every 60 seconds during long-running tasks.

```typescript
heartbeat('agent-1');
```

#### `cleanupStaleClaims(leaseTimeout?: number): number`
Manually trigger cleanup of expired claims. Called automatically every 60 seconds.

```typescript
const released = cleanupStaleClaims(5 * 60 * 1000);
console.log(`Released ${released} stale tasks`);
```

#### `hasPendingWork(): boolean`
Check if there are unclaimed tasks available.

```typescript
if (!hasPendingWork()) {
  console.log('All tasks claimed or completed');
}
```

#### `isSwarmComplete(): boolean`
Check if all tasks are done or failed.

```typescript
if (isSwarmComplete()) {
  console.log('Swarm finished!');
}
```

#### `getSwarmStats(): SwarmStats | null`
Get task counts and timing info.

```typescript
const stats = getSwarmStats();
console.log(`${stats.doneTasks}/${stats.totalTasks} done`);
```

#### `getActiveAgents(): number`
Get count of agents with recent heartbeats.

```typescript
const active = getActiveAgents();
console.log(`${active} agents currently active`);
```

#### `getAllTasks(): SwarmTask[]`
Get all tasks with current status.

```typescript
const tasks = getAllTasks();
const pending = tasks.filter(t => t.status === 'pending');
```

#### `getTasksWithStatus(status: string): SwarmTask[]`
Filter tasks by status: 'pending', 'claimed', 'done', 'failed'.

```typescript
const failed = getTasksWithStatus('failed');
```

#### `getAgentTasks(agentId: string): SwarmTask[]`
Get all tasks claimed by a specific agent.

```typescript
const myTasks = getAgentTasks('agent-1');
```

#### `retryTask(agentId: string, taskId: string): ClaimResult`
Attempt to reclaim a failed task.

```typescript
const retry = retryTask('agent-1', 'task-1');
if (retry.success) {
  console.log('Task reclaimed, trying again...');
}
```

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

## Cancel Swarm

User can cancel via `/oh-my-claudecode:cancel`:
- Stops orchestrator monitoring
- Signals all background agents to exit
- Preserves partial progress in SQLite database
- Marks session as "cancelled" in database

## Use Cases

### 1. Fix All Type Errors
```
/swarm 5:executor "fix all TypeScript type errors"
```
Spawns 5 executors, each claiming and fixing individual files.

### 2. Implement UI Components
```
/swarm 3:designer "implement Material-UI styling for all components in src/components/"
```
Spawns 3 designers, each styling different component files.

### 3. Security Audit
```
/swarm 4:security-reviewer "review all API endpoints for vulnerabilities"
```
Spawns 4 security reviewers, each auditing different endpoints.

### 4. Documentation Sprint
```
/swarm 2:writer "add JSDoc comments to all exported functions"
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

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Delete state files on completion - do NOT just set `active: false`**

When all tasks are done:

```bash
# Delete swarm state files
rm -f .omc/state/swarm-state.json
rm -f .omc/state/swarm-tasks.json
rm -f .omc/state/swarm-claims.json
```

## Implementation Notes

The orchestrator (main skill handler) is responsible for:
1. Initial task decomposition (via explore/architect)
2. Creating and initializing SQLite database via `startSwarm()`
3. Spawning N background agents
4. Monitoring progress via `getSwarmStats()` and `getActiveAgents()`
5. Running `cleanupStaleClaims()` automatically (via setInterval)
6. Detecting completion via `isSwarmComplete()`
7. Reporting final summary from database query

Each agent is a standard Task invocation with:
- `run_in_background: true`
- Agent-specific prompt with work loop instructions
- API import: `import { claimTask, completeTask, ... } from './swarm'`
- Connection: `await connectToSwarm(cwd)` to join existing swarm
- Loop: repeatedly call `claimTask()` → do work → `completeTask()` or `failTask()`
