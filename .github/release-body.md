# oh-my-claudecode v5.8.0: Team bridge removal and restored ralph closeout

## Release Notes

This is the first release of the 5.8 series. It removes the oh-my-claude-sisyphus/team bridge exports that were previously offered as an MCP server, simplifying the architecture and reducing maintenance overhead. The ralph closeout implementation has been restored from #4830. **Note:** v5.7.31 was never published; this release follows v5.7.30.

### ⚠️ Breaking Changes

- **Removal of team MCP bridge exports** (#4788) — The `oh-my-claude-sisyphus/team` package export path and associated MCP server bridge have been removed. Migrate to direct team skill invocation (`$team`) or the team command surface instead.

### Features

- **Restored ralph closeout implementation** from #4830 with improved completion predicates and confirmation workflow.

### Stats

- **Multiple PRs merged** | **1 breaking change** | **1 feature restoration** | **0 new features** | **0 bug fixes** | **0 chore**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.8.0
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.30...v5.8.0

## Contributors

Thank you to all contributors who made this release possible!

@RobinNorberg @Yeachan-Heo
