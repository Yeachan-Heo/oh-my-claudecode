---
name: map
description: The yard's skill map — which skill owns which job, in delivery-loop order. Use when something needs doing but not which of the shipped skills owns it; the map routes, it never executes.
argument-hint: "[what are you trying to do]"
disable-model-invocation: true
---

# Map

You know something needs doing; you do not know which skill owns it. Find the job below and follow its route. Most routes call the Skill tool; a route marked manual gives you the slash command to invoke yourself because model invocation is disabled. The map routes and explains nothing twice — each routed skill owns its own doctrine.

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
| Code crosses a function boundary; designs should compete first | `architect` |
| A design question prose cannot settle | `loft` |
| Finished work needs judgment | `review` |
| Something claims to be done | `verify` |
| Work is landing as a PR | `pr` |
| An open PR needs driving to merge-ready | `babysit` |
| The run taught the environment something | `refit` |

## On-ramps (off the main loop)

| Job | Skill |
|---|---|
| A bug needs its root cause | `debug`; competing-hypothesis tracing: `trace` |
| The question is why the code is this way | `why` |
| A subsystem needs explaining | `how` |
| A risky change needs its blast radius mapped | `blast-radius` |
| The same agent mistake keeps recurring | `correct` |
| Long autonomous work needs an audit trail | `show-me-your-work` |
| No bundled skill fits the task shape | `figure-it-out` (designs one, validated against anchors) |
| Roles should run on chosen models | `models` |
| Tests should drive the implementation | `tdd` |
| The codebase is getting harder to change | `architecture-survey` |
| AI-generated slop needs cleanup | `ai-slop-cleaner` |
| An open question needs grounded answers | `research`; external docs: `external-context` |
| Knowledge should compound across sessions | `wiki`; durable project memory: `remember` |
| A recurring autonomous improvement loop | `self-improve`; durable goal ledger: `ultragoal` |
| A session needs reorientation across its pivots and outcomes | `session-flow` — run `/oh-my-claudecode:session-flow` manually |
| Visual work needs verdicts or diagrams | `visual-verdict`; `diagram` |

## Utilities

| Job | Skill |
|---|---|
| Install, diagnose, configure | `omc-setup`; `omc-doctor`; `configure-notifications` |
| Manage skills themselves | `skill` (local); `skillify` (extract from session) |
| Inspect orchestration state | `trace` (also the tracing lane); `graph` (DAG runtime) |
| Cancel a mode | `cancel` |
| CI is red on a PR you own | `fix-ci` |
| Review threads need triage | `get-pr-comments` |
| PR conflicts need resolution | `fix-merge-conflicts` |

## Rules

- The map routes; it never executes. Each ordinary row resolves to one Skill-tool call — make it, then follow that skill's doctrine. For a manual-only route, show the user its slash command; do not try to call the Skill tool.
- When two rows both fit, the delivery loop above is the tiebreak: earlier legs come first.
- Phase boundaries (continue / re-enter from disk / hand off / compact) are defined in `launch`'s Context hygiene — the map does not restate them.
- A job matching no row is itself information: say so plainly rather than picking the nearest-sounding skill.
