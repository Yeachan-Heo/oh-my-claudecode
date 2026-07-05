---
name: start-work
description: "LazyCC Claude adaptation of LazyCodex start-work for executing compatible plans in a Claude Code worktree."
---

# LazyCC Start Work

Invoke with `/lazycc:start-work`.

Workflow concept: `start-work`

## Purpose

Execute the next unchecked task from an approved LazyCodex-compatible work plan while preserving Boulder, ledger, evidence, and verification contracts in a Claude Code worktree.

## Progressive Disclosure

1. Read `.lazycodex/boulder.json` if present.
2. Read the selected `.lazycodex/plans/<slug>.md` and find the first unchecked top-level task.
3. Re-read task-specific references and local `AGENTS.md` files.
4. Write the failing-first proof where feasible, then implement the smallest scoped change.
5. Run task-specific tests, build/lint gates, manual QA, adversarial probes, and cleanup.
6. Record evidence under `.lazycodex/evidence/` and mark the plan task only after verification passes.

## Claude adaptation

- Use the task-owned worktree for every edit and command.
- Use Claude Code Task or `/lazycc:team` when delegation is available; otherwise execute directly and record the missing delegation surface as staged.
- Preserve `.lazycodex/start-work/ledger.jsonl` semantics for portable evidence; do not silently rewrite it to `.omc`.

## Adapter Notes

- Codex-only concept: `multi_agent_v1`, `fork_context`, `.codex` agent roles, and Codex Stop continuation are not Claude runtime instructions.
- Claude alternative: OMC persistent-mode hooks, Claude Code Task agents, `/lazycc:team`, and explicit evidence files.
- User examples are input context, not permission to mutate host settings.
- Do not mutate Claude configuration or generated `dist/` artifacts unless a task explicitly owns that source.

## Completion

Return a DoneClaim with changed files, exact verification commands and results, manual QA artifacts, adversarial results, cleanup receipts, and remaining risks.
