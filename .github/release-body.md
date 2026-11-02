# oh-my-claudecode v5.7.30: Fix Windows executable search in project folder

## Release Notes

This release fixes a security issue where omc processes on Windows could inadvertently run executables planted in the project folder.

### Bug Fixes

- **fix: stop omc processes on Windows from running executables planted in the project folder** (#4768)

### Stats

- **1 PR merged** | **0 new features** | **1 bug fix** | **0 test improvements** | **0 chore**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.30
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.29...v5.7.30

## Contributors

Thank you to all contributors who made this release possible!

@RobinNorberg @Yeachan-Heo
