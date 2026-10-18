# oh-my-claudecode v5.7.4: More reliable hooks, team workflows, HUD, and Jev planning

## Release Notes

Release with **1 new feature**, **4 bug fixes**, **1 performance improvement**, and **3 test improvements** across **9 merged PRs**.

### Highlights

- **feat(jev): add OMC_JEV_PLAN_MODE to keep Jev from deciding in plan mode** (#4395)
- **fix(team): quarantine stale Cursor verdicts and retain them on unreadable tasks** (#4380)
- **perf(hooks): launch the file-context injectors only for the tools they act on** (#4373)

### New Features

- **feat(jev): add OMC_JEV_PLAN_MODE to keep Jev from deciding in plan mode** (#4395)

### Performance Improvements

- **perf(hooks): launch the file-context injectors only for the tools they act on** (#4373)
  - File-context injectors now launch only for the tools they act on, reducing hook overhead.

### Bug Fixes

- **fix(plugin-cache): link stale plugin roots only to a real cache directory** (#4375)
- **fix(installer): log CLAUDE.md as already up to date when install leaves it unchanged** (#4377)
- **fix(team): quarantine stale Cursor verdicts and retain them on unreadable tasks** (#4380)
- **fix: scope HUD stdin cache per session using stdin.session_id** (#4398)

### Test Improvements

- **test(run-cjs): blank user-level OMC env in the worker skip-guard hook spawns** (#4376)
- **test(atomic-write): give SQLite contention timing bounds a runner margin** (#4385)
- **test: make shutdown and state-clear race checks environment-independent** (#4379)

### Stats

- **9 PRs merged** | **1 new feature** | **4 bug fixes** | **1 performance improvement** | **3 test improvements**

---

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
