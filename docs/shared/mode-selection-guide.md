# Mode Selection Guide

## Quick Decision

| If you want...                                                        | Use this                       | Keyword                                        |
| --------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| Clarify vague requirements first                                      | `deep-interview`               | "deep interview", "ouroboros", "don't assume"  |
| Full autonomous build from idea                                       | `autopilot`                    | "autopilot", "build me", "I want a"            |
| Parallel autonomous (3-5x faster)                                     | `team` (replaces `ultrapilot`) | `/team N:executor "task"`                      |
| Persistence until verified done                                       | `ralph`                        | "ralph", "don't stop"                          |
| Parallel execution, manual oversight                                  | `ultrawork`                    | "ulw", "ultrawork"                             |
| Cost-efficient execution                                              | `` (modifier)                  | "eco", "budget"                                |
| Many similar independent tasks                                        | `team` (replaces `swarm`)      | `/team N:executor "task"`                      |
| Native Claude Code cross-turn loop with a single completion condition | Claude Code `/goal`            | `/goal "condition with proof"`                 |
| Durable goal ledger without starting another loop                     | artifact-only Ultragoal        | Write goal artifacts/checkpoints/evidence only |

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

Already have one measurable completion condition and want Claude Code to keep the session moving?
└── YES: Claude Code /goal, unless Ralph/Team/autopilot already owns the loop

Need durable tracking but no active execution loop yet?
└── YES: artifact-only Ultragoal ledger/checkpoints/evidence
```

## Goal-Oriented Workflow Selection

Claude Code `/goal`, Ralph, Team, and artifact-only Ultragoal all help with "keep going until done" work, but they own different parts of the workflow. Pick one primary loop authority for a session; do not run competing persistence loops at the same time.

| Workflow                | Primary authority                      | Best fit                                                                                | Evidence and completion rule                                                                 | Avoid when                                                                                 |
| ----------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code `/goal`     | Claude Code native goal loop           | One active session needs a measurable completion condition and cross-turn persistence   | Surface proof in the conversation, then let the `/goal` evaluator judge the stated condition | Ralph, Team, autopilot, or another Stop-hook loop is already driving continuation |
| Ralph                   | OMC persistence loop                   | Single-owner implementation that must finish all PRD stories with reviewer verification | Fresh tests/build/lint plus reviewer approval against PRD criteria                           | Work should be split across several owners first                                           |
| Team                    | OMC coordinated team pipeline          | Parallel work with explicit task ownership and staged verification                      | Task results, worker commits, team verification/fix loop evidence                            | One person can finish faster than coordination overhead                                    |
| Artifact-only Ultragoal | Durable goal artifacts, no active loop | Planning, handoff, or audit trail when a runtime loop is unavailable or unsafe          | Goal ledger, checkpoints, handoff prompts, and attached evidence                             | The user expects automatic execution without selecting Ralph/Team/`/goal`                  |

### Claude Code `/goal` source boundary

OMC docs treat `/goal` facts as Claude Code facts. Cite Claude Code or Anthropic sources only when documenting its behavior: the [Claude Code `/goal` docs](https://code.claude.com/docs/en/goal) and [Anthropic Claude Code changelog](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md). Do not use OpenAI/Codex documentation as authority for `/goal`.

Important limitation: the `/goal` evaluator judges from evidence surfaced in the Claude Code conversation. OMC docs and handoffs must not claim that the evaluator independently runs shell commands, reads files, or inspects hidden repository state. If tests, diffs, or logs matter, run them through the normal OMC/Claude Code tools and include the result in the visible evidence before relying on `/goal` status.

### Conflict policy

Use the deterministic policy names `refuse`, `adopt_existing`, and `artifact_only` when documenting or implementing loop-conflict handling.

When a goal-like request enters an OMC session:

1. If Ralph, Team, autopilot, or a Stop-hook loop is active, keep that OMC loop as the authority and use `/goal` only as a documented handoff option.
2. If Claude Code `/goal` is already active, either adopt that existing goal explicitly, refuse to start a competing OMC loop, or degrade to artifact-only Ultragoal documentation.
3. If hooks, workspace trust, or managed settings make `/goal` unavailable, use Ralph/Team or artifact-only Ultragoal instead of pretending `/goal` is active.
4. Always attach command/test/review evidence before declaring durable OMC completion. `/goal` evaluator success alone is not the OMC final-review gate.

## Examples

| User Request                            | Best Mode       | Why                             |
| --------------------------------------- | --------------- | ------------------------------- |
| "Build me a REST API"                   | autopilot       | Single coherent deliverable     |
| "Build frontend, backend, and database" | team 3:executor | Clear component boundaries      |
| "Fix all 47 TypeScript errors"          | team 5:executor | Many independent similar tasks  |
| "Refactor auth module thoroughly"       | ralph           | Need persistence + verification |
| "Quick parallel execution"              | ultrawork       | Manual oversight preferred      |
| "Save tokens while fixing errors"       | + ultrawork     | Cost-conscious parallel         |
| "Don't stop until done"                 | ralph           | Persistence keyword detected    |

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

- \*\*\*\*: Changes model routing to prefer cheaper tiers

## Valid Combinations

| Combination     | Effect                                 |
| --------------- | -------------------------------------- |
| `eco ralph`     | Ralph persistence with cheaper agents  |
| `eco ultrawork` | Parallel execution with cheaper agents |
| `eco autopilot` | Autonomous execution with cost savings |

## Invalid Combinations

| Combination      | Why Invalid                       |
| ---------------- | --------------------------------- |
| `autopilot team` | Both are standalone - use one     |
| `` alone         | Needs an execution mode to modify |
