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
2. **Partitions** files with exclusive ownership (no conflicts)
3. **Spawns** up to 20 parallel workers
4. **Coordinates** progress via TaskOutput
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
   Decomposition + File Partitioning
           |
   +-------+-------+-------+-------+
   |       |       |       |       |
   v       v       v       v       v
[W-1]   [W-2]   [W-3]   [W-4]   [W-5]
backend frontend database api-docs tests
(src/  (src/   (src/    (docs/)  (tests/)
 api/)  ui/)    db/)
   |       |       |       |       |
   +---+---+---+---+---+---+---+---+
       |
       v
  [INTEGRATION PHASE]
  (shared files: package.json, tsconfig.json, etc.)
       |
       v
  [VALIDATION PHASE]
  (full system test)
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

**Agent:** Architect (Opus)

**Method:** AI-Powered Task Decomposition

Ultrapilot uses the `decomposer` module to generate intelligent task breakdowns:

```typescript
import {
  generateDecompositionPrompt,
  parseDecompositionResult,
  validateFileOwnership,
  extractSharedFiles
} from 'src/hooks/ultrapilot/decomposer';

// 1. Generate prompt for Architect
const prompt = generateDecompositionPrompt(task, codebaseContext, {
  maxSubtasks: 5,
  preferredModel: 'sonnet'
});

// 2. Call Architect agent
const response = await Task({
  subagent_type: 'oh-my-claudecode:architect',
  model: 'opus',
  prompt
});

// 3. Parse structured result
const result = parseDecompositionResult(response);

// 4. Validate no file conflicts
const { isValid, conflicts } = validateFileOwnership(result.subtasks);

// 5. Extract shared files from subtasks
const finalResult = extractSharedFiles(result);
```

**Process:**
1. Analyze task requirements via Architect agent
2. Identify independent components with file boundaries
3. Assign agent type (executor-low/executor/executor-high) per complexity
4. Map dependencies between subtasks (blockedBy)
5. Generate parallel execution groups
6. Identify shared files (handled by coordinator)

**Output:** Structured `DecompositionResult`:

```json
{
  "subtasks": [
    {
      "id": "1",
      "description": "Backend API routes",
      "files": ["src/api/routes.ts", "src/api/handlers.ts"],
      "blockedBy": [],
      "agentType": "executor",
      "model": "sonnet"
    },
    {
      "id": "2",
      "description": "Frontend components",
      "files": ["src/ui/App.tsx", "src/ui/TodoList.tsx"],
      "blockedBy": [],
      "agentType": "executor",
      "model": "sonnet"
    },
    {
      "id": "3",
      "description": "Wire frontend to backend",
      "files": ["src/client/api.ts"],
      "blockedBy": ["1", "2"],
      "agentType": "executor-low",
      "model": "haiku"
    }
  ],
  "sharedFiles": [
    "package.json",
    "tsconfig.json",
    "README.md"
  ],
  "parallelGroups": [["1", "2"], ["3"]]
}
```

**Decomposition Types:**

| Type | Description | Use Case |
|------|-------------|----------|
| `DecomposedTask` | Full task with id, files, blockedBy, agentType, model | Intelligent worker spawning |
| `DecompositionResult` | Complete result with subtasks, sharedFiles, parallelGroups | Full decomposition output |
| `toSimpleSubtasks()` | Convert to string[] for legacy compatibility | Simple task lists |

### Phase 2: File Ownership Partitioning

**Goal:** Assign exclusive file sets to workers

**Rules:**
1. **Exclusive ownership** - No file in multiple worker sets
2. **Shared files deferred** - Handled sequentially in integration
3. **Boundary files tracked** - Files that import across boundaries

**Data Structure:** `.omc/state/ultrapilot-ownership.json`

```json
{
  "sessionId": "ultrapilot-20260123-1234",
  "workers": {
    "worker-1": {
      "ownedFiles": ["src/api/routes.ts", "src/api/handlers.ts"],
      "ownedGlobs": ["src/api/**"],
      "boundaryImports": ["src/types.ts"]
    },
    "worker-2": {
      "ownedFiles": ["src/ui/App.tsx", "src/ui/TodoList.tsx"],
      "ownedGlobs": ["src/ui/**"],
      "boundaryImports": ["src/types.ts"]
    }
  },
  "sharedFiles": ["package.json", "tsconfig.json", "src/types.ts"],
  "conflictPolicy": "coordinator-handles"
}
```

### Phase 3: Parallel Execution

**Goal:** Run all workers simultaneously

**Spawn Workers:**
```javascript
// Pseudocode
workers = [];
for (subtask in decomposition.subtasks) {
  workers.push(
    Task(
      subagent_type: "oh-my-claudecode:executor",
      model: "sonnet",
      prompt: `ULTRAPILOT WORKER ${subtask.id}

Your exclusive file ownership: ${subtask.files}

Task: ${subtask.description}

CRITICAL RULES:
1. ONLY modify files in your ownership set
2. If you need to modify a shared file, document the change in your output
3. Do NOT create new files outside your ownership
4. Track all imports from boundary files

