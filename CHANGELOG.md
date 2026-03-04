# oh-my-claudecode v4.6.7: Bundled Path Resolution & Daemon Startup Fixes

## Release Notes

Patch release focused on bundled CJS runtime stability and daemon startup correctness.

### Bug Fixes

- **Bundled package-dir resolution**: Hardened `getPackageDir()` logic in agent prompt loaders to correctly resolve package root in bundled CJS runtime while preserving source/dist behavior.
  - Updated `src/agents/utils.ts`
  - Updated `src/agents/prompt-helpers.ts`
  - Fixes #1322 and #1324

- **Wait daemon bootstrap module path**: Fixed daemon child-process import path resolution so bundled `bridge/cli.cjs` launches the correct dist module instead of recursively importing CLI entry.
  - Updated `src/features/rate-limit-wait/daemon.ts`
  - Added shared resolver `src/utils/daemon-module-path.ts`
  - Added regression tests in `src/__tests__/daemon-module-path.test.ts`
  - Fixes #1323

- **Reply listener daemon bootstrap module path**: Applied the same bundled module path fix to reply listener daemon startup.
  - Updated `src/notifications/reply-listener.ts`

- **Fish worker spawn argument forwarding**: Fixed worker launch forwarding in bundled runtime CLI for Fish shell by using `exec $argv` instead of `exec "$@"` (which Fish does not support), while preserving `exec "$@"` for bash/zsh and other POSIX shells.
  - Updated `src/team/tmux-session.ts`
  - Added regression tests in `src/team/__tests__/tmux-session.test.ts`
  - Regenerated `bridge/runtime-cli.cjs`
  - Fixes #1326

- **Regression coverage**:
  - Added `src/__tests__/package-dir-resolution-regression.test.ts`
  - Regenerated bridge/dist artifacts

---

# oh-my-claudecode v4.6.5: Remove jsonc-parser Dependency

## Release Notes

Removed external `jsonc-parser` dependency by implementing a lightweight JSONC parser internally.

### Bug Fixes

- **Bundle jsonc-parser**: Replaced external `jsonc-parser` dependency with a custom implementation.
  - Created `src/utils/jsonc.ts` with `parseJsonc()` and `stripJsoncComments()` functions
  - Updated `src/config/loader.ts` to use the internal parser
  - Removed `jsonc-parser` from external dependencies in `build-runtime-cli.mjs`
  - Fixes #1316: `runtime-cli.cjs` failing with "Cannot find module 'jsonc-parser'" in plugin marketplace installs

---

# oh-my-claudecode v4.6.4: ESM/CJS Path Resolution Hotfix

## Release Notes

Hotfix for `getPackageDir()` path resolution in bundled CJS builds. Fixes the `import.meta?.url` check that was incorrectly transformed by esbuild.

### Bug Fixes

- **CJS Bundle Path Resolution**: Fixed `getPackageDir()` functions in multiple files to properly detect CJS bundle context.
  - Reordered checks to prioritize `__dirname` (available in CJS) over `import.meta.url` (ESM)
  - Fixed files: `src/agents/prompt-helpers.ts`, `src/agents/utils.ts`, `src/installer/index.ts`, `src/installer/hooks.ts`
  - Fixed `src/hooks/bridge.ts` `isMainModule()` check to handle both ESM and CJS contexts
  - Resolves #1314: `omc update` failing with `TypeError [ERR_INVALID_ARG_TYPE]`

---

# oh-my-claudecode v4.6.3: CLI import.meta.url Fix

## Release Notes

Critical hotfix for CLI runtime error caused by `import.meta.url` being undefined in CJS bundle.

### Bug Fixes

- **CLI Runtime Fix**: Fixed `fileURLToPath` error by injecting `import.meta.url` polyfill in CJS build.
  - Added banner injection in `scripts/build-cli.mjs` to define `importMetaUrl` before bundle
  - Used esbuild `define` to replace `import.meta.url` with the polyfill
  - Fixes `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string` when running `omc` CLI

