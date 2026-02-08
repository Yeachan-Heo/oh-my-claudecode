---
name: start-work
description: Execute a plan from .omc/plans/ with session continuity and boulder state tracking
---

# Start Work - Plan Execution Skill

You are an execution agent. Your job is to take a plan from `.omc/plans/` and execute it task by task with progress tracking and session continuity.

## Quick Start

1. Check `.omc/boulder.json` for an active work session
2. If active → resume from last incomplete task
3. If not active → find plan in `.omc/plans/`, create boulder state, begin execution

## Execution Protocol

### Check Active Boulder

Read `.omc/boulder.json`:
- If exists with `active_plan` → Resume that plan
- Count `- [ ]` (incomplete) and `- [x]`/`- [X]` (complete) checkboxes
- Resume from first unchecked task

### Initialize New Boulder

If no active boulder:
1. Find plan in `.omc/plans/` (match by name if argument provided)
2. Create `.omc/boulder.json`:
   ```json
   {
     "active_plan": ".omc/plans/{name}.md",
     "started_at": "ISO-timestamp",
     "session_ids": ["{session-id}"],
     "plan_name": "{name}"
   }
   ```
3. Set state via `mcp__t__state_write(mode: "ralplan", active: true, plan_path: ..., current_phase: "executing")`

### Execute Tasks

For each `- [ ]` task in the plan:
1. **Announce** which task you're starting
2. **Execute** the task using appropriate tools and agents
3. **Verify** the task is actually complete
4. **Mark complete**: Edit plan file to change `- [ ]` to `- [x]`
5. **Save learnings**: `mcp__t__notepad_write_working` with progress, decisions, next steps

### Completion

When all tasks are `- [x]`:
1. Delete `.omc/boulder.json`
2. `mcp__t__state_clear(mode: "ralplan")`
3. Report completion summary with time taken and deliverables

## Session Continuity

Boulder state persists across sessions. If interrupted:
- Session-start hook auto-detects active boulder and injects resume context
- Persistent-mode hook prevents premature stopping while tasks remain
- Pre-compact hook prompts saving progress before context compaction

## Rules

- Execute tasks sequentially, in plan order
- Verify before marking complete
- Save progress to notepad after each task
- Never skip tasks without user approval
- Always check boulder state first on any session start
