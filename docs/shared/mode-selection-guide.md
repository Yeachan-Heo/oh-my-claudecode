# Mode Selection Guide

## Quick Decision

| If you want... | Use this | Keyword |
|----------------|----------|---------|
| Multi-agent coordinated execution (recommended) | `team` | "team", "coordinated team" |
| Full autonomous build from idea | `autopilot` | "autopilot", "build me", "I want a" |
| Persistence until verified done | `ralph` | "ralph", "don't stop" |
| Parallel execution, manual oversight | `ultrawork` | "ulw", "ultrawork" |
| Persistent team execution | `team ralph` | "team ralph" |

## If You're Confused

**Start with `team`** — it is the canonical orchestration surface since v4.1.7. It handles most multi-agent scenarios with a staged pipeline (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`) and transitions between stages automatically.

For single-deliverable autonomous builds, use `autopilot`.

## Detailed Decision Flowchart

```
Want multi-agent execution?
├── YES: team (canonical orchestration — staged pipeline with specialized agents)
│   └── Need persistence until verified? team ralph (adds ralph retry loop)
└── NO: Want autonomous end-to-end execution?
    ├── YES: autopilot (sequential with ralph phases)
    └── NO: Want persistence until verified done?
        ├── YES: ralph (persistence + ultrawork + verification)
        └── NO: Want parallel execution with manual oversight?
            ├── YES: ultrawork
            └── NO: Standard orchestration (delegate to agents directly)
```

## Examples

| User Request | Best Mode | Why |
|--------------|-----------|-----|
| "Fix all 47 TypeScript errors" | team | Many subtasks, team decomposes and assigns to workers |
| "Build frontend, backend, and database" | team | Clear component boundaries, parallel team agents |
| "Build me a REST API" | autopilot | Single coherent deliverable, autonomous execution |
| "Refactor auth module thoroughly" | ralph | Need persistence + verification for focused work |
| "Quick parallel execution" | ultrawork | Manual oversight preferred |
| "Don't stop until done" | ralph | Persistence keyword detected |
| "Build complete app with tests and review" | team ralph | Team orchestration + ralph persistence loop |

## Mode Categories

### Canonical Orchestration
- **team**: Multi-agent coordinated execution with staged pipeline. The recommended default for any task that benefits from parallelism or multiple specialized agents. Supports `team ralph` for persistence.

### Autonomous Execution
- **autopilot**: Autonomous end-to-end execution from idea to working code. Best for single coherent deliverables.

### Persistence + Verification
- **ralph**: Self-referential loop with verification. Keeps working until the task is verified complete. Includes ultrawork for parallel execution.

### Component Modes
- **ultrawork**: Parallel execution engine (used by ralph, autopilot, and team internally).

### Legacy Facades

> **Note:** The following modes are retained for backward compatibility but route through `team` internally since v4.1.7. Prefer using `team` directly.

- **ultrapilot**: Legacy parallel autonomous mode. Now a facade over `team` with autopilot-style decomposition. Use `team` instead for better control and visibility.
- **swarm**: Legacy N-agent coordination with SQLite task pool. Now an alias for `team`. Use `team` directly for native Claude Code team tools, task dependencies, and inter-agent communication.

## Valid Combinations

| Combination | Effect |
|-------------|--------|
| `team ralph` | Team orchestration with ralph persistence loop |
| `eco ralph` | Ralph persistence with cheaper agents |
| `eco ultrawork` | Parallel execution with cheaper agents |
| `eco autopilot` | Autonomous execution with cost savings |
| `eco team` | Team orchestration with cheaper agents |

## Invalid Combinations

| Combination | Why Invalid |
|-------------|-------------|
| `autopilot team` | Both are standalone — use `team` for multi-agent, `autopilot` for autonomous |
| `` alone | Needs an execution mode to modify |
