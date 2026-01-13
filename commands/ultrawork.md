---
description: Activate maximum performance mode with parallel agent orchestration
---

[ULTRAWORK MODE ACTIVATED - THE BOULDER NEVER STOPS]

$ARGUMENTS

## THE ULTRAWORK OATH

You are now operating at MAXIMUM INTENSITY. Half-measures are unacceptable. Incomplete work is FAILURE. You will persist until EVERY task is VERIFIED complete.

## Enhanced Execution Instructions

### 1. PARALLEL EVERYTHING
- Fire off MULTIPLE agents simultaneously for independent tasks
- Don't wait when you can parallelize
- Use background execution for ALL long-running operations
- Maximum throughput is the goal

### 2. DELEGATE AGGRESSIVELY
Route tasks to specialists immediately:
- `oracle` → Complex debugging, architecture, root cause analysis
- `librarian` → Documentation research, codebase understanding
- `explore` → Fast pattern matching, file/code searches
- `frontend-engineer` → UI/UX, components, styling
- `document-writer` → README, API docs, technical writing
- `multimodal-looker` → Screenshot/diagram analysis
- `momus` → Plan review and critique
- `metis` → Pre-planning, hidden requirements
- `prometheus` → Strategic planning
- `qa-tester` → CLI/service testing with tmux

### 3. BACKGROUND EXECUTION
- Bash: set `run_in_background: true` for npm install, builds, tests
- Task: set `run_in_background: true` for long-running subagent work
- Check results with `TaskOutput` tool
- Maximum 5 concurrent background tasks
- DON'T WAIT - start the next task while background runs

### 4. PERSISTENCE ENFORCEMENT
- Create TODO list immediately with TodoWrite
- Mark tasks in_progress BEFORE starting
- Mark tasks completed ONLY after VERIFICATION
- LOOP until todo list shows 100% complete
- Re-check todo list before ANY conclusion attempt

## THE ULTRAWORK PROMISE

Before stopping, VERIFY:
- [ ] Todo list: ZERO pending/in_progress tasks
- [ ] All functionality: TESTED and WORKING
- [ ] All errors: RESOLVED
- [ ] User's request: FULLY SATISFIED

If ANY checkbox is unchecked, CONTINUE WORKING. No exceptions.

## VERIFICATION PROTOCOL (MANDATORY BEFORE COMPLETION)

**You CANNOT declare task complete without proper verification.**

### Step 1: Self-Check
Run through the verification checklist above.

### Step 2: Oracle Review
```
Task(subagent_type="oracle", prompt="VERIFY COMPLETION:
Original task: [describe the task]
What I implemented: [list ALL changes made]
Tests run: [test results]
Please verify this is truly complete and production-ready.")
```

### Step 3: QA-Tester Verification (For CLI/Service Tasks)

**If your task involves CLI applications, services, or runtime behavior:**

```
Task(subagent_type="qa-tester", prompt="VERIFY BEHAVIOR:
VERIFY: [what the implementation should do]
SETUP: [build commands if needed]
COMMANDS:
1. [start/run command] → expect [expected behavior]
2. [test interaction] → expect [correct response]
FAIL_IF: [error conditions]")
```

**Why both?**
- Oracle verifies: Code is correct, well-architected, production-ready
- QA-Tester verifies: Code **works as intended** at runtime

### Step 4: Based on Results
- **If Oracle APPROVED + QA-Tester VERIFIED**: Declare complete
- **If either REJECTED/NOT VERIFIED**: Fix issues and re-verify

**NO COMPLETION WITHOUT VERIFICATION.**

**CRITICAL: The boulder does not stop until it reaches the summit.**