Deliver: Code changes + list of boundary dependencies`,
      run_in_background: true
    )
  );
}
```

**Monitoring:**
- Poll TaskOutput for each worker
- Track completion status
- Detect conflicts early
- Accumulate boundary dependencies

**Max Workers:** 5 (Claude Code limit)

### Phase 4: Integration

**Goal:** Merge all worker changes and handle shared files

**Process:**
1. **Collect outputs** - Gather all worker deliverables
2. **Detect conflicts** - Check for unexpected overlaps
3. **Handle shared files** - Sequential updates to package.json, etc.
4. **Integrate boundary files** - Merge type definitions, shared utilities
5. **Resolve imports** - Ensure cross-boundary imports are valid

**Agent:** Executor (Sonnet) - sequential processing

**Conflict Resolution:**
- If workers unexpectedly touched same file → manual merge
- If shared file needs multiple changes → sequential apply
- If boundary file changed → validate all dependent workers

### Phase 5: Validation

**Goal:** Verify integrated system works

**Checks (parallel):**
1. **Build** - Run the project's build command
2. **Lint** - Run the project's lint command
3. **Type check** - Run the project's type check command
4. **Unit tests** - All tests pass
5. **Integration tests** - Cross-component tests

**Agents (parallel):**
- Build-fixer (Sonnet) - Fix build errors
- Architect (Opus) - Functional completeness
- Security-reviewer (Opus) - Cross-component vulnerabilities

**Retry Policy:** Up to 3 validation rounds. If failures persist, detailed error report to user.

## State Management

### Session State

**Location:** `.omc/ultrapilot-state.json`

```json
{
  "sessionId": "ultrapilot-20260123-1234",
  "taskDescription": "Build a full-stack todo app",
  "phase": "execution",
  "startTime": "2026-01-23T10:30:00Z",
  "decomposition": { /* from Phase 1 */ },
  "workers": {
    "worker-1": {
      "status": "running",
      "taskId": "task-abc123",
      "startTime": "2026-01-23T10:31:00Z",
      "estimatedDuration": "5m"
    }
  },
  "conflicts": [],
  "validationAttempts": 0
}
```

### File Ownership Map

**Location:** `.omc/state/ultrapilot-ownership.json`

Tracks which worker owns which files (see Phase 2 example above).

### Progress Tracking

**Location:** `.omc/ultrapilot/progress.json`

```json
{
  "totalWorkers": 5,
  "completedWorkers": 3,
  "activeWorkers": 2,
  "failedWorkers": 0,
  "estimatedTimeRemaining": "2m30s"
}
```

## Configuration

Optional settings in `.claude/settings.json`:

```json
{
  "omc": {
    "ultrapilot": {
      "maxWorkers": 5,
      "maxValidationRounds": 3,
      "conflictPolicy": "coordinator-handles",
      "fallbackToAutopilot": true,
      "parallelThreshold": 2,
      "pauseAfterDecomposition": false,
      "verboseProgress": true
    }
  }
}
```

**Settings Explained:**
- `maxWorkers` - Max parallel workers (5 is Claude Code limit)
- `maxValidationRounds` - Validation retry attempts
- `conflictPolicy` - "coordinator-handles" or "abort-on-conflict"
- `fallbackToAutopilot` - Auto-switch if task not parallelizable
- `parallelThreshold` - Min subtasks to use ultrapilot (else fallback)
- `pauseAfterDecomposition` - Confirm with user before execution
- `verboseProgress` - Show detailed worker progress

## Cancellation

```
/oh-my-claudecode:cancel
```

Or say: "stop", "cancel ultrapilot", "abort"

**Behavior:**
- All active workers gracefully terminated
- Partial progress saved to state file
- Session can be resumed

## Resume

If ultrapilot was cancelled or a worker failed:

```
/oh-my-claudecode:ultrapilot resume
```

**Resume Logic:**
- Restart failed workers only
- Re-use completed worker outputs
- Continue from last phase

## Examples

### Example 1: Full-Stack App

```
/oh-my-claudecode:ultrapilot Build a todo app with React frontend, Express backend, and PostgreSQL database
```

**Workers:**
1. Frontend (src/client/)
2. Backend (src/server/)
3. Database (src/db/)
4. Tests (tests/)
5. Docs (docs/)

**Shared Files:** package.json, docker-compose.yml, README.md

**Duration:** ~15 minutes (vs ~75 minutes sequential)

### Example 2: Multi-Service Refactor

```
/oh-my-claudecode:up Refactor all services to use dependency injection
```

**Workers:**
1. Auth service
2. User service
3. Payment service
4. Notification service

**Shared Files:** src/types/services.ts, tsconfig.json

**Duration:** ~8 minutes (vs ~32 minutes sequential)

### Example 3: Test Coverage

```
/oh-my-claudecode:ultrapilot Generate tests for all untested modules
```

**Workers:**
1. API tests
2. UI component tests
3. Database tests
4. Utility tests
5. Integration tests

**Shared Files:** jest.config.js, test-utils.ts

**Duration:** ~10 minutes (vs ~50 minutes sequential)

