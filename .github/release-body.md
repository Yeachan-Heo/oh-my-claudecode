# oh-my-claudecode v5.7.22: Configurable quality gates for workflow stages

## Release Notes

This release adds configurable blocking and advisory quality gates for the deep-interview, ralplan, and review workflow stages, with settings in user or project OMC config and `omc quality-gates list` for inspecting gate configuration. It also prevents a stage from using its own controller skill as a gate and keeps stages without configured gates as strict no-ops. Thanks to @iyoda for #4670 and #4671, and to @iqdoctor for requesting the original port.

### New Features

- **feat(quality-gates): configure blocking and advisory custom gates for deep-interview, ralplan, and review, and inspect them with `omc quality-gates list`** (#4670; ported from oh-my-codex#3956, issue #3955; requested by @iqdoctor; @iyoda)

### Quality-Gate Safety

- **fix(quality-gates): reject a stage's own controller skill as a gate to prevent self-recursion, and skip gate lookup and prompt-spec work for unconfigured stages** (#4671; @iyoda)

### Other Changes

- **chore(sync): merge main's v5.7.21 release into dev** (#4667)
- **ci: authorize generated artifacts for main-to-dev sync PR #4667** (#4668)

### Stats

- **4 PRs merged** | **1 new feature** | **1 quality-gate safety improvement** | **2 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.7.22
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.7.21...v5.7.22

## Contributors

Thank you to all contributors who made this release possible!

@iqdoctor @iyoda @Yeachan-Heo
