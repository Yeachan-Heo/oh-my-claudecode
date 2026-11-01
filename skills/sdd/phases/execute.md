
# Execute Skill

Execute the pre-approved implementation plan in `spec/<slug>/tasks.yaml` task by task, validate each task, and halt at
checkpoints for approval.

This is the implementation phase of a spec-driven development workflow, after the plan has been generated and the review
has gated it as ready.

Pipeline position: proposal → spec → criteria → rules → review → plan → **execute**

# Role

You execute tasks in order, validate them, and report progress. You do not modify anything under `spec/<slug>/` except
`status.md`. You do not skip tasks, reorder them, or proceed past checkpoints without explicit approval.

# Inputs

- Plan: `spec/<slug>/tasks.yaml` (task list)
- Acceptance criteria: `spec/<slug>/criteria.md` (validation source)
- Technical constraints: `spec/<slug>/rules.md` (constraint set)
- Feature context: `spec/<slug>/spec.md`
- Pipeline verdict and risk hotspots: `spec/<slug>/review.md`
- Progress: `spec/<slug>/status.md` (you maintain this; create if missing)

# Initialization

When starting work:

1. Read `tasks.yaml`. This is your task list.
2. Read `criteria.md` and `rules.md`.
3. Read `spec.md` for feature context and `review.md` for risk hotspots that map to specific tasks.
4. Read `status.md` to find your position. If it doesn't exist, create it with `phase-1` / `task-1.1` as `NOT_STARTED`.
5. Set `current_task` to the first task with status `NOT_STARTED`.

# Execution Loop

For each task:

1. **Verify prerequisites.** For every `task_id` in `task.depends_on`, confirm its status is `COMPLETE` in `status.md`.
   If not, halt with a Blocker report.

2. **Mark in progress.** Update `status.md`: set the task to `IN_PROGRESS`.

3. **Execute (test-first).** Read the task's `description`, `artifact`, `covers.acs`, and `covers.rules`. First write
   the tests for every AC in `covers.acs` and run them to confirm they fail for the right reason (red). Then produce or
   update the artifact, plus any supporting files (fixtures, configs) needed to satisfy validation, until the tests pass
   (green). Apply every constraint
   listed in `covers.rules`. Do not modify files unrelated to this task.

4. **Validate.** Run the check described in `task.validation`. Then verify every AC in `covers.acs` is satisfied,
   typically through passing tests or behavioral checks against `criteria.md`. If validation fails, take up to two
   corrective attempts. Each attempt must be a different approach, not a re-run of the same code. If still failing after
   two attempts, halt with a Blocker report.

5. **Mark complete.** Update `status.md`: set the task to `COMPLETE`. Record any non-obvious decisions in the notes.

6. **Advance.** If more tasks remain in the phase, set `current_task` to the next one. If this was the last task of the
   phase, generate a Checkpoint report and halt for approval.

When all phases complete, generate a Completion report.

# Approval Responses

After a Checkpoint report, wait for one of:

- `APPROVED`: proceed to the next phase.
- `APPROVED WITH NOTES: <notes>`: record notes in `status.md`, then proceed.
- `REVISE: task-N.M - <instructions>`: apply the revision to the named task, re-validate, then resume.
- `ROLLBACK: task-N.M`: mark the named task `NOT_STARTED`, undo its artifact, then resume from there.
- `BLOCKED: <reason>`: record blocker in `status.md` and halt.

After a Blocker report, wait for one of:

- `PROCEED WITH: <option number>`: continue using the specified option from the report.
- `PROCEED WITH: <custom instructions>`: continue using user-provided guidance.
- `ABORT TASK`: skip this task and adjust the plan.

# Status File Format

Maintain `spec/<slug>/status.md` with only the delta from `tasks.yaml`. Everything else is derivable.

```markdown
# Status: <feature>

## Current

- Task: task-N.M
- Status: IN_PROGRESS | NOT_STARTED | BLOCKED

## Completed

- task-1.1
- task-1.2

## Phase Approvals

- phase-1: APPROVED
- phase-2: PENDING

## Blockers

(empty if none)

## Deviations

(approved deviations from plan, with task ID and reason)

## Notes

(non-obvious decisions, per task)
```

# Checkpoint Report

```markdown
# Checkpoint: phase-N complete

## Summary

- Phase: phase-N, <name>
- Tasks: <n>/<n> complete

## Artifacts

| File   | Purpose    |
|--------|------------|
| <path> | <one-line> |

## AC Coverage (this phase)

| AC   | Status    | Verified in    |
|------|-----------|----------------|
| AC-1 | satisfied | <file or test> |

## Validation

- Compilation: PASS | FAIL
- Tests: <n>/<n> passing
- Constraints (this phase's RULES): <n>/<n> satisfied

## Notes

<ambiguities resolved, deviations, concerns; empty if none>

CHECKPOINT REACHED. AWAITING APPROVAL.
```

# Blocker Report

```markdown
# BLOCKED: task-N.M

## Type

SPEC_AMBIGUITY | SPEC_CONFLICT | TECHNICAL | VALIDATION_FAILURE | DEPENDENCY

## Summary

<one sentence>

## Details

<full explanation>

## Evidence

<code, error messages, spec quotes>

## Attempted Solutions

1. <what you tried> → <result>
2. <what you tried> → <result>

## Options

1. <option>
   - Impact: <plan, timeline, architecture>
   - Tradeoff: <pros, cons>
2. <option>
   - Impact: <...>
   - Tradeoff: <...>

## Recommendation

<which option and why>

BLOCKED. AWAITING RESOLUTION.
```

# Completion Report

```markdown
# Feature Complete: <feature>

## Summary

- Phases: <n>/<n> complete
- Tasks: <n>/<n> complete
- ACs satisfied: <n>/<n>
- RULES applied: <n>/<n>

## Coverage

| AC   | Implemented in |
|------|----------------|
| AC-1 | <file or test> |

## Deviations from Plan

<deviations approved during execution; empty if none>

## Open Items

<anything intentionally deferred, with reason>
```

# Rules

- The `spec/<slug>/` directory is read-only during implementation. The single exception is `status.md`, which you maintain.
- Do not skip tasks or reorder within a phase.
- Do not proceed past a checkpoint without an approval response.
- Do not proceed when blocked without a resolution response.
- A task may touch supporting files (tests, fixtures, configs) needed to satisfy `validation`, but must not modify files
  unrelated to the task's `artifact` and coverage.
- Record non-obvious decisions in the per-task notes in `status.md`.
