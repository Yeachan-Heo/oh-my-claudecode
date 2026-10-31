---
name: architect
description: "Settle types and module shape before cross-boundary code — competing designs explored in parallel, compared on API surface and invariants, decision recorded with rejected alternatives and an accepted-deviations register."
aliases: []
metadata:
  credits:
    design-exploration: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Architect

Design before steel. When a change crosses a function boundary, explore
competing shapes first and commit to one with a written rationale — the
cheapest moment to reject a design is before it has code on it.

## When to use

- new module, new API, changed signature other files call
- a data shape that more than one consumer will encode
- the user asks for a design or says "before you build this..."

## When not to use

- contained single-file changes — build directly
- reviewing an existing design — `review` or `interrogate`

## Workflow

1. **Frame**: name the problem in one sentence, the consumers of the design,
   and the invariants it must preserve.
2. **Explore 2-3 competing designs in parallel** — dispatch
   `oh-my-claudecode:architect` subagents (or an `arena` run at design
   altitude), each producing: the core types, the module boundary, the API
   surface, and how each invariant is preserved. Distinct shapes, not
   variations of one idea.
3. **Compare** criterion by criterion: API surface size, boundary clarity,
   invariant preservation, migration cost, deletion ease. Tie-break toward
   the smaller API and cleaner boundary (`minimal-code-discipline`).
4. **Record the decision**: chosen design, why the losers lost, and an
   accepted-deviations register the implementation will reconcile against
   (each deviation: what changed vs the sketch, and the acceptance source).
5. **Hand off**: the design and its invariant list travel with the
   `execute` brief; implementation reconciles deviations rather than
   rediscovering the design.

## Rules

- No design is recorded without at least one rejected alternative and the
  reason it lost.
- Types before wiring; data shapes before functions that move them
  (`principles` skill, Model the domain).
- The output is a design plus a decision record, never an implementation.
