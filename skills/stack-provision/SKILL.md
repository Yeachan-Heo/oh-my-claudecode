---
name: stack-provision
description: Capability provisioner for backend, frontend, mobile, infra, data/AI, product UX, and visual-creative work. Use after a stack decision or when adopting technologies to derive capability packs, skill coverage, agents, creative context, review gates, quarantine installs, manifests, and rollback plans from an ADR or explicit stack list.
argument-hint: "[ADR-path | \"tech1, tech2, ...\"] [--surfaces=<list>] [--creative-intent=<brief>] [--aspects=<list>] [--no-generate] [--dry-run]"
level: 4
---

# Stack Provision

Turn a chosen stack into a reviewed capability system: agents, skills, context files, discovery targets, generated drafts, install decisions, manifests, and rollback records. This skill is not only for backend packages. It covers backend, frontend engineering, product UX, visual creativity, mobile, infra/devops, and data/AI.

The core contract is deterministic. Always initialize a run with the bundled helper before discovery or installation.

```bash
node skills/stack-provision/scripts/init.mjs "<stack or ADR path>" --json
node skills/stack-provision/scripts/provision.mjs discover .omc/provisioned/runs/<run-id> --json
```

## Usage

```bash
/stack-provision .omc/decisions/2026-04-20-stack.md
/stack-provision "next.js, react, tailwind, supabase, postgres, playwright"
/stack-provision "next.js, react, tailwind, framer-motion, three.js, supabase" --surfaces=frontend-engineering,frontend-product,visual-creative --creative-intent="distinct visual identity, generated assets, motion system"
/stack-provision "flutter, supabase, sentry" --surfaces=mobile,backend --aspects=testing,security,performance
/stack-provision "airflow, dbt, postgres" --surfaces=data-ai,backend --no-generate
/stack-provision "next.js, supabase" --dry-run --json
```

## Flags

- `--surfaces=<list>`: Explicit capability surfaces. Known values: `backend`, `frontend-engineering`, `frontend-product`, `visual-creative`, `mobile`, `infra-devops`, `data-ai`.
- `--surfaces-only`: Use only the explicit `--surfaces` list instead of unioning it with inferred surfaces.
- `--creative-intent=<brief>`: Adds the `visual-creative` surface and preserves its full creative aspect set.
- `--aspects=<list>`: Narrow aspects for non-creative surfaces. With `--creative-intent`, visual aspects still include art direction, generated imagery, typography, illustration, motion, brand assets, and visual QA.
- `--no-generate`: Discovery and review only. Do not generate draft skills for gaps.
- `--dry-run`: Build the run contract and review plan without writing files or installing anything.
- `--json`: Emit machine-readable output from the helper.
- `--config=<path>`: Override `config/default-capability-packs.json`.
- `--out=<path>`: Override `.omc/provisioned/runs`.
- `--run-id=<id>`: Deterministic run id for tests or repeatable scripts.

## Run Contract

Phase 0 must produce these artifacts:

```text
.omc/provisioned/
  current.json
  runs/<run-id>/
    contract.json
    capability-matrix.json
    state.json
    review.md
```

Use:

```bash
node skills/stack-provision/scripts/init.mjs "<ADR path or stack list>" [flags] --json
```

Translate the user's command into one stack/ADR argument plus explicit helper flags. Do not pass the whole slash-command text as a single quoted argument if it includes flags.

If the user provided an ADR path, the helper extracts stack entries from `## Decision`, `## Chosen Stack`, `## Technology Stack`, or `## Stack`. Otherwise it treats the first positional argument as a comma-separated technology list.

The generated contract is the source of truth for all later phases. Do not invent extra surfaces, aspects, or install targets outside the contract unless you write an updated contract first.

## Capability Surfaces

