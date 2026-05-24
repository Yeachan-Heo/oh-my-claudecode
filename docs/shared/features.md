# Features Reference (v3.1 - v3.4)

## Session Notepad (Short-Term Memory)

Compaction-resilient memory system at `.omc/notepad.md` with three tiers:

| Section | Behavior | Use For |
|---------|----------|---------|
| **Priority Context** | ALWAYS loaded on session start (max 500 chars) | Critical facts: "Project uses pnpm", "API key in .env" |
| **Working Memory** | Timestamped entries, auto-pruned after 7 days | Debugging breadcrumbs, temporary findings |
| **MANUAL** | Never auto-pruned | Team contacts, deployment info, permanent notes |

**User skill:** `/oh-my-claudecode:note`
- `/oh-my-claudecode:note <content>` - Add to Working Memory
- `/oh-my-claudecode:note --priority <content>` - Add to Priority Context
- `/oh-my-claudecode:note --manual <content>` - Add to MANUAL section
- `/oh-my-claudecode:note --show` - Display notepad contents

**Automatic capture:** `<remember>` tags in Task agent output are automatically captured:
- `<remember>content</remember>` → Working Memory with timestamp
- `<remember priority>content</remember>` → Replaces Priority Context

**API:** `initNotepad()`, `addWorkingMemoryEntry()`, `setPriorityContext()`, `addManualEntry()`, `getPriorityContext()`, `getWorkingMemory()`, `formatNotepadContext()`, `pruneOldEntries()`

## Notepad Wisdom System (Plan-Scoped)

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

## Pipeline (v3.4)

Sequential agent chaining with data passing between stages.

**Built-in Presets:**
| Preset | Stages |
|--------|--------|
| `review` | explore -> architect -> critic -> executor |
| `implement` | planner -> executor -> test-engineer |
| `debug` | explore -> architect -> debugger |
| `research` | parallel(document-specialist, explore) -> architect -> writer |
| `refactor` | explore -> architect-medium -> executor-high -> qa-tester |
| `security` | explore -> security-reviewer -> executor -> security-reviewer-low |

**Custom pipelines:** `/pipeline explore:haiku -> architect:opus -> executor:sonnet`

## Unified Cancel (v3.4)

Smart cancellation that auto-detects active mode.

**Usage:** `/cancel` or just say "cancelomc", "stopomc"

Auto-detects and cancels: autopilot, ralph, ultrawork, ultraqa, pipeline
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
| ultragoal | `ultragoal-state.json` |
| autopilot | `autopilot-state.json` |
| ultrawork | `ultrawork-state.json` |
|  | `-state.json` |
| ultraqa | `ultraqa-state.json` |
| pipeline | `pipeline-state.json` |

**Important:** Never store OMC state in `~/.claude/` - that directory is reserved for Claude Code itself.

Legacy locations auto-migrated on read.
