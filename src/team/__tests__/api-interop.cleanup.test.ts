import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOmcRoot } from '../../lib/worktree-paths.js';

const { shutdownTeamV2Mock } = vi.hoisted(() => ({
  shutdownTeamV2Mock: vi.fn(async () => ({ outcome: 'cleaned' as const })),
}));

vi.mock('../runtime-v2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime-v2.js')>();
  return {
    ...actual,
    shutdownTeamV2: shutdownTeamV2Mock,
  };
});

import { executeTeamApiOperation } from '../api-interop.js';

function isolateFixtureRoot(root: string): () => void {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOmcStateDir = process.env.OMC_STATE_DIR;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.OMC_STATE_DIR;

  return () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = previousOmcStateDir;
  };
}

function teamStatePath(cwd: string, teamName: string, ...segments: string[]): string {
  return join(getOmcRoot(cwd), 'state', 'team', teamName, ...segments);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function writeText(root: string, relativePath: string, value: string): Promise<void> {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf-8');
}

async function expectCleanupBlockedAndStatePreserved(cwd: string, teamName: string, evidencePath: string): Promise<void> {
  const teamRoot = teamStatePath(cwd, teamName);

  const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected cleanup to be blocked');
  expect(result.error.code).toBe('operation_failed');
  expect(result.error.message).toContain('cleanup_blocked:worktree_cleanup_evidence_present');
  await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
  await expect(readFile(evidencePath, 'utf-8')).resolves.toBeTruthy();
  expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
}

describe('team api cleanup', () => {
  const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
  let cwd = '';
  let restoreFixtureEnv: (() => void) | undefined;

  afterEach(async () => {
    shutdownTeamV2Mock.mockClear();
    restoreFixtureEnv?.();
    restoreFixtureEnv = undefined;
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = '';
    }
  });

  it('routes cleanup through runtime-v2 shutdown when a v2 team config exists', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-v2-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-v2';
    await writeJson(teamStatePath(cwd, teamName, 'config.json'), {
      name: teamName,
      instance_id: INSTANCE_A,
      task: 'test',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      governance: {
        delegation_only: false,
        plan_approval_required: false,
        nested_teams_allowed: false,
        one_team_per_leader_session: true,
        cleanup_requires_all_workers_inactive: true,
      },
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: '',
      next_task_id: 1,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });

    const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);

    expect(result).toEqual({ ok: true, operation: 'cleanup', data: { team_name: teamName } });
    expect(shutdownTeamV2Mock).toHaveBeenCalledWith(teamName, cwd, { instanceId: INSTANCE_A });
  });

  it('surfaces shutdown gate failures instead of deleting team state directly', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-gated-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-gated';
    const teamRoot = teamStatePath(cwd, teamName);

    await writeJson(teamStatePath(cwd, teamName, 'config.json'), {
      name: teamName,
      instance_id: INSTANCE_A,
      task: 'test',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      governance: {
        delegation_only: false,
        plan_approval_required: false,
        nested_teams_allowed: false,
        one_team_per_leader_session: true,
        cleanup_requires_all_workers_inactive: true,
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
    await writeJson(teamStatePath(cwd, teamName, 'tasks', 'task-1.json'), {
      id: '1',
      subject: 'pending work',
      description: 'still pending',
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    shutdownTeamV2Mock.mockImplementationOnce(async () => {
      throw new Error('shutdown_gate_blocked:pending=1,blocked=0,in_progress=0,failed=0');
    });

    const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('operation_failed');
    expect(result.error.message).toContain('shutdown_gate_blocked');
    await expect(readFile(join(teamRoot, 'config.json'), 'utf-8')).resolves.toContain(teamName);
    expect(shutdownTeamV2Mock).toHaveBeenCalledWith(teamName, cwd, { instanceId: INSTANCE_A });
  });

  it('preserves state when provider cleanup cannot be verified', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-provider-unverified-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-provider-unverified';
    const teamRoot = teamStatePath(cwd, teamName);
    await writeJson(teamStatePath(cwd, teamName, 'config.json'), {
      name: teamName,
      instance_id: INSTANCE_A,
      task: 'test',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, pane_id: '%1', launch_attempt_id: 'attempt-1' }],
      created_at: new Date().toISOString(),
      tmux_session: 'cleanup-provider-unverified:0',
      next_task_id: 1,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
    shutdownTeamV2Mock.mockResolvedValueOnce({
      outcome: 'preserved',
      reason: 'provider_cleanup_unverified',
      workers: ['worker-1'],
    } as never);

    const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected provider cleanup to be preserved');
    expect(result.error.code).toBe('operation_failed');
    expect(result.error.message).toContain('team_shutdown_preserved:provider_cleanup_unverified');
    await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
    expect(shutdownTeamV2Mock).toHaveBeenCalledWith(teamName, cwd, { instanceId: INSTANCE_A });
  });

  it('preserves legacy cleanup state without invoking the retired shutdown path', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-legacy-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-legacy';
    const teamRoot = teamStatePath(cwd, teamName);
    await writeJson(join(teamRoot, 'config.json'), {
      name: teamName,
      agentTypes: ['codex'],
      tmuxSession: `${teamName}:0`,
      workers: [],
    });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');

    const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected legacy cleanup to preserve state');
    expect(result.error.code).toBe('operation_failed');
    expect(result.error.message).toContain('team_shutdown_preserved:config_cleanup_unsupported');
    await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
    expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
  });

  it('preserves V2-shaped state when its immutable instance identity is missing', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-missing-instance-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-missing-instance';
    const teamRoot = teamStatePath(cwd, teamName);
    await writeJson(join(teamRoot, 'config.json'), {
      name: teamName,
      task: 'test',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: '',
      next_task_id: 1,
    });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');

    const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected missing instance identity to preserve state');
    expect(result.error.code).toBe('operation_failed');
    expect(result.error.message).toContain('team_shutdown_preserved:instance_identity_missing');
    await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
    expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
  });

  it('preserves orphaned team state when no authoritative config exists', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-orphan-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-orphan';
    const teamRoot = teamStatePath(cwd, teamName);
    await mkdir(join(teamRoot, 'tasks'), { recursive: true });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');

    const result = await executeTeamApiOperation('cleanup', { team_name: teamName }, cwd);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected cleanup to preserve unknown authority');
    expect(result.error.code).toBe('operation_failed');
    expect(result.error.message).toContain('team_shutdown_preserved:config_missing_cleanup_evidence');
    await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
    expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
  });

  it('routes acknowledged orphan-cleanup through the instance-bound V2 protocol', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-orphan-cleanup-v2-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'orphan-cleanup-v2';
    await writeJson(teamStatePath(cwd, teamName, 'config.json'), {
      name: teamName,
      instance_id: INSTANCE_A,
      task: 'test',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: '',
      next_task_id: 1,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });

    const result = await executeTeamApiOperation('orphan-cleanup', {
      team_name: teamName,
      acknowledge_lost_worktree_recovery: true,
    }, cwd);

    expect(result).toEqual({ ok: true, operation: 'orphan-cleanup', data: { team_name: teamName } });
    expect(shutdownTeamV2Mock).toHaveBeenCalledWith(teamName, cwd, {
      instanceId: INSTANCE_A,
      force: true,
      timeoutMs: 0,
    });
  });

  it('blocks orphan-cleanup when worktree recovery evidence exists without explicit acknowledgement', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-orphan-cleanup-guard-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'orphan-cleanup-guard';
    const teamRoot = teamStatePath(cwd, teamName);
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
    const backupPath = join(teamRoot, 'workers', 'worker-1', 'worktree-root-agents.json');
    await writeJson(teamStatePath(cwd, teamName, 'workers', 'worker-1', 'worktree-root-agents.json'), {
      worktreePath: join(cwd, '.omc-worktrees', `${teamName}-worker-1`),
      hadOriginal: false,
      installedContent: 'worker overlay',
      installedAt: new Date().toISOString(),
    });

    const result = await executeTeamApiOperation('orphan-cleanup', { team_name: teamName }, cwd);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected orphan-cleanup to be blocked');
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toContain('orphan_cleanup_blocked:worktree_recovery_evidence_present');
    await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
    await expect(readFile(backupPath, 'utf-8')).resolves.toBeTruthy();
    expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
  });

  it('preserves acknowledged orphan-cleanup when no authoritative config exists', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-orphan-cleanup-ack-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'orphan-cleanup-ack';
    const teamRoot = teamStatePath(cwd, teamName);
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
    await writeJson(teamStatePath(cwd, teamName, 'workers', 'worker-1', 'worktree-root-agents.json'), {
      worktreePath: join(cwd, '.omc-worktrees', `${teamName}-worker-1`),
      hadOriginal: false,
      installedContent: 'worker overlay',
      installedAt: new Date().toISOString(),
    });

    const result = await executeTeamApiOperation('orphan-cleanup', {
      team_name: teamName,
      acknowledge_lost_worktree_recovery: true,
    }, cwd);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected orphan-cleanup to preserve unknown authority');
    expect(result.error.code).toBe('operation_failed');
    expect(result.error.message).toContain('cleanup_blocked:worktree_cleanup_evidence_present');
    await expect(readFile(join(teamRoot, 'orphan.txt'), 'utf-8')).resolves.toBe('stale');
    expect(shutdownTeamV2Mock).not.toHaveBeenCalled();
  });

  it('blocks no-config cleanup when worktree metadata is unreadable', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-corrupt-worktrees-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-corrupt-worktrees';
    const teamRoot = teamStatePath(cwd, teamName);
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
    const metadataPath = join(teamRoot, 'worktrees.json');
    await writeFile(metadataPath, '{not-json', 'utf-8');

    await expectCleanupBlockedAndStatePreserved(cwd, teamName, metadataPath);
  });

  it('blocks no-config cleanup when only a root AGENTS backup remains', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-backup-only-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-backup-only';
    const teamRoot = teamStatePath(cwd, teamName);
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
    const backupPath = join(teamRoot, 'workers', 'worker-1', 'worktree-root-agents.json');
    await writeJson(teamStatePath(cwd, teamName, 'workers', 'worker-1', 'worktree-root-agents.json'), {
      worktreePath: join(cwd, '.omc-worktrees', `${teamName}-worker-1`),
      hadOriginal: true,
      originalContent: 'root agents',
      installedContent: 'worker overlay',
      installedAt: new Date().toISOString(),
    });

    await expectCleanupBlockedAndStatePreserved(cwd, teamName, backupPath);
  });

  it('blocks corrupt-config cleanup when native worktree recovery evidence exists', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-api-cleanup-corrupt-config-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
    const teamName = 'cleanup-corrupt-config';
    const teamRoot = teamStatePath(cwd, teamName);
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'orphan.txt'), 'stale', 'utf-8');
    await writeText(cwd, `.omc/state/team/${teamName}/config.json`, '{bad-config');
    const metadataPath = join(teamRoot, 'worktrees.json');
    await writeJson(teamStatePath(cwd, teamName, 'worktrees.json'), [{
      workerName: 'worker-1',
      path: join(cwd, '.omc-worktrees', `${teamName}-worker-1`),
      branch: `omc/${teamName}/worker-1`,
      createdAt: new Date().toISOString(),
    }]);

    await expectCleanupBlockedAndStatePreserved(cwd, teamName, metadataPath);
  });
});
