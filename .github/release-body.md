# oh-my-claudecode v4.15.7: Bug Fixes

## Release Notes

Release with **4 bug fixes**, **1 other change** across **5 merged PRs**.

### Highlights

- **fix(psm): fail closed on malformed worktree results** (#3531)
- **fix(psm): use jira-cli --raw instead of non-existent --output json** (#3529)
- **fix(psm): use tmux-safe session names so sessions stay manageable** (#3530)

### Bug Fixes

- **fix(psm): fail closed on malformed worktree results** (#3531)
- **fix(psm): use jira-cli --raw instead of non-existent --output json** (#3529)
- **fix(psm): use tmux-safe session names so sessions stay manageable** (#3530)
- **fix(windows): separate prompt host and worker timeouts** (#3525)

### Other Changes

- **ci: add main generated-artifact authorization trust root** (#3540)

### Stats

- **5 PRs merged** | **0 new features** | **4 bug fixes** | **0 security/hardening improvements** | **1 other change**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask`, `ccg`, and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@4.15.7
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.15.6...v4.15.7

## Contributors

Thank you to all contributors who made this release possible!

@Yeachan-Heo
