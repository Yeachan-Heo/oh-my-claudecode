# oh-my-claudecode Unreleased

## Release Notes

### New Features

- **feat(team): per-role provider and model routing via `.claude/omc.jsonc` with resolved-routing snapshot** — declare which provider (`claude`/`codex`/`gemini`) and model tier backs each canonical role (critic, code-reviewer, executor, planner, etc.) in `team.roleRouting`. Routing resolves once at team creation, persists in `TeamConfig.resolved_routing`, and is reused across spawn/scale-up/restart. Env override via `OMC_TEAM_ROLE_OVERRIDES`. Missing CLIs fall back to Claude with a visible warning. See `skills/team/SKILL.md` § Per-Role Provider & Model Routing.
- **fix(team): honor alias-keyed role routing and restrict `ops.defaultAgentType` to runtime-supported CLI providers** — accepted aliases like `reviewer` now affect resolved snapshot/stage routing, and `team.ops.defaultAgentType` now matches actual `/team` launcher semantics (`claude`/`codex`/`gemini` only).

---

# oh-my-claudecode v4.11.6: add MiniMax coding, display extra usage, split usage cache

## Release Notes

Release with **4 new features**, **30 bug fixes**, **14 other changes** across **50 merged PRs**.

### Highlights

- **feat(hud): add MiniMax coding plan usage provider** (#2568)
- **feat(hud): display extra usage spend data in HUD** (#2571)
- **feat(hud): split usage cache by provider to eliminate cross-session thrashing** (#2556)
- **feat(release): rewrite release skill as generic repo-aware assistant** (#2501)

### New Features

- **feat(hud): add MiniMax coding plan usage provider** (#2568)
- **feat(hud): display extra usage spend data in HUD** (#2571)
- **feat(hud): split usage cache by provider to eliminate cross-session thrashing** (#2556)
- **feat(release): rewrite release skill as generic repo-aware assistant** (#2501)

### Bug Fixes

- **fix: suppress optional OMX startup MCP method-not-found pane noise** (#2592)
- **fix(tmux): suppress stale pane alert replays after session death** (#2590)
- **fix(hooks): wrap wiki hook additionalContext in hookSpecificOutput** (#2588)
- **fix(installer): preserve concurrent settings updates during install** (#2586)
- **fix(hooks): prevent duplicate hook firing when plugin and standalone coexist** (#2579)
- **fix(openclaw): suppress dead-session pane replay alerts** (#2563)
- **fix(tmux-detector): suppress stale pane history and commit/UI text false-positives** (#2574)
- **fix(installer): preserve user skills with OMC-style frontmatter during updates** (#2575)
- **fix(permission-handler): allow read-only gh issue/pr commands; add installer lib assertions** (#2576)
- **fix(context-bloat): eliminate three sources of repeated rule/skill injection** (#2578)
- **fix(ask): close stdin for provider spawns to prevent hang in piped environments** (#2564)
- **fix(post-tool-verifier): suppress non-actionable error token noise** (#2559)
- **fix(openclaw): suppress late lifecycle alerts for completed/cleaned-up sessions** (#2554)
- **fix(keyword-detector): suppress review-seed echo from tripping code-review alerts** (#2550)
- **fix(purge): symlink stale plugin version dirs to prevent post-upgrade hook failures** (#2549)
- **fix(deep-interview): replace five remaining hardcoded 20%/0.2 threshold signals (issue #2545)** (#2547)
- **fix(stop-hook): cap echoed task prompt to 150 chars** (#2544)
- **fix(mcp): wire wiki, shared_memory, skills, and deepinit tools into standalone server** (#2537)
- **fix(openclaw): suppress stale tmux pane history in stop/session-end alerts** (#2535)
- **fix(state-root): centralize OMC_STATE_DIR resolution across hook entrypoints** (#2533)
- **fix: restrict setup stale-skill cleanup to OMC-managed dirs** (#2528)
- **fix: reduce post-tool bash failure false positives** (#2526)
- **fix: pipe multiline ask advisor prompts via stdin** (#2524)
- **fix(config): warn on deprecated delegation routing** (#2522)
- **fix(notifications): suppress usage-text tmux alert noise** (#2515)
- **fix(psm): launch trusted sessions with initial prompt** (#2512)
- **fix(openclaw): dedupe multi-pane native lifecycle bursts** (#2494)
- **fix(tmux): keep HUD pane cleanup on the current tmux server** (#2492)
- **fix(autopilot): scope runtime insight to the active session** (#2491)
- **fix(team): scaleUp() should honor agentType launch contracts** (#2489)

### Documentation

- **docs: add omc symlink bootstrap and .mcp.json conflict resolution** (#2493)

### Other Changes

- **Make Ralph enforce real PRD and story review gates** (#2604)
- **Keep PR review verification focused by default** (#2600)
- **Reduce false-severe PR review noise in clean worktrees** (#2598)
- **Guard shipped permission-handler parity at the runtime entrypoint** (#2596)
- **Reduce approval stalls for safe repo inspection and single-test runs** (#2594)
- **Harden live tmux keyword alerts against prompt/search noise** (#2585)
- **Harden tmux keyword alerting against review/payload noise** (#2582)
- **Fix stop-hook timeout enforcement for issue #2565** (#2569)
- **Fix persistent-mode.cjs OMC_STATE_DIR state resolution mismatch** (#2531)
- **Suppress stale repo-level CI replay noise after zero backlog** (#2530)
- **Fix issue #2506: keep review/fix tmux sessions on their requested task context** (#2507)
- **Fix issue #2504: suppress tmux keyword-alert false positives from PR review seed prompts** (#2505)
- **Fix tmux keyword-alert noise from prompt-mode startup echo** (#2502)
- **Back off zero-backlog follow-up spam on unchanged repo state** (#2498)

### Stats

- **50 PRs merged** | **4 new features** | **30 bug fixes** | **0 security/hardening improvements** | **14 other changes**