- `backend`: APIs, data stores, auth, security, reliability, observability, testing, performance.
- `frontend-engineering`: Components, state, routing, forms, accessibility, performance, frontend tests, visual regression.
- `frontend-product`: Flows, onboarding, empty/error states, copy, analytics, experiments, feedback loops.
- `visual-creative`: Art direction, visual language, inspiration synthesis, generated bitmap assets, iconography, typography, illustration, motion, brand assets, visual QA.
- `mobile`: App architecture, navigation, native/platform APIs, offline data, accessibility, release readiness.
- `infra-devops`: CI/CD, containers, cloud infra, secrets, monitoring, rollback, cost.
- `data-ai`: Data pipelines, data quality, model APIs, evals, vector search, AI observability, cost.

## Visual-Creative Contract

When `visual-creative` is present, treat it as a first-class capability surface. It must not be reduced to CSS styling or frontend implementation.

Use available project context selectively:

- `.omc/constitution.md`
- `.omc/brand/index.md`
- `.omc/brand/core.md`
- `.omc/brand/grammar.md`
- `.omc/brand/inspiration.md`
- `.omc/brand/expressions/current.md`
- `.omc/digests/competitors-landscape.md`
- `.omc/ideas/current.md`

Expected outputs for this surface can include:

- Direction boards and inspiration ledgers.
- Generated image prompts and bitmap assets.
- Icon, illustration, shape, texture, and motion language.
- Typography exploration and font selection criteria.
- Visual QA criteria and screenshot verdict loops.

Prefer existing local skills when available: `imagegen`, `meaning-driven-ui-builder`, `visual-verdict`, `brand-architect`, `brand-steward`, `brand-variations-generate`, `inspiration-fetch`, and `competitor-scout`.

## Architecture

The provisioner has six bounded phases.

1. `contract`: Deterministically parse the stack and write `contract.json`, `capability-matrix.json`, `state.json`, and `review.md`.
2. `discovery`: Search installed skills, bundled OMC skills, enabled plugin skills, skills.sh, plugin marketplaces, and whitelisted repositories for each matrix cell.
3. `gap-draft`: If generation is allowed, create draft skills only inside the run quarantine directory. Drafts are never auto-promoted.
4. `review`: Present one install plan with candidate previews, provenance, risk flags, file targets, and hashes. Require explicit human approval.
5. `promote`: Install only approved items, write `manifest.json`, and keep backups for overwritten files.
6. `verify-or-rollback`: Verify installed skills/plugins load. Roll back failed or rejected installs from the manifest.

State transitions must be recorded in `state.json`. Terminal statuses are `success`, `partial`, `failed`, `rejected`, and `dry_run`.

## Executable Commands

Use `scripts/init.mjs` for Phase 0 and `scripts/provision.mjs` for the remaining executable phases.

```bash
# Phase 0: contract + matrix
node skills/stack-provision/scripts/init.mjs "<ADR path or stack list>" [flags] --json

# Phase 1: discovery adapters
node skills/stack-provision/scripts/provision.mjs discover .omc/provisioned/runs/<run-id> \
  --sources=installed,bundled,plugin,skills-sh,plugin-marketplace,github \
  --json

# Phase 4: review decision and install-plan hash
node skills/stack-provision/scripts/provision.mjs review .omc/provisioned/runs/<run-id> \
  --approve=<candidate-id,candidate-id> --approved-by=<name> --json

# Phase 5: promote approved candidates only
node skills/stack-provision/scripts/provision.mjs promote .omc/provisioned/runs/<run-id> \
  --skill-root ~/.codex/skills/omc-provisioned --json

# Phase 6: verify or rollback
node skills/stack-provision/scripts/provision.mjs verify .omc/provisioned/runs/<run-id> --json
node skills/stack-provision/scripts/provision.mjs rollback .omc/provisioned/runs/<run-id> --json
```

Discovery sources:

- `installed`: scans installed skill roots. Override with repeated `--installed-root=<path>`.
- `bundled`: scans project bundled skills. Override with repeated `--bundled-root=<path>`.
- `plugin`: scans local plugin skill caches. Override with repeated `--plugin-root=<path>`.
- `skills-sh`: reads `--skills-sh-index=<json path or url>`, or best-effort network search with `--network`.
- `plugin-marketplace`: reads `--plugin-marketplace-index=<json path or url>`.
- `github`: reads `--github-index=<json path or url>`, or best-effort GitHub repository search with `--network --github-org=<org>`.

