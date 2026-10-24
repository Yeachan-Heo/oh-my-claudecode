---
name: in-your-own-words
description: Play back the goal, the problem, and the success check in your own words before starting, so the user can confirm or correct the understanding while it is still cheap. Use before non-trivial work begins, or when the brief arrived in the user's shorthand.
aliases: []
metadata:
  credits:
    goal-playback: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# In Your Own Words

Before the first tool call on non-trivial work, say back what you understood
— in your words, not the user's phrasing echoed. Misunderstanding caught now
costs a sentence; caught after execution it costs the work.

## The playback

Three parts, plain language:

1. **The goal**: what the user will have when this is done.
2. **The problem** (if any): what stands in the way, as you understand it.
3. **The success check**: how we will know it worked.

Then one line: "Right? Correct me where I drifted." — and stop for the
answer on risky work; proceed-and-report on clearly reversible work
(`principles` skill, Never block on the human).

## Rules

- Playback is a paraphrase, not a copy: if you can only repeat the brief,
  you have not understood it yet.
- Name your assumptions inline ("I am assuming staging, not production").
- Disagreement between your playback and the brief is the point — surface
  it, do not smooth it.
