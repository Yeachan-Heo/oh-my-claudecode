# Native Team Worktree Mode

Native team worktree mode is the opt-in rollout path for running `omc team` workers in dedicated git worktrees while keeping one leader-owned team-specific coordination root. It is intended for runtime-v2 team sessions and is designed to make worker edits isolated without fragmenting task, mailbox, status, or manifest state.

## Availability

- The rollout is **opt-in / config-gated** for the first slice. Do not assume worktree mode is the default behavior.
- The target runtime is `runtime-v2`. Legacy `runtime.ts` remains limited to read/status and cleanup compatibility unless a later plan explicitly expands it.
- No new dependency is required; lifecycle operations use git worktrees plus the existing team CLI/API surfaces.
- Backported OMX team behaviors are compatibility inputs only. The OMC-native contract remains `omc team ...`, `omc team api ... --json`, `OMC_TEAM_STATE_ROOT`, and `.omc/state/team/<team-name>`; `.omx` paths or `OMX_*` variables must not become native OMC state roots.

## Workspace contract

When worktree mode is active, OMC uses this stable layout:

| Field                           | Contract                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Worktree root                   | `<repo>/.omc/team/<team-name>/worktrees/<worker-name>`                                |
| Team-specific coordination root | `<repo>/.omc/state/team/<team-name>` in the leader workspace                          |
| Worker cwd                      | The worker's `worktree_path`                                                          |
| Worker coordination             | `OMC_TEAM_STATE_ROOT` points back to the team-specific leader-owned coordination root |
| Worker instructions             | Worktree-root `AGENTS.md` is installed with backup/restore safeguards                 |

Workers must keep using `omc team api ...` lifecycle and mailbox operations against the team-specific coordination root. They must not create or mutate a separate local `.omc/state` inside their worker worktree when `OMC_TEAM_STATE_ROOT` is available; for worktree-backed workers it should point at `<repo>/.omc/state/team/<team-name>`.

OMX-compatible aliases may be accepted at explicit interop boundaries for migrated workers, but OMC sessions should prefer OMC variables when both are present. Documentation, prompts, tests, and status output should present `omc team api` as the primary control surface unless a mixed-runtime compatibility mode is explicitly being described.

## Persisted fields

Config, manifest, worker identity, and status surfaces should expose the same locked field set so resume/status/bootstrap paths can reason about worker location without inference:

- `workspace_mode`
- `worktree_mode`
- `team_state_root`
- `working_dir`
- `worktree_repo_root`
- `worktree_path`
- `worktree_branch`
- `worktree_detached`
- `worktree_created`

`workspace_mode` should be `worktree` for worktree-backed sessions and `single` for the existing shared-workspace behavior. `team_state_root` means the team-specific coordination root (`<repo>/.omc/state/team/<team-name>`); if a future feature needs the broader `.omc/state` base, use a separately named field such as `state_base_root`.

## Safety rules

- OMC must check the leader workspace before provisioning worktrees. If the leader repo is dirty, startup should refuse worktree provisioning rather than copying an unsafe base state.
- Existing compatible clean worker worktrees may be reused.
- Dirty worker worktrees must be preserved and surfaced as warnings/events. Cleanup must not force-remove dirty worker edits.
- Branch/path mismatches should fail instead of reusing the wrong workspace.
- Rollback may remove newly created clean worktrees and runtime-created branches when safe; reused worktrees are preserved.
- `orphan-cleanup` is a destructive escape hatch that may delete worktree recovery metadata and root `AGENTS.md` backups. When that evidence exists, callers must pass `acknowledge_lost_worktree_recovery: true` only after manually preserving or intentionally discarding the affected worker worktrees/backups.

## CLI and status expectations

`omc team status <team-name> --json` should make the workspace contract observable. JSON consumers should be able to find `workspace_mode`, `worktree_mode`, `team_state_root`, and each worker's worktree metadata without reading private files directly.

