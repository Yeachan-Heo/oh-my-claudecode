# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.1.0] - 2026-02-07

### Changed

- **CLAUDE.md Refactoring** - Significantly refactored system prompt from 571 to 358 lines (37% reduction). Condensed MCP Tools, Team Tools, State Tools, Notepad, Memory, and LSP/AST sections. Merged "Commands vs Skills" into Skills section header.
- **Documentation Cleanup** - Updated 20 files including `AGENTS.md`, `marketplace.json` (agent count 34→28), `ANALYSIS.md`, and seminar materials (`notes.md`, `quickref.md`, `slides.md`) to reflect consolidated agent tiers.

### Removed

- **Redundant Agent Tiers** - Deleted 6 agents: `build-fixer-low`, `code-reviewer-low`, `explore-medium`, `qa-tester-high`, `researcher-low`, `scientist-low`. Capabilities merged into base agents with model routing.
- **Redundant Skills** - Merged `local-skills-setup` into `skill` (as `/skill setup`) and `learn-about-omc` into `help` (as "Usage Analysis" section).
- **Source Code Artifacts** - Removed unused definitions from `src/agents/definitions.ts`, exports from `src/agents/index.ts`, MCP safelist entries from `src/mcp/prompt-injection.ts`, HUD mappings from `src/hud/elements/agents.ts`, and CLI help text.

### Fixed

- **Orphan References** - Removed ALL remaining orphan references to deleted agents/skills from source code and documentation.
- **Test Maintenance** - Removed `explore-medium` test cases from delegation-enforcer and hud-agents tests.

## [4.0.7] - 2026-02-06

### Added

- **SQLite-backed MCP job state storage** - New `job-state-db.ts` with WAL-mode SQLite for reliable job state persistence. Includes JSON fallback compatibility for environments without native modules.
- **Improved job management reliability** - SQLite-first reads for check/wait/list/kill flows with automatic fallback to JSON file-based storage.
- **PreCompact hook job summaries** - Pre-compact hook now injects job summary data from SQLite into checkpoint content.
- **Comprehensive test coverage** - 74 new unit tests for job-state-db + 16 integration tests for SQLite job management.

### Fixed

- **Windows compatibility** - Platform-aware path normalization (`toForwardSlash()`), `pathToFileURL()` for bridge detection, cross-platform config/data directory resolution (`getConfigDir()`/`getDataDir()`), and `shell: true` for CLI spawn on Windows.
- **Path traversal hardening** - Strengthened `isAllowedPath` and boundary checks with `isAbsolute()` guard for Windows drive-letter edge cases. Added security regression tests.
- **Worktree boundary validation** - Hardened and clarified worktree boundary enforcement for MCP file/path handling across codex-core and gemini-core.

### Changed

- **Teleport command** - Now uses `git worktree list` and `fs.rmSync` with cross-platform `path.isAbsolute()` checks.
- **LSP client** - Updated URI construction to use `pathToFileURL()` for Windows compatibility.

## [4.0.6] - 2026-02-06

### Added

- **Codex/GPT/Gemini magic-keyword MCP delegation** - New keyword detection for `ask codex`, `use gpt`, `delegate to gemini` that routes directly to MCP tools instead of skill invocation. Requires intent phrases to avoid false positives.
- **Codex model fallback chain** - Automatic retry with fallback models (`gpt-5.3-codex` → `gpt-5.3` → `gpt-5.2-codex` → `gpt-5.2`) on model-not-found errors for both blocking and background execution.
- **Full sanitization pipeline in TypeScript** - Ported XML tag, URL, file path, and code block stripping from runtime .mjs to TypeScript keyword detector for consistent false-positive prevention.

### Fixed

- **Background retry error handling** - Fixed silent error swallowing when model fallback retry fails in background execution, preventing jobs from getting stuck in "running" state.
- **Redundant sanitization in keyword wrappers** - Removed double-processing where `hasKeyword`, `getAllKeywords`, and `getPrimaryKeyword` called `removeCodeBlocks` before `detectKeywordsWithType` which already calls `sanitizeForKeywordDetection`.

## [4.0.5] - 2026-02-05

### Changed

- **Include dist/ in git** - Compiled output now ships with the repo so users no longer need to rebuild after plugin install/update. Eliminates the most common setup issue.
- **Simplified update guide** - All 5 README translations updated with streamlined update instructions (no rebuild step needed).
- **Removed outdated rebuild instructions** - Cleaned up `commands/omc-setup.md`, `commands/hud.md`, and `skills/hud/SKILL.md` to remove the "Verify Plugin Build" step and related dist/ rebuild guidance.

## [4.0.4] - 2026-02-05

### Fixed

