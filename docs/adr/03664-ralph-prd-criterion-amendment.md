# ADR 03664: Ralph PRD Evidence-Preserving Criterion Amendment

- **Status:** Accepted — this landing
- **Issue:** #3664 (`Fixes #3664`)
- **Decision scope:** `src/hooks/ralph/prd.ts` and its consumers (ralph loop context, verifier prompt, persistent-mode continuation prompt, ralph skill). No CLI, HUD, installer, or generated `dist`/`bridge` surfaces.

## Decision

Give Ralph's PRD an explicit, evidence-preserving path for amending acceptance criteria that implementation has empirically refuted. A criterion stops governing a story's completion check **only** through a `criterionAmendments` ledger entry that retains the original criterion verbatim alongside bounded proof, reason, authority, and timestamp. There is no silent deletion path and no arbitrary goal weakening.

### Schema

```ts
type CriterionAmendmentKind = 'replaced' | 'superseded';

interface CriterionAmendment {
  kind: CriterionAmendmentKind;      // 'replaced' (corrected criterion governs) | 'superseded' (no replacement governs)
  original: string;                  // verbatim refuted criterion, retained forever
  replacement?: string;              // required for 'replaced'; must be absent for 'superseded'
  reason: string;                    // why the original no longer governs (mandatory)
  evidence: string;                  // the bounded measurement that refuted it (mandatory, >= 10 chars)
  authority: string;                 // who performed the amendment (mandatory)
  timestamp: string;                 // ISO 8601
}

interface UserStory {
  // ...
  acceptanceCriteria: string[];        // currently governing criteria only
  criterionAmendments?: CriterionAmendment[];  // evidence ledger; original retained
}
```

### Authority and completion semantics

- `acceptanceCriteria` holds the **active** criteria that Steps 4/7 verify. A successful amendment atomically removes the original (a replacement is inserted at the original's position) and appends the ledger record.
- `amendCriterion(dir, storyId, { original, replacement, reason, evidence, authority, timestamp? })` → `'replaced'`.
- `supersedeCriterion(dir, storyId, { original, reason, evidence, authority, timestamp? })` → `'superseded'`.
- Mutation gate (closed error codes): `prd-not-found`, `story-not-found`, `original-not-active`, `reason-required`, `evidence-required`, `evidence-too-short` (bounded proof: `MIN_CRITERION_EVIDENCE_LENGTH = 10`), `authority-required`, `replacement-required`, `replacement-not-allowed`, `write-failed`. A failed mutation never mutates the PRD.
- Read-time normalization is fail-closed: a hand-edited PRD whose ledger is malformed, whose amended original is still active, or whose original appears twice is **invalid** (`readPrd` returns `null`), matching the existing invalid-PRD startup behavior. This makes silent deviation detectable rather than silently authoritative.
- Completion semantics are unchanged in mechanism: `getPrdStatus`/`isStoryComplete` count stories by `passes && architectVerified`; they operate over active criteria only, so a superseded criterion stops governing while the ledger preserves the audit trail.

### Backward compatibility / migration

- `criterionAmendments` is optional; legacy PRDs (no ledger) read, format, and write unchanged. `formatStory`/`formatPrd` output is byte-identical for stories without amendments (covered by tests).
- An empty `criterionAmendments: []` is treated as absent.
- `UserStoryInput`/`createPrd` pass the field through for programmatic construction.
- Known limitation (documented, inherent): an **older** OMC build that rewrites a PRD serializes only fields its own normalizer knows, so it would not preserve the ledger. Amendment records are only understood by builds that ship this schema; mixed-version concurrent writes are outside the supported contract.

## Drivers

1. **The measurement wins, the loop keeps its grip** — the concrete failure in #3664 ("16 setters" was actually 12; two refuted readers were the only affected files) resolves toward the measured count without the loop losing its completion authority.
2. **No silent deletion** — the original is retained verbatim with proof, reason, authority, and timestamp; reviewers see why it no longer governs.
3. **No arbitrary weakening** — every amendment requires bounded evidence, a reason, and an authority; malformed or contradictory ledgers fail closed.
4. **Backward compatible** — legacy PRDs and existing formatting/tests are untouched.

## Alternatives

- **`superseded: boolean` per criterion (minimal issue suggestion):** rejected — a boolean flag records neither the proof nor the replacement; it weakens the audit trail the PRD exists for.
- **Free-form model rewriting of criteria with no schema:** rejected — exactly the "PRD theater" the skill warns against; unverifiable and silently deletable.
- **Auto-resolve contradictions on read (drop bad ledger entries):** rejected — silent repair is silent deletion by another name; fail-closed is the existing PRD philosophy.

## Consequences

- Ralph's loop, continuation prompt, next-story prompt, and architect verification prompt now surface the amendment ledger so working agents and reviewers see struck-through originals with evidence.
- The ralph skill documents the amend path with the exact JSON shape and gates, including the issue's concrete 16→12 example.
- Deterministic tests cover mutation semantics, closed validation errors, fail-closed invariants, session scoping, formatting, verifier prompts, and backward compatibility.
- Future criterion-authority features (e.g. reviewer-approved amendments) can extend the ledger without changing the storage contract.

## Governance

This PR targets `dev`, is based on exact dev commit `8859cd218` (before the v4.15.10 release merge; release files untouched), and references #3664 with `Fixes #3664`.