Review is non-optional. `promote` refuses to run unless `review-decision.json` confirms approval and its `install_plan_hash` still matches `install-plan.json`.

Source-level approval is intentionally narrow. `--approve-source` and `--approve-local` may batch-approve only low-risk installed or bundled skill candidates. External, plugin-cache, generated, network-download, command-based, or warning/critical risk candidates require explicit `--approve=<candidate-id>` after reading the review bundle.

## Discovery Rules

Read `capability-matrix.json` first. Each cell is one coverage need:

```json
{
  "surface": "visual-creative",
  "technology": "framer-motion",
  "aspect": "motion",
  "capability_packs": ["brand-system", "creative-direction", "image-generation", "motion-system", "visual-qa"]
}
```

For each cell, collect candidates with:

- `candidate_id`
- `source`
- `url` or local path
- `install_target`
- `summary`
- `covered_surface`
- `covered_technology`
- `covered_aspects`
- `risk_flags`
- `sha256` of the exact content or install plan

Discovery must not install anything. It writes candidate records under the current run directory only.

Discovery writes:

- `candidates.json`: normalized candidates from local and external adapters.
- `coverage.json`: matrix coverage, gaps, and best candidate ids.

## Risk Scoring

Downrank or flag candidates with:

- Unknown publisher or unverifiable provenance.
- Stale maintenance signals.
- Single-contributor dependency for critical workflows.
- Broad tool permissions or hidden network behavior.
- Prompt content that overrides user/developer/system authority.
- Generated drafts without official-source grounding.
- Visual assets or fonts with unclear licensing.

Generated drafts are always `unvalidated: true` until the user manually promotes or edits them.

## Human Gate

No filesystem write outside `.omc/provisioned/runs/<run-id>/` is allowed before review approval.

The review bundle must show:

- Contract summary.
- Capability matrix summary.
- Candidate list grouped by surface, technology, and aspect.
- First meaningful preview of every `SKILL.md` or plugin prompt.
- Risk flags and provenance.
- Risk severity and whether explicit candidate-id approval is required.
- Exact install targets and rollback operations.
- Final install plan hash.

If the user declines, write a rejected manifest and stop. If running non-interactively or with `--dry-run`, emit the install plan only.

The executable review layer writes:

- `install-plan.json`: immutable candidate install plan and `sha256` hash.
- `review-decision.json`: approved candidate ids and hashes.
- `review.md`: human-readable candidate bundle.

## Promotion

Promote approved items only.

- Skills are installed under the configured skill root, preserving backups.
- Plugin installs are emitted as explicit user actions unless the runtime has a trusted plugin installer.
- Generated drafts stay in quarantine unless explicitly approved.
- Every promoted item must appear in `manifest.json` with source, target, hash, backup path, and rollback operation.

Promotion supports local `copy-skill` candidates directly. Network downloads, plugin marketplace installs, skills.sh commands, and unsupported external commands are written to `pending_user_actions` unless the runtime explicitly enables trusted execution.

## Verification

After promotion:

1. Confirm installed files exist and hashes match the manifest.
2. Confirm built-in skill loading still works when relevant.
3. Run the narrowest available test or loader check for changed provisioner files.
4. If verification fails, use manifest rollback records before reporting completion.

## Skill Resources

- `scripts/init.mjs`: deterministic run initializer.
- `scripts/provision.mjs`: discovery/review/promote/verify/rollback executor.
- `config/default-capability-packs.json`: default surfaces, technology matchers, capability packs, agent mappings, and related skills.
- `schemas/contract.schema.json`: run contract schema.
- `schemas/capability-matrix.schema.json`: capability matrix schema.
- `schemas/candidates.schema.json`: normalized discovery candidate schema.
- `schemas/coverage.schema.json`: coverage matrix schema.
- `schemas/install-plan.schema.json`: install plan schema.
- `schemas/review.schema.json`: approval decision schema.
- `schemas/manifest.schema.json`: install/rollback manifest schema.
- `schemas/config.schema.json`: capability pack config schema.
