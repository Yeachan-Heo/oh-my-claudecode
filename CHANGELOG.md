# oh-my-claudecode v5.8.6: Plugin payload sync optimization

## Release Notes

v5.8.6 is a patch release that optimizes the plugin payload sync process by skipping unnecessary sync operations when payloads are already complete.

### Bug Fixes

- **fix(installer): skip plugin payload sync when payloads are complete** (#1502) — improves performance by avoiding unnecessary file system operations when plugin payloads are already valid

### Stats

- **1 fix** | **0 new features** | **0 security/hardening improvements**

---

# oh-my-claudecode v5.8.5: Jev enhancements and hook improvements

## Release Notes

v5.8.5 is a patch release that adds opt-in environment variables to control Jev advisory point actions, extends hook timeouts for improved reliability, and improves flexibility in the loop-continuation workflow.

### Features

- **feat(jev): opt-in actions on advisory Jev points** (#4935) — introduces `OMC_JEV_SLOP_WARNING_APPLY`, `OMC_JEV_LEARNER_EXTRACTION_APPLY`, `OMC_JEV_SIMPLIFIER_TRIGGER_APPLY`, and `OMC_JEV_LOOP_RELEASE_ONLY` environment variables
- **feat(jev): opt-in routing hints for large mechanical work** (#4960) — adds guidance for model selection in specific scenarios
- **feat(hooks): improved hook timeout handling** — better hook execution under concurrent operations

### Bug Fixes

- **fix(jev): lengthen hook timeouts for hooks that wait for Jev** (#4961) — improved reliability for hooks waiting on Jev model routing
- **fix(shell-checks): count a bash that exits before reading the command as bash-failure** (#4958)
- **fix(test): set TMPDIR for grok/muse env vars test with Windows platform**
- **fix(jev): restore vi.waitFor replacement polling utility in Jev integration tests**

### Stats

- **5 PRs merged** | **3 new features** | **4 bug fixes** | **0 security/hardening improvements** | **0 other changes**

---

# oh-my-claudecode v5.8.4: Hooks improvements, Jev enhancements, Teleport fix

## Release Notes

v5.8.4 is a patch release that adds opt-in shell command checks, improves Jev model routing, fixes worktree teleport for projects without package.json, and hardens Windows plugin hook spawning.

### Features

- **feat(hooks): opt-in shell command checks for Bash and PowerShell** (#4925) — enable with `OMC_SHELL_CHECKS=1`
- **feat(jev): let a use marker pin the model and effort of a model-routing call** (#4924)

### Bug Fixes

- **fix(jev): Stop completion output, Noul probabilities, loop-continuation excerpt, parent-message notices** (#4923)
- **fix(teleport): skip the dependency step when the new worktree has no package.json** (#4919)
- **fix(types): add TypeScript declarations for hook-command-normalizer module** (e1ec999)
- **fix(hooks): spawn plugin hooks without a shell on Windows** (d605bce)

### Stats

- **5 PRs merged** | **2 new features** | **4 bug fixes** | **0 security/hardening improvements** | **0 other changes**

---

# oh-my-claudecode v5.8.3: Bug Fixes

## Release Notes

Release with **2 bug fixes**, **6 other changes** across **8 merged PRs**.

### Highlights

- **fix(checkpoint): keep tracked files that match an ignore rule in snapshots** (#4904)
- **fix(mcp-registry): do not write type field to Codex config (fixes #4899)** (#4903)

### Bug Fixes

- **fix(checkpoint): keep tracked files that match an ignore rule in snapshots** (#4904)
- **fix(mcp-registry): do not write type field to Codex config (fixes #4899)** (#4903)

### Other Changes

- **ci: repin sync PR #4907 authorization to signed head 11190730**
- **chore(sync): leave base-owned authorization file to dev**
- **ci: repin sync PR #4907 authorization to 672baa2c**
- **ci: retrigger checks after authorization PR merge**
- **ci: authorize generated artifacts for sync PR #4907 at edc27e05e**
- **chore(inventory): regenerate after #4903** (#4905)

### Stats

- **8 PRs merged** | **0 new features** | **2 bug fixes** | **0 security/hardening improvements** | **6 other changes**

---

# oh-my-claudecode v5.8.2: Hook event signature improvements

## Release Notes

Release with **1 new feature**, **1 bug fix**, **3 other changes** across **5 merged PRs**.

### Highlights

- **feat(hooks): add argv to pre/post-tool-use-failure hook events** (#4883)
- **fix(hooks): improve hook shutdown grace period handling on Windows** (#4891)

### Features

- **feat(hooks): add argv to pre/post-tool-use-failure hook events** (#4883)

### Bug Fixes

- **fix(hooks): improve hook shutdown grace period handling on Windows** (#4891)

### Other Changes

- **ci: repin #4891 authorization**
- **ci: authorize generated artifacts for pull request #4891**
- **ci: repin sync PR #4889 authorization to new head fb49e8da**

### Stats

- **5 PRs merged** | **1 new feature** | **1 bug fix** | **0 security/hardening improvements** | **3 other changes**

---

# oh-my-claudecode v5.8.1: Release candidate launch

## Release Notes

v5.8.1 is a release candidate for the v5.8 feature line, with consolidation of recent Jev improvements and hook refinements.

Release with **5 new features**, **3 bug fixes**, **11 other changes** across **19 merged PRs**.

### Highlights

- **feat(hook-dispatcher): add hook-call timeout in state-tracking context** (#4873) — Implements timeout tracking for hook calls in mode-running hook context
- **feat(jev): new Noul-type `bool` answer for Jev branching in model-routing contexts** (#4877) — Adds boolean Noul-type answer support
- **feat(persistent-mode): opt-in async transition guards for ralph/autopilot/team phases** (#4878) — Allows async validation of mode transitions
- **feat(tree-cli): Tree-CLI diagnostic suite for debugging Jev and hook behavior** (#4879)
- **feat(hooks): add optional asyncRequest parameter to hook context for long-running operations** (#4880)

### Features

- **feat(hook-dispatcher): add hook-call timeout in state-tracking context** (#4873)
- **feat(jev): new Noul-type `bool` answer for Jev branching in model-routing contexts** (#4877)
- **feat(persistent-mode): opt-in async transition guards for ralph/autopilot/team phases** (#4878)
- **feat(tree-cli): Tree-CLI diagnostic suite for debugging Jev and hook behavior** (#4879)
- **feat(hooks): add optional asyncRequest parameter to hook context for long-running operations** (#4880)

### Bug Fixes

- **fix(jev): set OMC_JEV_LOOP_RELEASE_MAX to 5 default to stop premature release blocking** (#4884)
- **fix(hooks): improve hook timeouts and process cleanup on Windows** (#4885)
- **fix(ralph): correct `loop_released` decision visibility in state JSON** (#4886)

### Other Changes

- **ci: authorize generated artifacts for #4873, #4877, #4878, #4879, #4880, #4884, #4885, #4886, #4888**
- **ci: repin authorization PRs with updated generated artifacts**
- **chore: regenerate inventory graph after feature merges**

### Stats

- **19 PRs merged** | **5 new features** | **3 bug fixes** | **0 security/hardening improvements** | **11 other changes**

---

# oh-my-claudecode v5.8.0: Final release

## Release Notes

v5.8.0 is the final release of the v5.8 feature line. This version consolidates improvements to Jev model routing, hook event signatures, and persistent mode handling.

Release with **7 new features**, **5 bug fixes**, **9 other changes** across **21 merged PRs**.

### Highlights

- **feat(jev): model-routing answer types and extensible decision framework** — Comprehensive Jev answer-type system
- **feat(hooks): hook event context improvements** — Better event signatures for hook implementations
- **feat(persistent-mode): improved mode lifecycle management** — More reliable state transitions
- **feat(inventory): graph-based inventory visualization** — Dependency graph for the codebase
- **feat(team): agent coordination improvements** — Better team workflow support

### Features

- **feat(jev): model-routing answer types and extensible decision framework** (#4820)
- **feat(hooks): hook event context improvements** (#4821)
- **feat(persistent-mode): improved mode lifecycle management** (#4822)
- **feat(inventory): graph-based inventory visualization** (#4823)
- **feat(team): agent coordination improvements** (#4824)
- **feat(ultragoal): multi-plan tracking and completion** (#4825)
- **feat(projection): skill-state projection system** (#4826)

### Bug Fixes

- **fix(jev): correct answer normalization for model routing** (#4827)
- **fix(hooks): improve hook dispatcher reliability** (#4828)
- **fix(persistent-mode): fix state transition guards** (#4829)
- **fix(inventory): ensure inventory graph consistency** (#4830)
- **fix(team): improve agent failure handling** (#4831)

### Other Changes

- **ci: authorize generated artifacts for feature releases**
- **chore: regenerate all inventory graphs**
- **docs: update feature documentation for v5.8.0**

### Stats

- **21 PRs merged** | **7 new features** | **5 bug fixes** | **0 security/hardening improvements** | **9 other changes**

---
