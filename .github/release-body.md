# oh-my-claudecode v4.11.5: Bug Fixes & Release Skill

## Release Notes

Release with **30+ bug fixes** across **50+ merged PRs** and **1 new feature**.

### New Features

- **feat(release): rewrite release skill as generic repo-aware assistant** (#2501) — `/oh-my-claudecode:release` now inspects any repo's CI, version files, and release rules on first run and caches them in `.omc/RELEASE_RULE.md`.

### Highlights

- **Autopilot/Team stability** — surface hidden dependency stalls before `/autopilot` looks hung; preserve live team workflows when coarse staged state drifts; bound MCP restarts; repair retired team MCP config on upgrade.
- **Keyword-detector accuracy** — prevent mode activation from quoted reference prose; keep help-style queries informational; preserve activation in mixed command/help prompts.
- **Ralph robustness** — preserve continuation across interrupted tool turns; silence repeated idle follow-up nudges once backlog is truly zero.
- **HUD reliability** — prevent setup docs from deleting the installed wrapper; surface import errors; prevent stale root state revival.
- **Setup/installer correctness** — always update CLAUDE.md on install; avoid hook re-injection for plugin installs; validate and select cache version candidates deterministically.
- **tmux centralization** — all tmux execution routed through wrapper functions; Windows `.cmd` availability checks aligned; tmux-utils API compatibility restored.

### Bug Fixes

#### Autopilot / Team
- Surface hidden dependency stalls before /autopilot looks hung
- Preserve live team workflows when coarse staged state drifts
- Bound launcher-backed MCP restarts without changing user intent
- Repair retired team MCP config on upgrade and launch
- Prevent stale team worktrees from blocking startup
- Preserve team state for explicit shutdown instead of terminal auto-cleanup
- Keep bridge autopilot blocker regression aligned with active-session ownership
- Prevent autopilot runtime insight from leaking unrelated team blockers
- Let scale-up workers follow the existing provider launch contract
- Avoid Claude onboarding on default omc launches
- Prefer consensus planning blockers over team-stage continuation
- Back off shipped idle follow-ups once zero backlog is unchanged
- Collapse duplicate native lifecycle bursts for attached tmux sessions (#2494)

#### Keyword Detector / Modes
- Prevent shipped keyword-detector hooks from re-triggering on explanatory follow-ups
- Prevent mode activation from quoted reference prose
- Prevent explanatory mode references from re-triggering orchestration
- Prevent bundled help-question regexes from collapsing in keyword detection
- Preserve activation in mixed command/help prompts (#2428)
- Keep help-style use queries informational (#2428)
- Prevent stale ralplan terminal states from re-triggering stop enforcement
- Prevent stale stop-hook state from blocking fresh sessions
- Silence repeated idle follow-up nudges once backlog is truly zero

#### Ralph
- Preserve Ralph continuation across interrupted tool turns

#### HUD
- Prevent HUD setup docs from deleting the installed wrapper
- Prevent session-recreated HUD panes from reviving stale root state
- Surface HUD import errors from plugin root wrapper (#2457)
- Remove stale inline wrapper from HUD skill, copy from canonical template (#2433)
- Prevent nested tmux HUD panes from surviving cleanup (#2492)

#### Setup / Installer / Doctor
- Always update claude config CLAUDE.md on install (#2431)
- Avoid hook re-injection for plugin installs (#2430)
- Validate and strictly select cache version candidates (#2422)
- Prefer latest cache version over stale installed path (#2422)
- Detect CLAUDE.md version drift against plugin cache (#2423)
- Support companion version markers and mingw-safe checks (#2423)
- Use deterministic CLAUDE source for version drift check (#2423)
- Remove extra brace in version drift command (#2423)

#### tmux / CLI
- Centralize all tmux execution through wrapper functions (#2427)
- Keep Windows tmux.cmd execution consistent with availability checks (#2444)
- Restore tmux-utils API compatibility (#2442)
- Allow completed ultrawork sessions to exit cleanly (#2439)

#### Hooks / Tools
- Avoid .json false positive in source extension matching (#2432)
- Recognize `ty` in the supported Python LSP registry (#2439)
- Align learned skill templates with flat-file discovery (#2438)

### Documentation

- **docs: add omc symlink bootstrap and .mcp.json conflict resolution to CONTRIBUTING** (#2493)

### Stats

- **50+ PRs merged** | **1 new feature** | **30+ bug fixes** | **0 breaking changes**

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.11.5
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.11.4...v4.11.5
