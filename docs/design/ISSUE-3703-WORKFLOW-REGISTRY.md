# Issue #3703: Canonical workflow registry and compatibility policy

**Status:** implemented (additive, read-only; no runtime routing behavior changed)
**Epic:** #3698 — planning contract `docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md`
**Depends on:** #3702 (inventory manifest — see adapter seam below); builds on merged #3706 alias resolver.

## Scope

`src/workflow/registry.ts` is the single source of truth for the public
workflow surface classification:

- **Tier-0 workflows:** exactly `plan`, `execute`, `review`, `verify`
  (re-exported from the merged #3706 resolver; the registry enforces via test
  that no other entry carries `tier: 0`).
- **Tier-0 roles:** exactly `planner`, `executor`, `reviewer`, `verifier`.
  All 15 specialist roles from `src/agents/definitions.ts` are registered as
  `internalOnly` with an explicit Tier-0 mapping (reviewer ← architect /
  critic / code-reviewer / security-reviewer; verifier ← test-engineer /
  qa-tester / tracer; planner ← analyst; executor ← the rest).
- **All aliases:** every one of the 41 installed skills and 28 installed
  commands has exactly one registry entry with a `keep | merge |
  alias-deprecate | delete` decision, canonical target, owner, warning
  milestone, and notes. Merge/alias chains are cycle-checked and must resolve
  to a `keep` entry (`resolveCanonical`).
- **Risk classes:** `secrets-privacy`, `destructive-mutation`,
  `release-authority`, `corruption-integrity`, `security-boundary` fail
  closed; `advisory` fails open. `failModeForRisk` is the only policy
  decision point.
- **Warning policy:** concise actionable warning, once per session, with
  automation opt-out — implemented by the merged #3706 resolver
  (`maybeGetAliasWarning`, `isWarningOptedOut`); this registry supplies the
  per-entry metadata and does not re-implement warning state.
- **Release maintainer boundary:** `release` (skill + command) is an
  `alias-deprecate` entry targeting maintainer-only `omc-release`, risk class
  `release-authority` (fail closed), `maintainerOnly: true`. No tag, publish,
  or release mutation is performed anywhere in this epic.
- **Retirement evidence:** structured `RETIREMENT_POLICY` (≥2 minor releases
  AND 90 days, whichever longer; ≥95% canonical-use share over 2 consecutive
  releases; zero known critical integrations). The executable verifier is the
  merged #3706 `checkAliasRetirement`; this registry's constants are the
  policy source of truth the verifier's thresholds mirror.
- **Projections:** `src/workflow/projections.ts` builds a deterministic
  canonical-JSON projection (sorted entries, `schemaVersion`,
  `registryVersion`, SHA-256 `digest`) and a drift check proving every
  installed `skills/*/SKILL.md` and `commands/*.md` surface is registered and
  every non-`declaredOnly` entry has an installed file.

## Adapter seams

- **#3706 resolver:** `registryAliasLookup` implements the resolver's
  documented `AliasRegistryLookup` seam for `resolveWorkflowAliasViaRegistry`.
  Only workflow-surface aliases are served (Tier-0 targets, internal lanes
  team→execute / research→plan, and maintainer-only omc-release).
  Utility-to-utility aliases (e.g. `learner`→`remember`) return `undefined`
  so the resolver's own merged table keeps serving them; no resolution logic
  is duplicated.
- **#3702 inventory (not yet merged):** the drift check currently enumerates
  installed surfaces from the filesystem (`enumerateInstalledSurfaces`).
  `checkProjectionDrift` accepts injected `InstalledSurfaces`, so the durable
  #3702 manifest can replace the filesystem census with no change to the
  comparison logic.

## Rollback

- `OMC_WORKFLOW_REGISTRY=0` disables `registryAliasLookup` (every lookup
  returns `undefined`); `OMC_ALIAS_RESOLVER_ENABLED=0` (merged #3706) disables
  alias routing entirely. Legacy keyword/skill resolution paths are untouched;
  deleting `src/workflow/registry.ts`, `projections.ts`, and their tests
  fully removes this issue's surface.

## Acceptance evidence

- `src/workflow/__tests__/registry.test.ts` — 30 tests: exact Tier-0 sets,
  specialist internality, risk-class policy, full 41+28 classification,
  alias-chain integrity, release boundary, retirement thresholds, feature
  flag, adapter seam.
- `src/workflow/__tests__/projections.test.ts` — 8 tests: canonical-JSON
  determinism, digest stability/sensitivity, sort order, exact drift parity
  with the installed 41 skills / 28 commands, synthetic drift detection,
  `declaredOnly` exemption.
- Measured acceptance: 41 installed skills and 28 installed commands
  classified exactly once; drift check `ok: true` against the live tree;
  digest stable across processes (canonical JSON + SHA-256).

## Non-goals

No alias removal, no routing cutover, no prompt/hook changes, no
release/tag/publish mutation, no epic closure. Alias retirement remains
gated on the temporal policy above and is executed by #3711 with receipts.
