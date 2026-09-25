---
name: omc-review
description: Evaluate finished work for defects, risk, and simplification before it ships
---

# Review

Use this skill to evaluate work that already exists. Review never authors the
change it is judging.

This is the canonical review workflow. `merge-readiness` routes here, and
`ai-slop-cleaner` is an opt-in lane within it.

## Goal
Find what is actually wrong, ranked by severity, with enough detail to act on.

## Workflow
1. Establish what changed and what it was meant to do.
2. Read the change against that intent.
3. Check correctness first, then risk, then simplification.
4. Verify each candidate finding before reporting it.
5. Report findings most-severe first.

## What to check
- **Correctness** — logic defects, edge cases, error paths, concurrency
- **Risk** — security boundaries, destructive operations, data integrity
- **Reuse** — existing utilities or patterns the change should have used
- **Simplification** — code that could be deleted or collapsed
- **Coverage** — behavior that ships untested

## Two axes, run apart

A substantial diff is reviewed as two parallel sub-agent passes, reported separately — never merged or cross-ranked, because a change can pass one axis and fail the other (standards-conforming but wrong behavior; faithful but convention-breaking):

- **Standards axis** — the diff against the repo's documented standards (CLAUDE.md/AGENTS.md, `docs/standards/` volumes where they exist) plus a judgement-call-only smell baseline; anything tooling already enforces is skipped.
- **Intent axis** — the diff against what the work was meant to do — the task, spec, or ticket acceptance criteria: requirements missing or partial, behavior nobody asked for, each finding quoting its source line.

Keep each sub-agent brief under ~400 words and pointed at one axis. Aggregate without picking a single winner across axes — that reranking is what the separation exists to prevent; state each axis's verdict on its own. A small diff stays one pass.

## Rules
- Separate lanes: the reviewer must not be the author's same active context.
- Verify before reporting. A plausible-sounding finding that does not reproduce is noise.
- State severity honestly; do not pad the list to look thorough.
- "No findings" is a valid result when the work is sound.
- Advisory by default — review informs, it does not gate. Hard gates (release,
  security, destructive operations) stay separate and fail closed.

## Output
- Findings, most-severe first, each with file, line, and concrete failure scenario
- What was checked and found clean
- Anything that could not be assessed
