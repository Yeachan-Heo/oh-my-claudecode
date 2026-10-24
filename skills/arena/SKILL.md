---
name: arena
description: Run N parallel candidates at the same brief and synthesize the best artifact — rubric-first framing, isolated fan-out, an independent cross-judge on a different model, criterion-by-criterion pick, and hand grafting of the losers' strongest parts. Use when one attempt at a non-trivial artifact would lock in the wrong shape.
aliases: []
metadata:
  credits:
    arena-workflow: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Arena

N parallel candidates attack the same brief; the best artifact is picked
criterion by criterion and strengthened by grafting. Diversity of candidates
is the mechanism: agreement across independent attempts is high-signal, and
divergence exposes what the brief under-specified.

## When to use

- a design or implementation has more than one defensible shape, and the
  first attempt would lock in the wrong one
- judgment-sensitive work: a migration strategy, an API surface, a data
  structure choice, a subtle algorithm
- the user asks for a bakeoff, a comparison of approaches, or "try a few
  ways and pick"

## When not to use

- mechanical edits, contained one-file changes, or work with an obvious
  single answer — run `execute` instead
- research questions whose deliverable is an answer, not an artifact — run
  `research`

## Phase A — Frame

Every candidate gets the same brief, so the brief is the contract.

1. State the artifact each candidate produces.
2. Derive the rubric: 3-6 concrete, gradeable criteria for this task. The
   rubric is the picker's tool in Phase D; candidates never see it.
3. Pick the runtime:
   - **In-session**: parallel `Task` dispatches to `oh-my-claudecode:executor`,
     one per candidate, each given its own output location.
   - **Multi-provider**: `omc team 1:claude,1:codex,1:gemini "<brief>"` with
     worktree isolation (`OMC_TEAM_WORKTREE_MODE`) so each candidate owns a
     separate worktree — one writer per worktree.
   Use diverse models when the work is judgment-sensitive; the same model N
   times when it is generation-bound.
4. Give each candidate an exclusive output location — a git worktree when
   possible, otherwise a scratch directory. Candidates must not share
   writable state.

## Phase B — Fan out

Spawn all candidates in one message, in the background, each with the brief,
its output location, and instructions to return the artifact plus a short
rationale naming the alternatives it considered and rejected. If a candidate
produces nothing, proceed with N-1 and note the dropout.

## Phase C — Cross-judge

After all candidates finish, spawn one read-only judge on a different model —
or a different provider family — from the candidates. The judge sees the
rubric and the candidates by path label, scores each criterion, and
recommends a base with rationale. It runs while you read.

## Phase D — Pick

Read every candidate end to end. Score each against the rubric criterion by
criterion, not on holistic feel, and compare with the cross-judge. Agreement
on the base confirms the pick; disagreement means one of you is biased or the
rubric is ambiguous — read both rationales before deciding. Tie-break toward
the smaller API and the cleaner boundary (`minimal-code-discipline`).

## Phase E — Graft

Walk each losing candidate once more for what is worth porting — usually one
or two things, not most of it. Fold grafts in by hand so the result stays
coherent under one mental model. Candidates that converge on one shape are
strong agreement: note it and ship the consensus shape. Candidates that
wildly diverge mean Phase A was under-specified: reframe and rerun rather
than averaging the divergence.

## Phase F — Verify

Verify the synthesized artifact under the `verify` skill protocol — real
command output, fresh evidence. A problem the arena missed means either the
rubric was wrong (reframe and rerun) or a graft was missed (back to Phase E).
Do not paper over it.

## Rules

- Never a default gate: arena runs only when explicitly invoked.
- The lead session owns the result; candidate and judge outputs are inputs,
  not verdicts.
- A later `review` judges the synthesized artifact, not the candidates.
