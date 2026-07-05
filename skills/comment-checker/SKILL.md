---
name: comment-checker
description: "LazyCC Claude adaptation of LazyCodex comment-checker for edit-time comment feedback."
---

# LazyCC Comment Checker

Invoke with `/lazycc:comment-checker`.

Workflow concept: `comment-checker`

## Purpose

Interpret and respond to automatic comment-quality feedback after edits. The goal is to fix misleading, stale, or empty comments rather than explain the warning away.

## Progressive Disclosure

1. Read the hook feedback and the changed file context.
2. Identify whether the comment is redundant, stale, misleading, or genuinely useful.
3. Prefer removing weak comments over rewriting them.
4. Re-run the relevant check or tests after changes.

## Claude adaptation

- Treat Claude `PostToolUse` hook feedback as advisory or blocking according to OMC hook policy.
- Use repository lint/test commands as the verification surface when no standalone comment-checker binary is available.
- Stage missing binary/runtime support explicitly instead of claiming the hook ran.

## Adapter Notes

- Codex-only concept: Codex edit tool names and Codex `PostToolUse` payload shapes are compatibility references only.
- Claude alternative: OMC `PostToolUse` hooks, changed-file inspection, and project lint/test commands.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration or silence hooks to continue.

## Completion

Return the warning, the file/comment decision, the exact verification command, and any staged runtime limitation.
