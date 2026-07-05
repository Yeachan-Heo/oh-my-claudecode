---
name: coding-agent-sessions
description: "LazyCC Claude adaptation of LazyCodex coding-agent-sessions for local transcript discovery."
---

# LazyCC Coding Agent Sessions

Invoke with `/lazycc:coding-agent-sessions`.

Workflow concept: `coding-agent-sessions`

## Purpose

Find, inspect, and summarize local coding-agent sessions across Claude, Codex, OpenCode, and related tools using evidence from local stores instead of memory.

## Progressive Disclosure

1. Identify the named platform or use cross-platform search.
2. Read only the relevant LazyCodex reference file for that platform before inspecting stores.
3. Prefer a broad finder or exact file path over manual guessing.
4. Narrow by cwd, time, model, query, session id, or parent/child linkage.
5. Quote only short necessary excerpts and cite the local artifact path.

## Claude adaptation

- For Claude Code, inspect `[$CLAUDE_CONFIG_DIR|~/.claude]/projects`, transcript exports, pre-compact histories, and subagent metadata when present.
- For Codex or other platforms, treat their stores as external evidence sources, not active runtime APIs.
- If the LazyCodex helper script is unavailable in OMC packaging, run an equivalent read-only shell search and record the staged helper gap.

## Adapter Notes

- Codex-only concept: `.codex` rollout stores and Codex thread linkage are data sources only.
- Claude alternative: Claude transcript directories, OMC trace state, and read-only file inspection.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration, delete transcripts, or rewrite session stores.

## Completion

Return the selected session ids, exact paths inspected, query lanes used, and confidence limits for missing or partial stores.
