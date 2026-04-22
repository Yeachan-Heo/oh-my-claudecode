---
name: product-strategist
description: Slash-wrapper for the product-strategist agent — evaluates feature proposals against constitution anti-goals OR builds a Product Capability & Launch Map for a product foundation. Use --capability-map when the user needs to know what product features/systems are required beyond the first named MVP features before technology-strategist runs.
argument-hint: "<feature description or slug> | --capability-map \"<product scope>\""
level: 4
---

# Product Strategist Skill

Thin wrapper that invokes the `product-strategist` agent as a slash command. Useful when you want a standalone strategic gate on a feature idea WITHOUT running the full product-pipeline or backend-pipeline, or when `product-foundation` needs a Product Capability & Launch Map before `technology-strategist`.

## Usage

```
/oh-my-claudecode:product-strategist "<feature description>"
/product-strategist "<feature slug from .omc/ideas/>"
/product-strategist --classify .omc/ideas/<latest>.md   # classify shortlist as core / enabling / context
/product-strategist --capability-map "knitting companion; known features: raglan calculator, PDF pattern parsing"
```

### Examples

```
/product-strategist "add AI-generated pattern suggestions to the knitting marketplace"
/product-strategist matching-algorithm                  # slug from ideas
/product-strategist --classify .omc/ideas/2026-04-19-onboarding.md
/product-strategist --capability-map "AI-native knitting companion for advanced hobbyists"
```

<Purpose>
Invokes `product-strategist` agent to gate a proposed feature against constitution anti-goals and mission, producing a structured evaluation. Also supports batch classification of idea shortlists as core / enabling / context, and product-level capability mapping for new-product foundation work.
</Purpose>

<Use_When>
- You have a feature idea and want a strategic gate before committing to a pipeline.
- You want to triage a backlog against anti-goals without running the full product-pipeline for each.
- You need to classify an idea shortlist (from ideate) as core / enabling / context for depth planning.
- You have brand/competitor/idea artifacts but do not yet know the complete MVP/product-system map.
- `product-foundation` needs a bridge artifact between `brand-steward` and `technology-strategist`.
- A design partner requested a feature and you need to check it against constitution.
</Use_When>

<Do_Not_Use_When>
- You are ready to build and need the full pipeline — use `/product-pipeline` or `/backend-pipeline`.
- You need divergent feature generation with multiple creative methods — use `/ideate`.
- You need concrete technology/provider choices — use `technology-strategist`.
- You need to measure shipped features — use quality-audit + scientist.
- No constitution exists yet — run `/brand-steward --pre-mvp --deep` first for a new product, or `/brand-steward --deep` for an established product.
</Do_Not_Use_When>

<Protocol>

## Phase 0 — Prerequisite Check

Read `.omc/constitution.md`.
- If absent → HARD STOP: "Strategic gate requires a constitution. Run `/brand-steward --pre-mvp --deep` first for a new product, or `/brand-steward --deep` for an established product."
- If `status: draft` → warn: "Evaluation against a draft constitution produces UNVALIDATED findings. Proceed but treat output as directional."
- If `status: partial | complete` → proceed.

## Phase 1 — Input Parsing

Input can be:
1. **Inline feature description** — `/product-strategist "add X to Y"` — agent evaluates the description.
2. **Slug reference** — `/product-strategist <slug>` — look for the feature in compact/index artifacts first: `.omc/features/<slug>/brief.md`, `.omc/ideas/current.md`, `.omc/roadmap/current.md`, or relevant index files. Do not scan whole archives unless the slug is not found.
3. **Classification batch** — `--classify <path-to-ideas-file>` — agent classifies each idea in the file.
4. **Capability map** — `--capability-map "<product scope>"` — agent synthesizes MVP feature set, product systems, launch gates, backend/product split, roadmap, deferred systems, and capability blocks for technology-strategist.

## Phase 2 — Invoke Agent

### For evaluation mode

