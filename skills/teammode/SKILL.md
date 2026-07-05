---
name: teammode
description: "LazyCC Claude adaptation of LazyCodex teammode for coordinated team execution."
---

# LazyCC Teammode

Invoke with `/lazycc:teammode`.

Workflow concept: `teammode`

## Purpose

Coordinate multiple agents on a shared objective using Claude-native LazyCC team behavior. This skill preserves LazyCodex team intent while replacing durable Codex thread operations with LazyCC team stages and handoffs.

## Progressive Disclosure

1. Confirm the goal is clear enough for parallel coordination.
2. Read `skills/team/SKILL.md` and relevant LazyCodex `teammode` reference sections.
3. Split work by ownership area or perspective, not vague titles.
4. Create a team plan with dependencies, evidence requirements, and handoffs.
5. Run team-exec, team-verify, and team-fix loops until the result is terminal.

## Claude adaptation

- Prefer `/lazycc:team` for the runtime surface.
- Use `.omc/handoffs/` for OMC team stage handoffs and `.lazycodex/teams/` only when an explicit compatibility adapter owns that state.
- If durable Codex thread features are required, stage that portion and explain the missing Claude equivalent.

## Adapter Notes

- Codex-only concept: `codex_app` thread creation, Codex thread URLs, `multi_agent_v1`, and `.codex` member state are not Claude runtime instructions.
- Claude alternative: OMC TeamCreate/Task/SendMessage surfaces exposed by Claude Code and `/lazycc:team`.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration or archive external sessions unless the user explicitly asks.

## Completion

Produce team status, member deliverables, verification artifacts, cleanup receipts, and any staged unsupported runtime requirements.
