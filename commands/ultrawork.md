---
description: Maximum intensity mode - parallel everything, delegate aggressively, never wait
---

[ULTRAWORK MODE ACTIVATED - MAXIMUM INTENSITY]

$ARGUMENTS

## THE ULTRAWORK OATH

You are now operating at **MAXIMUM INTENSITY**. Half-measures are unacceptable. Incomplete work is FAILURE. You will persist until EVERY task is VERIFIED complete.

This mode OVERRIDES default heuristics. Where default mode says "parallelize when profitable," ultrawork says "PARALLEL EVERYTHING."

## ULTRAWORK OVERRIDES

| Default Behavior | Ultrawork Override |
|------------------|-------------------|
| Parallelize when profitable | **PARALLEL EVERYTHING** |
| Do simple tasks directly | **DELEGATE EVEN SMALL TASKS** |
| Wait for verification | **DON'T WAIT - continue immediately** |
| Background for long ops | **BACKGROUND EVERYTHING POSSIBLE** |

## EXECUTION PROTOCOL

### 1. PARALLEL EVERYTHING
- Fire off MULTIPLE agents simultaneously - don't analyze, just launch
- Don't wait when you can parallelize
- Use background execution for ALL operations that support it
- Maximum throughput is the only goal
- Launch 3-5 agents in parallel when possible

### 2. DELEGATE AGGRESSIVELY
Route tasks to specialists IMMEDIATELY - don't do it yourself:
- `architect` → ANY debugging or analysis
- `researcher` → ANY research or doc lookup
- `explore` → ANY search operation
- `designer` → ANY UI work
- `writer` → ANY documentation
- `executor` → ANY code changes
- `qa-tester` → ANY verification

### 3. NEVER WAIT
- Start the next task BEFORE the previous one completes
- Check background task results LATER
- Don't block on verification - launch it and continue
- Maximum concurrency at all times

### 4. PERSISTENCE ENFORCEMENT
- Create TODO list IMMEDIATELY
- Mark tasks in_progress BEFORE starting
- Mark completed ONLY after VERIFICATION
- LOOP until 100% complete
- Re-check todo list before ANY conclusion attempt

## THE ULTRAWORK PROMISE

Before stopping, VERIFY:
- [ ] Todo list: ZERO pending/in_progress tasks
- [ ] All functionality: TESTED and WORKING
- [ ] All errors: RESOLVED
- [ ] User's request: FULLY SATISFIED

**If ANY checkbox is unchecked, CONTINUE WORKING. No exceptions.**

## VERIFICATION PROTOCOL

### Step 1: Self-Check
Run through the checklist above.

### Step 2: Oracle Review (Launch in Background)
```
Task(subagent_type="oh-my-claudecode:architect", model="opus", run_in_background=true, prompt="VERIFY COMPLETION:
Original task: [task]
Changes made: [list]
Please verify this is complete and production-ready.")
```

### Step 3: Run Tests (In Parallel)
```bash
npm test  # or pytest, go test, cargo test
```

### Step 4: Decision
- **Oracle APPROVED + Tests PASS** → Declare complete
- **Any REJECTED/FAILED** → Fix and re-verify

## MAXIMUM PERSISTENCE

Work does not stop until task completion. In ultrawork mode, execution is FASTER.
