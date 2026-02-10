---
description: Parallel autopilot with file ownership partitioning (up to 5x faster)
aliases: [up, ultraauto, parallelauto]
---

# Ultrapilot Command

[ULTRAPILOT ACTIVATED - PARALLEL AUTONOMOUS EXECUTION MODE]

You are now in ULTRAPILOT mode. Ultrapilot is a high-parallelism compatibility facade that maps orchestration onto Team mode's staged runtime while preserving the ultrapilot user intent.

Canonical staged runtime:
`team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)`

## User's Task

{{ARGUMENTS}}

## Your Mission

Transform this task into working code through parallel execution:

1. **Analysis** - Determine if task is parallelizable
2. **Decomposition** - Break into parallel-safe subtasks with file partitioning
3. **Parallel Execution** - Spawn up to 5 workers with exclusive file ownership
4. **Integration** - Handle shared files sequentially
5. **Validation** - Full system integrity check

## Team-Backed Staged Semantics

Ultrapilot preserves high-parallel execution intent, but stage orchestration aligns with Team runtime:

`team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)`

### Stage Entry/Exit Criteria

- **team-plan**: enter when ultrapilot request is parsed; exit when decomposition + ownership plan are ready.
- **team-prd**: enter when acceptance criteria/scope are underspecified; exit when execution criteria are explicit.
- **team-exec**: enter once task graph + workers are active; exit when current execution pass reaches terminal task states.
- **team-verify**: enter after execution pass; exit on pass or transition to `team-fix` on failure.
- **team-fix**: enter when verification finds defects/incomplete criteria; exit back to `team-exec` for another pass.

### Verify/Fix Loop Policy and Stop Conditions

Continue `team-exec -> team-verify -> team-fix` until verification passes with no required follow-up tasks, or work reaches an explicit terminal blocked/failed outcome with evidence.

`team-fix` is bounded by max attempts; exceeding that bound transitions to terminal `failed`.

### Resume and Cancel Semantics

- **Resume:** continue from the last non-terminal Team stage using staged state + live task status.
- **Cancel:** `/oh-my-claudecode:cancel` requests worker shutdown, waits best-effort for acknowledgements, marks phase `cancelled` with `active=false`, records cancellation metadata, clears/preserves team state per policy, and halts stage progression.
- Terminal states are `complete`, `failed`, and `cancelled`.

## Phase 0: Task Analysis

Determine if task is suitable for parallel execution:

**Parallelizable if:**
- Can be split into 2+ independent subtasks
- File boundaries are clear
- Dependencies between subtasks are minimal

**If NOT parallelizable:** Fall back to regular `/oh-my-claudecode:autopilot`

## Phase 1: Decomposition

Break task into parallel-safe subtasks:

1. Identify independent components (e.g., frontend, backend, database, tests)
2. Map each subtask to a non-overlapping file set
3. Identify shared files (package.json, tsconfig.json) for sequential handling
4. Create task list with clear ownership

**Output:** Subtask definitions with file ownership assignments

## Phase 2: File Partitioning

Create exclusive ownership map:

```
Worker 1: src/api/**     (exclusive)
Worker 2: src/ui/**      (exclusive)
Worker 3: src/db/**      (exclusive)
Worker 4: docs/**        (exclusive)
Worker 5: tests/**       (exclusive)
SHARED:   package.json, tsconfig.json (sequential)
```

**Rule:** No two workers can touch the same files

## Phase 3: Parallel Execution

Spawn workers using Task tool with `run_in_background: true`:

```
Task(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  run_in_background=true,
  prompt="ULTRAPILOT WORKER [1/5]

OWNED FILES: src/api/**
TASK: [specific subtask]

You have EXCLUSIVE ownership of these files.
DO NOT touch files outside your ownership.
Signal WORKER_COMPLETE when done."
)
```

**Critical Rules:**
- Maximum 5 parallel workers (Claude Code limit)
- Each worker owns exclusive file set
- Monitor via TaskOutput
- Handle failures by reassigning or fixing

## Phase 4: Integration

After all workers complete:

1. Handle shared files (package.json, configs) sequentially
2. Resolve any integration issues
3. Ensure all pieces work together

## Phase 5: Validation

Spawn Architect for full system verification:

```
Task(
  subagent_type="oh-my-claudecode:architect",
  model="opus",
  prompt="ULTRAPILOT VALIDATION

Verify the complete implementation:
1. All subtasks completed successfully
2. No integration conflicts
3. System works as a whole
4. Tests pass (if applicable)"
)
```

## Delegation Rules (MANDATORY)

**YOU ARE A COORDINATOR, NOT AN IMPLEMENTER.**

| Action | YOU Do | DELEGATE |
|--------|--------|----------|
| Decompose task | ✓ | |
| Partition files | ✓ | |
| Spawn workers | ✓ | |
| Track progress | ✓ | |
| **ANY code change** | ✗ NEVER | executor workers |

**Path Exception**: Only write to `.omc/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`

## State Management

Track state in `.omc/ultrapilot-state.json`:

```json
{
  "active": true,
  "mode": "ultrapilot",
  "workers": [
    {"id": "w1", "status": "running", "files": ["src/api/**"], "task_id": "..."},
    {"id": "w2", "status": "complete", "files": ["src/ui/**"], "task_id": "..."}
  ],
  "shared_files": ["package.json", "tsconfig.json"],
  "phase": "parallel_execution"
}
```

## Completion

When all phases complete and Architect validates, run `/oh-my-claudecode:cancel` to cleanly exit ultrapilot and clean up state files.

Then display summary with:
- Time savings vs sequential
- Workers spawned
- Files modified per worker
- Final validation status
