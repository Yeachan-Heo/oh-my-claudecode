# oh-my-claudecode v5.7.15: More reliable timeout handling and clearer token counts

## Release Notes

This release preserves whole-integer timeout values in persistent mode and pre-tool advisory cooldowns, shows near-million token counts in millions, and accepts GitHub and GitLab pull request diff and patch URLs. Thanks to @rudycelekli for #4599, #4600, #4601, and #4604.

### Highlights

- **fix(persistent-mode): stop truncating OMC_PERSISTENT_MODE_TIMEOUT_MS** (#4599, @rudycelekli)
- **fix(pre-tool-enforcer): stop truncating OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS** (#4600, @rudycelekli)
- **fix(teleport): read pull request patch and diff URLs** (#4604, @rudycelekli)
- **fix(hud): show token counts that round up to 1000k in millions** (#4601, @rudycelekli)

### Bug Fixes

- **fix(persistent-mode): stop truncating OMC_PERSISTENT_MODE_TIMEOUT_MS** (#4599, @rudycelekli)
- **fix(pre-tool-enforcer): stop truncating OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS** (#4600, @rudycelekli)
- **fix(hud): show token counts that round up to 1000k in millions** (#4601, @rudycelekli)
- **fix(teleport): read pull request patch and diff URLs** (#4604, @rudycelekli)

### Other Changes

- **chore(sync): merge the v5.7.14 main release into dev** (#4596)
- **ci: authorize generated artifacts for the v5.7.14 main-to-dev sync** (#4597)

### Stats

- **6 PRs merged** | **0 new features** | **4 bug fixes** | **0 security/hardening improvements** | **2 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.15
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.14...v5.7.15

## Contributors

Thank you to all contributors who made this release possible!

@rudycelekli @Yeachan-Heo