## Best Practices

1. **Clear module boundaries** - Works best with well-separated code
2. **Minimal shared state** - Reduces integration complexity
3. **Trust the decomposition** - Architect knows what's parallel-safe
4. **Monitor progress** - Check `.omc/ultrapilot/progress.json`
5. **Review conflicts early** - Don't wait until integration

## File Ownership Strategy

### Ownership Types

**Exclusive Ownership:**
- Worker has sole write access
- No other worker can touch these files
- Worker can create new files in owned directories

**Shared Files:**
- No worker has exclusive access
- Handled sequentially in integration phase
- Includes: package.json, tsconfig.json, config files, root README

**Boundary Files:**
- Can be read by all workers
- Write access determined by usage analysis
- Typically: type definitions, shared utilities, interfaces

### Ownership Detection Algorithm

```
For each file in codebase:
  If file in shared_patterns (package.json, *.config.js):
    → sharedFiles

  Else if file imported by 2+ subtask modules:
    → boundaryFiles
    → Assign to most relevant worker OR defer to shared

  Else if file in subtask directory:
    → Assign to subtask worker

  Else:
    → sharedFiles (safe default)
```

### Shared File Patterns

Automatically classified as shared:
- `package.json`, `package-lock.json`
- `tsconfig.json`, `*.config.js`, `*.config.ts`
- `.eslintrc.*`, `.prettierrc.*`
- `README.md`, `CONTRIBUTING.md`, `LICENSE`
- Docker files: `Dockerfile`, `docker-compose.yml`
- CI files: `.github/**`, `.gitlab-ci.yml`

## Conflict Handling

### Conflict Types

**Unexpected Overlap:**
- Two workers modified the same file
- **Resolution:** Coordinator merges with human confirmation

**Shared File Contention:**
- Multiple workers need to update package.json
- **Resolution:** Sequential application in integration phase

**Boundary File Conflict:**
- Type definition needed by multiple workers
- **Resolution:** First worker creates, others import

### Conflict Policy

**coordinator-handles (default):**
- Coordinator attempts automatic merge
- Falls back to user if complex

**abort-on-conflict:**
- Any conflict immediately cancels ultrapilot
- User reviews conflict report
- Can resume after manual fix

## Troubleshooting

**Decomposition fails?**
- Task may be too coupled
- Fallback to autopilot triggered automatically
- Review `.omc/ultrapilot/decomposition.json` for details

**Worker hangs?**
- Check worker logs in `.omc/logs/ultrapilot-worker-N.log`
- Cancel and restart that worker
- May indicate file ownership issue

**Integration conflicts?**
- Review `.omc/ultrapilot-state.json` conflicts array
- Check if shared files were unexpectedly modified
- Adjust ownership rules if needed

**Validation loops?**
- Cross-component integration issue
- Review boundary imports
- May need sequential retry with full context

**Too slow?**
- Check if workers are truly independent
- Review decomposition quality
- Consider if autopilot would be faster (high interdependency)

## Differences from Autopilot

| Feature | Autopilot | Ultrapilot |
|---------|-----------|------------|
| Execution | Sequential | Parallel (up to 5x) |
| Best For | Single-threaded tasks | Multi-component systems |
| Complexity | Lower | Higher |
| Speed | Standard | 3-5x faster (suitable tasks) |
| File Conflicts | N/A | Ownership partitioning |
| Fallback | N/A | Can fallback to autopilot |
| Setup | Instant | Decomposition phase (~1-2 min) |

**Rule of Thumb:** If task has 3+ independent components, use ultrapilot. Otherwise, use autopilot.

## Advanced: Custom Decomposition

You can provide a custom decomposition file to skip Phase 1:

**Location:** `.omc/ultrapilot/custom-decomposition.json`

```json
{
  "subtasks": [
    {
      "id": "worker-auth",
      "description": "Add OAuth2 authentication",
      "files": ["src/auth/**", "src/middleware/auth.ts"],
      "dependencies": ["src/types/user.ts"]
    },
    {
      "id": "worker-db",
      "description": "Add user table and migrations",
      "files": ["src/db/migrations/**", "src/db/models/user.ts"],
      "dependencies": []
    }
  ],
  "sharedFiles": ["package.json", "src/types/user.ts"]
}
```

Then run:
```
/oh-my-claudecode:ultrapilot --custom-decomposition
```

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Delete state files on completion - do NOT just set `active: false`**

When all workers complete successfully:

```bash
# Delete ultrapilot state files
rm -f .omc/state/ultrapilot-state.json
rm -f .omc/state/ultrapilot-ownership.json
```

## Future Enhancements

**Planned for v4.1:**
- Dynamic worker scaling (start with 2, spawn more if needed)
- Predictive conflict detection (pre-integration analysis)
- Worker-to-worker communication (for rare dependencies)
- Speculative execution (optimistic parallelism)
- Resume from integration phase (if validation fails)

**Planned for v4.2:**
- Multi-machine distribution (if Claude Code supports)
- Real-time progress dashboard
- Worker performance analytics
- Auto-tuning of decomposition strategy
