---
description: Parallel autopilot with file ownership partitioning (up to 5x faster)
aliases: [up, ultraauto, parallelauto]
---

# Ultrapilot Command

[ULTRAPILOT ACTIVATED - PARALLEL AUTONOMOUS EXECUTION MODE]

You are now in ULTRAPILOT mode. This is a parallel autopilot that spawns multiple workers with file ownership partitioning for maximum speed.

## User's Task

{{ARGUMENTS}}

## Your Mission

Transform this task into working code through parallel execution:

1. **Analysis** - Determine if task is parallelizable
2. **Decomposition** - Break into parallel-safe subtasks with file partitioning
3. **Parallel Execution** - Spawn up to 5 workers with exclusive file ownership
4. **Integration** - Handle shared files sequentially
5. **Validation** - Full system integrity check

## Phase 0: Task Analysis

Determine if task is suitable for parallel execution:

**Parallelizable if:**
- Can be split into 2+ independent subtasks
- File boundaries are clear
- Dependencies between subtasks are minimal

**If NOT parallelizable:** Fall back to regular `/oh-my-claudecode:autopilot`

## Phase 1: Decomposition

YOU perform decomposition directly (no delegation needed):

1. Use Explore agent or Glob/Grep to understand codebase structure
2. Identify independent components (e.g., frontend, backend, database, tests)
3. Map each subtask to a non-overlapping file set
4. Identify shared files (package.json, tsconfig.json) for sequential handling
5. Create task list with clear ownership

**Output format:**

```
DECOMPOSITION COMPLETE
======================
Subtask 1: [description]
  Files: src/api/**, src/types/api.ts
  Model: sonnet

Subtask 2: [description]
  Files: src/ui/**, src/components/**
  Model: sonnet

Subtask 3: [description]
  Files: tests/**
  Model: haiku

SHARED FILES (coordinator handles):
  - package.json
  - tsconfig.json
```

## Phase 2: File Partitioning

Create exclusive ownership map:

```
Worker 1: src/api/**     (exclusive)
Worker 2: src/ui/**      (exclusive)
Worker 3: src/db/**      (exclusive)
Worker 4: docs/**        (exclusive)
Worker 5: tests/**       (exclusive)
SHARED:   package.json, tsconfig.json (you handle these)
```

**Rule:** No two workers can touch the same files

## Phase 3: Parallel Execution

Spawn ALL workers in a SINGLE message using Task tool with `run_in_background: true`:

```javascript
// IMPORTANT: Send all Task calls in ONE message for true parallelism
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  run_in_background: true,
  prompt: `ULTRAPILOT WORKER [1/N]

YOUR EXCLUSIVE FILES: src/api/**
YOUR TASK: [specific subtask description]

CRITICAL RULES:
1. ONLY create/modify files in your ownership set above
2. Do NOT touch: package.json, tsconfig.json, or files outside your set
3. If you need a shared file modified, output "SHARED_FILE_REQUEST: filename - changes needed"
4. When complete, output "WORKER_COMPLETE" with summary of files changed

Implement the task now.`
)

// Spawn remaining workers in SAME message...
Task(subagent_type: "general-purpose", model: "sonnet", run_in_background: true, prompt: "ULTRAPILOT WORKER [2/N]...")
Task(subagent_type: "general-purpose", model: "haiku", run_in_background: true, prompt: "ULTRAPILOT WORKER [3/N]...")
```

**Critical Rules:**
- Maximum 5 parallel workers
- Each worker owns exclusive file set
- **ALL workers spawned in ONE message** (enables true parallelism)
- Monitor via TaskOutput (check periodically, don't block)

## Phase 4: Monitor & Integrate

After spawning all workers:

1. **Wait briefly** (10-20 seconds) then check TaskOutput for each worker
2. **Continue checking** until all workers report WORKER_COMPLETE or fail
3. **Collect SHARED_FILE_REQUESTs** from worker outputs
4. **Handle shared files yourself** (package.json, configs) based on requests
5. **Resolve integration issues** if workers report conflicts

Example monitoring:
```javascript
// Check worker status (non-blocking)
TaskOutput(task_id: "worker-1-id", block: false, timeout: 5000)
TaskOutput(task_id: "worker-2-id", block: false, timeout: 5000)
// ... repeat until all complete
```

## Phase 5: Validation

After all workers complete, validate the full system:

```javascript
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: `ULTRAPILOT VALIDATION

Verify the complete implementation:
1. Run build command (npm run build, pnpm build, etc.)
2. Run tests if they exist
3. Check for TypeScript errors
4. Verify all components integrate correctly

Report any issues found.`
)
```

If validation fails, fix issues directly or spawn targeted fix agents.

## Delegation Rules (MANDATORY)

**YOU ARE A COORDINATOR, NOT AN IMPLEMENTER.**

| Action | YOU Do | DELEGATE |
|--------|--------|----------|
| Analyze codebase | ✓ (Explore agent OK) | |
| Decompose task | ✓ | |
| Partition files | ✓ | |
| Spawn workers | ✓ | |
| Track progress | ✓ | |
| Handle shared files | ✓ | |
| **Feature code changes** | ✗ NEVER | general-purpose workers |

**Coordinator can write to**: `.omc/`, shared config files (package.json, tsconfig.json)

## State Tracking (Optional)

You may track state in `.omc/ultrapilot-state.json` for your own reference:

```json
{
  "task": "Build todo app",
  "phase": "execution",
  "workers": [
    {"id": "w1", "task_id": "abc123", "files": ["src/api/**"], "status": "running"},
    {"id": "w2", "task_id": "def456", "files": ["src/ui/**"], "status": "complete"}
  ],
  "shared_files": ["package.json", "tsconfig.json"],
  "shared_file_requests": []
}
```

## Completion

When all phases complete and validation passes:

```
ULTRAPILOT_COMPLETE
===================
Task: [original task]
Workers spawned: N
Files modified: [list by worker]
Shared files updated: [list]
Validation: PASSED

All subtasks completed successfully.
```

## Quick Reference: Valid Subagent Types

| Type | Use For |
|------|---------|
| `general-purpose` | Implementation work (DEFAULT for workers) |
| `Explore` | Codebase exploration, finding files |
| `Plan` | Architecture planning |
| `Bash` | Running commands only |
| `haiku` model | Simple tasks, tests, docs |
| `sonnet` model | Standard implementation |
| `opus` model | Complex architectural work |
