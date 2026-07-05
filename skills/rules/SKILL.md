---
name: rules
description: "LazyCC Claude adaptation of LazyCodex rules for project instruction loading and matching."
---

# LazyCC Rules

Invoke with `/lazycc:rules`.

Workflow concept: `rules`

## Purpose

Explain or inspect project rule loading in Claude/OMC while preserving LazyCodex's supported source vocabulary and host-specific differences.

## Progressive Disclosure

1. Read local `AGENTS.md` files and OMC rule-related hook docs before answering.
2. Inspect project rule sources such as `CONTEXT.md`, `.lazycodex/rules/**/*.md`, `.claude/rules/**/*.md`, `.cursor/rules/**/*.md`, and GitHub instruction files.
3. Separate static session injection from dynamic file-matching feedback.
4. Report exact files and environment knobs that affected the result.

## Claude adaptation

- OMC injects instructions through Claude hook and project-memory surfaces rather than Codex hook payloads.
- Preserve `.lazycodex/rules` as a compatibility input when present.
- Use OMC hook names such as `SessionStart`, `UserPromptSubmit`, and `PostToolUse` when describing runtime behavior.

## Adapter Notes

- Codex-only concept: Codex `apply_patch` hook wording, `.codex` config, and Codex-specific environment variables are compatibility notes only.
- Claude alternative: OMC hook registry, Claude project instructions, and `.claude/rules`.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration or rewrite rule files while explaining matching behavior.

## Completion

Return the matched rule sources, any disabled/staged behavior, and the exact files or variables that prove the answer.
