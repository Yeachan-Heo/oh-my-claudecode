# Mode Selection Guide

## Quick Decision

| If you want... | Use this | Keyword |
|----------------|----------|---------|
| Clarify vague requirements first | `deep-interview` | "deep interview", "ouroboros", "don't assume" |
| Full autonomous build from idea | `autopilot` | "autopilot", "build me", "I want a" |
| Parallel autonomous (3-5x faster) | `team` (replaces `ultrapilot`) | `/team N:executor "task"` |
| Persistence until verified done | `ralph` | "ralph", "don't stop" |
| Parallel execution, manual oversight | `ultrawork` | "ulw", "ultrawork" |
| Cost-efficient execution | `` (modifier) | "eco", "budget" |
| Many similar independent tasks | `team` (replaces `swarm`) | `/team N:executor "task"` |

> **Note:** `ultrapilot` and `swarm` are **deprecated** — they now route to `team` mode.

## If You're Confused or Uncertain

**Don't know what you don't know?** Start with `/deep-interview` - it uses Socratic questioning to clarify vague ideas, expose hidden assumptions, and measure clarity before any code is written.

**Already have a clear idea?** Start with `autopilot` - it handles most scenarios and transitions to other modes automatically.

## Detailed Decision Flowchart

```
Uncertain about requirements or have a vague idea?
├── YES: Use deep-interview to clarify before execution
└── NO: Continue below

Want autonomous execution?
├── YES: Is task parallelizable into 3+ independent components?
│   ├── YES: team N:executor (parallel autonomous with file ownership)
│   └── NO: autopilot (sequential with ralph phases)
└── NO: Want parallel execution with manual oversight?
    ├── YES: Do you want cost optimization?
    │   ├── YES: eco + ultrawork
    │   └── NO: ultrawork alone
    └── NO: Want persistence until verified done?
        ├── YES: ralph (persistence + ultrawork + verification)
        └── NO: Standard orchestration (delegate to agents directly)

Have many similar independent tasks (e.g., "fix 47 errors")?
└── YES: team N:executor (N agents claiming from task pool)
```

## Examples

| User Request | Best Mode | Why |
|--------------|-----------|-----|
| "Build me a REST API" | autopilot | Single coherent deliverable |
| "Build frontend, backend, and database" | team 3:executor | Clear component boundaries |
| "Fix all 47 TypeScript errors" | team 5:executor | Many independent similar tasks |
| "Refactor auth module thoroughly" | ralph | Need persistence + verification |
| "Quick parallel execution" | ultrawork | Manual oversight preferred |
| "Save tokens while fixing errors" |  + ultrawork | Cost-conscious parallel |
| "Don't stop until done" | ralph | Persistence keyword detected |

## Mode Types

### Standalone Modes
These run independently:
- **autopilot**: Autonomous end-to-end execution
- **team**: Canonical orchestration with coordinated agents (replaces `ultrapilot` and `swarm`)

> **Deprecated:** `ultrapilot` and `swarm` now route to `team` mode.

### Wrapper Modes
These wrap other modes:
- **ralph**: Adds persistence + verification around ultrawork

### Component Modes
These are used by other modes:
- **ultrawork**: Parallel execution engine (used by ralph, autopilot)

### Modifier Modes
These modify how other modes work:
- ****: Changes model routing to prefer cheaper tiers

## Valid Combinations

| Combination | Effect |
|-------------|--------|
| `eco ralph` | Ralph persistence with cheaper agents |
| `eco ultrawork` | Parallel execution with cheaper agents |
| `eco autopilot` | Autonomous execution with cost savings |

## Invalid Combinations

| Combination | Why Invalid |
|-------------|-------------|
| `autopilot team` | Both are standalone - use one |
| `` alone | Needs an execution mode to modify |
