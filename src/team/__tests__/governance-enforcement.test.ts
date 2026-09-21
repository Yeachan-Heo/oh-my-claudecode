import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { getOmcRoot } from '../../lib/worktree-paths.js';

const tmuxMocks = vi.hoisted(() => {
  const tmuxServerIdentity = {
    socket_path: '/tmp/omc-test-tmux.sock',
    server_pid: 4242,
    process_started_at: process.platform === 'darwin'
      ? 'darwin:1700000000:123456'
      : 'linux:01234567-89ab-cdef-0123-456789abcdef:424242',
  };
  return {
    tmuxServerIdentity,
    observeTmuxServerIdentity: vi.fn(async () => 'matching' as const),
    getOwnedWorkerLiveness: vi.fn(async () => 'dead' as const),
    observeTeamSessionTargetPresence: vi.fn(async () => ({ kind: 'owned' as const })),
    workerPaneBelongsToOwnedProviderTarget: vi.fn(async () => true),
    killOwnedWorkerPane: vi.fn(async () => undefined),
    killTeamSession: vi.fn(async () => true),
  };
});

vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    observeTmuxServerIdentity: tmuxMocks.observeTmuxServerIdentity,
    getOwnedWorkerLiveness: tmuxMocks.getOwnedWorkerLiveness,
    observeTeamSessionTargetPresence: tmuxMocks.observeTeamSessionTargetPresence,
    workerPaneBelongsToOwnedProviderTarget: tmuxMocks.workerPaneBelongsToOwnedProviderTarget,
    killOwnedWorkerPane: tmuxMocks.killOwnedWorkerPane,
    killTeamSession: tmuxMocks.killTeamSession,
  };
});

import { shutdownTeamV2 } from '../runtime-v2.js';
import { teamClaimTask } from '../team-ops.js';
import { activateTeamInstanceUnderLock, createTeamInstanceBinding, reserveTeamInstance, withTeamInstanceLifecycleLock } from '../team-instance.js';

describe('team governance enforcement', () => {
  let cwd: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousOmcStateDir: string | undefined;

  function teamStatePath(teamName: string, ...segments: string[]): string {
    return join(getOmcRoot(cwd), 'state', 'team', teamName, ...segments);
  }

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-governance-enforcement-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousOmcStateDir = process.env.OMC_STATE_DIR;
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    delete process.env.OMC_STATE_DIR;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = previousOmcStateDir;
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
  }

  it('blocks claiming code-change tasks until approval is granted when governance requires it', async () => {
    const teamName = 'approval-team';
    await writeJson(teamStatePath(teamName, 'config.json'), {
      name: teamName,
      state_revision: 2,
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
    await writeJson(teamStatePath(teamName, 'manifest.json'), {
      schema_version: 2,
      name: teamName,
      state_revision: 1,
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
    await writeJson(teamStatePath(teamName, 'tasks', 'task-1.json'), {
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

    await writeJson(teamStatePath(teamName, 'approvals', '1.json'), {
      task_id: '1',
      required: true,
      status: 'approved',
      reviewer: 'leader-fixed',
      decision_reason: 'approved',
      decided_at: new Date().toISOString(),
    });

    const previousAttemptId = process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID;
    process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID = 'attempt-current';
    try {
      const claimed = await teamClaimTask(teamName, '1', 'worker-1', null, cwd);
      expect(claimed.ok).toBe(true);
      const task = JSON.parse(await readFile(teamStatePath(teamName, 'tasks', 'task-1.json'), 'utf-8'));
      expect(task.claim?.launch_attempt_id).toBe('attempt-current');
    } finally {
      if (previousAttemptId === undefined) delete process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID;
      else process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID = previousAttemptId;
    }
  });

  it('allows shutdown cleanup override when governance disables inactive-worker requirement', async () => {
    const teamName = 'cleanup-team';
    const binding = createTeamInstanceBinding({ teamName, cwd });
    await reserveTeamInstance({ teamName, cwd, instanceId: binding.instance_id });
    await writeJson(teamStatePath(teamName, 'config.json'), {
      name: teamName,
      instance_id: binding.instance_id,
      leader_cwd: binding.cwd,
      team_state_root: binding.state_root,
      state_revision: 0,
      lifecycle_state: 'active',
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
      tmux_session: `${teamName}:0`,
      tmux_server_identity: tmuxMocks.tmuxServerIdentity,
      next_task_id: 2,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });
    await writeJson(teamStatePath(teamName, 'tasks', 'task-1.json'), {
      id: '1',
      subject: 'still pending',
      description: 'pending',
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    await withTeamInstanceLifecycleLock(cwd, teamName, () => activateTeamInstanceUnderLock(binding));
    await expect(shutdownTeamV2(teamName, cwd, { instanceId: binding.instance_id })).resolves.toEqual({ outcome: 'cleaned' });
  });
});
