# Unreleased

## Added

- New `omc setup` interactive wizard mode on TTY (same 11-question flow as `/omc-setup` skill). Mirrors the in-session experience from the terminal.
- SAFE_DEFAULTS non-interactive install for non-TTY contexts (`--non-interactive`, or automatic fallback when no TTY detected). Opinionated full install: global CLAUDE.md, ultrawork mode, all MCP servers in `install-without-auth`, 3 executor teams, HUD, welcome.
- `--infra-only` escape hatch for CI/automation that needs the pre-refactor byte-identical bare `omc setup` behavior.
- New flags: `--wizard`, `--preset <file>`, `--claude-md-only`, `--mcp-only`, `--state-save`, `--state-clear`, `--state-resume`, `--state-complete`, `--check-state`, `--build-preset`, `--dump-safe-defaults`, `--mcp-on-missing-creds`, `--mcp-scope`, `--exa-key-file`, `--github-token-file`, and phase option flags (`--target`, `--preserve`, `--overwrite`, `--execution-mode`, `--task-tool`, `--configure-mcp`, `--mcp-servers`, `--enable-teams`, `--team-agents`, `--team-type`, `--star-repo`).

## Changed

- `omc setup` and `/oh-my-claudecode:omc-setup` now share a single TypeScript implementation at `src/setup/`. The skill is a thin preset-builder that invokes `omc setup --build-preset` → `omc setup --preset`.
- `/oh-my-claudecode:mcp-setup` is now a thin wrapper around `omc setup --mcp-only`.
- `scripts/setup-claude-md.sh` and `scripts/setup-progress.sh` reduced from 563 lines of bash to thin shims that `exec` the CLI. Existing callers continue to work.
- MCP install default is now `--mcp-on-missing-creds=install-without-auth` (servers register without credentials so they appear in `claude mcp list`). Old behavior available via `--mcp-on-missing-creds=skip`.
- MCP install default scope is now `--scope user` (was implicitly `--scope local` via `claude mcp add` default). Use `--mcp-scope=local` for project-scoped installs.

## Fixed

- `--skip-hooks` flag now actually skips hook installation. Previously declared in the CLI but silently ignored — scripts that passed it got hooks installed anyway. A stderr deprecation advisory is emitted on first use per day for two releases to give downstream callers a soft landing.

## Deprecated

- `skills/omc-setup/phases/0[1-4]-*.md` files removed (logic moved to `src/setup/phases/*.ts`). The skill entry point is unchanged; only internal phase files are gone.

# oh-my-claudecode v4.11.3: Bug Fixes

## Release Notes

Release with **7 bug fixes** across **9 merged PRs**.

### Highlights

- **fix(node): prefer PATH node over unstable execPath** (#2400)
- **fix(hooks): prevent .js false positives in .json/.jsonl source extension check** (#2395)
- **fix(autoresearch): strip TMUX env for nested tmux compatibility** (#2385)

### Bug Fixes

- **fix(node): prefer PATH node over unstable execPath** (#2400)
- **fix(hooks): prevent .js false positives in .json/.jsonl source extension check** (#2395)
- **fix(autoresearch): strip TMUX env for nested tmux compatibility** (#2385)
- **fix: resolve asymmetric symlink path resolution** (#2372)
- **fix(installer): detect enabledPlugins (Claude Code 1.x) in hasEnabledOmcPlugin (#2252 follow-up)** (#2371)
- **fix: deactivate stale ralplan stop enforcement after consensus completion** (#2370)
- **fix(hud): fall back to path-based version when package.json is missing** (#2362)

### Documentation

- **docs: document --plugin-dir and add CONTRIBUTING.md for local development** (#2399)
- **docs(getting-started): document plugin + npm CLI as two coexisting surfaces** (#2367)

### Stats

- **9 PRs merged** | **0 new features** | **7 bug fixes** | **0 security/hardening improvements** | **0 other changes**
