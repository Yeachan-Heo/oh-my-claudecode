---
description: Execute a plan from .omc/plans/ with boulder state tracking
aliases: [sw]
---

# Start Work

[START-WORK ACTIVATED - PLAN EXECUTION MODE]

## User's Plan Selection

{{ARGUMENTS}}

## Overview

Start-work bridges planning to execution. It loads a plan from `.omc/plans/`, creates boulder state for session continuity, and executes tasks sequentially with progress tracking.

## Execution Protocol

### Step 1: Check for Active Boulder

First, check if there's already an active work session:

1. Read `.omc/boulder.json` - if it exists and has an `active_plan`:
   - Read the plan file at `active_plan` path
   - Count checkboxes: `- [ ]` (incomplete) vs `- [x]`/`- [X]` (complete)
   - If incomplete tasks remain → **RESUME** from the first unchecked task
   - Display: "Resuming plan: {plan_name} - {completed}/{total} tasks done"
   - Skip to Step 4 (Execute)
2. Also check `mcp__t__state_read` with `mode: "ralplan"` for any active ralplan state

### Step 2: Find and Select Plan

If no active boulder:

1. Scan `.omc/plans/*.md` using Glob tool
2. **If `{{ARGUMENTS}}` is provided and non-empty**: Match plan by filename (fuzzy match)
3. **If exactly 1 plan found**: Auto-select it
4. **If multiple plans found**: Use `AskUserQuestion` to present choices with progress stats
5. **If 0 plans found**: Say "No plans found in `.omc/plans/`. Run `/plan` first to create one." and STOP

### Step 3: Initialize Boulder State

Once a plan is selected:

1. Write `.omc/boulder.json`:
   ```json
   {
     "active_plan": ".omc/plans/{name}.md",
     "started_at": "ISO-timestamp",
     "session_ids": ["{current-session-id}"],
     "plan_name": "{name}"
   }
   ```

2. Set execution state via `mcp__t__state_write`:
   - `mode`: "ralplan"
   - `active`: true
   - `plan_path`: ".omc/plans/{name}.md"
   - `current_phase`: "executing"
   - `task_description`: First line/title of the plan
   - `started_at`: ISO timestamp

3. Read the full plan content and identify all `- [ ]` tasks

### Step 4: Execute Tasks

For each unchecked `- [ ]` task in the plan:

1. **Announce**: Display which task you're working on
2. **Execute**: Perform the task using appropriate tools and agents
3. **Verify**: Confirm the task is actually complete
4. **Mark complete**: Edit the plan file to change `- [ ]` to `- [x]`
5. **Save learnings**: Use `mcp__t__notepad_write_working` to record:
   - What was done
   - Key decisions made
   - Any issues encountered
   - What to do next

### Step 5: Completion

When all tasks are marked `- [x]`:

1. Clear boulder state: Delete `.omc/boulder.json`
2. Clear ralplan state: `mcp__t__state_clear(mode: "ralplan")`
3. Display completion summary:
   - Total tasks completed
   - Time taken (from boulder started_at)
   - Key deliverables

## Session Continuity

If the session is interrupted or compacted:
- The session-start hook will detect the active boulder on next session
- It will inject context reminding you to resume from where you left off
- The persistent-mode hook will prevent premature stopping while tasks remain
- The pre-compact hook will prompt you to save progress before compaction

## CRITICAL RULES

1. **Execute sequentially** - One task at a time, in plan order
2. **Verify before marking** - Never mark a task `[x]` without verification
3. **Save progress often** - Use notepad after each task for compaction resilience
4. **Never skip tasks** - Execute ALL unchecked tasks unless user explicitly says to skip
5. **Resume on restart** - Always check boulder state first
