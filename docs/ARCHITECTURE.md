# Architecture

> How oh-my-claudecode orchestrates multi-agent workflows.

## Overview

oh-my-claudecode enables Claude Code to orchestrate specialized agents through a skill-based routing system. It is built on four interlocking systems: **Hooks** detect lifecycle events, **Skills** inject behaviors, **Agents** execute specialized work, and **State** tracks progress across context resets.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OH-MY-CLAUDECODE                                 │
│                     Intelligent Skill Activation                         │
└─────────────────────────────────────────────────────────────────────────┘

  User Input                      Skill Detection                 Execution
  ──────────                      ───────────────                 ─────────
       │                                │                              │
       ▼                                ▼                              ▼
┌─────────────┐              ┌──────────────────┐           ┌─────────────────┐
│  "ultrawork │              │   CLAUDE.md      │           │ SKILL ACTIVATED │
│   refactor  │─────────────▶│   Auto-Routing   │──────────▶│                 │
│   the API"  │              │                  │           │ ultrawork +     │
└─────────────┘              │ Task Type:       │           │ default +       │
                             │  - Implementation│           │ git-master      │
                             │  - Multi-file    │           │                 │
                             │  - Parallel OK   │           │ ┌─────────────┐ │
                             │                  │           │ │ Parallel    │ │
                             │ Skills:          │           │ │ agents      │ │
                             │  - ultrawork ✓   │           │ │ launched    │ │
                             │  - default ✓     │           │ └─────────────┘ │
                             │  - git-master ✓  │           │                 │
                             └──────────────────┘           │ ┌─────────────┐ │
                                                            │ │ Atomic      │ │
                                                            │ │ commits     │ │
                                                            │ └─────────────┘ │
                                                            └─────────────────┘
```

The four systems flow in sequence:

```
User Input --> Hooks (event detection) --> Skills (behavior injection)
           --> Agents (task execution) --> State (progress tracking)
