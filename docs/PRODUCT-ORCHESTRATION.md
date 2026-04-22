# Product Orchestration Architecture

This document defines the OMC product-development route from a new product idea to implementation-ready backend and product pipelines.

Agent artifact hygiene, context budgets, role permissions, audit scoring, and same-repository fresh-start behavior are defined in `docs/AGENT-PIPELINE-GOVERNANCE.md`.

## Entry Points

| User intent | Command |
|---|---|
| Start a new product or major pivot | `/product-foundation "<idea or market/problem>"` |
| Clarify a vague product/problem | `/deep-interview "<vague idea>"` |
| Generate divergent feature/product hypotheses | `/ideate "<problem statement>"` |
| Research competitors and market whitespace | `/competitor-scout "<niche>"` |
| Synthesize constitution/brand philosophy | `/brand-steward --pre-mvp --deep` or `/brand-steward --deep` |
| Map product systems and launch capability blocks | `/product-strategist --capability-map "<scope>"` |
| Decide technology stack for approved capability blocks | `/prompts:technology-strategist "<scope>"` |
| Provision stack skills | `/stack-provision .omc/decisions/YYYY-MM-DD-technology-<slug>.md` |
| Build backend/engine capability | `/backend-pipeline "<feature>"` |
| Build user-facing product surface | `/product-pipeline "<feature>"` |

## Layering

OMC separates product development into five layers:

1. **Market/Product Discovery**
   - `deep-interview`
   - `ideate`
   - `competitor-scout`
   - output: `.omc/specs/**`, `.omc/ideas/**`, `.omc/competitors/**`

2. **Brand/Constitution**
   - `brand-steward`
   - `brand-architect`
   - output: `.omc/constitution.md`, `.omc/brand/**`

3. **Product Capability Mapping**
   - `product-strategist --capability-map`
   - output: `.omc/product/capability-map/**`
   - owns: MVP scope, product systems, launch readiness gates, backend/product split, 30/60/90 roadmap, deferred systems, and capability blocks for technology strategy.

4. **Technology/Capability Governance**
   - `technology-strategist`
   - researcher alias: `document-specialist`
   - `critic`
   - `stack-provision`
   - output: `.omc/decisions/**`, `.omc/provisioned/**`
   - owns: concrete technology choices, weighted scorecards, compatibility, risk, and skill provisioning targets.

5. **Execution Pipelines**
   - `backend-pipeline`
   - `product-pipeline`
   - output: source changes, `.omc/handoffs/**`, `.omc/audits/**`

Lower layers consume upper-layer artifacts. They do not re-invent them.

## Canonical New-Product Route

```text
/product-foundation "<idea>"
  Phase 0 intake classification
  Phase 1 deep-interview or ideate
  Phase 2 competitor-scout
  Phase 3 brand-steward
  Phase 4 product-strategist --capability-map
  Phase 5 technology-strategist
  Phase 6 critic
  Phase 7 stack-provision
  Phase 8 backend/product build handoff
```

For pre-MVP products, the brand layer may be hypothesis-grade (`status: partial`) but must still be explicit. Competitor and research gaps lower confidence; they do not license generic brand or stack decisions.

## Product Capability Map Rules

Product Strategist owns the missing middle between brand philosophy and build pipelines. It answers "what product systems must exist for this to be launchable and competitive?" before technology choices are made.

It must produce `.omc/product/capability-map/YYYY-MM-DD-<slug>.md` and refresh `.omc/product/capability-map/current.md`.

The map must include:

- MVP feature set and market-winning differentiators.
- required product systems: auth, onboarding, analytics, telemetry, admin/support, billing, content/data workflows, domain-specific engines, and retention/growth loops.
- launch readiness gates.
- backend/product pipeline split.
- capability blocks for `technology-strategist`.
- 30/60/90 roadmap.
- deferred systems with revisit triggers.
- a handoff to `technology-strategist`.

It must not:

- select concrete technologies, vendors, SDKs, or libraries.
- install or provision skills.
- generate a one-feature-only roadmap when the user is trying to build a product.
- read legacy product source during `--fresh-start` except as explicitly whitelisted reference.

## Technology Strategy Rules

Technology Strategist is not a package recommender and not the product roadmap owner. It consumes the capability map and converts product systems into concrete stack decisions, compatibility judgments, risks, and skill/provisioning targets.

It must:

