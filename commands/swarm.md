---
description: N coordinated agents on shared task list with SQLite-based atomic claiming
aliases: [swarm-agents]
---

# Swarm Command

[SWARM MODE ACTIVATED]

Swarm is now a compatibility facade over Team mode. It keeps legacy `/swarm` invocation syntax, but runtime orchestration follows Team's staged pipeline and native team/task infrastructure.

Staged runtime: `team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)`.

## User's Request

{{ARGUMENTS}}

## Usage Patterns

### Standard Mode (1-5 agents)
```
/oh-my-claudecode:swarm N:agent-type "task description"
```

### Aggressive Mode (20-50+ tasks)
```
/oh-my-claudecode:swarm aggressive:agent-type "large task description"
```
or
```
/oh-my-claudecode:swarm 30:executor "fix all TypeScript errors"
```

When N > 5 or "aggressive" keyword is used, swarm automatically:
1. Decomposes work into micro-tasks (one function, one file section, one test)
2. Spawns agents in waves up to the configured concurrent limit
3. Polls for completions every 5 seconds
4. Immediately spawns replacement agents as slots free up
5. Continues until all tasks complete

**Concurrency Note**: The concurrent agent limit is configurable via `permissions.maxBackgroundTasks` (default 5, max 50). Users can raise this in their OMC config to run more agents in parallel.

### Parameters

- **N** - Number of agents (1-5 for standard mode, 6+ for aggressive mode)
- **agent-type** - Agent to spawn (e.g., executor, build-fixer, architect)
- **task** - High-level task to decompose and distribute

### Examples

```bash
# Standard Mode
/oh-my-claudecode:swarm 5:executor "fix all TypeScript errors"
/oh-my-claudecode:swarm 3:build-fixer "fix build errors in src/"
/oh-my-claudecode:swarm 4:designer "implement responsive layouts for all components"
/oh-my-claudecode:swarm 2:architect "analyze and document all API endpoints"

# Aggressive Mode
/oh-my-claudecode:swarm 30:executor "fix all TypeScript errors"
/oh-my-claudecode:swarm aggressive:build-fixer "fix build errors across entire codebase"
```

## Compatibility Behavior (Team-backed)

`/oh-my-claudecode:swarm` is maintained for backward compatibility, but orchestration is delegated to Team mode.

Canonical staged runtime:

`team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)`

### Stage Entry/Exit Criteria

- **team-plan**: enters on legacy swarm invocation; exits when decomposition and task graph are ready.
- **team-prd**: enters when scope/acceptance criteria are ambiguous; exits when execution criteria are explicit.
- **team-exec**: enters once TeamCreate/TaskCreate/worker spawn are complete; exits when execution pass reaches terminal task states.
- **team-verify**: enters after execution pass; exits to done on pass, or to `team-fix` on failure.
- **team-fix**: enters when verification finds gaps; exits by feeding fixes back into `team-exec`.

### Verify/Fix Loop Policy and Stop Conditions

Continue `team-exec -> team-verify -> team-fix` until verification passes with no required fix tasks, or work reaches an explicit terminal blocked/failed outcome with evidence.

`team-fix` is bounded by max attempts; exceeding the bound transitions to terminal `failed`.

### Resume and Cancel Semantics

- **Resume:** continue from the last non-terminal Team stage using staged state + live task status.
- **Cancel:** `/oh-my-claudecode:cancel` requests teammate shutdown, waits best-effort for responses, marks phase `cancelled` with `active=false`, records cancellation metadata, runs `TeamDelete`, and clears/preserves Team state per policy.
- Terminal states are `complete`, `failed`, and `cancelled`.

> Historical SQLite details below are legacy reference and not the canonical runtime path for migrated Team mode.

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

### 2b. Micro-Task Decomposition (Aggressive Mode)

When N > 5 or "aggressive" keyword is detected, decompose work into fine-grained micro-tasks:

**File-Level Decomposition**
- One task per file (e.g., "Fix TypeScript errors in src/auth/login.ts")
- Ideal for: lint fixes, formatting, simple refactors
- Example: 47 files with errors → 47 tasks

