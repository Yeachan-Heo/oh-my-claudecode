import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTeamConfig } from '../monitor.js';
import { teamReadConfig } from '../team-ops.js';
import type { TeamConfig, TeamManifestV2 } from '../types.js';

describe('team max_workers config readers', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-team-max-workers-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeTeamState(maxWorkers: number): Promise<void> {
    const root = join(cwd, '.omc', 'state', 'team', 'max-team');
    await mkdir(root, { recursive: true });
    const common = {
      name: 'max-team',
      task: 'demo',
      worker_count: 2,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
      ],
      next_task_id: 2,
      created_at: new Date().toISOString(),
      leader_cwd: cwd,
      team_state_root: root,
      leader_pane_id: '%0',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    };
    const config: TeamConfig = {
      ...common,
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      max_workers: maxWorkers,
      tmux_session: 'max-team:0',
    };
    const manifest: TeamManifestV2 = {
      ...common,
      schema_version: 2,
      leader: { session_id: 'max-team:0', worker_id: 'leader-fixed', role: 'leader' },
      policy: {
        display_mode: 'split_pane',
        worker_launch_mode: 'interactive',
        dispatch_mode: 'hook_preferred_with_fallback',
        dispatch_ack_timeout_ms: 15_000,
      },
      governance: {
        delegation_only: false,
        plan_approval_required: false,
        nested_teams_allowed: false,
        one_team_per_leader_session: true,
        cleanup_requires_all_workers_inactive: true,
      },
      permissions_snapshot: {
        approval_mode: 'default',
        sandbox_mode: 'workspace-write',
        network_access: false,
      },
      tmux_session: 'max-team:0',
      max_workers: maxWorkers,
    };

    await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2));
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  it('preserves configured max_workers below the legacy default in monitor reads', async () => {
    await writeTeamState(2);

    await expect(readTeamConfig('max-team', cwd)).resolves.toMatchObject({
      max_workers: 2,
      worker_count: 2,
    });
  });

  it('preserves configured max_workers below the legacy default in team ops reads', async () => {
    await writeTeamState(2);

    await expect(teamReadConfig('max-team', cwd)).resolves.toMatchObject({
      max_workers: 2,
      worker_count: 2,
    });
  });
});