- **Hook Field Name Compatibility** - All 11 hook scripts + 5 templates updated to read snake_case field names (`tool_name`, `tool_input`, `tool_response`, `session_id`, `cwd`) with camelCase fallback. Claude Code sends snake_case but hooks were only reading camelCase, causing silent empty values.
- **Hook Error Display Noise** - PostToolUse hooks now return `suppressOutput: true` when no meaningful message, reducing "hook error" display noise from Claude Code display bug ([#10936](https://github.com/anthropics/claude-code/issues/10936)).

## [4.0.3] - 2026-02-05

### Fixed

- **Hook TaskCreate/TaskUpdate Compatibility** - Fixed PostToolUse and PreToolUse hooks failing on `TaskCreate` and `TaskUpdate` events after Claude Code renamed the Task tool in Feb 2025 update. Updated tool name matching in `post-tool-verifier.mjs`, `pre-tool-enforcer.mjs`, and `post-tool-use.mjs` template.

### Changed

- **Codex Default Model** - Updated default Codex model from `gpt-5.2` to `gpt-5.3`
- **Claude Opus 4.6 Support** - Updated all model references from `claude-opus-4-5-20251101` to `claude-opus-4-6-20260205` across config, routing, analytics, and tests

## [4.0.1] - 2026-02-05

### Fixed

- **Codex/Gemini Output File Handling** - Fixed issue where MCP bridge would overwrite output files that the CLI (Codex/Gemini) had already written via shell commands. Now checks file mtime before/after execution and preserves CLI-written content.
- **Codex JSONL Parser** - Updated `parseCodexOutput()` to handle current Codex CLI JSONL format (`item.completed` events with `item.type === "agent_message"`). Previously only matched older `message` and `output_text` event formats.

## [4.0.0] - 2026-02-05

### Breaking Changes

- **Node.js 20 Required** - Minimum Node.js version increased from 18 to 20. Users on Node.js 18 must upgrade before using this version. This aligns with Node.js LTS schedule (Node 18 EOL: April 2025).

### Refactored

- **MCP Core Modules** - Extracted shared Codex/Gemini business logic into `codex-core.ts` and `gemini-core.ts`, eliminating code duplication between in-process SDK servers and standalone stdio servers
- **Slim Server Wrappers** - Reduced `codex-server.ts`, `codex-standalone-server.ts`, `gemini-server.ts`, and `gemini-standalone-server.ts` to thin transport wrappers (~40-70 lines each)
- **Build Scripts** - Updated esbuild scripts with global npm module resolution banner for proper native module loading

### Changed

- **Codex/Gemini Agent Routing** - Codex (`ask_codex`) now recommended only for reviewer and planning agents (architect, planner, critic, analyst, code-reviewer, security-reviewer, tdd-guide). Gemini (`ask_gemini`) recommended only for design agents (designer, writer, vision). All other agents have no external consultation recommendation.
- **CLAUDE.md Compacted** - Reduced from 679 to 389 lines (43% smaller). All 33 agents, all skills, and all MCP tools with descriptions now inline. Removed external doc references and redundant troubleshooting section.
- **Agent Tiers Reference** - Added External AI Consultation section with strict Codex/Gemini routing per agent domain
- **Model Routing Enforcement** (#384) - Advisory agents (architect, planner, critic) enforce read-only behavior; execution agents get full tool access
- **Gemini Model Fallback Chain** - Gemini now uses fallback chain: gemini-3-pro-preview → gemini-3-flash-preview → gemini-2.5-pro → gemini-2.5-flash

### Performance

- **Levenshtein LRU Cache** - Added LRU cache for Levenshtein distance calculations in skill matching with canonical key ordering for maximum cache hits
- **Skill Metadata Cache** - Added 30-second TTL cache for skill metadata to reduce repeated file system reads
- **Debounced State Writes** - Subagent tracker now batches state file writes with 100ms debounce to reduce I/O
- **Pre-compiled Regex Patterns** - Pre-compiled 15+ regex patterns in hot paths (auto-learner, live-data, bridge) to eliminate repeated compilation
- **Parallel State File Reads** - Pre-compact module now reads all state files in parallel using Promise.all
- **Session Index Caching** - Token tracker now caches session indices with 5-minute TTL for 50-100ms faster stats loading
- **Space-Optimized Levenshtein** - Levenshtein algorithm now uses O(n) space instead of O(n²)

### Added

- **Job Management Tools** (#420) - Four new MCP tools for background Codex/Gemini job control: `wait_for_job`, `check_job_status`, `kill_job`, `list_jobs`
- **Version Drift Detection** (#422) - Automatic detection and cleanup of stale plugin versions on session start
- **HUD Fine-Grained Control** (#399) - Configurable sessionHealth display elements with per-element enable/disable options for context, rate limit, and cost displays
- **MCP Prompt File Parameters** (#416) - New `prompt_file` and `output_file` parameters for `ask_codex` and `ask_gemini` tools, enabling file-based prompt passing to avoid OS argument length limits
- **MCP Prompt Persistence Audit Trail** - Prompts now persisted to disk with audit trail for debugging and replay
- **MCP State Tools Enhancement** - Improved state management tools with better error handling
- **Plugin-Scoped Codex/Gemini MCP Servers** - Codex and Gemini now registered as plugin-scoped MCP servers with proper discovery
- **MCP System Prompt Injection** - Codex/Gemini tools now inject system prompts for better agent context
- **Built-in MCP Tools** - State, notepad, and project memory tools added as built-in MCP tools
- **Configurable Stop Hook Callbacks** (#395) - Hooks now support configurable callbacks for stop events
- **Swarm Aggressive Mode** - Wave-based spawning and micro-task decomposition for swarm coordination
- **Codex/Gemini Timeout Increase** - Both Codex and Gemini timeouts increased to 1 hour for complex analysis tasks

### Fixed

- **Per-Directory Debounce** - Fixed race condition in subagent tracker where global debounce state could lose writes for different directories
- **TOCTOU Race Condition** - Fixed time-of-check-time-of-use race in pre-compact by removing existsSync check before async read
- **True LRU Cache** - Fixed Levenshtein cache to use true LRU eviction (delete+reinsert on hit) instead of FIFO
- **Session Index Off-by-One** - Fixed off-by-one error in token tracker session index offset calculation
- **Cache Hit Rate Formula** (#425) - Corrected cache hit rate calculation to include all input token types (was exceeding 100%)
- **HUD Token Formatting** (#417) - Fixed `formatTokenCount()` returning "0.999k" for values under 1000
- **LSP goto_definition Null Safety** (#417) - Fixed crash when LSP returns `LocationLink` objects instead of `Location`
- **MCP Output File Suffix** (#419) - Fixed `output_file` writing to `.raw` suffix instead of the specified path
- **MCP Stdin Prompt Piping** - Fixed prompts being passed via command line arguments, which could exceed OS limits. Now piped via stdin.
- **HUD Semver Sorting** (#373) - Fixed version comparison using `semverCompare` for proper plugin cache version selection
- **Security Hardening** - Cross-platform compatibility improvements and security hardening across MCP tools
- **Codex/Gemini Role Allowlists** - Fixed role allowlists to match documented routing recommendations
- **Conflict Markers and Dedup** (#395) - Resolved committed conflict markers and deduplicated index.ts exports

### Breaking Changes (MCP)

- **MCP Response Contract** (#424) - `ask_codex` and `ask_gemini` now return file paths instead of inline content. `output_file` parameter is now required. Added `working_directory` parameter for path resolution.
- **Prompt Parameter Deprecated** (#421) - The `prompt` parameter for `ask_codex` and `ask_gemini` is removed. Use `prompt_file` instead, which writes prompts to files to avoid OS argument length limits.
- **Agent Role Required** - `agent_role` parameter is now required for both `ask_codex` and `ask_gemini` tools

---

## [3.9.8] - 2026-02-03

### Bug Fixes

- fix: auto-recover status bar after plugin update (#327, #329)
  - Filter plugin cache versions to only those with built dist/hud/index.js
  - Prevents picking unbuilt new version after plugin update

### Features

- feat: add project isolation to state files (#326, #328)
  - Added project_path validation to all persistent mode states
  - Prevents cross-project state contamination
  - Windows path normalization support
  - Backward compatible with legacy states

---

## [3.9.7] - 2026-02-02

### Fixed

- **Stop Hook Freeze on Bash Errors** (#321, fixes #319) - Fixed persistent-mode hook causing session freezes when bash commands encounter errors. The root cause was cascading errors in the catch block when stdout/stderr streams were broken:
  - Replaced `console.log`/`console.error` with `process.stdout.write`/`process.stderr.write` in error handlers
  - Added nested try-catch blocks to handle EPIPE and broken pipe errors gracefully
  - Added global `uncaughtException` and `unhandledRejection` handlers to prevent hook hangs
  - Added 10-second safety timeout to force exit if hook doesn't complete
  - Added early return for invalid JSON input to prevent unnecessary processing
  - Hook now guarantees to return `{ continue: true }` even on catastrophic errors

- **Invalid Hook Event Type** (#322, fixes #320) - Renamed invalid 'Setup' hook event to 'SessionStart' in hooks.json. The 'Setup' event type is not recognized by Claude Code's hook system. All hooks moved into SessionStart where they belong.

- **Project-Scoped Plugin Isolation** (#315, fixes #314) - Fixed project-scoped plugin installations incorrectly modifying global scope. When installing OMC as a project-scoped plugin (in `.claude/plugins/`), the installer was incorrectly modifying global `~/.claude/settings.json` and `~/.claude/hud/`, causing the statusline and plugin to appear in all projects:
  - Added `isProjectScopedPlugin()` detection function
  - Skip HUD statusline installation for project-scoped plugins
  - Skip settings.json modification for project-scoped plugins
  - Skip version metadata file for project-scoped plugins
  - Skip global config directory creation for project-scoped plugins
  - Added comprehensive tests for project-scoped detection

- **Auto-Update Trigger on Session Start** (#316, fixes #298) - Fixed silent auto-update feature not being triggered. The `silentAutoUpdate()` function existed but was never called. Now properly imports and calls `initSilentAutoUpdate()` in `processSessionStart()` so update checks run on session start when the user has opted in.

- **Session Isolation + Windows Path Handling** (#317) - Fixed session isolation and Windows path compatibility issues. Improved session ID handling across 14 files to prevent state conflicts between concurrent sessions, with proper Windows path normalization (contributed by @MeroZemory).

---

## [3.9.2] - 2026-02-01

### Added

- **Bash History Integration** (Issue #290) - Claude Code bash commands are now automatically appended to `~/.bash_history`, allowing users to recall them with arrow keys or Ctrl+R in their terminal. Enabled by default; disable with `"bashHistory": false` in `~/.claude/.omc-config.json`.

---

## [3.9.1] - 2026-02-01

### Changed

- **Framework-Agnostic Prompts** - All agent prompts, skill files, and TypeScript source code now use generic, language-neutral commands instead of hardcoded npm/Node.js-specific commands. This makes OMC work seamlessly with any project type (Python, Go, Rust, Java, etc.).

### Files Updated

**Agent Prompts:**

- `agents/deep-executor.md` - Generic verification evidence placeholders
- `agents/architect.md` - Generic project manifest and build references

**Skill Files:**

- `skills/build-fix/SKILL.md` - Generic type check and build command references
- `skills/ultrawork/SKILL.md` - Generic background task examples
- `skills/ralph/SKILL.md` - Generic background task examples
- `skills/ultraqa/SKILL.md` - Generic goal command references
- `skills/tdd/SKILL.md` - Generic test command references
- `skills/ultrapilot/SKILL.md` - Generic validation commands
- `skills/deepinit/SKILL.md` - Generic dependency and test instructions

**Command Files:**

- `commands/build-fix.md` - Generic type check command
- `commands/ralph.md` - Generic background task examples
- `commands/ultrawork.md` - Generic background task examples
- `commands/ultraqa.md` - Generic goal commands

**TypeScript Source:**

- `src/hooks/ultraqa/index.ts` - `getGoalCommand()` returns generic comments with examples
- `src/features/verification/index.ts` - Removed hardcoded npm commands from STANDARD_CHECKS
- `src/hooks/autopilot/state.ts` - Generic QA phase instructions
- `src/agents/definitions.ts` - Generic test command reference
- `src/features/background-tasks.ts` - Generic background task documentation
- `src/features/task-decomposer/index.ts` - Generic verification commands

---

## [3.8.17] - 2026-02-01

### Fixed

- **MCP Tool Name Length** (PR #252, fixes #241, #232, #235) - Shortened MCP server name from `omc-tools` to `t` to fix tool names exceeding the 64-character API limit. The longest tool name (`lsp_diagnostics_directory`) now uses 57 characters instead of 65.

---

## [3.8.16] - 2026-02-01

### Changed

- **Local-Only State Management** - All execution mode state (ralph, ultrawork, ecomode) is now stored exclusively in `.omc/state/` per project/worktree. Global state in `~/.claude/` and `~/.omc/state/` is no longer written for mode state, enabling multiple git worktrees to run OMC simultaneously without state conflicts. Existing global state is migrated on first read.
- **Promise Pattern Removal** - Fully removed `<promise>` completion pattern from ralph and verification workflows. Completion now uses architect verification + `/oh-my-claudecode:cancel` for clean exit.

### Added

- **HUD CWD Element** (#229) - Configurable working directory display in HUD with three formats: relative, absolute, folder.
- **HUD Thinking Indicator** (#229) - Configurable thinking indicator with four formats: bubble, brain, face, text.
- **HUD Line Limiting** (#228) - Prevents HUD output from shrinking the input field.
- **HUD Stale Task Threshold** (#236) - Configurable `staleTaskThresholdMinutes` option.
- **Session End Hook** - New hook for proper state cleanup on session termination, preventing stale state from causing stop hook malfunctions.
- **Learner Parser Backward Compatibility** (#227) - Backward-compatible parser for legacy skill files with auto-generated IDs and default source field.

### Fixed

- **Stop Hook Not Blocking** (PR #237, fixes #233) - Fixed persistent-mode Stop hook using `{ continue: true }` instead of `{ decision: "block" }`.
- **Completion Promise Checking** (#239) - Added completion promise checking to Ultrawork and Ecomode stop hooks.
- **Staleness Check** - Added staleness check and session-end cleanup for mode states.

---

## [3.8.15] - 2026-01-31

### Fixed

- **Stop Hook Not Blocking** (PR #237, fixes #233) - Fixed persistent-mode Stop hook using `{ continue: true }` instead of `{ decision: "block" }`. The old approach was a no-op that always allowed stops instead of blocking them. All 8 mode handlers (ralph, autopilot, ultrapilot, swarm, pipeline, ultraqa, ultrawork, ecomode) now properly block premature stops.

---

## [3.8.14] - 2026-01-30

### Added

- **Bun Package Manager Support** (PR #219) - OMC setup now prefers Bun over npm when available, with automatic fallback. Includes duplicate cleanup logic and per-manager verification.
- **MCP Skill Loading Tools** (PR #225) - Three new MCP tools (`load_omc_skills_local`, `load_omc_skills_global`, `list_omc_skills`) with 5-layer security hardening: path validation, symlink boundary checks, depth limits, content sanitization, and relative path output.

### Fixed

- **HUD OAuth Token Refresh** (PR #206) - Expired OAuth tokens now auto-refresh using RFC 6749 compliant refresh token grant, restoring rate limit display. Credentials persisted with atomic writes and 0o600 permissions.

---

## [3.8.10] - 2026-01-30

### Deprecated

- **Coordinator Agent** - `coordinatorAgent` and `ORCHESTRATOR_SISYPHUS_PROMPT_METADATA` are deprecated and will be removed in v4.0.0. The coordinator agent was never registered in the runtime agent registry and had zero internal consumers. Deprecated stubs are provided for backward compatibility.

### Fixed

- **Documentation Consistency** - Fixed misleading "Combine them" multi-skill documentation
  - Clarified that ralph includes ultrawork automatically
  - Updated 7 documentation files with accurate skill composition guidance
- **Skill Count** - Fixed documented skill count from 35 to 37 across all documentation
- **Missing Agent Exports** - Fixed 9 missing agent exports from index.ts:
  - `explore-high`, `security-reviewer`, `security-reviewer-low`
  - `build-fixer`, `build-fixer-low`
  - `tdd-guide`, `tdd-guide-low`
  - `code-reviewer`, `code-reviewer-low`

### Changed

- **Agent Prompt Architecture** - Migrated all 12 base agent prompts from hardcoded TypeScript constants to dynamic loading from markdown files
  - Implemented `loadAgentPrompt()` utility function for runtime prompt loading
  - Moved utility to `src/agents/utils.ts` to avoid circular dependency issues
  - Affected agents: planner, architect, executor, explore, researcher, designer, writer, qa-tester, vision, critic, analyst, scientist
- **Agent Prompt Enhancement** - Enhanced agent prompts with improved instructions and domain-specific guidance. Prompts are now maintained as standalone markdown files in `agents/`.
- **Public API** - `loadAgentPrompt()` is now exported from the main entry point for external consumers
- **Model Routing** - Removed dead coordinator references and `isFixedTierAgent()` function (was only used for deprecated coordinator)
- **Task Decomposer** - Renamed `requiresCoordinator` to `requiresOrchestration` in SharedFile type
- **Documentation Enhancement** - Added "Choosing the Right Mode" decision tree to clarify execution mode selection
- **State Management** - Standardized path documentation for state files across all modes

### Added

- **CI Validation Tests** - New comprehensive validation tests for agent registry
  - Validates agent count, markdown file presence, exports, and absence of hardcoded prompts
  - Prevents regressions in agent configuration

---

## [3.7.10] - 2026-01-28

### Fixed

#### MCP Server Plugin Distribution (Hotfix)

Fixed MCP server not working in Claude Code plugin cache.

- **Bundled MCP Server** (`bridge/mcp-server.cjs`)
  - Pre-bundled with esbuild for plugin distribution
  - No longer requires node_modules in plugin cache
  - Committed to repo (bridge/ is not gitignored)

- **LSP Tools Only**
  - Exposes 12 LSP tools (no native dependencies)
  - AST tools and python_repl excluded (require native modules)
  - Works out-of-the-box in plugin cache

### Changed

- `.mcp.json` now points to `bridge/mcp-server.cjs`
- Added `scripts/build-mcp-server.mjs` for bundling

---

## [3.7.9] - 2026-01-28

### Added

#### Plugin-Scoped MCP Server Discovery

Standalone MCP server for Claude Code plugin discovery, making omc-tools visible in the `/mcp` management UI.

- **Standalone MCP Server** (`src/mcp/standalone-server.ts`)
  - Stdio-based MCP server using `@modelcontextprotocol/sdk`
  - Exposes 12 LSP tools
  - Proper JSON Schema conversion from Zod schemas
  - Compatible with Claude Code's plugin MCP discovery

- **Plugin MCP Configuration** (`.mcp.json`)
  - Declares `omc-tools` server for plugin-scoped discovery
  - Uses `${CLAUDE_PLUGIN_ROOT}` for portable paths
  - Server auto-starts when plugin is enabled

- **Updated Plugin Manifest** (`.claude-plugin/plugin.json`)
  - Added `mcpServers` reference to `.mcp.json`

### Changed

- Added `@modelcontextprotocol/sdk` as dependency
- Updated `package.json` files array to include `.claude-plugin` and `.mcp.json`

---

## [3.7.8] - 2026-01-28

### Added

#### SDK MCP Server for Custom Tools (Major Feature)

In-process MCP server exposing 15 custom tools to Claude Code subagents via the Claude Agent SDK.

- **OMC Tools Server** (`src/mcp/omc-tools-server.ts`)
  - Uses `createSdkMcpServer` and `tool` helpers from `@anthropic-ai/claude-agent-sdk`
  - Exposes tools in MCP format as `mcp__omc-tools__<tool_name>`
  - Zero external process overhead - runs in-process
  - Configurable tool filtering via `getOmcToolNames()`

- **15 Custom Tools Exposed**
  - **12 LSP Tools**: `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_completion`, `lsp_signature_help`, `lsp_rename`, `lsp_code_actions`, `lsp_formatting`, `lsp_symbols`, `lsp_diagnostics`, `lsp_diagnostics_directory`, `lsp_semantic_tokens`
  - **2 AST Tools**: `ast_query`, `ast_query_multi`
  - **1 Python Tool**: `python_repl` (persistent REPL with session management)

- **Session Integration**
  - Tools automatically added to session's `allowedTools`
  - MCP server registered in session's `mcpServers` config
  - Feature flags for LSP/AST/Python tool inclusion

### Changed

- **Agent Definitions** (`src/agents/definitions.ts`)
  - Relevant agents (architect, executor, explore, qa-tester) now have LSP/AST tools in their tool arrays
  - Enables IDE-like capabilities for agent analysis and modification tasks

### Technical Details

**New Files:**

- `src/mcp/omc-tools-server.ts` - SDK MCP server implementation
- `src/__tests__/omc-tools-server.test.ts` - 10 tests for tool exposure

**Usage:**

```typescript
// Tools available to subagents as:
mcp__omc - tools__lsp_hover;
mcp__omc - tools__lsp_definition;
mcp__omc - tools__ast_query;
mcp__omc - tools__python_repl;
// ... etc
```

---

## [3.7.7] - 2026-01-28

### Changed

- **LSP/AST Tools Wired into Agent Definitions**
  - Architect, executor, explore, and qa-tester agents now have LSP/AST tools in their tool arrays
  - Enables IDE-like code intelligence for relevant agent tasks

---

## [3.7.4] - 2026-01-28

### Changed

- **Language-Agnostic Agent Prompts** (#174)
  - build-fixer: Multi-language build/type check commands (TypeScript, Python, Go, Rust, Java)
  - tdd-guide: Framework-agnostic test examples and coverage commands
  - security-reviewer: Multi-language vulnerability patterns and dependency audit commands
  - designer: Framework detection for React, Vue, Angular, Svelte, Solid
  - code-reviewer: Language-neutral terminology for logging, docs, and patterns
  - autopilot prompts: Multi-language build/lint/test commands
  - All agents now detect project type from manifest files and adapt accordingly

## [3.7.3] - 2026-01-28

### Added

#### MCP/Plugin Compatibility Layer (Major Feature)

A comprehensive compatibility layer enabling OMC to discover, register, and use external plugins, MCP servers, and tools. This makes OMC a good citizen in the Claude ecosystem by resolving inter-plugin conflicts.

- **Plugin Discovery** (`src/compatibility/discovery.ts`)
  - Auto-discovery of installed plugins and MCP servers
  - JSON Schema validation of plugin manifests using ajv
  - Path traversal protection with `isPathWithinDirectory()` validation
  - Symlink resolution and directory containment checks

- **Tool Registry** (`src/compatibility/registry.ts`)
  - Central registry for all discovered tools
  - Conflict resolution when multiple plugins provide the same tool
  - Priority-based tool selection

- **Permission Adapter** (`src/compatibility/permission-adapter.ts`)
  - Safe external tool usage with permission integration
  - ReDoS prevention using safe-regex library for pattern validation

- **MCP Bridge** (`src/compatibility/mcp-bridge.ts`)
  - Server connection management and tool invocation
  - Command whitelist enforcement (node, npx, python, python3, ruby, go)
  - Environment variable filtering to block dangerous vars (LD_PRELOAD, NODE_OPTIONS, etc.)
  - Proper child process error handlers and cleanup on spawn failure

- **Documentation** (`docs/COMPATIBILITY.md`)
  - 1,000+ line comprehensive documentation covering architecture, usage, and security

- **CLI Tools**
  - `omc tools list` - List all discovered tools
  - `omc tools enable/disable` - Manage tool availability

### Fixed

#### Security Fixes (6 Vulnerabilities) (#170)

In response to security review by @shaun0927:

1. **Arbitrary Code Execution** - Added command whitelist to MCP bridge; only allowed executables can be spawned
2. **Environment Variable Injection** - Block 10 dangerous environment variables (LD_PRELOAD, NODE_OPTIONS, etc.)
3. **ReDoS Vulnerability** - Validate regex patterns with safe-regex library before compilation
4. **No Schema Validation** - Added ajv-based JSON Schema validation for plugin manifests
5. **Missing Error Handlers** - Added child process error handlers with proper cleanup on spawn failure
6. **Path Traversal** - Added `isPathWithinDirectory()` with symlink resolution to prevent directory escape

#### Other Fixes

- **fix(hud):** Address code review feedback for cache toggle feature (#164)
- **fix(rate-limit-wait):** Add ESM compatibility for `__filename` in daemon (#169, #172)

### Testing

- **64 new tests** (all passing)
  - 30 compatibility layer tests (`src/__tests__/compatibility.test.ts`)
  - 34 security vulnerability tests (`src/__tests__/compatibility-security.test.ts`)

### Dependencies Added

- `ajv` ^8.17.1 - JSON Schema validation
- `safe-regex` ^2.1.1 - ReDoS prevention

### Technical Details

**New Files:**

- `src/compatibility/` - Complete compatibility layer (6 source files)
  - `index.ts` - Main exports and initialization
  - `types.ts` - TypeScript interfaces (276 lines)
  - `discovery.ts` - Plugin/MCP discovery with schema validation
  - `registry.ts` - Tool registry with conflict resolution
  - `permission-adapter.ts` - Permission integration with ReDoS protection
  - `mcp-bridge.ts` - MCP server bridge with security hardening
  - `safe-regex.d.ts` - Type declarations for safe-regex
- `docs/COMPATIBILITY.md` - Architecture documentation (1,051 lines)
- `src/__tests__/compatibility.test.ts` - Feature tests (612 lines)
- `src/__tests__/compatibility-security.test.ts` - Security tests (549 lines)

**Lines Added:** ~5,000+

---

## [3.7.2] - 2026-01-27

### Fixed

#### Security Hardening

- **fix(security):** Extend DANGEROUS_SHELL_CHARS regex for complete injection prevention (#146)
  - Added `\r`, `\t`, `\0`, `{}`, `[]`, `*`, `?`, `~`, `!`, `#` to blocked characters
  - Intentionally excludes quotes (`"'`) for paths with spaces
  - 20 new test cases covering brace expansion, CRLF, null bytes, globs, tilde, history, comment injection

- **fix(plugin-patterns):** Add path traversal prevention with `isValidFilePath()` (#148)
  - Blocks shell metacharacters in file paths
  - Blocks `..` path traversal and absolute paths
  - Applied to `formatFile()` and `lintFile()` functions

---

## [3.7.1] - 2026-01-27

### Fixed

#### Security & Stability Fixes

- **fix(daemon):** Filter environment variables to prevent credential leakage (#155)
  - New `createMinimalDaemonEnv()` function with allowlist approach
  - Blocks `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, AWS credentials from daemon subprocess
  - Adds proxy variable support (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`)

- **fix(permission-handler):** Remove dead code and add swarm marker support (#157)
  - Removed unreachable `isActiveModeRunning && isSafeCommand` code block
  - Added `swarm-active.marker` detection for swarm mode auto-approval
  - Generic `.marker` suffix support for future marker-based state files

- **fix(subagent-tracker):** Replace CPU busy-wait loops with syncSleep (#159)
  - `Atomics.wait`-based sleep instead of spinning loops
  - Fixed race condition in `cleanupStaleAgents` with proper lock acquisition
  - Complete state path migration to `.omc/state/` across all hooks and templates

- **fix(session-end):** Simplify HookOutput to avoid JSON validation errors (#161)
  - Removed `hookSpecificOutput` with unrecognized `SessionEnd` event
  - Metrics still persist to disk, cleanup still runs

- **fix(omc-setup):** Use cross-platform date conversion for state age check (#151)
  - New `iso_to_epoch()` function with GNU/BSD fallback chain
  - Safer jq usage with `// empty` for missing timestamps

### Removed

- Closed PR #153 in favor of PR #158 (superset with better design decisions)

---

## [3.7.0] - 2026-01-27

### Added

#### Rate Limit Auto-Resume (Major Feature)

Automatic session resumption when rate limits reset for users running in tmux.

- **Rate Limit Monitor** (`src/features/rate-limit-wait/`)
  - OAuth API-based rate limit status checking
  - tmux pane detection for blocked Claude Code sessions
  - Background daemon that polls and auto-resumes when limit clears
  - CLI commands: `omc wait status`, `omc wait daemon start/stop`, `omc wait detect`

- **Security Hardening**
  - Secure file permissions (0600) for state/PID/log files
  - Input validation for tmux pane IDs (prevents command injection)
  - Text sanitization for tmux send-keys commands
  - Log rotation (1MB limit) to prevent unbounded growth

- **Smart CLI** (`src/cli/commands/wait.ts`)
  - Zero learning curve: `omc wait` shows status and suggests next action
  - `omc wait --start` / `--stop` shortcuts
  - 61 tests covering real-world scenarios

#### Async Hook Lifecycle Modules (5 New Hooks)

Claude Code integration hooks for session and tool lifecycle events.

- **SubagentTracker** (`src/hooks/subagent-tracker/`)
  - Track active subagents with parent mode context
  - File locking mechanism to prevent race conditions
  - Bounded storage (max 100 completed agents) with eviction

- **PreCompact** (`src/hooks/pre-compact/`)
  - Preserve critical state before context compaction
  - Auto-save important discoveries to notepad

- **Setup** (`src/hooks/setup/`)
  - Directory structure initialization on session start
  - Periodic maintenance tasks

- **PermissionRequest** (`src/hooks/permission-handler/`)
  - Smart auto-approval for safe commands during active modes
  - Shell metacharacter injection prevention
  - Safe command allowlist (git, npm, tsc, eslint, pytest, etc.)

- **SessionEnd** (`src/hooks/session-end/`)
  - Record session metrics
  - Cleanup transient state
  - Export summaries

#### Delegation Enforcement (Production-Ready)

Configurable enforcement for orchestrator delegation behavior.

- **Configuration Levels**
  - `off`: No enforcement
  - `warn`: Warnings for direct source file edits (default)
  - `strict`: Block direct source file modifications

- **Performance Optimizations**
  - 30-second TTL cache for config reads (avoids sync I/O on hot path)
  - Fixed nullish coalescing bug (`||` → `??`)

- **Smart Agent Suggestions**
  - Suggests appropriate agent based on file extension
  - Audit logging to `.omc/logs/delegation-audit.jsonl`

- **635 tests** for delegation enforcement levels

### Fixed

- **Shell Metacharacter Injection** (CRITICAL): Added `DANGEROUS_SHELL_CHARS` regex to reject commands with `;`, `&`, `|`, `` ` ``, `$`, `()`, `<>`, `\n`, `\\`
- **Blanket Auto-Approval** (CRITICAL): Active modes now require BOTH `isActiveModeRunning()` AND `isSafeCommand()` checks
- **Arbitrary File Access** (HIGH): Removed `cat`, `head`, `tail` from safe command patterns
- **Race Condition** (HIGH): Added file locking to subagent-tracker with 5-second timeout
- **Unbounded Memory** (HIGH): Capped `completed_agents` at 100 with oldest-first eviction
- **Config Caching**: Added 30s TTL cache to avoid sync file reads on every tool call

### Technical Details

**New Files:**

- `src/features/rate-limit-wait/` - Rate limit auto-resume feature (6 files)
- `src/cli/commands/wait.ts` - CLI integration
- `src/hooks/subagent-tracker/index.ts` - Subagent lifecycle tracking
- `src/hooks/pre-compact/index.ts` - Pre-compaction state preservation
- `src/hooks/session-end/index.ts` - Session end cleanup
- `src/hooks/setup/index.ts` - Directory initialization
- `src/hooks/permission-handler/index.ts` - Permission request handling
- `scripts/*.mjs` - Standalone hook entry scripts (6 files)
- `SECURITY-FIXES.md` - Security fix documentation

**Tests Added:**

- 61 rate-limit-wait tests (daemon, integration, monitor, tmux-detector)
- 69 permission-handler security tests
- 635 delegation-enforcement-levels tests

**Configuration:**

- Local: `.omc/config.json` → `delegationEnforcementLevel`
- Global: `~/.claude/.omc-config.json` → `delegationEnforcementLevel`

## [3.6.3] - 2026-01-27

### Fixed

- Fix npm package references (`oh-my-claudecode` → `oh-my-claude-sisyphus`) in docs/MIGRATION.md, commands/doctor.md, skills/doctor/SKILL.md

## [3.6.2] - 2026-01-27

### Added

#### Project Session Manager (PSM) Skill

New skill for managing isolated project sessions with automatic context injection.

- **PSM Skill** (`skills/psm/`)
  - `/oh-my-claudecode:psm` command for project session management
  - Automatic CLAUDE.md and AGENTS.md injection on session start
  - Project isolation with dedicated session contexts
  - Session persistence and resume support
  - Integration with existing oh-my-claudecode workflows

### Changed

- Updated skill count: 40 → 41 (added psm)

## [3.6.0] - 2026-01-26

### Added

#### SQLite-based Swarm Coordination (Major Feature)

Production-ready multi-agent task coordination with atomic claiming and transaction isolation.

- **SQLite Database Backend** (`src/hooks/swarm/`)
  - Atomic task claiming with IMMEDIATE transaction mode
  - Lease-based ownership with 5-minute timeout
  - Heartbeat monitoring for agent health
  - Stale claim cleanup with automatic release
  - WAL mode for concurrent read access

- **Mode Registry** (`src/hooks/mode-registry/`)
  - Centralized mode state detection via file-based approach
  - Mutual exclusion between exclusive modes (autopilot, ultrapilot, swarm, pipeline)
  - Stale marker detection with 1-hour auto-removal
  - Marker file management for SQLite-based modes

- **Worker Preamble Protocol** (`src/agents/preamble.ts`)
  - Prevents worker agents from spawning their own sub-agents
  - Ensures agents use tools directly (Read, Write, Edit, Bash)
  - Requires agents to report results with absolute file paths
  - Documented in AGENTS.md

- **Ultrapilot Decomposer** (`src/hooks/ultrapilot/decomposer.ts`)
  - AI-powered task decomposition for parallel execution
  - File ownership assignment with non-overlapping patterns
  - Dependency tracking and execution order calculation

- **37 new tests** across 3 test files for swarm coordination

### Changed

#### State File Standardization

All execution mode state files consolidated into `.omc/state/` subdirectory:

- `autopilot-state.json`
- `ralph-state.json`
- `ultrawork-state.json`
- `ultraqa-state.json`
- `ultrapilot-state.json`
- `swarm.db` (SQLite database)
- `pipeline-state.json`
- `ecomode-state.json`

#### Skill Files Updated

All skill files now include explicit "STATE CLEANUP ON COMPLETION" sections instructing to delete state files rather than just setting `active: false`.

### Fixed

- **Path consistency**: Fixed path mismatches between mode-registry and cancel skill
- **Transaction isolation**: All 6 swarm transactions use `.immediate()` for proper write locking
- **Init error handling**: `cleanupOnFailure()` prevents leftover state on initialization errors

### Technical Details

**New Files:**

- `src/hooks/swarm/index.ts` - Main swarm coordination module
- `src/hooks/swarm/state.ts` - SQLite state management
- `src/hooks/swarm/claiming.ts` - Atomic task claiming
- `src/hooks/swarm/types.ts` - TypeScript interfaces
- `src/hooks/mode-registry/types.ts` - Mode registry types
- `src/agents/preamble.ts` - Worker preamble protocol
- `src/hooks/ultrapilot/decomposer.ts` - Task decomposition

**Dependencies Added:**

- `better-sqlite3` - SQLite3 binding for Node.js

## [3.5.7] - 2026-01-25

### Added

- feat(skills): add learn-about-omc skill for usage pattern analysis

### Changed

- feat(skills): consolidate 42 skills to 37 (removed deprecated cancel-\* skills, added build-fix, code-review, security-review, writer-memory, project-session-manager, local-skills-setup, skill)

### Fixed

- fix(tests): skip unimplemented delegation-enforcer tests
- fix(tests): correct analytics agent attribution expectations

### Removed

- chore: remove deprecated cancel-\* skills (use /cancel instead)

## [3.5.1] - 2026-01-24

### Added

#### Learned Skills Auto-Matching & Invocation System

Smart skill matching with fuzzy matching, pattern detection, and auto-invocation for learned skills.

- **Skill Matcher** (`src/hooks/learner/matcher.ts`)
  - Fuzzy matching using Levenshtein distance
  - Glob and regex pattern support for triggers
  - Context extraction (errors, files, code patterns)
  - Confidence scoring (0-100) for match quality

- **Auto-Learner** (`src/hooks/learner/auto-learner.ts`)
  - Pattern detection from problem-solution pairs
  - Skill worthiness scoring algorithm
  - Auto-trigger extraction from conversation context
  - Suggestion threshold (70+ confidence)

- **Auto-Invoke** (`src/hooks/learner/auto-invoke.ts`)
  - High-confidence auto-invocation (80+ threshold)
  - Session tracking with cooldown to prevent spam
  - Success/failure analytics for learning

- **New Skills**
  - `local-skills-setup` - Guided wizard for skill directory setup and management
  - `skill` - CLI commands for list/add/remove/edit/search/sync local skills

- **90 new tests** for matcher, auto-learner edge cases, security, and performance

#### Analytics Backfill System

Complete offline transcript analysis pipeline for token usage and cost tracking.

- **Transcript Scanner** (`src/analytics/transcript-scanner.ts`)
  - Scans `~/.claude/projects/` for session JSONL files
  - Smart path decoding handles hyphenated directory names
  - Project filtering and date range support

- **Transcript Parser** (`src/analytics/transcript-parser.ts`)
  - Streaming JSONL parser with AbortSignal support
  - Memory-efficient line-by-line processing
  - Graceful handling of malformed entries

- **Token Extractor** (`src/analytics/transcript-token-extractor.ts`)
  - Extracts token usage from both `assistant` and `progress` entry types
  - **Proper agent attribution**: Progress entries (actual agent responses) correctly attributed via `parentToolUseID` → `toolUseId` lookup
  - Model normalization (claude-sonnet-4-5-20250929 → claude-sonnet-4.5)
  - Haiku model detection from progress entries
  - Skips `<synthetic>` model entries

- **Backfill Engine** (`src/analytics/backfill-engine.ts`)
  - Orchestrates the full pipeline: scan → parse → extract → deduplicate → store
  - Progress events for UI feedback
  - Batch processing with configurable batch size
  - Dry-run mode for testing

- **Backfill Deduplication** (`src/analytics/backfill-dedup.ts`)
  - SHA256-based entry ID generation for consistent deduplication
  - Persistent state in `~/.omc/state/backfill-state.json`
  - Prevents duplicate entries on re-runs

- **CLI Command** (`omc backfill`)
  - Progress bar with real-time stats
  - Options: `--project`, `--from`, `--to`, `--dry-run`, `--verbose`
  - Auto-backfill on first `omc stats` run

- **Global Token Tracking**
  - All token data stored globally in `~/.omc/state/` (not per-project)
  - Cross-session aggregate statistics via `getAllStats()`
  - Proper "(main session)" attribution for non-agent token usage

- **Documentation** (`docs/ANALYTICS-SYSTEM.md`)
  - Complete system architecture documentation
  - Data flow diagrams and file format specifications

### Fixed

- **Agent Cost Attribution**: Previously spawned agent costs were hidden in "(main session)" because progress entries weren't properly attributed. Now correctly shows:
  - Main session: ~60% of cost (direct user interactions)
  - Spawned agents: ~40% of cost (delegated work)

- **Haiku Model Detection**: Haiku responses stored as `type: "progress"` entries with nested `data.message.message.usage` are now properly detected

- **Model Name Normalization**: Handles full model names (claude-sonnet-4-5-20250929) and normalizes to pricing tiers

### Technical Details

**Agent Attribution Fix:**

```
Before: Assistant entries with Task calls → incorrectly attributed to agent
        Progress entries (actual agent work) → hidden in "(main session)"

After:  Assistant entries → correctly attributed to "(main session)"
        Progress entries → correctly attributed via parentToolUseID lookup
```

**New Files:**

- `src/analytics/transcript-scanner.ts` - Directory scanning
- `src/analytics/transcript-parser.ts` - JSONL streaming parser
- `src/analytics/transcript-token-extractor.ts` - Token extraction with agent lookup
- `src/analytics/backfill-engine.ts` - Pipeline orchestration
- `src/analytics/backfill-dedup.ts` - Deduplication state
- `src/analytics/analytics-summary.ts` - Fast mtime-based caching
- `src/cli/commands/backfill.ts` - CLI command
- `docs/ANALYTICS-SYSTEM.md` - System documentation
- `src/__tests__/analytics/*.test.ts` - 105 tests

## [3.4.2] - 2026-01-24

### Fixed

- **Critical**: Updated `.claude-plugin/plugin.json` version to 3.4.2
  - Required for Claude Code plugin system to recognize the latest version
  - Ensures proper plugin version detection and updates

- **Website**: Updated to v3.4.2
  - Version badge updated
  - Skills count updated to 40

## [3.4.1] - 2026-01-24

### Added

#### New Features

- **Metadata Sync System**: Automated documentation synchronization tool
  - `scripts/sync-metadata.ts` - Syncs version, agent count, skill count across all docs
  - npm scripts: `sync-metadata`, `sync-metadata:verify`, `sync-metadata:dry-run`
  - `docs/SYNC-SYSTEM.md` - Comprehensive documentation (528 lines)
  - Dynamically counts agents (32) and skills (40) from filesystem
  - Single source of truth: package.json

- **New Skills** (3):
  - `build-fix` - Fix build and TypeScript errors with minimal changes
  - `code-review` - Comprehensive code review with severity ratings
  - `security-review` - OWASP Top 10 security vulnerability detection

- **New Commands** (5):
  - `cancel` - Unified cancellation for all modes
  - `cancel-ecomode` - Cancel ecomode (deprecated, use unified cancel)
  - `pipeline` - Sequential agent chaining with built-in presets
  - `planner` - Strategic planning with interview workflow
  - `swarm` - N coordinated agents with atomic task claiming

### Fixed

- **Documentation Consistency** (33 issues):
  - Updated all agent counts from 19/28 to 32 across all documentation
  - Updated skill counts from 21/31/37 to 40 across all documentation
  - Added v3.4.0 features section to docs/FULL-README.md
  - Added v3.3.x → v3.4.0 migration guide (220 lines)
  - Fixed section titles ("The Twelve Agents" → "The 32 Specialized Agents")
  - Documented unified cancel command with deprecation notices
  - Fixed cross-reference inconsistencies

- **Skill/Command Discrepancies**:
  - Fixed 13 mismatches between skills/ and commands/ directories
  - All user-invocable skills now have matching command files
  - Documented 5 internal/silent skills (frontend-ui-ux, git-master, orchestrate, omc-default, omc-default-global)

- **GitHub Metadata**:
  - Updated repository description to highlight all 5 execution modes
  - Added topics: multi-agent-systems, parallel-execution, automation
  - Updated counts: 32 agents, 31+ skills → 40 skills

- **Website Repository**:
  - Updated oh-my-claudecode-website to v3.4.0
  - Added ultrapilot, swarm, pipeline, ecomode features
  - Updated agent count from 28 to 32

### Changed

- Total skill count: 37 → 40 (build-fix, code-review, security-review added)
- Total command count: 32 → 35 (cancel, cancel-ecomode, pipeline, planner, swarm added)
- Package.json: Added sync-metadata scripts and tsx dependency

## [3.4.0] - 2026-01-23

### Added

#### New Features

- **Ultrapilot**: Parallel autopilot with up to 5 concurrent workers
  - Task decomposition engine for breaking complex tasks into parallelizable subtasks
  - File ownership coordination to prevent worker conflicts
  - Coordinator hook for managing shared files (package.json, tsconfig.json, etc.)
  - Auto-fallback to regular autopilot for non-parallelizable tasks
  - State tracking in `.omc/state/ultrapilot-state.json` and `.omc/state/ultrapilot-ownership.json`

- **Swarm Skill**: N coordinated agents with atomic task claiming
  - Shared task list with pending/claimed/done status tracking
  - 5-minute timeout per task with auto-release
  - Usage: `/swarm 5:executor "fix all TypeScript errors"`

- **Pipeline Skill**: Sequential agent chaining with data passing
  - Built-in presets: review, implement, debug, research, refactor, security
  - Branching logic based on output conditions
  - Parallel-then-merge execution patterns
  - Custom pipeline syntax with model specification

- **Unified Cancel Skill**: Smart cancellation for all modes
  - Auto-detects active mode (autopilot, ralph, ultrawork, ecomode, ultraqa, swarm, ultrapilot, pipeline)
  - Handles dependency-aware cancellation order
  - `--force` flag to clear ALL states

- **Ecomode**: Token-efficient parallel execution mode
  - Uses Haiku for simple tasks, Sonnet for standard work
  - Automatic model tier selection based on task complexity
  - Usage: `/ecomode "task"` or say "ecomode" keyword
  - State tracking in `.omc/ecomode-state.json`

- **Verification Module** (`src/features/verification/`)
  - Reusable verification protocol for ralph, ultrawork, and autopilot
  - 7 standard checks: BUILD, TEST, LINT, FUNCTIONALITY, ARCHITECT, TODO, ERROR_FREE
  - Evidence validation with 5-minute freshness detection
  - Multiple report formats: markdown, text, JSON
  - Parallel/sequential execution with fail-fast support

- **State Management Module** (`src/features/state-manager/`)
  - Standardized state locations: `.omc/state/{name}.json` (local), `~/.omc/state/{name}.json` (global)
  - `StateManager` class and function-based API
  - Legacy location support with auto-migration
  - Orphaned state cleanup utility

- **Task Decomposition Engine** (`src/features/task-decomposer/`)
  - Strategies: fullstack-app, refactoring, bug-fixes, features
  - Automatic agent type selection (designer for frontend, executor for backend)
  - File ownership assignment with non-overlapping patterns
  - Execution order calculation with dependency tracking

- **Explore-High Agent**: Opus-powered architectural search
  - Deep system understanding and pattern analysis
  - Complex architectural mapping capabilities

- **Agent Prompt Template System** (`agents/templates/`)
  - Base template with injection points
  - Tier-specific instructions (LOW/MEDIUM/HIGH)
  - Shared verification protocols

- **Delegation Enforcer Middleware**
  - Automatic model injection from agent definitions
  - Explicit model preservation (user-specified models never overwritten)
  - Debug mode warnings when `OMC_DEBUG=true`

### Changed

#### Consolidation

- **Ralph Hooks**: Consolidated from 4 directories into single `src/hooks/ralph/`
  - Merged: ralph-loop, ralph-prd, ralph-progress, ralph-verifier
  - Clean facade via `src/hooks/ralph/index.ts`

- **Recovery Module**: Unified from 3 modules into `src/hooks/recovery/`
  - Merged: context-window-limit-recovery, edit-error-recovery, session-recovery
  - Priority-based handling: Context Window → Session → Edit
  - Single `handleRecovery()` entry point

- **Autopilot Hooks**: Refactored from 10 to 7 files
  - Merged: signals.ts → enforcement.ts
  - Merged: transition.ts → state.ts
  - Merged: summary.ts → validation.ts

- **Ultra\* Hooks**: Renamed for consistency
  - `ultrawork-state/` → `ultrawork/`
  - `ultraqa-loop/` → `ultraqa/`

- **Plan/Planner Skills**: Merged planner interview logic into plan skill
  - Dual mode: interview (broad requests) and direct planning (detailed requirements)
  - Auto-detection of when to use interview vs direct planning

- **Setup Skills**: Consolidated into omc-setup
  - `--local` flag for direct local configuration
  - `--global` flag for direct global configuration
  - Integrated omc-default and omc-default-global functionality

- **Ralph-Init**: Merged into ralph skill with `--init` flag support

- **Migration Docs**: Consolidated MIGRATION.md and MIGRATION-v3.md into single file
  - Version-organized sections: v2.x→v3.0, v3.0→v3.1, v3.x→v4.0

#### Bug Fixes

- **Agent defaultModel Property**: All 30 agents now have explicit `defaultModel` property
  - LOW tier: haiku
  - MEDIUM tier: sonnet
  - HIGH tier: opus
  - Enables proper model routing via delegation middleware

- **QA-Tester-High Prompt**: Extracted inline prompt to `agents/qa-tester-high.md`
  - Follows same pattern as other agents with external prompts

#### Test Fixes

- Updated skills.test.ts count from 35 to 37 (added cancel-ecomode, ecomode)
- Updated installer.test.ts to check for Migration section instead of inline compatibility text
- All 612 tests passing

### Skills (37 total, 7 new)

| New Skill        | Description                             |
| ---------------- | --------------------------------------- |
| `cancel`         | Unified cancellation for all modes      |
| `pipeline`       | Sequential agent chaining               |
| `swarm`          | N coordinated agents with task claiming |
| `ultrapilot`     | Parallel autopilot (3-5x faster)        |
| `mcp-setup`      | MCP server configuration                |
| `ecomode`        | Token-efficient parallel execution      |
| `cancel-ecomode` | Cancel ecomode mode                     |

### Agents (30 total, 1 new)

| New Agent      | Model | Description                  |
| -------------- | ----- | ---------------------------- |
| `explore-high` | opus  | Complex architectural search |

### New Modules

| Module              | Location                              | Purpose                                   |
| ------------------- | ------------------------------------- | ----------------------------------------- |
| Verification        | `src/features/verification/`          | Reusable verification protocols           |
| State Manager       | `src/features/state-manager/`         | Standardized state management             |
| Task Decomposer     | `src/features/task-decomposer/`       | Task decomposition for parallel execution |
| Ultrapilot          | `src/hooks/ultrapilot/`               | Parallel autopilot coordinator            |
| Delegation Enforcer | `src/features/delegation-enforcer.ts` | Model injection middleware                |

### Files Changed Summary

- **New files**: 50+
- **Modified files**: 35+
- **Deleted files**: 15+ (consolidated into unified modules)
- **Tests**: 612 passing (all green)

## [3.3.10] - 2026-01-23

### Added

- **omc-setup**: GitHub star prompt after setup completion (#82)
  - Uses AskUserQuestion for clickable UI
  - Falls back to URL display if `gh` CLI unavailable
- **HUD**: Optional visual progress bars for context and rate limits (#81)
  - New `useBars` config option in HudElementConfig
  - Enabled by default in focused/full/dense presets
  - Format: `ctx:[████░░░░░░]67%` and `5h:[████░░░░░░]45%`

## [3.3.8] - 2026-01-23

### Added

- **Windows 100% Cross-Platform Compatibility**: Full Windows support across the entire codebase
  - New `src/platform/` module with unified platform detection utilities
  - Cross-platform process management (taskkill on Windows, negative PID on Unix)
  - Process start time detection via WMIC (Windows), /proc (Linux), ps (macOS)
  - O_NOFOLLOW fallback for Windows (doesn't exist on that platform)
  - Windows LOCALAPPDATA for runtime directories
  - Cross-platform path handling using path.parse(), path.basename(), path.join()
  - Windows npm-based auto-update (instead of bash scripts)
  - windowsHide: true on all exec calls to prevent console flashing

### Changed

- Deduplicated process utilities in bridge-manager.ts and session-lock.ts to use central platform module
- Improved LSP workspace root detection for Windows paths

## [3.3.7] - 2026-01-22

### Added

- MCP server configuration skill (`/oh-my-claudecode:mcp-setup`) for Context7, Exa, Filesystem, GitHub (#74)
- MCP setup integrated into omc-setup wizard

### Fixed

- ralplan now ensures critic agent executes before plan approval in plan mode (#73)
- README contradiction about command learning vs magic keywords (#72)

## [3.3.5] - 2026-01-22

### Fixed

- **AskUserQuestion Tool Enforcement in Plan Mode** (#70): Planner now uses the `AskUserQuestion` tool for preference questions, allowing users to select options via clickable UI instead of typing responses
  - Added MANDATORY section to `agents/planner.md` with examples and question type classification
  - Added global reminder to `docs/CLAUDE.md` in Internal Protocols
  - Enhanced `skills/planner/SKILL.md` with question types and exception cases
  - Enhanced `skills/plan/SKILL.md` with clickable UI explanation

## [3.3.0] - 2026-01-21

### Added

- **Scientist Agent**: New specialized agent for data analysis and research execution
  - Three tiers: `scientist` (Sonnet), `scientist-low` (Haiku), `scientist-high` (Opus)
  - Structured output markers: `[OBJECTIVE]`, `[DATA]`, `[FINDING]`, `[STAT:*]`, `[LIMITATION]`
  - Stage execution markers for multi-phase research workflows
  - Quality gates ensuring statistical evidence for all findings

- **Persistent Python REPL Tool** (`python_repl`): True variable persistence for data analysis
  - Unix socket-based Python bridge server (`bridge/gyoshu_bridge.py`)
  - Actions: `execute`, `reset`, `get_state`, `interrupt`
  - Variables persist across tool invocations - no file-based state needed
  - JSON-RPC 2.0 protocol with structured marker parsing
  - Memory tracking (RSS/VMS) in output
  - Session locking with PID verification for safe concurrent access
  - Security: Socket mode 0600, path validation, symlink protection, signal escalation

- **Research Command** (`/oh-my-claudecode:research`): Orchestrate parallel scientist agents for complex research
  - Multi-stage decomposition (3-7 independent stages)
  - Smart model routing: LOW (Haiku) / MEDIUM (Sonnet) / HIGH (Opus)
  - Parallel execution with 5 agent concurrency limit
  - Cross-validation and verification loop
  - AUTO mode for fully autonomous execution with loop control
  - Session persistence and resume support
  - Structured report generation with findings aggregation

### Technical Details

**New Files Created:**

- `src/tools/python-repl/` - Complete MCP tool implementation (~2,100 lines)
  - `types.ts` - TypeScript interfaces
  - `paths.ts` - Path utilities with security validation
  - `session-lock.ts` - File-based locks with PID verification
  - `socket-client.ts` - JSON-RPC 2.0 client
  - `bridge-manager.ts` - Python process lifecycle management
  - `tool.ts` - Main tool handler
  - `index.ts` - Tool export
- `src/lib/atomic-write.ts` - Atomic file operations
- `bridge/gyoshu_bridge.py` - Python JSON-RPC 2.0 server (~850 lines)
- `src/agents/scientist.ts` - Scientist agent definition
- `agents/scientist.md`, `scientist-low.md`, `scientist-high.md` - Agent prompts
- `skills/research/SKILL.md` - Research orchestration skill

**Usage Example:**

```
# Variables persist across calls!
python_repl(action="execute", researchSessionID="analysis",
            code="import pandas as pd; df = pd.read_csv('data.csv')")

# df still exists - no need to reload
python_repl(action="execute", researchSessionID="analysis",
            code="print(df.describe())")
```

### Changed

- Agent count: 28 (added scientist, scientist-low, scientist-high)
- Skill count: 30 (added research)
- Updated `src/tools/index.ts` to include `pythonReplTool`
- Updated `package.json` to include `bridge/` in published files

---

## [3.2.5] - 2026-01-21

### Added

- **PreToolUse hooks**: Soft enforcement for delegation via `pre-tool-use.sh` and `pre-tool-use.mjs`
  - Warns when orchestrator attempts direct Edit/Write on source files
  - Detects file modification patterns in Bash commands (sed -i, redirects, etc.)
  - Path-based exceptions for `.omc/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`
  - Soft warning only - operations proceed but reminder to delegate is shown

### Changed

- **Command file updates**: autopilot.md, ralph.md, ultrawork.md now include explicit delegation enforcement tables
- **Clearer orchestrator vs implementer distinction**: Documentation emphasizes "YOU ARE AN ORCHESTRATOR, NOT AN IMPLEMENTER"

---

## [3.2.0] - 2026-01-21

### Added

- **Autopilot Command** (`/oh-my-claudecode:autopilot`): Full autonomous execution from idea to working code
  - 5-phase workflow: Expansion → Planning → Execution → QA → Validation
  - Magic keywords: "autopilot", "build me", "create me", "I want a/an"
  - Parallel validation with 3 architects (functional, security, quality)
  - Resume support with progress preservation
- **Cancel-autopilot Skill** (`/oh-my-claudecode:cancel-autopilot`): Graceful cancellation with state preservation
- **8 new specialized agents registered**: security-reviewer, security-reviewer-low, build-fixer, build-fixer-low, tdd-guide, tdd-guide-low, code-reviewer, code-reviewer-low
- **Autopilot HUD element**: Real-time phase progress display

### Changed

- Agent count: 20 → 28 (8 previously documented agents now registered)
- Skill count: 26 → 28 (autopilot + cancel-autopilot)
- Updated docs/CLAUDE.md with autopilot integration

---

## [3.1.1] - 2026-01-21

### Added

- **Non-blocking queue system**: Background tasks now enter `'queued'` status when waiting for concurrency slot
- **Stale session detection**: New `staleThresholdMs` and `onStaleSession` callback detect hung tasks (default: 5 min)
- **Model preservation**: Background tasks inherit parent session's model via `parentModel` field
- **User abort detection**: New `StopContext` and `isUserAbort()` detect user-initiated stops (Ctrl+C, cancel)

### Changed

- **Capacity enforcement**: `maxTotalTasks` now counts both running AND queued tasks
- **Status display**: `getStatusSummary()` shows queued count and wait times
- **Continuation hooks**: Ralph-loop, ultrawork, and todo-continuation now respect user aborts

### Fixed

- **Graceful stop handling**: Users can now cleanly exit persistent modes without forced continuation

---

## [3.1.0] - 2026-01-21

### Added

- **8 new specialized agents** (ECC integration):
  - `security-reviewer` / `security-reviewer-low`: Security vulnerability analysis
  - `build-fixer` / `build-fixer-low`: Build error diagnosis and fixes
  - `tdd-guide` / `tdd-guide-low`: Test-driven development guidance
  - `code-reviewer` / `code-reviewer-low`: Code review and quality feedback
- **Update notification**: omc-setup now checks for and notifies about available updates
- **Rate limit reset times**: HUD shows when limits reset (e.g., `5h:0% wk:100%(1d6h)`)
- **Todos on second line**: HUD now displays todos separately as `todos:3/5 (working: task)`

### Changed

- **omc-setup rebuild behavior**: Now shows version changes when refreshing CLAUDE.md
- **Cache clearing**: omc-setup automatically removes stale plugin cache versions
- **API timeout**: Increased from 5s to 10s for slower connections
- **Cache TTL**: Reduced from 60s to 30s for fresher rate limit data

### Fixed

- **Credential reading**: Handle nested `claudeAiOauth` wrapper in credentials.json
- **HUD semver sorting**: Fixed version comparison to use numeric sort instead of alphabetical
- **ESLint**: Disabled `no-control-regex` for ANSI escape code handling in tests

## [3.0.11] - 2026-01-20

### Changed

- **Fully-qualified command names**: Documentation now uses `/oh-my-claudecode:omc-setup` and `/oh-my-claudecode:help` for namespace consistency
- **Commands folder populated**: All user-facing commands now have full content (copied from skills)
- **Separated commands vs skills**:
  - 20 commands (user-facing): analyze, cancel-ralph, cancel-ultraqa, cancel-ultrawork, deepinit, deepsearch, doctor, help, hud, learner, note, omc-setup, plan, ralph, ralph-init, ralplan, release, review, ultraqa, ultrawork
  - 6 skills-only (internal): orchestrate, frontend-ui-ux, git-master, omc-default, omc-default-global, planner
- **Consolidated planner into plan**: `planner` is now skill-only; users invoke via `/oh-my-claudecode:plan`

---

## [3.0.0] - 2026-01-20

### 🎨 Complete Rebrand - From Mythology to Intuition

This is a **breaking release** that renames the entire project and all agent names for clarity and accessibility.

### Breaking Changes

- **Project Renamed**: Project renamed to `oh-my-claudecode`
  - npm package remains `oh-my-claude-sisyphus`: `npx oh-my-claude-sisyphus install`
  - Plugin name is `oh-my-claudecode` for Claude Code integration

- **Agent Names Changed**: Greek mythology → Intuitive names
  - `prometheus` → `planner` (strategic planning)
  - `momus` → `critic` (plan review)
  - `oracle` → `architect` (architecture & debugging)
  - `metis` → `analyst` (pre-planning analysis)
  - `mnemosyne` → `learner` (learned skills system)
  - `sisyphus-junior` → `executor` (focused execution)
  - `librarian` → `researcher` (documentation research)
  - `frontend-engineer` → `designer` (UI/UX work)
  - `document-writer` → `writer` (technical documentation)
  - `multimodal-looker` → `vision` (visual analysis)
  - `orchestrator-sisyphus` → `orchestrator` (task coordination)

- **Directory Structure**: `.sisyphus/` → `.omc/` (oh-my-claudecode)
  - State files now in `~/.claude/.omc/`
  - Runtime plans in `.omc/plans/`
  - Session notes in `.omc/notepads/`

- **Environment Variables**: `SISYPHUS_*` → `OMC_*`
  - All environment variable prefixes updated for consistency

- **Slash Commands Updated**: Agent-referencing commands now use new names
  - `/oh-my-claudecode:plan` now uses `planner` agent (was `prometheus`)
  - `/oh-my-claudecode:review` now uses `critic` agent (was `momus`)
  - `/oh-my-claudecode:mnemosyne` → `/oh-my-claudecode:learner` for skill extraction

### Migration Guide

For existing users upgrading from 2.x:

1. **Reinstall**: Run `npx oh-my-claude-sisyphus install` to update hooks and configs
2. **State Migration**: Old `.sisyphus/` directories will continue to work, but new state saves to `.omc/`
3. **Agent References**: Update any custom scripts/configs that referenced old agent names
4. **Environment Variables**: Rename any `SISYPHUS_*` variables to `OMC_*`

### Rationale

The Greek mythology naming convention, while elegant, created barriers for new users:

- Non-obvious agent purposes ("What does Prometheus do?")
- Cultural accessibility concerns
- Increased cognitive load for remembering agent roles

The new intuitive names (`planner`, `architect`, `critic`) make the system immediately understandable.

### Note on Historical Entries

All changelog entries below v3.0.0 reference the old names (`prometheus`, `sisyphus-junior`, etc.) - this is intentional and accurate for those versions.

---

## [3.0.0-beta] - 2026-01-19

### 🧠 Mnemosyne - Learned Skills System (Major Feature)

Named after the Greek Titan goddess of memory, **Mnemosyne** enables Claude to extract, store, and automatically reuse knowledge from problem-solving sessions.

### 📊 Sisyphus HUD - Multi-Agent Statusline (Major Feature)

Real-time visualization of the Sisyphus orchestration system via Claude Code's statusline.

### Added

- **Mnemosyne - Learned Skills** (`src/hooks/mnemosyne/`)
  - `/oh-my-claudecode:mnemosyne` command to extract reusable skills from conversations
  - Automatic skill injection based on trigger keywords in user messages
  - **Hybrid storage**: User-level (`~/.claude/skills/sisyphus-learned/`) + Project-level (`.sisyphus/skills/`)
  - YAML frontmatter format for skill metadata (triggers, tags, quality scores)
  - Quality gate validation for skill extraction
  - Pattern detection for extractable moments (problem-solution, technique, workaround, optimization)
  - Promotion from ralph-progress learnings to skills
  - Configuration system with `~/.claude/sisyphus/mnemosyne.json`
  - `skill-injector.mjs` hook for UserPromptSubmit

- **Sisyphus HUD Statusline** (`src/features/hud/`)
  - Real-time statusline showing system state
  - **Display presets**: minimal, focused (default), full
  - **Elements**: ralph loop progress, PRD story, ultrawork status, context usage, agents, background tasks, todos
  - **Color coding**: Green (healthy), Yellow (warning), Red (critical)
  - `/oh-my-claudecode:hud` command to configure display options
  - Auto-refresh every ~300ms during active sessions
  - Type-coded agent visualization with model tier colors

- **New Commands**
  - `/oh-my-claudecode:mnemosyne` - Extract learned skills from current conversation
  - `/oh-my-claudecode:hud [preset]` - Configure HUD display (minimal/focused/full)
  - `/oh-my-claudecode:hud status` - Show detailed HUD status

- **New Test Suites**
  - `src/__tests__/mnemosyne/` - 41 tests for learned skills system
  - `src/__tests__/hud-agents.test.ts` - 44 tests for HUD agents
  - Total: **443 tests** (up from 399)

### Changed

- **Module Naming**: Adopted Greek mythology naming convention
  - `learned-skills` → `mnemosyne` (goddess of memory)
  - Exports: `Claudeception*` → `Mnemosyne*`

- **Context Injector**: Added `mnemosyne` as a context source type

### Breaking Changes

- Renamed `/oh-my-claudecode:claudeception` to `/oh-my-claudecode:mnemosyne`
- Renamed config from `claudeception.json` to `mnemosyne.json`
- Module path changed from `hooks/learned-skills` to `hooks/mnemosyne`

---

## [2.6.1] - 2026-01-19

### Added

- **Help Command** (`commands/help.md`)
  - Comprehensive `/oh-my-claudecode:help` command to guide users on plugin usage
  - Quick reference for all 19 commands and 19 agents
  - Example workflows for common tasks
  - Tips for effective usage and best practices
  - Integration with plugin documentation

### Fixed

- **Stop Hook Compatibility** (`scripts/persistent-mode.mjs`)
  - Fixed ERR_MODULE_NOT_FOUND error when upgrading from 2.5.0 to 2.6.0
  - Made notepad module import dynamic with graceful fallback
  - Hook now works even if notepad module is missing (backward compatibility)

## [2.6.0] - 2026-01-19

### 🧠 Compaction-Resilient Memory System (Major Feature)

This release introduces a **three-tier memory system** that survives context compaction, ensuring Claude never loses critical project knowledge during long sessions.

### 🔄 Ralph Loop PRD Support (Major Feature)

Implements structured task tracking inspired by the original [Ralph](https://github.com/snarktank/ralph) project. This brings PRD-based task management to ralph-loop, enabling reliable completion tracking across iterations.

### Added

- **Notepad Memory System** (`src/hooks/notepad/index.ts`) - **Compaction-Resilient Context**
  - `.sisyphus/notepad.md` persists across context compactions
  - **Three-tier storage architecture:**
    - **Priority Context** - Always loaded on session start (max 500 chars, critical discoveries)
    - **Working Memory** - Session notes with timestamps (auto-pruned after 7 days)
    - **MANUAL** - User content that is never auto-pruned
  - **Auto-injection** of Priority Context via SessionStart hook
  - **Auto-pruning** of old Working Memory entries on session stop
  - `/note <content>` command for manual note-taking

- **Remember Tag Auto-Capture** (`src/installer/hooks.ts`) - **PostToolUse Hook**
  - `<remember>content</remember>` - Auto-saves to Working Memory section
  - `<remember priority>content</remember>` - Auto-saves to Priority Context section
  - Agents can output remember tags to persist discoveries across compactions
  - Works without jq dependency (grep/sed fallback)
  - Installed as `post-tool-use.sh` hook

- **PRD (Product Requirements Document) Support** (`src/hooks/ralph-prd/index.ts`)
  - `prd.json` structured task format with user stories, acceptance criteria, priorities
  - Story status tracking (`passes: boolean`) for completion detection
  - CRUD operations: `readPrd`, `writePrd`, `markStoryComplete`, `getNextStory`
  - Status calculation: `getPrdStatus` returns completion stats
  - Formatting utilities for display and context injection

- **Progress Memory System** (`src/hooks/ralph-progress/index.ts`)
  - Append-only `progress.txt` for memory persistence between iterations
  - Codebase patterns section for consolidated learnings
  - Per-story progress entries with implementation notes, files changed, learnings
  - Pattern extraction and learning retrieval for context injection

- **New Commands**
  - `/oh-my-claudecode:ralph-init <task>` - Scaffold a PRD from task description with auto-generated user stories
  - `/oh-my-claudecode:ultrawork-ralph <task>` - Maximum intensity mode with completion guarantee (ultrawork + ralph loop)
  - `/oh-my-claudecode:ultraqa <goal>` - Autonomous QA cycling workflow (test → verify → fix → repeat)
  - `/oh-my-claudecode:sisyphus-default` - Configure Sisyphus in local project `.claude/CLAUDE.md`
  - `/oh-my-claudecode:sisyphus-default-global` - Configure Sisyphus globally in `~/.claude/CLAUDE.md`
  - `/oh-my-claudecode:note <content>` - Save notes to notepad.md for compaction resilience

- **New Agent Tiers**
  - `qa-tester-high` (Opus) - Complex integration testing

- **New Hooks**
  - `PostToolUse` hook for processing Task agent output
  - Remember tag detection and notepad integration

- **Comprehensive Test Suites**
  - `src/__tests__/ralph-prd.test.ts` - 29 tests for PRD operations
  - `src/__tests__/ralph-progress.test.ts` - 30 tests for progress tracking
  - `src/__tests__/notepad.test.ts` - 40 tests for notepad operations
  - `src/__tests__/hooks.test.ts` - 18 new tests for design flaw fixes
  - Total: **358 tests** (up from 231)

### Changed

- **Ralph Loop Enhanced**
  - Auto-initializes PRD when user runs `/oh-my-claudecode:ralph-loop` without existing `prd.json`
  - PRD-based completion: loop ends when ALL stories have `passes: true`
  - Context injection includes current story, patterns, and recent learnings
  - Updated continuation prompts with structured story information

- **Persistent Mode Integration**
  - `src/hooks/persistent-mode/index.ts` now imports and uses PRD completion checking
  - Checks PRD status before allowing ralph-loop completion
  - Clears ultrawork state when PRD loop completes (for ultrawork-ralph)

- **Installer Enhanced**
  - Now installs `post-tool-use.sh` hook for remember tag processing
  - Registers `PostToolUse` hook in settings.json
  - Platform-aware hook installation (bash/node.js)

### Fixed

- **Stale position bug in `addPattern`** - Placeholder removal now happens before calculating separator position
- **Type safety in `createPrd`** - New `UserStoryInput` type with optional priority field
- **Recursion guard in `addPattern`** - Prevents infinite loops on repeated initialization failures
- **Todo-continuation infinite loop** - Added max-attempts counter (5) to prevent agent getting stuck
- **UltraQA/Ralph-Loop conflict** - Added mutual exclusion to prevent both loops running simultaneously
- **Agent name prefixing** - Standardized all Task() calls to use `oh-my-claude-sisyphus:` prefix
- **VERSION constant mismatch** - Fixed installer VERSION from 2.4.1 to 2.6.0
- **Completion promise inconsistency** - Standardized to `TASK_COMPLETE`
- **Non-existent /start-work command** - Removed references to command that doesn't exist

### Technical Details

**Notepad.md Structure:**

```markdown
# Notepad

<!-- Auto-managed by Sisyphus. Manual edits preserved in MANUAL section. -->

## Priority Context

<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->

Project uses pnpm not npm
API client at src/api/client.ts

## Working Memory

<!-- Session notes. Auto-pruned after 7 days. -->

### 2026-01-19 10:30

Discovered auth middleware in src/middleware/auth.ts

### 2026-01-19 09:15

Database schema uses PostgreSQL with Prisma ORM

## MANUAL

<!-- User content. Never auto-pruned. -->

User's permanent notes here
```

**Remember Tag Usage:**

```
Agent output: <remember>Project uses TypeScript strict mode</remember>
→ Saved to Working Memory with timestamp

Agent output: <remember priority>API base URL is https://api.example.com</remember>
→ Saved to Priority Context (replaces previous)
```

**PRD Structure:**

```json
{
  "project": "ProjectName",
  "branchName": "ralph/feature-name",
  "description": "Feature description",
  "userStories": [
    {
      "id": "US-001",
      "title": "Story title",
      "description": "User story description",
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "priority": 1,
      "passes": false
    }
  ]
}
```

**Progress.txt Structure:**

```
# Ralph Progress Log
Started: 2026-01-19T...

## Codebase Patterns
- Pattern learned from iteration 1
- Pattern learned from iteration 2

---

## [2026-01-19 12:00] - US-001
**What was implemented:**
- Feature A
- Feature B

**Learnings for future iterations:**
- Important pattern discovered
```

---

## [2.0.1] - 2026-01-13

### Added

- **Vitest test framework** with comprehensive test suite (231 tests)
  - Model routing tests (100 tests)
  - Hook system tests (78 tests)
  - Skill activation tests (15 tests)
  - Installer validation tests (28 tests)
- **Windows native support improvements**
  - Cross-platform command detection (which → where on Windows)
  - Platform-aware auto-update with graceful Windows handling
  - Fixed Unix-only shell redirects

### Changed

- Synced shell script installer with TypeScript installer
- Removed deprecated orchestrator command from shell script
- Removed separate skills directory (now via commands only)

### Fixed

- Cross-platform `which` command replaced with platform-aware detection
- Auto-update now handles Windows gracefully with helpful error message
- Shell script command count matches TypeScript installer (11 commands)
- **Agent frontmatter** - Added missing `name` and `description` fields to all 11 agents
  - Per Claude Code sub-agent specification requirements

---

## [2.0.0-beta.2] - 2026-01-13

### 🧪 New: QA-Tester Agent for Interactive Testing

**Added tmux-based interactive testing capabilities for CLI/service verification.**

### Added

- **QA-Tester Agent** (`src/agents/qa-tester.ts`)
  - Interactive CLI testing using tmux sessions
  - Prerequisite checking (tmux availability, server connections)
  - Structured test execution workflow
  - Oracle → QA-Tester diagnostic loop pattern

- **Smart Gating for qa-tester** in ultrawork/skills
  - Prefer standard test suites over qa-tester when available
  - Use qa-tester only when interactive testing is truly needed
  - Token-efficient verification decisions

- **Adaptive Routing for qa-tester**
  - Simple verification → Haiku
  - Interactive testing → Sonnet
  - Complex integration → Opus

### Changed

- Updated ultrawork skill with verification protocol and qa-tester gating
- Updated ralph-loop and orchestrator with qa-tester integration
- Updated sisyphus command with Agent Combinations section

### Refactored

- **Merged sisyphus+orchestrator+ultrawork into default mode** - 80% behavior overlap consolidated
  - Default mode is now an intelligent orchestrator
  - `/oh-my-claudecode:orchestrator` command deprecated (use default mode or `/oh-my-claudecode:ultrawork`)
  - Skill composition replaces agent swapping
- **Removed deprecated orchestrator command** - Deleted `commands/orchestrator.md` and `orchestratorSkill` (1352 lines)
- **Updated attribution** - Changed from "Port of" to "Inspired by" oh-my-opencode (70% divergence)

### Fixed

- **Migrated to ESLint v9 flat config** - Created `eslint.config.js` for modern ESLint
- **Resolved all 50 lint warnings** - Removed unused imports, fixed prefer-const, updated re-exports
- Synced installer COMMAND_DEFINITIONS with updated skills
- Handle malformed settings.json gracefully in install.sh

---

## [2.0.0-beta.1] - 2026-01-13

### 🚀 Revolutionary: Intelligent Model Routing

**This is a major release introducing adaptive model routing for all agents.**

The orchestrator (Opus) now analyzes task complexity BEFORE delegation and routes to the appropriate model tier (Haiku/Sonnet/Opus). This dramatically improves efficiency - simple tasks use faster, cheaper models while complex tasks get the full power of Opus.

### Added

- **Intelligent Model Routing System** (`src/features/model-routing/`)
  - `types.ts`: Core types for routing (ComplexityTier, RoutingDecision, etc.)
  - `signals.ts`: Complexity signal extraction (lexical, structural, context)
  - `scorer.ts`: Weighted scoring system for complexity calculation
  - `rules.ts`: Priority-based routing rules engine
  - `router.ts`: Main routing logic with `getModelForTask()` API
  - `prompts/`: Tier-specific prompt adaptations (opus.ts, sonnet.ts, haiku.ts)

- **Adaptive Routing for ALL Agents**
  - Only orchestrators are fixed to Opus (they analyze and delegate)
  - All other agents adapt based on task complexity:
    - `oracle`: lookup → Haiku, tracing → Sonnet, debugging → Opus
    - `prometheus`: breakdown → Haiku, planning → Sonnet, strategic → Opus
    - `momus`: checklist → Haiku, gap analysis → Sonnet, adversarial → Opus
    - `metis`: impact → Haiku, deps → Sonnet, risk analysis → Opus
    - `explore`: simple search → Haiku, complex → Sonnet
    - `document-writer`: simple docs → Haiku, complex → Sonnet
    - `sisyphus-junior`: simple fix → Haiku, module work → Sonnet, risky → Opus

- **Complexity Signal Detection**
  - Lexical: word count, keywords (architecture, debugging, risk, simple)
  - Structural: subtask count, cross-file deps, impact scope, reversibility
  - Context: previous failures, conversation depth, plan complexity

- **Tiered Prompt Adaptations**
  - Haiku: Concise, direct prompts for speed
  - Sonnet: Balanced prompts for efficiency
  - Opus: Deep reasoning prompts with thinking mode

### Changed

- **Orchestrator Prompts** updated with intelligent routing guidance
- **Configuration** (`src/config/loader.ts`) now includes routing options
- **Types** (`src/shared/types.ts`) extended with routing configuration

### Breaking Changes

- Routing is now proactive (orchestrator decides upfront) instead of reactive
- Deprecated `routeWithEscalation()` - use `getModelForTask()` instead

### Migration Guide

No action needed - the system automatically routes based on complexity. To override:

```typescript
Task(
  (subagent_type = "oracle"),
  (model = "opus"),
  (prompt = "Force Opus for this task"),
);
```

---

## [1.11.0] - 2026-01-13

### Added

- **Enhanced Hook Enforcement System** - Stronger Sisyphus behavior enforcement beyond CLAUDE.md
  - `pre-tool-enforcer.sh`: PreToolUse hook that injects contextual Sisyphus reminders before every tool execution
  - `post-tool-verifier.sh`: PostToolUse hook for verification after tools, with failure detection
  - Enhanced `persistent-mode.sh`: Stop hook now includes build/test/git/background task verification
  - `claude-sisyphus.sh`: CLI wrapper that uses `--append-system-prompt` for direct system prompt injection
  - `sisyphus-aliases.sh`: Shell aliases (`claude-s`, `claudew`) for easy activation

### Changed

- **Stop Hook** now enforces additional verification requirements:
  - Build verification (if build scripts exist)
  - Test verification (if tests exist)
  - Git status check (warns on uncommitted changes)
  - Background task completion check
  - All previous checks (Ralph Loop, Ultrawork, Todo completion)

- **Hook Configuration** - Added PreToolUse and PostToolUse to `hooks.json`

### Technical Details

- PreToolUse hook provides tool-specific reminders (Bash, Task, Edit, Write, Read, Grep/Glob)
- PostToolUse hook tracks session statistics in `~/.claude/.session-stats.json`
- Stop hook returns `continue: false` until ALL verification requirements are met
- CLI wrapper appends core Sisyphus rules directly to Claude's system prompt

### Enforcement Hierarchy

1. **Stop Hook** with `continue: false` - Blocks ALL stopping until verified
2. **PreToolUse** - Injects reminders BEFORE every tool
3. **PostToolUse** - Verifies AFTER every tool
4. **CLI Wrapper** - Appends rules to system prompt

## [1.10.0] - 2026-01-11

### Added

- **Persistent Mode System** - Enhanced hook system for auto-continuation
  - `ultrawork-state` module: Manages persistent ultrawork mode state across sessions
  - `persistent-mode` hook: Unified Stop handler for ultrawork, ralph-loop, and todo continuation
  - `session-start` hook: Restores persistent mode states when a new session starts
  - Three-layer priority enforcement: Ralph Loop > Ultrawork > Todo Continuation

- **Claude Code Native Hooks Integration**
  - SessionStart hook for mode restoration on session resume
  - Enhanced Stop hook with persistent mode detection
  - Cross-platform support (Bash for Unix, Node.js for Windows)

- **Popular Plugin Patterns Module** (`plugin-patterns`)
  - Auto-format support for multiple languages (TypeScript, Python, Go, Rust)
  - Lint validation with language-specific linters
  - Conventional commit message validation
  - TypeScript type checking integration
  - Test runner detection and execution
  - Pre-commit validation workflow

### Changed

- **Bridge Module** - Added persistent-mode and session-start hook handlers
- **Keyword Detector** - Now activates ultrawork state when ultrawork keyword is detected
- **Settings Configuration** - Added SessionStart hook configuration for both Bash and Node.js

### Technical Details

- New hooks: `persistent-mode.sh/.mjs`, `session-start.sh/.mjs`
- State files: `.sisyphus/ultrawork-state.json`, `~/.claude/ultrawork-state.json`
- Ultrawork mode now persists across stop attempts when todos remain incomplete
- Ralph-loop continues with iteration tracking and reinforcement messages

## [1.9.0] - 2026-01-10

### Changed

- **Synced all builtin skills with oh-my-opencode source implementation**
  - Updated `orchestrator` skill (1302 lines) with complete orchestrator-sisyphus.ts template
  - Updated `sisyphus` skill (362 lines) with complete sisyphus.ts template
  - Updated `ultrawork` skill (97 lines) - cleaned and adapted from keyword-detector
  - Updated `ralph-loop` skill (11 lines) from ralph-loop hook
  - Updated `git-master` skill with 1131-line comprehensive template
  - Updated `frontend-ui-ux` skill with enhanced Work Principles section

### Fixed

- **Installer improvements**
  - Fixed skill path format from `'skill-name.md'` to `'skill-name/skill.md'`
  - Fixed agent path for prometheus from `'prometheus/skill.md'` to `'prometheus.md'`
  - Added directory creation for both commands and skills to prevent ENOENT errors
  - Fixed ultrawork skill to remove JavaScript wrapper code (clean prompt only)

- **Template escaping**
  - Properly escaped backticks, template literals (`${}`), and backslashes in all skill templates
  - Fixed TypeScript compilation errors due to improper template string escaping

- **SDK adaptation**
  - Converted all oh-my-opencode SDK patterns to Claude Code SDK:
    - `sisyphus_task()` → `Task(subagent_type=...)`
    - `background_output()` → `TaskOutput()`
    - References to OhMyOpenCode → Oh-My-ClaudeCode-Sisyphus

### Verified

- All 6 builtin skills install correctly to `~/.claude/skills/`
- Orchestrator skill properly delegates with `Task(subagent_type=...)`
- Ultrawork skill contains clean verification guarantees and zero-tolerance failures
- Build completes without TypeScript errors
- Installation completes successfully

## [1.8.0] - 2026-01-10

### Added

- Intelligent Skill Composition with task-type routing
- Architecture comparison documentation (OpenCode vs Claude Code)
- Intelligent Skill Activation section to README

### Changed

- Merged feature/auto-skill-routing branch

## [1.7.0] - Previous Release

### Added

- Windows support with Node.js hooks
- ESM import for tmpdir

---

[2.6.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v2.5.0...v2.6.0
[2.0.1]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v2.0.0...v2.0.1
[1.11.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/Yeachan-Heo/oh-my-claude-sisyphus/releases/tag/v1.7.0