Invoke `oh-my-claudecode:product-strategist` with directive:
- Read `.omc/constitution.md` + feature description (from input).
- If resolving a slug, read only the explicit feature artifact or compact current/index file needed to identify it.
- Evaluate against: anti-goals (verbatim match for violations), mission alignment, scope boundaries, strategic risks.
- Result: APPROVED | APPROVED WITH RISKS | NEEDS CLARIFICATION | BLOCKED.
- Write `.omc/strategy/YYYY-MM-DD-<slug>.md`.

### For classification mode

Invoke with directive:
- Read the referenced ideas file + constitution.
- For each idea, tag as `core | enabling | context` with one-line justification citing mission and anti-goals.
- Write `.omc/classification/features-core-context.md` (creates or appends; never overwrites without supersession pointer).

### For capability-map mode

Invoke with directive:
- Read `.omc/constitution.md`.
- Read compact product/market context only: `.omc/ideas/current.md`, `.omc/specs/current.md`, `.omc/competitors/index.md`, `.omc/competitors/landscape/current.md`, `.omc/research/current.md`, `.omc/brand/index.md`, `.omc/brand/core.md`, `.omc/brand/grammar.md` when present.
- Do not scan full archives by default.
- Synthesize Product Capability & Launch Map:
  - MVP feature set.
  - market-winning differentiators.
  - required product systems.
  - retention/growth systems.
  - launch readiness gates.
  - backend/product split.
  - capability blocks for technology-strategist.
  - 30/60/90 roadmap.
  - deferred systems and revisit triggers.
- Write one dated map at `.omc/product/capability-map/YYYY-MM-DD-<slug>.md`.
- Replace compact pointer `.omc/product/capability-map/current.md`.
- Append a standard `<handoff>` envelope pointing to `technology-strategist`.

## Phase 3 — Post-Invocation Summary

Report:
- Verdict (or classification distribution).
- Capability-map path and whether it is ready for technology strategy.
- Key risks or anti-goal conflicts flagged.
- Recommended next steps: `/ideate` if NEEDS CLARIFICATION, `/brand-steward` if BLOCKED by anti-goal and the anti-goal is wrong, pipeline invocation if APPROVED.

</Protocol>

<Input_Contract>
Primary argument: feature description (quoted) OR slug OR `--classify <path>` OR `--capability-map "<product scope>"`.
</Input_Contract>

<Output>
Evaluation mode: `.omc/strategy/YYYY-MM-DD-<slug>.md` with verdict, anti-goal citations, risks.
Classification mode: `.omc/classification/features-core-context.md` with per-idea tag + rationale.
Capability-map mode: `.omc/product/capability-map/YYYY-MM-DD-<slug>.md` plus `.omc/product/capability-map/current.md`.
</Output>

<Failure_Modes_To_Avoid>
- Running without a constitution — gate is meaningless without anti-goals.
- Batch-classifying without reading constitution (each classification needs mission-citation).
- Capability-mapping without reading competitors/brand/ideas current files when they exist.
- Resolving slugs by loading entire `.omc/ideas/`, `.omc/roadmap/`, or `.omc/features/` archives. Use explicit paths, current files, and indexes first.
- Silently overwriting prior classification file (supersession required).
- Creating one artifact per feature/system in capability-map mode. Write one map plus current pointer.
- Selecting concrete technologies in capability-map mode. Hand product capability blocks to technology-strategist.
- Treating BLOCKED verdict as a veto without offering path: either constitution change via brand-steward, or feature revision.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Delegates to `oh-my-claudecode:product-strategist` agent.
- Used standalone OR within `/product-pipeline` Stage 2 / `/backend-pipeline` Stage 2 (those invoke it internally).
- Used by `/product-foundation` after `brand-steward` and before `technology-strategist`.
- Consumers: `/priority-engine` reads strategy verdicts; `/pre-launch-sprint` reads classification file.
- `technology-strategist` reads `.omc/product/capability-map/current.md` to produce ADRs and stack-provision handoffs.
- Prerequisite: `.omc/constitution.md` with status ≥ partial.
</Integration_Notes>
