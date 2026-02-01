---
name: ultraqa
description: QA cycling workflow - test, verify, fix, repeat until goal met
---

# UltraQA Skill

[ULTRAQA ACTIVATED - AUTONOMOUS QA CYCLING]

## Overview

You are now in **ULTRAQA** mode - an autonomous QA cycling workflow that runs until your quality goal is met.

**Cycle**: test → diagnosis → fix → repeat

## Goal Parsing

Parse the goal from arguments. Supported formats:

| Invocation | Goal Type | What to Check |
|------------|-----------|---------------|
| `/oh-my-claudecode:ultraqa --tests` | tests | All test suites pass |
| `/oh-my-claudecode:ultraqa --build` | build | Build succeeds with exit 0 |
| `/oh-my-claudecode:ultraqa --lint` | lint | No lint errors |
| `/oh-my-claudecode:ultraqa --typecheck` | typecheck | No TypeScript errors |
| `/oh-my-claudecode:ultraqa --custom "pattern"` | custom | Custom success pattern in output |

If no structured goal provided, interpret the argument as a custom goal.

## Cycle Workflow

### Cycle N (Max 5)

1. **RUN QA**: Execute verification based on goal type
   - `--tests`: Run `npm test` or equivalent
   - `--build`: Run `npm run build` or equivalent
   - `--lint`: Run `npm run lint` or equivalent
   - `--typecheck`: Run `npm run typecheck` or `tsc --noEmit`
   - `--custom`: Run appropriate command and check for pattern
   - `--interactive`: Use general-purpose agent for interactive CLI/service testing:
     ```
     Task(subagent_type="general-purpose", model="sonnet", prompt="TEST:
     Goal: [describe what to verify]
     Service: [how to start]
     Test cases: [specific scenarios to verify]")
     ```

2. **CHECK RESULT**: Did the goal pass?
   - **YES** → Exit with success message
   - **NO** → Continue to step 3

3. **DIAGNOSIS**: Spawn agent to analyze failure
   ```
   Task(subagent_type="general-purpose", model="opus", prompt="DIAGNOSE FAILURE:
   Goal: [goal type]
   Output: [test/build output]
   Provide root cause and specific fix recommendations.")
   ```

4. **FIX ISSUES**: Apply recommendations
   ```
   Task(subagent_type="general-purpose", model="sonnet", prompt="FIX:
   Issue: [diagnosis]
   Files: [affected files]
   Apply the fix precisely as recommended.")
   ```

5. **REPEAT**: Go back to step 1

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Goal Met** | Exit with success: "ULTRAQA COMPLETE: Goal met after N cycles" |
| **Cycle 5 Reached** | Exit with diagnosis: "ULTRAQA STOPPED: Max cycles. Diagnosis: ..." |
| **Same Failure 3x** | Exit early: "ULTRAQA STOPPED: Same failure detected 3 times. Root cause: ..." |
| **Environment Error** | Exit: "ULTRAQA ERROR: [tmux/port/dependency issue]" |

## Observability

Output progress each cycle:
```
[ULTRAQA Cycle 1/5] Running tests...
[ULTRAQA Cycle 1/5] FAILED - 3 tests failing
[ULTRAQA Cycle 1/5] Diagnosing...
[ULTRAQA Cycle 1/5] Fixing: auth.test.ts - missing mock
[ULTRAQA Cycle 2/5] Running tests...
[ULTRAQA Cycle 2/5] PASSED - All 47 tests pass
[ULTRAQA COMPLETE] Goal met after 2 cycles
```

## State Tracking

Track state in `.omc/ultraqa-state.json`:
```json
{
  "active": true,
  "goal_type": "tests",
  "goal_pattern": null,
  "cycle": 1,
  "max_cycles": 5,
  "failures": ["3 tests failing: auth.test.ts"],
  "started_at": "2024-01-18T12:00:00Z",
  "session_id": "uuid"
}
```

## Cancellation

User can cancel with `/oh-my-claudecode:cancel` which clears the state file.

## Important Rules

1. **PARALLEL when possible** - Run diagnosis while preparing potential fixes
2. **TRACK failures** - Record each failure to detect patterns
3. **EARLY EXIT on pattern** - 3x same failure = stop and surface
4. **CLEAR OUTPUT** - User should always know current cycle and status
5. **CLEAN UP** - Clear state file on completion or cancellation

## Valid Agent Types

| Type | Use For |
|------|---------|
| `general-purpose` | Implementation, fixes, testing (DEFAULT) |
| `Explore` | Finding files, understanding codebase |
| `Plan` | Architecture analysis |
| `Bash` | Running commands |

## STATE CLEANUP ON COMPLETION

**IMPORTANT: Delete state files on completion - do NOT just set `active: false`**

When goal is met OR max cycles reached OR exiting early:

```bash
# Delete ultraqa state file
rm -f .omc/state/ultraqa-state.json
```

This ensures clean state for future sessions. Stale state files with `active: false` should not be left behind.

---

Begin ULTRAQA cycling now. Parse the goal and start cycle 1.
