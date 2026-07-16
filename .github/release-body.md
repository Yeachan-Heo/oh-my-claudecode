# oh-my-claudecode v4.15.5: Reliability Fixes

## Release Notes

Release with **8 bug fixes** and **2 other changes** across **9 merged PRs**, plus one release-gate fix found during local macOS verification.

### Highlights

- **fix(ci): bind artifact authorizer to dev event base** (#3486)
- **fix(team): make watchdog task publication atomic** (#3488)
- **fix(windows): avoid Git console flashes in hooks and HUD** (#3484)

### Bug Fixes

- **fix(ci): bind artifact authorizer to dev event base** (#3486)
- **fix(windows): keep prompt hook timeout ownership in runner** (#3490)
- **fix(team): make watchdog task publication atomic** (#3488)
- **fix(windows): avoid Git console flashes in hooks and HUD** (#3484)
- **fix(hooks): make SessionEnd shutdown durable and bounded** (#3478)
- **fix: narrow workflow drift decision detection** (#3475)
- **fix: validate direct team mailbox targets** (#3473)
- **fix(team): fall back to locale-stable process start detection on macOS**

### Other Changes

- **test(project-memory): guard packed learner against command harvesting** (#3495)
- **ci: add base-owned generated artifact authorizer** (#3480)

### Stats

- **9 PRs merged** | **0 new features** | **8 bug fixes** | **0 security/hardening improvements** | **2 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask`, `ccg`, and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@4.15.5
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.15.4...v4.15.5

## Contributors

Thank you to all contributors who made this release possible!

@Yeachan-Heo
