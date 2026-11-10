# oh-my-claudecode v5.8.3: Bug Fixes

## Release Notes

Release with **2 bug fixes**, **6 other changes** across **8 merged PRs**.

### Highlights

- **fix(checkpoint): keep tracked files that match an ignore rule in snapshots** (#4904)
- **fix(mcp-registry): do not write type field to Codex config (fixes #4899)** (#4903)

### Bug Fixes

- **fix(checkpoint): keep tracked files that match an ignore rule in snapshots** (#4904)
- **fix(mcp-registry): do not write type field to Codex config (fixes #4899)** (#4903)

### Other Changes

- **ci: repin sync PR #4907 authorization to signed head 11190730**
- **chore(sync): leave base-owned authorization file to dev**
- **ci: repin sync PR #4907 authorization to 672baa2c**
- **ci: retrigger checks after authorization PR merge**
- **ci: authorize generated artifacts for sync PR #4907 at edc27e05e**
- **chore(inventory): regenerate after #4903** (#4905)

### Stats

- **8 PRs merged** | **0 new features** | **2 bug fixes** | **0 security/hardening improvements** | **6 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.8.3
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.8.2...v5.8.3
