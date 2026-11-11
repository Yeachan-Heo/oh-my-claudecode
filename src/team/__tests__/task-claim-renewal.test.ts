import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const environmentIsolation = await vi.hoisted(async () => {
  const [{ mkdtempSync }, { join: pathJoin }, { tmpdir: osTmpdir }] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:os'),
  ]);
  const previous = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    stateDir: process.env.OMC_STATE_DIR,
  };
  const root = mkdtempSync(pathJoin(osTmpdir(), 'omc-task-claim-renewal-import-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.OMC_STATE_DIR = pathJoin(root, 'state');
  return { previous, root };
});

import { getOmcRoot } from '../../lib/worktree-paths.js';
import {
  teamClaimTask,
  teamCreateTask,
  teamRenewTaskClaim,
  teamTransitionTaskStatus,
} from '../team-ops.js';
import type { TeamTask } from '../types.js';

const teamName = 'claim-renewal-team';
const timestamp = '2026-09-10T00:00:00.000Z';

function teamRoot(cwd: string): string {
  return join(getOmcRoot(cwd), 'state', 'team', teamName);
}

function taskPath(cwd: string, taskId: string): string {
  return join(teamRoot(cwd), 'tasks', `task-${taskId}.json`);
}

function task(
  id: string,
  status: TeamTask['status'] = 'pending',
  overrides: Partial<TeamTask> = {},
): TeamTask {
  return {
    id,
    subject: `Task ${id}`,
    description: `Description for ${id}`,
    status,
    created_at: timestamp,
    version: 1,
    ...overrides,
  };
}

async function writeTask(cwd: string, value: TeamTask): Promise<void> {
  const tasksDir = join(teamRoot(cwd), 'tasks');
  await mkdir(tasksDir, { recursive: true });
  await writeFile(join(tasksDir, `task-${value.id}.json`), JSON.stringify(value, null, 2), 'utf8');
}

