# oh-my-claudecode v5.7.29: Windows provider resolution and state-lock contention fixes

## Release Notes

This release resolves Windows-specific provider resolution issues for both npm-installed and planted-cwd binaries, fixes state-lock contention from early probe attempts, and improves SessionEnd action claim and manifest handling. Note: v5.7.28 was cut from the wrong branch (main instead of dev) and contained only a version bump with no functionality changes; it was not published to npm or GitHub releases. This release incorporates all intended fixes from the 5.7.27→5.7.28→5.7.29 sequence.

### Bug Fixes

- **fix(team): resolve the PATHEXT candidate for Windows providers** (#4726 follow-up, #4741)
- **fix: prevent Windows where command from searching cwd** (#4728) (#4734)
- **fix: state-lock owner probe outside BEGIN IMMEDIATE to avoid contention** (#4727) (#4736)
- **fix(lib): retry an early SQLITE_BUSY from state-lock database setup** (#4717)
- **fix(utils): use BigInt inodes for NTFS compatibility** (#4719)
- **fix(hooks): retry owner-fenced SessionEnd manifest writes on revision drift** (#4721)
- **fix(ralph): release undoes SessionEnd action claims that never started** (#4723)
- **chore: remove src modules no runtime entry point reaches**

### Test Improvements

- **test(team): fix the #4726 Windows planted-git test and expose the libuv cwd-search gap** (#4746) (#4739)

### Stats

- **10 PRs merged** | **0 new features** | **8 bug fixes** | **1 test improvement** | **1 chore**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.29
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.27...v5.7.29

## Contributors

Thank you to all contributors who made this release possible!

@iyoda @Yeachan-Heo
