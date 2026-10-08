---
name: execute
description: Carry an approved task through to working, verified code
---

# Execute

Use this skill when the work is understood and the job is to build it.

This is the canonical execution workflow. `autopilot`, `ralph`, `ultragoal`,
`ultrapilot`, `pipeline`, and `swarm` route here.

## Goal
Take a task from agreed intent to working code, with evidence that it works.

## Workflow
1. Confirm the task is clear enough to build. If it is not, plan first.
2. Break the work into independent units; run genuinely independent units in parallel.
3. Implement the smallest correct change per unit, reusing existing utilities and patterns.
4. Verify as you go, not only at the end.
5. Report what changed, what was verified, and what remains.

## Scale
Match the machinery to the task:
- **Single unit** — implement directly, verify, done.
- **Several independent units** — delegate to `executor` agents in parallel.
- **Long-running or unbounded** — keep a durable task list and continue until the list is empty.
- **Needs coordinated parallel workers** — use `team`.

Do not spin up coordination for work that one focused pass would finish.

## Rules
- Prefer deletion over addition when behavior is preserved.
- Do not add dependencies without an explicit request.
- Keep diffs small and reversible.
- Work on two tracks at once: finish the task in front of you, and notice what would make the next task easier or safer — the second track is a proposal, not a detour.
- No workarounds: a deviation from convention that only unblocks you today (a skipped check, a hard-coded value, a manual step) is fixed or flagged before feature work lands on top of it — it never silently becomes the norm.
- Before asserting what a skill or protocol does, or skipping one of its steps, read its source — summaries are for finding it, not for standing in for it.
- Placeholder TODOs, `test.skip`, and stub tests are blockers, not progress.
- Authoring and approval are separate passes — do not self-approve; hand off to `review` or `verify`.

## Completion
Before claiming done:
- No pending tasks
- Tests pass, or failures are reported plainly
- Verification evidence collected

## Output
- Files changed
- What was implemented
- Evidence it works
- What is still open
