---
name: lcx-doctor
description: "LazyCC Claude adaptation of LazyCodex lcx-doctor for staged LazyCodex and Codex health diagnosis."
---

# LazyCC LazyCodex Doctor

Invoke with `/lazycc:lcx-doctor`.

Workflow concept: `lcx-doctor`

## Purpose

Diagnose LazyCodex/Codex installation health with source-backed evidence. Under OMC this workflow is staged because LazyCodex is a Codex-centered distribution and may not be installed or controllable from Claude.

## Progressive Disclosure

1. Confirm the user wants LazyCodex/Codex diagnosis, not OMC diagnosis.
2. Prefer `/lazycc:omc-doctor` for OMC installation health.
3. If LazyCodex diagnosis remains requested, inspect only read-only local surfaces and current source checkouts.
4. Compare installed manifests, hook paths, and command availability against source evidence.
5. Return PASS/WARN/FAIL with every verdict tied to a command or file.

## Claude adaptation

- Staged: OMC does not own Codex global config, Codex plugin cache, or LazyCodex release state.
- Use read-only shell probes for Codex/LazyCodex paths if present.
- Do not run recursive doctor commands that would call this workflow again.

## Adapter Notes

- Codex-only concept: `.codex` plugin cache, Codex CLI runtime probes, and LazyCodex installer mutation are external to Claude.
- Claude alternative: `/lazycc:omc-doctor` for OMC, plus read-only file/command probes for LazyCodex when explicitly requested.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration, Codex configuration, source checkouts, or user installs during diagnosis.

## Completion

Return a staged support note, evidence-backed health table, and remediation suggestions only. Applying fixes requires explicit confirmation.
