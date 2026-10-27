# oh-my-claudecode v5.7.17: More reliable recovery when providers exit

## Release Notes

This release reaches all-dead recovery when every team worker's provider exits while its tmux pane remains alive, so the job no longer stays running with stuck pending tasks. Thanks to @iyoda for #4618.

### Bug Fixes

- **fix(team): reach all-dead recovery when every worker's provider exits inside a live pane** (#4618, @iyoda)

### Other Changes

- **ci: authorize generated artifacts for an earlier v5.7.16 main-to-dev sync attempt** (#4615)
- **chore(sync): merge main's v5.7.16 release into dev** (#4616)
- **ci: authorize generated artifacts for the v5.7.16 main-to-dev sync** (#4617)

### Stats

- **4 PRs merged** | **0 new features** | **1 bug fix** | **0 security/hardening improvements** | **3 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.17
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.16...v5.7.17

## Contributors

Thank you to all contributors who made this release possible!

@iyoda @Yeachan-Heo
