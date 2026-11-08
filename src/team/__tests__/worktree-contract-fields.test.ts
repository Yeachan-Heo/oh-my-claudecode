import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { readTeamConfig, saveTeamConfig } from '../monitor.js';
import { teamWriteWorkerIdentity } from '../team-ops.js';
import type { TeamConfig, TeamManifestV2, WorkerInfo } from '../types.js';

function isolateFixtureRoot(cwd: string): () => void {
  const home = process.env.HOME;
  const userProfile = process.env.USERPROFILE;
  const stateDir = process.env.OMC_STATE_DIR;
  process.env.HOME = cwd;
  process.env.USERPROFILE = cwd;
  delete process.env.OMC_STATE_DIR;
  return () => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userProfile;
    if (stateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = stateDir;
  };
}

describe('native worktree contract fields', () => {
  it('persists and reads the locked config/manifest worker worktree field set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-worktree-contract-'));
    const restoreEnv = isolateFixtureRoot(cwd);
    const worker: WorkerInfo = {
      name: 'worker-1',
      index: 1,
      role: 'executor',
      assigned_tasks: ['1'],
      working_dir: join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
      worktree_repo_root: resolve(cwd),
      worktree_path: join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
      worktree_branch: 'omc-team/demo-team/worker-1',
      worktree_detached: false,
      worktree_created: true,
      team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
    };
    const config: TeamConfig = {
      name: 'demo-team',
      task: 'demo',
      agent_type: 'codex',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [worker],
      created_at: new Date().toISOString(),
      tmux_session: 'demo-session',
      next_task_id: 2,
      leader_cwd: cwd,
      team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
      workspace_mode: 'worktree',
      worktree_mode: 'named',
      leader_pane_id: '%0',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    };

    try {
      await saveTeamConfig(config, cwd);
      const readBack = await readTeamConfig('demo-team', cwd);

      expect(readBack).toMatchObject({
        workspace_mode: 'worktree',
        worktree_mode: 'named',
        team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
        workers: [expect.objectContaining({
          working_dir: worker.worktree_path,
          worktree_repo_root: resolve(cwd),
          worktree_path: worker.worktree_path,
          worktree_branch: 'omc-team/demo-team/worker-1',
          worktree_detached: false,
          worktree_created: true,
          team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
        })],
      });
    } finally {
      restoreEnv();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves worktree_mode when normalizing a manifest-only team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-worktree-manifest-'));
    const restoreEnv = isolateFixtureRoot(cwd);
    const worker: WorkerInfo = {
      name: 'worker-1',
      index: 1,
      role: 'executor',
      assigned_tasks: [],
      working_dir: join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
      worktree_repo_root: resolve(cwd),
      worktree_path: join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
      worktree_branch: 'omc-team/demo-team/worker-1',
      worktree_detached: true,
      worktree_created: false,
      team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
    };
    const manifest: TeamManifestV2 = {
      schema_version: 2,
      name: 'demo-team',
      task: 'demo',
      leader: { session_id: 'demo-session', worker_id: 'leader-fixed', role: 'leader' },
      policy: {
        display_mode: 'split_pane',
        worker_launch_mode: 'interactive',
        dispatch_mode: 'hook_preferred_with_fallback',
        dispatch_ack_timeout_ms: 30_000,
      },
      governance: {
        delegation_only: false,
        plan_approval_required: false,
        nested_teams_allowed: false,
        one_team_per_leader_session: false,
        cleanup_requires_all_workers_inactive: true,
      },
      permissions_snapshot: { approval_mode: 'default', sandbox_mode: 'default', network_access: false },
      tmux_session: 'demo-session',
      worker_count: 1,
      workers: [worker],
      next_task_id: 1,
      created_at: new Date().toISOString(),
      leader_cwd: cwd,
      team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
      workspace_mode: 'worktree',
      worktree_mode: 'detached',
      leader_pane_id: '%0',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    };

    try {
      const { mkdir, writeFile } = await import('fs/promises');
      await mkdir(join(cwd, '.omc', 'state', 'team', 'demo-team'), { recursive: true });
      await writeFile(join(cwd, '.omc', 'state', 'team', 'demo-team', 'manifest.json'), JSON.stringify(manifest, null, 2));

      const readBack = await readTeamConfig('demo-team', cwd);
      expect(readBack?.workspace_mode).toBe('worktree');
      expect(readBack?.worktree_mode).toBe('detached');
      expect(readBack?.workers[0]).toMatchObject({
        worktree_repo_root: resolve(cwd),
        worktree_created: false,
      });
    } finally {
      restoreEnv();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('worker identity persistence accepts the full worktree metadata payload', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-worktree-identity-'));
    const restoreEnv = isolateFixtureRoot(cwd);
    try {
      await teamWriteWorkerIdentity('demo-team', 'worker-1', {
        name: 'worker-1',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        working_dir: join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
        worktree_repo_root: resolve(cwd),
        worktree_path: join(cwd, '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
        worktree_branch: 'omc-team/demo-team/worker-1',
        worktree_detached: false,
        worktree_created: true,
        team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
      }, cwd);

      const identity = JSON.parse(await readFile(join(cwd, '.omc', 'state', 'team', 'demo-team', 'workers', 'worker-1', 'identity.json'), 'utf-8')) as WorkerInfo;
      expect(identity).toMatchObject({
        worktree_repo_root: resolve(cwd),
        worktree_branch: 'omc-team/demo-team/worker-1',
        worktree_created: true,
      });
    } finally {
      restoreEnv();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
