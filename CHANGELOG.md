<<<<<<< HEAD
# oh-my-claudecode v5.8.0
=======
# oh-my-claudecode v5.8.0: Team Bridge Removal and JEV Model Routing

## Release Notes

⚠️ **Breaking Changes:** The public `oh-my-claude-sisyphus/team` module exports have been removed (#4788). See [Migration Guide](docs/MIGRATION.md) for alternatives.

**Note:** v5.7.31 was never published. This release aggregates improvements staged in the abandoned v5.7.31 stream with v5.7.30 and subsequent backlog work.

Release with **1 new feature**, **11 bug fixes**, **2 breaking changes**, and **8 other changes** across **23 merged PRs**.

### Highlights

- **feat(jev): let model-routing choose subagent effort** (#4810)
- **BREAKING: remove public team exports** (#4788) — external consumers must use alternative integration patterns

### Breaking Changes

- **Team Bridge Removal (#4788)**: Public `oh-my-claude-sisyphus/team` exports removed. External consumers should migrate to alternative patterns. See [Migration Guide](docs/MIGRATION.md#team-module-removal).

### New Features

- **feat(jev): let model-routing choose subagent effort** (#4810)

### Bug Fixes

- **fix(jev): use the full effort range in model-routing** (#4820)
- **fix(jev): consume active-mode answers in plugin hook scripts** (#4808)
- **fix(ralph): exclude vitest's Start at clock from failure signatures** (#4819)
- **fix(jev): map the context-pruning staleness score and keep CRITICAL at the threshold** (#4818)
- **fix(jev): extract primitive heuristics for comparability** (#4809)
- **fix(hooks): don't flag a run awaiting confirmation as crashed** (#4799)
- **fix(hooks): correct Jev context-pruning answer gate and mapping** (#4807)
- **fix(ralph): stop fingerprinting pytest progress dots as failures** (#4800)
- **fix(ralph): normalize pytest (m:ss) durations in feedback signatures** (#4801)
- **fix(ralph): exclude pytest all-pass summaries from failure signatures** (#4802)
- **fix(hooks): keep the plugin and standalone helper copies identical** (#4784)

### Documentation

- **docs(migration): document the team entry-point exports removed with the bridge** (#4788)
- **docs(team): drop skill guidance that calls the removed bridge APIs** (#4788)

### Other Changes

- **chore(team): remove the MCP team bridge that nothing spawns** (#4788)
- **chore(auth): authorize generated artifacts for releases**
- **chore(sync): rebuild generated artifacts and inventory after main→dev merge**
- **chore(inventory): regenerate after merging dev**

### Stats

- **23 PRs merged** | **1 new feature** | **11 bug fixes** | **2 breaking changes** | **8 other changes**

---

# oh-my-claudecode v5.7.30: Fix Windows executable search in project folder
>>>>>>> clean-release

## Release Notes

⚠️ **Breaking Changes:** The public `oh-my-claude-sisyphus/team` module exports have been removed (#4788). See migration guide for alternatives.

**Note:** v5.7.31 was never published. This release contains all improvements from v5.7.31 with fixed generated-artifact authorization tests and merged main→dev history.

Release with **1 new feature**, **11 bug fixes**, **8 other changes** across **23 merged PRs**.

### Highlights

- **feat(jev): let model-routing choose subagent effort** (#4810)
- **BREAKING: remove public team exports** (#4788)

### Breaking Changes

- **Team Bridge Removal (#4788)**: Public `oh-my-claude-sisyphus/team` exports removed. External consumers should use alternative integration patterns.

---

# oh-my-claudecode v5.7.31: let model-routing choose (UNPUBLISHED)

## Release Notes

Release with **1 new feature**, **11 bug fixes**, **8 other changes** across **23 merged PRs**.

### Highlights

- **feat(jev): let model-routing choose subagent effort** (#4810)

### New Features

- **feat(jev): let model-routing choose subagent effort** (#4810)

### Bug Fixes

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

### Documentation

- **docs(migration): document the team entry-point exports removed with the bridge**
- **docs(team): drop skill guidance that calls the removed bridge APIs**

### Other Changes

- **chore(auth): authorize generated artifacts for main→dev sync #4792** (#4793)
- **chore(sync): rebuild generated artifacts and inventory after main→dev merge**
- **chore(auth): move the team bridge removal authorization from #4758 to #4788** (#4789)
- **chore(auth): re-pin the #4758 authorization after merging dev** (#4787)
- **chore(inventory): regenerate after merging dev**
- **chore(auth): authorize generated artifacts for #4758 (team bridge removal)** (#4786)
- **chore: remove build outputs of the deleted team bridge modules**
- **chore(team): remove the MCP team bridge that nothing spawns**

### Stats

- **23 PRs merged** | **1 new feature** | **11 bug fixes** | **0 security/hardening improvements** | **8 other changes**