**Function-Level Decomposition**
- One task per function or exported symbol
- Ideal for: documentation, test writing, complexity refactors
- Example: "Document auth module" → 12 tasks (one per exported function)

**Pattern-Based Decomposition**
- One task per error type or pattern instance
- Ideal for: specific lint rules, security patterns, deprecation fixes
- Example: "Remove console.log statements" → 23 tasks (one per file with console.log)

**Example Decomposition: "Fix all TypeScript errors" (32 tasks)**

```typescript
// Input: "fix all TypeScript errors" with 32 files containing errors

// Output Task Pool:
[
  "Fix TypeScript errors in src/auth/login.ts (4 errors)",
  "Fix TypeScript errors in src/auth/register.ts (2 errors)",
  "Fix TypeScript errors in src/api/users.ts (7 errors)",
  "Fix TypeScript errors in src/api/posts.ts (3 errors)",
  // ... 28 more file-level tasks
]

// Each task is atomic: one file, clear success criteria (tsc --noEmit shows no errors)
```

**File Ownership Assignment**

Assign filePatterns to tasks for advisory ownership tracking:

```typescript
{
  id: "task-1",
  description: "Fix TypeScript errors in src/auth/login.ts",
  filePatterns: ["src/auth/login.ts"],  // Advisory ownership
  status: "pending"
}
```

This allows conflict detection (two agents claiming tasks on same file) but does NOT enforce locks.

### 3. Wave-Based Agent Spawning

**Standard Mode (N ≤ 5)**: Spawn all N agents at once, all run concurrently until task pool is empty.

**Aggressive Mode (N > 5)**: Wave-based spawning to respect concurrent agent limits while maximizing throughput.

#### Wave Loop Algorithm

```typescript
const maxConcurrent = getMaxBackgroundTasks(); // From config, default 5, max 50
const totalTasks = taskPool.length;
let activeAgents = new Set<string>();
let spawnedCount = 0;

while (!isSwarmComplete()) {
  // 1. Check available slots
  const freeSlots = maxConcurrent - activeAgents.size;

  // 2. Spawn agents to fill slots
  if (freeSlots > 0 && spawnedCount < totalTasks) {
    const toSpawn = Math.min(freeSlots, totalTasks - spawnedCount);

    for (let i = 0; i < toSpawn; i++) {
      const agentId = `agent-${spawnedCount + 1}`;
      spawnAgent(agentId, agentType);
      activeAgents.add(agentId);
      spawnedCount++;
    }
  }

  // 3. Wait for polling interval
  await sleep(5000); // Poll every 5 seconds

  // 4. Check for completions and remove finished agents
  const finishedAgents = await checkCompletedAgents(activeAgents);
  finishedAgents.forEach(id => activeAgents.delete(id));

  // 5. Loop continues - free slots will trigger more spawns
}
```

#### Orchestrator Polling

The orchestrator continuously monitors swarm progress:

```typescript
async function monitorSwarm() {
  const pollInterval = 5000; // 5 seconds

  while (!isSwarmComplete()) {
    // Get current stats
    const stats = getSwarmStats();

    // Report progress
    console.log(`Progress: ${stats.doneTasks}/${stats.totalTasks} complete`);
    console.log(`Active: ${stats.claimedTasks}, Failed: ${stats.failedTasks}`);

    // Check for agent completions via TaskOutput
    const updates = await pollAgentUpdates();

    // Spawn replacements for completed agents
    spawnReplacementAgents();

    await sleep(pollInterval);
  }
}
```

#### Key Characteristics

- **Agents claim autonomously**: Orchestrator spawns agents but does NOT pre-assign tasks
- **Wave-based throughput**: Keeps all available slots filled until work is done
- **Dynamic scaling**: Respects user-configured `maxBackgroundTasks` limit
- **No manual coordination**: Agents use SQLite atomic claiming to self-coordinate

**Important:** Use worker preamble when spawning agents to prevent sub-agent recursion:

```typescript
import { wrapWithPreamble } from '../agents/preamble.js';

const prompt = wrapWithPreamble(`Your task: ${taskDescription}`);
```

