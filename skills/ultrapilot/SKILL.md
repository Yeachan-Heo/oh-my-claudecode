---
name: ultrapilot
description: Parallel autopilot with file ownership partitioning
---

# Ultrapilot Skill

Parallel autopilot that spawns multiple workers with file ownership partitioning for maximum speed.

## Overview

Ultrapilot is the parallel evolution of autopilot. It decomposes your task into independent parallelizable subtasks, assigns non-overlapping file sets to each worker, and runs them simultaneously.

**Key Capabilities:**
1. **Decomposes** task into parallel-safe components
2. **Partitions** files with exclusive ownership (advisory, not enforced)
3. **Spawns** up to 5 parallel workers using `general-purpose` agents
4. **Coordinates** progress via TaskOutput polling
5. **Integrates** changes with sequential handling of shared files
6. **Validates** full system integrity

**Speed Multiplier:** Up to 5x faster than sequential autopilot for suitable tasks.

## Usage

```
/oh-my-claudecode:ultrapilot <your task>
/oh-my-claudecode:up "Build a full-stack todo app"
/oh-my-claudecode:ultrapilot Refactor the entire backend
```

## Magic Keywords

These phrases auto-activate ultrapilot:
- "ultrapilot", "ultra pilot"
- "parallel build", "parallel autopilot"
- "swarm build", "swarm mode"
- "fast parallel", "ultra fast"

## When to Use

**Ultrapilot Excels At:**
- Multi-component systems (frontend + backend + database)
- Independent feature additions across different modules
- Large refactorings with clear module boundaries
- Parallel test file generation
- Multi-service architectures

**Autopilot Better For:**
- Single-threaded sequential tasks
- Heavy interdependencies between components
- Tasks requiring constant integration checks
- Small focused features in a single module

## Architecture

```
User Input: "Build a full-stack todo app"
           |
           v
  [ULTRAPILOT COORDINATOR]
           |
   Decomposition (coordinator does this)
           |
   +-------+-------+-------+-------+
   |       |       |       |       |
   v       v       v       v       v
[W-1]   [W-2]   [W-3]   [W-4]   [W-5]
general-purpose agents (run_in_background)
backend frontend database api-docs tests
   |       |       |       |       |
   +---+---+---+---+---+---+---+---+
       |
       v
  [INTEGRATION PHASE]
  (coordinator handles shared files)
       |
       v
  [VALIDATION PHASE]
  (general-purpose agent)
```

## Phases

### Phase 0: Task Analysis

**Goal:** Determine if task is parallelizable

**Checks:**
- Can task be split into 2+ independent subtasks?
- Are file boundaries clear?
- Are dependencies minimal?

**Output:** Go/No-Go decision (falls back to autopilot if unsuitable)

### Phase 1: Decomposition

**Goal:** Break task into parallel-safe subtasks

**Agent:** Coordinator does this directly (may use Explore agent for codebase understanding)

**Process:**
1. Analyze task requirements
2. Identify independent components with file boundaries
3. Assign model tier (haiku/sonnet) per complexity
4. Map dependencies between subtasks
5. Generate parallel execution plan
6. Identify shared files (handled by coordinator)

**Output:**

```
DECOMPOSITION COMPLETE
======================
Subtask 1: Create Express API routes for todo CRUD
  Files: src/server/routes/**, src/server/controllers/**
  Model: sonnet

Subtask 2: Create React components for todo list UI
  Files: src/client/components/**, src/client/hooks/**
  Model: sonnet

Subtask 3: Create database schema and migrations
  Files: src/db/**
  Model: haiku

Subtask 4: Wire up API client in frontend
  Files: src/client/api/**
  Model: haiku
  Depends on: 1, 2

SHARED FILES (coordinator handles):
  - package.json
  - tsconfig.json
  - src/types/todo.ts
```

### Phase 2: File Ownership Partitioning

