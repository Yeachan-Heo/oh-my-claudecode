---
name: product-strategist
description: Slash-wrapper for the product-strategist agent — evaluates a feature proposal against constitution anti-goals, mission, and scope; produces APPROVED / APPROVED WITH RISKS / NEEDS CLARIFICATION / BLOCKED verdict in .omc/strategy/
argument-hint: "<feature description or slug>"
level: 4
---

# Product Strategist Skill

Thin wrapper that invokes the `product-strategist` agent as a slash command. Useful when you want a standalone strategic gate on a feature idea WITHOUT running the full product-pipeline or backend-pipeline (e.g., triaging a backlog, pre-checking ideate output, evaluating a partner request).

## Usage

```
/oh-my-claudecode:product-strategist "<feature description>"
/product-strategist "<feature slug from .omc/ideas/>"
/product-strategist --classify .omc/ideas/<latest>.md   # classify shortlist as core / enabling / context
```

### Examples

```
/product-strategist "add AI-generated pattern suggestions to the knitting marketplace"
/product-strategist matching-algorithm                  # slug from ideas
/product-strategist --classify .omc/ideas/2026-04-19-onboarding.md
```

<Purpose>
Invokes `product-strategist` agent to gate a proposed feature against constitution anti-goals and mission, producing a structured evaluation. Also supports batch classification of idea shortlists as core / enabling / context (which feeds pre-launch-sprint's depth scaling).
</Purpose>

<Use_When>
- You have a feature idea and want a strategic gate before committing to a pipeline.
- You want to triage a backlog against anti-goals without running the full product-pipeline for each.
- You need to classify an idea shortlist (from ideate) as core / enabling / context for depth planning.
- A design partner requested a feature and you need to check it against constitution.
</Use_When>

<Do_Not_Use_When>
- You are ready to build and need the full pipeline — use `/product-pipeline` or `/backend-pipeline`.
- You need to generate features — use `/ideate`.
- You need to measure shipped features — use quality-audit + scientist.
- No constitution exists yet — run `/brand-steward --session1` first.
</Do_Not_Use_When>

<Protocol>

## Phase 0 — Prerequisite Check

Read `.omc/constitution.md`.
- If absent → HARD STOP: "Strategic gate requires a constitution. Run `/brand-steward --session1` first."
- If `status: draft` → warn: "Evaluation against a draft constitution produces UNVALIDATED findings. Proceed but treat output as directional."
- If `status: partial | complete` → proceed.

## Phase 1 — Input Parsing

Input can be:
1. **Inline feature description** — `/product-strategist "add X to Y"` — agent evaluates the description.
2. **Slug reference** — `/product-strategist <slug>` — look for the feature in `.omc/ideas/` or `.omc/roadmap/` matching slug.
3. **Classification batch** — `--classify <path-to-ideas-file>` — agent classifies each idea in the file.

## Phase 2 — Invoke Agent

### For evaluation mode

Invoke `oh-my-claudecode:product-strategist` with directive:
- Read `.omc/constitution.md` + feature description (from input).
- Evaluate against: anti-goals (verbatim match for violations), mission alignment, scope boundaries, strategic risks.
- Result: APPROVED | APPROVED WITH RISKS | NEEDS CLARIFICATION | BLOCKED.
- Write `.omc/strategy/YYYY-MM-DD-<slug>.md`.

### For classification mode

Invoke with directive:
- Read the referenced ideas file + constitution.
- For each idea, tag as `core | enabling | context` with one-line justification citing mission and anti-goals.
- Write `.omc/classification/features-core-context.md` (creates or appends; never overwrites without supersession pointer).

## Phase 3 — Post-Invocation Summary

Report:
- Verdict (or classification distribution).
- Key risks or anti-goal conflicts flagged.
- Recommended next steps: `/ideate` if NEEDS CLARIFICATION, `/brand-steward` if BLOCKED by anti-goal and the anti-goal is wrong, pipeline invocation if APPROVED.

</Protocol>

<Input_Contract>
Primary argument: feature description (quoted) OR slug OR `--classify <path>`.
</Input_Contract>

<Output>
Evaluation mode: `.omc/strategy/YYYY-MM-DD-<slug>.md` with verdict, anti-goal citations, risks.
Classification mode: `.omc/classification/features-core-context.md` with per-idea tag + rationale.
</Output>

<Failure_Modes_To_Avoid>
- Running without a constitution — gate is meaningless without anti-goals.
- Batch-classifying without reading constitution (each classification needs mission-citation).
- Silently overwriting prior classification file (supersession required).
- Treating BLOCKED verdict as a veto without offering path: either constitution change via brand-steward, or feature revision.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Delegates to `oh-my-claudecode:product-strategist` agent.
- Used standalone OR within `/product-pipeline` Stage 2 / `/backend-pipeline` Stage 2 (those invoke it internally).
- Consumers: `/priority-engine` reads strategy verdicts; `/pre-launch-sprint` reads classification file.
- Prerequisite: `.omc/constitution.md` with status ≥ partial.
</Integration_Notes>
