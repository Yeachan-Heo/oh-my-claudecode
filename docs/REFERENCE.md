# Reference Documentation

Complete reference for oh-my-claudecode. For quick start, see the main [README.md](../README.md).

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Plugin directory flags](#plugin-directory-flags)
- [CLI Commands: ask/team/session](#cli-commands-askteamsession)
- [Legacy MCP Team Runtime Tools (Deprecated)](#legacy-mcp-team-runtime-tools-deprecated)
- [Agents (29 Total)](#agents-29-total)
- [Skills (32 Total)](#skills-32-total)
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
- **Default**: explicitly overwrites existing `~/.claude/CLAUDE.md`
- **Optional preserve mode**: keeps the base file, writes OMC to `~/.claude/CLAUDE-omc.md`, and lets `omc` force-load that companion config at launch while plain `claude` stays unchanged

### What Configuration Enables

| Feature           | Without     | With omc Config            |
| ----------------- | ----------- | -------------------------- |
| Agent delegation  | Manual only | Automatic based on task    |
| Keyword detection | Disabled    | ultrawork, search |
| Todo continuation | Basic       | Enforced completion        |
| Model routing     | Default     | Smart tier selection       |
| Skill composition | None        | Auto-combines skills       |

### Configuration Precedence

If both configurations exist, **project-scoped takes precedence** over global:

```
./.claude/CLAUDE.md  (project)   →  Overrides  →  ~/.claude/CLAUDE.md  (global)
```

### Environment Variables

| Variable                   | Default              | Description                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMC_STATE_DIR`            | _(unset)_            | Centralized state directory. When set, OMC stores state at `$OMC_STATE_DIR/{project-id}/` instead of `{worktree}/.omc/`. This preserves state across worktree deletions. The project identifier is derived from the git remote URL (or worktree path for local-only repos). |
| `OMC_BRIDGE_SCRIPT`        | _(auto-detected)_    | Path to the Python bridge script                                                                                                                                                                                                                                            |
| `OMC_PARALLEL_EXECUTION`   | `true`               | Enable/disable parallel agent execution                                                                                                                                                                                                                                     |
| `OMC_CODEX_DEFAULT_MODEL`  | _(provider default)_ | Default model for Codex CLI workers                                                                                                                                                                                                                                         |
| `OMC_GEMINI_DEFAULT_MODEL` | _(provider default)_ | Default model for Gemini CLI workers                                                                                                                                                                                                                                        |
| `OMC_LSP_TIMEOUT_MS`       | `15000`              | Timeout (ms) for LSP requests. Increase for large repos or slow language servers                                                                                                                                                                                            |
| `DISABLE_OMC`              | _(unset)_            | Set to any value to disable all OMC hooks                                                                                                                                                                                                                                   |
| `OMC_SKIP_HOOKS`           | _(unset)_            | Comma-separated list of hook names to skip                                                                                                                                                                                                                                  |

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

### Remote OMC / Remote MCP Access

Issue #1653 asked whether OMC can "connect to a remote OMC" so one development machine can browse files on lab/test machines without opening an interactive SSH session.

The narrow, coherent answer today is:

- **Supported**: connect to a **remote MCP server** through the unified MCP registry
- **Not implemented**: a general "OMC cluster", shared remote filesystem view, or automatic remote-OMC federation
- **Still appropriate for full remote shell workflows**: SSH, worktrees, or a mounted/network filesystem

If a remote host already exposes an MCP endpoint, add it to your MCP registry (or Claude settings and then re-run setup so OMC syncs the registry to Codex too):

```json
{
  "mcpServers": {
    "remoteOmc": {
      "url": "https://lab.example.com/mcp",
      "timeout": 30
    }
  }
}
```

This gives OMC a coherent remote connection surface for MCP-backed tools. It does **not** make all remote files magically appear as a local workspace, and it does **not** replace SSH for arbitrary shell access.

If you need richer cross-machine behavior in the future, that would require a separate authenticated remote execution/filesystem design rather than stretching the current local-workspace architecture.

### Agent Customization

Edit agent files in `~/.claude/agents/` to customize behavior:

```yaml
---
name: architect
description: Your custom description
tools: Read, Grep, Glob, Bash, Edit
model: opus # or sonnet, haiku
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

## Plugin directory flags

When you launch OMC via a local development checkout instead of the marketplace plugin, you can configure how OMC discovers agents, skills, and commands.

> **Recommended for local development**: Use `omc --plugin-dir <path>` (paired with `omc setup --plugin-dir-mode`). Unlike `claude plugin marketplace add`, this flow loads agents/skills directly from your checkout with **no plugin cache**, so edits are picked up on the next session without `marketplace update` / `plugin update` round-trips — much faster iteration.

### `omc --plugin-dir <path>`

**Usage**: Non-consuming launcher flag that captures your local checkout path.

```bash
omc --plugin-dir /path/to/oh-my-claudecode setup --plugin-dir-mode
```

- **What it does**: Parses `--plugin-dir <path>` (or `--plugin-dir=<path>`), resolves it to an absolute path, sets `OMC_PLUGIN_ROOT` environment variable, then passes the flag through to Claude Code untouched.
- **Non-consuming**: The flag stays in the argument list so Claude Code's plugin loader still sees it.
- **Precedence**: Explicit `--plugin-dir` flag wins over any pre-existing `OMC_PLUGIN_ROOT` env var (with a warning if they disagree).
- **Resolution**: Relative paths are resolved to absolute via `path.resolve()`. Note: `~` is **not** expanded — use `$HOME` or an absolute path instead.
- **Pair with setup**: `--plugin-dir` alone only affects the current Claude session. You must **also** run `omc setup --plugin-dir-mode` (or let auto-detection kick in from `OMC_PLUGIN_ROOT`) so HUD, hooks, and CLAUDE.md are installed for the linked checkout. Skipping this step leaves `~/.claude/` pointing at a stale plugin root.

### `claude --plugin-dir <path>` (direct)

**Usage**: When you launch Claude Code directly without the `omc` shim.

```bash
export OMC_PLUGIN_ROOT=/path/to/oh-my-claudecode
claude --plugin-dir /path/to/oh-my-claudecode
```

- **Requirement**: You must manually set `OMC_PLUGIN_ROOT` environment variable so the HUD wrapper and other env-aware components can resolve the same path as the plugin loader.
- **Why**: The HUD bundle needs to know where agents/skills/commands are located so they stay in sync with the plugin instance.
- **Note**: Plain `claude` (without `omc`) does not automatically capture `--plugin-dir` for you.

### `omc setup --plugin-dir-mode`

**Usage**: Explicit flag to enable dev plugin-dir mode during setup.

```bash
omc setup --plugin-dir-mode
```

- **What it does**: Skips copying agents and bundled skills into `~/.claude/` because the plugin already provides them at runtime via `--plugin-dir`.
- **Still installs**:
  - HUD bundle (`~/.claude/hud/`)
  - Git hooks (`.git/hooks/`, if applicable)
  - CLAUDE.md configuration files
  - `.omc-config.json` state
- **Conflicts with `--no-plugin`**: If both flags are set, `--no-plugin` takes precedence (with a warning).
- **Auto-detection**: If `OMC_PLUGIN_ROOT` is already set in the environment, `--plugin-dir-mode` is auto-enabled (unless `--no-plugin` overrides it).

### `omc doctor --plugin-dir <path>` (NEW)

**Usage**: Run diagnostics with a specific plugin directory.

```bash
omc doctor --plugin-dir /path/to/oh-my-claudecode
omc doctor conflicts --plugin-dir /path/to/oh-my-claudecode
```

- **What it does**: Resolves the provided path to absolute, sets `OMC_PLUGIN_ROOT` before the doctor action runs, matching `launch.ts` semantics.
- **Precedence**: Explicit `--plugin-dir` flag wins over pre-existing `OMC_PLUGIN_ROOT` env var (with a warning if they disagree).
- **Subcommand support**: Works with both `omc doctor` and `omc doctor conflicts`.
- **Output**: Diagnostic results reflect the plugin directory you specified.

### `OMC_PLUGIN_ROOT` environment variable

**Usage**: Authoritative source for the active plugin root when launching Claude Code.

```bash
export OMC_PLUGIN_ROOT=/path/to/oh-my-claudecode
claude --plugin-dir /path/to/oh-my-claudecode
```

- **Set by**: `omc --plugin-dir <path>` launcher (via `src/cli/launch.ts`).
- **Read by**: HUD wrapper, setup auto-detect, doctor diagnostics.
- **Required when**: Using `claude --plugin-dir` directly (without the `omc` shim), so downstream components can resolve the same path.
- **Precedence**: Explicit CLI flags override this env var (with warnings).

### Decision matrix: which flag/mode to use?

| Your setup | Launch command | Setup command | Expected behavior |
|---|---|---|---|
| **Marketplace plugin** (recommended) | `omc` or `claude` (default) | `omc setup` | Normal: agents/skills copied to `~/.claude/` |
| **Local dev checkout, want OMC shim** | `omc --plugin-dir /path` | `omc setup --plugin-dir-mode` | Dev mode: agents/skills loaded from `/path`, not copied |
| **Local dev checkout, no OMC shim** | `claude --plugin-dir /path` + `export OMC_PLUGIN_ROOT=/path` | `omc setup --plugin-dir-mode` | Dev mode + manual env: agents/skills loaded from `/path` |
| **Local dev, want bundled skills** | `omc --plugin-dir /path` | `omc setup --no-plugin` | Forces local bundled skills to `~/.claude/skills/`, ignoring plugin |
| **Troubleshooting a specific path** | N/A | `omc doctor --plugin-dir /path` | Diagnostics show status for `/path` |

---

## CLI Commands: ask/team/session

### `omc ask`

```bash
omc ask claude "review this patch"
omc ask codex "review this patch from a security perspective"
omc ask gemini --prompt "suggest UX improvements"
omc ask claude --agent-prompt executor --prompt "create an implementation plan"
```

- Provider matrix: `claude | codex | gemini`
- Artifacts: `.omc/artifacts/ask/{provider}-{slug}-{timestamp}.md`
- Canonical env vars: `OMC_ASK_ADVISOR_SCRIPT`, `OMC_ASK_ORIGINAL_TASK`
- Phase-1 aliases (deprecated warning): `OMX_ASK_ADVISOR_SCRIPT`, `OMX_ASK_ORIGINAL_TASK`
- Skill entrypoint: `/oh-my-claudecode:ask <claude|codex|gemini> <prompt>` routes to this command

### `omc team` (CLI runtime surface)

```bash
omc team 2:codex "review auth flow"
omc team status review-auth-flow
omc team shutdown review-auth-flow --force
omc team api claim-task --input '{"team_name":"auth-review","task_id":"1","worker":"worker-1"}' --json
```

Supported entrypoints: direct start (`omc team [N:agent] "<task>"`), `status`, `shutdown`, and `api`.

Topology behavior:
- inside classic tmux (`$TMUX` set): reuse the current tmux surface for split-pane or `--new-window` layouts
- inside cmux (`CMUX_SURFACE_ID` without `$TMUX`): launch a detached tmux session for team workers
- plain terminal: launch a detached tmux session for team workers

### `omc session search`

```bash
omc session search "team leader stale"
omc session search notify-hook --since 7d
omc session search provider-routing --project all --json
```

- Defaults to the current project/worktree scope
- Use `--project all` to search across all local Claude project transcripts
- Supports `--limit`, `--session`, `--since`, `--context`, `--case-sensitive`, and `--json`
- MCP/tool surface: `session_search` returns structured JSON for agents and automations

---

## Legacy MCP Team Runtime Tools (Deprecated, Opt-In Only)

The Team MCP runtime server is **not enabled by default**. If manually enabled, runtime tools are still **CLI-only deprecated** and return a deterministic error envelope:

```json
{
  "code": "deprecated_cli_only",
  "message": "Legacy team MCP runtime tools are deprecated. Use the omc team CLI instead."
}
```

Use `omc team ...` replacements instead:

| Tool                   | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `omc_run_team_start`   | **Deprecated** → `omc team [N:agent-type] "<task>"`        |
| `omc_run_team_status`  | **Deprecated** → `omc team status <team-name>`             |
| `omc_run_team_wait`    | **Deprecated** → monitor via `omc team status <team-name>` |
| `omc_run_team_cleanup` | **Deprecated** → `omc team shutdown <team-name> [--force]` |

Optional compatibility enablement (manual only):

```json
{
  "mcpServers": {
    "team": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bridge/team-mcp.cjs"]
    }
  }
}
```

### Runtime status semantics

- **Artifact-first terminal convergence**: team monitors prefer finalized state artifacts when present.
- **Deterministic parse-failure handling**: malformed result artifacts are treated as terminal `failed`.
- **Cleanup scope**: shutdown/cleanup only clears `.omc/state/team/{teamName}` for the target team (never sibling teams).

### Artifact descriptors and bounded handoff

OMC handoffs follow an artifact-first discipline:

- **Control plane** data stays small and operational: queue state, worker claims, session state, and interop task/message envelopes.
- **Data plane** artifacts stay durable: plans, prompts, specs, traces, and result files.
- Large payloads should be referenced by descriptor instead of copied into control-plane state.
- Current low-risk call sites follow this split explicitly:
  - shared interop state writes oversized task descriptions, task results, and shared messages to `.omc/state/interop/artifacts/**`
  - prompt persistence keeps durable prompt/response files in `.omc/prompts/**` and exposes descriptor metadata through job status records

Canonical descriptor fields:

| Field | Meaning |
|------|---------|
| `kind` | Artifact type such as `plan`, `prompt`, `result`, or `trace` |
| `path` | Durable artifact path |
| `contentHash?` | Optional integrity hint |
| `createdAt` | Artifact creation timestamp |
| `producer` | Owning worker/tool/skill |
| `sizeBytes?` | Optional size for threshold checks |
| `retention` | Retention/ownership hint |
| `expiresAt?` | Optional expiry for short-lived artifacts |

Bounded handoff policy:

1. Keep small payloads inline only when the call site's explicit threshold allows it.
2. For larger payloads, pass a short summary plus the descriptor.
3. Keep durable content in artifact paths such as `.omc/plans/`, `.omc/prompts/`, and related artifact stores rather than embedding full bodies into queue or status records.

## Agents (29 Total)

Always use `oh-my-claudecode:` prefix when calling via Task tool.

### By Domain and Tier

| Domain           | LOW (Haiku)             | MEDIUM (Sonnet)       | HIGH (Opus)         |
| ---------------- | ----------------------- | --------------------- | ------------------- |
| **Analysis**     | `architect-low`         | `architect-medium`    | `architect`         |
| **Execution**    | `executor-low`          | `executor`            | `executor-high`     |
| **Search**       | `explore`               | -                     | `explore-high`      |
| **Research**     | -                       | `document-specialist` | -                   |
| **Frontend**     | `designer-low`          | `designer`            | `designer-high`     |
| **Docs**         | `writer`                | -                     | -                   |
| **Visual**       | -                       | `vision`              | -                   |
| **Planning**     | -                       | -                     | `planner`           |
| **Critique**     | -                       | -                     | `critic`            |
| **Pre-Planning** | -                       | -                     | `analyst`           |
| **Testing**      | -                       | `qa-tester`           | -                   |
| **Tracing**      | -                       | `tracer`              | -                   |
| **Security**     | `security-reviewer-low` | -                     | `security-reviewer` |
| **Build**        | -                       | `debugger`            | -                   |
| **TDD**          | -                       | `test-engineer`       | -                   |
| **Code Review**  | -                       | -                     | `code-reviewer`     |
| **Data Science** | -                       | `scientist`           | `scientist-high`    |
| **Git**          | -                       | `git-master`          | -                   |
| **Simplification** | -                     | -                     | `code-simplifier`   |

### Agent Selection Guide

| Task Type                    | Best Agent                    | Model  |
| ---------------------------- | ----------------------------- | ------ |
| Quick code lookup            | `explore`                     | haiku  |
| Find files/patterns          | `explore`                     | haiku  |
| Complex architectural search | `explore-high`                | opus   |
| Simple code change           | `executor-low`                | haiku  |
| Feature implementation       | `executor`                    | sonnet |
| Complex refactoring          | `executor-high`               | opus   |
| Debug simple issue           | `architect-low`               | haiku  |
| Debug complex issue          | `architect`                   | opus   |
| UI component                 | `designer`                    | sonnet |
| Complex UI system            | `designer-high`               | opus   |
| Write docs/comments          | `writer`                      | haiku  |
| Research docs/APIs           | `document-specialist` (repo docs first; optional Context Hub / `chub`) | sonnet |
| Analyze images/diagrams      | `vision`                      | sonnet |
| Strategic planning           | `planner`                     | opus   |
| Review/critique plan         | `critic`                      | opus   |
| Pre-planning analysis        | `analyst`                     | opus   |
| Test CLI interactively       | `qa-tester`                   | sonnet |
| Evidence-driven causal tracing | `tracer`                    | sonnet |
| Security review              | `security-reviewer`           | sonnet |
| Quick security scan          | `security-reviewer-low`       | haiku  |
| Fix build errors             | `debugger`                    | sonnet |
| Simple build fix             | `debugger` (model=haiku)      | haiku  |
| TDD workflow                 | `test-engineer`               | sonnet |
| Quick test suggestions       | `test-engineer` (model=haiku) | haiku  |
| Code review                  | `code-reviewer`               | opus   |
| Quick code check             | `code-reviewer` (model=haiku) | haiku  |
| Data analysis/stats          | `scientist`                   | sonnet |
| Quick data inspection        | `scientist` (model=haiku)     | haiku  |
| Complex ML/hypothesis        | `scientist-high`              | opus   |
| Git operations               | `git-master`                  | sonnet |
| Code simplification          | `code-simplifier`             | opus   |

---

## Skills (32 Total)

Includes **31 canonical skills + 1 deprecated alias** (`psm`). Runtime truth comes from the builtin skill loader scanning `skills/*/SKILL.md` and expanding aliases declared in frontmatter.

| Skill                     | Description                                                      | Manual Command                              |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `ai-slop-cleaner`         | Anti-slop cleanup workflow with optional reviewer-only `--review` pass | `/oh-my-claudecode:ai-slop-cleaner`         |
| `ask`                     | Ask Claude, Codex, or Gemini via local CLI and capture a reusable artifact | `/oh-my-claudecode:ask`               |
| `autopilot`               | Full autonomous execution from idea to working code              | `/oh-my-claudecode:autopilot`               |
| `cancel`                  | Unified cancellation for active modes                            | `/oh-my-claudecode:cancel`                  |
| `ccg`                     | Tri-model workflow via `ask codex` + `ask gemini`, then Claude synthesis | `/oh-my-claudecode:ccg`                     |
| `configure-notifications` | Configure notification integrations (Telegram, Discord, Slack) via natural language | `/oh-my-claudecode:configure-notifications` |
| `deep-dive`               | Two-stage trace → deep-interview pipeline with context handoff   | `/oh-my-claudecode:deep-dive`               |
| `deep-interview`          | Socratic deep interview with ambiguity gating                    | `/oh-my-claudecode:deep-interview`          |
| `deepinit`                | Generate hierarchical AGENTS.md docs                             | `/oh-my-claudecode:deepinit`                |
| `external-context`        | Parallel document-specialist research                            | `/oh-my-claudecode:external-context`        |
| `hud`                     | Configure HUD/statusline                                         | `/oh-my-claudecode:hud`                     |
| `learner`                 | Extract reusable skill from session                              | `/oh-my-claudecode:learner`                 |
| `mcp-setup`               | Configure MCP servers                                            | `/oh-my-claudecode:mcp-setup`               |
| `omc-doctor`              | Diagnose and fix installation issues                             | `/oh-my-claudecode:omc-doctor`              |
| `omc-plan`                | Planning workflow (`/plan` safe alias)                           | `/oh-my-claudecode:omc-plan`                |
| `omc-reference`           | Detailed OMC agent/tools/team/commit reference skill             | Auto-loaded reference only                  |
| `omc-setup`               | One-time setup wizard                                            | `/oh-my-claudecode:omc-setup`               |
| `omc-teams`               | Spawn `claude`/`codex`/`gemini` tmux workers for parallel execution | `/oh-my-claudecode:omc-teams`             |
| `project-session-manager` | Manage isolated dev environments (git worktrees + tmux)          | `/oh-my-claudecode:project-session-manager` |
| `psm` | **Deprecated** compatibility alias for `project-session-manager` | `/oh-my-claudecode:psm` |
| `ralph`                   | Persistence loop until verified completion                       | `/oh-my-claudecode:ralph`                   |
| `ralplan`                 | Consensus planning alias for `/omc-plan --consensus`             | `/oh-my-claudecode:ralplan`                 |
| `release`                 | Automated release workflow                                       | `/oh-my-claudecode:release`                 |
| `setup`                   | Unified setup entrypoint for install, diagnostics, and MCP configuration | `/oh-my-claudecode:setup`              |
| `sciomc`                  | Parallel scientist orchestration                                 | `/oh-my-claudecode:sciomc`                  |
| `skill`                   | Manage local skills (list/add/remove/search/edit)                | `/oh-my-claudecode:skill`                   |
| `team`                    | Coordinated multi-agent workflow                                 | `/oh-my-claudecode:team`                    |
| `trace`                   | Evidence-driven tracing lane with parallel tracer hypotheses     | `/oh-my-claudecode:trace`                   |
| `ultraqa`                 | QA cycle until goal is met                                       | `/oh-my-claudecode:ultraqa`                 |
| `ultrawork`               | Maximum parallel throughput mode                                 | `/oh-my-claudecode:ultrawork`               |
| `visual-verdict`          | Structured visual QA verdict for screenshot/reference comparisons | `/oh-my-claudecode:visual-verdict`          |
| `writer-memory`           | Agentic memory system for writing projects                       | `/oh-my-claudecode:writer-memory`           |


---

## Slash Commands

Each installed skill is exposed as `/oh-my-claudecode:<skill-name>`. The skills table above is the full runtime-backed list; the commands below highlight common entrypoints and aliases. Compatibility keyword modes like `deep-analyze` and `tdd` are prompt-triggered behaviors, not standalone slash commands.

| Command                                     | Description                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/oh-my-claudecode:ai-slop-cleaner <target>`    | Run the anti-slop cleanup workflow (`--review` for reviewer-only pass)                    |
| `/oh-my-claudecode:ask <claude\|codex\|gemini> <prompt>` | Route a prompt through the selected advisor CLI and capture an ask artifact         |
| `/oh-my-claudecode:autopilot <task>`            | Full autonomous execution                                                                  |
| `/oh-my-claudecode:configure-notifications`     | Configure notification integrations                                                       |
| `/oh-my-claudecode:deep-dive <problem>`         | Run the trace → deep-interview pipeline                                                   |
| `/oh-my-claudecode:deep-interview <idea>`       | Socratic interview with ambiguity scoring before execution                                 |
| `/oh-my-claudecode:deepinit [path]`             | Index codebase with hierarchical AGENTS.md files                                           |
| `/oh-my-claudecode:mcp-setup`                   | Configure MCP servers                                                                      |
| `/oh-my-claudecode:omc-doctor`                  | Diagnose and fix installation issues                                                       |
| `/oh-my-claudecode:omc-plan <description>`      | Start planning session (supports consensus structured deliberation)                        |
| `/oh-my-claudecode:omc-setup`                   | One-time setup wizard                                                                      |
| `/oh-my-claudecode:omc-teams <N>:<agent> <task>`       | Spawn `claude`/`codex`/`gemini` tmux workers for legacy parallel execution                |
| `/oh-my-claudecode:project-session-manager <arguments>` | Manage isolated dev environments with git worktrees + tmux                         |
| `/oh-my-claudecode:psm <arguments>`             | Deprecated alias for project session manager                                               |
| `/oh-my-claudecode:ralph <task>`                | Self-referential loop until task completion (`--critic=architect|critic|codex`)           |
| `/oh-my-claudecode:ralplan <description>`       | Iterative planning with consensus structured deliberation (`--deliberate` for high-risk mode) |
| `/oh-my-claudecode:release`                     | Automated release workflow                                                                 |
| `/oh-my-claudecode:setup`                       | Unified setup entrypoint (`setup`, `setup doctor`, `setup mcp`)                           |
| `/oh-my-claudecode:sciomc <topic>`              | Parallel research orchestration                                                            |
| `/oh-my-claudecode:team <N>:<agent> <task>`     | Coordinated native team workflow                                                           |
| `/oh-my-claudecode:trace`                       | Evidence-driven tracing lane that orchestrates parallel tracer hypotheses in team mode     |
| `/oh-my-claudecode:ultraqa <goal>`              | Autonomous QA cycling workflow                                                             |
| `/oh-my-claudecode:ultrawork <task>`            | Maximum performance mode with parallel agents                                              |
| `/oh-my-claudecode:visual-verdict <task>`       | Structured visual QA verdict for screenshot/reference comparisons                          |

### Skill Pipeline Metadata (Preview)

Built-in skills and slash-loaded skills can now declare a lightweight pipeline/handoff contract in frontmatter:

```yaml
pipeline: [deep-interview, omc-plan, autopilot]
next-skill: omc-plan
next-skill-args: --consensus --direct
handoff: .omc/specs/deep-interview-{slug}.md
```

When present, OMC appends a standardized **Skill Pipeline** section to the rendered skill prompt so the current stage, handoff artifact, and explicit next `Skill("oh-my-claudecode:...")` invocation are carried forward consistently.

### Skills 2.0 Compatibility (MVP)

OMC's canonical project-local skill directory remains `.omc/skills/`, but the runtime now also reads compatibility skills from `.agents/skills/`.

For builtin and slash-loaded skills, OMC also appends a standardized **Skill Resources** section when the skill directory contains bundled assets such as helper scripts, templates, or support libraries. This helps agents reuse packaged skill resources instead of recreating them ad hoc.

---

## Hooks System

OMC registers 20 hook scripts across 11 Claude Code lifecycle events. For detailed documentation, see [HOOKS.md](./HOOKS.md).

### Hooks by Lifecycle Event

| Event | Scripts | Timeout |
|-------|---------|---------|
| **UserPromptSubmit** | `keyword-detector.mjs`, `skill-injector.mjs` | 5s, 3s |
| **SessionStart** | `session-start.mjs`, `project-memory-session.mjs`, `setup-init.mjs` (init), `setup-maintenance.mjs` (maintenance) | 5s, 5s, 30s, 60s |
| **PreToolUse** | `pre-tool-enforcer.mjs` | 3s |
| **PermissionRequest** | `permission-handler.mjs` (Bash only) | 5s |
| **PostToolUse** | `post-tool-verifier.mjs`, `project-memory-posttool.mjs` | 3s, 3s |
| **PostToolUseFailure** | `post-tool-use-failure.mjs` | 3s |
| **SubagentStart** | `subagent-tracker.mjs start` | 3s |
| **SubagentStop** | `subagent-tracker.mjs stop`, `verify-deliverables.mjs` | 5s, 5s |
| **PreCompact** | `pre-compact.mjs`, `project-memory-precompact.mjs` | 10s, 5s |
| **Stop** | `context-guard-stop.mjs`, `persistent-mode.cjs`, `code-simplifier.mjs` | 5s, 10s, 5s |
| **SessionEnd** | `session-end.mjs` | 30s |

> **Note**: autopilot, ralph, ultrawork, and ultraqa are **skills** (activated via keyword-detector), not hooks. The `persistent-mode.cjs` hook enforces their continuation by blocking the Stop event.

### Code Simplifier Hook

### Code Simplifier Hook

The `code-simplifier` Stop hook automatically delegates recently modified source files to the
`code-simplifier` agent after each Claude turn. It is **disabled by default** and must be
explicitly enabled via the global OMC config file:

- Linux/Unix default: `${XDG_CONFIG_HOME:-~/.config}/omc/config.json`
- macOS/Windows legacy/default path: `~/.omc/config.json`
- Existing legacy `~/.omc/config.json` continues to be read as a fallback where applicable.

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

| Option       | Type       | Default                                         | Description                        |
| ------------ | ---------- | ----------------------------------------------- | ---------------------------------- |
| `enabled`    | `boolean`  | `false`                                         | Opt-in to automatic simplification |
| `extensions` | `string[]` | `[".ts",".tsx",".js",".jsx",".py",".go",".rs"]` | File extensions to consider        |
| `maxFiles`   | `number`   | `10`                                            | Maximum files simplified per turn  |

**How it works:**

1. When Claude stops, the hook runs `git diff HEAD --name-only` to find modified files
2. If modified source files are found, the hook injects a message asking Claude to delegate to the `code-simplifier` agent
3. The agent simplifies the files for clarity and consistency without changing behavior
4. A turn-scoped marker prevents the hook from triggering more than once per turn cycle

---

## Magic Keywords

Use these trigger phrases in natural language prompts to activate enhanced modes:

| Keyword                                                 | Effect                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ultrawork`, `ulw`, `uw`                                | Activates parallel agent orchestration                                                        |
| `autopilot`, `build me`, `I want a`, `handle it all`, `end to end`, `e2e this` | Full autonomous execution                                              |
| `deslop`, `anti-slop`, cleanup/refactor + slop smells         | Anti-slop cleanup workflow (`ai-slop-cleaner`)                                               |
| `ralph`, `don't stop`, `must complete`, `until done`    | Persistence until verified complete                                                           |
| `ccg`, `claude-codex-gemini`                            | Claude-Codex-Gemini orchestration                                                             |
| `ralplan`                                               | Iterative planning consensus with structured deliberation (`--deliberate` for high-risk mode) |
| `deep interview`, `ouroboros`                           | Deep Socratic interview with mathematical clarity gating                                      |
| `deepsearch`, `search the codebase`, `find in codebase` | Codebase-focused search mode                                                                  |
| `deepanalyze`, `deep-analyze`                           | Deep analysis mode                                                                            |
| `ultrathink`, `think hard`, `think deeply`              | Deep reasoning mode                                                                           |
| `tdd`, `test first`, `red green`                        | TDD workflow enforcement                                                                      |
| `code review`, `review code`                            | Comprehensive code review mode                                                                |
| `security review`, `review security`                    | Security-focused review mode                                                                  |
| `cancelomc`, `stopomc`                                  | Unified cancellation                                                                          |

### Examples

```bash
# In Claude Code:

# Maximum parallelism
ultrawork implement user authentication with OAuth

# Enhanced search
deepsearch for files that import the utils module

# Deep analysis
deep-analyze why the tests are failing

# Autonomous execution
autopilot: build a todo app with React

# Parallel autonomous execution
team 3:executor "build a fullstack todo app"

# Persistence mode
ralph: refactor the authentication module

# Planning session
ralplan this feature

# TDD workflow
tdd: implement password validation

# Stop active orchestration
stopomc
```

---

## Platform Support

### Operating Systems

| Platform    | Install Method              | Hook Type      |
| ----------- | --------------------------- | -------------- |
| **Windows** | WSL2 recommended (see note) | Node.js (.mjs) |
| **macOS**   | Claude Code Plugin          | Bash (.sh)     |
| **Linux**   | Claude Code Plugin          | Bash (.sh)     |

> **Note**: Bash hooks are fully portable across macOS and Linux (no GNU-specific dependencies).

> **Windows**: Native Windows (win32) support is experimental. OMC requires tmux, which is not available on native Windows. **WSL2 is strongly recommended** for Windows users. See the [WSL2 installation guide](https://learn.microsoft.com/en-us/windows/wsl/install). Native Windows issues may have limited support.

> **Advanced**: Set `OMC_USE_NODE_HOOKS=1` to use Node.js hooks on macOS/Linux.

### Available Tools

| Tool          | Status       | Description           |
| ------------- | ------------ | --------------------- |
| **Read**      | ✅ Available | Read files            |
| **Write**     | ✅ Available | Create files          |
| **Edit**      | ✅ Available | Modify files          |
| **Bash**      | ✅ Available | Run shell commands    |
| **Glob**      | ✅ Available | Find files by pattern |
| **Grep**      | ✅ Available | Search file contents  |
| **WebSearch** | ✅ Available | Search the web        |
| **WebFetch**  | ✅ Available | Fetch web pages       |
| **Task**      | ✅ Available | Spawn subagents       |
| **TodoWrite** | ✅ Available | Track tasks           |

### LSP Tools (Real Implementation)

| Tool                        | Status         | Description                                 |
| --------------------------- | -------------- | ------------------------------------------- |
| `lsp_hover`                 | ✅ Implemented | Get type info and documentation at position |
| `lsp_goto_definition`       | ✅ Implemented | Jump to symbol definition                   |
| `lsp_find_references`       | ✅ Implemented | Find all usages of a symbol                 |
| `lsp_document_symbols`      | ✅ Implemented | Get file outline (functions, classes, etc.) |
| `lsp_workspace_symbols`     | ✅ Implemented | Search symbols across workspace             |
| `lsp_diagnostics`           | ✅ Implemented | Get errors, warnings, hints                 |
| `lsp_prepare_rename`        | ✅ Implemented | Check if rename is valid                    |
| `lsp_rename`                | ✅ Implemented | Rename symbol across project                |
| `lsp_code_actions`          | ✅ Implemented | Get available refactorings                  |
| `lsp_code_action_resolve`   | ✅ Implemented | Get details of a code action                |
| `lsp_servers`               | ✅ Implemented | List available language servers             |
| `lsp_diagnostics_directory` | ✅ Implemented | Project-level type checking                 |

> **Note**: LSP tools require language servers to be installed (typescript-language-server, ty, rust-analyzer, gopls, etc.). Use `lsp_servers` to check installation status.

### AST Tools (ast-grep Integration)

| Tool               | Status         | Description                                  |
| ------------------ | -------------- | -------------------------------------------- |
| `ast_grep_search`  | ✅ Implemented | Pattern-based code search using AST matching |
| `ast_grep_replace` | ✅ Implemented | Pattern-based code transformation            |

> **Note**: AST tools use [@ast-grep/napi](https://ast-grep.github.io/) for structural code matching. Supports meta-variables like `$VAR` (single node) and `$$$` (multiple nodes).

---

## Performance Monitoring

oh-my-claudecode includes comprehensive monitoring for agent performance, token usage, and debugging parallel workflows.

For complete documentation, see **[Performance Monitoring Guide](./PERFORMANCE-MONITORING.md)**.

### Quick Overview

| Feature                 | Description                                     | Access                               |
| ----------------------- | ----------------------------------------------- | ------------------------------------ |
| **Agent Observatory**   | Real-time agent status, efficiency, bottlenecks | HUD / API                            |
| **Session-End Summaries** | Persisted per-session summaries and callback payloads | `.omc/sessions/*.json`, `session-end` |
| **Session Replay**      | Event timeline for post-session analysis        | `.omc/state/agent-replay-*.jsonl`    |
| **Session Search**      | Search prior local transcript/session artifacts  | `omc session search`, `session_search` |
| **Intervention System** | Auto-detection of stale agents, cost overruns   | Automatic                            |

### CLI Commands

```bash
omc hud                              # Render the current HUD statusline
omc team status <team-name>          # Inspect a running team job
tail -20 .omc/state/agent-replay-*.jsonl
ls .omc/sessions/*.json
```

### HUD Presets

Enable a supported preset for agent and context visibility in your status line:

```json
{
  "omcHud": {
    "preset": "focused"
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
      "gitBranch": true,
      "showTokens": true
    }
  }
}
```

| Element      | Description                                                                                       | Default |
| ------------ | ------------------------------------------------------------------------------------------------- | ------- |
| `cwd`        | Show current working directory                                                                    | `false` |
| `gitRepo`    | Show git repository name                                                                          | `false` |
| `gitBranch`  | Show current git branch                                                                           | `false` |
| `omcLabel`   | Show [OMC] label                                                                                  | `true`  |
| `contextBar` | Show context window usage                                                                         | `true`  |
| `agents`     | Show active agents count                                                                          | `true`  |
| `todos`      | Show todo progress                                                                                | `true`  |
| `ralph`      | Show ralph loop status                                                                            | `true`  |
| `autopilot`  | Show autopilot status                                                                             | `true`  |
| `showTokens` | Show transcript-derived token usage (`tok:i1.2k/o340`, plus `r...` reasoning and `s...` session total when reliable) | `false` |

Additional `omcHud` layout options (top-level):

| Option     | Description                                                                       | Default    |
| ---------- | --------------------------------------------------------------------------------- | ---------- |
| `maxWidth` | Maximum HUD line width (terminal columns)                                         | unset      |
| `wrapMode` | `truncate` (ellipsis) or `wrap` (break at `\|` boundaries) when `maxWidth` is set | `truncate` |

Available presets: `minimal`, `focused`, `full`, `dense`, `analytics`, `opencode`

### Common Issues

| Issue                 | Solution                                                                         |
| --------------------- | -------------------------------------------------------------------------------- |
| Commands not found    | Re-run `/oh-my-claudecode:omc-setup`                                             |
| Hooks not executing   | Check hook permissions: `chmod +x ~/.claude/hooks/**/*.sh`                       |
| Agents not delegating | Verify CLAUDE.md is loaded: check `./.claude/CLAUDE.md` or `~/.claude/CLAUDE.md` |
| LSP tools not working | Install language servers: `npm install -g typescript-language-server`            |
| Token limit errors    | Use `/oh-my-claudecode:` for token-efficient execution                           |

### Auto-Update

Oh-my-claudecode includes a silent auto-update system that checks for updates in the background.

Features:

- **Rate-limited**: Checks at most once every 24 hours
- **Concurrent-safe**: Lock file prevents simultaneous update attempts
- **Cross-platform**: Works on both macOS and Linux

To manually update, re-run the plugin install command or use Claude Code's built-in update mechanism.

### Uninstall

Use Claude Code's plugin management:

```
/plugin uninstall oh-my-claudecode@oh-my-claudecode
```

Or manually remove the installed files:

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
