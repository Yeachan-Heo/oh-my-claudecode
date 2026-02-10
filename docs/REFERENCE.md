# Reference Documentation

Complete reference for oh-my-claudecode. For quick start, see the main [README.md](../README.md).

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Agents (28 Total)](#agents-28-total)
- [Skills (37 Total)](#skills-37-total)
- [Slash Commands](#slash-commands)
- [Hooks System](#hooks-system)
- [Magic Keywords](#magic-keywords)
- [MCP Path Boundary Rules](#mcp-path-boundary-rules)
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
/oh-my-claudecode:omc-setup
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

---

## Agents (28 Total)

Always use `oh-my-claudecode:` prefix when calling via Task tool.

### By Domain and Tier

| Domain | LOW (Haiku) | MEDIUM (Sonnet) | HIGH (Opus) |
|--------|-------------|-----------------|-------------|
| **Analysis** | `architect-low` | `architect-medium` | `architect` |
| **Execution** | `executor-low` | `executor` | `executor-high` |
| **Search** | `explore` | - | `explore-high` |
| **Research** | - | `researcher` | - |
| **Frontend** | `designer-low` | `designer` | `designer-high` |
| **Docs** | `writer` | - | - |
| **Visual** | - | `vision` | - |
| **Planning** | - | - | `planner` |
| **Critique** | - | - | `critic` |
| **Pre-Planning** | - | - | `analyst` |
| **Testing** | - | `qa-tester` | - |
| **Security** | `security-reviewer-low` | - | `security-reviewer` |
| **Build** | - | `build-fixer` | - |
| **TDD** | `tdd-guide-low` | `tdd-guide` | - |
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
| Research docs/APIs | `researcher` | sonnet |
| Analyze images/diagrams | `vision` | sonnet |
| Strategic planning | `planner` | opus |
| Review/critique plan | `critic` | opus |
| Pre-planning analysis | `analyst` | opus |
| Test CLI interactively | `qa-tester` | sonnet |
| Security review | `security-reviewer` | opus |
| Quick security scan | `security-reviewer-low` | haiku |
| Fix build errors | `build-fixer` | sonnet |
| Simple build fix | `build-fixer` (model=haiku) | haiku |
| TDD workflow | `tdd-guide` | sonnet |
| Quick test suggestions | `tdd-guide-low` | haiku |
| Code review | `code-reviewer` | opus |
| Quick code check | `code-reviewer` (model=haiku) | haiku |
| Data analysis/stats | `scientist` | sonnet |
| Quick data inspection | `scientist` (model=haiku) | haiku |
| Complex ML/hypothesis | `scientist-high` | opus |

---

## Skills (37 Total)

### Core Skills

| Skill | Description | Manual Command |
|-------|-------------|----------------|
| `orchestrate` | Multi-agent orchestration mode | - |
| `autopilot` | Full autonomous execution from idea to working code | `/oh-my-claudecode:autopilot` |
| `ultrawork` | Maximum performance with parallel agents | `/oh-my-claudecode:ultrawork` |
| `ultrapilot` | Parallel autopilot with 3-5x speedup | `/oh-my-claudecode:ultrapilot` |
| `swarm` | N coordinated agents with task claiming | `/oh-my-claudecode:swarm` |
| `pipeline` | Sequential agent chaining | `/oh-my-claudecode:pipeline` |
| `ecomode` | Token-efficient parallel execution | `/oh-my-claudecode:ecomode` |
| `ralph` | Self-referential development until completion | `/oh-my-claudecode:ralph` |
| `ralph-init` | Initialize PRD for structured task tracking | `/oh-my-claudecode:ralph-init` |
| `ultraqa` | Autonomous QA cycling workflow | `/oh-my-claudecode:ultraqa` |
| `plan` | Start planning session | `/oh-my-claudecode:plan` |
| `ralplan` | Iterative planning (Planner+Architect+Critic) | `/oh-my-claudecode:ralplan` |
| `review` | Review work plans with critic | `/oh-my-claudecode:review` |

### Enhancement Skills

| Skill | Description | Manual Command |
|-------|-------------|----------------|
| `deepinit` | Hierarchical AGENTS.md codebase documentation | `/oh-my-claudecode:deepinit` |
| `deepsearch` | Thorough multi-strategy codebase search | `/oh-my-claudecode:deepsearch` |
| `analyze` | Deep analysis and investigation | `/oh-my-claudecode:analyze` |
| `research` | Parallel scientist orchestration | `/oh-my-claudecode:research` |
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
| `doctor` | Diagnose and fix installation issues | `/oh-my-claudecode:doctor` |
| `help` | Show OMC usage guide | `/oh-my-claudecode:help` |
| `hud` | Configure HUD statusline | `/oh-my-claudecode:hud` |
| `release` | Automated release workflow | `/oh-my-claudecode:release` |
| `mcp-setup` | Configure MCP servers | `/oh-my-claudecode:mcp-setup` |
| `writer-memory` | Agentic memory system for writers | `/oh-my-claudecode:writer-memory` |
| `project-session-manager` | Manage isolated dev environments (git worktrees + tmux) | `/oh-my-claudecode:project-session-manager` |
| `skill` | Manage local skills (list, add, remove, search, edit) | `/oh-my-claudecode:skill` |

---

## Slash Commands

All skills are available as slash commands with the prefix `/oh-my-claudecode:`.

| Command | Description |
|---------|-------------|
| `/oh-my-claudecode:orchestrate <task>` | Activate multi-agent orchestration mode |
| `/oh-my-claudecode:autopilot <task>` | Full autonomous execution |
| `/oh-my-claudecode:ultrawork <task>` | Maximum performance mode with parallel agents |
| `/oh-my-claudecode:ultrapilot <task>` | Parallel autopilot (3-5x faster) |
| `/oh-my-claudecode:swarm <N>:<agent> <task>` | Coordinated agent swarm |
| `/oh-my-claudecode:pipeline <stages>` | Sequential agent chaining |
| `/oh-my-claudecode:ecomode <task>` | Token-efficient parallel execution |
| `/oh-my-claudecode:ralph-init <task>` | Initialize PRD for structured task tracking |
| `/oh-my-claudecode:ralph <task>` | Self-referential loop until task completion |
| `/oh-my-claudecode:ultraqa <goal>` | Autonomous QA cycling workflow |
| `/oh-my-claudecode:plan <description>` | Start planning session |
| `/oh-my-claudecode:ralplan <description>` | Iterative planning with consensus |
| `/oh-my-claudecode:review [plan-path]` | Review a plan with critic |
| `/oh-my-claudecode:deepsearch <query>` | Thorough multi-strategy codebase search |
| `/oh-my-claudecode:deepinit [path]` | Index codebase with hierarchical AGENTS.md files |
| `/oh-my-claudecode:analyze <target>` | Deep analysis and investigation |
| `/oh-my-claudecode:research <topic>` | Parallel research orchestration |
| `/oh-my-claudecode:tdd <feature>` | TDD workflow enforcement |
| `/oh-my-claudecode:learner` | Extract reusable skill from session |
| `/oh-my-claudecode:note <content>` | Save notes to notepad.md |
| `/oh-my-claudecode:cancel` | Unified cancellation |
| `/oh-my-claudecode:omc-setup` | One-time setup wizard |
| `/oh-my-claudecode:doctor` | Diagnose and fix installation issues |
| `/oh-my-claudecode:help` | Show OMC usage guide |
| `/oh-my-claudecode:hud` | Configure HUD statusline |
| `/oh-my-claudecode:release` | Automated release workflow |
| `/oh-my-claudecode:mcp-setup` | Configure MCP servers |

---

## Hooks System

Oh-my-claudecode includes 31 lifecycle hooks that enhance Claude Code's behavior.

### Execution Mode Hooks

| Hook | Description |
|------|-------------|
| `autopilot` | Full autonomous execution from idea to working code |
| `ultrawork` | Maximum parallel agent execution |
| `ralph` | Persistence until verified complete |
| `ultrapilot` | Parallel autopilot with file ownership |
| `ultraqa` | QA cycling until goal met |
| `swarm` | Coordinated multi-agent with SQLite task claiming |
| `mode-registry` | Tracks active execution mode (incl. ecomode) |
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
| `ecomode`, `eco`, `efficient`, `save-tokens`, `budget` | Token-efficient parallel execution |
| `autopilot`, `build me`, `I want a` | Full autonomous execution |
| `ultrapilot`, `parallel build`, `swarm build` | Parallel autopilot (3-5x faster) |
| `ralph`, `don't stop`, `must complete` | Persistence until verified complete |
| `plan this`, `plan the` | Planning interview workflow |
| `ralplan` | Iterative planning consensus |
| `search`, `find`, `locate` | Enhanced search mode |
| `analyze`, `investigate`, `debug` | Deep analysis mode |
| `research`, `analyze data`, `statistics` | Parallel research orchestration |
| `tdd`, `test first`, `red green` | TDD workflow enforcement |
| `swarm N agents` | Coordinated agent swarm |
| `pipeline`, `chain agents` | Sequential agent chaining |
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

# Coordinated swarm
swarm 5 agents: fix all lint errors

# Agent chaining
pipeline: analyze → fix → test this bug
```

---

## MCP Path Boundary Rules

The MCP tools (`ask_codex`, `ask_gemini`) enforce strict path boundaries for security. Both `prompt_file` and `output_file` are resolved relative to `working_directory`.

### Default Behavior (Strict Mode)

By default, both files must reside within the `working_directory`:

| Parameter | Requirement |
|-----------|-------------|
| `prompt_file` | Must be within `working_directory` (after symlink resolution) |
| `output_file` | Must be within `working_directory` (after symlink resolution) |
| `working_directory` | Must be within the project worktree (unless bypassed) |

### Environment Variable Overrides

| Variable | Values | Description |
|----------|--------|-------------|
| `OMC_MCP_OUTPUT_PATH_POLICY` | `strict` (default), `redirect_output` | Controls output file path enforcement |
| `OMC_MCP_OUTPUT_REDIRECT_DIR` | Path (default: `.omc/outputs`) | Directory for redirected outputs when policy is `redirect_output` |
| `OMC_MCP_ALLOW_EXTERNAL_PROMPT` | `0` (default), `1` | Allow prompt files outside working directory |
| `OMC_ALLOW_EXTERNAL_WORKDIR` | unset (default), `1` | Allow working_directory outside project worktree |

### Policy Descriptions

**`OMC_MCP_OUTPUT_PATH_POLICY=strict` (Default)**
- Output files must be within `working_directory`
- Attempts to write outside the boundary fail with `E_PATH_OUTSIDE_WORKDIR_OUTPUT`
- Most secure option - recommended for production

**`OMC_MCP_OUTPUT_PATH_POLICY=redirect_output`**
- Output files are automatically redirected to `OMC_MCP_OUTPUT_REDIRECT_DIR`
- Only the filename is preserved; directory structure is flattened
- Useful when you want to collect all outputs in a single location
- Logs redirection at `[MCP Config]` level

**`OMC_MCP_ALLOW_EXTERNAL_PROMPT=1`**
- Allows reading prompt files from outside `working_directory`
- **Security Warning**: Enables reading arbitrary files on the filesystem
- Use only in trusted environments

**`OMC_ALLOW_EXTERNAL_WORKDIR=1`**
- Allows `working_directory` to be outside the project worktree
- Bypasses the worktree boundary check
- Use when running MCP tools against external projects

### Error Tokens

| Token | Meaning |
|-------|---------|
| `E_PATH_OUTSIDE_WORKDIR_PROMPT` | prompt_file is outside working_directory |
| `E_PATH_OUTSIDE_WORKDIR_OUTPUT` | output_file is outside working_directory |
| `E_PATH_RESOLUTION_FAILED` | Failed to resolve symlink or directory |
| `E_WRITE_FAILED` | Failed to write output file (I/O error) |
| `E_WORKDIR_INVALID` | working_directory does not exist or is inaccessible |

### Example Valid/Invalid Patterns

**Valid paths (working_directory: `/home/user/project`)**
```
prompt.txt                    -> /home/user/project/prompt.txt
./prompts/task.md             -> /home/user/project/prompts/task.md
../project/output.txt         -> /home/user/project/output.txt (resolves inside)
.omc/outputs/response.md      -> /home/user/project/.omc/outputs/response.md
```

**Invalid paths (working_directory: `/home/user/project`)**
```
/etc/passwd                   -> Outside working directory (absolute)
../../etc/shadow              -> Outside working directory (traverses too far)
/tmp/output.txt               -> Outside working directory (different root)
```

### Troubleshooting Matrix

| Symptom | Cause | Fix |
|---------|-------|-----|
| `E_PATH_OUTSIDE_WORKDIR_PROMPT` error | prompt_file outside working_directory | Move file to working directory or change working_directory to a common ancestor |
| `E_PATH_OUTSIDE_WORKDIR_OUTPUT` error | output_file outside working_directory | Use relative path within working directory, or set `OMC_MCP_OUTPUT_PATH_POLICY=redirect_output` |
| `E_PATH_RESOLUTION_FAILED` error | Symlink resolution failed or directory inaccessible | Ensure target directory exists and is accessible |
| `E_WRITE_FAILED` error | I/O error (permissions, disk full) | Check file permissions and disk space |
| `working_directory is outside the project worktree` | working_directory not within git worktree | Set `OMC_ALLOW_EXTERNAL_WORKDIR=1` or use a working directory inside the project |
| Output file not where expected | `redirect_output` policy active | Check `OMC_MCP_OUTPUT_REDIRECT_DIR` (default: `.omc/outputs`) |

---

## Platform Support

### Operating Systems

| Platform | Install Method | Hook Type |
|----------|---------------|-----------|
| **Windows** | `npm install -g` | Node.js (.mjs) |
| **macOS** | curl or npm | Bash (.sh) |
| **Linux** | curl or npm | Bash (.sh) |

> **Note**: Bash hooks are fully portable across macOS and Linux (no GNU-specific dependencies).

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
/oh-my-claudecode:doctor
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
| Token limit errors | Use `/oh-my-claudecode:ecomode` for token-efficient execution |

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
rm ~/.claude/agents/{architect,researcher,explore,designer,writer,vision,critic,analyst,executor,qa-tester}.md
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
