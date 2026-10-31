# oh-my-claudecode v5.7.23: Preserve project memory during session start

## Release Notes

This release prevents session-start from rescanning project memory through a competing writer, preserving stored user fields, and brings the Spanish README in line with the current English README. Thanks to @iyoda for #4681 and @DeadY2J for #4673.

### Bug Fixes

- **fix(session-start): stop rescanning project memory in a second writer so stored user fields are not lost** (#4681; @iyoda)

### Documentation

- **docs(i18n): sync the Spanish README with the current English README** (#4673; @DeadY2J)

### Stats

- **2 PRs merged** | **0 new features** | **1 bug fix** | **1 documentation update**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.23
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.22...v5.7.23

## Contributors

Thank you to all contributors who made this release possible!

@DeadY2J @iyoda @Yeachan-Heo
