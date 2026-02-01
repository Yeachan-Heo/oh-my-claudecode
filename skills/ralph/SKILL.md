---
name: ralph
description: Self-referential loop until task completion with architect verification
---

# Ralph Skill

[RALPH + ULTRAWORK - ITERATION {{ITERATION}}/{{MAX}}]

Your previous attempt did not output the completion promise. Continue working on the task.

## PRD MODE (OPTIONAL)

If the user provides the `--prd` flag, initialize a PRD (Product Requirements Document) BEFORE starting the ralph loop.

### Detecting PRD Mode

Check if `{{PROMPT}}` contains the flag pattern: `--prd` or `--PRD`

### PRD Initialization Workflow

When `--prd` flag detected:

1. **Create PRD File Structure** (`.omc/prd.json` and `.omc/progress.txt`)
2. **Parse the task** (everything after `--prd` flag)
3. **Break down into user stories** with this structure:

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name]",
  "description": "[Feature description]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Short title]",
      "description": "As a [user], I want to [action] so that [benefit].",
      "acceptanceCriteria": ["Criterion 1", "Typecheck passes"],
      "priority": 1,
      "passes": false
    }
  ]
}
```

4. **Create progress.txt**:

```
# Ralph Progress Log
Started: [ISO timestamp]

## Codebase Patterns
(No patterns discovered yet)

---
```

5. **Guidelines for PRD creation**:
   - Right-sized stories: Each completable in one focused session
   - Verifiable criteria: Include "Typecheck passes", "Tests pass"
   - Independent stories: Minimize dependencies
   - Priority order: Foundational work (DB, types) before UI

6. **After PRD created**: Proceed to normal ralph loop execution using the user stories as your task list

### Example Usage

User input: `--prd build a todo app with React and TypeScript`

Your workflow:
1. Detect `--prd` flag
2. Extract task: "build a todo app with React and TypeScript"
3. Create `.omc/prd.json` with user stories
4. Create `.omc/progress.txt`
5. Begin ralph loop using user stories as task breakdown

## ULTRAWORK MODE (AUTO-ACTIVATED)

Ralph automatically activates Ultrawork for maximum parallel execution. You MUST follow these rules:

### Parallel Execution Rules
- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially
- **BACKGROUND FIRST**: Use Task(run_in_background=true) for long operations (10+ concurrent)
- **DELEGATE**: Route tasks to agents immediately

### Smart Model Routing (SAVE TOKENS)

| Task Complexity | Model | Examples |
|-----------------|-------|----------|
| Simple lookups | haiku | "What does this function return?", "Find where X is defined" |
| Standard work | sonnet | "Add error handling", "Implement this feature" |
| Complex analysis | opus | "Debug this race condition", "Refactor auth module" |

### Agent Types and Models

| Purpose | Agent Type | Model |
|---------|------------|-------|
| **Codebase Exploration** | `Explore` | haiku or sonnet |
| **Architecture/Planning** | `Plan` | sonnet or opus |
| **Implementation** | `general-purpose` | haiku/sonnet/opus based on complexity |
| **Shell Commands** | `Bash` | N/A |

**CRITICAL: Always pass `model` parameter explicitly!**
```
Task(subagent_type="Explore", model="haiku", prompt="...")
Task(subagent_type="general-purpose", model="sonnet", prompt="...")
Task(subagent_type="Plan", model="opus", prompt="...")
```

### Background Execution Rules

**Run in Background** (set `run_in_background: true`):
- Package installation: npm install, pip install, cargo build
- Build processes: npm run build, make, tsc
- Test suites: npm test, pytest, cargo test
- Docker operations: docker build, docker pull

**Run Blocking** (foreground):
- Quick status checks: git status, ls, pwd
- File reads, edits
- Simple commands

## COMPLETION REQUIREMENTS

Before claiming completion, you MUST:
1. Verify ALL requirements from the original task are met
2. Ensure no partial implementations
3. Check that code compiles/runs without errors
4. Verify tests pass (if applicable)
5. TODO LIST: Zero pending/in_progress tasks

## VERIFICATION BEFORE COMPLETION (IRON LAW)

**NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE**

Before outputting the completion promise:

### Steps (MANDATORY)
1. **IDENTIFY**: What command proves the task is complete?
2. **RUN**: Execute verification (test, build, lint)
3. **READ**: Check output - did it actually pass?
4. **ONLY THEN**: Proceed to verification

### Red Flags (STOP and verify)
- Using "should", "probably", "seems to"
- About to output completion without fresh evidence
- Expressing satisfaction before verification

### Evidence Chain
1. Fresh test run output showing pass
2. Fresh build output showing success
3. lsp_diagnostics showing 0 errors
4. THEN Plan agent verification
5. THEN completion promise

**Skipping verification = Task NOT complete**

## ARCHITECT VERIFICATION (MANDATORY)

When you believe the task is complete:
1. **First**, spawn Plan agent to verify your work (ALWAYS pass model explicitly!):
   ```
   Task(subagent_type="Plan", model="opus", prompt="Verify this implementation is complete: [describe what you did]")
   ```

2. **Wait for assessment**

3. **If approved**: Output `<promise>{{PROMISE}}</promise>`
4. **If issues found**: Fix them, then repeat verification

DO NOT output the completion promise without verification.

## ZERO TOLERANCE

- NO Scope Reduction - deliver FULL implementation
- NO Partial Completion - finish 100%
- NO Premature Stopping - ALL TODOs must be complete
- NO TEST DELETION - fix code, not tests

## Valid Agent Types

| Type | Use For |
|------|---------|
| `general-purpose` | All implementation work (DEFAULT) |
| `Explore` | Codebase exploration, finding files |
| `Plan` | Architecture and planning, verification |
| `Bash` | Shell commands only |

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Delete state files on successful completion - do NOT just set `active: false`**

When outputting the completion promise after verification:

```bash
# Delete ralph state file (and linked ultrawork if applicable)
rm -f .omc/state/ralph-state.json
rm -f .omc/state/ralph-verification.json
rm -f ~/.claude/ralph-state.json

# If ultrawork was linked, delete it too
rm -f .omc/state/ultrawork-state.json
rm -f ~/.claude/ultrawork-state.json
```

This ensures clean state for future sessions. Stale state files with `active: false` should not be left behind.

## INSTRUCTIONS

- Review your progress so far
- Continue from where you left off
- Use parallel execution and background tasks
- When FULLY complete AND verified:
  1. Clean up state files (delete ralph-state.json, ultrawork-state.json)
  2. Output: <promise>{{PROMISE}}</promise>
- Do not stop until the task is truly done

Original task:
{{PROMPT}}
