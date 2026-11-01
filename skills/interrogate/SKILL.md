---
name: interrogate
description: "Adversarial pass over a diff or design: three reviewers on different models each try to break it — correctness, security, edge cases — findings merged by severity into a blocking verdict. For contested or high-risk changes."
aliases: []
metadata:
  credits:
    adversarial-panel: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Interrogate

Three independent reviewers try to break the work before it ships. Diversity
is the mechanism: reviewers on different models or provider families find
different classes of defects, and agreement across them is high-signal. This
is an adversarial lane on top of `review`, not a replacement for it.

## When to use

- a diff or design is contested, high-risk, or security-adjacent
- work is about to ship and a single review pass is not enough evidence
- the user asks to "stress-test", "red-team", or "try to break" a change

## When not to use

- routine changes with passing verification — `review` alone is enough
- the deliverable is an answer, not an artifact under judgment

## Phase 1 — Frame the target

Name exactly what is under interrogation: the diff (default), a design doc,
or an API contract. State the invariants the change must preserve; reviewers
attack those first.

## Phase 2 — Seat the panel

Spawn three reviewers in one message, in the background, each read-only:

- prefer different models, and where available different provider families
  (Claude + Codex + Gemini via
  `OMC_TEAM_WORKTREE_MODE=detached omc team --no-decompose 1:claude,1:codex,1:gemini "<the framed target, the invariants, and one lens per seat>"`,
  or in-session `Task` dispatches to `oh-my-claudecode:code-reviewer` and
  `oh-my-claudecode:security-reviewer` on different models) — the team
  command needs the task text; pass target, invariants, and lens allocation
  as that task
- each reviewer gets the same target by path, the invariants, and one lens:
  correctness, security and trust boundaries, or edge cases and failure modes
- instruct each to return findings as `{severity: blocker|major|minor, claim, evidence, location}`
  with evidence quoted from the target — a finding without evidence is dropped

## Phase 3 — Merge

You own the merge. Collect the panels' findings, drop duplicates and
unevidenced claims, and rank by severity. A claim two reviewers disagree on
is a question for the code, not a vote — resolve it by reading or running.

## Phase 4 — Verdict

- **block**: any blocker finding stands after re-reading the evidence. The
  work goes back to the author lane with the finding list; nothing merges.
- **revise**: only major or minor findings. Fix-forward is safe.
- **pass**: no standing findings. Record the verdict with the reviewers'
  models named, in the reply.

The verdict is advisory to `review` and to the human; it never merges or
gates delivery on its own. When interrogation blocks, say what would change
the verdict.

## Rules

- Never count your own review as one of the three.
- A reviewer that cannot run (missing provider, agent limits) is named in the
  verdict as missing; two reviewers still produce a verdict, one does not.
- Findings are about the artifact, not the author; keep the tone clinical.
