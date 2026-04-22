# Agent Pipeline Governance

This document defines how OMC agents exchange state, write artifacts, limit context growth, and recover from obsolete product work.

## Goals

- Keep product, technology, provisioning, and implementation decisions traceable.
- Prevent artifact sprawl and "repo garbage" from repeated agent runs.
- Make every handoff compact enough for downstream agents to consume without rereading the whole project.
- Allow a product to restart in the same repository without stale product code steering new reasoning.

## Canonical Artifact Model

Every long-lived lane should use one dated primary artifact plus a compact current pointer.

| Lane | Dated artifact | Current pointer / index |
|---|---|---|
| Ideas/specs | `.omc/ideas/YYYY-MM-DD-<slug>.md`, `.omc/specs/YYYY-MM-DD-<slug>.md` | `.omc/ideas/current.md`, `.omc/specs/current.md`, indexes |
| Competitors | `.omc/competitors/<slug>.md`, `.omc/competitors/landscape/YYYY-MM-DD-<slug>.md` | `.omc/competitors/index.md`, `.omc/competitors/landscape/current.md` |
| Brand | `.omc/brand/YYYY-MM-DD-<slug>.md` | `.omc/constitution.md`, `.omc/brand/index.md` |
| Product capability map | `.omc/product/capability-map/YYYY-MM-DD-<slug>.md` | `.omc/product/capability-map/current.md` |
| Technology decisions | `.omc/decisions/YYYY-MM-DD-technology-<slug>.md` | ADR index or explicit handoff path |
| Provisioning | `.omc/provisioned/runs/<run-id>/**` | `.omc/provisioned/current.json` |
| Handoffs | `.omc/handoffs/YYYY-MM-DD-<scope>.md` | latest pointer inside upstream artifact |
| Audits/reviews | `.omc/audits/YYYY-MM-DD-<scope>.md` | explicit path in report |
| Reset boundaries | `.omc/reset/YYYY-MM-DD-<slug>.md` | latest reset referenced by product-foundation |

Rules:

- Do not create one artifact per minor thought, candidate, or sub-question. Put tables inside the primary artifact.
- Refresh `current.md` / `current.json` only after the dated artifact is coherent.
- Archive or mark stale artifacts; do not let downstream agents discover them by broad glob scans.
- Every primary artifact must end with a compact `<handoff>` block.
- Stack strategy/provisioning artifacts must include handoff-envelope v2.

## Context Budget Rules

Agents read in this order:

1. Current pointers and indexes.
2. Exact artifacts referenced by those pointers.
3. The minimal source/config files needed for the current task.
4. Archived or legacy artifacts only when explicitly whitelisted by the orchestrator or user.

Default limits:

| Work type | Default context budget |
|---|---|
| Product/brand strategy | current/index artifacts first; avoid source code unless product behavior must be verified |
| Technology strategy | current capability map, constitution, current decisions/provisioning, manifests/configs |
| Provisioning | ADR/handoff/provision contract only; no source tree scan |
| Backend/product execution | accepted plan, scoped files, directly related tests |
| Critic/reviewer | upstream artifact plus exact diff or scope under review |

No agent should bulk-read `.omc/archive/**`, old dated artifacts, generated logs, dependency folders, build outputs, or the entire source tree.

## Standard Agent Response

Every agent-facing artifact or terminal response should expose the same compact footer:

```yaml
status: ok | needs-research | blocked | needs-human-decision
evidence:
  - <path, command, or source>
confidence: <0.0-1.0>
blocking_issues:
  - <issue or []>
next_action: <agent/command and why>
artifacts_written:
  - <path or []>
```

For cross-agent stack/provisioning handoffs, use `handoff-envelope v2` from `docs/HANDOFF-ENVELOPE.md`.

## Role Permissions

