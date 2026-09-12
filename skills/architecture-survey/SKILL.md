---
name: architecture-survey
description: Periodic architecture survey — walks the module graph and reports ranked deepening candidates (shallow modules, hypothetical seams, logic behind the wrong seam). Survey, not rescue: it finds candidates and hands them to the captain; it never refactors on its own.
argument-hint: "[optional directory or area to survey]"
level: 3
disable-model-invocation: true
---

**A surveyor charts the reef; the captain decides whether to dredge.** The survey reads the water, reports what it found with evidence, and stops. It is the maintenance twin of the loft: where the loft answers one design question before building, the survey answers "where is this repo getting harder to change, and what would deepen it" after building.

## When to survey

- Periodically — every few days of active building, or after a batch of tickets lands.
- Out of turn, when the repo starts feeling harder to change than it was last week: edits touching more files than they should, interfaces growing to satisfy one caller, tests that must be updated in lockstep for unrelated reasons.

Optional argument narrows the survey to a directory or area; with no argument, survey the whole repo.

## The survey

1. Read the repo's architecture principles (CLAUDE.md, ADRs) and the seeded seam vocabulary in `docs/standards/architecture.md` — the definitions of seam and deep module.
2. Walk the module graph of the target area — and when no direction was given, weight the walk toward the yard's busy water: read a good stretch of the commit history first and let the areas that keep coming up pull the survey, because deepening pays off where future edits will land. A scattered history with no hot spot widens the net.
3. Look for three finding classes:
   - **Shallow modules** — wide interface, thin behavior; callers know more than the module hides.
   - **Hypothetical seams** — a boundary crossed by exactly one adapter with no second caller; checkable by counting callers.
   - **Logic behind the wrong seam** — behavior living on the far side of a boundary that does not own its data.

Apply the **demolition test** to every suspect: if the module were removed, would its complexity vanish (a pass-through wearing a uniform) or reappear across its callers (load-bearing)? Only load-bearing shallowness is a finding.

## The report

Rank candidates by leverage against risk. Each candidate carries:

- **Evidence** — file:line for the interface, its callers, and the behavior.
- **The deepening move** — what to deepen, merge, or move, in one sentence.
- **The risk note** — what the move touches and what could break.

## Handoff

The report is decision input, not work. Candidates feed the mission brief (launch Phase 1) or grilling material for the next effort. Survey proposes; the captain disposes.

## Non-goals

- **No code edits.** The survey never refactors, not even "while it's fresh."
- **Not a gate.** Nothing blocks on the report.
- **Not merged into the drydock drift audit.** `--check` stays strictly mechanically checkable — high-confidence findings only. Architecture judgment is a low-confidence heuristic; mixing it in dilutes the contract.

## Completion definition

The survey is done when the report exists with evidence, rankings, and risk notes for every finding — and no file was modified.
