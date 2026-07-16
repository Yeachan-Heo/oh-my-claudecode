# Model Cost Optimization

How to get OMC's multi-agent output without paying Opus prices for Haiku work. Smart model routing typically saves 30-50% on tokens compared to running everything on the largest model.

Tier definitions live in [docs/shared/agent-tiers.md](shared/agent-tiers.md), the single source of truth for which agent runs on which model. This guide covers when to use each tier, not what the tiers are.

## The Haiku-First Principle

Start with the lightest model that can do the job. Escalate only when the light model demonstrably falls short.

- Quick lookups, file finding, simple questions: `explore`, `writer` (Haiku)
- Feature implementation, standard debugging, test writing: `executor`, `debugger`, `test-engineer` (Sonnet)
- Architecture decisions, deep analysis, plan review: `architect`, `planner`, `critic` (Opus)

Escalation is cheap when it starts small: a failed Haiku lookup costs almost nothing, and the retry on Sonnet arrives with better context. Starting on Opus for everything costs the difference on every call, including the many calls that never needed it.

## High-Cost Operations

These multiply agent count, so their model choices multiply too:

| Operation | Why it costs | When it earns its cost |
|-----------|--------------|------------------------|
| `team` | N coordinated agents on a shared task list | Large tasks with genuinely parallel parts |
| `autopilot` | Full pipeline: expansion, planning, execution, QA, validation | End-to-end builds from an idea |
| `ralph` | Persistence loop, repeated verification passes | Tasks that must run to completion unattended |
| `ultrawork` | Parallel executors | High-throughput batches of independent edits |
| `qa-tester` | Interactive tmux sessions, long transcripts | Behavior that unit tests cannot reach |

A single well-prompted agent beats a team on any task without parallel structure.

## Combination Patterns

Proven sequences that keep expensive models at the decision points and cheap models everywhere else:

- **Standard build**: `explore` (Haiku) → `planner` (Opus) → `executor` (Sonnet) → `verifier` (Sonnet)
- **Deep analysis**: `analyst` → `architect` → `planner` → `critic` (Opus where it matters) → `executor` → `verifier` (Sonnet)
- **Debugging loop**: `debugger` (Sonnet) → `architect` (Opus, only if the debugger stalls) → `qa-tester` (Sonnet, only for interactive verification)
- **Review pipeline**: `code-reviewer` (Opus) → `security-reviewer` (Sonnet) → `executor` (Sonnet) for fixes

Verification order also matters for cost: existing tests are nearly free, direct commands are cheap, `qa-tester` is expensive. Exhaust the cheap evidence first.

## Anti-Patterns

- **All-Opus configuration.** Setting every agent to Opus buys latency and cost, not quality. Mechanical edits do not improve with model size.
- **Heavy modes for small tasks.** `ultrawork` on a single-file change or a team for a one-line fix spends coordination overhead with nothing to coordinate. OMC's task-size detection suppresses heavy modes for small prompts; do not fight it.
- **qa-tester as the default verifier.** Reach for it only after existing tests and direct commands cannot observe the behavior.
- **Claiming completion without verification.** Skipping the verifier saves one Sonnet call and regularly costs a full rework cycle.

## Practical Tips

- Plan before heavy execution: a `/plan` pass (low cost) that scopes the work makes every downstream agent cheaper.
- Watch the HUD: `agents:` and `ctx:` fields show what is running and how full the context is.
- Use `cancelomc` the moment a heavy mode stops earning its cost.
- Per-agent model overrides belong in config (`~/.config/claude-omc/config.jsonc` or `.claude/omc.jsonc`), and only where a specific agent consistently under- or over-performs its default tier.
