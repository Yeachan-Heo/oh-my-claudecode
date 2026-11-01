# oh-my-claudecode v5.7.26: Keep project memory and workflow routing current

## Release Notes

This release keeps project-memory hot paths aligned with the files users are working on and stops retired workflow names from being recommended or routed at runtime. Thanks to @iyoda for #4698 and #4699.

### Bug Fixes

- **fix(project-memory): make hot paths follow current work** (#4698; @iyoda)
- **fix(workflows): drop retired ultraqa, omc-teams, and ultrawork names that still route** (#4699; @iyoda)

### Stats

- **2 PRs merged** | **0 new features** | **2 bug fixes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.26
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.25...v5.7.26

## Contributors

Thank you to all contributors who made this release possible!

@iyoda @Yeachan-Heo
