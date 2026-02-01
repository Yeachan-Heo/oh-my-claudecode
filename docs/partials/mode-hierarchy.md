# Execution Mode Hierarchy

This document defines the relationships between execution modes and provides guidance on mode selection.

## Mode Inheritance Tree

```
autopilot (autonomous end-to-end)
├── includes: ralph (persistence)
│   └── includes: ultrawork (parallelism)
├── includes: ultraqa (QA cycling)
└── includes: plan (strategic thinking)

ultrapilot (parallel autopilot)
├── includes: file ownership partitioning
├── includes: worker coordination (up to 5 workers)
└── falls back to: autopilot (if not parallelizable)

swarm (N-agent coordination)
├── includes: SQLite task claiming
├── includes: heartbeat monitoring
└── orthogonal to: autopilot/ultrapilot (different paradigm)

ecomode (token efficiency ONLY)
└── modifies: agent tier selection (prefer haiku/sonnet)
    (does NOT include persistence - that's ralph's job)

ralph (persistence wrapper)
└── includes: ultrawork (parallelism engine)
    (adds: loop until done + architect verification)

ultrawork (parallelism engine)
└── COMPONENT only - parallel agent spawning
    (no persistence, no verification loop)
```

## Mode Relationships

| Mode | Type | Includes | Mutually Exclusive With |
|------|------|----------|------------------------|
| autopilot | Standalone | ralph, ultraqa, plan | ultrapilot |
| ultrapilot | Standalone | file ownership, workers | autopilot |
| swarm | Standalone | SQLite claiming | - |
| ralph | Wrapper | ultrawork | - |
| ultrawork | Component | - | - |
| ecomode | Modifier | - | - |
| ultraqa | Component | - | - |

## Decision Tree

```
Want autonomous execution?
├── YES: Is task parallelizable into 3+ independent components?
│   ├── YES: ultrapilot (parallel autopilot with file ownership)
│   └── NO: autopilot (sequential with ralph phases)
└── NO: Want parallel execution with manual oversight?
    ├── YES: Do you want cost optimization?
    │   ├── YES: ecomode + ultrawork
    │   └── NO: ultrawork alone
    └── NO: Want persistence until verified done?
        ├── YES: ralph (persistence + ultrawork + verification)
        └── NO: Standard orchestration (delegate to agents directly)

Have many similar independent tasks (e.g., "fix 47 errors")?
└── YES: swarm (N agents claiming from task pool)
```

## Mode Differentiation Matrix

| Mode | Best For | Parallelism | Persistence | Verification | File Ownership |
|------|----------|-------------|-------------|--------------|----------------|
| autopilot | "Build me X" | Via ralph | Yes | Yes | N/A |
| ultrapilot | Multi-component | 5 workers | Yes | Yes | Partitioned |
| swarm | Homogeneous tasks | N workers | Per-task | Per-task | Per-task |
| ralph | "Don't stop" | Via ultrawork | Yes | Mandatory | N/A |
| ultrawork | Parallel only | Yes | No | No | N/A |
| ecomode | Cost savings | Modifier | No | No | N/A |

## Quick Reference

**Just want to build something?** → `autopilot`
**Building multi-component system?** → `ultrapilot`
**Fixing many similar issues?** → `swarm`
**Want control over execution?** → `ultrawork`
**Need verified completion?** → `ralph`
**Want to save tokens?** → `ecomode` (combine with other modes)

## Combining Modes

Valid combinations:
- `eco ralph` = Ralph loop with cheaper agents
- `eco ultrawork` = Parallel execution with cheaper agents
- `eco autopilot` = Full autonomous with cost optimization

Invalid combinations:
- `autopilot ultrapilot` = Mutually exclusive (both are standalone)
- `ecomode` alone = Not useful (needs an execution mode)

## State Management

### Standard Paths
All mode state files use standardized locations:
- Primary: `.omc/state/{name}.json` (local, per-project)
- Global backup: `~/.omc/state/{name}.json` (global, session continuity)

### Mode State Files
| Mode | State File |
|------|-----------|
| ralph | `ralph-state.json` |
| autopilot | `autopilot-state.json` |
| ultrapilot | `ultrapilot-state.json` |
| ultrawork | `ultrawork-state.json` |
| ecomode | `ecomode-state.json` |
| ultraqa | `ultraqa-state.json` |
| pipeline | `pipeline-state.json` |
| swarm | `swarm-summary.json` + `swarm-active.marker` |

**Important:** Never store OMC state in `~/.claude/` - that directory is reserved for Claude Code itself.

Legacy locations are auto-migrated on read.
