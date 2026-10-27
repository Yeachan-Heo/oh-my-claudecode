# oh-my-claudecode v5.7.18: Keep macOS team workers logged in

## Release Notes

This release preserves Claude Code's macOS keychain OAuth login for team workers by passing `USER` through the POSIX provider environment, preventing workers from starting logged out and being retired with `startup_dispatch_failed`. Thanks to @iyoda for #4625.

### Bug Fixes

- **fix(team): pass `USER` through the POSIX provider environment so macOS workers retain their Claude login** (#4625, @iyoda)

### Other Changes

- **chore(sync): merge main's v5.7.17 release into dev** (#4623)
- **ci: authorize generated artifacts for the v5.7.17 main-to-dev sync** (#4624)

### Stats

- **3 PRs merged** | **0 new features** | **1 bug fix** | **0 security/hardening improvements** | **2 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.18
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.17...v5.7.18

## Contributors

Thank you to all contributors who made this release possible!

@iyoda @Yeachan-Heo
