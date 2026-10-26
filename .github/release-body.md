# oh-my-claudecode v5.7.16: Clearer change summaries and more reliable team startup

## Release Notes

This release preserves the first Git status entry's path in subagent file-change summaries, reports modify/delete paths in team rebase conflict messages, and detects Claude's directory-trust question when it wraps in narrow panes, so workers no longer exit on first launch. Thanks to @rudycelekli for #4607 and #4608, and @iyoda for #4611, which addresses the same symptom as #4123.

### Highlights

- **fix(omc-orchestrator): keep the first git status entry's path intact in the subagent FILE CHANGES SUMMARY** (#4607, @rudycelekli)
- **fix(team): report modify/delete paths in rebase conflict messages** (#4608, @rudycelekli)
- **fix(team): detect Claude's directory-trust dialog when its question wraps in narrow panes** (#4611, fixes #4123; @iyoda)

### Bug Fixes

- **fix(omc-orchestrator): keep the first git status entry's path intact in the subagent FILE CHANGES SUMMARY** (#4607, @rudycelekli)
- **fix(team): report modify/delete paths in rebase conflict messages** (#4608, @rudycelekli)
- **fix(team): detect Claude's directory-trust dialog when its question wraps in narrow panes** (#4611, fixes #4123; @iyoda)

### Other Changes

- **chore(sync): merge the v5.7.15 main release into dev** (#4609)
- **ci: authorize generated artifacts for the v5.7.15 main-to-dev sync** (#4610)

### Stats

- **5 PRs merged** | **0 new features** | **3 bug fixes** | **0 security/hardening improvements** | **2 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.16
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.15...v5.7.16

## Contributors

Thank you to all contributors who made this release possible!

@rudycelekli @iyoda @Yeachan-Heo
