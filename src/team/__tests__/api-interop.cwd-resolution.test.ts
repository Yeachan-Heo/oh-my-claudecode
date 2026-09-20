import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { executeTeamApiOperation } from '../api-interop.js';
import { reserveRecoveryRequest, writeRecoveryPhase } from '../recovery-request-store.js';
import {
  activateTeamInstanceUnderLock,
  createTeamInstanceBinding,
  reserveTeamInstanceUnderLock,
  withTeamInstanceLifecycleLock,
} from '../team-instance.js';

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

describe('team api working-directory resolution', () => {
  let cwd: string;
  let restoreFixtureEnv: (() => void) | undefined;
  const teamName = 'resolution-team';

  async function seedTeamState(workspace = cwd): Promise<{ root: string; instanceId: string }> {
    const instance = createTeamInstanceBinding({ teamName, cwd: workspace });
    const base = instance.state_root;
    await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, async () => {
      await reserveTeamInstanceUnderLock({
        teamName,
        cwd: workspace,
        instanceId: instance.instance_id,
      });
      await mkdir(join(base, 'tasks'), { recursive: true });
      await mkdir(join(base, 'mailbox'), { recursive: true });
      await writeFile(join(base, 'config.json'), JSON.stringify({
        name: teamName,
        instance_id: instance.instance_id,
        leader_cwd: workspace,
        lifecycle_state: 'active',
        task: 'resolution test',
        agent_type: 'claude',
        worker_launch_mode: 'interactive',
        worker_count: 1,
        max_workers: 20,
        workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
        created_at: '2026-03-06T00:00:00.000Z',
        next_task_id: 2,
        team_state_root: base,
      }, null, 2));
      await writeFile(join(base, 'tasks', 'task-1.json'), JSON.stringify({
        id: '1',
        subject: 'Resolution test task',
        description: 'Ensure API finds the real team root',
        status: 'pending',
        owner: null,
        created_at: '2026-03-06T00:00:00.000Z',
        version: 1,
      }, null, 2));
      await activateTeamInstanceUnderLock(instance);
    });
    return { root: base, instanceId: instance.instance_id };
  }

  function seedRecoveryPhase(
    workspace: string,
    recoveryId: string,
    stateRevision: number,
    instanceId: string,
  ): void {
    reserveRecoveryRequest(workspace, 'request-a', {
      operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(workspace).digest('hex'),
      teamName,
      workerName: 'worker-1',
      instanceId,
    }, recoveryId);
    writeRecoveryPhase(workspace, {
      schema_version: 1,
      kind: 'phase',
      request_id: 'request-a',
      recovery_id: recoveryId,
      team_name: teamName,
      worker_name: 'worker-1',
      phase: 'active',
      continuation: 'adopted',
      adoption: 'adopted',
      services: 'synced',
      manifest: 'synced',
      state_revision: stateRevision,
      updated_at: '2026-07-11T00:00:00.000Z',
    });
  }

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-team-api-resolution-'));
    restoreFixtureEnv = isolateFixtureRoot(cwd);
  });

  afterEach(async () => {
    restoreFixtureEnv?.();
    restoreFixtureEnv = undefined;
    delete process.env.OMC_TEAM_STATE_ROOT;
    delete process.env.OMC_TEAM_WORKER;
    await rm(cwd, { recursive: true, force: true });
  });

  it('resolves workspace cwd from a team-specific config.team_state_root', async () => {
    await seedTeamState();

    const readResult = await executeTeamApiOperation('read-task', {
      team_name: teamName,
      task_id: '1',
    }, cwd);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;
    expect((readResult.data as { task?: { id?: string } }).task?.id).toBe('1');

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
    }, cwd);
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    expect(typeof (claimResult.data as { claimToken?: string }).claimToken).toBe('string');
  });

  it('resolves workspace cwd from OMC_TEAM_STATE_ROOT when it points at a team-specific root', async () => {
    const seeded = await seedTeamState();
    process.env.OMC_TEAM_STATE_ROOT = seeded.root;

    const nestedCwd = join(cwd, 'nested', 'worker');
    await mkdir(nestedCwd, { recursive: true });

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
    }, nestedCwd);
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    expect(typeof (claimResult.data as { claimToken?: string }).claimToken).toBe('string');
  });

  it('reads recovery results from canonical leader state rather than a colliding foreign worker cwd', async () => {
    const leader = await seedTeamState();
    const leaderStateRoot = leader.root;
    const foreignCwd = join(cwd, 'worktrees', 'worker-1', 'nested');

    seedRecoveryPhase(cwd, 'leader-recovery', 7, leader.instanceId);
    const restoreForeignFixtureEnv = isolateFixtureRoot(foreignCwd);
    try {
      const foreign = await seedTeamState(foreignCwd);
      seedRecoveryPhase(foreignCwd, 'foreign-recovery', 99, foreign.instanceId);
    } finally {
      restoreForeignFixtureEnv();
    }
    process.env.OMC_TEAM_STATE_ROOT = leaderStateRoot;
    process.env.OMC_TEAM_WORKER = `${teamName}/worker-1`;

    await expect(executeTeamApiOperation('read-recovery-result', {
      team_name: teamName,
      request_id: 'request-a',
    }, foreignCwd)).resolves.toMatchObject({
      ok: true,
      operation: 'read-recovery-result',
      data: { outcome: { kind: 'phase', recovery_id: 'leader-recovery', state_revision: 7 } },
    });
  });

  it('claims tasks using config workers even when manifest workers are stale', async () => {
    const seeded = await seedTeamState();
    await writeFile(join(seeded.root, 'manifest.json'), JSON.stringify({
      schema_version: 2,
      name: teamName,
      instance_id: seeded.instanceId,
      task: 'resolution test',
      worker_count: 0,
      workers: [],
      created_at: '2026-03-06T00:00:00.000Z',
      team_state_root: seeded.root,
    }, null, 2));

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
    }, cwd);
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    expect((claimResult.data as { ok?: boolean }).ok).toBe(true);
    expect(typeof (claimResult.data as { claimToken?: string }).claimToken).toBe('string');
  });

  it('recognizes workers implied by worker_count when workers array is temporarily empty', async () => {
    const seeded = await seedTeamState();
    await writeFile(join(seeded.root, 'config.json'), JSON.stringify({
      name: teamName,
      instance_id: seeded.instanceId,
      leader_cwd: cwd,
      lifecycle_state: 'active',
      task: 'resolution test',
      agent_type: 'claude',
      worker_count: 2,
      max_workers: 20,
      workers: [],
      created_at: '2026-03-06T00:00:00.000Z',
      next_task_id: 2,
      team_state_root: seeded.root,
    }, null, 2));

    const claimResult = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-2',
    }, cwd);
    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    expect((claimResult.data as { ok?: boolean }).ok).toBe(true);
    expect(typeof (claimResult.data as { claimToken?: string }).claimToken).toBe('string');
  });
});
