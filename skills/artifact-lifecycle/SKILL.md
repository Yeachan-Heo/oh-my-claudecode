---
name: artifact-lifecycle
description: Scan .omc/ for stale/superseded artifacts and produce a lifecycle report — identifies canonical vs superseded versions, abandoned files, duplicate topics. Optional --archive mode moves flagged files to per-directory archive/ with user confirmation
argument-hint: "[--scan | --archive | --report-only] [--threshold=<days>] [--dry-run]"
level: 4
---

# Artifact Lifecycle Skill

Framework-sustainability utility. As OMC accumulates artifacts (ideas, strategies, competitor dossiers, sprints, partner sessions, brand expressions), `.omc/` grows without built-in garbage collection. This skill scans for staleness patterns and produces a report; optionally moves flagged files to archive directories with user confirmation.

## Usage

```
/oh-my-claudecode:artifact-lifecycle                   # default: scan + report
/artifact-lifecycle --scan                             # explicit scan (same as default)
/artifact-lifecycle --archive                          # prompt to archive superseded/abandoned files
/artifact-lifecycle --archive --dry-run                # show what WOULD be archived; don't move
/artifact-lifecycle --threshold=60                     # abandoned = not updated in 60 days (default 90)
/artifact-lifecycle --report-only                      # report without suggesting archive action
```

<Purpose>
Periodic sustainability check for `.omc/`. Produces a lifecycle report identifying canonical vs superseded vs abandoned artifacts, duplicate-topic versions, and directories at risk of accumulating noise. Enables the user to either manually tidy, run `--archive` with per-file confirmation, or (with `--dry-run`) preview the impact of archival before committing.
</Purpose>

<Use_When>
- Weekly/biweekly as part of hygiene (consider pairing with `/oh-my-claudecode:loop`).
- Before a major sprint or release when the repo feels cluttered.
- After a brand refine or constitution pivot (old artifacts referring to prior direction may mislead agents).
- After 30+ days of active OMC usage when agents start reading stale data.
</Use_When>

<Do_Not_Use_When>
- Early project (first 14 days) — nothing meaningful to archive.
- Right before a regulatory audit — archival may move files that need to be cited as evidence; run `--dry-run` only.
</Do_Not_Use_When>

<Protocol>

## Phase 0 — Scan

Walk `.omc/**` excluding already-archived directories (`archive/`, `graduated/`, `unverified/`).

For each file, extract:
- Date from filename (YYYY-MM-DD pattern) or from frontmatter `updated:` field if present.
- Topic/slug from filename or frontmatter.
- `status:` field from frontmatter if present (`draft | partial | complete | active | archived | superseded`).
- `supersedes:` / `superseded_by:` references if present.

Group artifacts by `(parent_directory, topic_slug)`:

```yaml
- .omc/ideas/:
    - slug=matching-algorithm: 3 versions
    - slug=onboarding: 2 versions
- .omc/competitors/<acme>/:
    - slug=acme: 5 dossiers
```

## Phase 1 — Classify Staleness

For each artifact, determine class:

| Class | Criterion | Action hint |
|---|---|---|
| **canonical** | Most recent version in topic group AND status not `archived` | keep in place |
| **superseded** | Older version in same topic group; newer version exists | move to `<parent>/archive/` |
| **abandoned** | Not updated in `--threshold` days AND no `superseded_by` reference AND no ongoing references from elsewhere | flag for user decision |
| **orphan** | No matching topic group members; sits alone | inspect; may be a unique artifact |
| **duplicate** | Same slug + same date + different content | conflict — requires manual merge |
| **stale-ref** | References file that no longer exists | orphaned link — may need update or archive |

## Phase 2 — Cross-Reference Check

For each artifact flagged `abandoned`, check if it's still referenced by:
- Any file in `.omc/handoffs/` (implies active pipeline in progress)
- Any `.omc/sprints/**/week*.md` in status `active` or `in-progress`
- Any open handoff in `.omc/<anywhere>` where the referenced file is cited as input

If YES → downgrade from `abandoned` to `held-by-reference` (not safe to archive automatically).

