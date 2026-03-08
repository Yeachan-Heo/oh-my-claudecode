# oh-my-claudecode v4.7.5: Runtime Guardrails & Model Default Cleanup

## Release Notes

Patch release that lands the post-v4.7.4 stabilization work on `dev`: safer orchestration guardrails, fail-open team stop enforcement, and centralized model defaults.

### Bug Fixes

- **fix(models): centralize defaults and remove outdated hardcoded mappings** — Consolidates model defaults into a single source of truth so runtime, config, and team flows stop drifting on stale hardcoded values. (#1376)
- **fix: add context guardrails for agent orchestration** — Adds stronger orchestration context checks so agent/runtime flows fail earlier and more predictably when state is invalid. (#1373)
- **fix(hooks): fail-open team stop enforcement and add breaker** — Makes team stop-hook enforcement safer under failure by failing open and adding a breaker to avoid deadlocks or runaway blocking. (#1374)
- **test: fix no-undef process in post-tool-verifier test** — Repairs the verifier regression test so CI stays green with the updated orchestration guardrails.

### Build

- **chore: sync `main` into `dev` and rebuild dist artifacts** — Merged the v4.7.4 release lineage back into `dev`, then rebuilt committed bridge/runtime/dist outputs for v4.7.5.

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.7.5
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.7.4...v4.7.5

---

# oh-my-claudecode v4.7.4: Team Worker Hardening & CI Improvements

## Release Notes

Patch release focused on hardening Team worker orchestration, mailbox/task interop, and release validation ergonomics.

### Features

- **feat(team): harden worker guardrails and task/mailbox interop** — Strengthens worker lifecycle protections, mailbox/task handling, CLI interop, and state-path coverage for tmux-backed Team execution.

### CI & Release

- **chore(ci): retrigger PR workflows** — Refreshes CI after the worker-hardening changes landed.
- **chore(ci): add manual workflow_dispatch triggers** — Adds manual triggers for CI workflows so maintainers can rerun validation on demand during release prep.
- **chore: rebuild dist artifacts** — Rebuilt committed bridge/runtime/team outputs for the worker-hardening release cut.

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.7.4
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.7.3...v4.7.4

---

# oh-my-claudecode v4.7.1: Team Stability Fixes

## Release Notes

Patch release with critical stability fixes for team orchestration — prevents infinite agent spawning and fixes Gemini CLI worker launch failures.

### Bug Fixes

- **fix(hooks): prevent infinite team spawning** — Disabled automatic team keyword detection in hooks to prevent recursive agent spawning loops. Team mode now requires explicit `/team` invocation only, eliminating the risk of infinite spawn cascades when the keyword "team" appears in natural conversation. (#1355)
- **fix(team): gemini worker launch with correct approval mode** — Fixed Gemini CLI worker spawning by using `--approval-mode yolo -i` flags, matching the expected Gemini CLI interface for non-interactive autonomous execution. Previously, workers would fail to launch due to missing approval mode configuration. (#1356)
- **fix(tests): update tier0 contract test** — Aligned tier0 contract tests with the new explicit-only team mode behavior to prevent false test failures.

### Build

- **chore: rebuild dist artifacts** — Rebuilt `bridge/cli.cjs` and `dist/cli/` with `--json` flag support for `omc team start`, enabling structured JSON output for programmatic team orchestration. Tests for `--json` envelope, `--count` expansion, and non-JSON fallback included.

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.7.1
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.7.0...v4.7.1

---

# oh-my-claudecode v4.7.0: Event-Driven Team Runtime & Multi-Model Flexibility

## Release Notes

Major release featuring a completely redesigned team orchestration runtime, restored non-tmux Codex/Gemini skills for maximum flexibility, comprehensive security hardening, and 50+ merged PRs.

### Highlights

- **Event-Driven Team Runtime v2** — Complete architectural redesign matching OMX patterns. Direct tmux spawn with CLI API inbox replaces watchdog/done.json polling. Dispatch queues, monitoring, and scaling modules provide production-grade orchestration. (#1348)
- **Ask-Codex & Ask-Gemini Skills** — Restored non-tmux Codex and Gemini integration via `ask-codex` and `ask-gemini` skills. Users now have maximum flexibility: use `/ccg` for tri-model fan-out, `/omc-teams` for tmux pane workers, or the new ask skills for lightweight single-query dispatch — no tmux required. (#1350)
- **OMX CLI Integration** — Unified `ask` and `team` CLI commands from OMX into OMC core. The team MCP runtime is deprecated in favor of the new CLI-native approach. (#1346)

### Features

- **feat(team): event-driven team redesign** — New `runtime-v2.ts` with `api-interop.ts`, `dispatch-queue.ts`, `events.ts`, `monitor.ts`, `scaling.ts`, `mcp-comm.ts`, and `team-ops.ts` modules. 5,000+ lines of new orchestration infrastructure. (#1348)
- **feat(team): v2 runtime direct tmux spawn** — CLI API inbox replaces done.json and watchdog patterns for more reliable worker lifecycle management.
- **feat(ask): add ask-codex and ask-gemini skills** — Non-tmux skills that invoke Codex/Gemini via wrapper scripts using `CLAUDE_PLUGIN_ROOT` for portable path resolution. (#1350, #1351)
- **feat(cli): integrate omx ask/team into omc** — Unified CLI surface; deprecate team MCP runtime in favor of CLI-native team operations. (#1346)
- **feat(notifications): custom integration system** — Webhook and CLI dispatch support for notifications beyond built-in Telegram/Discord/Slack presets. Template variables, validation, and integration tests included.
- **feat(agents): harsh-critic v2** — Plan-specific protocol with adaptive harshness levels and reproducible benchmark pack. (#1335)
- **feat(hud): configurable git info position** — Place git info above or below the HUD via config. (#1302)
- **feat(hud): wrap mode for maxWidth** — New `wrap` alternative to truncation for long output lines. (#1331, #1319)
- **feat(hud): API error indicator** — Explicit error display when rate limit API fetch fails. (#1255, #1259)
- **feat(hud): active profile name** — Display current profile name for multi-profile setups. (#1246)
- **feat(benchmark): deterministic keyword thresholds** — Calibrated keyword matcher with reproducible thresholds. (#1300)

### Bug Fixes

- **fix: infinite OAuth loop** — Stop 401/403 loops in Team persistent mode. (#1308, #1330)
- **fix(cli): duplicate 'team' command** — Remove duplicate command registration that caused CLI boot failures.
- **fix(cli): bundle CLI entry point** — Eliminate `node_modules` dependency for plugin marketplace installs. (#1293)
- **fix(cli): bare --notify handling** — Prevent `--notify` from consuming the next positional argument.
- **fix(team): CLI worker model passthrough** — `OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL` now correctly propagates to workers. (#1291, #1294)
- **fix(team-mcp): wait hang prevention** — Artifact convergence prevents indefinite blocking. (#1241)
- **fix(team-runtime): readiness startup** — Restore startup sequence for non-prompt workers. (#1243)
- **fix(team-runtime): done.json parse recovery** — Robust JSON parsing with fallback for corrupted watchdog files. (#1231, #1234)
- **fix(team-runtime): paths with spaces** — Allow valid `launchBinary` paths containing spaces. (#1232, #1236)
- **fix(team-security): CLI path trust** — Tightened trust validation and RC-loading behavior. (#1230, #1237)
- **fix(hud): documentation and error handling** — Resolve slop in HUD docs and error paths. (#1307)
- **fix(hud): async file I/O** — Prevent event loop blocking in HUD render hot path. (#1273, #1305)
- **fix(persistent-mode): cancel signal check** — Check cancellation before blocking stop hook. (#1306)
- **fix(deep-interview): state mode alignment** — Align with state tools enum for correct persistence. (#1233, #1235)
- **fix(python-repl): Windows cleanup** — Fix orphan process and session cleanup on Windows. (#1239)
- **fix(config): auto-detect Bedrock/Vertex AI** — Correct `forceInherit` detection for cloud providers. (#1292)
- **fix: Fish shell worker spawn** — Use `$argv` instead of `$@` for Fish compatibility. (#1326, #1329)
- **fix: duplicate shebang in CLI build** — Remove double shebang in bundled CLI entry. (#1309)
- **fix: bundled path resolution** — Hardened `getPackageDir()` across agent loaders, daemon bootstrap, and reply listener. (#1322, #1323, #1324, #1325)

### Security

- **SSRF protection for ANTHROPIC_BASE_URL** — Validate base URL to prevent server-side request forgery. (#1298, #1304)
- **Default-deny in checkSecurity()** — Critical fix: `live-data.ts` now denies by default instead of allowing unknown paths. (#1281)
- **Shell injection prevention** — Validate model name and provider in `spawnCliProcess`. (#1285)
- **Prompt injection mitigation** — Sanitize AGENTS.md content before session injection. (#1284)
- **Environment credential isolation** — Filter sensitive env vars from child processes. (#1284, #1296)
- **Path traversal fixes** — Harden session-end hook against directory traversal. (#1282)
- **Shell/config injection** — Fix injection vectors in teleport and daemon modules. (#1283)
- **TOCTOU race conditions** — Replace `existsSync+readFileSync` with atomic `try/catch ENOENT`. (#1288)
- **Memory leak prevention** — Add max-size caps to unbounded Maps and caches. (#1287, #1274)
- **Null safety** — Replace unsafe non-null assertions with defensive checks. (#1286, #1277)
- **Silent catch logging** — Add error logging to 19+ silent catch blocks. (#1297, #1303)

### Documentation & i18n

- **Korean translations** — Full ARCHITECTURE, FEATURES, MIGRATION, and REFERENCE docs in Korean. (#1260, #1262, #1264)
- **5 new language READMEs** — Expanded international documentation coverage. (#1289)
- **Remove deprecated CLI docs** — Removed references to non-existent `omc stats`, `omc agents`, `omc tui` commands. (#1336, #1341)
- **Team/Ask skill docs** — Aligned team and ask documentation with CCG routing. (#1353)

### Testing & CI

- **CLI boot regression tests** — Prevent duplicate command registration regressions.
- **Edge/smoke coverage expansion** — Runtime and integration edge-case tests. (#1345)
- **npm pack + install CI test** — Verify published package installs correctly. (#1318)
- **Stop-hook cooldown assertion fix** — Correct OpenClaw test timing. (#1344)
- **Harsh-critic parser hardening** — Handle markdown formatting variants in benchmark. (#1301)

### Stats

- **50+ PRs merged** | **30,000+ lines changed** | **268 files touched**
- **15 security fixes** | **20+ bug fixes** | **10+ new features**

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.7.0
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.6.7...v4.7.0

---

# oh-my-claudecode v4.6.7: Bundled Path Resolution & Daemon Startup Fixes
