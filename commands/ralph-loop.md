---
description: Start self-referential development loop until task completion
---

[RALPH LOOP ACTIVATED - INFINITE PERSISTENCE MODE]

$ARGUMENTS

## THE RALPH OATH

You have entered the Ralph Loop - an INESCAPABLE development cycle that binds you to your task until VERIFIED completion. There is no early exit. There is no giving up. The only way out is through.

## How The Loop Works

1. **WORK CONTINUOUSLY** - Break tasks into todos, execute systematically
2. **VERIFY THOROUGHLY** - Test, check, confirm every completion claim
3. **PROMISE COMPLETION** - ONLY output `<promise>DONE</promise>` when 100% verified
4. **AUTO-CONTINUATION** - If you stop without the promise, YOU WILL BE REMINDED TO CONTINUE

## The Promise Mechanism

The `<promise>DONE</promise>` tag is a SACRED CONTRACT. You may ONLY output it when:

✓ ALL todo items are marked 'completed'
✓ ALL requested functionality is implemented AND TESTED
✓ ALL errors have been resolved
✓ You have VERIFIED (not assumed) completion

**LYING IS DETECTED**: If you output the promise prematurely, your incomplete work will be exposed and you will be forced to continue.

## Exit Conditions

| Condition | What Happens |
|-----------|--------------|
| `<promise>DONE</promise>` | Loop ends - work verified complete |
| User runs `/cancel-ralph` | Loop cancelled by user |
| Max iterations (100) | Safety limit reached |
| Stop without promise | **CONTINUATION FORCED** |

## Continuation Enforcement

If you attempt to stop without the promise tag:

> [RALPH LOOP CONTINUATION] You stopped without completing your promise. The task is NOT done. Continue working on incomplete items. Do not stop until you can truthfully output `<promise>DONE</promise>`.

## Working Style

1. **Create Todo List First** - Map out ALL subtasks
2. **Execute Systematically** - One task at a time, verify each
3. **Delegate to Specialists** - Use subagents for specialized work
4. **Parallelize When Possible** - Multiple agents for independent tasks
5. **Verify Before Promising** - Test everything before the promise

## The Ralph Verification Checklist

Before outputting `<promise>DONE</promise>`, verify:

- [ ] Todo list shows 100% completion
- [ ] All code changes compile/run without errors
- [ ] All tests pass (if applicable)
- [ ] User's original request is FULLY addressed
- [ ] No obvious bugs or issues remain
- [ ] You have TESTED the changes, not just written them

**If ANY checkbox is unchecked, DO NOT output the promise. Continue working.**

## VERIFICATION PROTOCOL (MANDATORY)

**You CANNOT declare task complete without proper verification.**

### Step 1: Oracle Review
```
Task(subagent_type="oracle", prompt="VERIFY COMPLETION:
Original task: [describe the task]
What I implemented: [list changes]
Tests run: [test results]
Please verify this is truly complete and production-ready.")
```

### Step 2: Runtime Verification (Choose ONE)

**Option A: Standard Test Suite (PREFERRED)**
If the project has tests (npm test, pytest, cargo test, etc.):
```bash
npm test  # or pytest, go test, etc.
```
Use this when existing tests cover the functionality.

**Option B: QA-Tester (ONLY when needed)**
Use qa-tester ONLY when ALL of these apply:
- ✗ No existing test suite covers the behavior
- ✓ Requires interactive CLI input/output
- ✓ Needs service startup/shutdown verification
- ✓ Tests streaming, real-time, or tmux-specific behavior

```
Task(subagent_type="qa-tester", prompt="VERIFY BEHAVIOR: ...")
```

**Gating Rule**: If `npm test` (or equivalent) passes, you do NOT need qa-tester.

### Step 3: Based on Verification Results
- **If Oracle APPROVED + Tests/QA-Tester PASS**: Output `<promise>DONE</promise>`
- **If any REJECTED/FAILED**: Fix issues and re-verify

**NO PROMISE WITHOUT VERIFICATION.**

---

Begin working on the task now. The loop will not release you until you earn your `<promise>DONE</promise>`.