```

---

## Agent System

### Overview

OMC provides 19 specialized agents organized into 4 lanes. Each agent is invoked as `oh-my-claudecode:<agent-name>` and runs on the appropriate model tier.

### Build/Analysis Lane

Covers the full development lifecycle from exploration to verification.

| Agent | Default Model | Role |
|-------|---------------|------|
| `explore` | haiku | Codebase discovery, file/symbol mapping |
| `analyst` | opus | Requirements analysis, hidden constraint discovery |
| `planner` | opus | Task sequencing, execution plan creation |
| `architect` | opus | System design, interface definition, trade-off analysis |
| `debugger` | sonnet | Root-cause analysis, build error resolution |
| `executor` | sonnet | Code implementation, refactoring |
| `verifier` | sonnet | Completion verification, test adequacy confirmation |
| `tracer` | sonnet | Evidence-driven causal tracing, competing hypothesis analysis |

### Review Lane

Quality gates before handoff. Catches correctness and security issues.

| Agent | Default Model | Role |
|-------|---------------|------|
| `security-reviewer` | sonnet | Security vulnerabilities, trust boundaries, authn/authz review |
| `code-reviewer` | opus | Comprehensive code review, API contracts, backward compatibility |

### Domain Lane

Domain experts called in when needed.

| Agent | Default Model | Role |
|-------|---------------|------|
| `test-engineer` | sonnet | Test strategy, coverage, flaky-test hardening |
| `designer` | sonnet | UI/UX architecture, interaction design |
| `writer` | haiku | Documentation, migration notes |
| `qa-tester` | sonnet | Interactive CLI/service runtime validation via tmux |
| `scientist` | sonnet | Data analysis, statistical research |
| `git-master` | sonnet | Git operations, commits, rebase, history management |
| `document-specialist` | sonnet | External documentation, API/SDK reference lookup |
| `code-simplifier` | opus | Code clarity, simplification, maintainability improvement |

### Coordination Lane

Challenges plans and designs made by other agents. A plan passes only when no gaps can be found.

| Agent | Default Model | Role |
|-------|---------------|------|
| `critic` | opus | Gap analysis of plans and designs, multi-angle review |

### Model Routing

OMC uses three model tiers:

| Tier | Model | Characteristics | Cost |
|------|-------|-----------------|------|
| LOW | haiku | Fast and inexpensive | Low |
| MEDIUM | sonnet | Balanced performance and cost | Medium |
| HIGH | opus | Highest-quality reasoning | High |

Default assignments by role:
- **haiku**: Fast lookups and simple tasks (`explore`, `writer`)
- **sonnet**: Code implementation, debugging, testing (`executor`, `debugger`, `test-engineer`)
- **opus**: Architecture, strategic analysis, review (`architect`, `planner`, `critic`, `code-reviewer`)

### Delegation

Work is delegated through the Task tool with intelligent model routing:

```typescript
Task(
  subagent_type="oh-my-claudecode:executor",
  model="sonnet",
  prompt="Implement feature..."
)
```

**Delegate to agents when:**
- Multiple files need to change
- Refactoring is required
- Debugging or root-cause analysis is needed
- Code review or security review is needed
- Planning or research is required

**Handle directly when:**
- Simple file lookups
- Straightforward question answering
- Single-command operations

### Agent Selection Guide

| Task Type | Recommended Agent | Model |
|-----------|-------------------|-------|
| Quick code lookup | `explore` | haiku |
| Feature implementation | `executor` | sonnet |
| Complex refactoring | `executor` (model=opus) | opus |
| Simple bug fix | `debugger` | sonnet |
| Complex debugging | `architect` | opus |
| UI component | `designer` | sonnet |
| Documentation | `writer` | haiku |
| Test strategy | `test-engineer` | sonnet |
| Security review | `security-reviewer` | sonnet |
| Code review | `code-reviewer` | opus |
| Data analysis | `scientist` | sonnet |

### Typical Agent Workflow

```
explore --> analyst --> planner --> critic --> executor --> verifier
(discover)  (analyze)   (sequence)  (review)   (implement)  (confirm)
```

### Agent Role Boundaries

| Agent | Does | Does Not |
|-------|------|----------|
| `architect` | Code analysis, debugging, verification | Requirements gathering, planning |
| `analyst` | Find requirements gaps | Code analysis, planning |
| `planner` | Create task plans | Requirements analysis, plan review |
| `critic` | Review plan quality | Requirements analysis, code analysis |

---

## Skills System

### Overview

Skills are **behavior injections** that modify how the orchestrator operates. Instead of swapping agents, skills add capabilities on top of existing agents. OMC provides 31 skills total (28 user-invocable + 3 internal/pipeline).

### Skill Layers

Skills compose in three layers:

```
┌─────────────────────────────────────────────────────────────┐
│  GUARANTEE LAYER (optional)                                  │
│  ralph: "Cannot stop until verified done"                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  ENHANCEMENT LAYER (0-N skills)                              │
│  ultrawork (parallel) | git-master (commits) | frontend-ui-ux│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  EXECUTION LAYER (primary skill)                             │
│  default (build) | orchestrate (coordinate) | planner (plan) │
└─────────────────────────────────────────────────────────────┘
```

**Formula:** `[Execution Skill] + [0-N Enhancements] + [Optional Guarantee]`

Example:
```
Task: "ultrawork: refactor API with proper commits"
Active skills: ultrawork + default + git-master
```

### How to Invoke Skills

**Slash commands:**
```bash
/oh-my-claudecode:autopilot build me a todo app
/oh-my-claudecode:ralph refactor the auth module
/oh-my-claudecode:team 3:executor "implement fullstack app"
```

**Magic keywords** — include a keyword in natural language and the skill activates automatically:
```bash
autopilot build me a todo app      # activates autopilot
ralph: refactor the auth module    # activates ralph
ultrawork implement OAuth          # activates ultrawork
```

### Core Workflow Skills

#### autopilot
Full autonomous 5-stage pipeline from idea to working code.
- Trigger: `autopilot`, `build me`, `I want a`
```bash
autopilot build me a REST API with authentication
```

#### ralph
Repeating loop that does not stop until work is verified complete. The `verifier` agent confirms completion before the loop exits.
- Trigger: `ralph`, `don't stop`, `must complete`
```bash
ralph: refactor the authentication module
```

#### ultrawork
Maximum parallelism — launches multiple agents simultaneously.
- Trigger: `ultrawork`, `ulw`
```bash
ultrawork implement user authentication with OAuth
```

#### team
Coordinates N Claude agents with a 5-stage pipeline: `plan → prd → exec → verify → fix`
```bash
/oh-my-claudecode:team 3:executor "implement fullstack todo app"
```

