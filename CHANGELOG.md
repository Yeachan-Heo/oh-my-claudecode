# Unreleased

### Fixed

- Repair native Windows worker supervisor generation, console handle isolation, process cleanup, and provider exit status.
- Compress the source-bound supervisor invocation to fit Windows command-line limits and reject unresolved native provider executables.
- Submit tmux startup inboxes with Enter; shorten only overflowing Windows inbox notifications using the supplied state-root environment variable.
- Recognize Codex folder-trust prompts without delivering task text or granting persistent trust.

---

# oh-my-claudecode v5.7.7: Codex hook compatibility and safer HUD loading

## Release Notes

This release includes fixes for Codex hook output, HUD fallback security and reliability, configuration parsing, team shutdown validation, and plugin-only bootstrap.

### Bug Fixes

- **fix(hooks): emit Codex-compatible PreToolUse output** (#4489, fixes #4488)
- **fix(hud): restrict npm fallback to the global prefix** (#4471, #4472)
- **fix(hooks): fall back from blank shell config directory overrides** (#4474)
- **fix(hooks): honor trailing commas in agent model JSONC** (#4473)
- **fix(installer): recognize quoted Codex MCP keys** (#4469)
- **fix(hud): report cached HUD load failures** (#4468)
- **fix(skills): align argument hints with behavior** (#4465)
- **fix(team): validate shutdown acknowledgements before consuming them** (#4462)
- **fix(ultragoal): allow plugin-only bootstrap commands** (#4459)

### Other Changes

- **test(ci): make timing regression tests deterministic** (#4464)
- **ci: canonicalize generated-artifact authorization expiry timestamps** (#4484)
- **ci: sync the v5.7.6 main release back into dev** (#4485)
- **chore(inventory): regenerate the inventory graph** (#4486)

---

# oh-my-claudecode v5.7.6: Fix plugin-mode HUD loading and tighten input validation

## Release Notes

Hotfix for v5.7.5: the plugin HUD no longer imports Zod from the plugin cache, where `node_modules` is unavailable. This release also fixes HUD estimates, frontmatter handling, command parsing, and numeric option validation.

### Bug Fixes

- **fix(hud): remove the runtime Zod dependency from plugin security config** (#4454, PR #4455)
- **fix(hud): exclude local API request records from the payload estimate** (#4437)
- **fix(featured-contributors): reject invalid `--min-stars` values** (#4439)
- **fix(session-end): prevent `OMC_DAILY_CHAIN_LIMIT` from flooring to zero** (#4440)
- **fix(autoresearch): reject invalid `--max-waves` and `--poll-interval` values** (#4441)
- **fix(team): reject non-integer numeric CLI flag values** (#4442)
- **fix(auto-slash-command): keep the plugin namespace when parsing slash commands** (#4450)
- **fix(agents): read frontmatter by line-anchored delimiters, including after a BOM** (#4451)
- **fix(autoresearch): accept a leading UTF-8 BOM in `sandbox.md` frontmatter** (#4452)

### Other Changes

- **ci:** refresh generated-artifact authorizations and inventory metadata for the main-to-dev sync (#4444, #4445, #4449, #4453)

---