| Role / skill | Read | Write | Forbidden |
|---|---|---|---|
| Orchestrator / Team | state, handoffs, exact artifacts | `.omc/state/**`, `.omc/handoffs/**` | inventing agent outputs |
| `product-foundation` | current product/market/brand/provisioning artifacts | foundation summary, reset boundary when requested | source edits |
| `deep-interview` / `ideate` | user input, compact context | `.omc/specs/**`, `.omc/ideas/**` | technology/vendor decisions |
| `competitor-scout` | market inputs, public research | `.omc/competitors/**`, `.omc/research/**` | implementation changes |
| `brand-steward` | vision, competitors, research | `.omc/constitution.md`, `.omc/brand/**` | technology/provisioning |
| `product-strategist` | compact product/market/brand context | `.omc/strategy/**`, `.omc/product/capability-map/**` | concrete technology/vendor choices |
| `technology-strategist` | current capability map, code/config read-only | `.omc/decisions/**`, `.omc/handoffs/**` | source/config edits, skill installs |
| Researcher | exact research questions and sources | `.omc/artifacts/**`, `.omc/handoffs/**` | product implementation |
| Critic | upstream artifacts/diff read-only | `.omc/audits/**`, `.omc/handoffs/**` | silent approval without findings |
| `stack-provision` | ADR/provision contract/review | `.omc/provisioned/**`, approved skill root | install before Strict Gate |
| `backend-pipeline` | accepted plan, scoped source/tests | scoped backend/source/test files | unapproved stack changes |
| `product-pipeline` | accepted plan, brand/capability artifacts, scoped UI files | scoped product/source/test files | generic UI that contradicts constitution |

## Agent Audit Scorecard

Use this scorecard when reviewing or rewriting each agent/skill. Score each item 0-2.

| Metric | 0 | 1 | 2 |
|---|---|---|---|
| Role boundary | overlaps heavily | mostly clear | single owner and explicit non-goals |
| Input contract | vague | paths listed | exact current/index/read order |
| Output contract | prose only | partial template | schema/footer/handoff required |
| Write scope | broad | implied | explicit path allowlist |
| Context economy | broad scans | some limits | current-first, archive-fenced |
| State handoff | manual | partial | machine-readable and validated |
| Determinism | subjective | some criteria | metrics, tie-breaks, thresholds |
| Failure routing | stops vaguely | suggests next step | exact next agent/phase |
| Artifact hygiene | many files | moderate | one primary artifact + pointer |
| Stale-context risk | high | acknowledged | reset/archive behavior defined |

Targets:

- 18+ = acceptable for production workflow.
- 14-17 = usable, but should be tightened before broad automation.
- <14 = do not use as a default route.

## Audit Order

Audit the product-development route in this order:

1. `product-foundation`
2. `product-strategist`
3. `technology-strategist`
4. `stack-provision`
5. `backend-pipeline`
6. `product-pipeline`
7. `brand-steward`
8. `competitor-scout`
9. `deep-interview` / `ideate`
10. `critic`, `reviewer`, `verifier`

Do not tune every agent at once. Finish one lane, run validation, then continue.

## Fresh-Start In Same Repository

Use this when the current product direction or existing code should not influence the next product foundation.

Command pattern:

```bash
/product-foundation "<new or reset product direction>" --fresh-start --pre-mvp --deep-brand
```

Fresh-start behavior:

1. Create `.omc/reset/YYYY-MM-DD-<slug>.md`.
2. Record:
   - reset reason.
   - artifacts allowed as carry-over.
   - paths and dated artifacts to ignore.
   - whether old source code is `ignore`, `reference-only`, or `port-selected`.
   - human approval status for destructive cleanup.
3. Run product-foundation from current pointers created after the reset.
4. Treat old product implementation as out of scope unless a later build handoff explicitly says to port or reuse a component.

Fresh-start must not delete source files by default. Deletion requires a cleanup plan, review, tests where practical, and explicit user approval.

Recommended reset artifact:

```markdown
# Product Reset: <slug>

**Date:** YYYY-MM-DD
**Status:** active
**Reason:** <why the old product direction is obsolete>
**Old source mode:** ignore | reference-only | port-selected

## Carry Over
- <artifact/path and why>

## Ignore
- <artifact/path and why>

## Cleanup Candidates
- <path>

## Next Route
`/product-foundation "<scope>" --fresh-start --pre-mvp --deep-brand`
```

## GitHub Release Path

When changes are ready:

1. Run focused tests plus typecheck and lint.
2. Review `git diff --stat` and high-risk diffs.
3. Commit on a `codex/` branch.
4. Push and open a draft PR.
5. In the PR body, include changed agents/skills, new workflow commands, compatibility notes, tests, and remaining risks.
