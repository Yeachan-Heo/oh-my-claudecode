---
name: map
description: The yard's skill map — which skill owns which job, in delivery-loop order. Use when something needs doing but not which of the shipped skills owns it; the map routes, it never executes.
argument-hint: "[what are you trying to do]"
disable-model-invocation: true
---

# Map

You know something needs doing; you do not know which skill owns it. Find the job below, call the Skill tool with the routed skill. The map routes and explains nothing twice — each routed skill owns its own doctrine.

## The delivery loop

| You are here | Skill |
|---|---|
| External work arrived (issues, PRs, reports) | `harbor` |
| A non-engineer handed you a chat log as requirements | `intent` |
| The destination is foggy — the first three decisions cannot be stated yet | `ask-navigator` |
| Vague idea; questions must come before anything else | `deep-interview` |
| Requirements are clear; you need a plan | `plan` (multi-perspective consensus: `ralplan`) |
| Approved plan; decompose and ship end to end with human checkpoints | `launch` |
| One task; persistence until verified complete | `ralph` |
| Hands-off idea-to-code | `autopilot` |
| Work needs coordinated parallel workers | `team` |
| One approved task carried through verified code | `execute` |
| A design question prose cannot settle | `loft` |
| Finished work needs judgment | `review` |
| Something claims to be done | `verify` |
| Work is landing as a PR | `pr` |
| The run taught the environment something | `refit` |

## On-ramps (off the main loop)

| Job | Skill |
|---|---|
| A bug needs its root cause | `debug`; competing-hypothesis tracing: `trace` |
| Tests should drive the implementation | `tdd` |
| The codebase is getting harder to change | `architecture-survey` |
| AI-generated slop needs cleanup | `ai-slop-cleaner` |
| An open question needs grounded answers | `research`; external docs: `external-context` |
| Knowledge should compound across sessions | `wiki`; durable project memory: `remember` |
| A recurring autonomous improvement loop | `self-improve`; durable goal ledger: `ultragoal` |
| Visual work needs verdicts or diagrams | `visual-verdict`; `diagram` |

## Utilities

| Job | Skill |
|---|---|
| Install, diagnose, configure | `omc-setup`; `omc-doctor`; `configure-notifications` |
| Manage skills themselves | `skill` (local); `skillify` (extract from session) |
| Inspect orchestration state | `trace` (also the tracing lane); `graph` (DAG runtime) |
| Cancel a mode | `cancel` |

## Rules

- The map routes; it never executes. Every row resolves to one Skill-tool call — make it, then follow that skill's own doctrine.
- When two rows both fit, the delivery loop above is the tiebreak: earlier legs come first.
- Phase boundaries (continue / re-enter from disk / hand off / compact) are defined in `launch`'s Context hygiene — the map does not restate them.
- A job matching no row is itself information: say so plainly rather than picking the nearest-sounding skill.
