# oh-my-claudecode v5.7.31: let model-routing choose

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