**Goal:** Assign exclusive file sets to workers

**Rules:**
1. **Exclusive ownership** - No file in multiple worker sets
2. **Shared files deferred** - Handled sequentially by coordinator
3. **Advisory enforcement** - Workers are instructed not to cross boundaries

**Data Structure:**

```
Worker 1: src/server/**     (exclusive)
Worker 2: src/client/components/**, src/client/hooks/**  (exclusive)
Worker 3: src/db/**         (exclusive)
Worker 4: src/client/api/** (exclusive)
SHARED:   package.json, tsconfig.json, src/types/**
```

### Phase 3: Parallel Execution

**Goal:** Run all workers simultaneously

**CRITICAL: Spawn all workers in ONE message for true parallelism**

```javascript
// All in single message:
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  run_in_background: true,
  prompt: "ULTRAPILOT WORKER [1/4]\n\nYOUR EXCLUSIVE FILES: src/server/**\n..."
)

Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  run_in_background: true,
  prompt: "ULTRAPILOT WORKER [2/4]\n\nYOUR EXCLUSIVE FILES: src/client/components/**..."
)

// ... more workers in same message
```

**Monitoring:**
- Use TaskOutput with `block: false` to check status
- Poll periodically until all workers complete
- Collect any SHARED_FILE_REQUESTs from outputs

**Max Workers:** 5 (practical limit for coordination)

### Phase 4: Integration

**Goal:** Merge all worker changes and handle shared files

**Process:**
1. **Collect outputs** - Gather all worker deliverables via TaskOutput
2. **Process SHARED_FILE_REQUESTs** - Apply requested changes to package.json, etc.
3. **Handle shared files** - Coordinator makes sequential updates
4. **Resolve conflicts** - If workers touched unexpected files, merge manually

**Conflict Resolution:**
- If workers unexpectedly touched same file → coordinator reviews and fixes
- If shared file needs multiple changes → apply sequentially
- If type definition changed → ensure all workers' code is compatible

### Phase 5: Validation

**Goal:** Verify integrated system works

**Checks:**
1. **Build** - `npm run build` or equivalent
2. **Type check** - `tsc --noEmit`
3. **Tests** - Run test suite if present
4. **Lint** - Check for lint errors

**Agent:**

```javascript
Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: "ULTRAPILOT VALIDATION\n\nVerify the complete implementation..."
)
```

**Retry Policy:** Up to 3 validation rounds. If failures persist, detailed error report to user.

## Valid Subagent Types

**IMPORTANT:** Only use these built-in Claude Code agent types:

| Type | Use For |
|------|---------|
| `general-purpose` | Implementation work (DEFAULT for all workers) |
| `Explore` | Codebase exploration, understanding structure |
| `Plan` | Architecture planning, design decisions |
| `Bash` | Running shell commands only |

**Model tiers:**
| Model | Use For |
|-------|---------|
| `haiku` | Simple tasks, tests, docs, low complexity |
| `sonnet` | Standard implementation (DEFAULT) |
| `opus` | Complex architectural decisions |

## Configuration

Optional settings in `.claude/settings.json`:

```json
{
  "omc": {
    "ultrapilot": {
      "maxWorkers": 5,
      "maxValidationRounds": 3,
      "fallbackToAutopilot": true,
      "parallelThreshold": 2,
      "pauseAfterDecomposition": false
    }
  }
}
```

**Settings Explained:**
- `maxWorkers` - Max parallel workers (5 is practical limit)
- `maxValidationRounds` - Validation retry attempts
- `fallbackToAutopilot` - Auto-switch if task not parallelizable
- `parallelThreshold` - Min subtasks to use ultrapilot (else fallback)
- `pauseAfterDecomposition` - Confirm with user before execution

## Cancellation

```
/oh-my-claudecode:cancel
```

Or say: "stop", "cancel ultrapilot", "abort"

