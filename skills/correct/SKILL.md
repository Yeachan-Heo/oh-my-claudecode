---
name: correct
description: Find the mistakes agents keep repeating in this repo and make each one impossible, enforced at the highest level that works — lint rule over type guard over runtime check over script over prompt text. Use when the same class of agent error shows up more than once.
aliases: []
metadata:
  credits:
    mistake-elimination: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Correct

Text instructions decay; structure reruns. This skill converts a repeated
agent mistake into an enforcement the mistake cannot survive.

## When to use

- the same class of error appears twice or more (wrong import path, missed
  codegen step, broken invariant, slop pattern)
- retrospective findings in `.omc/notepads/` or review history name recurring
  friction

## Workflow

1. **Collect.** Mine the evidence: `.omc/notepads/*/problems.md`,
   `.omc/state/verification-ledger.tsv` failures, review comments, recent
   fix commits. Group by root cause, not by symptom.
2. **Rank.** Frequency × cost. Take the top mistakes; one at a time.
3. **Pick the highest enforcement level that works**:
   1. linter rule / compiler error — the mistake stops compiling
   2. type-level guard — the mistake stops type-checking
   3. runtime check or assertion — the mistake fails loudly at the boundary
   4. script or codemod — the correct action is one command
   5. project skill text — the last resort; note why every higher level
      failed
4. **Implement** the enforcement with its exception path documented (how a
   legitimate case opts out).
5. **Prove it fires.** Reproduce the mistake deliberately and show the
   enforcement catching it, with real output. An enforcement you have not
   seen fire is a hypothesis (`benchmark-checklist` discipline applies).

## Rules

- Never weaken an enforcement to make a test pass; the enforcement is the
  requirement now.
- Record what was encoded in `.omc/state/verification-ledger.tsv` with
  verdict `unit-test-verified` and the repro command as evidence.
- Text added at level 5 references this skill, so the next occurrence tries
  to climb the ladder again.
