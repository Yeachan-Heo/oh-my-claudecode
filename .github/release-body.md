# oh-my-claudecode v5.7.27: SQLITE_BUSY retry, BigInt file identities, and SessionEnd manifest drift handling

## Release Notes

This release introduces compatibility improvements for NTFS file systems with BigInt inode support, adds retry logic for early SQLITE_BUSY errors during state-lock setup, and improves SessionEnd action claim handling to prevent zombie claims. Thanks to the maintainers for #4717, #4719, #4721, and #4723.

### Bug Fixes

- **fix(lib): retry an early SQLITE_BUSY from state-lock database setup** (#4717)
- **fix(utils): use BigInt inodes for NTFS compatibility** (#4719)
- **fix(hooks): retry owner-fenced SessionEnd manifest writes on revision drift** (#4721)
- **fix(ralph): release undoes SessionEnd action claims that never started** (#4723)

### Stats

- **4 PRs merged** | **0 new features** | **4 bug fixes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.27
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.26...v5.7.27

## Contributors

Thank you to all contributors who made this release possible!

@iyoda @Yeachan-Heo