**Concurrency Configuration**: Users can increase `permissions.maxBackgroundTasks` in their OMC config to run more agents in parallel (max 50).

### 4. File Ownership (Conflict Prevention)

File ownership is **ADVISORY**, not enforced. It helps detect potential conflicts but does not lock files.

#### Assignment Strategy

When creating tasks, assign `filePatterns` for ownership tracking:

```typescript
{
  id: "task-12",
  description: "Fix TypeScript errors in src/api/users.ts",
  filePatterns: ["src/api/users.ts"],  // Single file ownership
  status: "pending"
}

{
  id: "task-25",
  description: "Add JSDoc to all auth functions",
  filePatterns: ["src/auth/*.ts"],     // Pattern-based ownership
  status: "pending"
}
```

#### Conflict Detection

The orchestrator can query for potential conflicts:

```typescript
function detectFileConflicts(): ConflictReport {
  const claimedTasks = db.prepare(
    'SELECT id, claimed_by, filePatterns FROM tasks WHERE status = "claimed"'
  ).all();

  // Check for overlapping filePatterns
  const conflicts = findOverlappingPatterns(claimedTasks);

  return conflicts; // Report to user, but don't block
}
```

#### Best Practices

**Prefer file-level boundaries:**
- Good: "Fix errors in src/auth/login.ts" (one file)
- Avoid: "Refactor auth module" (many files, high conflict risk)

**Use filePatterns for broader scope:**
- Pattern: `["src/api/*.ts"]` for API-wide changes
- Pattern: `["**/*.test.ts"]` for test suite work

**Conflict resolution:**
- If two agents modify the same file, git merge conflict may occur
- Agents should pull latest changes before committing
- Failed tasks can be retried automatically

**Note:** File ownership is purely advisory. SQLite ensures task claiming atomicity, but file-level conflicts must be handled by git or agent coordination strategies.

### 5. Task Claiming Protocol (SQLite Transactional)
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

### 6. Heartbeat Protocol
- Agents call `heartbeat(agentId)` every 60 seconds (or custom interval)
- Heartbeat records: agent_id, last_heartbeat timestamp, current_task_id
- Orchestrator runs cleanupStaleClaims every 60 seconds
- If heartbeat is stale (>5 minutes old) and task claimed, task auto-releases

### 7. Progress Tracking
- Orchestrator monitors via TaskOutput
- Shows live progress: pending/claimed/done/failed counts
- Active agent count via getActiveAgents()
- Reports which agent is working on which task via getAgentTasks()
- Detects idle agents (all tasks claimed by others)

### 8. Completion
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

### Quick Fix (Standard Mode)
```
/oh-my-claudecode:swarm 3:executor "fix linting errors in src/api/"
```
Spawns 3 executors concurrently. Each claims and fixes individual files. Good for small, bounded tasks.

### Large Codebase Refactor (Aggressive Mode)
```
/oh-my-claudecode:swarm 30:executor "fix all TypeScript errors across codebase"
```
Creates 30 micro-tasks (one per file with errors). Spawns agents in waves of 5 (or configured limit). As agents complete tasks and exit, new agents spawn to maintain throughput until all 30 tasks are done.

### Test Suite Expansion
```
/oh-my-claudecode:swarm aggressive:executor "add unit tests for all untested functions"
```
Uses "aggressive" keyword to trigger micro-task decomposition. Breaks work into function-level tasks. Wave-based spawning keeps pipeline full.

### Documentation Sprint
```
/oh-my-claudecode:swarm 25:writer "add JSDoc comments to all exported functions"
```
Creates 25 tasks (one per module or file). Spawns writers in waves, continuously replacing finished agents until documentation is complete.

### Security Audit
```
/oh-my-claudecode:swarm aggressive:security-reviewer "audit codebase for SQL injection vulnerabilities"
```
Pattern-based decomposition: one task per file with database queries. Aggressive mode ensures thorough coverage across large codebases.

**Note on Persistence**: Unlike ralph/ultrawork which use the persistent-mode hook to block Stop events, aggressive swarm's persistence is handled by the orchestrator's wave loop. The orchestrator continuously polls for completion and spawns replacement agents.

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
