# Features Reference (v3.1 - v3.4)

## Notepad Wisdom System

Plan-scoped wisdom capture for learnings, decisions, issues, and problems.

**Location:** `.omc/notepads/{plan-name}/`

| File | Purpose |
|------|---------|
| `learnings.md` | Technical discoveries and patterns |
| `decisions.md` | Architectural and design decisions |
| `issues.md` | Known issues and workarounds |
| `problems.md` | Blockers and challenges |

**API:** `initPlanNotepad()`, `addLearning()`, `addDecision()`, `addIssue()`, `addProblem()`, `getWisdomSummary()`, `readPlanWisdom()`

## Delegation Categories

Semantic task categorization that auto-maps to model tier, temperature, and thinking budget.

| Category | Tier | Temperature | Thinking | Use For |
|----------|------|-------------|----------|---------|
| `visual-engineering` | HIGH | 0.7 | high | UI/UX, frontend, design systems |
| `ultrabrain` | HIGH | 0.3 | max | Complex reasoning, architecture, deep debugging |
| `artistry` | MEDIUM | 0.9 | medium | Creative solutions, brainstorming |
| `quick` | LOW | 0.1 | low | Simple lookups, basic operations |
| `writing` | MEDIUM | 0.5 | medium | Documentation, technical writing |

**Auto-detection:** Categories detect from prompt keywords automatically.

## Directory Diagnostics Tool

Project-level type checking via `lsp_diagnostics_directory` tool.

**Strategies:**
- `auto` (default) - Auto-selects best strategy, prefers tsc when tsconfig.json exists
- `tsc` - Fast, uses TypeScript compiler
- `lsp` - Fallback, iterates files via Language Server

**Usage:** Check entire project for errors before commits or after refactoring.

## Session Resume

Background agents can be resumed with full context via `resume-session` tool.

## Ultrapilot (v3.4)

Parallel autopilot with up to 5 concurrent workers for 3-5x faster execution.

**Trigger:** "ultrapilot", "parallel build", "swarm build"

**How it works:**
1. Task decomposition engine breaks complex tasks into parallelizable subtasks
2. File ownership coordinator assigns non-overlapping file sets to workers
3. Workers execute in parallel, coordinator manages shared files
4. Results integrated with conflict detection

**Best for:** Multi-component systems, fullstack apps, large refactoring

**State files:**
- `.omc/state/ultrapilot-state.json` - Session state
- `.omc/state/ultrapilot-ownership.json` - File ownership

## Swarm (v3.4)

N coordinated agents with atomic task claiming from shared pool.

**Usage:** `/swarm 5:executor "fix all TypeScript errors"`

**Features:**
- Shared task list with pending/claimed/done status
- 5-minute timeout per task with auto-release
- Clean completion when all tasks done

## Pipeline (v3.4)

Sequential agent chaining with data passing between stages.

**Built-in Presets:**
| Preset | Stages |
|--------|--------|
| `review` | explore -> architect -> critic -> executor |
| `implement` | planner -> executor -> tdd-guide |
| `debug` | explore -> architect -> build-fixer |
| `research` | parallel(researcher, explore) -> architect -> writer |
| `refactor` | explore -> architect-medium -> executor-high -> qa-tester |
| `security` | explore -> security-reviewer -> executor -> security-reviewer-low |

**Custom pipelines:** `/pipeline explore:haiku -> architect:opus -> executor:sonnet`

## Unified Cancel (v3.4)

Smart cancellation that auto-detects active mode.

**Usage:** `/cancel` or just say "cancelomc", "stopomc"

Auto-detects and cancels: autopilot, ultrapilot, ralph, ultrawork, ultraqa, ecomode, swarm, pipeline
Use `--force` or `--all` to clear ALL states.

## Verification Module (v3.4)

Reusable verification protocol for workflows.

**Standard Checks:** BUILD, TEST, LINT, FUNCTIONALITY, ARCHITECT, TODO, ERROR_FREE

**Evidence validation:** 5-minute freshness detection, pass/fail tracking

## State Management (v3.4)

Standardized state file locations.

**Standard paths for all mode state files:**
- Primary: `.omc/state/{name}.json` (local, per-project)
- Global backup: `~/.omc/state/{name}.json` (global, session continuity)

**Mode State Files:**
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

Legacy locations auto-migrated on read.
