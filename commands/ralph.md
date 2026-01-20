---
name: ralph
description: Start self-referential development loop until task completion
---

[RALPH ACTIVATED - MAXIMUM INTENSITY + COMPLETION GUARANTEE]

$ARGUMENTS

## THE RALPH OATH

You have entered Ralph mode - maximum intensity execution with completion guarantee. This combines:
- **ULTRAWORK**: Maximum intensity, parallel everything, aggressive delegation
- **COMPLETION GUARANTEE**: Inescapable loop until VERIFIED completion

There is no early exit. There is no giving up. The only way out is through.

## STEP 0: PRD INITIALIZATION (MANDATORY)

**Before starting any work, check for prd.json:**

```
IF prd.json does NOT exist in root or .omc/:
  → CREATE prd.json FIRST
  → Break task into discrete user stories
  → Each story must be completable in one focused session
  → Initialize progress.txt for learnings
  → THEN proceed to work
```

### Auto-Initialize PRD

If no `prd.json` exists, you MUST create one before proceeding:

1. **Analyze the task** - Break into small, focused user stories
2. **Create `.omc/prd.json`** with this structure:

```json
{
  "project": "[Project/Feature Name]",
  "branchName": "ralph/[feature-name]",
  "description": "[Task description from user]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Short title]",
      "description": "As a [user], I want [action] so that [benefit].",
      "acceptanceCriteria": [
        "Criterion 1",
        "Criterion 2",
        "Typecheck passes",
        "Tests pass (if applicable)"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

3. **Create `.omc/progress.txt`**:

```
# Ralph Progress Log
Started: [ISO timestamp]

## Codebase Patterns
(No patterns discovered yet)

---

```

4. **Report PRD created**, then begin work on first story

### Right-Sized Stories

Each story should be:
- **Completable in one session** - Not multi-day epics
- **Independently testable** - Can verify without other stories
- **Focused** - Single responsibility

**Good examples:**
- Add a database column and migration
- Create a UI component
- Add an API endpoint
- Implement a specific function

**Too big (split these):**
- "Build the dashboard"
- "Add authentication"
- "Refactor everything"

## How The Loop Works

1. **INITIALIZE PRD** - Create prd.json if not present (see above)
2. **WORK CONTINUOUSLY** - Execute stories systematically
3. **VERIFY THOROUGHLY** - Test, check, confirm every completion claim
4. **PROMISE COMPLETION** - ONLY output `<promise>TASK_COMPLETE</promise>` when 100% verified
5. **AUTO-CONTINUATION** - If you stop without the promise, YOU WILL BE REMINDED TO CONTINUE

## PRD Workflow

Once prd.json exists:

1. **Read prd.json** - Understand all user stories and their status
2. **Read progress.txt** - Check Codebase Patterns section for learnings
3. **Pick highest priority story** where `passes: false`
4. **Implement that single story** - Focus on one story at a time
5. **Run quality checks** - typecheck, lint, test
6. **Update prd.json** - Set `passes: true` for completed story
7. **Append to progress.txt** - Document implementation and learnings
8. **Repeat** until ALL stories have `passes: true`
9. **Output promise** when all stories complete

### Updating progress.txt

After completing each story, append:

```
## [Date] - [Story ID]
- What was implemented
- Files changed
- **Learnings:**
  - Pattern or gotcha discovered
```

If you discover a **reusable pattern**, add it to the `## Codebase Patterns` section at the top.

## The Promise Mechanism

The `<promise>TASK_COMPLETE</promise>` tag is a SACRED CONTRACT. You may ONLY output it when:

✓ ALL stories in prd.json have `passes: true`
✓ ALL acceptance criteria for each story are met
✓ Quality checks pass (typecheck, tests)
✓ progress.txt updated with learnings

**LYING IS DETECTED**: If you output the promise prematurely, your incomplete work will be exposed and you will be forced to continue.

## Exit Conditions

| Condition | What Happens |
|-----------|--------------|
| `<promise>TASK_COMPLETE</promise>` | Loop ends - work verified complete |
| All PRD stories `passes: true` | Loop can end |
| User runs `/cancel-ralph` | Loop cancelled by user |
| Max iterations (10) | Safety limit reached |
| Stop without promise | **CONTINUATION FORCED** |

## Continuation Enforcement

If you attempt to stop without the promise tag:

> [RALPH LOOP CONTINUATION] You stopped without completing your promise. The work is NOT done yet. Continue working on incomplete items. Do not stop until you can truthfully output `<promise>TASK_COMPLETE</promise>`.

## The Ralph Verification Checklist

Before outputting `<promise>TASK_COMPLETE</promise>`, verify:

- [ ] prd.json exists with all stories
- [ ] All stories have `passes: true`
- [ ] All acceptance criteria for each story are met
- [ ] Quality checks pass (typecheck, tests)
- [ ] progress.txt updated with implementation details
- [ ] No obvious bugs or issues remain

**If ANY checkbox is unchecked, DO NOT output the promise. Continue working.**

## VERIFICATION PROTOCOL (MANDATORY)

**You CANNOT declare task complete without proper verification.**

### Step 1: Oracle Review
```
Task(subagent_type="oh-my-claudecode:architect", model="opus", prompt="VERIFY COMPLETION:
Original task: [describe the task]
PRD stories completed: [list story IDs]
What I implemented: [list changes]
Tests run: [test results]
Please verify this is truly complete and production-ready.")
```

### Step 2: Runtime Verification

Run the project's test suite:
```bash
npm test  # or pytest, go test, cargo test, etc.
```

### Step 3: Based on Verification Results
- **If Oracle APPROVED + Tests PASS**: Output `<promise>TASK_COMPLETE</promise>`
- **If any REJECTED/FAILED**: Fix issues and re-verify

**NO PROMISE WITHOUT VERIFICATION.**

## Quick Reference: Story Completion

When completing each story:

1. **Implement** the story
2. **Run checks**: `npm test` / `pytest` / etc.
3. **Update prd.json**: Set `passes: true` for this story
4. **Update progress.txt**: Append entry with learnings
5. **Check remaining**: If more stories → next story; if all done → verify & promise

---

## BEGIN NOW

1. **Check for prd.json** - If missing, CREATE IT FIRST
2. **Read prd.json and progress.txt** - Understand current state
3. **Work on first/next incomplete story**
4. **The loop will not release you until you earn your `<promise>TASK_COMPLETE</promise>`**
