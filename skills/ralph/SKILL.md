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

Ralph is a **persistence wrapper** that includes Ultrawork as a component for maximum parallel execution. You MUST follow these rules:

### Parallel Execution Rules
- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially
- **BACKGROUND FIRST**: Use Task(run_in_background=true) for long operations (10+ concurrent)
- **DELEGATE**: Route tasks to specialist agents immediately

### Smart Model Routing (SAVE TOKENS)

| Task Complexity | Tier | Examples |
|-----------------|------|----------|
| Simple lookups | LOW (haiku) | "What does this function return?", "Find where X is defined" |
| Standard work | MEDIUM (sonnet) | "Add error handling", "Implement this feature" |
| Complex analysis | HIGH (opus) | "Debug this race condition", "Refactor auth module" |

### Available Agents by Tier

**FIRST ACTION:** Before delegating any work, read the agent reference file:
```
Read file: docs/shared/agent-tiers.md
```
This provides the complete agent tier matrix, MCP tool assignments, and selection guidance.

**CRITICAL: Always pass `model` parameter explicitly!**
```
Task(subagent_type="oh-my-claudecode:architect-low", model="haiku", prompt="...")
Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")
Task(subagent_type="oh-my-claudecode:architect", model="opus", prompt="...")
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
4. **ONLY THEN**: Proceed to Architect verification

### Red Flags (STOP and verify)
- Using "should", "probably", "seems to"
- About to output completion without fresh evidence
- Expressing satisfaction before verification

### Evidence Chain
1. Fresh test run output showing pass
2. Fresh build output showing success
3. lsp_diagnostics showing 0 errors
4. THEN Architect verification
5. THEN completion promise

**Skipping verification = Task NOT complete**

## VERIFICATION PROTOCOL (TIERED)

Ralph uses tiered verification to save tokens while maintaining quality.

### Verification Tier Selection

Before spawning architect for verification, determine the appropriate tier:

| Change Profile | Tier | Agent |
|----------------|------|-------|
| <5 files, <100 lines, full tests | LIGHT | architect-low (haiku) |
| Standard changes | STANDARD | architect-medium (sonnet) |
| >20 files, security/architectural | THOROUGH | architect (opus) |

### Ralph Minimum Verification Tier

**Floor: STANDARD (architect-medium / sonnet)**

Even for small changes (<5 files), ralph requires at least STANDARD tier verification. The LIGHT tier (haiku) is insufficient for ralph's completion guarantee. When tier selection returns LIGHT, upgrade to STANDARD.

### Verification Flow

1. **Collect change metadata**: Count files, lines, detect security/architectural patterns
2. **Select tier**: Apply rules from `/docs/shared/verification-tiers.md`
3. **Spawn appropriate architect**:
   ```
   // LIGHT - small, well-tested changes
   Task(subagent_type="oh-my-claudecode:architect-low", model="haiku", prompt="Quick verification: [describe changes]")

   // STANDARD - most changes
   Task(subagent_type="oh-my-claudecode:architect-medium", model="sonnet", prompt="Verify implementation: [describe changes]")

   // THOROUGH - large/security/architectural changes
   Task(subagent_type="oh-my-claudecode:architect", model="opus", prompt="Full verification: [describe changes]")
   ```
4. **Wait for verdict**
5. **If approved**: Run `/oh-my-claudecode:cancel` to cleanly exit
6. **If rejected**: Fix issues and re-verify (same tier)

For complete tier selection rules, read: `docs/shared/verification-tiers.md`

## ZERO TOLERANCE

- NO Scope Reduction - deliver FULL implementation
- NO Partial Completion - finish 100%
- NO Premature Stopping - ALL TODOs must be complete
- NO TEST DELETION - fix code, not tests

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Use the cancel skill for proper state cleanup**

When work is complete and Architect verification passes, run `/oh-my-claudecode:cancel` to cleanly exit ralph mode. This handles:
- Deletion of ralph state files (both local and global)
- Cleanup of linked ultrawork or ecomode state
- Proper termination of the ralph loop

This ensures clean state for future sessions without leaving stale state files behind.

## INSTRUCTIONS

- Review your progress so far
- Continue from where you left off
- Use parallel execution and background tasks
- When FULLY complete AND Architect verified: Run `/oh-my-claudecode:cancel` to cleanly exit and clean up all state files
- Do not stop until the task is truly done

Original task:
{{PROMPT}}
