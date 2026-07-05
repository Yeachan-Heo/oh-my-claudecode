---
name: lcx-contribute-bug-fix
description: "LazyCC Claude adaptation of LazyCodex lcx-contribute-bug-fix for staged LazyCodex or Codex fixes."
---

# LazyCC LazyCodex Contribute Bug Fix

Invoke with `/lazycc:lcx-contribute-bug-fix`.

Workflow concept: `lcx-contribute-bug-fix`

## Purpose

Investigate, reproduce, patch, and prepare a LazyCodex or Codex bug fix with evidence. Under OMC this workflow is staged because it may require external clones, fork/PR operations, labels, and Codex-specific packaging.

## Progressive Disclosure

1. Confirm the defect is concrete enough to reproduce.
2. Diagnose ownership before writing a patch.
3. Use a fresh temporary clone or worktree for external repositories.
4. Capture reproduction logs before the fix and verification logs after the fix.
5. Prepare either a verified-fix issue for LazyCodex-owned defects or a PR draft for upstream Codex defects, subject to explicit user approval.

## Claude adaptation

- Staged: publishing or mutating external LazyCodex/Codex repositories requires explicit confirmation and available GitHub tooling.
- Use OMC debugging, test-first implementation, and evidence gates.
- Keep edits out of the user's active OMC worktree unless this repository itself owns the defect.
- Stage network, fork, push, issue, and label operations until explicitly approved and available.

## Adapter Notes

- Codex-only concept: LazyCodex generated distribution rules, `.codex` plugin payloads, and Codex fork PR routing are external compatibility targets.
- Claude alternative: OMC local diagnosis, temporary external worktrees, GitHub connector or `gh` after explicit confirmation, and evidence-backed patch artifacts.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration, user installs, labels, issues, PRs, or external repositories without explicit confirmation.

## Completion

Return reproduction evidence, patch evidence, verification commands, cleanup receipts, and the staged publish action still requiring approval.