#### ccg (Claude-Codex-Gemini)
Fans out to Codex and Gemini simultaneously; Claude synthesizes the results.
- Trigger: `ccg`, `claude-codex-gemini`
```bash
ccg: review this authentication implementation
```

#### ralplan
Iterative planning: Planner, Architect, and Critic loop until they reach consensus.
- Trigger: `ralplan`
```bash
ralplan this feature
```

### Utility Skills

| Skill | Description | Command |
|-------|-------------|---------|
| `cancel` | Cancel active execution mode | `/oh-my-claudecode:cancel` |
| `hud` | Status bar configuration | `/oh-my-claudecode:hud` |
| `omc-setup` | Initial setup wizard | `/oh-my-claudecode:omc-setup` |
| `omc-doctor` | Diagnose installation | `/oh-my-claudecode:omc-doctor` |
| `skillify` | Extract reusable skills from session | `/oh-my-claudecode:skillify` (`learner` deprecated alias) |
| `skill` | Manage local skills (list/add/remove) | `/oh-my-claudecode:skill` |
| `trace` | Evidence-driven causal tracing | `/oh-my-claudecode:trace` |
| `release` | Automated release workflow | `/oh-my-claudecode:release` |
| `deepinit` | Generate hierarchical AGENTS.md | `/oh-my-claudecode:deepinit` |
| `deep-interview` | Socratic deep interview | `/oh-my-claudecode:deep-interview` |
| `sciomc` | Parallel scientist agent orchestration | `/oh-my-claudecode:sciomc` |
| `external-context` | Parallel document-specialist research | `/oh-my-claudecode:external-context` |
| `ai-slop-cleaner` | Clean AI expression patterns | `/oh-my-claudecode:ai-slop-cleaner` |
| `writer-memory` | Memory system for writing projects | `/oh-my-claudecode:writer-memory` |

### Magic Keyword Reference

| Keyword | Effect |
|---------|--------|
| `ultrawork`, `ulw`, `uw` | Parallel agent orchestration |
| `autopilot`, `build me`, `I want a`, `handle it all`, `end to end`, `e2e this` | Autonomous execution pipeline |
| `ralph`, `don't stop`, `must complete`, `until done` | Loop until verified complete |
| `ccg`, `claude-codex-gemini` | 3-model orchestration |
| `ralplan` | Consensus-based planning |
| `deep interview`, `ouroboros` | Socratic deep interview |
| `code review`, `review code` | Comprehensive code review mode |
| `security review`, `review security` | Security-focused review mode |
| `deepsearch`, `search the codebase`, `find in codebase` | Codebase search mode |
| `deepanalyze`, `deep-analyze` | Deep analysis mode |
| `ultrathink`, `think hard`, `think deeply` | Deep reasoning mode |
| `tdd`, `test first`, `red green` | TDD workflow |
| `deslop`, `anti-slop` | AI expression cleanup |
| `cancelomc`, `stopomc` | Cancel active execution mode |

### Keyword Detection Sources

Keywords are processed in two places:

| Source | Role | Customizable |
|--------|------|--------------|
| `config.jsonc` `magicKeywords` | 4 categories (ultrawork, search, analyze, ultrathink) | Yes |
| `keyword-detector` hook | 11+ triggers (autopilot, ralph, ccg, etc.) | No |

The `autopilot`, `ralph`, and `ccg` triggers are hardcoded in the hook and cannot be changed through config.

---

## Hooks

### Overview

Hooks are code that reacts to Claude Code lifecycle events. They run automatically when a user submits a prompt, uses a tool, or starts/ends a session. OMC implements agent delegation, keyword detection, and state persistence through this hook system.

### Lifecycle Events

Claude Code provides 11 lifecycle events. OMC registers hooks on these events:

| Event | When It Fires | OMC Usage |
|-------|---------------|-----------|
| `UserPromptSubmit` | User submits a prompt | Magic keyword detection, skill injection |
| `SessionStart` | Session begins | Initial setup, project memory load |
| `PreToolUse` | Before a tool is used | Permission validation, parallel execution hints |
| `PermissionRequest` | Permission requested | Bash command permission handling |
| `PostToolUse` | After a tool is used | Result validation, project memory update |
| `PostToolUseFailure` | After a tool fails | Error recovery handling |
| `SubagentStart` | Subagent starts | Agent tracking |
| `SubagentStop` | Subagent stops | Agent tracking, output verification |
| `PreCompact` | Before context compaction | Preserve critical information, save project memory |
| `Stop` | Claude is about to stop | Persistent mode enforcement, code simplification |
| `SessionEnd` | Session ends | Session data cleanup |

