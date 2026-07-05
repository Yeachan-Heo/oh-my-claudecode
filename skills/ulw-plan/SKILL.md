---
name: ulw-plan
description: "LazyCC Claude adaptation of LazyCodex ulw-plan for explore-first planning before coding."
---

# LazyCC ULW Plan

Invoke with `/lazycc:ulw-plan`.

Workflow concept: `ulw-plan`

## Purpose

Create one decision-complete plan under the LazyCodex-compatible plan store before implementation starts. This is the Claude runtime version of the LazyCodex Prometheus planning workflow: explore first, ask only unresolved owner decisions, document adopted defaults, and stop before product edits.

## Progressive Disclosure

1. Read the user's request and the nearest `AGENTS.md` files.
2. Read only the relevant packaged LazyCodex/LazyCodex reference material when it is available in the installed plugin, source checkout, or task-provided reference path. If no legacy reference is available in the current host, record that as a staged compatibility gap and proceed from the Claude adaptation below.
3. For clear requests, gather repository facts and ask the minimal remaining decision questions.
4. For unclear requests, research and adopt explicit best-practice defaults instead of interviewing the user into inventing the outcome.
5. Write the plan artifact and wait for an explicit execution request such as `/lazycc:start-work`.

## Claude adaptation

- Use OMC planning conventions and Claude Code Task delegation when available.
- Use `/lazycc:plan`, `/lazycc:ralplan`, or direct read-only exploration as the Claude alternative when the full LazyCodex planning machinery is unavailable.
- Preserve `.lazycodex` plan paths for interoperability; do not migrate plan state to `.omc` unless a later adapter explicitly owns that bridge.

## Adapter Notes

- Codex-only concept: `multi_agent_v1` delegation, `fork_context`, `.codex` session routing, and Codex model names are reference concepts only.
- Claude alternative: use Claude Code Task agents, OMC `/lazycc:team` for coordinated planning work, and Haiku/Sonnet/Opus capability classes from OMC model routing.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration, install plugins, start telemetry, or rewrite global files while planning.

## Completion

The output is a concrete `.lazycodex/plans/<slug>.md` plan with acceptance criteria, verification commands, manual QA scenarios, staged/unsupported notes, and the next invocation text.
