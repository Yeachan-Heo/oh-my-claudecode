# Native Team Worktree Mode

Native team worktree mode is the opt-in rollout path for running `omc team` workers in dedicated git worktrees while keeping one leader-owned team-specific coordination root. It is intended for runtime-v2 team sessions and is designed to make worker edits isolated without fragmenting task, mailbox, status, or manifest state.

## Availability

- The rollout is **opt-in / config-gated** for the first slice. Do not assume worktree mode is the default behavior.
- The target runtime is `runtime-v2`. Legacy `runtime.ts` remains limited to read/status and cleanup compatibility unless a later plan explicitly expands it.
- No new dependency is required; lifecycle operations use git worktrees plus the existing team CLI/API surfaces.

## Workspace contract

When worktree mode is active, OMC uses this stable layout:

| Field | Contract |
| --- | --- |
| Worktree root | `<repo>/.omc/team/<team-name>/worktrees/<worker-name>` |
| Team-specific coordination root | `<repo>/.omc/state/team/<team-name>` in the leader workspace |
| Worker cwd | The worker's `worktree_path` |
| Worker coordination | `OMC_TEAM_STATE_ROOT` points back to the team-specific leader-owned coordination root |
| Worker instructions | Worktree-root `AGENTS.md` is installed with backup/restore safeguards |

Workers must keep using `omc team api ...` lifecycle and mailbox operations against the team-specific coordination root. They must not create or mutate a separate local `.omc/state` inside their worker worktree when `OMC_TEAM_STATE_ROOT` is available; for worktree-backed workers it should point at `<repo>/.omc/state/team/<team-name>`.

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
- `orphan-cleanup` requires the same instance, provider, pane, and worktree cleanup evidence as normal shutdown. Neither force nor `acknowledge_lost_worktree_recovery` permits deleting unknown ownership records or worktree recovery backups.

## CLI and status expectations

`omc team status <team-name> --json` should make the workspace contract observable. JSON consumers should be able to find `workspace_mode`, `worktree_mode`, `team_state_root`, and each worker's worktree metadata without reading private files directly.

Human status output should also surface the mode and worktree path/branch details enough for users to understand where worker changes live and whether cleanup preserved a dirty worktree.

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
