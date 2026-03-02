# Reference Documentation

Complete reference for oh-my-claudecode. For quick start, see the main [README.md](../README.md).

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Agents (28 Total)](#agents-28-total)
- [Skills (38 Total)](#skills-38-total)
- [Slash Commands](#slash-commands)
- [Hooks System](#hooks-system)
- [Magic Keywords](#magic-keywords)
- [Platform Support](#platform-support)
- [Performance Monitoring](#performance-monitoring)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)

---

## Installation

**Only the Claude Code Plugin method is supported.** Other installation methods (npm, bun, curl) are deprecated and may not work correctly.

### Claude Code Plugin (Required)

```bash
# Step 1: Add the marketplace
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode

# Step 2: Install the plugin
/plugin install oh-my-claudecode
```

This integrates directly with Claude Code's plugin system and uses Node.js hooks.

> **Note**: Direct npm/bun global installs are **not supported**. The plugin system handles all installation and hook setup automatically.

### Requirements

- [Claude Code](https://docs.anthropic.com/claude-code) installed
- One of:
  - **Claude Max/Pro subscription** (recommended for individuals)
  - **Anthropic API key** (`ANTHROPIC_API_KEY` environment variable)

---

## Configuration

### Project-Scoped Configuration (Recommended)

Configure omc for the current project only:

```
/oh-my-claudecode:omc-setup --local
```

- Creates `./.claude/CLAUDE.md` in your current project
- Configuration applies only to this project
- Won't affect other projects or global settings
- **Safe**: Preserves your global CLAUDE.md

### Global Configuration

Configure omc for all Claude Code sessions:

```
/oh-my-claudecode:omc-setup
```

- Creates `~/.claude/CLAUDE.md` globally
- Configuration applies to all projects
- **Warning**: Completely overwrites existing `~/.claude/CLAUDE.md`

### What Configuration Enables

| Feature | Without | With omc Config |
|---------|---------|-----------------|
| Agent delegation | Manual only | Automatic based on task |
| Keyword detection | Disabled | ultrawork, search, analyze |
| Todo continuation | Basic | Enforced completion |
| Model routing | Default | Smart tier selection |
| Skill composition | None | Auto-combines skills |

### Configuration Precedence

If both configurations exist, **project-scoped takes precedence** over global:

```
./.claude/CLAUDE.md  (project)   →  Overrides  →  ~/.claude/CLAUDE.md  (global)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OMC_STATE_DIR` | _(unset)_ | Centralized state directory. When set, OMC stores state at `$OMC_STATE_DIR/{project-id}/` instead of `{worktree}/.omc/`. This preserves state across worktree deletions. The project identifier is derived from the git remote URL (or worktree path for local-only repos). |
| `OMC_BRIDGE_SCRIPT` | _(auto-detected)_ | Path to the Python bridge script |
| `OMC_PARALLEL_EXECUTION` | `true` | Enable/disable parallel agent execution |
| `OMC_CODEX_DEFAULT_MODEL` | _(provider default)_ | Default model for Codex CLI workers |
| `OMC_GEMINI_DEFAULT_MODEL` | _(provider default)_ | Default model for Gemini CLI workers |
| `OMC_LSP_TIMEOUT_MS` | `15000` | Timeout (ms) for LSP requests. Increase for large repos or slow language servers |
| `DISABLE_OMC` | _(unset)_ | Set to any value to disable all OMC hooks |
| `OMC_SKIP_HOOKS` | _(unset)_ | Comma-separated list of hook names to skip |

#### Centralized State with `OMC_STATE_DIR`

By default, OMC stores state in `{worktree}/.omc/`. This is lost when worktrees are deleted. To preserve state across worktree lifecycles, set `OMC_STATE_DIR`:

```bash
# In your shell profile (~/.bashrc, ~/.zshrc, etc.)
export OMC_STATE_DIR="$HOME/.claude/omc"
```

This resolves to `~/.claude/omc/{project-identifier}/` where the project identifier uses a hash of the git remote URL (stable across worktrees/clones) with a fallback to the directory path hash for local-only repos.

If both a legacy `{worktree}/.omc/` directory and a centralized directory exist, OMC logs a notice and uses the centralized directory. You can then migrate data from the legacy directory and remove it.

### When to Re-run Setup

- **First time**: Run after installation (choose project or global)
- **After updates**: Re-run to get the latest configuration
- **Different machines**: Run on each machine where you use Claude Code
- **New projects**: Run `/oh-my-claudecode:omc-setup --local` in each project that needs omc

> **NOTE**: After updating the plugin (via `npm update`, `git pull`, or Claude Code's plugin update), you MUST re-run `/oh-my-claudecode:omc-setup` to apply the latest CLAUDE.md changes.

### Agent Customization

Edit agent files in `~/.claude/agents/` to customize behavior:

```yaml
---
name: architect
description: Your custom description
tools: Read, Grep, Glob, Bash, Edit
model: opus  # or sonnet, haiku
---

Your custom system prompt here...
```

### Project-Level Config

Create `.claude/CLAUDE.md` in your project for project-specific instructions:

```markdown
# Project Context

This is a TypeScript monorepo using:
- Bun runtime
- React for frontend
- PostgreSQL database

## Conventions
- Use functional components
- All API routes in /src/api
- Tests alongside source files
```

### Stop Callback Notification Tags

Configure tags for Telegram/Discord stop callbacks with `omc config-stop-callback`.

```bash
# Set/replace tags
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id> --tag-list "@alice,bob"
omc config-stop-callback discord --enable --webhook <url> --tag-list "@here,123456789012345678,role:987654321098765432"

# Incremental updates
omc config-stop-callback telegram --add-tag charlie
omc config-stop-callback discord --remove-tag @here
omc config-stop-callback discord --clear-tags

# Inspect current callback config
omc config-stop-callback telegram --show
omc config-stop-callback discord --show
```

Tag behavior:
- Telegram: `alice` is normalized to `@alice`
- Discord: supports `@here`, `@everyone`, numeric user IDs (`<@id>`), and role tags (`role:<id>` -> `<@&id>`)
- `file` callbacks ignore tag options

---

## Agents (28 Total)

Always use `oh-my-claudecode:` prefix when calling via Task tool.

### By Domain and Tier

| Domain | LOW (Haiku) | MEDIUM (Sonnet) | HIGH (Opus) |
|--------|-------------|-----------------|-------------|
| **Analysis** | `architect-low` | `architect-medium` | `architect` |
| **Execution** | `executor-low` | `executor` | `executor-high` |
| **Search** | `explore` | - | `explore-high` |
| **Research** | - | `document-specialist` | - |
| **Frontend** | `designer-low` | `designer` | `designer-high` |
| **Docs** | `writer` | - | - |
| **Visual** | - | `vision` | - |
| **Planning** | - | - | `planner` |
| **Critique** | - | - | `critic` |
| **Pre-Planning** | - | - | `analyst` |
| **Testing** | - | `qa-tester` | - |
| **Security** | `security-reviewer-low` | - | `security-reviewer` |
| **Build** | - | `build-fixer` | - |
| **TDD** | - | `test-engineer` | - |
| **Code Review** | - | - | `code-reviewer` |
| **Data Science** | - | `scientist` | `scientist-high` |

### Agent Selection Guide

| Task Type | Best Agent | Model |
|-----------|------------|-------|
| Quick code lookup | `explore` | haiku |
| Find files/patterns | `explore` | haiku |
| Complex architectural search | `explore-high` | opus |
| Simple code change | `executor-low` | haiku |
| Feature implementation | `executor` | sonnet |
| Complex refactoring | `executor-high` | opus |
| Debug simple issue | `architect-low` | haiku |
| Debug complex issue | `architect` | opus |
| UI component | `designer` | sonnet |
| Complex UI system | `designer-high` | opus |
| Write docs/comments | `writer` | haiku |
| Research docs/APIs | `document-specialist` | sonnet |
| Analyze images/diagrams | `vision` | sonnet |
| Strategic planning | `planner` | opus |
| Review/critique plan | `critic` | opus |
| Pre-planning analysis | `analyst` | opus |
| Test CLI interactively | `qa-tester` | sonnet |
| Security review | `security-reviewer` | opus |
| Quick security scan | `security-reviewer-low` | haiku |
| Fix build errors | `build-fixer` | sonnet |
| Simple build fix | `build-fixer` (model=haiku) | haiku |
| TDD workflow | `test-engineer` | sonnet |
| Quick test suggestions | `test-engineer` (model=haiku) | haiku |
| Code review | `code-reviewer` | opus |
| Quick code check | `code-reviewer` (model=haiku) | haiku |
| Data analysis/stats | `scientist` | sonnet |
| Quick data inspection | `scientist` (model=haiku) | haiku |
| Complex ML/hypothesis | `scientist-high` | opus |

---

## Skills (38 Total)

### Core Skills

| Skill | Description | Manual Command |
|-------|-------------|----------------|
| `orchestrate` | Multi-agent orchestration mode | - |
| `autopilot` | Full autonomous execution from idea to working code | `/oh-my-claudecode:autopilot` |
| `ultrawork` | Maximum performance with parallel agents | `/oh-my-claudecode:ultrawork` |
| `ultrapilot` | **Deprecated** — use `autopilot` or `team` instead | `/oh-my-claudecode:ultrapilot` |
| `team` | N coordinated agents on shared task list using native teams | `/oh-my-claudecode:team` |
| `pipeline` | **Deprecated** — use `autopilot` instead | `/oh-my-claudecode:pipeline` |
| `ralph` | Self-referential development until completion | `/oh-my-claudecode:ralph` |
| `ralph-init` | Initialize PRD for structured task tracking | `/oh-my-claudecode:ralph-init` |
| `ultraqa` | Autonomous QA cycling workflow | `/oh-my-claudecode:ultraqa` |
| `plan` | Start planning session (consensus mode uses RALPLAN-DR structured deliberation) | `/oh-my-claudecode:plan` |
| `ralplan` | Iterative planning (Planner+Architect+Critic) with structured deliberation; short mode default, `--deliberate` for high-risk pre-mortem + expanded test plan | `/oh-my-claudecode:ralplan` |
| `deep-interview` | Socratic deep interview with mathematical ambiguity gating (Ouroboros-inspired) | `/oh-my-claudecode:deep-interview` |
| `review` | Review work plans with critic | `/oh-my-claudecode:review` |

### Enhancement Skills

| Skill | Description | Manual Command |
|-------|-------------|----------------|
| `deepinit` | Hierarchical AGENTS.md codebase documentation | `/oh-my-claudecode:deepinit` |
| `deepsearch` | Thorough multi-strategy codebase search | `/oh-my-claudecode:deepsearch` |
| `analyze` | Deep analysis and investigation | `/oh-my-claudecode:analyze` |
| `sciomc` | Parallel scientist orchestration | `/oh-my-claudecode:sciomc` |
| `frontend-ui-ux` | Designer-turned-developer UI/UX expertise | (silent activation) |
| `git-master` | Git expert for atomic commits and history | (silent activation) |
| `tdd` | TDD enforcement: test-first development | `/oh-my-claudecode:tdd` |
| `learner` | Extract reusable skill from session | `/oh-my-claudecode:learner` |
| `build-fix` | Fix build and TypeScript errors | `/oh-my-claudecode:build-fix` |
| `code-review` | Comprehensive code review | `/oh-my-claudecode:code-review` |
| `security-review` | Security vulnerability detection | `/oh-my-claudecode:security-review` |

### Utility Skills

| Skill | Description | Manual Command |
|-------|-------------|----------------|
| `note` | Save notes to compaction-resilient notepad | `/oh-my-claudecode:note` |
| `cancel` | Unified cancellation for all modes | `/oh-my-claudecode:cancel` |
| `omc-setup` | One-time setup wizard | `/oh-my-claudecode:omc-setup` |
| `omc-doctor` | Diagnose and fix installation issues | `/oh-my-claudecode:omc-doctor` |
| `omc-help` | Show OMC usage guide | `/oh-my-claudecode:omc-help` |
| `hud` | Configure HUD statusline | `/oh-my-claudecode:hud` |
| `release` | Automated release workflow | `/oh-my-claudecode:release` |
| `mcp-setup` | Configure MCP servers | `/oh-my-claudecode:mcp-setup` |
| `writer-memory` | Agentic memory system for writers | `/oh-my-claudecode:writer-memory` |
| `project-session-manager` | Manage isolated dev environments (git worktrees + tmux) | `/oh-my-claudecode:project-session-manager` |
| `psm` | **Deprecated** compatibility alias for `project-session-manager` | `/oh-my-claudecode:psm` |
| `skill` | Manage local skills (list, add, remove, search, edit) | `/oh-my-claudecode:skill` |

---

## Slash Commands

All skills are available as slash commands with the prefix `/oh-my-claudecode:`.

| Command | Description |
|---------|-------------|
| `/oh-my-claudecode:orchestrate <task>` | Activate multi-agent orchestration mode |
| `/oh-my-claudecode:autopilot <task>` | Full autonomous execution |
| `/oh-my-claudecode:ultrawork <task>` | Maximum performance mode with parallel agents |
| `/oh-my-claudecode:ultrapilot <task>` | **Deprecated** — redirects to `autopilot` or `team` |
| `/oh-my-claudecode:team <N>:<agent> <task>` | Coordinated native team workflow |
| `/oh-my-claudecode:pipeline <stages>` | **Deprecated** — redirects to `autopilot` |
| `/oh-my-claudecode:ralph-init <task>` | Initialize PRD for structured task tracking |
| `/oh-my-claudecode:ralph <task>` | Self-referential loop until task completion |
| `/oh-my-claudecode:ultraqa <goal>` | Autonomous QA cycling workflow |
| `/oh-my-claudecode:plan <description>` | Start planning session (supports consensus structured deliberation) |
| `/oh-my-claudecode:ralplan <description>` | Iterative planning with consensus structured deliberation (`--deliberate` for high-risk mode) |
| `/oh-my-claudecode:deep-interview <idea>` | Socratic interview with ambiguity scoring before execution |
| `/oh-my-claudecode:review [plan-path]` | Review a plan with critic |
| `/oh-my-claudecode:deepsearch <query>` | Thorough multi-strategy codebase search |
| `/oh-my-claudecode:deepinit [path]` | Index codebase with hierarchical AGENTS.md files |
| `/oh-my-claudecode:analyze <target>` | Deep analysis and investigation |
| `/oh-my-claudecode:sciomc <topic>` | Parallel research orchestration |
| `/oh-my-claudecode:tdd <feature>` | TDD workflow enforcement |
| `/oh-my-claudecode:learner` | Extract reusable skill from session |
| `/oh-my-claudecode:note <content>` | Save notes to notepad.md |
| `/oh-my-claudecode:cancel` | Unified cancellation |
| `/oh-my-claudecode:omc-setup` | One-time setup wizard |
| `/oh-my-claudecode:omc-doctor` | Diagnose and fix installation issues |
| `/oh-my-claudecode:omc-help` | Show OMC usage guide |
| `/oh-my-claudecode:hud` | Configure HUD statusline |
| `/oh-my-claudecode:release` | Automated release workflow |
| `/oh-my-claudecode:mcp-setup` | Configure MCP servers |
| `/oh-my-claudecode:psm <arguments>` | Deprecated alias for project session manager |

---

## Hooks System

Oh-my-claudecode includes 31 lifecycle hooks that enhance Claude Code's behavior.

### Execution Mode Hooks

| Hook | Description |
|------|-------------|
| `autopilot` | Full autonomous execution from idea to working code |
| `ultrawork` | Maximum parallel agent execution |
| `ralph` | Persistence until verified complete |
| `team-pipeline` | Native team staged pipeline orchestration |
| `ultraqa` | QA cycling until goal met |
| `mode-registry` | Tracks active execution mode state (including team/ralph/ultrawork/ralplan) |
| `persistent-mode` | Maintains mode state across sessions |

### Core Hooks

| Hook | Description |
|------|-------------|
| `rules-injector` | Dynamic rules injection with YAML frontmatter parsing |
| `omc-orchestrator` | Enforces orchestrator behavior and delegation |
| `auto-slash-command` | Automatic slash command detection and execution |
| `keyword-detector` | Magic keyword detection (ultrawork, ralph, etc.) |
| `todo-continuation` | Ensures todo list completion |
| `notepad` | Compaction-resilient memory system |
| `learner` | Skill extraction from conversations |

### Context & Recovery

| Hook | Description |
|------|-------------|
| `recovery` | Edit error, session, and context window recovery |
| `preemptive-compaction` | Context usage monitoring to prevent limits |
| `pre-compact` | Pre-compaction processing |
| `directory-readme-injector` | README context injection |

### Quality & Validation

| Hook | Description |
|------|-------------|
| `comment-checker` | BDD detection and directive filtering |
| `thinking-block-validator` | Extended thinking validation |
| `empty-message-sanitizer` | Empty message handling |
| `permission-handler` | Permission requests and validation |
| `think-mode` | Extended thinking detection |
| `code-simplifier` | Auto-simplify recently modified files on Stop (opt-in) |

### Code Simplifier Hook

The `code-simplifier` Stop hook automatically delegates recently modified source files to the
`code-simplifier` agent after each Claude turn. It is **disabled by default** and must be
explicitly enabled via `~/.omc/config.json`.

**Enable:**
```json
{
  "codeSimplifier": {
    "enabled": true
  }
}
```

**Full config options:**
```json
{
  "codeSimplifier": {
    "enabled": true,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
    "maxFiles": 10
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Opt-in to automatic simplification |
| `extensions` | `string[]` | `[".ts",".tsx",".js",".jsx",".py",".go",".rs"]` | File extensions to consider |
| `maxFiles` | `number` | `10` | Maximum files simplified per turn |

**How it works:**
1. When Claude stops, the hook runs `git diff HEAD --name-only` to find modified files
2. If modified source files are found, the hook injects a message asking Claude to delegate to the `code-simplifier` agent
3. The agent simplifies the files for clarity and consistency without changing behavior
4. A turn-scoped marker prevents the hook from triggering more than once per turn cycle

### Coordination & Environment

| Hook | Description |
|------|-------------|
| `subagent-tracker` | Tracks spawned sub-agents |
| `session-end` | Session termination handling |
| `non-interactive-env` | CI/non-interactive environment handling |
| `agent-usage-reminder` | Reminder to use specialized agents |
| `background-notification` | Background task completion notifications |
| `plugin-patterns` | Plugin pattern detection |
| `setup` | Initial setup and configuration |

---

## Magic Keywords

Just include these words anywhere in your prompt to activate enhanced modes:

| Keyword | Effect |
|---------|--------|
| `ultrawork`, `ulw`, `uw` | Activates parallel agent orchestration |
| `eco`, `efficient`, `save-tokens`, `budget` | Token-efficient parallel execution |
| `autopilot`, `build me`, `I want a` | Full autonomous execution |
| `ralph`, `don't stop`, `must complete` | Persistence until verified complete |
| `plan this`, `plan the` | Planning interview workflow |
| `ralplan` | Iterative planning consensus with structured deliberation (`--deliberate` for high-risk mode) |
| `deep interview`, `ouroboros` | Deep Socratic interview with mathematical clarity gating |
| `search`, `find`, `locate` | Enhanced search mode |
| `analyze`, `investigate`, `debug` | Deep analysis mode |
| `sciomc` | Parallel research orchestration |
| `tdd`, `test first`, `red green` | TDD workflow enforcement |
| `stop`, `cancel`, `abort` | Unified cancellation |

### Examples

```bash
# In Claude Code:

# Maximum parallelism
ultrawork implement user authentication with OAuth

# Token-efficient parallelism
eco fix all TypeScript errors

# Enhanced search
find all files that import the utils module

# Deep analysis
analyze why the tests are failing

# Autonomous execution
autopilot: build a todo app with React

# Parallel autopilot
ultrapilot: build a fullstack todo app

# Persistence mode
ralph: refactor the authentication module

# Planning session
plan this feature

# TDD workflow
tdd: implement password validation

# Coordinated team agents
team 5:executor fix all lint errors
```

---

## Platform Support

### Operating Systems

| Platform | Install Method | Hook Type |
|----------|---------------|-----------|
| **Windows** | WSL2 recommended (see note) | Node.js (.mjs) |
| **macOS** | curl or npm | Bash (.sh) |
| **Linux** | curl or npm | Bash (.sh) |

> **Note**: Bash hooks are fully portable across macOS and Linux (no GNU-specific dependencies).

> **Windows**: Native Windows (win32) support is experimental. OMC requires tmux, which is not available on native Windows. **WSL2 is strongly recommended** for Windows users. See the [WSL2 installation guide](https://learn.microsoft.com/en-us/windows/wsl/install). Native Windows issues may have limited support.

> **Advanced**: Set `OMC_USE_NODE_HOOKS=1` to use Node.js hooks on macOS/Linux.

### Available Tools

| Tool | Status | Description |
|------|--------|-------------|
| **Read** | ✅ Available | Read files |
| **Write** | ✅ Available | Create files |
| **Edit** | ✅ Available | Modify files |
| **Bash** | ✅ Available | Run shell commands |
| **Glob** | ✅ Available | Find files by pattern |
| **Grep** | ✅ Available | Search file contents |
| **WebSearch** | ✅ Available | Search the web |
| **WebFetch** | ✅ Available | Fetch web pages |
| **Task** | ✅ Available | Spawn subagents |
| **TodoWrite** | ✅ Available | Track tasks |

### LSP Tools (Real Implementation)

| Tool | Status | Description |
|------|--------|-------------|
| `lsp_hover` | ✅ Implemented | Get type info and documentation at position |
| `lsp_goto_definition` | ✅ Implemented | Jump to symbol definition |
| `lsp_find_references` | ✅ Implemented | Find all usages of a symbol |
| `lsp_document_symbols` | ✅ Implemented | Get file outline (functions, classes, etc.) |
| `lsp_workspace_symbols` | ✅ Implemented | Search symbols across workspace |
| `lsp_diagnostics` | ✅ Implemented | Get errors, warnings, hints |
| `lsp_prepare_rename` | ✅ Implemented | Check if rename is valid |
| `lsp_rename` | ✅ Implemented | Rename symbol across project |
| `lsp_code_actions` | ✅ Implemented | Get available refactorings |
| `lsp_code_action_resolve` | ✅ Implemented | Get details of a code action |
| `lsp_servers` | ✅ Implemented | List available language servers |
| `lsp_diagnostics_directory` | ✅ Implemented | Project-level type checking |

> **Note**: LSP tools require language servers to be installed (typescript-language-server, pylsp, rust-analyzer, gopls, etc.). Use `lsp_servers` to check installation status.

### AST Tools (ast-grep Integration)

| Tool | Status | Description |
|------|--------|-------------|
| `ast_grep_search` | ✅ Implemented | Pattern-based code search using AST matching |
| `ast_grep_replace` | ✅ Implemented | Pattern-based code transformation |

> **Note**: AST tools use [@ast-grep/napi](https://ast-grep.github.io/) for structural code matching. Supports meta-variables like `$VAR` (single node) and `$$$` (multiple nodes).

---

## Performance Monitoring

oh-my-claudecode includes comprehensive monitoring for agent performance, token usage, and debugging parallel workflows.

For complete documentation, see **[Performance Monitoring Guide](./PERFORMANCE-MONITORING.md)**.

### Quick Overview

| Feature | Description | Access |
|---------|-------------|--------|
| **Agent Observatory** | Real-time agent status, efficiency, bottlenecks | HUD / API |
| **Token Analytics** | Cost tracking, usage reports, budget warnings | `omc stats`, `omc cost` |
| **Session Replay** | Event timeline for post-session analysis | `.omc/state/agent-replay-*.jsonl` |
| **Intervention System** | Auto-detection of stale agents, cost overruns | Automatic |

### CLI Commands

```bash
omc stats          # Current session statistics
omc cost daily     # Daily cost report
omc cost weekly    # Weekly cost report
omc agents         # Agent breakdown
omc backfill       # Import historical transcript data
```

### HUD Analytics Preset

Enable detailed cost tracking in your status line:

```json
{
  "omcHud": {
    "preset": "analytics"
  }
}
```

### External Resources

- **[MarginLab.ai](https://marginlab.ai)** - SWE-Bench-Pro performance tracking with statistical significance testing for detecting Claude model degradation

---

## Troubleshooting

### Diagnose Installation Issues

```bash
/oh-my-claudecode:omc-doctor
```

Checks for:
- Missing dependencies
- Configuration errors
- Hook installation status
- Agent availability
- Skill registration

### Configure HUD Statusline

```bash
/oh-my-claudecode:hud setup
```

Installs or repairs the HUD statusline for real-time status updates.

### HUD Configuration (settings.json)

Configure HUD elements in `~/.claude/settings.json`:

```json
{
  "omcHud": {
    "preset": "focused",
    "elements": {
      "cwd": true,
      "gitRepo": true,
      "gitBranch": true
    }
  }
}
```

| Element | Description | Default |
|---------|-------------|---------|
| `cwd` | Show current working directory | `false` |
| `gitRepo` | Show git repository name | `false` |
| `gitBranch` | Show current git branch | `false` |
| `omcLabel` | Show [OMC] label | `true` |
| `contextBar` | Show context window usage | `true` |
| `agents` | Show active agents count | `true` |
| `todos` | Show todo progress | `true` |
| `ralph` | Show ralph loop status | `true` |
| `autopilot` | Show autopilot status | `true` |

Available presets: `minimal`, `focused`, `full`, `dense`, `analytics`, `opencode`

### Common Issues

| Issue | Solution |
|-------|----------|
| Commands not found | Re-run `/oh-my-claudecode:omc-setup` |
| Hooks not executing | Check hook permissions: `chmod +x ~/.claude/hooks/**/*.sh` |
| Agents not delegating | Verify CLAUDE.md is loaded: check `./.claude/CLAUDE.md` or `~/.claude/CLAUDE.md` |
| LSP tools not working | Install language servers: `npm install -g typescript-language-server` |
| Token limit errors | Use `/oh-my-claudecode:` for token-efficient execution |

### Auto-Update

Oh-my-claudecode includes a silent auto-update system that checks for updates in the background.

Features:
- **Rate-limited**: Checks at most once every 24 hours
- **Concurrent-safe**: Lock file prevents simultaneous update attempts
- **Cross-platform**: Works on both macOS and Linux

To manually update, re-run the plugin install command or use Claude Code's built-in update mechanism.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/scripts/uninstall.sh | bash
```

Or manually:

```bash
rm ~/.claude/agents/{architect,document-specialist,explore,designer,writer,vision,critic,analyst,executor,qa-tester}.md
rm ~/.claude/commands/{analyze,autopilot,deepsearch,plan,review,ultrawork}.md
```

---

## Changelog

See [CHANGELOG.md](../CHANGELOG.md) for version history and release notes.

---

## License

MIT - see [LICENSE](../LICENSE)

## Credits

Inspired by [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by code-yeongyu.