### system-reminder Injection

Hooks inject additional context to Claude via `<system-reminder>` tags:

```xml
<system-reminder>
hook success: Success
</system-reminder>
```

Injected pattern meanings:

| Pattern | Meaning |
|---------|---------|
| `hook success: Success` | Hook ran normally, continue as planned |
| `hook additional context: ...` | Additional context information, take note |
| `[MAGIC KEYWORD: ...]` | Magic keyword detected, execute indicated skill |
| `The boulder never stops` | ralph/ultrawork mode is active |

### Key Hooks

**keyword-detector** — fires on `UserPromptSubmit`. Detects magic keywords in user input and activates the corresponding skill.

**persistent-mode** — fires on `Stop`. When a persistent mode (ralph, ultrawork) is active, prevents Claude from stopping until work is verified complete.

**pre-compact** — fires on `PreCompact`. Saves critical information to the notepad before the context window is compressed.

**subagent-tracker** — fires on `SubagentStart` and `SubagentStop`. Tracks currently running agents; validates output on stop.

**context-guard-stop** — fires on `Stop`. Monitors context usage and warns when approaching the limit.

**code-simplifier** — fires on `Stop`. Disabled by default. When enabled, automatically simplifies modified files when Claude stops.

Enable via config:
```json
{
  "codeSimplifier": {
    "enabled": true,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
    "maxFiles": 10
  }
}
```

### Hook Registration Structure

OMC hooks are declared in `hooks.json`. Each hook is a Node.js script with a timeout:

```json
{
  "UserPromptSubmit": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "node scripts/keyword-detector.mjs",
          "timeout": 5
        }
      ]
    }
  ]
}
```

- `matcher`: Pattern the hook responds to (`*` matches all input)
- `timeout`: Timeout in seconds
- `type`: Always `"command"` (runs an external command)

### Disabling Hooks

Disable all hooks:
```bash
export DISABLE_OMC=1
```

Skip specific hooks (comma-separated):
```bash
export OMC_SKIP_HOOKS="keyword-detector,persistent-mode"
```

---

## State Management

### Overview

OMC stores task progress and project knowledge in the `.omc/` directory. The state system preserves critical information even when context compaction resets the context window.

### Directory Structure

```
.omc/
├── state/                    # Per-mode state files
│   ├── autopilot-state.json  # autopilot progress
│   ├── ralph-state.json      # ralph loop state
│   ├── team/                 # team task state
│   ├── interop/              # cross-tool task/message envelopes
│   └── sessions/             # per-session state
│       └── {sessionId}/
├── notepad.md                # Compaction-resistant memo pad
├── project-memory.json       # Project knowledge store
├── plans/                    # Execution plans
├── notepads/                 # Per-plan knowledge capture
│   └── {plan-name}/
│       ├── learnings.md
│       ├── decisions.md
│       ├── issues.md
│       └── problems.md
├── prompts/                  # persisted prompt/response artifacts
├── autopilot/                # autopilot artifacts
│   └── spec.md
├── research/                 # Research results
└── logs/                     # Execution logs
```

### Control Plane vs Data Plane

OMC keeps orchestration metadata separate from large durable artifacts:

- **Control plane**: queue state, worker assignment, session state, and cross-tool task/message envelopes under `.omc/state/**`.
- **Data plane**: plans, specs, prompts, results, traces, and other durable artifacts under paths such as `.omc/plans/`, `.omc/notepads/`, `.omc/prompts/`, and `.omc/state/interop/artifacts/**`.
- **Concrete handoff examples**:
  - shared interop state keeps task/message metadata inline while storing oversized task descriptions, task results, and message bodies under `.omc/state/interop/artifacts/**`
  - prompt persistence stores durable prompt/response files under `.omc/prompts/**` and records descriptor metadata alongside job status

**Global State:**
- `~/.omc/state/{name}.json` — user preferences and global config

Legacy locations are auto-migrated on read.

This separation keeps schedulers and status checks small while allowing richer artifacts to remain durable and inspectable.

### Artifact Descriptors and Bounded Handoffs

