---
name: teach
description: Explain a subsystem to a learner by composing how and why — the walkthrough from `how`, the design reasons from `why`, paced with checks that the explanation landed. Use for onboarding, knowledge transfer, and "teach me X".
aliases: []
metadata:
  credits:
    compose-how-why: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Teach

Teaching is `how` and `why` composed for a learner: what the subsystem does
and the reasons it is shaped that way, in an order a person can absorb.

## Workflow

1. **Ask the learner's baseline**: one question — familiar with the domain,
   the language, or neither. Size the explanation to the answer.
2. **How first** (`how` skill): the walkthrough, entry to exit, cited to
   file:line, at the depth the baseline supports.
3. **Then why** (`why` skill): the 2-4 decisions that shaped it, each with
   its evidence and the alternative it beat. Human rulings quoted verbatim.
4. **Check the landing**: ask the learner to predict one behavior — "if X
   happens, what does the subsystem do?" A correct prediction ends the
   lesson; a wrong one names the layer to redo. The check is for pacing,
   not grading.

## Rules

- One new concept per paragraph; jargon defined at first use in one clause.
- Cite code for behavior, cite records for reasons; label anything you
  inferred.
- Stop when the learner can predict behavior — completeness is not the goal,
  transfer is.