Human status output should also surface the mode and worktree path/branch details enough for users to understand where worker changes live and whether cleanup preserved a dirty worktree.

## Backport parity matrix

Use this compact matrix when reviewing OMX-team behavior that is adapted into OMC. Update the evidence column in PR notes when a row changes.

| Behavior slice                    | OMC contract to preserve                                                                                                                                         | Compatibility risk                                                                         | Required evidence                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Task lifecycle                    | Claim, transition, and release operations use bare task IDs through `omc team api`; task files remain `tasks/task-<id>.json` under `.omc/state/team/<team-name>` | Source imports may assume `.omx/state` or bypass claim tokens                              | Task lifecycle and locking tests, plus structured `transition-task-status` results       |
| Mailbox and dispatch              | Mailbox delivery/notified state and dispatch requests stay under the team-specific OMC coordination root                                                         | Worker nudges can accidentally append `team/<name>` twice or address a local worktree root | Mailbox/API, dispatch hook, and worktree trigger-path tests                              |
| Event, summary, and monitor state | API envelopes stay stable: `schema_version`, `timestamp`, `command`, `ok`, `operation`, and `data` or `error`                                                    | Partial API parity can expose source-like operations without target-side state semantics   | Field-level API tests or an intentional rejection note for unsupported source operations |
| State-root resolution             | `OMC_TEAM_STATE_ROOT` is authoritative for OMC workers; `.omx`/`OMX_*` is compatibility-only                                                                     | Inherited OMX env can silently switch CLI hints or state roots                             | Command-dialect and cwd-resolution tests with both OMC and OMX contexts                  |
| Worker launch and model args      | OMC binary validation, CLI selection, launch-arg normalization, and role reasoning rules remain in force                                                         | Wholesale source launch code can weaken binary/path safety or model precedence             | Model-contract, runtime-v2 startup, tmux, and scaling launch tests                       |
| Shutdown and cleanup              | Shutdown gates active work, preserves dirty worktrees, and cleans only the target team root                                                                      | Source cleanup semantics can remove sibling teams or dirty worker edits                    | Shutdown, cleanup, worktree safety, and status-count tests                               |

## Verification checklist for changes

Use the source PRD/test-spec checklist when modifying this area. At minimum, changes should cover:

1. Worktree planning disabled/no-op and active path modes.
2. Fresh, reused, dirty, and mismatched worktree lifecycle cases.
3. Runtime-v2 startup/spawn state: worker cwd, env, config, manifest, and identity all agree.
4. Bootstrap prompts and trigger paths use `$OMC_TEAM_STATE_ROOT` for worktree-backed workers.
5. Scale-up workers inherit the same team-specific coordination root and worktree instruction strategy.
6. Shutdown/cleanup removes safe clean worktrees, preserves dirty ones, and reports warnings.
7. CLI help/status tests cover the opt-in rollout and locked status field set.

Recommended focused commands:

```bash
npm test -- --run src/team/__tests__/git-worktree.test.ts
npm test -- --run src/team/__tests__/worker-bootstrap.test.ts
npm test -- --run src/team/__tests__/runtime-v2.dispatch.test.ts
npm test -- --run src/team/__tests__/runtime-v2.shutdown.test.ts
npm test -- --run src/team/__tests__/api-interop.dispatch.test.ts
npm test -- --run src/team/__tests__/api-interop.cwd-resolution.test.ts
npm test -- --run src/team/__tests__/scaling-launch-config.test.ts
npm test -- --run src/cli/__tests__/team-runtime-boundary.test.ts
npm run build
```

## Review notes

- Keep the first slice narrow: runtime-v2 startup/spawn/dispatch/scale-up/resume/status/shutdown/cleanup plus legacy read/cleanup compatibility.
- Do not reduce scope by omitting status visibility, dirty-worktree preservation, or team-specific coordination-root behavior; those are part of the locked contract.
- Prefer explicit persisted fields over reconstructing worktree state from paths or branch names.
