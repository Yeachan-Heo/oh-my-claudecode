# oh-my-claudecode v5.8.5: MCP servers start again on plugin installs without node_modules (#4954)

## Release Notes

Release with **5 new features**, **5 bug fixes**, **8 other changes** across **19 merged PRs**.

### Highlights

- **fix(bridge): bundle MCP SDK dependencies so plugin installs start without node_modules** (#4955) — fixes the v5.8.4 MCP server crash (#4954)
- **feat(model-routing): add opt-in support for fable model routing (Fixes #4933)** (#4942)
- **feat(jev): opt-in task-size notice and explicit-request rules in the hook script** (#4932)
- **feat(jev): add OMC_JEV_MAX_EFFORT_ALWAYS to cap every explicit Task/Agent effort** (#4930)
- **feat(jev): opt-in `compaction` point that keeps the conversation verbatim** (#4940)
- **feat(jev): give task-size, skill-trigger, intent and learner-extraction their own default excerpt limits** (#4936)

### New Features

- **feat(model-routing): add opt-in support for fable model routing (Fixes #4933)** (#4942)
- **feat(jev): opt-in task-size notice and explicit-request rules in the hook script** (#4932)
- **feat(jev): add OMC_JEV_MAX_EFFORT_ALWAYS to cap every explicit Task/Agent effort** (#4930)
- **feat(jev): opt-in `compaction` point that keeps the conversation verbatim** (#4940)
- **feat(jev): give task-size, skill-trigger, intent and learner-extraction their own default excerpt limits** (#4936)

### Bug Fixes

- **fix(bridge): bundle MCP SDK dependencies so plugin installs start without node_modules** (#4955)
- **fix(jev): make point:off turn a point off under all and all:active** (#4959)
- **fix(jev): read the ralph slash confirmation from the raw prompt** (#4957)
- **fix(jev): confirm mid-prompt slash commands only under an active task-size decision** (#4952)
- **fix(jev): read the TypeScript loop-continuation Noul answer as a probability** (#4938)

### Other Changes

- **ci: re-authorize #4955 generated bridges at d3fe4895** (#4964)
- **ci: authorize #4955 regenerated bridge bundles** (#4956)
- **chore(sync): merge main into dev for v5.8.4** (#4945)
- **ci: authorize sync PR #4945 at GitHub-signed head 1ae48609** (#4953)
- **ci: restore #4945 authorization to signed head 69a40721** (#4951)
- **ci: update #4945 authorization to original head da712048** (#4950)
- **ci: repin #4945 authorization to signed head 69a40721** (#4948)
- **ci: authorize generated artifacts for sync PR #4945 at da712048** (#4946)

### Stats

- **19 PRs merged** | **5 new features** | **5 bug fixes** | **0 security/hardening improvements** | **8 other changes**

### Install / Update

The npm CLI and the Claude Code marketplace/plugin are separate install tracks, not either/or replacements. Update whichever track you use; if you have both installed, update both. CLI-dependent skill paths such as `ask` and CLI-backed `team` require the `omc` CLI from the npm package.

**CLI / runtime:**

```bash
npm install -g oh-my-claude-sisyphus@5.8.5
```

**Claude Code plugin:**

```text
/plugin marketplace update omc
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v5.8.4...v5.8.5

## Contributors

Thank you to all contributors who made this release possible!

@gaebal-gajae @maciejdrazkowski @Yeachan-Heo
