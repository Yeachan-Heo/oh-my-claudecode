---
name: agent-doc-discipline
description: "Writing-time discipline for documents agents consume (the five surfaces, specs, tickets, .omc/skills/) — every rule checkable and carrying a why, steps before reference, one meaning in one home, no restating what the environment already says. Mandatory at drydock seed generation and the launch C5 sediment pass; opt-in for any other agent-facing doc edit. The companion of minimal-code-discipline: that one disciplines code, this one disciplines papers."
level: 3
---

# Agent Doc Discipline

Use this skill to apply a writing-time discipline while creating or editing any document an agent consumes to act: the five surfaces (`CLAUDE.md`, `CONTEXT.md`, `docs/standards/`, `design-system/`, `.omc/skills/`), specs, tickets, and skill files. The test a document must pass: **a fresh agent session can act on it by reading alone.**

Mandatory when: drydock generates surface seeds, the launch C5 sediment pass writes a lesson into a slot. Opt-in for every other edit — but any edit to an agent-facing document should survive these rules.

## When Not to Use

Documents written for humans only: `docs/business/` narrative, ADR decision stories, READMEs for human onboarding. They may still follow the rules where it costs nothing, but they are not held to this discipline.

## The Discipline

**Write for a reader with no chat history.** The document is self-describing: nothing leans on "as discussed", a prior session, or knowledge that lives in someone's head. _Test:_ a brand-new agent session can act on the document by reading alone.

**Every rule checkable and carrying a why.** No "keep it clean" — write the observable condition and the reason. _Test:_ an agent can decide pass/fail from the text alone, and the why is stated next to the rule.

**One meaning, one home.** Each rule or definition has a single authoritative place; duplication is drift waiting to happen. _Test:_ changing a behavior is a one-place edit.

**Never restate what the environment confesses.** Package scripts, directory layouts, `--help` output are lookups, not documents — a copied lookup goes stale. Document only what cannot be found by looking: the unwritten convention, the reason behind a choice, the gotcha. _Test:_ every line survives "can this be looked up elsewhere?".

**Steps first, reference behind, rare material behind a pointer.** What to do, in order, at the top; consult-on-demand rules below; low-frequency material pushed behind a pointer whose wording names the branches that should trigger reaching it. _Test:_ the next action is findable within the first screen.

**Every step ends on a completion criterion.** Done must be tellable from not-done — a vague bound invites premature completion. _Test:_ for each step, "how do I know this is finished?" has an answer in the text.

**A procedure longer than two steps is numbered.** The numbers are stable references: a reader can name step 3, follow the order, and jump without re-reading. An unnumbered procedure of many steps makes the reader hold the order in their head. _Test:_ every procedure of three or more steps carries its numbers.

**A list is capped at what a reader holds in one glance.** A list that outgrows the reader's grasp loses its point — nothing in it is findable. A longer enumeration becomes structure (a table, subsections) or splits. This governs the writing of documents; it never touches the machinery of a gate or a batched decision, which lives in the methodology, not the prose. _Test:_ every list in the document fits in one glance, and any longer enumeration has become structure.

**Deferred and scheduled work states when.** A document that defers work to a later step, session, or release states that timing next to the work it defers — "when" is a fact the reader needs to act, and an unstated deferral reads as an unstarted one. The timing is stated in the prose only; it never rebinds a checkpoint the methodology pushes right deliberately. _Test:_ every deferral in the document carries its when.

**Close on a next action a reader can start now.** A report, ticket, or session-close pointer ends not with a summary but with the one next step a reader can begin in under two minutes — the destination, the pointer, or the command. A close that only summarizes makes the reader re-derive what to do first. _Test:_ the last line answers "what do I do next?" without scrolling up.

**Re-state the position each time the reader rejoins.** A document a returning reader touches mid-flight (a long spec, a run report, a map Notes section) opens the new material with where things stand — step, phase, or decision count — before adding anything new. _Test:_ a reader arriving cold can locate the current state in the first two lines of the newest section.

**Prompt the positive.** State the target behavior; a prohibition is reserved for hard guardrails and is always paired with the positive target. _Test:_ every prohibition in the document names the thing to do instead.

**Scrape barnacles on write.** When the document contains stale or redundant material, remove it in the same edit; when it does not, add only the required material and do not invent deletions. A sentence the model already obeys by default pays load for nothing — delete the whole sentence. _Test:_ every line re-read earns its place against "does this change behavior versus the default?", and any stale or redundant material found during the edit is gone.

## Verification

Before reporting a document change done, confirm:

- a fresh session could act on it without asking a human anything
- every rule is checkable and states its why; no rule restates a lookup
- meanings live in one place; pointers name their trigger branches
- stale or redundant material found during the edit was removed, while valid unrelated content was preserved
- closes end on a next action the reader can start now; rejoining readers find the current state stated before new material
- procedures of three or more steps are numbered; lists fit in one glance; every deferral states its when
