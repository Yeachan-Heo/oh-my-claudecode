# oh-my-claudecode v4.11.1: add gitStatus working-tree, add hostname element, cwd folder format

## Release Notes

Release with **3 new features**, **8 security improvements**, **33 bug fixes**, **1 other change** across **45 merged PRs**.

### Highlights

- **feat(hud): add gitStatus working-tree indicator element** (#2247)
- **feat(hud): add hostname element for multi-host SSH workflows** (#2246)
- **feat(hud): cwd folder format shows parent/leaf instead of just leaf** (#2238)
- **fix(security): clamp hardMaxIterations and enforce in autopilot** (#2331)
- **fix(security): delegate gitea URL validation to validateUrlForSSRF** (#2336)
- **fix(security): enforce disableExternalLLM in omc ask command** (#2324)

### New Features

- **feat(hud): add gitStatus working-tree indicator element** (#2247)
- **feat(hud): add hostname element for multi-host SSH workflows** (#2246)
- **feat(hud): cwd folder format shows parent/leaf instead of just leaf** (#2238)

### Security & Hardening

- **fix(security): clamp hardMaxIterations and enforce in autopilot** (#2331)
- **fix(security): delegate gitea URL validation to validateUrlForSSRF** (#2336)
- **fix(security): enforce disableExternalLLM in omc ask command** (#2324)
- **fix(security): sanitize trigger_message control characters before tmux send-keys** (#2323)
- **fix(security): check iteration directly against hardMax independent of max_iterations** (#2322)
- **fix(security): reject non-positive hardMaxIterations in strict mode** (#2321)
- **fix(security): enforce hardMaxIterations for ultrawork persistent mode** (#2320)
- **fix(security): block all tmux subcommands in worker context** (#2316)

### Bug Fixes

- **fix(installer): use getPackageDir() instead of __dirname for HUD helper copies** (#2347)
- **fix(team): lock unregisterMcpWorker and registerInConfig read-modify-write paths** (#2333)
- **fix(shared-memory): add retry timeout to writeEntry lock acquisition** (#2342)
- **fix: guard against fd leak in tryAcquireSync on write failure** (#2341)
- **fix(team): use randomUUID in MCP team-server job ID generation** (#2340)
- **fix(cancel,team): add skill-active cleanup to bash fallback and guard startTeamV2 events** (#2339)
- **fix(i18n): prevent Korean keyword false positives for 설명서 and 랄프로렌** (#2337)
- **fix(state-tools): correct cancel signal path and add legacy fallback** (#2335)
- **fix: guard Atomics.wait with try/catch in session-registry and subagent-tracker** (#2334)
- **fix(cancel): write legacy cancel signal to .omc/state/ instead of worktree root** (#2332)
- **fix(worktree-paths): include dot in project path encoding regex** (#2329)
- **fix(team): add locking to teamUpdateTask for concurrent safety** (#2330)
- **fix(hud): apply wrap mode when terminal width is auto-detected** (#2338)
- **fix(hud): handle ST-terminated OSC 8 sequences in ANSI regex** (#2319)
- **fix(prompt-prerequisites): use suffix matching for file path comparison** (#2314)
- **fix(prompt-prerequisites): require path prefix or file extension in isLikelyPath** (#2313)
- **fix(prompt-prerequisites): move progress recording after blocking check** (#2312)
- **fix(setup): clean up preserve-mode artifacts on overwrite** (#2298)
- **fix(launch): mirror keybindings.json and rules/ to runtime config dir** (#2297)
- **fix(team): sync worker_count after canonicalization dedup** (#2296)
- **fix(team): skip past colliding worker names in scaleUp** (#2295)
- **fix(skill-state): add recency check to orchestrator idle bypass** (#2287)
- **fix(wiki): normalize CRLF in parseFrontmatter for Windows compatibility** (#2285)
- **fix(wiki): escape newlines in title to prevent frontmatter corruption** (#2284)
- **fix(wiki): guard writePageUnsafe against reserved filenames** (#2283)
- **fix(pre-tool-enforcer): strip UTF-8 BOM before frontmatter parsing** (#2276)
- **fix(wiki): titleToSlug produces bare .md for non-ASCII titles** (#2270)
- **fix(wiki): keyword search returns 0 results for CJK text** (#2263)
- **fix(skills): clarify ralph step 7 chaining and ai-slop-cleaner skill invocation** (#2245)
- **fix(persistent-mode): relax overly-strict ralph/ultrawork session-id check** (#2244)
- **fix(hud): correctly mark background agents as completed in transcript parser** (#2243)
- **fix: ignore HTML comments in keyword detector** (#2249)
- **fix(launch): forward env vars into tmux sessions & respect CLAUDE_CONFIG_DIR** (#2204)

### Other Changes

- **Make artifact-first handoffs explicit for interop and prompt persistence** (#2257)

### Stats

- **45 PRs merged** | **3 new features** | **33 bug fixes** | **8 security/hardening improvements** | **1 other change**
