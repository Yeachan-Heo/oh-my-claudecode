---
name: hillclimb
description: "Sustained single-metric improvement loop — hypothesis, before/after measurement against a fixed baseline, decision log, one accepted commit per verified win. For targets climbed over multiple rounds; not one-off fixes."
aliases: []
metadata:
  credits:
    hillclimb-loop: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Hillclimb

Climb one metric scientifically: each round is a hypothesis, a measurement
against a fixed baseline, and a decision — keep the win, revert the loss.
One accepted commit per verified win; the log is the climb's memory.

## When to use

- a measurable target will take multiple rounds ("cut cold-start to <2s",
  "get flaky suite under 1%")
- the user names a metric to improve, not a feature to build

## When not to use

- a one-off fix with a known cause — `debug` or `execute`
- no measurable baseline exists yet — build the measurement first (that is
  round zero, not skippable)

## The loop

1. **Fix the baseline**: the metric's definition, the exact command that
   measures it, and the current value — measured, not estimated
   (`benchmark-checklist` discipline). The baseline command never changes
   mid-climb; if it must, the climb restarts.
2. **Log the target and the climb** in `.omc/state/decision-trail-{task-slug}.tsv` via
   the `show-me-your-work` trail: one row per round.
3. **One hypothesis per round**: what you believe will move the metric and
   why. State it before touching code.
4. **Implement on a branch**, measure with the baseline command, and apply
   `benchmark-checklist` before believing any number.
5. **Decide**: a verified win is committed alone (one commit per win, so any
   regression bisects to a single round); a loss or wash is reverted and
   logged with what was learned. Neither counts as failure — both are data.
6. **Repeat** until the target is reached or the hypothesis space is
   exhausted — then report the plateau honestly instead of grinding.

## Rules

- Never stack two hypotheses in one round; a stacked win cannot be
  attributed.
- Never move the baseline, relax the check, or cherry-pick the favorable
  run — a climb that cheats its measurement is worse than no climb.
- Every decision row names its measurement evidence; every claim is
  labeled measured, inferred, or guess (`principles` skill, Explain the
  number).
- The final reply reports: rounds run, wins kept, the measured delta from
  the original baseline, and what was tried and rejected.