## Phase 3 — Report

Write to `.omc/lifecycle/reports/YYYY-MM-DD.md`:

```markdown
# Artifact Lifecycle Report — YYYY-MM-DD

## Summary
- Scanned: N files across M directories
- Canonical: X
- Superseded: Y (safe to archive)
- Abandoned: Z (no updates > <threshold> days; no references)
- Held-by-reference: W (abandoned-looking but still cited elsewhere)
- Orphan: V
- Duplicate conflicts: U
- Stale refs: T

## Per-directory breakdown
| Directory | Canonical | Superseded | Abandoned | Held | Orphan |
|---|---|---|---|---|---|

## Safe-to-archive (total size: X MB)
[<file path>: reason (superseded by <path> on YYYY-MM-DD)]

## Abandoned — needs decision
[<file path>: last update YYYY-MM-DD; not referenced; <age>d old]

## Held-by-reference (do NOT archive)
[<file path>: referenced by <referencing file>]

## Duplicate conflicts — manual review
[<pair of files>: same slug + date; content differs]

## Stale references
[<file A> references <file B> which does not exist]

## Recommended actions
1. Run `/artifact-lifecycle --archive --dry-run` to preview archival of safe-to-archive set.
2. Review abandoned set; decide per file.
3. Manually reconcile duplicate conflicts.
4. Fix stale references or archive referencing files.
```

## Phase 4 — Archive (only if --archive flag)

If `--archive` without `--dry-run`:
- For each safe-to-archive file, prompt user for confirmation OR batch-confirm by category.
- Move to `<parent-directory>/archive/<filename>` — create archive subdirectory if needed.
- Add `superseded_by: <canonical-file-path>` to the moved file's frontmatter (if not already present).
- Update canonical file's `supersedes:` field if appropriate.

If `--archive --dry-run`:
- Report what WOULD be moved without modifying the file system.

Never archive `held-by-reference` files. Never archive files without date or topic metadata (too risky to classify).

## Phase 5 — Summary to User

Terminal output:
- Report path.
- Top 3 action items.
- Recommended cadence if first run (`/loop 30d /artifact-lifecycle`).

</Protocol>

<Input_Contract>
Flags:
- `--scan` (default) — scan and report.
- `--archive` — interactively archive safe-to-archive set.
- `--report-only` — explicit report-only mode (same as default).
- `--threshold=<days>` — abandoned threshold (default 90).
- `--dry-run` — show what would happen without modifying files.
</Input_Contract>

<Output>
- `.omc/lifecycle/reports/YYYY-MM-DD.md` — always written.
- Archived files moved to per-directory `archive/` subdirectories (only with `--archive` and no `--dry-run`).
</Output>

<Failure_Modes_To_Avoid>
- **Archiving files referenced by active handoffs or sprints.** The held-by-reference check is non-negotiable.
- **Classifying a file as abandoned based only on file mtime.** Frontmatter `updated:` takes precedence; files are often committed together but updated separately.
- **Archiving duplicates without human review.** Same-slug same-date with different content signals a real conflict; never auto-resolve.
- **Running `--archive` without `--dry-run` on first invocation.** Always preview first on a new codebase.
- **Deleting files.** This skill NEVER deletes. Archive only. Restoration must always be possible.
- **Touching files outside `.omc/`.** Scope is strict.
- **Suppressing stale-ref warnings.** Broken citations mislead agents; surface them.
</Failure_Modes_To_Avoid>

<Integration_Notes>
- Scoped strictly to `.omc/**`.
- Composes with `/oh-my-claudecode:loop 30d /artifact-lifecycle` for monthly hygiene.
- Does NOT force metadata changes on existing agents — works with whatever metadata exists (date in filename OR frontmatter OR mtime fallback).
- Agents following the context-manifest standard (`reads:` / `writes:` / `supersession:` fields) produce richer signal for this skill, but it is NOT a prerequisite.
- Pairs well with: `competitor-scout` (produces rapidly-dated dossiers), `ideate` (produces versioned shortlists), `pre-launch-sprint` (weekly dated artifacts).
</Integration_Notes>
