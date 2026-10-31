# oh-my-claudecode v5.7.24: Route factory CI failures to the shipped debug skill

## Release Notes

This release routes factory CI failures to the shipped `debug` skill and migrates legacy full-template diagnose routes when they are read. Thanks to @RobinNorberg for #4677.

### Bug Fixes

- **fix(factory): route CI failures to the shipped debug skill and migrate legacy full-template diagnose routes on read** (#4677; fixes #4676; @RobinNorberg)

### Stats

- **1 PR merged** | **0 new features** | **1 bug fix**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.24
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.23...v5.7.24

## Contributors

Thank you to all contributors who made this release possible!

@RobinNorberg @Yeachan-Heo
