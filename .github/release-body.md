# oh-my-claudecode v4.15.6: Named Stage Profiles & Reliability Fixes

## Release Notes

Release with **1 new feature**, **10 bug fixes** across **11 merged PRs**.

### Highlights

- **feat(autopilot): add named stage profiles** (#3492)

### New Features

- **feat(autopilot): add named stage profiles** (#3492)

### Bug Fixes

- **fix(release): guard coordinator across shipped surfaces** (#3516)
- **fix: ship complete plugin runtime closure** (#3479)
- **fix(windows): ship hidden worktree git subprocesses** (#3501)
- **fix(ultragoal): make the /goal handoff satisfy the guard, not just the ledger** (#3514)
- **fix(lsp): handle server-to-client requests** (#3511)
- **fix(ultragoal): defer /goal guard until confirmation** (#3510)
- **fix(beads): correct CLI instruction syntax** (#3505)
- **fix(session-start): keep plugin drift guidance on marketplace channel** (#3500)
- **fix(session-start): align update notices with plugin channel** (#3499)
- **fix(windows): bound generic-hook runner timeout ownership and nested git** (#3496)

### Stats

- **11 PRs merged** | **1 new feature** | **10 bug fixes** | **0 security/hardening improvements** | **0 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask`, `ccg`, and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@4.15.6
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.15.5...v4.15.6

## Contributors

Thank you to all contributors who made this release possible!

@FrontHeadlock @Yeachan-Heo
