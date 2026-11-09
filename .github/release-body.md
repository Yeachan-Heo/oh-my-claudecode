# oh-my-claudecode v5.8.2: Restore dev fixes, ralph closeout fixes, LSP Windows support

## Release Notes

v5.8.2 is a patch release that restores important dev-branch fixes that were inadvertently reverted in the v5.8.0 sync, adds ralph closeout Codex findings fixes, and improves LSP devcontainer URI mapping on Windows hosts.

### Bug Fixes

- **fix(mcp): restore the profile's own .claude.json for CLAUDE_CONFIG_DIR** (#4890)
- **fix: restore dev fixes reverted by the v5.8.0 main→dev sync** (#4893)
- **fix: address ralph closeout Codex findings** (#4896)
- **fix(lsp): map devcontainer URIs and labels on a Windows host** (#4897)

### Stats

- **4 PRs merged** | **0 new features** | **4 bug fixes** | **0 test improvements** | **0 chore**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.8.2
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.8.1...v5.8.2

## Contributors

Thank you to all contributors who made this release possible!

@Yeachan-Heo @pangpang778 @Jack11111eee @maciejdrazkowski @iyoda @tanishqbaweja @LukeTheoJohnson @topazyo