- classify domain and monetization/engagement model.
- consume `.omc/product/capability-map/current.md` when present.
- infer missing application blocks only to challenge or complete the map, not to silently replace it.
- explicitly evaluate retention/growth systems: analytics, experimentation, lifecycle messaging, in-app guidance, referrals, gamification, retention modeling, session replay, personalization, NPS/feedback, segmentation.
- separate concrete stack technologies from product capability blocks.
- compute the fixed weighted score:
  - Product Fit: 30%
  - Operability: 20%
  - Ecosystem Maturity: 20%
  - Performance: 15%
  - Security/Compliance: 10%
  - Cost: 5%
- produce pairwise compatibility for `auth`, `analytics`, `telemetry`, `frontend-core`, `backend-core`, and `integration-layer`.
- emit handoff-envelope v2.

It must not:

- assume the first stack is permanent.
- skip auth/analytics/telemetry/operations because the user did not mention them.
- pass granular product blocks directly into `stack-provision --blocks` unless they map to canonical blocks.
- send anything to `stack-provision` when compatibility is `blocked`.

## Dynamic Routing

| Signal | Route |
|---|---|
| `requirements_completeness < 0.75` | `deep-interview` |
| `unknown_critical_inputs >= 2` | `deep-interview` |
| `top2_score_gap < 8` | `document-specialist` researcher |
| critical compatibility is `unknown` | `document-specialist` researcher |
| fresh external evidence is missing for key technology | `document-specialist` researcher |
| critic `approve` | `stack-provision` |
| critic `revise` | back to `technology-strategist` |
| critic `rewind` | hard rewind to `product-strategist --capability-map`; invalidate downstream technology/provision artifacts |
| rewind count > 2 | `deep-interview` + human decision gate |

## Stack Provisioning Rules

`stack-provision` is Strict Gate by default:

- no install before critic approval.
- no install if source trust `< 0.85`.
- no install if freshness exceeds 180 days.
- no install without checksum.
- no install with license conflict.
- generated skills are fallback only and stay marked with generated provenance.
- untrusted candidates stay in `.omc/provisioned/runs/<run-id>/quarantine`.

## Feature Pipeline Integration

`backend-pipeline` and `product-pipeline` include conditional technology preflight:

- backend: Stage 3.5, after requirements and before architecture.
- product: Stage 2.5, after strategic gate and before UX research/flow design.

Skip this preflight only when a current ADR and verified provisioning manifest explicitly cover the feature's capability blocks.

## Visual Product Quality

For user-facing surfaces, `product-pipeline` must treat the brand and visual layer as first-class:

- read `.omc/constitution.md` and `.omc/brand/**`.
- prefer original visual concepts grounded in brand philosophy, competitor whitespace, and product meaning.
- provision visual-creative skills when the feature needs motion, generated imagery, 3D, illustration, iconography, typography exploration, or visual QA.
- avoid generic UI defaults that contradict the constitution.

## Handoff And Permissions

The orchestrator owns state. Agents write artifacts.

| Role | Read | Write |
|---|---|---|
| Orchestrator | state and envelopes | `.omc/state/**`, `.omc/handoffs/**` |
| Product Strategist | compact product/market/brand context read-only | `.omc/strategy/**`, `.omc/product/capability-map/**` |
| Technology Strategist | compact product context and code/config read-only | `.omc/decisions/**`, `.omc/handoffs/**` |
| Researcher | docs/external/context read-only | `.omc/artifacts/**`, `.omc/handoffs/**` |
| Critic | upstream artifacts read-only | `.omc/audits/**`, `.omc/handoffs/**` |
| Stack Provision | run contract/review/provision files | `.omc/provisioned/**`, approved skill root |
| Backend/Product pipelines | approved plans and code | scoped source/test files |

All stack strategy/provisioning handoffs use handoff-envelope v2. Malformed envelopes are rejected and corrected before the next agent runs.

## Practical Command Sequence

```bash
/product-foundation "AI-native knitting companion for advanced hobbyists" --pre-mvp --deep-brand
```

For a major pivot in the same repository:

```bash
/product-foundation "AI-native knitting companion for advanced hobbyists" --fresh-start --pre-mvp --deep-brand
```

Then follow the foundation report:

```bash
/backend-pipeline "<first backend capability from the foundation report>"
/product-pipeline "<first user-facing flow from the foundation report>"
```

For an already-running project with a new capability:

```bash
/backend-pipeline "add subscription billing with Stripe, invoices, dunning, and audit trail"
```

or:

```bash
/product-pipeline "build onboarding flow with activation analytics and in-app guidance"
```

The pipeline will run the technology preflight only if existing ADR/provisioning does not cover those blocks.
