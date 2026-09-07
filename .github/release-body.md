# oh-my-claudecode v5.4.0: add harbor —, make the SessionStart

## Release Notes

Release with **2 new features**, **6 bug fixes**, **1 other change** across **9 merged PRs**.

### Highlights

- **feat(skills): add harbor — shipyard intake gate for external issues and PRs (opt-in)** (#3982)
- **feat(hooks): make the SessionStart context budget configurable via OMC_SESSION_START_CONTEXT_BUDGET** (#3981)

### New Features

- **feat(skills): add harbor — shipyard intake gate for external issues and PRs (opt-in)** (#3982)
- **feat(hooks): make the SessionStart context budget configurable via OMC_SESSION_START_CONTEXT_BUDGET** (#3981)

### Bug Fixes

- **fix(worktree-paths): treat a bare repository as a work-tree-less repo, not a failed probe** (#3991)
- **fix(release): cover version-coupled surfaces in the release runbook** (#3989)
- **fix(inventory): re-anchor inventory-graph provenance to the current dev head** (#3987)
- **fix(setup): continue with canonical plugin root when launcher path is a compat symlink** (#3986)
- **fix(worktree-paths): force LC_ALL=C on git probe spawns** (#3979)
- **fix(team): bound active Cursor/Codex startup grace and verify provider cleanup**

### Documentation

- **docs: replace retired mode guidance with the shipped 5.3.0 surface** (#3985)

### Other Changes

- **chore(inventory): refresh graph for startup grace changes**

### Stats

- **9 PRs merged** | **2 new features** | **6 bug fixes** | **0 security/hardening improvements** | **1 other change**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.4.0
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.3.0...v5.4.0