---

# oh-my-claudecode v4.6.2: CLI Shebang Hotfix

## Release Notes

Hotfix release to resolve duplicate shebang issue in published v4.6.1 package.

### Bug Fixes

- **CLI Shebang Fix** (#1309): Removed duplicate shebang from `bridge/cli.cjs` build output.

---

# oh-my-claudecode v4.6.1: Security Hardening, Team Reliability & HUD Improvements

## Release Notes

This patch release delivers critical security fixes for SSRF and shell injection vulnerabilities, alongside team runtime stability improvements and HUD configurability enhancements. Version bumped from 4.6.0 to 4.6.1.

### New Features

- **Configurable Git Info Position** (#047d5638): HUD now supports `gitInfoPosition` config to display git information above or below the main panel.
- **Harsh-Critic Opt-in** (#9f52cd1a): The harsh-critic agent is now opt-in via `features.harshCritic` configuration flag.

### Security Fixes

- **SSRF Protection** (#1304): Added SSRF protection for `ANTHROPIC_BASE_URL` to prevent unauthorized outbound requests.
- **Shell Injection Prevention** (#9675babb): Validated model name and provider in `spawnCliProcess` to prevent shell injection attacks.
- **Config Injection Fixes** (#0b2e0542): Hardened against shell and configuration injection vulnerabilities.

### Bug Fixes

- **Persistent Mode Cancel Signal** (#1306): Fixed cancel signal check before blocking stop hook.
- **HUD Async I/O** (#1305): Converted file I/O to async to prevent event loop blocking.
- **CLI Model Passthrough**: Fixed CLI worker model parameter passing in `omc-teams`.
- **CLI Bundle** (#9d713bc4): Bundled CLI entry point to eliminate node_modules dependency.
- **Memory Leak Prevention** (#bfd726cb): Added max-size caps to unbounded Maps and caches.
- **Benchmark Hardening** (#469f914a): Hardened benchmark parser and calibrated keyword matching.
- **Benchmark Retry Logic** (#3d6f56f7): Added retry with exponential backoff for API overload errors.

---

# oh-my-claudecode v4.6.0: Team Runtime Hardening, Security Fixes & PRD-Driven Ralph

## Release Notes

This release delivers 48 commits of team runtime stability improvements, security hardening, and new features including mandatory PRD mode for Ralph, a new deep-interview skill, and comprehensive team worker reliability enhancements. Version bumped from 4.5.3 to 4.6.0.

### New Features

- **Deep Interview Skill** (#1215): [Ouroboros](https://github.com/Q00/ouroboros)-inspired Socratic questioning skill for requirements elicitation and problem decomposition.
- **Ralph PRD Mode Mandatory** (#1219): Ralph now auto-generates `prd.json` when none exists, making PRD-driven iteration the default behavior. Stories iterate until all acceptance criteria pass. Opt-out via `--no-prd`.
- **Factcheck Sentinel Readiness Gate** (#1210): Wired factcheck sentinel readiness gate into team pipeline for improved verification reliability.
- **Model Aliases Configuration** (#1211, #1213): Added `modelAliases` config to override agent definition defaults for flexible model routing.

### Security Fixes

- **CLI Path Trust & RC-Loading** (#1230): Tightened CLI path trust validation and restored explicit RC-loading opt-out via `OMC_TEAM_NO_RC` for team worker runtime hardening. Pinned validated absolute CLI binary paths across preflight/spawn.
- **Binary Path Validation** (#1228): Hardened CLI binary validation and launch safety with proper `normalize` imports for binary path compatibility checks.

### Team Runtime Fixes

- **Transient Failure Retry** (#1209, #1243): Added retry logic for dead worker panes with proper failure retry accounting atomicity. Skip `done.json` retry backoff on `ENOENT` errors.
- **Watchdog Improvements** (#1234, #1229): Restored `done.json` parse recovery in watchdog path and retry pending-task read on transient gaps.
- **Startup Reliability** (#1228): Restored readiness-based startup for non-prompt workers and preserved team context on pane-ready rollback.
- **Binary Path Handling** (#1236): Allow absolute `launchBinary` paths containing spaces.
- **Leader Pane Stability** (#1205): Prevent leader pane crash when `omc-teams` workers are active.
- **Artifact Convergence** (#1241): Prevent wait hang in team MCP via artifact convergence.

### Bug Fixes

- **Python REPL Orphan Process** (#1239): Resolved orphan process leak on Windows caused by inline `require` in `killProcessGroup`.
- **Shell RC Sourcing** (#1207): Source shell RC files when launching tmux sessions for proper environment inheritance.
- **Stop Hook Blocking** (#1216): Return `continue: false` when stop hook should block execution.
- **State Mode Alignment** (#1233, #1235): Aligned deep-interview state mode with state tools enum.

### Cleanup & Refactoring

- **Dead Code Removal** (#1220): Removed deprecated agents/skills, synchronized PluginConfig, renamed `plan` to `omc-plan` for consistency.

### Testing

- **Watchdog Retry Tests**: Hardened test suite for watchdog retry functionality with deterministic wait helpers.
- **Runtime CLI Tests**: Added comprehensive CLI path resolution and prompt-mode test coverage.
- **Done Recovery Tests**: Added tests for `done.json` recovery scenarios.

### Documentation

- **Execution Mode Guide** (#1221, #1222): Updated mode selection guide to recommend Team mode first.
- **Skill Documentation**: Updated all skill READMEs to reflect new naming and capabilities.

---

# oh-my-claudecode v4.5.3: Dev→Main Release Alignment & OMC Teams Shipping

## Patch Notes

This release formalizes the dev→main shipping workflow for OMC releases, bumps plugin/package metadata to 4.5.3, and validates release readiness with smoke and e2e-oriented test runs after loading the dev plugin in-session.

### Release Process

- **Dev→Main shipping flow**: release notes now explicitly capture dev as the integration branch and main as the shipping branch for final release publication.
- **Version bump to 4.5.3**: updated package and plugin metadata to keep runtime, plugin manifest, marketplace metadata, and docs version markers aligned.

### OMC Teams

- **Ship `/omc-teams` with Codex workers**: release flow includes Codex-worker parallel review/validation as part of release readiness checks.

### Verification

- **Smoke test run**: execute smoke-focused Vitest suites before release.
- **E2E test run**: execute e2e-scoped test selection (or explicit no-test result) as part of release gate.

---

# oh-my-claudecode v4.5.2: Security Hardening, Shared Memory Reliability & Team Stability

## Patch Notes

Major reliability and security release with 59 commits. Addresses critical data-integrity issues in shared memory (atomic writes, file locking, TOCTOU prevention), hardens team worker coordination (path traversal validation, shell sandboxing, binary validation), adds notification security (token redaction, input sanitization, WebSocket message validation), and introduces new features including Slack Bot Socket Mode, cross-session memory sync, factcheck guards, configurable pipeline orchestrator, and non-Claude provider auto-detection.

### Features

- **Slack Bot Socket Mode** (#1138, #1139): Bidirectional replay injection via WebSocket for real-time Slack integration.
- **Cross-session memory sync** (#1137): Shared memory subsystem for multi-agent handoffs across sessions.
- **Factcheck guard + sentinel health analyzer** (#1155, #1156): Portable factcheck guard with sentinel health monitoring.
- **Configurable pipeline orchestrator** (#1132): Phase 1 & 2 of autopilot pipeline orchestrator with configurable stages.
- **API key source indicator** (#1146, #1147): HUD element showing the source of the active API key.
- **OMC-OMX cross-platform worker adapter** (#1117, #1123): Interop adapter for cross-platform worker orchestration.
- **OpenClaw channel context** (#1110, #1115): Originating channel context passed through to webhook hooks.
- **forceInherit model routing** (#1135, #1136): Option to bypass model routing and inherit parent model.
- **Non-Claude provider auto-detection** (#1201, #1202): Auto-detect non-Claude providers (OpenRouter, Bedrock, etc.) and enable forceInherit.
- **LSP timeout configuration** (#1106): Configurable request timeout via `OMC_LSP_TIMEOUT_MS` env var.
- **HUD maxWidth config** (#1102): Statusline truncation with configurable max width.
- **Worktree path in tmux session name** (#1088, #1089): Include worktree path for disambiguating parallel sessions.

### Security Fixes

- **Path traversal prevention in worker inbox/outbox** (#1185): Validate file paths to prevent directory traversal attacks in team worker message exchange.
- **Shell rc sandboxing and binary validation** (#1166, #1189): Sandbox shell rc loading and validate binary paths before execution in team workers.
- **CLI binary resolution hardening** (#1173, #1190): Prevent PATH manipulation from influencing CLI binary resolution.
- **Slack/Telegram token redaction** (#1176): Redact bot tokens in log and error output paths.
- **Slack webhook input sanitization** (#1175): Sanitize input data in Slack webhook payloads.
- **Slack WebSocket message validation** (#1188): Validate WebSocket messages before session injection.

### Bug Fixes — Shared Memory & State

- **Deep merge for cross-session sync** (#1193): Use deep merge instead of full overwrite to prevent data loss during sync.
- **Payload size validation** (#1181): Validate memory write payloads to prevent oversized writes.
- **TOCTOU cache poisoning prevention** (#1179): Add locking to state-manager `update()` to prevent time-of-check/time-of-use races.
- **Atomic writes** (#1174): Write to temp file + rename to prevent corruption on crash.
- **Cross-process file locking** (#1178): File locking to prevent concurrent write data loss.
- **Mode state I/O consolidation** (#1143): Consolidate mode state I/O and fix cancel cleanup.
- **OMC_STATE_DIR support** (#1127): Use `getOmcRoot()` in HUD and hooks to respect `OMC_STATE_DIR`.

### Bug Fixes — Team & Workers

- **Tmux layout debounce** (#1158, #1196): Debounce layout operations during rapid worker spawn/kill cycles.
- **Shell-readiness configurable timeout** (#1171, #1192): Add configurable timeout to shell-readiness wait.
- **Readiness race condition** (#1183): Close race between pane check and task delivery.
- **Interop bootstrap fail-open warning** (#1164, #1182): Add visible warning log when interop bootstrap fails open.
- **Worker spawn env hardening** (#1141): Harden worker spawn environment and interop bootstrap fail-open.
- **Inline worker task sentinels** (#1151, #1152): Include `.ready`/`done.json` sentinel in inline worker task.
- **Prompt-mode gitignore bypass** (#1148, #1150): Inline task content for prompt-mode workers to bypass gitignore.
- **PromptMode shell-readiness wait** (#1144, #1145): Add shell-readiness wait for promptMode agent panes.
- **Shell PATH resolution** (#1128): Resolve user's shell PATH for CLI detection and runtime spawn.
- **Gemini CLI worker fixes** (#1105): Resolve 4 Gemini CLI worker bugs.
- **Auto-create detached tmux session** (#1095): Auto-create detached tmux session when not inside tmux.

### Bug Fixes — Notifications

- **WebSocket cleanup gaps** (#1172, #1194): Close WebSocket cleanup gaps on disconnect.
- **Telegram reply injection** (#1099): Fix 3 reply listener bugs preventing Telegram reply injection.

### Bug Fixes — Hooks, CLI & Shell

- **Transcript path in native git worktrees** (#1191, #1195): Resolve transcript path correctly in native git worktrees.
- **Worktree-mismatched transcript paths** (#1098): Resolve worktree-mismatched transcript paths.
- **Shell rc in tmux sessions** (#1153, #1154): Load default shell rc in OMC tmux shell sessions.
- **Source shell rc in tmux launch** (Yeachan-Heo/fix/tmux-shell-rc-loading): Source shell rc files in tmux launch sessions.
- **Forward OMC_* env vars** (#1093): Forward OMC_* environment variables to tmux sessions.

### Bug Fixes — Other

- **HUD worktree root resolution** (#1118, #1121): Resolve worktree root to prevent `.omc/` in subdirectories.
- **CLAUDE_CONFIG_DIR support** (#1125): Support `CLAUDE_CONFIG_DIR` in HUD Keychain credential lookup.
- **OpenClaw claude -p mode** (#1120, #1122): Stop and session-end hooks fire reliably in `claude -p` mode.
- **Plugin setup runtime deps** (#1113, #1114): Install runtime deps in plugin cache, remove prepare trap.
- **Skill name prefixing** (#1111): Prefix plan, review, security-review skill names with omc-.
- **Windows TCP fallback** (#1112): Add TCP localhost fallback for bridge when AF_UNIX unavailable.
- **omc-doctor false positives** (#1101, #1104): Resolve false-positive checks for CLAUDE.md and legacy skills.

### Chore & Refactor

- **Deprecate legacy execution modes** (#1131, #1134): Deprecate ultrapilot, swarm, and pipeline execution modes.
- **CLAUDE.md diet** — Reduce from 288 to 162 lines (-44%).
- **i18n README fix** (#1096): Fix npm package name in translated READMEs.

### Tests

- **Edge/smoke test suites** (#1157): Add edge/smoke test suites for main→dev feature coverage.
- **Smoke and unit tests** (#1140): Add smoke and unit tests for changelog features.
- **CI test fixes** (#1197, #1198, #1199): Fix slack-socket, project-memory-merge, runtime-interop, runtime-prompt-mode, and memory-tools payload test failures.

---

# oh-my-claudecode v4.5.1: OpenClaw CLI Command Gateway

## Patch Notes

Hotfix adding CLI command gateway support to OpenClaw. The HTTP-only dispatcher could not wake CLI-based agents (Clawdbot/OpenClaw) that use WebSocket interfaces. This release adds a `"command"` gateway type that executes shell commands with shell-escaped variable interpolation, auto-detects `openclaw`/`clawdbot` binaries, and captures tmux pane tail content for stop/session-end events.

### Features

- **CLI command gateway type** (#1087): New `OpenClawCommandGatewayConfig` with discriminated union types, `wakeCommandGateway()` dispatcher using `execFile("sh", ["-c", ...])`, and shell-safe `{{variable}}` interpolation via `shellEscapeArg()`.
- **tmux tail capture**: Auto-captures last 15 lines of tmux pane content for `stop` and `session-end` events via `capturePaneContent()`. Added `tmuxTail` field to `OpenClawContext` and `OpenClawPayload`.
- **configure-openclaw skill update**: Auto-detects installed CLI (`which openclaw || which clawdbot`) and offers command gateway setup with pre-filled templates.

### Bug Fixes

- **OpenClaw HTTP 405 on CLI agents**: Clawdbot/OpenClaw gateways use WebSocket, not REST — HTTP POST returned 405 on all routes. Command gateway type bypasses this entirely.

---

# oh-my-claudecode v4.5.0: Notifications Engine, OpenClaw Gateway & Reliability Hardening

## Patch Notes

This release introduces a full notifications infrastructure (hook config, template engine, platform gating), the OpenClaw webhook gateway for external automation, i18n prompt translation, and extensive reliability hardening across team coordination, project memory, LSP tooling, and hook lifecycle management. Dead code from the legacy compatibility subsystem has been removed.

**35 commits, 181 files changed, +9712 -5927 lines**

---

### Features

- **Notifications engine** (#1022): New hook config system (`hook-config.ts`), template engine (`template-engine.ts`), and platform gating (`platform-gating`) for structured notification delivery across Telegram, Discord, Slack, and webhooks.
- **CLI platform flags** (#1024): Added `--telegram`, `--discord`, `--slack`, and `--webhook` CLI flags for configuring notification destinations at launch.
- **OpenClaw webhook gateway** (#1023): New `openclaw` module (`config.ts`, `dispatcher.ts`, `index.ts`, `types.ts`) enables waking external automations and AI agents on hook events via configurable webhook endpoints.
- **i18n prompt translation** (#1017): Keyword-detector hook now dynamically injects prompt translations, enabling localized skill invocations.
- **Configurable state directory** (#1015): New `OMC_STATE_DIR` environment variable allows overriding the default `.omc/state/` path for custom state directory layouts.
- **RALPLAN-DR structured deliberation**: Added structured deliberation format to the ralplan consensus planning workflow.
- **Auto-nudge idle teammate panes** (#1047, #1048): `omc_run_team_wait` now automatically nudges idle tmux worker panes with configurable delay, max count, and custom messages.

---

### Bug Fixes

- **LSP Content-Length byte counting** (#1026, #1028): `handleData` in the LSP client now uses `Buffer.byteLength` instead of `String.length` for Content-Length, fixing multi-byte character parsing errors.
- **Project memory atomic writes** (#1073): Project memory storage now uses atomic writes with async mutex and session cache cleanup, preventing data corruption under concurrent access.
- **Team worker reconstruction on resume** (#1078): Team runtime now reconstructs worker state on resume, handles malformed inbox files gracefully, and adds a parallel watchdog for worker health monitoring.
- **Ralph loop deduplication** (#1079): Persistent-mode hook deduplicates Ralph loop re-entry, caches cancel signals, and extracts mode constants to prevent redundant iterations.
- **Frontmatter parser deduplication** (#1081): Extracted shared `parseFrontmatter()` utility to `src/utils/frontmatter.ts`, eliminating duplicate implementations in builtin-skills loader and auto-slash-command executor. Fixes CC command shadowing.
- **Session state GC** (#1082): Error handling now garbage-collects stale session state, rejects pending LSP requests on exit, and escalates watchdog errors appropriately.
- **LSP error responses** (#1075): LSP tool errors now include `isError: true` in MCP responses. Also fixes bridge exit handling and AST `replaceAll` mode.
- **Config type unification** (#1072): Unified config types with Zod schema validation, filling gaps in MODES constant coverage.
- **Team CLI worker ACK poll** (#1071): Skips unnecessary ACK polling for CLI workers and adds a task claiming lock to prevent race conditions.
- **Agent routing gaps** (#1070): Fixes vision enforcer, task decomposer thresholds, and routing gaps for edge-case agent delegations.
- **Recovery stub** (#1054, #1069): Non-functional recovery stub now returns failure instead of silently succeeding.
- **Notification lock deadline** (#1068): Added cumulative deadline to the notification lock acquisition loop, preventing indefinite blocking.
- **Portable omc-setup** (#1051): Replaced BSD-incompatible `sed` with portable `awk` in the setup script for cross-platform compatibility.
- **Platform flag defaults** (#1046): CLI platform flags now use `undefined` defaults instead of `false` to preserve existing environment variable values.
- **Null guard in template engine** (#1045): Added null guard to `resolveEventTemplate` preventing crashes on undefined event templates.
- **Terminal-overrides regression** (#1044): Removed `smcup@/rmcup@` terminal overrides re-introduced by #1024 that caused Ink rendering corruption.
- **Skill-active-state lifecycle** (#1033, #1036): New `skill-state` module tracks active skill execution, preventing the persistent-mode Stop hook from prematurely terminating skills that don't write mode state files (e.g., code-review, plan, tdd).
- **Team-state stop hook** (#1032): Persistent-mode Stop hook now checks `team-state.json` in addition to other mode states.
- **Codex prompt-mode support** (#1030): omc-teams now passes prompt-mode flags to Codex CLI workers.
- **Model ID hardcoding** (#1025, #1027): Team and sub-agent creation no longer hardcodes model IDs, respecting user configuration.
- **Windows tmux compatibility** (#1019, #1021): Team tmux sessions now work on MSYS2/Git Bash with Windows-specific path and shell adjustments.
- **Ink rendering corruption** (#1020): Removed `terminal-overrides smcup@/rmcup@` from tmux config that caused Ink-based UI corruption.
- **Notification denoising** (#1016): Session idle notifications are denoised to reduce spurious output.

---

### Performance

- **State read cache** (#1083): Hook state reads are now cached to avoid redundant filesystem I/O. Diagnostics are notification-driven instead of polled. Parallel watchdog added for multi-mode monitoring.

---

### Security

- **Shell interpolation removal** (#1076): Replaced shell string interpolation with array-form `spawn()` across the codebase, eliminating a class of command injection vulnerabilities.

---

### Testing

- **Skill-state lifecycle tests** (`skill-state.test.ts`): Validates protection levels, state read/write/clear, staleness detection, and stop-hook blocking logic.
- **OpenClaw tests** (`config.test.ts`, `dispatcher.test.ts`, `index.test.ts`): Full coverage for webhook gateway configuration, event dispatching, and module integration.
- **Notification tests** (`hook-config.test.ts`, `template-engine.test.ts`, `platform-gating.test.ts`, `formatter.test.ts`): Validates hook config loading, template resolution, platform-specific gating, and message formatting.
- **LSP byte counting** (`client-handle-data.test.ts`): Regression test for multi-byte Content-Length parsing.
- **Team tests** (`idle-nudge.test.ts`, `runtime-prompt-mode.test.ts`, `model-contract.test.ts`): New coverage for idle nudging, prompt-mode passthrough, and model contract validation.
- **Bridge routing** (`bridge-openclaw.test.ts`): OpenClaw hook routing integration test.
- **Launch tests** (`launch.test.ts`): Terminal-overrides regression coverage.
- **Frontmatter tests** (`frontmatter.test.ts`): Coverage for shared frontmatter parsing utilities.

---

### Internal

- **Dead code removal** (#1074): Removed the legacy compatibility subsystem (`src/compatibility/`), orphan agent files, and unused utilities. Net deletion of ~5900 lines.
- **Codex `buildLaunchArgs` reverted** (#1039 → #1040): The `exec` subcommand addition was reverted due to compatibility issues.
- **Mode constants extracted**: `MODES` constant map centralized in `src/lib/mode-names.ts` for consistent mode name references.
- **Session isolation improvements**: `resolveSessionStatePath` used consistently across skill-state, project-memory, and notification modules.
- **Worktree path utilities** (`worktree-paths.ts`): Extended with session-scoped state path resolution.

---

# oh-my-claudecode v4.4.2: Cross-Platform Hardening & Cancel Race Fix

## Patch Notes

This release hardens cross-platform hook execution, fixes a cancel re-arm race in ralph/ultrawork, and improves tmux injection safety with adaptive polling and copy-mode guards.

**11 commits, 75 files changed, +2312 -222 lines**

---

### Features

- **Win32 startup warning** (#923): CLI now displays a platform compatibility warning when running on native Windows (not WSL), informing users about potential limitations.
- **Adaptive polling for tmux workers** (#907): New `shouldAttemptAdaptiveRetry` logic retries message delivery to busy worker panes without interrupting active turns. Includes copy-mode detection to prevent key injection when a pane is in scroll mode.
- **Runtime/status telemetry** (#907): Team runtime emits per-cycle telemetry (`monitorMs`, `tasksMs`, `workerMs`) for diagnosing slow polling loops. `team-status` extended with richer status reporting.

---

### Bug Fixes

- **Cancel re-arm race in ralph/ultrawork** (#921): The stop hook could re-enforce ralph/ultrawork persistence after `/cancel` was invoked but before state files were fully cleared. A new `cancel-signal` sentinel file with a 30-second TTL prevents re-arming during the cancellation window.
- **Codex background prompt normalization** (#919, #920): Background inline prompts passed to Codex CLI are now normalized to `prompt_file` at the callsite, fixing cases where prompts with special characters were mangled or lost.
- **`ralph-init` triggering ralph loop** (#914): The `ralph` keyword regex now uses a negative lookahead (`(?!-)`) so that `ralph-init` no longer falsely triggers the ralph persistence loop.
- **Cross-platform hook runner** (#912): Replaced the `sh + find-node.sh` chain with a new `scripts/run.cjs` that uses `process.execPath` to spawn hook scripts. Fixes hook execution failures on Windows where `/usr/bin/sh` is unavailable, and resolves nvm/fnm node binary discovery issues (#909, #899, #892, #869).
- **HUD `--watch` mode repeated setup error** (#911): Added a stdin cache (`hud-stdin-cache.json`) so `--watch` mode can recover HUD data when stdin becomes a TTY on subsequent iterations, preventing repeated setup errors.

---

### Security

- **tmux copy-mode injection guard**: `sendToWorker` and `injectToLeaderPane` now check `paneInCopyMode` before every `send-keys` call, preventing unintended key injection when a tmux pane is in scroll/copy mode. Multiple guard points added throughout the send-keys retry loop.

---

### Testing

- **Cancel race test suite** (`cancel-race.test.ts`): Validates that `isSessionCancelInProgress` correctly reads/expires cancel signals and that ralph/ultrawork checks respect the cancel window.
- **Win32 warning test** (`cli-win32-warning.test.ts`): Verifies the platform warning renders on win32 and is suppressed on other platforms.
- **Team bridge usage test** (`mcp-team-bridge.usage.test.ts`): End-to-end test for the MCP team bridge tool registration.
- **Runtime assign test** (`runtime-assign.test.ts`): Tests task assignment logic in the team runtime.
- **Improved mocks** (`team-cleanup.test.ts`): Replaced `Function` callback types with properly typed mocks.
- **Extended coverage**: `session-isolation.test.ts`, `tmux-session.test.ts`, `team-status.test.ts`, `runtime.test.ts`, `tmux-comm.test.ts` all expanded with new test cases.

---

### Internal

- **`scripts/run.cjs`**: New cross-platform CJS hook runner that uses `spawnSync(process.execPath, ...)` to bypass shell discovery.
- **`hooks.json` updated**: All hook commands now use the `node + run.cjs` chain instead of `sh + find-node.sh`.
- **`plugin-setup.mjs` improvements**: Setup script patching updated to support the new runner chain.
- **`bridge/runtime-cli.cjs`**: +126 lines of telemetry, adaptive polling, and worker lifecycle improvements.
- **`bridge/team-bridge.cjs`**: +181 lines of enhanced team bridge coordination.
- **`todo-continuation`**: Added `isExplicitCancelCommand` detection for cleaner cancel handling.
- **`mode-registry`**: Improved mode detection and session isolation logic.

---

### Codex Review Summary

Infrastructure review (2 findings, non-blocking):
- **Low**: Unquoted absolute node path in hook commands could theoretically break on paths with spaces on Windows.
- **Low**: `run.cjs` exits cleanly (`process.exit(0)`) when spawn fails, which suppresses error details from Claude Code's hook output.

No tmux shell injection vulnerabilities found in the hardened `sendToWorker`/`injectToLeaderPane` implementations.

---

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