async function writeTeamConfig(cwd: string): Promise<void> {
  await mkdir(teamRoot(cwd), { recursive: true });
  await writeFile(join(teamRoot(cwd), 'config.json'), JSON.stringify({
    name: teamName,
    task: 'claim renewal',
    agent_type: 'claude',
    worker_launch_mode: 'interactive',
    worker_count: 2,
    max_workers: 20,
    workers: [
      { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
      { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
    ],
    created_at: timestamp,
    tmux_session: `${teamName}:0`,
    next_task_id: 1,
    leader_pane_id: null,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    lifecycle_state: 'active',
  }, null, 2), 'utf8');
}

describe('teamRenewTaskClaim', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-claim-renewal-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env.HOME = environmentIsolation.previous.home;
    process.env.USERPROFILE = environmentIsolation.previous.userProfile;
    process.env.OMC_STATE_DIR = environmentIsolation.previous.stateDir;
  });

  it('extends the lease of a live claim so a long task can still complete', async () => {
    await writeTeamConfig(cwd);
    await teamCreateTask(teamName, { subject: 'Long task', description: 'runs longer than the lease', status: 'pending' }, cwd);
    const claimed = await teamClaimTask(teamName, 'task-1', 'worker-1', null, cwd);
    if (!claimed.ok) throw new Error(`claim failed: ${claimed.error}`);
    const originalLease = Date.parse(claimed.task.claim!.leased_until);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // one minute before the original lease dies: renew extends the window
      vi.setSystemTime(originalLease - 60_000);
      const renewed = await teamRenewTaskClaim(teamName, 'task-1', claimed.claimToken, 'worker-1', cwd);
      expect(renewed.ok).toBe(true);
      if (renewed.ok) {
        const renewedLease = Date.parse(renewed.task.claim!.leased_until);
        expect(renewedLease).toBeGreaterThan(originalLease);
        // completion after the original 15-minute deadline now succeeds
        vi.setSystemTime(originalLease + 60_000);
        const completed = await teamTransitionTaskStatus(teamName, 'task-1', 'in_progress', 'completed', claimed.claimToken, cwd);
        expect(completed).toEqual({ ok: true, task: expect.objectContaining({ status: 'completed' }) });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the task version and persists the new lease under the claim lock', async () => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'in_progress', {
      owner: 'worker-1',
      version: 7,
      claim: { owner: 'worker-1', token: 'token-1', leased_until: new Date(Date.now() + 60_000).toISOString() },
    }));
    const renewed = await teamRenewTaskClaim(teamName, 'task-1', 'token-1', 'worker-1', cwd);
    expect(renewed.ok).toBe(true);
    if (renewed.ok) {
      expect(renewed.task.version).toBe(7);
      const onDisk = JSON.parse(await readFile(taskPath(cwd, '1'), 'utf8')) as TeamTask;
      expect(onDisk.version).toBe(7);
      expect(Date.parse((onDisk.claim as { leased_until: string }).leased_until))
        .toBeGreaterThan(Date.now() + 14 * 60_000);
    }
  });

  it.each([
    ['expired lease', '2000-01-01T00:00:00.000Z', 'token-1', 'worker-1', 'lease_expired'],
    ['wrong token', '2099-01-01T00:00:00.000Z', 'wrong-token', 'worker-1', 'claim_conflict'],
    ['wrong worker', '2099-01-01T00:00:00.000Z', 'token-1', 'worker-2', 'claim_conflict'],
  ] as const)('rejects renewal for %s without rewriting the task', async (_label, leasedUntil, claimToken, worker, expectedError) => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'in_progress', {
      owner: 'worker-1',
      claim: { owner: 'worker-1', token: 'token-1', leased_until: leasedUntil },
    }));
    const before = await readFile(taskPath(cwd, '1'), 'utf8');

    const result = await teamRenewTaskClaim(teamName, 'task-1', claimToken, worker, cwd);
    expect(result).toEqual({ ok: false, error: expectedError });
    expect(await readFile(taskPath(cwd, '1'), 'utf8')).toBe(before);
  });

  it('rejects renewal once a recovery reservation exists', async () => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'in_progress', {
      owner: 'worker-1',
      claim: { owner: 'worker-1', token: 'token-1', leased_until: '2099-01-01T00:00:00.000Z' },
      recovery_reservation: {
        recovery_id: 'rec-1',
        request_id: 'req-1',
        continuation_sequence: 1,
        checkpoint_path: '/tmp/checkpoint.json',
        checkpoint_hash: 'hash',
        replacement_worker: 'worker-2',
        replacement_generation: 2,
        adoption_token_hash: 'adoption-hash',
        reserved_at: timestamp,
      },
    }));
    const result = await teamRenewTaskClaim(teamName, 'task-1', 'token-1', 'worker-1', cwd);
    expect(result).toEqual({ ok: false, error: 'claim_conflict' });
  });

  it('rejects renewal for tasks that are not in progress', async () => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'pending'));
    const result = await teamRenewTaskClaim(teamName, 'task-1', 'token-1', 'worker-1', cwd);
    expect(result).toEqual({ ok: false, error: 'invalid_transition' });
  });

  it('rejects renewal for terminal tasks even with a stale claim attached', async () => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'completed', {
      owner: 'worker-1',
      completed_at: timestamp,
      claim: { owner: 'worker-1', token: 'token-1', leased_until: '2099-01-01T00:00:00.000Z' },
    }));
    const result = await teamRenewTaskClaim(teamName, 'task-1', 'token-1', 'worker-1', cwd);
    expect(result).toEqual({ ok: false, error: 'already_terminal' });
  });

  it('preserves version-bound checkpoints across renewals', async () => {
    // Regression test for the P1 issue: renewal must not invalidate version-bound recovery checkpoints.
    // When a checkpoint is published at version V and renewal does not bump the version,
    // the checkpoint remains valid for recovery if the worker crashes before publishing a new checkpoint.
    await writeTeamConfig(cwd);
    // Create a task in-progress with an initial version (simulating a claimed task)
    await writeTask(cwd, task('1', 'in_progress', {
      owner: 'worker-1',
      version: 5,
      claim: { owner: 'worker-1', token: 'token-1', leased_until: new Date(Date.now() + 60_000).toISOString() },
    }));

    // Renew the claim multiple times - version must stay the same
    // This simulates the worker extending the lease for a long-running task
    for (let i = 0; i < 3; i++) {
      const renewed = await teamRenewTaskClaim(teamName, 'task-1', 'token-1', 'worker-1', cwd);
      expect(renewed.ok).toBe(true);
      if (renewed.ok) {
        // Version must remain unchanged after renewal
        expect(renewed.task.version).toBe(5);
        const onDisk = JSON.parse(await readFile(taskPath(cwd, '1'), 'utf8')) as TeamTask;
        expect(onDisk.version).toBe(5);
      }
    }
  });
});
