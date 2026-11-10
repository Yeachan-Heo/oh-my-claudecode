# oh-my-claudecode v5.8.4: Hooks improvements, Jev enhancements, Teleport fix

## Release Notes

v5.8.4 is a patch release that adds opt-in shell command checks, improves Jev model routing, fixes worktree teleport for projects without package.json, and hardens Windows plugin hook spawning.

### Highlights

- **feat(hooks): opt-in shell command checks for Bash and PowerShell** (#4925) — enable with `OMC_SHELL_CHECKS=1`
- **feat(jev): let a use marker pin the model and effort of a model-routing call** (#4924)
- **fix(teleport): skip the dependency step when the new worktree has no package.json** (#4919)

### Features

- **feat(hooks): opt-in shell command checks for Bash and PowerShell** (#4925)
- **feat(jev): let a use marker pin the model and effort of a model-routing call** (#4924)

### Bug Fixes

- **fix(jev): Stop completion output, Noul probabilities, loop-continuation excerpt, parent-message notices** (#4923)
- **fix(teleport): skip the dependency step when the new worktree has no package.json** (#4919)
- **fix(types): add TypeScript declarations for hook-command-normalizer module**
- **fix(hooks): spawn plugin hooks without a shell on Windows**

### Stats

- **5 PRs merged** | **2 new features** | **4 bug fixes** | **0 security/hardening improvements** | **0 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.8.4
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.8.3...v5.8.4
