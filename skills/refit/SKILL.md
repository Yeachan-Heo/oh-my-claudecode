---
name: refit
description: Cross-session environment retrospective driven by OMC's own instrumentation — trace timelines, friction reports, logs, and plan notepads. Every finding lands on the surface that owns the fix (deterministic check, steering volume, tooling, or information access); nothing is written without user approval.
argument-hint: "[--scope <area>] [--last <N sessions>]"
disable-model-invocation: true
---

# Refit

Refit surveys the environment the agent worked in — not the code it produced (review and verify own that) and not one launch run's lessons (the sediment pass owns that). Every kind of work leaves friction behind: a ralph loop that kept tripping on the same check, an autopilot run that stalled waiting for a signal, a debugging session where the decisive output was never captured anywhere. OMC instruments all of it. Refit reads the instruments and converts recorded friction into environment changes, so the next run starts in a better yard.

## Evidence first

The survey starts from OMC's instruments, not from a checklist. Read before asking the user anything:

- `trace_timeline` / `trace_summary` — where turns stalled, repeated, or fanned out wastefully
- `omc session friction report` — friction the session recorded about itself
- `.omc/logs/` and session state — errors, retries, swallowed failures
- plan notepads `.omc/notepads/*/issues.md` and `problems.md` — problems that accumulated across a plan
- the repo's own check surface (`package.json` scripts, CI workflows) — read before proposing any new check, because a check that exists but sits unwired or silently broken is the finding, not a reinvention

Findings emerge from what the data shows. An empty survey is a valid result and is stated plainly; an invented finding is the same violation as skipping the survey. A repo with no wired automated checks is itself a finding, not a neutral default.

## Four fix-owner surfaces

Every finding names the surface that owns its fix. A finding that fits no surface is declined, explicitly and with the reason.

1. **Deterministic check** — the failure was mechanical: a fixed syntactic pattern, a banned API, an import shape, a file-location rule. The fix is a lint rule, hook, or CI job — whichever the repo's existing guardrails make cheapest. Default to building the check over writing the rule.
2. **Steering surface** — the failure was a judgement call no guardrail substitutes for: cross-file consistency, matches-surrounding-style. The fix lands in the matching `docs/standards/` volume, or in `CLAUDE.md`/`AGENTS.md` within the thin-entry budget the launch sediment pass defines. Navigation pointers over prose.
3. **Tool surface** — the drag was tooling itself: expensive or token-inefficient MCP calls, missing automation, checks too slow to be run when they matter. The fix lands in `.mcp.json`, `scripts/`, hooks, or OMC config.
4. **Information surface** — the agent needed a signal it could not reach: dev-server logs, service state, third-party readonly access. The fix tees the log, exposes the state, or documents the access path.

The split rests on where enforcement pressure lives: implementation contexts carry the most of it (exploration, writing, and debugging all at once); review contexts receive a diff with none of it. Standards therefore belong to reviewers and checks — never to more instructions loaded onto the implementer.

## Proposal and landing

1. Present findings ranked by severity, each as `finding → surface → intended change`, with one line of instrument evidence (which instrument, what it showed).
2. Stop for user approval. Each line is individually approvable or vetoable.
3. Write approved findings to their surfaces. Before writing any steering prose, call the Skill tool with `agent-doc-discipline` and pass its verification checklist.
4. Record where each finding landed — one file location per line — so the next refit starts from the record, not from memory. A refit on a launch-run session starts from that run's sediment list; a launch run may defer a lesson to a later refit by naming it.

## Headless refit (unattended invocation)

Refit is user-invoked, but its survey does not need the user at the keyboard to run — only to dispose. A host scheduler (cron, CI timer, an automation tool) may start a headless agent session that invokes this skill; the survey runs to its natural boundary under the same contract:

- The survey reads the same instruments and lands nothing anywhere: headless refit produces the proposal list only — `finding → surface → intended change`, each with one line of instrument evidence — written to `.omc/refit/pending-proposals.md` and, when a notification channel is configured (`configure-notifications`), summarized there so the user learns a survey is waiting.
- Nothing reaches a surface without the user's approval, exactly as in an interactive refit: proposals wait ranked, each independently vetoable, and the next interactive refit starts from the pending list instead of re-running the survey.
- An empty survey is stated plainly ("no findings"), never padded — inventing findings is the same violation as skipping the survey.

## Output

- Findings ranked by severity, each with evidence, surface, and intended change — every line independently decidable
- After approval: what landed and where
- Declined findings, with reasons
