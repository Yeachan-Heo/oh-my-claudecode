---
name: technical-writing
description: Write docs, RFCs, readmes, PR descriptions, and commit messages to one layered standard — outcome first, one meaning one home, checkable statements, no filler. Layers with minimal-prose-discipline. Use whenever the deliverable or a surface it ships contains prose meant to last.
aliases: []
metadata:
  credits:
    layered-writing-standard: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Technical Writing

Prose that ships — docs, RFCs, readmes, PR descriptions, commit messages —
follows one standard so readers can navigate any of them the same way.

## The standard

1. **Outcome first.** The first sentence says what changed for whom and what
   the reader can now do. Context comes after the reader knows why they
   care.
2. **One meaning, one home.** Each fact lives in exactly one place; every
   other mention links there. Duplicated facts rot at different speeds.
3. **Checkable statements.** Prefer a statement the reader can verify with a
   command or a glance over an adjective. "Builds in ~40s" beats "fast".
4. **Layered structure.** Summary, then detail, then edge cases — each layer
   readable alone, each deeper layer skippable.
5. **No filler.** No restating the obvious, no throat-clearing, no AI tells
   (`ai-slop-cleaner` territory; this skill composes with it).

## Per surface

- **Commit message**: subject says what changed in one line ≤72 chars; body
  says why, and the constraint that made the change necessary.
- **PR description**: claim, evidence (before/after), reversibility — the
  `pr` skill owns the full template.
- **README**: what it is, who it is for, the shortest working example, then
  everything else.
- **RFC/design doc**: problem, constraints, options considered with why the
  losers lost (feeds from `architect`), decision, migration.

## Rules

- Write clean as you draft; a cleanup pass after drafting does not remove
  these patterns.
- Every claim carries its evidence or its label in the same sentence.
- Delete more than you add; the reader's time is the budget
  (`principles` skill, Minimize reader load).
