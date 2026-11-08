⚠️ **Breaking Changes:** The public `oh-my-claude-sisyphus/team` module exports have been removed (#4788). See [Migration Guide](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/docs/MIGRATION.md) for alternatives.

**Note:** v5.7.31 was never published. This release aggregates improvements staged in the abandoned v5.7.31 stream with v5.7.30 and subsequent backlog work.

---

## Highlights

- **feat(jev): let model-routing choose subagent effort** (#4810)
- **BREAKING: remove public team exports** (#4788) — external consumers must use alternative integration patterns

## New Features

- **feat(jev): let model-routing choose subagent effort** (#4810)

## Bug Fixes

- **fix(jev): use the full effort range in model-routing** (#4820)
- **fix(jev): consume active-mode answers in plugin hook scripts** (#4808)
- **fix(ralph): exclude vitest's Start at clock from failure signatures** (#4819)
- **fix(jev): map the context-pruning staleness score and keep CRITICAL at the threshold** (#4818)
- **fix(jev): extract primitive heuristics for comparability - Fixes #4806** (#4809)
- **fix(hooks): don't flag a run awaiting confirmation as crashed** (#4799)
- **fix(hooks): correct Jev context-pruning answer gate and mapping (issue #4804)** (#4807)
- **fix(ralph): stop fingerprinting pytest progress dots as failures** (#4800)
- **fix(ralph): normalize pytest (m:ss) durations in feedback signatures** (#4801)
- **fix(ralph): exclude pytest all-pass summaries from failure signatures** (#4802)
- **fix(hooks): keep the plugin and standalone helper copies identical** (#4784)

## Documentation

- **docs(migration): document the team entry-point exports removed with the bridge**
- **docs(team): drop skill guidance that calls the removed bridge APIs**

## Other Changes

- **chore(team): remove the MCP team bridge that nothing spawns**
- **chore(auth): authorize generated artifacts for releases**
- **chore(sync): rebuild generated artifacts and inventory after main→dev merge**
- **chore(inventory): regenerate after merging dev**

## Stats

- **23 PRs merged** | **1 new feature** | **11 bug fixes** | **2 breaking changes** | **8 other changes**

## Install / Update

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
