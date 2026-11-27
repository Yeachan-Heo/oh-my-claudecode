---
name: architect
description: "Settle types and module shape before cross-boundary code — sketch two shapes, pick by ownership and caller load, record the decision with rejected alternatives and an accepted-deviations register. For a large or contested design, arena decides instead."
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

For a large or contested design, run the `arena` skill instead of sketching
alone.

## When to use

- new module, new API, changed signature other files call
- a data shape that more than one consumer will encode
- the user asks for a design or says "before you build this..."

## When not to use

- contained single-file changes — build directly
- reviewing an existing design — `review`

## Workflow

1. **Trace** every system the change touches — entry points, the data each
   owns, who calls it. Naming a file is not grounding.
2. **Sketch two structurally distinct shapes** — types, signatures, module
   boundaries — whole-shape alternatives, not point fixes inside one idea.
3. **Pick** the shape where each piece of state has one owner, each task has
   one way to do it, and callers need to know least; tie-break toward the
   smaller API and cleaner boundary (`minimal-code-discipline`).
4. **Record the decision**: chosen design, why the loser lost, and an
   accepted-deviations register the implementation will reconcile against
   (each deviation: what changed vs the sketch, and the acceptance source).
5. **Hand off**: the design and its invariant list travel with the
   `execute` brief; implementation reconciles deviations rather than
   rediscovering the design. Redesign instead of patching if workarounds
   repeat — the signal is a pattern, not single instances
   (`principles` skill, Redesign from first principles).

## Rules

- No design is recorded without at least one rejected alternative and the
  reason it lost.
- Types before wiring; data shapes before functions that move them.
- The output is a design plus a decision record, never an implementation.
