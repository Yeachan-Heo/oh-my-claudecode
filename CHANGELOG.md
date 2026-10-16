## [Unreleased]

### Fixed

- Recognize Codex 0.162 folder-trust dialogs and report an untrusted workspace instead of typing task text into the menu or granting trust automatically.
- Repair native Windows worker supervisor generation, console handle isolation, process cleanup, and provider exit status.
- Compress the source-bound supervisor invocation to fit Windows command-line limits and reject unresolved native provider executables.
- Submit tmux startup inboxes with Enter; shorten only overflowing Windows inbox notifications using the supplied state-root environment variable.

# oh-my-claudecode v5.7.3: Retire agent variant names, parallel consensus reviews

## Release Notes

Release with **2 improvements**, **1 bug fix**, **2 CI improvements** across **5 merged PRs**.

### Highlights

- **fix(#4343): Retire tiered agent variant names — use model parameter instead** (#4345)
- **fix(#4355): Enable parallel Architect/Critic reviews when both are Claude agents** (#4358)
- **fix(#4363): Ralph started through Skill tool now gets state with prd_mode and prd.json** (#4364)

### Changes

- **fix(#4343): Retire tiered agent variant names — use model parameter instead** (#4345)
  - Replaces tier-based agent selection (fast/balanced/strong) with direct `--model` parameter
  - Simplifies agent routing and removes tier-selector complexity

- **fix(#4355): Enable parallel Architect/Critic reviews when both are Claude agents** (#4358)
  - Allows concurrent Architect and Critic consensus reviews for improved workflow efficiency
  - Coordination guarantees remain for non-Claude agent roles

- **fix(#4363): Ralph started through Skill tool now gets state with prd_mode and prd.json** (#4364)
  - Skill tool invocation of ralph now properly receives planning state artifacts
  - Fixes missing PRD state when using the `skill` tool interface

### CI Improvements

- **fix(ci): restore inventory-graph drift baseline on dev** (#4360, #4365)

### Stats

- **5 PRs merged** | **0 new features** | **1 bug fix** | **2 improvements** | **2 CI improvements**

---

# oh-my-claudecode v5.7.2: add Muse and

## Release Notes

Release with **1 new feature**, **3 bug fixes**, **6 other changes** across **10 merged PRs**.

### Highlights

- **feat(ask): add Muse and fix Grok role prompt transport**

### New Features

- **feat(ask): add Muse and fix Grok role prompt transport**

### Bug Fixes

- **fix(inventory): regenerate inventory graph after #4348**
- **fix(test): set TMPDIR for grok/muse env vars test with Windows platform**
- **fix(ask): mirror Muse ask guard in standalone hook and document Muse in README**

### Documentation

- **docs: refresh inventory-graph baseline after features.md changes**
- **docs: complete ultrawork removal from features.md**
- **docs: remove retired ultrawork/web-clone references** (#4343)

### Other Changes

- **chore: rebind PR #4345 authorization to head 6d1e331a**
- **chore: update PR #4345 authorization with final rebuilt head 36b49bd13**
- **ci: rebind PR #4345 authorization to head 494758c7 and merge base 5a394754**
- **ci: rebind PR #4345 authorization for new head commit (r10)**
- **ci: rebind PR #4345 authorization for new head commit**
- **ci: authorize stale tier-selector dist removal for PR #4345**

### Stats

- **10 PRs merged** | **1 new feature** | **3 bug fixes** | **0 security/hardening improvements** | **6 other changes**
