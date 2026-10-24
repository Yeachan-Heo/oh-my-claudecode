---
name: how
description: Walk through how a subsystem works — a fast explorer maps the territory, an explainer writes the layered walkthrough. Use for "how does X work", onboarding on unfamiliar code, or before changing a subsystem you cannot yet explain.
aliases: []
metadata:
  credits:
    explorer-explainer: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# How

Explain how a subsystem works, layered so each layer stands alone. Two roles,
two passes:

1. **Explore** (read-only, fast): dispatch `oh-my-claudecode:explore` to map
   the subsystem — entry points, main flows, data shapes, state, external
   calls, and the files that own each. Explorer returns a map with file:line
   citations, not prose.
2. **Explain** (lead): write the walkthrough from the map, reading the cited
   code yourself where the claim is load-bearing.

## Output shape

- **One paragraph**: what the subsystem does and for whom, no jargon.
- **Walkthrough**: the main path end to end, step by step, each step citing
  `file:line`. Diverge into how errors and retries are handled at the point
  they occur.
- **Edge cases and invariants**: what must stay true for the walkthrough to
  hold, and what happens when it does not.
- **Boundaries**: what this subsystem deliberately does not do.

## Rules

- Every behavioral claim cites code you or the explorer read this session;
  an uncited claim is labeled a guess.
- The walkthrough explains the code as it is, not as it should be; design
  critique belongs to `why` and `review`.
- Size the depth to the ask: a routing question gets one paragraph plus the
  relevant slice, not the full walkthrough.
