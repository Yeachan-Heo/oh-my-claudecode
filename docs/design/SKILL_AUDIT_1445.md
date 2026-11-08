# Issue #1445 Skill Audit

Date: 2026-03-08

## Goal

Audit the seven questioned-value skills called out in issue #1445 and decide whether they are ready for deprecation, should remain built-in, or need follow-up instrumentation before any removal decision.

## Skills Reviewed

| Skill | Lines | Initial concern | Audit verdict |
| --- | ---: | --- | --- |
| `configure-notifications` | 1213 | Large for a narrow task | Keep for now; too much behavior to deprecate without usage data |
| `sciomc` | 510 | Niche scientific workflow | Keep for now; niche is not the same as unused |
| `deep-interview` | 551 | Complex and unclear frequency | Keep for now; keyword-triggered planning surface still exists |
| `project-session-manager` | 564 | Overlaps with native worktrees | Keep for now; still provides tmux/session orchestration beyond plain git worktrees |
| `writer-memory` | 443 | Domain-specific | Keep for now; domain specificity alone is not sufficient removal evidence |
| `external-context` | 83 | Thin wrapper concern | Candidate for later consolidation, but not enough evidence for removal today |
| `release` | 87 | Project-specific | Keep for now; project-specific maintenance workflows are expected in this repo |

## Existing Evidence Sources

The repository already has useful observability surfaces that can support a future deprecation decision:

- `src/hooks/subagent-tracker/flow-tracer.ts`
- `src/hooks/subagent-tracker/session-replay.ts`
- `src/tools/trace-tools.ts`
- `docs/PERFORMANCE-MONITORING.md`
- `skills/learn-about-omc/SKILL.md`

These surfaces provide session-level traces, replay data, and aggregate summaries. They are enough to support a structured manual audit before adding new opt-in telemetry.

## Why This Issue Is Not Deprecation-Ready Yet

A removal/deprecation decision still lacks three things:

1. **A denominator** — whether usage should be measured against canonical skills only, canonical + deprecated aliases, or by user sessions.
2. **A time window** — there is no agreed threshold for "<5% usage" across days, weeks, or releases.
3. **A privacy posture** — adding new telemetry would require explicit opt-in scope and retention rules.

Without those, immediate removals would be arbitrary and hard to defend.

## Recommended Evaluation Rubric

Before any future deprecation PR, require all of the following:

1. At least one release cycle of trace-derived usage data or a clearly documented manual sampling method.
2. A written threshold for low usage, including the population being measured.
3. A migration path for any command that remains user-facing.
4. A replacement surface, if the skill is removed because native tools or other skills already cover the use case.

## Recommended Next Steps

### Keep as-is for now

- `configure-notifications`
- `sciomc`
- `deep-interview`
- `project-session-manager`
- `writer-memory`
- `release`

### Revisit later with stronger evidence

- `external-context`

### Follow-up work if maintainers want harder data

1. Document a trace-based audit workflow using existing `trace_summary` and replay data.
2. Decide whether `learn-about-omc` should surface that audit view directly.
3. Only then consider new opt-in telemetry if the trace workflow proves insufficient.

## Conclusion

Issue #1445 is valid as an audit request, but it does **not** currently justify removing any of the reviewed skills. The correct outcome today is an audit record plus a clearer decision framework, not a deprecation batch.
