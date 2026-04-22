---
name: product-foundation
description: Market-to-stack product foundation workflow for a new product or major pivot. Orchestrates deep-interview/ideate, competitor-scout, brand-steward, product-strategist capability mapping, technology-strategist, critic, and stack-provision before backend-pipeline/product-pipeline feature work begins.
argument-hint: "\"<product idea or market/problem>\" [--pre-mvp] [--deep-brand] [--fresh-start] [--skip-provision] [--backend-first|--product-first]"
level: 4
---

# Product Foundation

Build the product foundation before feature execution: articulate the product, scout the market, synthesize brand/constitution, map the product capability and launch systems, derive the capability stack, provision skills under Strict Gate, then hand off to `backend-pipeline` and/or `product-pipeline`.

This skill is the top-level route for starting a new product or major pivot. It is intentionally not an implementation pipeline. It prepares the evidence, brand layer, stack decisions, and skill coverage that lower-level pipelines need.

## Usage

```bash
/oh-my-claudecode:product-foundation "<product idea or market/problem>"
/product-foundation "<product idea>" --pre-mvp --deep-brand
/product-foundation "<major pivot>" --fresh-start --pre-mvp --deep-brand
/product-foundation "<clear product concept>" --skip-provision
/product-foundation "<backend-heavy product>" --backend-first
```

## When To Use

- Starting a new product from an idea, market, or vague problem.
- Repositioning after a competitor, market, or brand shift.
- Preparing a new product ecosystem before calling `backend-pipeline` or `product-pipeline`.
- You need technology strategy and skill provisioning to reflect product blocks such as auth, analytics, telemetry, billing, retention, content, moderation, or domain-specific systems.

Do not use this for a single already-approved feature. Use `backend-pipeline` or `product-pipeline` directly, which will run their own conditional technology preflight when needed.

## Architecture

The foundation route is evidence-first and resumable through `.omc/**` artifacts:

```text
deep-interview OR ideate
  -> competitor-scout
  -> brand-steward
  -> product-strategist --capability-map
  -> technology-strategist
  -> researcher if needed
  -> critic
  -> stack-provision
  -> backend-pipeline / product-pipeline
```

The orchestrator owns state transitions. Agents own their artifacts. `stack-provision` is the only lane that may write installed skills, and only after critic approval and Strict Gate review.

## Pipeline

### Phase 0 - Intake Classification

Read the invocation, existing `.omc/constitution.md`, `.omc/ideas/current.md`, `.omc/specs/current.md`, `.omc/competitors/index.md`, `.omc/competitors/landscape/current.md`, `.omc/research/current.md`, `.omc/brand/index.md`, and `.omc/provisioned/current.json` when present.

If `--fresh-start` is present, create a reset/context-boundary note before reading legacy project details:

- Write `.omc/reset/YYYY-MM-DD-<slug>.md` with the reason for the reset, allowed carry-over artifacts, and explicitly ignored legacy areas.
- Treat existing source code and old `.omc/**` artifacts as legacy reference only unless the user explicitly whitelists them.
- Keep `.git/`, framework files, reusable prompts/skills, and OMC infrastructure in scope; ignore stale product implementation decisions by default.

Classify the input:

| Condition | Next step |
|---|---|
| Problem/product is vague, missing target user, missing job, or founder says not to assume | `/deep-interview "<input>"` |
| Problem is clear but solution space is open | `/ideate "<input>"` |
| Product concept and first feature are clear | continue to competitor scout |
| Existing foundation artifacts are fresh and accepted | skip to Phase 5 technology strategy |

Freshness defaults:
- Competitor landscape: fresh for 30 days; use `competitor-scout --refresh` when stale.
- Constitution: valid until a major pivot, new target segment, or material market shift.
- Technology ADR/provisioning manifest: valid only for capability blocks explicitly covered by the current feature/product block.

### Phase 1 - Product Articulation

Produce at least one vision source:

- `/deep-interview "<vague idea>"` writes `.omc/specs/**` when the problem is ambiguous.
- `/ideate "<problem statement>"` writes `.omc/ideas/**` when divergent hypotheses are needed.

Hard stop: do not run brand or stack strategy without at least one current vision source.

### Phase 2 - Competitive Landscape

Run:

```bash
/competitor-scout "<niche or product category>"
```

Use `--refresh` if a watchlist already exists. The output must include `.omc/competitors/index.md` and `.omc/competitors/landscape/current.md`, or a halted artifact explaining why scouting could not complete.

Hard stop in post-MVP mode: fewer than three credible competitor dossiers. In pre-MVP mode, continue but mark brand and technology whitespace assumptions LOW confidence.

### Phase 3 - Brand Constitution

Run:

```bash
/brand-steward --pre-mvp --deep
```

when the product is pre-MVP and needs a hypothesis-grade constitution, or:

```bash
/brand-steward --deep
```

when post-MVP or sufficient research/competitor inputs exist. Omit `--deep` only when the user explicitly wants a shallow brand layer.

Output: `.omc/constitution.md`.

Hard stop: if brand-steward refuses due to missing research/vision inputs, do not route to implementation. Remediate the missing input first.

### Phase 4 - Product Capability & Launch Map

Invoke `product-strategist` after brand and market context exist:

```bash
/product-strategist --capability-map "<product scope + competitor/brand context>"
```

Product Strategist must produce `.omc/product/capability-map/YYYY-MM-DD-<slug>.md` and refresh `.omc/product/capability-map/current.md`.

The capability map must separate:

