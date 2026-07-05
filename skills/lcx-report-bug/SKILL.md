---
name: lcx-report-bug
description: "LazyCC Claude adaptation of LazyCodex lcx-report-bug for staged LazyCodex or Codex bug routing."
---

# LazyCC LazyCodex Report Bug

Invoke with `/lazycc:lcx-report-bug`.

Workflow concept: `lcx-report-bug`

## Purpose

Prepare a high-signal LazyCodex or Codex bug report with reproduction, ownership routing, source evidence, and a verification plan. Under OMC this is staged until the user confirms external GitHub filing and any required Codex/LazyCodex source checkout access.

## Progressive Disclosure

1. Read the bug report and identify the affected surface.
2. Reproduce the bug through the real surface where possible.
3. Compare LazyCodex-owned behavior against upstream Codex behavior before choosing a repository.
4. Draft title, environment, steps, expected/actual behavior, root-cause evidence, and fix direction.
5. Ask for explicit confirmation before creating or mutating any GitHub issue.

## Claude adaptation

- Use OMC debugging and verification practices for investigation.
- Use read-only source inspection unless the user asks for filing.
- Stage issue creation when GitHub app/CLI access, repository ownership, or labels are unavailable.

## Adapter Notes

- Codex-only concept: Codex plugin bugs, `.codex` source layout, and LazyCodex-generated labels are external compatibility targets.
- Claude alternative: OMC issue-draft workflow, GitHub connector or `gh` only after explicit user approval, and local evidence artifacts.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration, create issues, apply labels, or push branches without explicit confirmation.

## Completion

Return the routed repository decision, the issue draft, evidence paths, and staged/unsupported filing requirements.
