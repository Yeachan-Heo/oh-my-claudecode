# oh-my-claudecode v5.5.0: jev — advisory, point registry and, jev — ralph

## Release Notes

Release with **22 new features**, **24 bug fixes**, **5 other changes** across **57 merged PRs**.

### Highlights

- **feat(hooks): jev — advisory points batch and script-side channel ADR** (#4075)
- **feat(jev): point registry and shadow eval tool — unify the judgment-point program** (#4065)
- **feat(hooks): jev — ralph completion verdict and task-size shadow points** (#4064)
- **feat(hooks): jev — judgment points with heuristic degradation** (#4058)
- **feat(hud): fall back to rate-limit headers for setup-token usage** (#4057)

### New Features

- **feat(hooks): jev — advisory points batch and script-side channel ADR** (#4075)
- **feat(jev): point registry and shadow eval tool — unify the judgment-point program** (#4065)
- **feat(hooks): jev — ralph completion verdict and task-size shadow points** (#4064)
- **feat(hooks): jev — judgment points with heuristic degradation** (#4058)
- **feat(hud): fall back to rate-limit headers for setup-token usage** (#4057)
- **feat(deep-interview): absorb grilling's frontier-rounds questioning from mattpocock/skills#647** (#4052)
- **perf(hud): throttle and batch the shared cache sweep (fix #4045)** (#4051)
- **feat(skills): state the run numbers in the launch C5 completion report** (#4050)
- **feat(audit): extend shipyard-audit.mjs with project-skill triggers and intent status checks** (#4048)
- **feat(skills): intent — internal requirements intake for non-engineer contributors** (#4038)
- **feat(skills): weave the six remaining output disciplines into both companions** (#4036)
- **feat(skills): minimal-prose-discipline — the yard's third writing companion** (#4035)
- **feat(skills): add closable-next-action and rejoin-orientation rules to agent-doc-discipline**
- **feat(skills): give the drydock guardrail preset a concrete seed shape**
- **feat(skills): wire launch and navigator gates to the shipyard-audit executable**
- **feat(shipyard): retire the --check limitation wording — the structured exit contract exists**
- **feat(shipyard): add the shipyard-audit script — mechanical --check findings in the lookout vocabulary**
- **feat(shipyard): round-2 absorption — comprehension reset, settled-consensus exit, planned handoff, commit-time gates, on-the-spot survey grilling** (#4028)
- **feat(shipyard): close the loop — weave the missing disciplines into the seven skills** (#4026)
- **feat(shipyard): seed the testing discipline volume in the process standards** (#4017)
- **feat(skills): add diagram skill — model-invoked visual explanations** (#4014)
- **feat(shipyard): add architecture-survey skill and invocation contract** (#4012)

### Bug Fixes

- **fix(session-end): record why a release left the job recoverable (#4076)** (#4076)
- **fix(config): validate background task env limit** (#4074)
- **fix(preflight): reject malformed context threshold overrides** (#4071)
- **fix(read-budget): reject malformed env budget overrides** (#4070)
- **fix(read-budget): skip binaries, honor pages, reorder remedy, add maxBytes (#4062)** (#4062)
- **fix(team): bind native team lifecycle to an immutable instance id** (#4059)
- **fix(hooks): enforce the read budget in pre-tool-enforcer (#4054)** (#4054)
- **fix(hud): validate watch intervals** (#4053)
- **fix(inventory): stop failing the drift guard on squash-merged baselines** (#4044)
- **fix: use ${CLAUDE_PLUGIN_ROOT} brace form in hook commands (Windows startup error)** (#4042)
- **fix(inventory): repoint graph provenance at the dev tip after #4041** (#4043)
- **fix(notepad): stop interpreting section text as replace patterns and anchor section boundary** (#4041)
- **fix(hooks): force LC_ALL=C on inline state-root git spawns (#4033)** (#4033)
- **fix(shipyard): stop the audit from manufacturing findings it cannot back**
- **fix(team): make task claims and monitor snapshots consistent** (#4009)
- **fix(inventory): repair the orphaned provenance anchor that reddens every PR** (#4029)
- **fix(graph): invalidate nested operations before closing directory FDs** (#4027)
- **fix(hooks): register the directory-context injector so nested AGENTS.md is delivered (#4006)** (#4006)
- **fix(launch): keep forwarded credentials off every launch command line** (#4022)
- **fix(graph): use directory-relative filesystem operations on Darwin (#4011, rebased from #4013 without the CI workflow change)** (#4021)
- **fix(launch): exec-replace the tmux pane so the agent binary is the pane process (#4005)** (#4005)
- **fix(state): survive a missing better-sqlite3 native binding with an actionable diagnostic (#4016)** (#4016)
- **fix(team): preserve resumed state and scope cancellation safely** (#4015)
- **fix: acquireStateFileLockSync did not honor OMC_TEST_FLOCK_AVAILABLE, breaking the pre-SQLite fallback contract (non-exclusive callers proceed best-effort; exclusive callers fail closed) that legacy-cancel-signal and other flock-era tests depend on**

### Refactoring

- **refactor(skills): read the drydock language contract from launch instead of inlining it** (#4047)

### Documentation

- **docs: add plugin-dir conflict verification note** (#4069)

### Other Changes

- **chore(inventory): rebind v5.5.0 release baseline**
- **chore(build): rebuild generated artifacts for the v5.5.0 release head**
- **chore(inventory): regenerate baseline at the release head**
- **chore(inventory): regenerate baseline at the release head**
- **chore(inventory): refresh the baseline for the audit-contract SKILL.md deltas**

### Stats

- **57 PRs merged** | **22 new features** | **24 bug fixes** | **0 security/hardening improvements** | **5 other changes**
