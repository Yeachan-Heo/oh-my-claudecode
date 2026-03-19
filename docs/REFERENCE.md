# Reference Documentation

Quick-reference cheat-sheet for oh-my-claudecode. For detailed documentation, see the focused guides linked below.

| Guide | What it covers |
|-------|----------------|
| [GETTING-STARTED.md](./GETTING-STARTED.md) | Installation, first session, configuration |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Agents, skills, hooks, state management |
| [HOOKS.md](./HOOKS.md) | Hook system, lifecycle events, magic keywords |
| [TOOLS.md](./TOOLS.md) | MCP tools (state, notepad, LSP, AST grep, Python REPL) |

For quick start, see the main [README.md](../README.md).

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [CLI Commands: ask/team/session](#cli-commands-askteamsession)
- [Legacy MCP Team Runtime Tools (Deprecated)](#legacy-mcp-team-runtime-tools-deprecated)
- [Agents](#agents)
- [Skills](#skills)
- [Slash Commands](#slash-commands)
- [Hooks System](#hooks-system)
- [Magic Keywords](#magic-keywords)
- [Platform Support](#platform-support)
- [Performance Monitoring](#performance-monitoring)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)

---

## Installation

**Only the Claude Code Plugin method is supported.**

```bash
# Step 1: Add the marketplace
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode

# Step 2: Install the plugin
/plugin install oh-my-claudecode

# Step 3: Run setup
/oh-my-claudecode:omc-setup
```

**Requirements:** Claude Code + Claude Max/Pro subscription or `ANTHROPIC_API_KEY`.

> For full installation steps, platform notes, and verification, see [GETTING-STARTED.md](./GETTING-STARTED.md).

---

## Configuration

| Scope | Command | File |
|-------|---------|------|
| Project (recommended) | `/oh-my-claudecode:omc-setup --local` | `./.claude/CLAUDE.md` |
| Global | `/oh-my-claudecode:omc-setup` | `~/.claude/CLAUDE.md` |

**Configuration precedence:** Defaults → User config → Project config → Environment variables

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OMC_STATE_DIR` | _(unset)_ | Centralized state directory; preserves state across worktree deletions |
| `OMC_PARALLEL_EXECUTION` | `true` | Enable/disable parallel agent execution |
| `OMC_LSP_TIMEOUT_MS` | `15000` | LSP request timeout in ms |
| `DISABLE_OMC` | _(unset)_ | Set to any value to disable all OMC hooks |
| `OMC_SKIP_HOOKS` | _(unset)_ | Comma-separated list of hook names to skip |
| `OMC_BRIDGE_SCRIPT` | _(auto-detected)_ | Path to the Python bridge script |
| `OMC_CODEX_DEFAULT_MODEL` | _(provider default)_ | Default model for Codex CLI workers |
| `OMC_GEMINI_DEFAULT_MODEL` | _(provider default)_ | Default model for Gemini CLI workers |

#### Centralized State

```bash
# In ~/.bashrc or ~/.zshrc
export OMC_STATE_DIR="$HOME/.claude/omc"
```

State is stored at `~/.claude/omc/{project-identifier}/` (hash of git remote URL).

### Agent Model Overrides

```jsonc
// .claude/omc.jsonc
{
  "agents": {
    "explore": { "model": "sonnet" },
    "executor": { "model": "opus" },
    "writer": { "model": "haiku" }
  }
}
```

### Stop Callback Notifications

```bash
omc config-stop-callback telegram --enable --token <bot_token> --chat <chat_id>
omc config-stop-callback discord --enable --webhook <url>
omc config-stop-callback telegram --add-tag alice
omc config-stop-callback discord --show
```

> For full configuration options (model routing, magic keyword customization, CLAUDE.md setup), see [GETTING-STARTED.md](./GETTING-STARTED.md).

---

## CLI Commands: ask/team/session

### `omc ask`

```bash
omc ask claude "review this patch"
omc ask codex "review from a security perspective"
omc ask gemini --prompt "suggest UX improvements"
omc ask claude --agent-prompt executor --prompt "create an implementation plan"
```

- Provider matrix: `claude | codex | gemini`
- Artifacts: `.omc/artifacts/ask/{provider}-{slug}-{timestamp}.md`
- Skill shortcuts: `/oh-my-claudecode:ask-codex` and `/oh-my-claudecode:ask-gemini`

### `omc team` (CLI runtime surface)

```bash
omc team 2:codex "review auth flow"
omc team status review-auth-flow
omc team shutdown review-auth-flow --force
omc team api claim-task --input '{"team_name":"auth-review","task_id":"1","worker":"worker-1"}' --json
```

Supported entrypoints: direct start, `status`, `shutdown`, `api`.

### `omc session search`

```bash
omc session search "team leader stale"
omc session search notify-hook --since 7d
omc session search provider-routing --project all --json
```

- Defaults to current project scope; `--project all` searches all local transcripts
- Supports `--limit`, `--session`, `--since`, `--context`, `--case-sensitive`, `--json`
- MCP surface: `session_search`

---

## Legacy MCP Team Runtime Tools (Deprecated)

The Team MCP runtime server is **not enabled by default**. Use `omc team ...` CLI instead:

| Deprecated Tool | Replacement |
|----------------|-------------|
| `omc_run_team_start` | `omc team [N:agent-type] "<task>"` |
| `omc_run_team_status` | `omc team status <team-name>` |
| `omc_run_team_wait` | `omc team status <team-name>` (monitor) |
| `omc_run_team_cleanup` | `omc team shutdown <team-name> [--force]` |

---

## Agents

Always use `oh-my-claudecode:` prefix when calling via Task tool. For full agent descriptions and delegation rules, see [ARCHITECTURE.md](./ARCHITECTURE.md).

### By Domain and Tier

| Domain | LOW (Haiku) | MEDIUM (Sonnet) | HIGH (Opus) |
|--------|-------------|-----------------|-------------|
| **Analysis** | `architect-low` | `architect-medium` | `architect` |
| **Execution** | `executor-low` | `executor` | `executor-high` |
| **Search** | `explore` | — | `explore-high` |
| **Research** | — | `document-specialist` | — |
| **Frontend** | `designer-low` | `designer` | `designer-high` |
| **Docs** | `writer` | — | — |
| **Planning** | — | — | `planner` |
| **Critique** | — | — | `critic` |
| **Pre-Planning** | — | — | `analyst` |
| **Testing** | — | `qa-tester` | — |
| **Tracing** | — | `tracer` | — |
| **Security** | `security-reviewer-low` | — | `security-reviewer` |
| **Build** | — | `debugger` | — |
| **TDD** | — | `test-engineer` | — |
| **Code Review** | — | — | `code-reviewer` |
| **Data Science** | — | `scientist` | `scientist-high` |

### Agent Selection Guide

| Task Type | Best Agent | Model |
|-----------|------------|-------|
| Quick code lookup / find files | `explore` | haiku |
| Complex architectural search | `explore-high` | opus |
| Simple code change | `executor-low` | haiku |
| Feature implementation | `executor` | sonnet |
| Complex refactoring | `executor-high` | opus |
| Debug simple / complex issue | `debugger` / `architect` | sonnet / opus |
| UI component / system | `designer` / `designer-high` | sonnet / opus |
| Write docs | `writer` | haiku |
| Research docs/APIs | `document-specialist` | sonnet |
| Strategic planning | `planner` | opus |
| Review/critique plan | `critic` | opus |
| Pre-planning analysis | `analyst` | opus |
| Test CLI interactively | `qa-tester` | sonnet |
| Evidence-driven tracing | `tracer` | sonnet |
| Security review / quick scan | `security-reviewer` / `security-reviewer-low` | opus / haiku |
| TDD workflow | `test-engineer` | sonnet |
| Code review | `code-reviewer` | opus |
| Data analysis | `scientist` / `scientist-high` | sonnet / opus |

---

## Skills

For skill internals and composition layers, see [ARCHITECTURE.md](./ARCHITECTURE.md).

| Skill | Trigger / Command | Description |
|-------|-------------------|-------------|
| `autopilot` | `autopilot`, `build me`, `I want a` | Full autonomous execution from idea to working code |
| `ralph` | `ralph`, `don't stop`, `must complete` | Persistence loop until verified completion |
| `ultrawork` | `ultrawork`, `ulw` | Maximum parallel throughput mode |
| `team` | `/oh-my-claudecode:team` | Coordinated multi-agent workflow (5-stage pipeline) |
| `omc-teams` | `/oh-my-claudecode:omc-teams` | Spawn CLI workers in tmux panes (Codex, Gemini, etc.) |
| `ccg` | `ccg`, `claude-codex-gemini` | Tri-model workflow: Codex + Gemini, Claude synthesizes |
| `ultraqa` | auto (within autopilot) | QA cycle until goal is met |
| `plan` | `/oh-my-claudecode:omc-plan` | Strategic planning with interview workflow |
| `ralplan` | `ralplan` | Consensus planning (Planner + Architect + Critic loop) |
| `deep-interview` | `deep interview`, `ouroboros` | Socratic deep interview with ambiguity gating |
| `deepinit` | `/oh-my-claudecode:deepinit` | Generate hierarchical AGENTS.md docs |
| `sciomc` | `/oh-my-claudecode:sciomc` | Parallel scientist orchestration |
| `external-context` | `/oh-my-claudecode:external-context` | Parallel document-specialist research |
| `ai-slop-cleaner` | `deslop`, `anti-slop`, cleanup + slop smell | Anti-slop cleanup workflow |
| `trace` | `/oh-my-claudecode:trace` | Evidence-driven tracing with parallel tracer hypotheses |
| `ask` | `/oh-my-claudecode:ask` | Ask Claude/Codex/Gemini and capture artifacts |
| `cancel` | `cancelomc`, `stopomc` | Unified cancellation for active modes |
| `hud` | `/oh-my-claudecode:hud` | Configure HUD/statusline |
| `omc-setup` | `/oh-my-claudecode:omc-setup` | One-time setup wizard |
| `omc-doctor` | `/oh-my-claudecode:omc-doctor` | Diagnose and fix installation issues |
| `learner` | `/oh-my-claudecode:learner` | Extract reusable skill from session |
| `skill` | `/oh-my-claudecode:skill` | Manage local skills (list/add/remove/search/edit) |
| `release` | `/oh-my-claudecode:release` | Automated release workflow |
| `configure-notifications` | `/oh-my-claudecode:configure-notifications` | Configure Discord/Telegram/Slack notifications |
| `mcp-setup` | `/oh-my-claudecode:mcp-setup` | Configure MCP servers |
| `setup` | `/oh-my-claudecode:setup` | Unified setup entrypoint |
| `project-session-manager` | `/oh-my-claudecode:project-session-manager` | Manage isolated dev environments (worktrees + tmux) |
| `writer-memory` | `/oh-my-claudecode:writer-memory` | Agentic memory system for writing projects |

---

## Slash Commands

All skills are available as `/oh-my-claudecode:<name>`. Key commands:

| Command | Description |
|---------|-------------|
| `/oh-my-claudecode:autopilot <task>` | Full autonomous execution |
| `/oh-my-claudecode:ultrawork <task>` | Maximum performance mode |
| `/oh-my-claudecode:team <N>:<agent> <task>` | Coordinated multi-agent workflow |
| `/oh-my-claudecode:ralph <task>` | Persistence loop (`--critic=architect\|critic\|codex`) |
| `/oh-my-claudecode:ralph-init <task>` | Initialize PRD for structured task tracking |
| `/oh-my-claudecode:ultraqa <goal>` | Autonomous QA cycling |
| `/oh-my-claudecode:omc-plan <description>` | Planning session |
| `/oh-my-claudecode:ralplan <description>` | Consensus planning (`--deliberate` for high-risk) |
| `/oh-my-claudecode:deep-interview <idea>` | Socratic interview before execution |
| `/oh-my-claudecode:deepinit [path]` | Index codebase with AGENTS.md files |
| `/oh-my-claudecode:sciomc <topic>` | Parallel research orchestration |
| `/oh-my-claudecode:ai-slop-cleaner <target>` | Anti-slop cleanup (`--review` for reviewer-only) |
| `/oh-my-claudecode:trace` | Evidence-driven tracing lane |
| `/oh-my-claudecode:learner` | Extract reusable skill from session |
| `/oh-my-claudecode:note <content>` | Save notes to notepad.md |
| `/oh-my-claudecode:cancel` | Unified cancellation |
| `/oh-my-claudecode:setup` | Unified setup (`setup`, `setup doctor`, `setup mcp`) |
| `/oh-my-claudecode:omc-setup` | One-time setup wizard |
| `/oh-my-claudecode:omc-doctor` | Diagnose and fix installation issues |
| `/oh-my-claudecode:hud` | Configure HUD statusline |
| `/oh-my-claudecode:release` | Automated release workflow |
| `/oh-my-claudecode:mcp-setup` | Configure MCP servers |
| `/oh-my-claudecode:psm <arguments>` | Deprecated alias for project session manager |

---

## Hooks System

OMC includes 20 hooks across 11 lifecycle events. For full hook documentation and lifecycle events, see [HOOKS.md](./HOOKS.md).

### Hook Scripts by Lifecycle Event (Summary)

| Event | Scripts |
|-------|---------|
| `UserPromptSubmit` | `keyword-detector.mjs`, `skill-injector.mjs` |
| `SessionStart` | `session-start.mjs`, `project-memory-session.mjs`, `setup-init.mjs`, `setup-maintenance.mjs` |
| `PreToolUse` | `pre-tool-enforcer.mjs` |
| `PermissionRequest` | `permission-handler.mjs` |
| `PostToolUse` | `post-tool-verifier.mjs`, `project-memory-posttool.mjs` |
| `PostToolUseFailure` | `post-tool-use-failure.mjs` |
| `SubagentStart` | `subagent-tracker.mjs` (start) |
| `SubagentStop` | `subagent-tracker.mjs` (stop), `verify-deliverables.mjs` |
| `PreCompact` | `pre-compact.mjs`, `project-memory-precompact.mjs` |
| `Stop` | `context-guard-stop.mjs`, `persistent-mode.cjs`, `code-simplifier.mjs` |
| `SessionEnd` | `session-end.mjs` |

### Disabling Hooks

```bash
export DISABLE_OMC=1                          # disable all hooks
export OMC_SKIP_HOOKS="keyword-detector,notepad"  # skip specific hooks
```

### Code Simplifier Hook (opt-in)

```json
{
  "codeSimplifier": {
    "enabled": true,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
    "maxFiles": 10
  }
}
```

Automatically delegates recently modified files to the `code-simplifier` agent on Stop. Disabled by default.

---

## Magic Keywords

Include these phrases in natural language prompts to activate modes. No slash command needed. For how keyword detection works, see [HOOKS.md](./HOOKS.md).

| Keyword | Effect |
|---------|--------|
| `ultrawork`, `ulw`, `uw` | Parallel agent orchestration |
| `autopilot`, `build me`, `I want a`, `auto-pilot`, `full auto`, `fullsend`, `e2e this` | Full autonomous execution |
| `ralph`, `don't stop`, `must complete`, `until done` | Persistence until verified complete |
| `ccg`, `claude-codex-gemini` | Claude-Codex-Gemini tri-model orchestration |
| `ralplan` | Iterative planning consensus |
| `deep interview`, `ouroboros` | Socratic deep interview |
| `deepsearch`, `search the codebase`, `find in codebase` | Codebase-focused search mode |
| `deepanalyze`, `deep-analyze` | Deep analysis mode |
| `ultrathink`, `think hard`, `think deeply` | Extended reasoning mode |
| `tdd`, `test first`, `red green` | TDD workflow enforcement |
| `deslop`, `anti-slop`, cleanup + slop smells | Anti-slop cleanup |
| `cancelomc`, `stopomc` | Cancel all active modes |

**Priority order (highest first):** `cancel` → `ralph` → `autopilot` → `ultrawork` → `ccg` → `ralplan` → `deep-interview` → `ai-slop-cleaner` → `tdd` → `code-review` → `security-review` → `ultrathink` → `deepsearch` → `analyze`

> `team` is not auto-detected; use `/oh-my-claudecode:team` explicitly.

---

## Platform Support

### Operating Systems

| Platform | Install Method | Hook Type |
|----------|---------------|-----------|
| **macOS** | Claude Code Plugin | Bash (.sh) |
| **Linux** | Claude Code Plugin | Bash (.sh) |
| **Windows** | WSL2 recommended | Node.js (.mjs) |

> Bash hooks are fully portable across macOS and Linux (no GNU-specific dependencies).
> Native Windows support is experimental. OMC requires tmux, not available on native Windows. Use WSL2.
> Set `OMC_USE_NODE_HOOKS=1` to use Node.js hooks on macOS/Linux.

### Available Tools

| Tool | Status | Description |
|------|--------|-------------|
| **Read** | Available | Read files |
| **Write** | Available | Create files |
| **Edit** | Available | Modify files |
| **Bash** | Available | Run shell commands |
| **Glob** | Available | Find files by pattern |
| **Grep** | Available | Search file contents |
| **WebSearch** | Available | Search the web |
| **WebFetch** | Available | Fetch web pages |
| **Task** | Available | Spawn subagents |
| **TodoWrite** | Available | Track tasks |

### LSP Tools

| Tool | Description |
|------|-------------|
| `lsp_hover` | Type info and documentation at position |
| `lsp_goto_definition` | Jump to symbol definition |
| `lsp_find_references` | Find all usages of a symbol |
| `lsp_document_symbols` | File outline (functions, classes, etc.) |
| `lsp_workspace_symbols` | Search symbols across workspace |
| `lsp_diagnostics` | Errors, warnings, hints for a file |
| `lsp_diagnostics_directory` | Project-level type checking |
| `lsp_prepare_rename` | Check if rename is valid |
| `lsp_rename` | Rename symbol across project |
| `lsp_code_actions` | Available refactorings for a range |
| `lsp_code_action_resolve` | Details of a specific code action |
| `lsp_servers` | List available language servers |

> Requires language servers: `typescript-language-server`, `pylsp`, `rust-analyzer`, `gopls`, etc. Run `lsp_servers()` to check status.

### AST Tools

| Tool | Description |
|------|-------------|
| `ast_grep_search` | Structural code search using AST patterns |
| `ast_grep_replace` | Structural code transformation (use `dryRun=true` first) |

> Uses [@ast-grep/napi](https://ast-grep.github.io/). Meta-variables: `$VAR` (single node), `$$$` (multiple nodes).

> For full tool documentation with examples, see [TOOLS.md](./TOOLS.md).

---

## Performance Monitoring

For complete documentation, see [PERFORMANCE-MONITORING.md](./PERFORMANCE-MONITORING.md).

| Feature | Description | Access |
|---------|-------------|--------|
| **Agent Observatory** | Real-time agent status, efficiency, bottlenecks | HUD / API |
| **Session-End Summaries** | Persisted per-session summaries | `.omc/sessions/*.json` |
| **Session Replay** | Event timeline for post-session analysis | `.omc/state/agent-replay-*.jsonl` |
| **Session Search** | Search prior transcripts/session artifacts | `omc session search`, `session_search` |
| **Intervention System** | Auto-detection of stale agents, cost overruns | Automatic |

### CLI

```bash
omc hud                              # Render the current HUD statusline
omc team status <team-name>          # Inspect a running team job
tail -20 .omc/state/agent-replay-*.jsonl
ls .omc/sessions/*.json
```

### HUD Configuration (`~/.claude/settings.json`)

```json
{
  "omcHud": {
    "preset": "focused",
    "elements": {
      "cwd": true,
      "gitBranch": true,
      "showTokens": true
    }
  }
}
```

| Element | Description | Default |
|---------|-------------|---------|
| `cwd` | Current working directory | `false` |
| `gitRepo` | Git repository name | `false` |
| `gitBranch` | Current git branch | `false` |
| `omcLabel` | [OMC] label | `true` |
| `contextBar` | Context window usage | `true` |
| `agents` | Active agents count | `true` |
| `todos` | Todo progress | `true` |
| `ralph` | Ralph loop status | `true` |
| `autopilot` | Autopilot status | `true` |
| `showTokens` | Transcript-derived token usage | `false` |

Available presets: `minimal`, `focused`, `full`, `dense`, `analytics`, `opencode`

---

## Troubleshooting

### Diagnose Installation

```bash
/oh-my-claudecode:omc-doctor
```

Checks: dependencies, configuration errors, hook status, agent availability, skill registration.

### Configure HUD

```bash
/oh-my-claudecode:hud setup
```

### Common Issues

| Issue | Solution |
|-------|----------|
| Commands not found | Re-run `/oh-my-claudecode:omc-setup` |
| Hooks not executing | Check permissions: `chmod +x ~/.claude/hooks/**/*.sh` |
| Agents not delegating | Verify CLAUDE.md is loaded: `./.claude/CLAUDE.md` or `~/.claude/CLAUDE.md` |
| LSP tools not working | `npm install -g typescript-language-server` |
| Token limit errors | Use `/oh-my-claudecode:` prefix for token-efficient execution |

### Auto-Update

- Checks at most once every 24 hours (rate-limited, concurrent-safe)
- To update manually, re-run the plugin install command

### Uninstall

```bash
/plugin uninstall oh-my-claudecode@oh-my-claudecode
```

Or manually remove installed files:

```bash
rm ~/.claude/agents/{architect,document-specialist,explore,designer,writer,critic,analyst,executor,qa-tester}.md
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