- MVP feature set.
- market-winning differentiators.
- required product systems such as auth, onboarding, analytics, telemetry, admin, support, billing, content, moderation, and domain-specific systems.
- retention/growth systems.
- launch readiness gates.
- backend/product pipeline split.
- capability blocks for `technology-strategist`.
- 30/60/90 roadmap.
- deferred systems with revisit triggers.

Hard stop: do not route to technology strategy without a current capability map unless the invocation is a narrow feature-preflight from `backend-pipeline` or `product-pipeline`.

### Phase 5 - Capability Stack Strategy

Invoke `technology-strategist` after brand and market context exist:

```bash
/prompts:technology-strategist "<product scope + first 3 feature directions + known stack>"
```

Technology Strategist must:

- classify domain and monetization/engagement model.
- consume `.omc/product/capability-map/current.md` when present.
- convert product capability blocks into technology options, scorecards, compatibility reports, and skill targets.
- evaluate retention/growth blocks, not only engineering blocks.
- produce weighted scorecards and pairwise compatibility report.
- request `deep-interview` if `requirements_completeness < 0.75` or `unknown_critical_inputs >= 2`.
- request researcher (`document-specialist`) if `top2_score_gap < 8`, critical compatibility is unknown, or fresh external evidence is missing.
- emit handoff-envelope v2 and a concrete `stack-provision` command.

Hard stop: any `blocked` compatibility pair. The strategist must revise or route to critic; provisioning is forbidden.

### Phase 6 - Critic Gate

Run critic on the technology ADR and v2 handoff:

```bash
/prompts:critic ".omc/decisions/YYYY-MM-DD-technology-<slug>.md"
```

Verdicts:

| Verdict | Route |
|---|---|
| `approve` | continue to stack-provision |
| `revise` | return to technology-strategist with exact findings |
| `rewind` | hard rewind to `product-strategist --capability-map`, invalidate downstream scorecard/compatibility/provision artifacts |

Hard rewind limit is two. After two rewinds, run `/deep-interview` and require human decision before further stack changes.

### Phase 7 - Strict Stack Provisioning

Skip only when `--skip-provision` is explicit. Otherwise run the command emitted by the ADR, then:

```bash
node skills/stack-provision/scripts/init.mjs "<ADR path>" --json
node skills/stack-provision/scripts/provision.mjs discover .omc/provisioned/runs/<run-id> --json
node skills/stack-provision/scripts/provision.mjs review .omc/provisioned/runs/<run-id> --critic-verdict=approve --research-ack --json
node skills/stack-provision/scripts/provision.mjs promote .omc/provisioned/runs/<run-id> --skill-root ~/.codex/skills/omc-provisioned --json
node skills/stack-provision/scripts/provision.mjs verify .omc/provisioned/runs/<run-id> --json
```

Only approve candidates that meet Strict Gate:

- `source_trust >= 0.85`
- `freshness_days <= 180`
- checksum valid
- license without conflict
- review gate approved
- critic verdict is `approve`

Untrusted or generated candidates stay in quarantine until manual review.

### Phase 8 - Build Handoff

Produce a foundation summary with:

- vision/spec artifact paths.
- competitor landscape path.
- constitution path.
- product capability map path.
- technology ADR path.
- provisioning manifest path.
- recommended first feature sequence.
- whether to start with `backend-pipeline`, `product-pipeline`, or both.

Default routing:

- Backend-heavy capability, data model, API, auth, billing, jobs, integrations: `/backend-pipeline "<feature>"`
- User-facing flow, interaction, visual system, copy, onboarding, dashboards: `/product-pipeline "<feature>"`
- Both surfaces: run `backend-pipeline` first for contracts/API/state model, then `product-pipeline` for the product surface.

## State And Handoff Rules

- The orchestrator is the only role that updates pipeline state.
- `product-strategist` is read-only for code and writes only `.omc/strategy/**` for feature gates or `.omc/product/capability-map/**` for capability-map mode.
- `technology-strategist`, researcher, and critic are read-only for code and write only `.omc/decisions/**`, `.omc/handoffs/**`, `.omc/artifacts/**`, or `.omc/audits/**` as appropriate.
- `stack-provision` writes only `.omc/provisioned/**` before approval and `~/.codex/skills/omc-provisioned/**` after approval.
- Every primary artifact should end with a `<handoff>` block. Stack strategy/provisioning artifacts must also include handoff-envelope v2 fields.

## Output

Terminal summary plus pointers:

```markdown
## Product Foundation Report

**Status:** ready-for-build | halted | needs-research | needs-human-decision

### Foundation Artifacts
| Layer | Path | Status |
|---|---|---|
| Vision/spec | `.omc/specs/...` or `.omc/ideas/...` | ... |
| Competitors | `.omc/competitors/landscape/current.md` | ... |
| Constitution | `.omc/constitution.md` | ... |
| Capability map | `.omc/product/capability-map/current.md` | ... |
| Technology ADR | `.omc/decisions/YYYY-MM-DD-technology-<slug>.md` | ... |
| Provisioning | `.omc/provisioned/runs/<run-id>/manifest.json` | ... |

### Recommended Build Order
1. `/backend-pipeline "..."`
2. `/product-pipeline "..."`
```

## Failure Modes To Avoid

- Running product/backend implementation before brand and stack are grounded.
- Letting Technology Strategist invent the product roadmap when a capability map is missing.
- Treating technology strategy as one-time setup. Re-run it whenever a new capability block appears.
- Provisioning from a stack list without the strategist's application-block context.
- Letting product-pipeline invent visual systems that contradict `.omc/constitution.md` or `.omc/brand/**`.
- Letting backend-pipeline choose infra/auth/payment technologies ad hoc during implementation.
- Accepting unknown compatibility on a critical path without researcher pass.
- Self-approving generated skills or external downloads.