**Behavior:**
- Background workers continue until their current operation completes
- Coordinator stops spawning new workers
- Partial progress may be available

## Examples

### Example 1: Full-Stack App

```
/oh-my-claudecode:ultrapilot Build a todo app with React frontend, Express backend, and PostgreSQL database
```

**Workers:**
1. Backend API (src/server/) - sonnet
2. Frontend components (src/client/) - sonnet
3. Database schema (src/db/) - haiku
4. Tests (tests/) - haiku

**Shared Files:** package.json, docker-compose.yml, README.md

### Example 2: Multi-Service Refactor

```
/oh-my-claudecode:up Refactor all services to use dependency injection
```

**Workers:**
1. Auth service - sonnet
2. User service - sonnet
3. Payment service - sonnet
4. Notification service - haiku

**Shared Files:** src/types/services.ts, tsconfig.json

### Example 3: Test Coverage

```
/oh-my-claudecode:ultrapilot Generate tests for all untested modules
```

**Workers:**
1. API tests - haiku
2. UI component tests - haiku
3. Database tests - haiku
4. Utility tests - haiku
5. Integration tests - sonnet

**Shared Files:** jest.config.js, test-utils.ts

## Best Practices

1. **Clear module boundaries** - Works best with well-separated code
2. **Minimal shared state** - Reduces integration complexity
3. **Trust the decomposition** - Review before spawning workers
4. **Monitor progress** - Check TaskOutput periodically
5. **Handle shared files last** - After all workers complete

## File Ownership Strategy

### Ownership Types

**Exclusive Ownership:**
- Worker instructed to only modify these files
- Advisory (relies on prompt instructions)
- Worker can create new files in owned directories

**Shared Files:**
- Coordinator handles exclusively
- Includes: package.json, tsconfig.json, config files
- Workers output SHARED_FILE_REQUEST if they need changes

### Shared File Patterns

Automatically classified as shared:
- `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- `tsconfig.json`, `*.config.js`, `*.config.ts`
- `.eslintrc.*`, `.prettierrc.*`
- `README.md`, `CONTRIBUTING.md`, `LICENSE`
- Docker files: `Dockerfile`, `docker-compose.yml`
- CI files: `.github/**`, `.gitlab-ci.yml`

## Troubleshooting

**Decomposition produces too few subtasks?**
- Task may be too coupled for parallelism
- Consider using regular autopilot instead

**Workers touching each other's files?**
- File ownership is advisory only
- Review decomposition for clearer boundaries
- Coordinator can fix conflicts in integration phase

**Validation keeps failing?**
- Cross-component integration issue
- May need to run fixes sequentially
- Check for missing type definitions or imports

**Workers seem slow?**
- Check if workers are truly independent
- Background agents have some overhead
- For simple tasks, autopilot may be faster

## Differences from Autopilot

| Feature | Autopilot | Ultrapilot |
|---------|-----------|------------|
| Execution | Sequential | Parallel (up to 5x) |
| Best For | Single-threaded tasks | Multi-component systems |
| Complexity | Lower | Higher |
| Speed | Standard | 3-5x faster (suitable tasks) |
| File Conflicts | N/A | Advisory ownership |
| Fallback | N/A | Can fallback to autopilot |
| Setup | Instant | Decomposition phase |

**Rule of Thumb:** If task has 3+ independent components, use ultrapilot. Otherwise, use autopilot.

## STATE CLEANUP ON COMPLETION

**Delete state files when done:**

```bash
rm -f .omc/ultrapilot-state.json
```

## TypeScript Utilities (Reference Only)

The `src/hooks/ultrapilot/` directory contains TypeScript utilities:
- `decomposer.ts` - Decomposition prompt generation and parsing
- `state.ts` - State management helpers
- `types.ts` - TypeScript type definitions

**Note:** These are reference implementations. The actual ultrapilot execution uses prompt-based coordination through Claude Code's Task tool, not direct TypeScript invocation.
