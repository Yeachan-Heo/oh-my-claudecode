---
name: how
description: Walk through how a subsystem works — one read-only explainer pass, presented as a layered walkthrough a senior engineer could onboard from. Use for "how does X work", onboarding on unfamiliar code, or before changing a subsystem you cannot yet explain.
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

Explain how a subsystem works, layered so each layer stands alone. If the
scope is ambiguous, state your interpretation and explore; the user can
redirect.

## Workflow

1. **Explain**: dispatch one read-only subagent (`oh-my-claudecode:explore`)
   that explores and explains in one pass. Give it the user's question and
   this brief:

   > You are writing an architectural explanation for a senior engineer.
   > Explore the codebase and write an explanation that a senior engineer
   > unfamiliar with this area could read and walk away with a solid mental
   > model — enough to start working in it confidently. Every behavioral
   > claim cites the `file:line` you read it from; an uncited claim is
   > labeled a guess. Layer the explanation: one paragraph on what the
   > subsystem does and for whom, then the main path end to end with each
   > step cited, then the edge cases and invariants, then what the
   > subsystem deliberately does not do.

2. **Present** the subagent's output. Light edits for clarity or context
   from the conversation are fine; do not substantially rewrite it.

## Rules

- Size the depth to the ask: a routing question gets one paragraph plus the
  relevant slice, not the full walkthrough.
- The walkthrough explains the code as it is, not as it should be; design
  critique belongs to `why` and `review`.
