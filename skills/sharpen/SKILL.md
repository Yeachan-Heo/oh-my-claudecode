---
name: sharpen
description: Aim a task at what the user is really after without overspecifying it — name the consumer, the observable change, and what is explicitly out of scope; at most one clarifying question when a real fork remains. Use on vague briefs before execution starts.
aliases: []
metadata:
  credits:
    task-aiming: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Sharpen

A vague brief fails quietly. Sharpening names what the work is for so the
first attempt lands near the target — without pinning details the work
itself should decide.

## Workflow

1. **Name the consumer**: who feels the result (an end user, a teammate, a
   future reader), and what changes for them, observably.
2. **Name the done-check**: the cheapest observable that says the task is
   done — a command that passes, a page that renders, a question that
   answers.
3. **Name the non-goals**: what is explicitly out of scope this round.
   Non-goals are the cheapest scope protection there is.
4. **One question, if a real fork remains**: if two different tasks both
   satisfy the brief and the choice changes the work materially, ask —
   one question, with the options and what each would cost. Otherwise
   proceed and report the interpretation you took (`principles` skill,
   Never block on the human).

## Rules

- Sharpen the aim, not the solution: how to build it stays open unless the
  user pinned it.
- Overspecifying is its own failure — a sharpened brief a stranger could
  execute without chat context, in three sentences or fewer.
- If the brief cannot be sharpened (no consumer nameable, no done-check
   findable), say so and route to `deep-interview`.
