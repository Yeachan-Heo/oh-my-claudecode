---
name: correct
description: "Find the mistakes agents keep repeating in this repo and make each impossible at the highest enforcing level — lint rule, type guard, runtime check, script, then text — with every enforcement proven to fire."
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
6. **Record honestly**: the ledger verdict matches what the repro actually
   exercised — a lint rule or type guard firing is `enforcement-verified`,
   a runtime check exercised by a test is `unit-test-verified`, a proof is
   `formally-verified`. Never record a stronger verdict than the evidence.

## Rules

- Never weaken an enforcement to make a test pass; the enforcement is the
  requirement now.
- Record what was encoded in `.omc/state/verification-ledger.tsv` with the
  verdict the repro actually exercised (see workflow step 6) and the repro
  command as evidence.
- Text added at level 5 references this skill, so the next occurrence tries
  to climb the ladder again.
