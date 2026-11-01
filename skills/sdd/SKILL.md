---
name: sdd
description: Spec-Driven Development, lite by default. Interview, then spec with testable acceptance criteria, then a short plan, then test-first execution with checkpoints. Use when the user types /sdd or asks to work spec-driven. `/sdd full` runs the 6-phase pipeline in phases/ instead.
level: 3
---

# SDD (lite)

Interview → Spec+AC → Plan → Test-first execute. Artifacts live in `spec/<slug>/` at project root (one folder per feature). No implementation code before `spec/<slug>/plan.md` is approved.

If args start with `full`: read and follow `phases/spec.md`, `phases/criteria.md`, `phases/rules.md`, `phases/review.md`, `phases/tasks.md`, `phases/execute.md` (relative to this skill's directory) in that order, confirming with the user after each artifact. Pick the slug as in Entry; every phase writes to `spec/<slug>/`. Then stop reading this file.

## Entry

1. `git status --short --branch`; list `spec/*/`.
2. Pick the slug (kebab-case, max 40 chars, descriptive of the feature):
   - On a feature branch, use the branch name without the prefix (`feat/csv-export` → `csv-export`) if `spec/<that>/` exists or the task matches it.
   - Otherwise derive it from the task (`add CSV export of reports` → `csv-report-export`) and show it to the user in the first message so they can correct it.
   - If several `spec/*/` folders exist and the task is unclear, ask which one to resume via AskUserQuestion.
3. Resume at the first missing artifact in `spec/<slug>/` and say where you resume.
4. Task text comes from args or the user's message. Ask only if there is none.
5. Skip the flow for tasks prefixed `quick:`.

## 1. Interview (no file yet)

- Read the code first; never ask what the code answers.
- One question at a time via AskUserQuestion: 2-4 concrete options, a recommended pick, one-line reason why it matters.
- Ask only if the answer changes behavior, scope, or a safe assumption. Otherwise decide and record it as an assumption.
- Stop when an implementer would have no questions left. Typically 3-7 questions; more means the task should be split.

## 2. Spec → `spec/<slug>/spec.md`

One file, short:

- Summary (2-3 sentences)
- Decisions and assumptions (bullets, with the reason)
- Out of scope
- Acceptance criteria: `AC-1`, `AC-2`, ... one observable outcome each, EARS form:
  `When <trigger>, the <system> shall <response>.` / `If <bad trigger>, then the <system> shall <response>.` / `While <state>, ...`
  - Bounded values: three ACs (inside, at, beyond the bound).
  - Error paths: state the response and whether it is all-or-nothing.
  - No implementation details, no "fast"/"correct" without a number.

Show a 5-line summary, then AskUserQuestion: continue or revise.

## 3. Plan → `spec/<slug>/plan.md`

- Design in under 10 lines: components, flow, new dependencies. Record only deviations from project conventions (read CLAUDE.md, build files, existing layout first) and deliberate "not using X" decisions.
- Tasks as a checklist, ordered, each under ~1 hour: `- [ ] T1: <what> (AC-1, AC-2) — verify: <test or command>`
- Group into phases (max 4); end each phase with `CHECKPOINT`.
- Every AC appears in at least one task. Self-check this; if something is unclear, go back to the interview instead of guessing.
- For large or risky features only (many ACs, migrations, new infra), add a "Risks" list of up to 5 items with mitigations.

Show the plan, AskUserQuestion: approve or revise.

## 4. Execute (test-first)

Per task, in order, no skipping:

1. Write tests for the task's ACs; run them; confirm they fail for the right reason (red).
2. Implement the minimum to pass (green); run the full test suite, type check, and linter.
3. If still failing after 2 different attempts, stop and report: what failed, what you tried, 2 options, your recommendation.
4. Tick the task in `plan.md` (`- [x]`). Do not edit `spec.md` during execute; if the spec is wrong, stop and say so.

At each `CHECKPOINT`: report tasks done, ACs satisfied (AC → test file), test/lint results. Then wait for the user: `ok`, `revise T<n>: ...`, or `rollback T<n>`.

At the end: AC coverage table (AC → test) and one command to run the tests.
