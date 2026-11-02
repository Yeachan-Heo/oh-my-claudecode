# oh-my-claudecode v5.7.31: Keep plugin and standalone helper copies synchronized

## Release Notes

This release synchronizes the plugin and standalone helper copies of thirteen shared modules and fixes a stdin timeout mismatch that caused hook reads to time out mid-operation under external hook budgets.

### Bug Fixes

- **fix(hooks): keep the plugin and standalone helper copies identical** (#4784; @Jack11111eee)

### Stats

- **1 PR merged** | **0 new features** | **1 bug fix**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.31
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.30...v5.7.31

## Contributors

Thank you to all contributors who made this release possible!

@Jack11111eee @Yeachan-Heo