When a handoff needs to reference a large artifact, prefer a descriptor/handle over pasting the full payload inline. The canonical descriptor shape is:

| Field | Purpose |
|------|---------|
| `kind` | Artifact category (plan, prompt, result, trace, etc.) |
| `path` | Durable path to the artifact |
| `contentHash?` | Optional integrity/checksum hint when available |
| `createdAt` | Creation timestamp |
| `producer` | Owning tool, skill, or worker |
| `sizeBytes?` | Optional payload size for threshold decisions |
| `retention` | Lifecycle hint for cleanup/ownership |
| `expiresAt?` | Optional expiry for short-lived artifacts |

**Bounded handoff rule:**

1. Keep small payloads inline when the call site's explicit threshold allows it.
2. Switch to a descriptor + short human-readable summary when the payload would bloat control-plane state.
3. Preserve ownership/retention metadata with the descriptor so later cleanup and audits remain deterministic.

### Notepad

**File:** `.omc/notepad.md`

The notepad survives context compaction. Content written to it persists even after the context window is reset.

Notes can be saved using the `notepad_write_manual` MCP tool or the `notepad_write_priority` tool for persistent notes.

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `notepad_read` | Read notepad contents |
| `notepad_write_priority` | Write high-priority memo (permanent retention) |
| `notepad_write_working` | Write working memo |
| `notepad_write_manual` | Write manual memo |
| `notepad_prune` | Clean up old memos |
| `notepad_stats` | View notepad statistics |

**How it works:**
1. On `PreCompact` event, important information is saved to the notepad
2. After compaction, notepad contents are re-injected into context
3. Agents use the notepad to recover previous context

### Project Memory

**File:** `.omc/project-memory.json`

Project memory is a persistent store for project-level knowledge. It survives across sessions.

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `project_memory_read` | Read project memory |
| `project_memory_write` | Overwrite entire project memory |
| `project_memory_add_note` | Add a note |
| `project_memory_add_directive` | Add a directive |

**Lifecycle integration:**
- `SessionStart`: Load project memory and inject into context
- `PostToolUse`: Extract project knowledge from tool results and save
- `PreCompact`: Save project memory before context compaction

### Session Scope

**Path:** `.omc/state/sessions/{sessionId}/`

Stores state isolated per session. Multiple sessions on the same project run simultaneously without state conflicts.

### Plan Notepad (Per-Plan Knowledge Capture)

**Path:** `.omc/notepads/{plan-name}/`

Stores learnings from each execution plan separately.

| File | Contents |
|------|----------|
| `learnings.md` | Discovered patterns, successful approaches |
| `decisions.md` | Architecture decisions and rationale |
| `issues.md` | Problems and blockers |
| `problems.md` | Technical debt and cautions |

All entries are timestamped automatically.

### Centralized State (Optional)

By default, state is stored in the project's `.omc/` directory and is deleted when the worktree is removed.

To preserve state across worktree deletions, set the `OMC_STATE_DIR` environment variable:

```bash
# Add to ~/.bashrc or ~/.zshrc
export OMC_STATE_DIR="$HOME/.claude/omc"
```

State is then stored at `~/.claude/omc/{project-identifier}/`. The project identifier is a hash of the Git remote URL, so the same repository shares state across different worktrees.

### Persistent Memory Tags

For critical information, use `<remember>` tags:

```xml
<!-- Retained for 7 days -->
<remember>API endpoint changed to /v2</remember>

<!-- Retained permanently -->
<remember priority>Never access production DB directly</remember>
```

| Tag | Retention |
|-----|-----------|
| `<remember>` | 7 days |
| `<remember priority>` | Permanent |

---

## Verification Protocol

The verification module ensures work completion with evidence:

**Standard Checks:**
- BUILD: Compilation passes
- TEST: All tests pass
- LINT: No linting errors
- FUNCTIONALITY: Feature works as expected
- ARCHITECT: Opus-tier review approval
- TODO: All tasks completed
- ERROR_FREE: No unresolved errors

Evidence must be fresh (within 5 minutes) and include actual command output.

---

## For More Details

- **Complete Reference**: See [REFERENCE.md](./REFERENCE.md)
- **Internal API**: See [FEATURES.md](./FEATURES.md)
- **User Guide**: See [README.md](../README.md)
- **Skills Reference**: See CLAUDE.md in your project
