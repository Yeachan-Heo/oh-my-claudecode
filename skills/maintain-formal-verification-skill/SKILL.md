---
name: maintain-formal-verification-skill
description: Re-sync an existing formal verification skill after the code it covers changed — re-check every model assumption against current code, update cited lines, rerun the tool, and report drift honestly. Use when a formal verification skill's spec cites code that has moved or changed shape.
aliases: []
metadata:
  credits:
    verification-maintenance: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Maintain Formal Verification Skill

A formal spec that cites lines that no longer exist is stale, and a stale
spec's green is worthless. This skill re-syncs an existing
`verify-formal-*` project skill (created by `create-formal-verification-skill`)
to the code it models.

## When to use

- the modeled protocol, arithmetic, or invariant changed shape
- cited file:line anchors drifted after refactors
- before trusting a green run that predates recent changes to the covered
  code

## Workflow

1. **Inventory the model's bindings**: every cited file:line, every named
   function, every assumption on the skill's assumption list.
2. **Re-check each binding against current code**: does the cited line still
   contain the modeled step? Does the assumption still hold (pid reuse,
   atomicity, integer width, timing)? A binding that no longer matches is
   drift; record it, do not silently absorb it.
3. **Update the model** where drift is real: move citations, adjust steps to
   the new protocol shape, and rewrite the assumption list to match reality.
   The property itself does not weaken — if the new code violates the
   property, that is a finding to report, not a model edit.
4. **Rerun the tool** (`TLC`/`apalache`, `lake build`, `cargo kani`) and
   capture real output.
5. **Update the project skill** in place: new citations, new assumption
   list, same run command — and append the resync to
   `.omc/state/verification-ledger.tsv`: `formally-verified` with the rerun
   command as evidence only when the rerun is green; a counterexample during
   resync records `verifier-failed` with the counterexample as evidence and
   is reported before any model change.

## Rules

- A counterexample found during resync is reported before any model change;
  verify whether the code shares the flaw.
- Never mark a resync done with an unrerun tool; the rerun is the resync.
- If more than half the bindings drifted, say so — the model may have been
  modeling an implementation that no longer exists, and regeneration via
  `create-formal-verification-skill` is the honest path.
