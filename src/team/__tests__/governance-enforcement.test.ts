import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

import { shutdownTeamV2 } from '../runtime-v2.js';
import { teamClaimTask } from '../team-ops.js';

describe('team governance enforcement', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-governance-enforcement-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeJson(relativePath: string, value: unknown): Promise<void> {
    const fullPath = join(cwd, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
  }

  it('blocks claiming code-change tasks until approval is granted when governance requires it', async () => {
    const teamName = 'approval-team';
    await writeJson(`.omc/state/team/${teamName}/config.json`, {
      name: teamName,
      task: 'test',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      governance: {
        delegation_only: false,
        plan_approval_required: true,
        nested_teams_allowed: false,
        one_team_per_leader_session: true,
        cleanup_requires_all_workers_inactive: true,
      },
      worker_count: 1,
      max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
      created_at: new Date().toISOString(),
      tmux_session: 'approval-session',
      next_task_id: 2,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });
    await writeJson(`.omc/state/team/${teamName}/manifest.json`, {
      schema_version: 2,
      name: teamName,
      task: 'test',
      leader: { session_id: 's1', worker_id: 'leader-fixed', role: 'leader' },
      policy: {
        display_mode: 'split_pane',
        worker_launch_mode: 'interactive',
        dispatch_mode: 'hook_preferred_with_fallback',
        dispatch_ack_timeout_ms: 15000,
      },
      governance: {
        delegation_only: false,
        plan_approval_required: true,
        nested_teams_allowed: false,
        one_team_per_leader_session: true,
        cleanup_requires_all_workers_inactive: true,
      },
      permissions_snapshot: {
        approval_mode: 'default',
        sandbox_mode: 'workspace-write',
        network_access: false,
      },
      tmux_session: 'approval-session',
      worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
      next_task_id: 2,
      created_at: new Date().toISOString(),
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });
    await writeJson(`.omc/state/team/${teamName}/tasks/task-1.json`, {
      id: '1',
      subject: 'approved work',
      description: 'requires approval',
      status: 'pending',
      requires_code_change: true,
      created_at: new Date().toISOString(),
    });

    const blocked = await teamClaimTask(teamName, '1', 'worker-1', null, cwd);
    expect(blocked).toEqual({
      ok: false,
      error: 'blocked_dependency',
      dependencies: ['approval-required'],
    });

    await writeJson(`.omc/state/team/${teamName}/approvals/1.json`, {
      task_id: '1',
      required: true,
      status: 'approved',
      reviewer: 'leader-fixed',
      decision_reason: 'approved',
      decided_at: new Date().toISOString(),
    });

    const claimed = await teamClaimTask(teamName, '1', 'worker-1', null, cwd);
    expect(claimed.ok).toBe(true);
  });

  it('allows shutdown cleanup override when governance disables inactive-worker requirement', async () => {
    const teamName = 'cleanup-team';
    await writeJson(`.omc/state/team/${teamName}/config.json`, {
      name: teamName,
      task: 'test',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      governance: {
        delegation_only: false,
        plan_approval_required: false,
        nested_teams_allowed: false,
        one_team_per_leader_session: true,
        cleanup_requires_all_workers_inactive: false,
      },
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: '',
      next_task_id: 2,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });
    await writeJson(`.omc/state/team/${teamName}/tasks/task-1.json`, {
      id: '1',
      subject: 'still pending',
      description: 'pending',
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    await expect(shutdownTeamV2(teamName, cwd)).resolves.toBeUndefined();
  });
});
