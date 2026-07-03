# Reference Documentation

Complete reference for oh-my-claudecode. For quick start, see the main [README.md](../README.md).

---

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Runtime storage and goal artifacts](#runtime-storage-and-goal-artifacts)
- [Plugin directory flags](#plugin-directory-flags)
- [CLI Commands: ask/team/session](#cli-commands-askteamsession)
- [Legacy MCP Team Runtime Tools (Deprecated)](#legacy-mcp-team-runtime-tools-deprecated-opt-in-only)
- [Agents (29 Total)](#agents-29-total)
- [Goal Workflow UX: `/goal`, Ralph, Team, UltraQA, Ultragoal](#goal-workflow-ux-goal-ralph-team-ultraqa-ultragoal)
- [Skills (38 Total)](#skills-38-total)
- [Slash Commands](#slash-commands)
- [Claude Code `/goal` Adapter Design](#claude-code-goal-adapter-design)
- [Hooks System](#hooks-system)
- [Magic Keywords](#magic-keywords)
- [Platform Support](#platform-support)
- [Performance Monitoring](#performance-monitoring)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)

---

## Installation

OMC has two supported public surfaces. Use the Claude Code plugin for in-session slash commands, hooks, agents, skills, and statusline behavior. Use the npm-installed `omc` CLI for terminal commands, setup/update automation, and CI-safe checks.

### Claude Code Plugin

```bash
# Step 1: Add the marketplace
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode

# Step 2: Install the plugin
/plugin install oh-my-claudecode
```

This integrates directly with Claude Code's plugin system and uses Node.js hooks.

### Terminal CLI

```bash
npm i -g oh-my-claude-sisyphus@latest
omc setup
```

The npm package exposes both `oh-my-claudecode` and `omc`; examples prefer `omc` unless troubleshooting needs the long alias. The CLI does not make in-session slash skills available by itself; install the plugin for `/autopilot`, `/ralph`, `/team`, and other interactive skills.

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

| Feature           | Without     | With omc Config         |
| ----------------- | ----------- | ----------------------- |
| Agent delegation  | Manual only | Automatic based on task |
| Keyword detection | Disabled    | ultrawork, search       |
| Todo continuation | Basic       | Enforced completion     |
| Model routing     | Default     | Smart tier selection    |
| Skill composition | None        | Auto-combines skills    |

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
| `OMC_GEMINI_DEFAULT_MODEL`       | _(provider default)_ | Default model for Gemini CLI workers                                                                                                                                                                                                                                    |
| `OMC_ANTIGRAVITY_DEFAULT_MODEL`  | _(provider default)_ | Default model for Antigravity CLI (`agy`) workers                                                                                                                                                                                                                       |
| `OMC_GROK_DEFAULT_MODEL`         | _(provider default)_ | Default model for Grok Build CLI workers                                                                                                                                                                                                                                |
| `OMC_LSP_TIMEOUT_MS`       | `15000`              | Timeout (ms) for LSP requests. Increase for large repos or slow language servers                                                                                                                                                                                            |
| `OMC_MIGRATE_LEGACY_STATE` | _(unset)_            | Set to `1` to enable one-shot legacy→session-scoped state migration on next read. See [Legacy state migration](#legacy-state-migration-omc_migrate_legacy_state) below.                                                                                                      |
| `OMC_DISABLE_MULTIREPO`    | _(unset)_            | Set to `1` to disable workspace-marker resolution and fall back to git-root + cwd resolution order. `OMC_STATE_DIR` is still honoured. See [Rollback / disable multi-repo](#rollback--disable-multi-repo-omc_disable_multirepo) below.                                       |
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

#### OMC state, gitignore, worktree, and workspace contract

OMC's project-local state root is `.omc/` unless `OMC_STATE_DIR` or `.omc-workspace` changes the root resolution described below. The default root contains runtime and audit artifacts such as:

- `.omc/state/` and `.omc/state/sessions/{sessionId}/` — mode state, session-scoped state, replay markers, and recovery metadata.
- `.omc/notepad.md` and `.omc/project-memory.json` — local session notes and project memory.
- `.omc/plans/`, `.omc/research/`, `.omc/logs/`, `.omc/artifacts/`, `.omc/handoffs/`, and `.omc/ultragoal/` — generated plans, research outputs, logs, advisor artifacts, team handoffs, and ultragoal ledgers.
- `.omc/team/` — opt-in native team worker worktrees when team worktree mode creates them.
- `.omc/skills/` — the only project-local `.omc` subtree intended to be committed when the team wants to share OMC-authored skills.

Git handling is intentionally conservative. The repository `.gitignore` keeps `.omc/` itself visible, ignores `.omc/*`, and then re-includes `.omc/skills/` plus `.omc/skills/**`. That means generated state stays untracked by default, while project skills can be reviewed and committed explicitly. Do not force-add runtime `.omc` files unless you are deliberately attaching a sanitized artifact to an issue or test fixture; runtime state can include prompts, transcripts, absolute paths, machine identifiers, and workflow history.

Worktree behavior follows the resolved state root:

- **Default single repo / monorepo**: `getOmcRoot()` uses the git toplevel, so every package below one git root shares `{repo}/.omc/`.
- **Linked git worktrees**: without `OMC_STATE_DIR`, each linked worktree has its own `{worktree}/.omc/`; removing that worktree removes its local OMC state. Re-run setup from the worktree you are actively using so installed hooks and generated instructions match that checkout.
- **Persistent state across worktree deletion**: set `OMC_STATE_DIR`; OMC writes to `$OMC_STATE_DIR/{project-id}/`, where the project id is stable across linked worktrees when a remote or primary git dir is available.
- **Multi-repo workspace**: add `.omc-workspace` to a non-git parent when independent sibling repos should share `{parent}/.omc/`. This is for multi-repo workspaces, not ordinary monorepos.

Plan persistence follows the same rule. Default generated plans under `.omc/plans/` are local operational artifacts and are ignored. If a plan should become durable project documentation, move it to a tracked docs path or configure `planOutput.directory` to a reviewed directory such as `docs/plans`; keep machine-local session state in `.omc/`.

Cleanup rule of thumb: after OMC sessions are stopped, it is safe to delete ignored runtime subtrees such as `.omc/state/`, `.omc/logs/`, `.omc/artifacts/`, `.omc/research/`, or `.omc/ultragoal/` if you no longer need their recovery/audit history. Do not delete `.omc/skills/` unless you intend to remove project-scoped skills.

#### Multi-repo workspaces with `.omc-workspace`

When you have several independent git repos under one parent directory and the parent itself is **not** a git repo, OMC cannot infer a shared root via `git rev-parse --show-toplevel`. Each sub-repo would get its own isolated `.omc/`. To anchor a single `.omc/` at the parent, drop a `.omc-workspace` marker file there:

```bash
cd /path/to/my-workspace            # parent dir (not a git repo)
echo '{}' > .omc-workspace          # empty JSON is fine
```

From any sub-directory (including inside any sub-git-repo), OMC resolves `.omc/` to `/path/to/my-workspace/.omc/`. The marker may also carry an explicit project identifier so all sessions share state regardless of the parent dir name:

```json
{ "id": "my-org-bidchex" }
```

Resolution order inside `getOmcRoot()`:

1. `OMC_STATE_DIR` (centralized).
2. `.omc-workspace` marker (multi-repo workspace).
3. `git rev-parse --show-toplevel` (monorepo / single repo).
4. `process.cwd()` (last resort).

Once a workspace is anchored, multiple Claude Code sessions in different sub-repos can run `/ultragoal`, `/ralph`, `/ultrawork`, `/autopilot` in parallel without bleeding state. For `/ultragoal` specifically, pass `--plan-id <id>` or `--auto-plan-id` on `create-goals` so each session writes to `.omc/ultragoal/plans/{planId}/` instead of the shared `goals.json` — see "ultragoal multi-plan" below. The PARALLEL SESSION WARNING in `session-start.mjs` performs a PID-aware liveness check and no longer suppresses restore when the owner session is dead.

#### `.omc/handoffs/` shared contract

`.omc/handoffs/` is intentionally **shared across team runs** by design. Its purpose is inter-session message passing: team stage handoffs (plan → prd → exec → verify) accumulate here so a later `team` run can resume from the last non-terminal stage without losing decision history.

**Only the `team` skill writes to `.omc/handoffs/`.** All other code that reads the directory does so read-only. This is enforced by the lint test `tests/lint/handoffs-writers.test.ts`, which scans `src/**` and `templates/**` and fails if any file outside `src/team/` or `src/hooks/team-pipeline/` references `handoffs/` as a write target.

- Handoff files survive team cancellation and OMC state cleanup intentionally — they are post-mortem artifacts. Claude Code 2.1.178+ has no `TeamDelete`.
- Do **not** session-scope `.omc/handoffs/` unless the `team` skill explicitly evolves to per-session inboxes (tracked as a follow-up in the ADR).

#### Branded path types (`ReadPath` / `WritePath`)

State-file path resolution returns a branded struct from `resolveSessionStatePaths()` in `src/lib/worktree-paths.ts`:

```ts
interface SessionStatePaths {
  sessionScoped: string;
  legacy: string;
  effectiveRead: ReadPath;   // string & { __brand: 'ReadPath' }
  effectiveWrite: WritePath; // string & { __brand: 'WritePath' }
}
```

The brand prevents a hook from silently passing a read-fallback path to a writer (or vice versa) — TypeScript rejects the cross-assignment at compile time. The only legitimate producer of the brand is `resolveSessionStatePaths()` itself; an ESLint `no-restricted-syntax` rule in `eslint.config.js` blocks `as ReadPath` / `as WritePath` casts anywhere outside `worktree-paths.ts` and its tests. Compile-time regression guard at `src/lib/__tests__/session-state-paths.type-test.ts`.

#### Legacy state migration (`OMC_MIGRATE_LEGACY_STATE`)

When you adopt `OMC_STATE_DIR` or `.omc-workspace` on a repo that already has existing `{worktree}/.omc/state/` files, you can opt in to a one-shot copy of legacy state into the new session-scoped path:

```bash
export OMC_MIGRATE_LEGACY_STATE=1
```

Semantics:
- **Trigger**: checked once per state-file read by callers that wrap their write through the migration helper.
- **Operation**: copies `{omcRoot}/state/{name}-state.json` → `{omcRoot}/state/sessions/{sessionId}/{name}-state.json` using an atomic `.migrating` sentinel + rename for crash recovery.
- **Idempotent**: a second run with the flag set is a no-op if the session-scoped file already exists.
- **Opt-in only**: never triggers automatically; only when `OMC_MIGRATE_LEGACY_STATE=1` is set.
- **No auto-trigger**: do not set this permanently in your shell profile; set it once for the migration session, then unset it.

#### Rollback / disable multi-repo (`OMC_DISABLE_MULTIREPO`)

If the workspace-marker resolution causes unexpected behaviour (e.g., after dropping a stale `.omc-workspace` marker), you can disable multi-repo path resolution in one env-var flip:

```bash
export OMC_DISABLE_MULTIREPO=1
```

Exact semantics:
- **Skips** `.omc-workspace` marker detection — `findWorkspaceRoot()` returns `null` immediately.
- **Falls back** to the standard `git rev-parse --show-toplevel` → `process.cwd()` resolution order.
- **Preserves** `OMC_STATE_DIR` if set — centralized state storage still works.
- **Scope**: per-process; set in the shell session where you run `claude`, not project-wide.

To restore multi-repo behaviour, unset the variable:

```bash
unset OMC_DISABLE_MULTIREPO
```

#### Ultragoal multi-plan layout

Default layout (single plan, monorepo / single session):

```
.omc/ultragoal/brief.md
.omc/ultragoal/goals.json
.omc/ultragoal/ledger.jsonl
```

Multi-plan layout, enabled by `--plan-id <id>` or `--auto-plan-id` on `omc ultragoal create-goals`:

```
.omc/ultragoal/plans/{planId}/brief.md
.omc/ultragoal/plans/{planId}/goals.json
.omc/ultragoal/plans/{planId}/ledger.jsonl
```

`--auto-plan-id` derives `{epochMs}-{slug}` from the brief title, so two parallel sessions running `omc ultragoal create-goals --auto-plan-id ...` never collide. Subsequent commands (`status`, `add-goal`, `complete-goals`, `checkpoint`, `record-review-blockers`) auto-resolve the plan when there is exactly one; when there are multiple, they require `--plan-id <id>`. `omc ultragoal list-plans` enumerates the available plan ids.

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

### Company Context via MCP

OMC also supports a narrow company-context contract on top of the existing MCP surface.

Configure it in the standard OMC config files:

- Project: `.claude/omc.jsonc`
- User: `~/.config/claude-omc/config.jsonc`

```jsonc
{
  "companyContext": {
    "tool": "mcp__vendor__get_company_context",
    "onError": "warn",
  },
}
```

- `tool` is the full MCP tool name to call.
- `onError` controls prompt-level fallback: `warn`, `silent`, or `fail`.
- The MCP server itself is still registered through the normal Claude/OMC MCP setup path.

This remains a prompt-level workflow contract, not runtime enforcement. For the full interface, trigger stages, and trust boundary, see [company-context-interface.md](./company-context-interface.md).

### Agent Customization

Edit agent files in `~/.claude/agents/` to customize behavior:

```yaml
---
name: architect
description: Your custom description
tools: Read, Grep, Glob, Bash, Edit
model: opus # or sonnet, haiku
# Optional: effort inherits from the parent Claude Code session unless you add an explicit override.
# effort: high
---
Your custom system prompt here...
```

Bundled OMC agent prompts currently do **not** ship an `effort:` frontmatter field. Any effort language inside `agents/*.md` is behavioral guidance for the prompt body, while runtime effort inherits from the parent Claude Code session unless the agent markdown explicitly declares an override.

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

## Runtime storage and goal artifacts

OMC documentation should describe goal and workflow artifacts by their logical role first, then map that role to the runtime-specific storage root. Do not treat `.omx/` as a universal path: it is the legacy OMX runtime root, while OMC uses `.omc/` for local project state.

### Runtime root mapping

| Runtime                      | Project-local root     | User/global root            | Notes                                                                                                                                                   |
| ---------------------------- | ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OMC                          | `.omc/`                | `~/.omc/`                   | Canonical OMC storage for project-local state, plans, notepads, logs, research, and ask artifacts.                                                      |
| OMX compatibility/runtime-v1 | `.omx/`                | `~/.omx/`                   | Compatibility root for older OMX sessions and cross-runtime handoffs. Mention only when documenting OMX-specific behavior.                              |
| OMO native                   | runtime-owned OMO path | runtime-owned OMO user path | OMO-native storage is owned by that runtime. OMC docs should name the logical artifact role unless an OMO command explicitly documents a concrete path. |

### Logical goal artifact roles

Use these names when writing docs or handoffs so the same concept remains portable across OMC, OMX compatibility, and OMO-native runtimes:

| Logical role            | OMC path                                                                   | OMX compatibility path                                                     | Purpose                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal/spec artifact      | `.omc/specs/<slug>.md` or `.omc/plans/<slug>.md`                           | `.omx/specs/<slug>.md` or `.omx/plans/<slug>.md`                           | Durable statement of the user goal, constraints, acceptance criteria, and execution handoff.                                                                                       |
| Approved execution plan | `.omc/plans/<slug>.md`                                                     | `.omx/plans/<slug>.md`                                                     | Reviewed implementation plan consumed by execution workflows such as team or ralph.                                                                                                |
| Task/runtime state      | `.omc/state/<mode>.json` or `.omc/state/sessions/<session-id>/<mode>.json` | `.omx/state/<mode>.json` or `.omx/state/sessions/<session-id>/<mode>.json` | Machine-readable workflow state. Session-scoped state wins over legacy flat files when present.                                                                                    |
| Team coordination state | `.omc/state/team/<team-name>/...`                                          | `.omx/state/team/<team-name>/...`                                          | Worker task files, mailbox, status, events, and dispatch metadata. Worktree-backed workers should use `OMC_TEAM_STATE_ROOT`/compat env to find the leader-owned coordination root. |
| Ask/advisor artifacts   | `.omc/artifacts/ask/<provider>-<slug>-<timestamp>.md`                      | `.omx/artifacts/ask/<provider>-<slug>-<timestamp>.md`                      | Persisted advisor output from `omc ask` or compatibility wrappers.                                                                                                                 |
| Plan-scoped notepad     | `.omc/notepads/<plan-name>/`                                               | `.omx/notepads/<plan-name>/`                                               | Durable notes gathered while planning or executing a named goal.                                                                                                                   |
| Project memory          | `.omc/project-memory.json` and `.omc/notepad.md`                           | `.omx/project-memory.json` and `.omx/notepad.md`                           | Reusable project facts and session notes.                                                                                                                                          |

When an environment variable such as `OMC_STATE_DIR` centralizes storage, resolve the OMC project-local root through that setting before expanding the paths above. In docs, phrase this as "the OMC state root" or "the team coordination root" when the exact filesystem path may vary.

### `/goal` interoperability notes

Claude Code's `/goal` feature owns its hidden goal state. OMC integrations should not mutate hidden Claude Code goal storage directly. When OMC needs a goal-related artifact, create or update an explicit OMC artifact such as `.omc/specs/<slug>.md`, `.omc/plans/<slug>.md`, or `.omc/state/<mode>.json` and record any `/goal` relationship as metadata or prose in that artifact.

For cross-runtime handoffs:

- Prefer logical names such as "approved execution plan" or "team coordination root" over hardcoded `.omx/...` paths.
- Use `.omc/...` examples for OMC-facing docs and commands.
- Use `.omx/...` examples only for OMX compatibility behavior.
- For OMO-native behavior, link to or quote the OMO command's documented path instead of inventing an OMC/OMX path.

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

| Your setup                            | Launch command                                               | Setup command                   | Expected behavior                                                   |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------- |
| **Marketplace plugin** (recommended)  | `omc` or `claude` (default)                                  | `omc setup`                     | Normal: agents/skills copied to `~/.claude/`                        |
| **Local dev checkout, want OMC shim** | `omc --plugin-dir /path`                                     | `omc setup --plugin-dir-mode`   | Dev mode: agents/skills loaded from `/path`, not copied             |
| **Local dev checkout, no OMC shim**   | `claude --plugin-dir /path` + `export OMC_PLUGIN_ROOT=/path` | `omc setup --plugin-dir-mode`   | Dev mode + manual env: agents/skills loaded from `/path`            |
| **Local dev, want bundled skills**    | `omc --plugin-dir /path`                                     | `omc setup --no-plugin`         | Forces local bundled skills to `~/.claude/skills/`, ignoring plugin |
| **Troubleshooting a specific path**   | N/A                                                          | `omc doctor --plugin-dir /path` | Diagnostics show status for `/path`                                 |

---

## CLI Commands: ask/team/session

### `omc ask`

```bash
omc ask claude "review this patch"
omc ask codex "review this patch from a security perspective"
omc ask gemini --prompt "suggest UX improvements"
omc ask antigravity --prompt "suggest UX improvements"
omc ask cursor --prompt "apply this implementation plan"
omc ask claude --agent-prompt executor --prompt "create an implementation plan"
```

- Provider matrix: `claude | codex | gemini | antigravity | grok | cursor`
- Artifacts: `.omc/artifacts/ask/{provider}-{slug}-{timestamp}.md`
- Canonical env vars: `OMC_ASK_ADVISOR_SCRIPT`, `OMC_ASK_ORIGINAL_TASK`
- Phase-1 aliases (deprecated warning): `OMX_ASK_ADVISOR_SCRIPT`, `OMX_ASK_ORIGINAL_TASK`
- Skill entrypoint: `/oh-my-claudecode:ask <claude|codex|gemini|antigravity|grok|cursor> <prompt>` routes to this command

### `omc team` (CLI runtime surface)

```bash
omc team 2:codex "review auth flow"
omc team status review-auth-flow
omc team shutdown review-auth-flow --force
omc team api claim-task --input '{"team_name":"auth-review","task_id":"1","worker":"worker-1"}' --json
```

Supported entrypoints: direct start (`omc team [N:agent] "<task>"`), `status`, `shutdown`, and `api`.

Native team worker worktrees are an opt-in/config-gated runtime-v2 rollout. See [Native Team Worktree Mode](TEAM-WORKTREE-MODE.md) for the worktree path contract, canonical `OMC_TEAM_STATE_ROOT` behavior, status fields, and dirty-worktree cleanup policy.

Topology behavior:

- inside classic tmux (`$TMUX` set): reuse the current tmux surface for split-pane or `--new-window` layouts
- inside cmux (`CMUX_SURFACE_ID` without `$TMUX`): create native cmux splits for visible team workers
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

### `omc session friction report`

```bash
omc session friction report --since 24h
omc session friction report --project all --json
```

- Local-only/offline report over Claude transcript files, `.omc/sessions/*.json`, and `.omc/state/agent-replay-*.jsonl`
- Does not print raw prompt, response, or tool-result content by default; output uses counts, sizes, timestamps, and signal codes
- Highlights context-bloat and operator-friction indicators such as high estimated context usage, large JSONL entries, tool error rates, long idle gaps, failed agents, and hook noise
- Supports `--limit`, `--session`, `--since`, `--project`, and `--json`

### Non-interactive automation and CI/CD

Use OMC's terminal and library surfaces in non-interactive environments:

- Run CLI commands that have deterministic exit codes, for example `omc setup`, `omc ask ...`, `omc session search ... --json`, or repo-owned verification scripts such as `npm run sync-metadata:verify`.
- Provide authentication through runner environment variables (`ANTHROPIC_API_KEY`) or pre-authenticated provider CLIs for `codex`, `gemini`, `antigravity`, `grok`, or `cursor` when using `omc ask` / `omc team`.
- Keep state explicit for ephemeral runners by setting `OMC_STATE_DIR` when state must survive worktree deletion or checkout replacement.
- Avoid interactive slash skills (`/autopilot`, `/ralph`, `/ultrawork`, `/deep-interview`, `/team`) in CI jobs; they require an active Claude Code session and user-visible conversation loop.
- OMC does not currently provide a VS Code extension or VS Code-specific automation contract. The documented IDE path is to use Claude Code's own integrations, then install OMC through the Claude Code plugin surface.
- Programmatic Agent SDK usage is supported through the exported TypeScript helpers and the in-process MCP server helpers in this package; it is a Node.js library surface, not an interactive plugin installer.

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

| Field          | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `kind`         | Artifact type such as `plan`, `prompt`, `result`, or `trace` |
| `path`         | Durable artifact path                                        |
| `contentHash?` | Optional integrity hint                                      |
| `createdAt`    | Artifact creation timestamp                                  |
| `producer`     | Owning worker/tool/skill                                     |
| `sizeBytes?`   | Optional size for threshold checks                           |
| `retention`    | Retention/ownership hint                                     |
| `expiresAt?`   | Optional expiry for short-lived artifacts                    |

Bounded handoff policy:

1. Keep small payloads inline only when the call site's explicit threshold allows it.
2. For larger payloads, pass a short summary plus the descriptor.
3. Keep durable content in artifact paths such as `.omc/plans/`, `.omc/prompts/`, and related artifact stores rather than embedding full bodies into queue or status records.

## Agents (29 Total)

Always use `oh-my-claudecode:` prefix when calling via Task tool.

### By Domain and Tier

| Domain             | LOW (Haiku)             | MEDIUM (Sonnet)       | HIGH (Opus)         |
| ------------------ | ----------------------- | --------------------- | ------------------- |
| **Analysis**       | `architect-low`         | `architect-medium`    | `architect`         |
| **Execution**      | `executor-low`          | `executor`            | `executor-high`     |
| **Search**         | `explore`               | -                     | `explore-high`      |
| **Research**       | -                       | `document-specialist` | -                   |
| **Frontend**       | `designer-low`          | `designer`            | `designer-high`     |
| **Docs**           | `writer`                | -                     | -                   |
| **Visual**         | -                       | `vision`              | -                   |
| **Planning**       | -                       | -                     | `planner`           |
| **Critique**       | -                       | -                     | `critic`            |
| **Pre-Planning**   | -                       | -                     | `analyst`           |
| **Testing**        | -                       | `qa-tester`           | -                   |
| **Tracing**        | -                       | `tracer`              | -                   |
| **Security**       | `security-reviewer-low` | -                     | `security-reviewer` |
| **Build**          | -                       | `debugger`            | -                   |
| **TDD**            | -                       | `test-engineer`       | -                   |
| **Code Review**    | -                       | -                     | `code-reviewer`     |
| **Data Science**   | -                       | `scientist`           | `scientist-high`    |
| **Git**            | -                       | `git-master`          | -                   |
| **Simplification** | -                       | -                     | `code-simplifier`   |

### Agent Selection Guide

| Task Type                      | Best Agent                                                             | Model  |
| ------------------------------ | ---------------------------------------------------------------------- | ------ |
| Quick code lookup              | `explore`                                                              | haiku  |
| Find files/patterns            | `explore`                                                              | haiku  |
| Complex architectural search   | `explore-high`                                                         | opus   |
| Simple code change             | `executor-low`                                                         | haiku  |
| Feature implementation         | `executor`                                                             | sonnet |
| Complex refactoring            | `executor-high`                                                        | opus   |
| Debug simple issue             | `architect-low`                                                        | haiku  |
| Debug complex issue            | `architect`                                                            | opus   |
| UI component                   | `designer`                                                             | sonnet |
| Complex UI system              | `designer-high`                                                        | opus   |
| Write docs/comments            | `writer`                                                               | haiku  |
| Research docs/APIs             | `document-specialist` (repo docs first; optional Context Hub / `chub`) | sonnet |
| Analyze images/diagrams        | `vision`                                                               | sonnet |
| Strategic planning             | `planner`                                                              | opus   |
| Review/critique plan           | `critic`                                                               | opus   |
| Pre-planning analysis          | `analyst`                                                              | opus   |
| Test CLI interactively         | `qa-tester`                                                            | sonnet |
| Evidence-driven causal tracing | `tracer`                                                               | sonnet |
| Security review                | `security-reviewer`                                                    | sonnet |
| Quick security scan            | `security-reviewer-low`                                                | haiku  |
| Fix build errors               | `debugger`                                                             | sonnet |
| Simple build fix               | `debugger` (model=haiku)                                               | haiku  |
| TDD workflow                   | `test-engineer`                                                        | sonnet |
| Quick test suggestions         | `test-engineer` (model=haiku)                                          | haiku  |
| Code review                    | `code-reviewer`                                                        | opus   |
| Quick code check               | `code-reviewer` (model=haiku)                                          | haiku  |
| Data analysis/stats            | `scientist`                                                            | sonnet |
| Quick data inspection          | `scientist` (model=haiku)                                              | haiku  |
| Complex ML/hypothesis          | `scientist-high`                                                       | opus   |
| Git operations                 | `git-master`                                                           | sonnet |
| Code simplification            | `code-simplifier`                                                      | opus   |

---

## Goal Workflow UX: `/goal`, Ralph, Team, UltraQA, Ultragoal

OMC exposes several ways to pursue a goal-shaped task. They are complementary, not interchangeable. Choose one primary loop authority per session and use the others as evidence producers or handoff targets.

| Surface                 | Runtime owner                                     | User-facing promise                                           | Completion evidence                                                          | Notes                                                                                                                                                           |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code `/goal`     | Claude Code native session loop                   | Keep working toward one stated completion condition           | Evidence surfaced in the conversation for the `/goal` evaluator              | Cite Claude Code/Anthropic docs or changelog only for `/goal` behavior. The evaluator must not be described as independently running commands or reading files. |
| Ralph                   | OMC skill + Stop-hook enforcement                 | Persistent single-owner implementation until PRD stories pass | Tests/build/lint/typecheck plus reviewer verification                        | Prefer when correctness depends on OMC's PRD, progress, and reviewer gates.                                                                                     |
| Team                    | OMC native/team or CLI team runtime               | Coordinated multi-agent execution over assigned tasks         | Worker task results, commits, staged `team-verify`/`team-fix` evidence       | Prefer when ownership boundaries and parallel lanes matter.                                                                                                     |
| UltraQA                 | OMC QA cycling skill                              | Repeat diagnose/fix cycles until a quality gate passes        | Command output from the requested QA goal each cycle                         | Prefer after the implementation target is known but verification still fails.                                                                                   |
| Artifact-only Ultragoal | Durable goal ledger/checkpoints/handoff artifacts | Track goal state without starting another active loop         | Goal artifact, checkpoints, handoff prompt, attached command/review evidence | Prefer when `/goal` is unavailable, unsafe, or conflicts with an active OMC loop.                                                                               |

### `/goal` source and evidence boundary

Use Claude Code/Anthropic sources for `/goal` facts, including:

- Claude Code `/goal` documentation: <https://code.claude.com/docs/en/goal>
- Anthropic Claude Code changelog: <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>

Do not cite OpenAI/Codex documentation as authority for Claude Code `/goal`. In OMC docs, examples, and handoff prompts, keep this limitation explicit: the `/goal` evaluator judges visible conversation evidence. It should not be described as independently executing shell commands, reading files, inspecting hidden state, or replacing OMC's final review gates.

### Recommended conflict handling

When multiple loops could apply, use this deterministic policy:

1. **refuse**: if Ralph, Team, UltraQA, autopilot, or another Stop-hook loop is already active and a new `/goal` would compete for continuation authority.
2. **adopt_existing**: if Claude Code `/goal` is already active and the OMC workflow can attach evidence to that same condition without changing loop ownership.
3. **artifact_only**: if `/goal` is unavailable because of hooks/trust/settings, or if the user only needs durable planning, checkpointing, and evidence capture.

`/goal` evaluator success can be useful evidence, but OMC completion should still require the relevant durable proof: command output, changed files, reviewer verdicts, task results, or release artifacts.

For the shorter user-facing chooser, see [Mode Selection Guide](./shared/mode-selection-guide.md#goal-oriented-workflow-selection).

## Skills (38 Total)

Includes bundled workflow, utility, domain, and compatibility skills. Runtime truth comes from the builtin skill loader scanning `skills/*/SKILL.md` and expanding aliases declared in frontmatter.

Marketplace/plugin installs compact the native plugin `skills/*/SKILL.md` files during `omc setup`: Claude Code receives concise registry descriptions for every bundled skill, while the full on-demand instructions are preserved under `skill-bodies/*/SKILL.md` and loaded by OMC when a skill is invoked. Source checkouts and standalone installs keep the full `skills/*/SKILL.md` bodies in place.



| Skill                     | Description                                                      | Manual Command                              |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `ai-slop-cleaner`         | Anti-slop cleanup workflow with optional reviewer-only `--review` pass | `/oh-my-claudecode:ai-slop-cleaner`         |
| `ask`                     | Ask Claude, Codex, Gemini, Antigravity, or Grok via local CLI and capture a reusable artifact | `/oh-my-claudecode:ask`               |
| `autoresearch`            | Stateful single-mission evaluator-driven improvement loop           | `/oh-my-claudecode:autoresearch`            |
| `autopilot`               | Full autonomous execution from idea to working code              | `/oh-my-claudecode:autopilot`               |
| `cancel`                  | Unified cancellation for active modes                            | `/oh-my-claudecode:cancel`                  |
| `ccg`                     | Tri-model workflow via `ask codex` + `ask antigravity`, then Claude synthesis | `/oh-my-claudecode:ccg`                     |
| `configure-notifications` | Configure notification integrations (Telegram, Discord, Slack) via natural language | `/oh-my-claudecode:configure-notifications` |
| `deep-dive`               | Two-stage trace → deep-interview pipeline with context handoff   | `/oh-my-claudecode:deep-dive`               |
| `deep-interview`          | Socratic deep interview with ambiguity gating                    | `/deep-interview`                           |
| `deepinit`                | Generate hierarchical AGENTS.md docs                             | `/oh-my-claudecode:deepinit`                |
| `external-context`        | Parallel document-specialist research                            | `/oh-my-claudecode:external-context`        |
| `hud`                     | Configure HUD/statusline                                         | `/oh-my-claudecode:hud`                     |
| `skillify`                | Extract reusable skill from session                              | `/oh-my-claudecode:skillify`                |
| `learner`                 | **Deprecated** compatibility alias for `skillify`                | `/oh-my-claudecode:learner`                 |
| `mcp-setup`               | Configure MCP servers                                            | `/oh-my-claudecode:mcp-setup`               |
| `omc-doctor`              | Diagnose and fix installation issues                             | `/oh-my-claudecode:omc-doctor`              |
| `omc-plan`                | Planning workflow (`/plan` safe alias; bundled directory ID is `plan`) | `/oh-my-claudecode:plan`                    |
| `omc-reference`           | Detailed OMC agent/tools/team/commit reference skill             | Auto-loaded reference only                  |
| `omc-setup`               | One-time setup wizard                                            | `/oh-my-claudecode:omc-setup`               |
| `omc-teams`               | Spawn `claude`/`codex`/`gemini`/`antigravity`/`grok`/`cursor` tmux workers for parallel execution | `/oh-my-claudecode:omc-teams`             |
| `project-session-manager` | Manage isolated dev environments (git worktrees + tmux)          | `/oh-my-claudecode:project-session-manager` |
| `psm` | **Deprecated** compatibility alias for `project-session-manager` | `/oh-my-claudecode:psm` |
| `ralph`                   | Persistence loop until verified completion                       | `/oh-my-claudecode:ralph`                   |
| `ralplan`                 | Consensus planning alias for `/plan --consensus`                 | `/oh-my-claudecode:ralplan`                 |
| `release`                 | Automated release workflow                                       | `/oh-my-claudecode:release`                 |
| `self-improve`            | Autonomous evolutionary code improvement engine with tournament selection; artifacts are topic-scoped under `.omc/self-improve/topics/<topic-slug>/` by default, with flat `.omc/self-improve/` preserved for legacy single-track resumes | `/oh-my-claudecode:self-improve`    |
| `setup`                   | Unified setup entrypoint for install, diagnostics, and MCP configuration | `/oh-my-claudecode:setup`              |
| `sciomc`                  | Parallel scientist orchestration                                 | `/oh-my-claudecode:sciomc`                  |
| `skill`                   | Manage local skills (list/add/remove/search/edit)                | `/oh-my-claudecode:skill`                   |
| `team`                    | Coordinated multi-agent workflow                                 | `/oh-my-claudecode:team`                    |
| `trace`                   | Evidence-driven tracing lane with parallel tracer hypotheses     | `/oh-my-claudecode:trace`                   |
| `ultraqa`                 | QA cycle until goal is met                                       | `/oh-my-claudecode:ultraqa`                 |
| `ultrawork`               | Maximum parallel throughput mode                                 | `/oh-my-claudecode:ultrawork`               |
| `visual-verdict`          | Structured visual QA verdict for screenshot/reference comparisons | `/oh-my-claudecode:visual-verdict`          |
| `wiki`                    | LLM Wiki — persistent markdown knowledge base that compounds across sessions | `/oh-my-claudecode:wiki`           |
| `writer-memory`           | Agentic memory system for writing projects                       | `/oh-my-claudecode:writer-memory`           |


---

## Slash Commands

Most installed skills are exposed as `/oh-my-claudecode:<skill-name>`. Deep Interview is intentionally documented with the short `/deep-interview` path because that path receives OMC's rendered runtime threshold guidance before the interview starts. The skills table above is the full runtime-backed list; the commands below highlight common entrypoints and aliases. Compatibility keyword modes like `deep-analyze` and `tdd` are prompt-triggered behaviors, not standalone slash commands. OMC's manual compaction helper is plugin-scoped as `/oh-my-claudecode:compact`; bare `/compact` remains Claude Code's native command and is not shadowed by OMC. The helper preserves the user's note and instructs them to run bare `/compact`; OMC does not invoke native compaction itself because Claude Code's built-in `/compact` is not a prompt skill.

| Command                                                  | Description                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/oh-my-claudecode:ai-slop-cleaner <target>`             | Run the anti-slop cleanup workflow (`--review` for reviewer-only pass)                        |
| `/oh-my-claudecode:ask <claude\|codex\|gemini\|antigravity\|grok\|cursor> <prompt>` | Route a prompt through the selected advisor CLI and capture an ask artifact                   |
| `/oh-my-claudecode:autopilot <task>`                     | Full autonomous execution                                                                     |
| `/oh-my-claudecode:configure-notifications`              | Configure notification integrations                                                           |
| `/oh-my-claudecode:compact [note]`                        | Prepare an OMC-safe manual handoff telling the user to run bare `/compact [note]`              |
| `/oh-my-claudecode:deep-dive <problem>`                  | Run the trace → deep-interview pipeline                                                       |
| `/deep-interview <idea>`                                 | Socratic interview with ambiguity scoring before execution                                    |
| `/oh-my-claudecode:deepinit [path]`                      | Index codebase with hierarchical AGENTS.md files                                              |
| `/oh-my-claudecode:mcp-setup`                            | Configure MCP servers                                                                         |
| `/oh-my-claudecode:omc-doctor`                           | Diagnose and fix installation issues                                                          |
| `/oh-my-claudecode:plan <description>`                   | Start planning session (supports consensus structured deliberation)                           |
| `/oh-my-claudecode:omc-setup`                            | One-time setup wizard                                                                         |
| `/oh-my-claudecode:omc-teams <N>:<agent> <task>`         | Spawn `claude`/`codex`/`gemini`/`antigravity`/`grok`/`cursor` tmux workers for legacy parallel execution                    |
| `/oh-my-claudecode:project-session-manager <arguments>`  | Manage isolated dev environments with git worktrees + tmux                                    |
| `/oh-my-claudecode:psm <arguments>`                      | Deprecated alias for project session manager                                                  |
| `/oh-my-claudecode:ralph <task>`                         | Self-referential loop until task completion (`--critic=architect \| critic \| codex`)       |
| `/oh-my-claudecode:ralplan <description>`                | Iterative planning with consensus structured deliberation (`--deliberate` for high-risk mode) |
| `/oh-my-claudecode:release`                              | Automated release workflow                                                                    |
| `/oh-my-claudecode:setup`                                | Unified setup entrypoint (`setup`, `setup doctor`, `setup mcp`)                               |
| `/oh-my-claudecode:sciomc <topic>`                       | Parallel research orchestration                                                               |
| `/oh-my-claudecode:team <N>:<agent> <task>`              | Coordinated native team workflow                                                              |
| `/oh-my-claudecode:trace`                                | Evidence-driven tracing lane that orchestrates parallel tracer hypotheses in team mode        |
| `/oh-my-claudecode:ultraqa <goal>`                       | Autonomous QA cycling workflow                                                                |
| `/oh-my-claudecode:ultrawork <task>`                     | Maximum performance mode with parallel agents                                                 |
| `/oh-my-claudecode:visual-verdict <task>`                | Structured visual QA verdict for screenshot/reference comparisons                             |


### Skill Pipeline Metadata (Preview)

Built-in skills and slash-loaded skills can now declare a lightweight pipeline/handoff contract in frontmatter:

```yaml
pipeline: [deep-interview, plan, autopilot]
next-skill: plan
next-skill-args: --consensus --direct
handoff: .omc/specs/deep-interview-{slug}.md
```

When present, OMC appends a standardized **Skill Pipeline** section to the rendered skill prompt so the current stage, handoff artifact, and explicit next `Skill("oh-my-claudecode:...")` invocation are carried forward consistently.

### Skills 2.0 Compatibility (MVP)

OMC's canonical project-local skill directory remains `.omc/skills/`, and the runtime also reads Claude Code project skills from `.claude/skills/` plus compatibility skills from `.agents/skills/`.

For builtin and slash-loaded skills, OMC also appends a standardized **Skill Resources** section when the skill directory contains bundled assets such as helper scripts, templates, or support libraries. This helps agents reuse packaged skill resources instead of recreating them ad hoc.

---

## Claude Code `/goal` Adapter Design

OMC treats Claude Code `/goal` as a native execution loop that can be handed off to, not as the durable source of truth for OMC completion. The design contract is documented in [docs/design/CLAUDE_CODE_GOAL_ADAPTER.md](./design/CLAUDE_CODE_GOAL_ADAPTER.md).

Key contract points:

- Claude Code `/goal` facts must cite Claude Code or Anthropic sources only. OpenAI/Codex references are comparison sources, not authority for Claude Code behavior.
- The adapter renders a measurable `/goal <condition>` handoff; it must not mutate hidden Claude Code session state directly.
- The deterministic conflict policy is exactly one of `refuse`, `adopt_existing`, or `artifact_only`; competing Ralph/autopilot/Stop-hook/Team/UltraQA loops must not continue with only a warning.
- `/goal` evaluator success is evidence for OMC final review, not completion by itself; OMC still requires surfaced command/test/docs evidence.
- OMC stores durable goal ledgers and evidence under OMC-owned logical artifacts and `.omc/`-resolved paths, not hardcoded `.omx/` paths.

---

## Hooks System

OMC registers 21 hook scripts across 11 Claude Code lifecycle events. For detailed documentation, see [HOOKS.md](./HOOKS.md).

### Hooks by Lifecycle Event

| Event                  | Scripts                                                                                                           | Timeout          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| **UserPromptSubmit**   | `keyword-detector.mjs`, `skill-injector.mjs`                                                                      | 10s, 15s         |
| **SessionStart**       | `session-start.mjs`, `project-memory-session.mjs`, `setup-init.mjs` (init), `setup-maintenance.mjs` (maintenance) | 5s, 5s, 30s, 60s |
| **PreToolUse**         | `pre-tool-enforcer.mjs`                                                                                           | 3s               |
| **PermissionRequest**  | `permission-handler.mjs` (Bash only)                                                                              | 5s               |
| **PostToolUse**        | `post-tool-verifier.mjs`, `project-memory-posttool.mjs`                                                           | 3s, 3s           |
| **PostToolUseFailure** | `post-tool-use-failure.mjs`                                                                                       | 3s               |
| **SubagentStart**      | `subagent-tracker.mjs start`                                                                                      | 3s               |
| **SubagentStop**       | `subagent-tracker.mjs stop`, `verify-deliverables.mjs`                                                            | 5s, 5s           |
| **PreCompact**         | `pre-compact.mjs`, `project-memory-precompact.mjs`                                                                | 10s, 5s          |
| **Stop**               | `context-guard-stop.mjs`, `workflow-drift-guard.mjs`, `persistent-mode.cjs`, `code-simplifier.mjs`                | 5s, 3s, 10s, 5s  |
| **SessionEnd**         | `session-end.mjs`                                                                                                 | 30s              |

> **Note**: autopilot, ralph, ultrawork, and ultraqa are **skills** (activated via keyword-detector), not hooks. The `persistent-mode.cjs` hook enforces their continuation by blocking the Stop event.

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

| Keyword                                                                        | Effect                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `ultrawork`, `ulw`, `uw`                                                       | Activates parallel agent orchestration                                                        |
| `autopilot`, `build me`, `I want a`, `handle it all`, `end to end`, `e2e this` | Full autonomous execution                                                                     |
| `deslop`, `anti-slop`, cleanup/refactor + slop smells                          | Anti-slop cleanup workflow (`ai-slop-cleaner`)                                                |
| `ralph`, `don't stop`, `must complete`, `until done`                           | Persistence until verified complete                                                           |
| `ccg`, `claude-codex-gemini`                                                   | Claude-Codex-Gemini orchestration (use `antigravity` when using the Antigravity CLI)         |
| `ralplan`                                                                      | Iterative planning consensus with structured deliberation (`--deliberate` for high-risk mode) |
| `deep interview`, `ouroboros`                                                  | Deep Socratic interview with mathematical clarity gating                                      |
| `deepsearch`, `search the codebase`, `find in codebase`                        | Codebase-focused search mode                                                                  |
| `deepanalyze`, `deep-analyze`                                                  | Deep analysis mode                                                                            |
| `ultrathink`, `think hard`, `think deeply`                                     | Deep reasoning mode                                                                           |
| `tdd`, `test first`, `red green`                                               | TDD workflow enforcement                                                                      |
| `code review`, `review code`                                                   | Comprehensive code review mode                                                                |
| `security review`, `review security`                                           | Security-focused review mode                                                                  |
| `cancelomc`, `stopomc`                                                         | Unified cancellation                                                                          |

### Localized triggers (Korean / Japanese)

The keyword detector recognizes localized aliases in addition to the English trigger phrases above. Each alias maps to the same skill/mode as its English counterpart:

| Keyword          | Korean      | Japanese           |
| ---------------- | ----------- | ------------------ |
| `ralph`          | 랄프        | ラルフ             |
| `autopilot`      | 오토파일럿  | オートパイロット   |
| `ultrawork`      | 울트라워크  | ウルトラワーク     |
| `ralplan`        | 랄플랜      | ラルプラン         |
| `ultrathink`     | 울트라씽크  | ウルトラシンク     |
| `ccg`            | 씨씨지      | シーシージー       |
| `deep-interview` | 딥인터뷰    | ディープインタビュー |
| `tdd`            | 테스트 퍼스트 | テスト ファースト |
| `code-review`    | 코드 리뷰   | コード レビュー    |
| `security-review`| 보안 리뷰   | セキュリティ レビュー |
| `deepsearch`     | 딥 서치     | ディープ サーチ    |
| `analyze`        | 딥 분석     | ディープ アナライズ |

`cancelomc` / `stopomc` have no localized alias (cancellation is matched only by the English tokens).

#### Localized routing behavior

- **Substring matching (aggressive routing).** Korean and Japanese have no ASCII word boundary, so localized aliases are matched as substrings rather than whole words. This is intentional: a localized alias embedded in a longer noun phrase still routes — e.g. `コードレビュー記事を要約して` ("summarize this code-review article") activates **code-review** mode. Prefer the English form, or phrase around the alias, if you do not want that behavior.
- **Reviewer-suffix guard.** `code-review` / `security-review` use a negative lookahead so "reviewer"-style nouns do not trigger review mode: `(?!어)` blocks Korean 리뷰어, and `(?!ア)` blocks any Japanese レビューア… form (e.g. レビューアー).
- **Informational suppression.** Help-style questions are suppressed and pass through without activating a mode — e.g. Korean `뭐야` / Japanese `とは` / `使い方` near an alias.
- **Difference questions.** Japanese "difference" phrasing — `…の違いを教えて`/`違いを説明`/`違いを知りたい` and `どう違う`/`何が違う`/`どこが違う` (e.g. `ディープサーチと普通の検索の違いを教えて`) — is treated as informational and suppressed. A work verb after `違い` (e.g. `違いを修正して`) is **not** suppressed and still activates.

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

> **Windows**: Native Windows (win32) support is experimental. Features that launch tmux-backed worker panes require a tmux-compatible binary. OMC supports native [psmux](https://github.com/psmux/psmux) for PowerShell 7+ users who want visible Claude Code teammate panes in interactive team workflows, and recommends WSL2 as the fallback when no compatible `tmux` command is installed or native Windows behavior is insufficient. psmux does not force worktree agents, non-interactive/print-mode agents, or model-selected in-process agents into visible panes. Native Windows issues may have limited support.

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

| Feature                   | Description                                           | Access                                 |
| ------------------------- | ----------------------------------------------------- | -------------------------------------- |
| **Agent Observatory**     | Real-time agent status, efficiency, bottlenecks       | HUD / API                              |
| **Session-End Summaries** | Persisted per-session summaries and callback payloads | `.omc/sessions/*.json`, `session-end`  |
| **Session Replay**        | Event timeline for post-session analysis              | `.omc/state/agent-replay-*.jsonl`      |
| **Session Search**        | Search prior local transcript/session artifacts       | `omc session search`, `session_search` |
| **Intervention System**   | Auto-detection of stale agents, cost overruns         | Automatic                              |

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

| Element      | Description                                                                                                          | Default |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ------- |
| `cwd`        | Show current working directory                                                                                       | `false` |
| `gitRepo`    | Show git repository name                                                                                             | `false` |
| `gitBranch`  | Show current git branch                                                                                              | `false` |
| `omcLabel`   | Show [OMC] label                                                                                                     | `true`  |
| `updateNotification` | Show available-update prompt text after the OMC label                                                                  | `true`  |
| `contextBar` | Show context window usage                                                                                            | `true`  |
| `agents`     | Show active agents count                                                                                             | `true`  |
| `todos`      | Show todo progress                                                                                                   | `true`  |
| `ralph`      | Show ralph loop status                                                                                               | `true`  |
| `autopilot`  | Show autopilot status                                                                                                | `true`  |
| `showTokens` | Show transcript-derived token usage (`tok:i1.2k/o340`, plus `r...` reasoning and `s...` session total when reliable) | `false` |

Additional `omcHud` layout and label options (top-level):

| Option     | Description                                                                       | Default    |
| ---------- | --------------------------------------------------------------------------------- | ---------- |
| `maxWidth` | Maximum HUD line width (terminal columns)                                         | unset      |
| `wrapMode` | `truncate` (ellipsis) or `wrap` (break at `\|` boundaries) when `maxWidth` is set | `truncate` |
| `locale`   | HUD label preset. Supported values: `en`, `zh-CN`                                 | `en`       |
| `labels`   | Per-label HUD text overrides; supported keys only                                 | unset      |

`locale` and `labels` affect only HUD labels. English remains the default, unsupported locale values and unknown label keys are ignored, and explicit `labels` override the locale preset. Supported label keys are `context`, `tokens`, `tool`, `agent`, `skill`, `ralph`, `background`, `thinking`, `staged`, `modified`, `untracked`, `ahead`, and `behind`.

Example:

```json
{
  "omcHud": {
    "locale": "zh-CN",
    "labels": {
      "context": "CTX"
    }
  }
}
```

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
