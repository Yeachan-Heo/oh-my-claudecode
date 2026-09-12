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

Every candidate states the yard's shared findings vocabulary — **severity** (how much friction the shallowness causes), **confidence** (a survey finding is heuristic-class and therefore low by construction; the mechanically checkable end of the scale belongs to the drydock `--check` audit), and **actionable** (whether the deepening move is specific enough to start from the report alone). End the report with the **top recommendation**: the one candidate to deepen first, and why — the captain reads one card, not the whole reef.

**Logbook conflicts.** A candidate that contradicts an existing ADR is nominated only when the friction is real: the card names the ADR and why the water has changed. Theoretical conflicts stay off the report — the logbook's rejections are not re-litigated by default.

The report may be rendered visually with the repo's diagram skill when the yard has one; the prose report stays the source of truth either way.

## Handoff

The report is decision input, not work. Candidates feed the mission brief (launch Phase 1) or grilling material for the next effort. Survey proposes; the captain disposes.

A candidate the captain declines with a load-bearing reason is offered as an ADR — the same ADR test launch applies (hard to reverse, surprising without context, a real tradeoff) — so the next survey does not re-nominate the same reef. Declined without one, it simply sinks.

## Non-goals

- **No code edits.** The survey never refactors, not even "while it's fresh."
- **Not a gate.** Nothing blocks on the report.
- **Not merged into the drydock drift audit.** `--check` stays strictly mechanically checkable — high-confidence findings only. Architecture judgment is a low-confidence heuristic; mixing it in dilutes the contract.

## Completion definition

The survey is done when the report exists with evidence, rankings, and risk notes for every finding — and no file was modified.
