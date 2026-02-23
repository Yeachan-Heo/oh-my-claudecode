# oh-my-claudecode v4.4.1: HUD hotfix

## Patch Notes

**Fix: HUD disappears after updating to v4.4.0** (#hotfix)

In v4.4.0, `dist/hud/index.js` was changed to export `main` for programmatic use and guard its auto-run with `process.argv[1] === fileURLToPath(import.meta.url)`. This check correctly identifies direct execution (`node dist/hud/index.js`) but **fails when the module is loaded via dynamic `import()` from the `omc-hud.mjs` wrapper** — in that case `process.argv[1]` is the wrapper path, not `index.js`, so `main()` was never called and the HUD silently produced no output.

**Fix:** Remove the direct-execution guard and call `main()` unconditionally. The `export { main }` is preserved for programmatic/watch-loop use.

---

# oh-my-claudecode v4.4.0: tmux CLI Workers, On-Demand Workers, Surgical Pane Cleanup & Security Hardening

This is a major release that rewrites how Codex and Gemini are integrated into OMC. The old MCP server architecture (`x`, `g` providers) has been replaced entirely by a tmux-based CLI worker runtime that spawns real CLI processes in visible panes. Workers are now spun up on demand and torn down immediately when done. Team session cleanup has been hardened to never destroy the user's shell. Several security issues in the MCP surface have been fixed.

---

### Breaking Changes

**Codex/Gemini MCP servers removed** ⚠️

The `x` (Codex) and `g` (Gemini) MCP server providers have been removed. Any `CLAUDE.md` or skill using `mcp__x__ask_codex`, `mcp__g__ask_gemini`, or `ToolSearch("ask_codex")` will no longer work.

- `codexMcpServer`, `codexToolNames`, `geminiMcpServer`, `geminiToolNames` exports removed from `src/mcp/index.ts`.
- The deleted source files — `codex-core.ts`, `codex-server.ts`, `codex-standalone-server.ts`, `gemini-core.ts`, `gemini-server.ts`, `gemini-standalone-server.ts` — are no longer compiled or bundled.
- **Migration**: use `/omc-teams N:codex "task"` or `/omc-teams N:gemini "task"` to spawn Codex/Gemini CLI workers in tmux panes. The `/ccg` skill fans out Codex (analytical) + Gemini (design/UI) tasks simultaneously.
- Keyword detection for `"ask codex"` / `"use gemini"` / `"delegate to codex"` now automatically routes to `/omc-teams` instead of the removed MCP tools.
- `docs/CLAUDE.md` updated: `<mcp_routing>` section removed; `<tools>` section updated with `mcp__team__` tool names; `ccg` skill added to `<skills>`.

---

### New Features

**tmux-based CLI workers (`/omc-teams` skill)**
- Spawn N `claude`, `codex`, or `gemini` CLI processes in tmux split-panes for parallel task execution.
- File-based coordination: each worker reads `inbox.md` and writes `done.json` on completion — no inter-process messaging required.
- MCP tools exposed via the `team` MCP server:
  - `omc_run_team_start` — non-blocking spawn; returns `jobId` immediately
  - `omc_run_team_wait` — blocking poll with exponential backoff (500 ms → 2 s); returns when all workers finish
  - `omc_run_team_status` — non-blocking status check for mid-flight inspection
  - `omc_run_team_cleanup` — kills only worker panes, never `kill-session`
- Default `omc_run_team_wait` timeout is 60 s; on timeout workers keep running — call wait again or cleanup to cancel.

**On-demand worker lifecycle** (#904)
- Workers are spawned only when a task arrives and killed immediately when their task completes.
- Hard per-session timeout removed; workers live exactly as long as their task requires.
- Eliminates idle workers consuming resources during long-running team pipelines.

**`/ccg` skill — Claude-Codex-Gemini tri-model orchestration**
- Fans out backend/analytical tasks to a Codex CLI worker and frontend/UI tasks to a Gemini CLI worker simultaneously.
- Claude synthesizes both results into a unified response.
- Falls back to Claude-only Task agents when Codex or Gemini CLI is not installed.
- Execution protocol updated to use `mcp__team__omc_run_team_start` + `omc_run_team_wait` (removed stale TypeScript `startTeam`/`assignTask`/`monitorTeam`/`shutdownTeam` imports).

---

### Fixed

**Team session cleanup hardening**
- `killWorkerPanes()`: SIGTERM → 10 s grace → SIGKILL escalation per pane; leader-pane guard prevents ever killing the invoking shell; shutdown sentinel written before force-kill so workers can detect graceful shutdown.
- `killTeamSession()`: never calls `kill-session` when `sessionName` contains `:` (split-pane mode); only worker-owned sessions are ever destroyed.
- `omc_run_team_wait` timeout no longer kills workers — it returns a timeout status and leaves workers running so the caller can decide whether to keep waiting or cleanup (#903).
- Pane IDs persisted to `~/.omc/team-jobs/{jobId}-panes.json` immediately after `startTeam()` resolves so cleanup always has valid targets even after a lead crash.

**Exit codes**
- `doShutdown()` in `runtime-cli` now exits with `0` (completed), `1` (failed), or `2` (timeout) instead of always exiting `0`. `team-server` interprets close codes correctly and surfaces them in `taskResults`.

**Windows: false hook error labels** (#899, #902)
- Hooks no longer run `sh` + `find-node.sh` on Windows, which was causing Claude Code to display "hook error" for hooks that completed successfully.

**HUD**
- Plugin-cache lookup now respects `CLAUDE_CONFIG_DIR` (#897), fixing HUD on systems where Claude's config directory is non-default.

**Update checks**
- `session-start.mjs` and `auto-update.ts` now fetch version and install from `oh-my-claude-sisyphus` (the published npm package name) instead of the legacy `oh-my-claudecode` package name.

**Team reliability (from 4.3.x backlog)**
- Hard-kill backstop and orphan PID detection (#901): processes that outlive their pane are forcefully terminated.
- Exit-code propagation from Claude CLI workers: a worker that exits non-zero is now surfaced as `status: failed` in `taskResults`.
- User-scoped job directory `~/.omc/team-jobs/` to avoid cross-user collisions on shared machines.

**Docs & skills sync**
- `docs/CLAUDE.md`: added `mcp__team__` tool names to `<tools>` section; added `ccg` skill entry with trigger patterns; removed stale `<mcp_routing>` section referencing removed providers.
- `skills/ccg/SKILL.md`: replaced stale TypeScript module imports (`startTeam`, `assignTask`, `monitorTeam`, `shutdownTeam`) with the correct `mcp__team__omc_run_team_start` + `omc_run_team_wait` async pattern.

---

### Security

- `validateJobId()` enforces `/^omc-[a-z0-9]{1,12}$/` on all `job_id` inputs to `omc_run_team_*` MCP tools, preventing path traversal via forged job IDs.
- Removed `context_files` path traversal vector that existed in the now-deleted Codex/Gemini MCP servers.
- `SUBAGENT_HEADER` anti-recursion guard removed (no longer needed without Codex/Gemini MCP workers).

---

# oh-my-claudecode v4.3.4: MCP Reliability & Hook Hardening

This release is a concentrated bug-fix batch targeting MCP bridge stability, hook field normalization, security hardening, and cross-platform compatibility. No breaking changes.

---

### Fixed

**MCP / Codex / Gemini**
- **Codex trust bypass hardening + disconnect retries**: `fix(mcp)` — bridge now retries on disconnect and tightens trust-bypass checks (#895).
- **`--skip-git-repo-check` added to all Codex CLI invocations** (#888): Codex no longer fails when invoked outside a git repo.
- **SUBAGENT_HEADER anti-recursion guard** (#828): Prevents Codex/Gemini from spawning further Codex/Gemini subagents.
- **`context_files` path validation** (#840): Validates paths to prevent path traversal and prompt injection attacks.
- **File paths passed instead of file contents** (#837): MCP tools now pass file paths to Codex/Gemini rather than inlining content, reducing token bloat.
- **ToolSearch discovery hardened** (#816): 3-step sequence prevents false negatives when MCP tools are deferred.

**Hooks**
- **nvm/fnm node binary resolution** (#892): Hook scripts now resolve the correct `node` binary for nvm/fnm users instead of falling back to system node.
- **snake_case re-normalization for 4 hook handlers** (#858): `camelCase` fields from Claude Code are correctly de-normalized back to `snake_case` before being forwarded.
- **`OMC_SKIP_HOOKS` guard added to standalone hook scripts** (#839): Standalone `.cjs` scripts now respect the kill-switch env var.
- **Unknown-field debug log redirected to stderr** (#871): Hook bridge no longer pollutes stdout with debug messages.

**Session & CLI**
- **`cwd` normalized to git worktree root in session-end hook** (#891): `.omc/` path resolution now correctly anchors to the worktree root instead of the raw `cwd`.
- **tmux mouse mode enabled** (#890): Scroll now works in tmux panes instead of accidentally navigating shell history.
- **Claude non-zero exit codes propagated** (#870): `cli-launch` no longer swallows non-zero exit codes from Claude.
- **HUD pane enabled on launch** (#863): `omc hud` command is registered at startup so the HUD pane renders correctly.
- **`pre-compact` job DB queries now receive `cwd`** (#862): `getActiveJobsSummary` was running queries without the working directory, returning empty results.

**Team**
- **Auto-cleanup guard for empty task list** (#841): Team auto-cleanup no longer panics when all tasks complete simultaneously.
- **Auto-cleanup workers on task completion** (#835): Workers are now shut down automatically when all tasks reach terminal states.
- **`require()` → ESM `import` in `captureFileSnapshot`** (#875): Fixes module-type mismatch in team file snapshot utility.

**Live-data**
- **HTML-escape command/output in tag attributes** (#854): Prevents XSS-class injection in live-data rendered output.
- **Skip directives inside unterminated fenced code blocks** (#853): Live-data parser no longer evaluates directives embedded in code fences.
- **`allowed_patterns` enforced independently of `allowed_commands`** (#855): Pattern allowlist was being skipped when `allowed_commands` was also set.

**Notifications**
- **Duplicate `messageId` — most recent entry returned** (#877): `lookupByMessageId` now resolves to the latest entry instead of the first.
- **Per-session idle cooldown wired into TypeScript path** (#842): Idle cooldown was only applied in the CJS path; now enforced end-to-end.
- **Notification tests made hermetic** (#876): Session-registry tests use a temp dir to avoid cross-test pollution.

**Security**
- **Shell injection fix in `createWorktree`** (#851): `execSync` replaced with `execFileSync` to prevent shell injection via branch names.

**Models**
- **`opus` alias resolves to `claude-opus-4-6`** (#681 / #817): The `opus` shorthand now correctly maps to the current Opus 4.6 model ID.

**Ralplan**
- **Mandatory `AskUserQuestion` removed from consensus mode** (#821): Ralplan no longer blocks on a user question in non-interactive runs; use `--interactive` flag to restore the prompt + team-approval option.

**Plugin**
- **`validateCommitMessage` uses `config.types`** (#865): Commit message validator was ignoring the configured type list.
- **`isValidFilePath` accepts Windows paths** (#865): Path validator now handles backslash-separated Windows file paths.
- **`runPreCommitChecks` runs tests and lint** (#865): Pre-commit validation now actually invokes tests and linting.
- **Cache purge path comparison hardened + race condition guard** (#811): Stale plugin cache pruning now handles symlinks and concurrent runs safely.

**Misc**
- **`compact` added to native CC command denylist** (#830): `/compact` is now blocked from being treated as a skill invocation.
- **Agents overlay duplicate truncation note removed** (#844): Cleaned up redundant text in the agents context overlay.

---

### Added

- **Startup codebase map injection hook** (#804 / #818): A new startup hook injects a lightweight codebase map into the session context for faster orientation.
- **`parseTmuxTail` for clean tmux output in notifications** (#819): Notification payloads now strip tmux control sequences before sending to Discord/Telegram.
- **Interop tooling gated by mode** (#829): Direct-write bridge and interop tools are only active when an appropriate execution mode is enabled.
- **Stale plugin cache pruning on update** (#811): Old plugin cache versions are automatically removed when the plugin updates.

---

### Changed

- **Default Gemini model → `gemini-3.1-pro-preview`** (#813): MCP Gemini provider now targets the latest model by default.
- **Lint: 180 production warnings resolved to zero** (#874): Full production lint pass with no suppressions.
- **Remaining `sisyphus` / `OmO` references removed** (#823): Repository-wide rename completes the branding cleanup.

---

# oh-my-claudecode v4.3.1: Agent Registry Consolidation

This release completes the Phase 3 agent catalog cleanup. The registry shrinks from **30 → 21 canonical agents**. All removed agents are replaced by deprecation-aware aliases that auto-route to their canonical successors — **no user action required** for most users.

> **Migration note:** If you hard-code agent names in custom `CLAUDE.md` files, task prompts, or automation scripts, check the alias table below. Old names still work but will route silently to the canonical agent.

---

### Changed: Agent Registry (30 → 21 agents)

**Review Lane** — 5 specialized reviewers collapsed into 3:

| Removed | Now handled by |
|---------|---------------|
| `style-reviewer` | `quality-reviewer` (use `model=haiku` for style-only checks) |
| `api-reviewer` | `code-reviewer` |
| `performance-reviewer` | `quality-reviewer` |

**Domain Specialists** — 3 specialists removed or renamed:

| Removed | Now handled by |
|---------|---------------|
| `dependency-expert` | `document-specialist` |
| `quality-strategist` | `quality-reviewer` |

**Product Lane** — fully removed (4 agents):

`product-manager`, `ux-researcher`, `information-architect`, `product-analyst` have been removed from the registry. These were low-utilization and overlapped with `analyst`, `planner`, and `designer`.

**Coordination** — `vision` removed:

`vision` (image analysis) → `document-specialist`. The `critic` agent remains the sole coordination agent.

---

### Auto-Routing for Deprecated Names

A new `normalizeDelegationRole()` function silently maps old names to canonical ones at runtime. The full alias table:

| Old name | Routes to |
|---------|-----------|
| `researcher` | `document-specialist` |
| `tdd-guide` | `test-engineer` |
| `api-reviewer` | `code-reviewer` |
| `performance-reviewer` | `quality-reviewer` |
| `dependency-expert` | `document-specialist` |
| `quality-strategist` | `quality-reviewer` |
| `vision` | `document-specialist` |

---

### Added

- **Deprecation metadata on skills** (`deprecatedAlias`, `deprecationMessage` fields on `BuiltinSkill`) — foundation for future migration warnings in the auto-slash-command system.
- **`listBuiltinSkillNames({ includeAliases })`** — returns 35 canonical skills by default; pass `{ includeAliases: true }` to include `swarm` and `psm` aliases (37 total).
- **`DEPRECATED_ROLE_ALIASES` map** — runtime lookup for auto-routing deprecated agent names to canonical agents.
- **`deep-executor` restored** — was accidentally dropped from the TypeScript registry in v4.3.0; re-added with full export and `getAgentDefinitions()` entry.
- **Phase 3 roadmap doc** at `docs/design/CONSOLIDATION_PHASE3_ROADMAP.md`.

### Fixed

- **Skill files referenced `tdd-guide`, `performance-reviewer`, `product-manager`** — `skills/tdd`, `skills/pipeline`, `skills/ccg`, `skills/team` updated to use canonical names.
- **Agent prompt role boundaries referenced removed agents** — `quality-reviewer`, `security-reviewer`, `debugger`, `verifier`, `test-engineer` prompt files updated to remove dangling `(style-reviewer)`, `(performance-reviewer)`, `(api-reviewer)` parentheticals.
- **`docs/CLAUDE.md` deprecated aliases incomplete** — all 7 deprecated aliases now listed explicitly.

---

# oh-my-claudecode v4.2.15

### Added

- **CCG skill** (#744): Added `claude-developer-platform` skill (`ccg`) for building programs that call the Claude API or Anthropic SDK.

### Removed

- **Ecomode execution mode** (#737): Removed `ecomode` from `KeywordType`, `ExecutionMode`, `MODE_CONFIGS`, and all hook scripts. The `persistent-mode` stop hook no longer has a Priority 8 ecomode continuation block. The keyword detector no longer recognizes `eco`, `ecomode`, `eco-mode`, `efficient`, `save-tokens`, or `budget` as execution mode triggers.

### Fixed

- **Windows HUD not showing** (#742): Fixed HUD rendering on Windows by correcting `NODE_PATH` separator handling.
- **WSL2 scroll fix**: Fixed scroll behavior in WSL2 environments.
- **tmux session name resolution** (#736, #740, #741): Use `TMUX_PANE` env variable to correctly resolve the tmux session name in notifications.

### Docs

- **oh-my-codex cross-reference** (#744): Added cross-reference documentation for Codex users.

---

# oh-my-claudecode v4.2.4: Session Idle Notifications

Session-idle notifications now fire when Claude stops without any active persistent mode, closing the gap where external integrations (Telegram, Discord) were never informed that a session went idle.

**4 files changed across 3 PRs (#588-#592)**

---

### Fixed

- **Session-idle notification never fired on ordinary stop** (#593): The `persistent-mode.cjs` Stop hook only sent notifications when a persistent mode (ralph, ultrawork, etc.) was active. When Claude stopped normally with no mode running, no `session-idle` event was emitted. External integrations (Telegram, Discord) now receive idle notifications so users know their session is waiting for input.

### Changed

- **Skills cleanup**: Removed deprecated `commands/` stubs and added missing `SKILL.md` files (#588).
- **HUD installation optional**: Installer now respects `hudEnabled` config, skipping HUD setup when disabled (#567).
- **Team status hooks**: Emit status hooks on tmux session ready transition (#572).
- **Explore agent context**: Added context-aware file reading to explore agent (#583).

---

# oh-my-claudecode v4.2.3: Stability & Cross-Platform Fixes

Bug fixes and reliability improvements across worktree state management, Codex rate limiting, session metrics, keyword detection, and cross-platform compatibility.

**94 files changed, 2462 insertions, 886 deletions across 10 PRs (#564-#581)**

---

### Fixed

- **Worktree state written in subdirectories** (#576): `.omc/state/` was created in agent CWD subdirectories instead of the git worktree root. New `resolveToWorktreeRoot()` ensures all state paths resolve to the repo root. Applied consistently across all 8 hook handlers.
- **Session duration overreported** (#573): `getSessionStartTime()` now filters state files by `session_id`, skipping stale leftovers from previous sessions. Timestamps are parsed to epoch for safe comparison.
- **Codex 429 rate limit crashes** (#570): Added exponential backoff with jitter for rate limit errors. Configurable via `OMC_CODEX_RATE_LIMIT_RETRY_COUNT` (default 3), `OMC_CODEX_RATE_LIMIT_INITIAL_DELAY` (5s), `OMC_CODEX_RATE_LIMIT_MAX_DELAY` (60s). Applies to both foreground and background Codex execution.
- **Daemon crash on ESM require()** (#564): Replaced `require()` with dynamic `import()` in daemon spawn script. Moved `appendFileSync`/`renameSync` to top-level ESM imports.
- **LSP spawn fails on Windows** (#569): Added `shell: true` when `process.platform === 'win32'` so npm-installed `.cmd` binaries are executed correctly.
- **Post-tool verifier false positives** (#579): Broadened failure detection patterns to prevent false negatives in PostToolUse hooks.
- **Team bridge ready detection** (#572): Workers now emit a `ready` outbox message after their first successful poll cycle, enabling reliable startup detection. Initial heartbeat written at startup with protected I/O.

### Changed

- **Keyword detector dual-emission**: `ultrapilot` and `swarm` keywords now emit both their original type and `team`, allowing the skill layer to distinguish between direct team invocations and legacy aliases.
- **Keyword sanitizer improvements**: File path stripping is more precise (requires leading `/`, `./`, or multi-segment paths). XML tag matching now requires matching tag names to prevent over-stripping.
- **Skills count**: 32 to 34 built-in skills (`configure-discord`, `configure-telegram` added).
- **README cleanup**: Removed Vietnamese and Portuguese translations.

---

# oh-my-claudecode v4.2.0: Notification Tagging & Config UX

This release adds configurable mention/tag support for lifecycle stop-callback notifications and extends CLI configuration workflows for Telegram and Discord.

### Added

- `tagList` support in stop-callback config for Telegram and Discord.
- Notification tag normalization:
  - Telegram: normalizes usernames to `@username`
  - Discord: supports `@here`, `@everyone`, numeric user IDs (`<@id>`), and role tags (`role:<id>` -> `<@&id>`)
- Extended `omc config-stop-callback` options:
  - `--tag-list <csv>`
  - `--add-tag <tag>`
  - `--remove-tag <tag>`
  - `--clear-tags`
- New CLI test coverage for tag list config mutations.

### Updated

- Session-end callback notifications now prefix summaries with configured tags for Telegram/Discord.
- Documentation updated across all README locales and `docs/REFERENCE.md` with notification tag configuration examples.

---

# oh-my-claudecode v4.1.11: The Big Fix Release

This release resolves 12 open issues in a single coordinated effort, fixing HUD rendering bugs, improving Windows compatibility, and restoring MCP agent role discovery.

**63 files changed, 659 insertions, 188 deletions across 12 PRs (#534-#545)**

---

### Critical Fix

- **MCP agent roles broken in CJS bundles** (#545): esbuild replaces `import.meta` with `{}` when bundling to CJS format, causing `VALID_AGENT_ROLES` to be empty. All `agent_role` values passed to `ask_codex` and `ask_gemini` were rejected with "Unknown agent_role". Fixed all 4 `getPackageDir()` functions to fall back to `__dirname` (CJS native) when `import.meta.url` is unavailable.

### Added

- **CLI setup command** (#498): New `omc setup` command provides an official CLI entry point for syncing OMC hooks, agents, and skills. Supports `--force`, `--quiet`, and `--skip-hooks` flags.
- **Configurable budget thresholds** (#531): HUD budget warning and critical thresholds are now configurable via `HudThresholds` instead of being hardcoded at $2/$5. Defaults preserve existing behavior.
- **Model version verbosity** (#500): `formatModelName()` now supports `'short'`, `'versioned'`, and `'full'` format levels. Removed the redundant `model:` prefix from HUD display.
- **Open questions standardization** (#514): Planner and analyst agents now direct unresolved questions to `.omc/plans/open-questions.md` with a shared `formatOpenQuestions()` utility.

### Fixed

- **Context bar missing suffixes** (#532): Bar mode now shows `COMPRESS?` and `CRITICAL` text hints at threshold boundaries, matching the behavior of non-bar mode.
- **Opus rate limit not parsed** (#529): The HUD now reads `seven_day_opus` from the usage API response, enabling per-model weekly rate limit display for Opus.
- **Session duration reset on long sessions** (#528): Session start time is now persisted in HUD state (scoped per session ID) to prevent tail-chunk parsing from resetting the displayed duration.
- **Wrong version in startup hook** (#516): The session-start hook now reads OMC's own `package.json` version instead of the user project's, preventing false update notices and version drift.
- **Agent type code collisions** (#530): Disambiguated HUD agent codes using 2-character codes: `Qr`/`Qs` (quality-reviewer/strategist), `Pm` (product-manager), `Ia` (information-architect).
- **Ralph loop ignores Team cancellation** (#533): Ralph now exits cleanly when Team pipeline reaches `cancelled` phase (in addition to `complete`/`failed`). Removed double iteration increment that prematurely consumed the max-iteration budget.
- **Hooks fail on Windows** (#524): All 14 hook scripts and 5 templates now use `pathToFileURL()` for dynamic imports instead of raw file paths, fixing ESM import failures on Windows. Added `suppressOutput: true` to empty hook responses to mitigate the Claude Code "hook error" display bug.

---

# oh-my-claudecode v4.1.2: Team Model Inheritance

## Changes

### Changed
- **Team skill**: Removed hardcoded `model: "sonnet"` default for team members. Teammates now inherit the user's session model instead of being forced to Sonnet. Since each teammate is a full Claude Code session capable of spawning its own subagents, the session model serves as the orchestration layer.
- **Team config**: Removed `defaultModel` from `.omc-config.json` team configuration options.

---

# oh-my-claudecode v4.1.1: Session Isolation & Flexible MCP Routing

This patch release hardens session isolation for parallel workflows, unblocks flexible MCP agent routing, and enhances the setup wizard with agent teams configuration.

---

### Added

- **Agent Teams Setup**: The `omc-setup` wizard now includes Step 5.5 to configure Claude Code's experimental Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), including `teammateMode` selection and team defaults. (#484)

### Changed

- **Flexible MCP Routing**: Removed per-provider enum restriction on `agent_role` for `ask_codex` and `ask_gemini` MCP tools. Both now accept any valid agent role (~30 types); provider-specific strengths are documented as recommendations, not enforced gates. (#485)

### Fixed

- **Session State Isolation**: Eliminated cross-session state contamination when multiple Claude Code sessions run in the same directory. When `session_id` is known, legacy shared state is invisible — no fallback to shared paths. Adds `isSessionMatch()` helper for consistent session matching across all 8 modes. (#486)
- **State Write Warnings**: Added warnings in MCP `state_write` when `session_id` is missing, preventing accidental shared-state writes. (#486)

---

# oh-my-claudecode v4.1.0: The Consolidation & Coordination Update

This major release introduces a fundamental overhaul of the agent architecture, streamlines skills and commands, and rolls out a powerful new Team Coordination system for distributed, resilient multi-agent workflows.

---

### 💥 Breaking Changes & Migration

The previous tiered agent system (`-low`, `-medium`, `-high` suffixes) has been deprecated and removed. This was done to simplify the user experience and align with modern model capabilities.

**Migration Guide:**
- **Action Required:** Users must update their scripts, configurations, and custom commands.
- **How to Update:** Instead of selecting agents by tier (e.g., `planner-high`), you now use a single, unified agent (e.g., `planner`) and specify the desired model size/capability via your Claude Code settings or model parameters.
- **Example:** A call to `Task(subagent_type="oh-my-claudecode:architect-high", ...)` should become `Task(subagent_type="oh-my-claudecode:architect", model="opus", ...)`.

---

### 🚀 Headline Feature: Agent Architecture Reform

The agent ecosystem has been completely reformed. We've consolidated the previous 34 tiered agents into **28 unified, specialized agents**. This new structure emphasizes role-based specialization over a confusing tier system, with model capability now handled by parameter routing. This change simplifies agent selection and improves the clarity of each agent's purpose. (#480, #481)

- **Unified Agent Roster**: Deprecated `-low`, `-medium`, and `-high` agent variants in favor of a single, unified roster.
- **New Specialist Agents**: Introduced a suite of new agents to cover more specialized tasks:
  - `debugger`: For root-cause analysis and bug fixing.
  - `verifier`: For validating logic and results.
  - `style-reviewer`: For enforcing coding style and conventions.
  - `quality-reviewer`: For assessing overall code quality.
  - `api-reviewer`: For analyzing API design and usage.
  - `performance-reviewer`: For identifying performance bottlenecks.
  - `dependency-expert`: For managing and analyzing project dependencies.
  - `test-engineer`: For creating and maintaining tests.
  - `quality-strategist`: For high-level quality assurance planning.
  - `product-manager`: For aligning work with product goals.
  - `ux-researcher`: For user experience analysis.
  - `information-architect`: For organizing and structuring information.
  - `product-analyst`: For analyzing product requirements and behavior.
- **System Integration**: Completed HUD codes, system prompts, and short names for all 28 agents to ensure full integration into the OMC ecosystem. (f5746a8)

---

### 🤝 Feature: Advanced Team Coordination

Introducing the **MCP Team Workers Bridge Daemon**, a major leap forward for multi-agent collaboration. This system enables robust, resilient, and observable distributed workflows.

- **Team Bridge Daemon**: A new background service (`mcp-team-workers`) orchestrates tasks among multiple agent "workers." (e16e2ad)
- **Enhanced Resilience**: Implemented hybrid orchestration, the use of `git worktrees` for isolated task execution, and improved observability to make team operations more robust. (0318f01)
- **Atomic Task Claiming**: Replaced the previous `sleep+jitter` mechanism with atomic, `O_EXCL` lock files. This prevents race conditions and ensures that a task is claimed by only one worker at a time. (c46c345, 7d34646)
- **Security Hardening**: Fortified the team bridge against a range of vulnerabilities, including file descriptor (FD) leaks, path traversal attacks, and improved shutdown procedures. (#462, #465)
- **Permission Enforcement**: Added a post-execution permission enforcement layer for MCP workers, ensuring that agents operate within their designated security boundaries. (fce3375, 6a7ec27)

---

### ✍️ Feature: System Prompt Rewrite for Claude Opus 4.6

In line with Anthropic's latest prompting best practices, the core system prompt (`docs/CLAUDE.md`) has been completely rewritten for significantly improved performance, reliability, and tool-use accuracy.

- **Best Practices**: The new prompt leverages XML behavioral tags (`<operating_principles>`, `<delegation_rules>`, `<agent_catalog>`, etc.), uses calm and direct language, and provides a comprehensive, structured reference for all available tools and skills. (42aad26)
- **Production Readiness**: Addressed feedback from a production readiness review to ensure the prompt is robust and effective. (d7317cb)

---

### 🔧 Skill & Command Consolidation

To reduce complexity and improve user experience, several skills and commands have been merged and formalized. (#471)

- **Merged Skills**:
  - `local-skills-setup` has been merged into the core `skill` command.
  - `learn-about-omc` is now part of the `help` command.
  - `ralplan` and `review` have been consolidated into the `plan` command. (dae0cf9, dd63c4a)
- **Command Aliases**: Added `ralplan` and `review` as aliases for `plan` to maintain backward compatibility for user muscle memory. (217a029)
- **Formalized Structure**: Clarified the distinction between "commands" (user-facing entry points) and "skills" (internal agent capabilities). `analyze`, `git-master`, and `frontend-ui-ux` are now thin routing layers to their respective underlying skills. (#470)
- **Cleanup**: Removed dead skills, orphan references, and updated documentation to reflect the new, leaner structure. (#478)

---

### ✅ Reliability & Bug Fixes

This release includes numerous fixes to improve stability, prevent errors, and enhance the overall reliability of the system.

- **State Management**:
  - Namespaced session state files to prevent context "bleeding" between different sessions. (#456)
  - Eliminated cross-session state leakage in the mode detection hooks for better isolation. (297fe42, 92432cf)
- **Concurrency & Race Conditions**:
  - Added a debounce mechanism to the compaction process to prevent errors from concurrent execution. (#453)
- **Tool & Hook Stability**:
  - Implemented a timeout-protected `stdin` in all hook scripts to prevent hangs. (#459)
- **API/Model Interaction**:
  - Added a fallback mechanism to handle `429 Too Many Requests` rate-limit errors from Codex and Gemini, improving resilience during heavy use. (#469)
- **Workflow Gates**:
  - Replaced the `AskUserQuestion` tool with a native Plan Mode approval gate in `ralplan` for a more streamlined and reliable human-in-the-loop workflow. (#448, #463)
- **Testing**:
  - Resolved merge conflicts and aligned skill/agent inventories in tests to match the consolidation changes. (e4d64a3, 539fb1a)
  - Fixed a test for stale lock file reaping by using `utimesSync` to correctly simulate file ages. (24455c3)