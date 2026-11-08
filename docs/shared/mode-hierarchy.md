# Execution Mode Hierarchy

This document defines the relationships between execution modes and provides guidance on mode selection.

## Mode Inheritance Tree

```
autopilot (autonomous end-to-end)
├── includes: ralph (persistence)
└── includes: plan (strategic thinking)

ralph (persistence wrapper)
└── delegates to executor agents directly (in parallel where possible)
    (adds: loop until done + architect verification)
```

## Mode Relationships

| Mode | Type | Includes | Mutually Exclusive With |
|------|------|----------|------------------------|
| autopilot | Standalone | ralph, plan | - |
| ralph | Wrapper | - | - |

## Decision Tree

```
Want autonomous execution?
├── YES: Is task parallelizable into 3+ independent components?
│   ├── YES: team N:executor (parallel autonomous with file ownership)
│   └── NO: autopilot (sequential with ralph phases)
└── NO: Want persistence until verified done?
    ├── YES: ralph (persistence + verification)
    └── NO: Standard orchestration (delegate to agents directly)

Have many similar independent tasks (e.g., "fix 47 errors")?
└── YES: team N:executor (N agents claiming from task pool)
```

## Mode Differentiation Matrix

| Mode | Best For | Parallelism | Persistence | Verification | File Ownership |
|------|----------|-------------|-------------|--------------|----------------|
| autopilot | "Build me X" | Via ralph | Yes | Yes | N/A |
| team | Multi-component/homogeneous | N workers | Per-task | Per-task | Per-task |
| ralph | "Don't stop" | Direct agent delegation | Yes | Mandatory | N/A |

## Quick Reference

**Just want to build something?** → `autopilot`
**Building multi-component system?** → `team N:executor`
**Fixing many similar issues?** → `team N:executor`
**Need verified completion?** → `ralph`
**Want to limit token spend?** → Set `OMC_RUN_BUDGET_TOKENS` environment variable

## Combining Modes

Valid combinations:
- `team N:executor` = Coordinated parallel execution

Invalid combinations:
- `autopilot team` = Mutually exclusive (both are standalone)
- `ralph team` = Mutually exclusive (both are standalone)

## State Management

### Standard Paths
All mode state files use standardized locations:
- Primary: `.omc/state/{name}.json` (local, per-project)
- Global backup: `~/.omc/state/{name}.json` (global, session continuity)

### Mode State Files
| Mode | State File |
|------|------------|
| ralph | `ralph-state.json` |
| autopilot | `autopilot-state.json` |
| pipeline | `pipeline-state.json` |

**Important:** Never store OMC state in `~/.claude/` - that directory is reserved for Claude Code itself.

Legacy locations are auto-migrated on read.
