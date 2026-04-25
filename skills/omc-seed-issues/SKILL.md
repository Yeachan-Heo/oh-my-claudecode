---
name: omc-seed-issues
description: Seed GitHub issues from project documentation in a single human-in-the-loop batch
argument-hint: "[--docs <path,...>] [--max-issues <N>] [--milestone <name>] [--dry-run] [--also-mark-ready]"
level: 3
---

# omc-seed-issues

One-shot human-in-the-loop generator for bootstrapping a GitHub issue backlog from existing project documentation. Walks a curated doc set, drafts one issue per actionable section, presents the batch for review, and creates issues only on explicit confirmation.

## <Purpose>

Turn structured product docs (PRDs, mock-up READMEs, roadmap sections) into reviewable GitHub issue drafts so OMC's execution modes have concrete starting work. Drafts persist on disk under `.omc/seed-issues/` for inspection and editing before any irreversible `gh issue create` call.

## <Use_When>

- User says "seed issues", "create issues from docs", "bootstrap issues", "omc-seed-issues".
- A new repo or workspace needs an initial backlog derived from existing documentation.

## <Steps>

1. **Validate auth.** `gh auth status` AND `gh api repos/<repo> -q .permissions.push` (the latter catches fine-grained PATs whose scopes are not visible to `auth status`). Stop with a clear remediation message if either fails.
2. **Parse arguments.** `--docs` (comma-separated; defaults to the curated PRD/mock-up/README list), `--max-issues` (default 50), `--milestone` (default `OMC Bootstrap`), `--dry-run`, `--also-mark-ready`.
3. **Ensure milestone.** Call `provider.ensureMilestone("<milestone>")` — idempotent; HTTP 422 (already exists) is treated as success and the existing milestone number is returned.
4. **Ensure labels.** For every label that drafts will reference (`omc-seeded`, optional `omc-ready`, area labels), call `provider.ensureLabel(name)`. Same 422-as-success contract.
5. **Extract drafts.** Invoke `node "${OMC_PLUGIN_DIR}/dist/issues/cli/seed-extract.js" --docs <list> --output-dir .omc/seed-issues --manifest .omc/seed-issues/manifest.json [--also-mark-ready]`. The TS module walks each doc, applies the source-to-issue mapping, computes content hashes, writes draft files under `.omc/seed-issues/<seq>.md`, and appends manifest entries with `status: draft`.
6. **Stop on `--dry-run`.** Print a summary of drafts written and exit. No `gh issue create` calls.
7. **Confirmation gate.** Present the user with: total draft count, per-source breakdown, first 3 titles, and three options:
   - `[1] Create all N issues`
   - `[2] Create subset (specify sequence numbers)`
   - `[3] Cancel — no issues will be created`
8. **Create on confirmation.** Invoke `node "${OMC_PLUGIN_DIR}/dist/issues/cli/seed-create.js" --manifest .omc/seed-issues/manifest.json --audit .omc/seed-issues/audit.log --repo "$REPO"`. The orchestrator iterates entries, performs hash-search idempotency checks, calls `provider.createIssue()` for new entries, updates manifest status (`created` / `skipped` / `error`), and appends audit log lines. Progress is printed one line per draft.
9. **Final summary.** Print created/skipped/failed counts and the URLs of created issues.

## Source-to-Issue Mapping

| Source | Behavior |
|---|---|
| `BASES-PRD.md` | One issue per H2/H3 heading after structural-heading exclusion. Area label `area:bases`. |
| `docs/mock-ups/<slug>/README.md` | One issue per mock-up directory. Area label `area:ui` plus `area:ui/<slug>`. |
| `docs/mock-ups/<dir>/` | One issue per child mock-up directory's README. |
| `README.md` | Only sections under headings containing `TODO`, `Roadmap`, `Planned`, or `Upcoming`. Area label `area:docs`. |
| `PRODUCT-PRINCIPLES.md` | Excluded — principles are guidance, not work items. |

## Title Rule

Format: `[area:<slug>] <heading>`. Maximum 80 codepoints; truncated with `...` if longer.

## Body Template

```
## Summary
<one-paragraph summary>

## Acceptance Criteria
- [ ] <bullets extracted via "must|should|shall|can|allow|support|enable" keyword scan, or a single "(To be refined during planning)" placeholder>

## Source
- **Document:** `<filename>`
- **Section:** `<heading text>`
- **Line range:** L<start>-L<end>

---
> Seeded from project documentation by `omc-seed-issues`.
> Label `omc-seeded` indicates OMC created this; add `omc-ready` after review for execution via `/omc-issue <N>`.

<!-- omc-seed-hash:<sha256-of-source-section-content> -->
```

## Idempotency

The `omc-seed-hash:<hex64>` sentinel makes re-runs safe. Before creating each issue, the orchestrator calls `provider.searchIssues(<bare-hash>, { state: 'all' })` and post-filters bodies for the full `omc-seed-hash:<hash>` substring. **Bare hash, not `key:value`** — GitHub Issues search silently ignores unrecognized qualifiers, so `omc-seed-hash:abc...` would return zero results and break idempotency.

## Manifest Update Protocol

Manifest writes follow the temp-then-rename protocol implemented in `src/issues/draft-writer.ts:appendManifestEntry`:
1. Read manifest into memory (or start with `[]`).
2. Derive `seq = max(existing) + 1` at read time.
3. Write to `manifest.json.tmp.<pid>.<6-hex-nonce>`.
4. Atomic rename to `manifest.json`.
5. On failure, retry up to 3 times with exponential backoff (100/200/400ms).

## Output Artifacts

- `.omc/seed-issues/<seq>.md` — draft files (preserved for review and partial-failure resume).
- `.omc/seed-issues/manifest.json` — per-draft status, hash, source provenance, `source: "docs"` discriminator.
- `.omc/seed-issues/audit.log` — append-only log of every CREATE / SKIP / ERROR action.

All three are removed by `cancel --purge-issue-artifacts`. Spec files at `.omc/specs/gh-issue-*.md` are NOT touched (they belong to D1).

## Rollback

There is no automated "delete all created issues" path. `gh issue delete` requires admin scope and is destructive. Recovery is manual via `gh issue close <N> --reason not_planned` for the issue numbers recorded in the manifest.
