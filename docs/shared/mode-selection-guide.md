# Mode Selection Guide

## Quick Decision

| If you want... | Use this | Keyword |
|----------------|----------|---------|
| Full autonomous build from idea | `autopilot` | "autopilot", "build me", "I want a" |
| Parallel autonomous (3-5x faster) | `ultrapilot` | "ultrapilot", "parallel build" |
| Persistence until verified done | `ralph` | "ralph", "don't stop" |
| Parallel execution, manual oversight | `ultrawork` | "ulw", "ultrawork" |
| Cost-efficient execution | `ecomode` (modifier) | "eco", "budget" |
| Many similar independent tasks | `swarm` | "swarm N agents" |

## If You're Confused

**Start with `autopilot`** - it handles most scenarios and transitions to other modes automatically.

## Detailed Decision Flowchart

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

## Examples

| User Request | Best Mode | Why |
|--------------|-----------|-----|
| "Build me a REST API" | autopilot | Single coherent deliverable |
| "Build frontend, backend, and database" | ultrapilot | Clear component boundaries |
| "Fix all 47 TypeScript errors" | swarm | Many independent similar tasks |
| "Refactor auth module thoroughly" | ralph | Need persistence + verification |
| "Quick parallel execution" | ultrawork | Manual oversight preferred |
| "Save tokens while fixing errors" | ecomode + ultrawork | Cost-conscious parallel |
| "Don't stop until done" | ralph | Persistence keyword detected |

## Mode Types

### Standalone Modes
These run independently:
- **autopilot**: Autonomous end-to-end execution
- **ultrapilot**: Parallel autonomous with file ownership
- **swarm**: N-agent coordination with task pool

### Wrapper Modes
These wrap other modes:
- **ralph**: Adds persistence + verification around ultrawork

### Component Modes
These are used by other modes:
- **ultrawork**: Parallel execution engine (used by ralph, autopilot)

### Modifier Modes
These modify how other modes work:
- **ecomode**: Changes model routing to prefer cheaper tiers

## Valid Combinations

| Combination | Effect |
|-------------|--------|
| `eco ralph` | Ralph persistence with cheaper agents |
| `eco ultrawork` | Parallel execution with cheaper agents |
| `eco autopilot` | Autonomous execution with cost savings |

## Invalid Combinations

| Combination | Why Invalid |
|-------------|-------------|
| `autopilot ultrapilot` | Both are standalone - use one |
| `ecomode` alone | Needs an execution mode to modify |
