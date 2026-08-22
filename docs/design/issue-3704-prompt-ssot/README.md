# Issue #3704: Prompt SSOT composer and projection digests

**Epic:** [#3698](https://github.com/Yeachan-Heo/oh-my-claudecode/issues/3698)
**Planning contract:** `docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md` §6.2 (Prompt SSOT), §7 (metrics)
**Scope:** additive surface only. No legacy consumer rewiring — projection parity and install migration are #3705. No release/tag/publish mutation.

## What ships

| Surface | Path | Contract |
|---|---|---|
| Canonical sections | `src/agents/prompt-ssot/sections.ts` | Every normative clause authored exactly once, with `id`, `kind`, `owner`, `version` |
| Manifest | `src/agents/prompt-ssot/manifest.ts` | `schemaVersion`, `sourceRevision`, required sections, projection catalog, rollback history |
| Deterministic composer | `src/agents/prompt-ssot/compose.ts` | Rank- and id-ordered composition; byte-identical output for identical inputs |
| Digests | `src/agents/prompt-ssot/digest.ts` | Normalization (CRLF→LF, trailing-ws strip, blank-line collapse) + SHA-256 over `id@version` + body |
| Metrics | `src/agents/prompt-ssot/metrics.ts` | Deterministic tokenizer, corpus stats, repeated-clause ratio, projection drift |
| Build gate | `scripts/build-prompt-ssot.ts` (`npm run prompt-ssot:build` / `:check`) | Regenerates `generated/prompt-ssot/*.md`; `--check` exits 1 on stale or stray projections |
| Measurement | `scripts/measure-prompt-ssot.ts` (`npm run prompt-ssot:measure`) | Emits `measurements.json` acceptance evidence |
| Tests | `src/agents/prompt-ssot/__tests__/prompt-ssot.test.ts` | 17 tests incl. the stale-projection gate |

## Design decisions

1. **Structured sections, stored once.** Section kinds: `policy`, `task-contract`, `safety`, `role-delta`, `provider-delta`, `model-tier-delta`, `output-contract` (plan §6.2). Base projections select non-overlay sections; overlays select exactly one provider delta and/or tier delta by id convention (`provider/<id>`, `tier/<low|medium|high>`). Normative policy text is byte-identical across all overlays — provider/model differences are data, never copied paragraphs (test: *"keeps normative policy text identical across overlays"*).
2. **Deterministic renderer.** Composition order is fully canonical: `(kind rank, section id)`. Output therefore never depends on manifest declaration order (test: *"insensitive to manifest section listing order"*). Composition is pure: same manifest + sections + overlay ⇒ byte-identical `fileText` and digest.
3. **Digest/version metadata.** Every committed projection carries a header with `schemaVersion`, `projection`, `sourceRevision`, overlay values, and `sha256` of the normalized composed body. Section digests bind `id@version` so a body edit without a version bump is still detectable.
4. **Build fails on stale projections.** `prompt-ssot:check` fails on any digest/text mismatch or stray file, and the vitest gate (`committed projections (stale-projection gate)`) performs the same exact-text comparison inside the normal test run, so CI enforces freshness without a new workflow file.
5. **Required sections fail closed.** A projection missing `policy/operating-principles` or `safety/hard-boundaries` throws at compose time.
6. **Rollback.** Rollback = select a prior manifest projection: check out the prior `manifest.ts`/`sections.ts` revision (or a `rollbackHistory` entry) and regenerate. `rollbackHistory` is seeded empty at introduction; the first subsequent manifest change must append `{sourceRevision, digest, retiredAt}` for `2026-08-12.1`.

## Integration seams (dependencies are integration order, not start gates)

- **#3702 (inventory/graph, merged via #3721):** `measurements.json` is the machine-readable prompt-metrics artifact for inventory reporting.
- **#3703 (workflow registry, merged):** Tier-0 role projection ids `role-planner|executor|reviewer|verifier` mirror `WORKFLOW_ROLES` in `src/workflow/registry.ts`. No shared file ownership; no registry edits here.
- **#3705 (projection parity / install migration):** owns rewiring legacy consumers (`CLAUDE.md`, `docs/CLAUDE.md`, `.github/CLAUDE.md`, `agents/*.md`, `omcSystemPrompt`) onto `composeProjection`. This issue deliberately does **not** touch those files, avoiding ownership conflicts with the sibling lane.

## Measured acceptance evidence

From `docs/design/issue-3704-prompt-ssot/measurements.json` (reproduce: `npm run prompt-ssot:measure`):

| Metric | Baseline (legacy corpus: 3 CLAUDE.md projections + 19 `agents/*.md`) | SSOT sections | Result |
|---|---:|---:|---|
| Total tokens | 23,970 | 797 | — |
| Repeated-clause ratio (8-gram) | 0.9662 | 0.3413 | −0.6249 |
| Repeated tokens (duplicate occurrences) | 15,888 | 136 | **−99.14%** (target ≥35%) |
| Max projection drift (composed vs committed) | — | — | **0** (target <5%) |

The reduction exceeds the plan's 35–50% band because the legacy corpus hand-copies boilerplate (frontmatter, delegation tables, session checklists) across all 22 files; the SSOT corpus stores each clause once. The headline number is reported as measured, with the corpus file list embedded in `measurements.json` for reproducibility.

## Test evidence

```
npx vitest run src/agents/prompt-ssot   # 17 passed
npx tsc --noEmit                        # clean
npm run prompt-ssot:check               # 5 projections fresh
```
