# oh-my-claudecode v4.15.1: state anchoring, MCP and session-search fixes

Maintenance release with **11 bug fixes** and **3 other changes** across **14 merged PRs**. No new features.

### Highlights

- **fix(worktree): anchor .omc state to superproject, not git submodule** (#3350)
- **fix: honor disabled tools in standalone MCP** (#3346)
- **fix(session-search): encode underscores in project dir name** (#3330)

### Bug Fixes

- **fix(worktree): anchor .omc state to superproject, not git submodule** (#3350)
- **fix(perf): widen CI envelope for subagent-lock benchmark** (#3352, #3353)
- **fix: honor disabled tools in standalone MCP** (#3346)
- **fix: let ultragoal guard escape standalone deadlock** (#3343)
- **fix(installer): prune legacy standalone hook files** (#3342)
- **fix(persistent-mode): keep stop reinforcement quiet while a delegated subagent is running** (#3338)
- **fix(hud): solid teammate rendering** (#3339)
- **fix(session-search): fix search from subdirectory cwd** (#3335)
- **fix(session-search): encode underscores in project dir name (current-scope returns 0 matches)** (#3330)
- **fix(team): cmux team worker startup** (#3328)
- **fix(ccg): default to antigravity advisor** (#3327)

### Other Changes

- **ci(guard): fail PRs that commit dist/ or bridge/ build artifacts** (#3351)
- **feat(cli): add local session friction report command** (#3348)
- **chore: rebuild session search encoder artifacts** (#3333)

### Stats

- **14 PRs merged** | **0 new features** | **11 bug fixes** | **3 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask`, `ccg`, and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@4.15.1
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

## Contributors

Thank you to all contributors who made this release possible!

@Yeachan-Heo @halindrome @momomuchu @Woo-JongHo

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.15.0...v4.15.1
