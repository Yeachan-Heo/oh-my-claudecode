# oh-my-claudecode v5.7.25: Protect sensitive repository paths and credential files

## Release Notes

This release closes case-insensitive bypasses in sensitive repository path protection and prevents safe-read inspection from auto-approving private-key and credential files. Thanks to @LukeTheoJohnson for #4693.

### Security Fixes

- **fix(permission-handler): match sensitive repo paths case-insensitively** (#4693; @LukeTheoJohnson)
- **fix(permission-handler): treat private-key and credential files as sensitive** (#4694)

### Stats

- **2 PRs merged** | **0 new features** | **2 security fixes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.25
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.24...v5.7.25

## Contributors

Thank you to all contributors who made this release possible!

@LukeTheoJohnson @Yeachan-Heo
