import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
  const root = mkdtempSync(pathJoin(osTmpdir(), 'omc-task-storage-integrity-import-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.OMC_STATE_DIR = pathJoin(root, 'state');
  return { previous, root };
});

import { getOmcRoot } from '../../lib/worktree-paths.js';
import {
  teamClaimTask,
  teamCreateTask,
  teamListTasks,
  teamReadMonitorSnapshot,
  teamReadTask,
  teamMarkTaskCompleted,
  teamTransitionTaskStatus,
  teamUpdateTask,
  teamWriteMonitorSnapshot,
  withTaskClaimLock,
  writeAtomic,
} from '../team-ops.js';
import type { TeamMonitorSnapshotState, TeamTask } from '../types.js';

const teamName = 'storage-integrity-team';
const timestamp = '2026-09-10T00:00:00.000Z';

function teamRoot(cwd: string): string {
  return join(getOmcRoot(cwd), 'state', 'team', teamName);
}

function taskPath(cwd: string, taskId: string): string {
  return join(teamRoot(cwd), 'tasks', `task-${taskId}.json`);
}

function snapshot(completedEventTaskIds: Record<string, boolean> = {}): TeamMonitorSnapshotState {
  return {
    taskStatusById: {},
    workerAliveByName: {},
    workerLivenessByName: {},
    workerStateByName: {},
    workerTurnCountByName: {},
    workerTaskIdByName: {},
    mailboxNotifiedByMessageId: {},
    completedEventTaskIds,
  };
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

async function writeTask(cwd: string, value: TeamTask, fileName = `task-${value.id}.json`): Promise<void> {
  const tasksDir = join(teamRoot(cwd), 'tasks');
  await mkdir(tasksDir, { recursive: true });
  await writeFile(join(tasksDir, fileName), JSON.stringify(value, null, 2), 'utf8');
}

async function writeTeamConfig(cwd: string): Promise<void> {
  await mkdir(teamRoot(cwd), { recursive: true });
  await writeFile(join(teamRoot(cwd), 'config.json'), JSON.stringify({
    name: teamName,
    task: 'storage integrity',
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

async function writeClaimedTask(
  cwd: string,
  id: string,
  workerName = 'worker-1',
  leasedUntil = '2099-01-01T00:00:00.000Z',
): Promise<void> {
  await writeTask(cwd, task(id, 'in_progress', {
    owner: workerName,
    claim: { owner: workerName, token: `token-${id}`, leased_until: leasedUntil },
  }));
}

function runSeparateProcessTransition(cwd: string, taskId: string): Promise<unknown> {
  const teamOpsPath = fileURLToPath(new URL('../team-ops.ts', import.meta.url));
  const script = `
    const { teamTransitionTaskStatus } = await import(${JSON.stringify(teamOpsPath)});
    const result = await teamTransitionTaskStatus(
      process.env.OMC_TEST_TEAM,
      process.env.OMC_TEST_TASK,
      'in_progress',
      'completed',
      process.env.OMC_TEST_TOKEN,
      process.env.OMC_TEST_CWD,
      { result: 'separate process completion' },
    );
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: cwd,
        USERPROFILE: cwd,
        OMC_TEST_TEAM: teamName,
        OMC_TEST_TASK: taskId,
        OMC_TEST_TOKEN: `token-${taskId}`,
        OMC_TEST_CWD: cwd,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`separate transition exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`separate transition returned invalid JSON: ${stdout}; ${stderr}; ${String(error)}`));
      }
    });
  });
}

describe('team task storage integrity', () => {
  let cwd: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-task-storage-integrity-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousStateDir = process.env.OMC_STATE_DIR;
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    delete process.env.OMC_STATE_DIR;
    await mkdir(join(teamRoot(cwd), 'tasks'), { recursive: true });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = previousStateDir;
    await rm(cwd, { recursive: true, force: true });
  });

  it('uses one claim lock for numeric and task-prefixed aliases', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const heldPromise = new Promise<void>((resolve) => { release = resolve; });

    const first = withTaskClaimLock(teamName, '1', cwd, async () => {
      entered();
      await heldPromise;
      return 'held';
    });
    await enteredPromise;
    await expect(withTaskClaimLock(teamName, 'task-1', cwd, async () => 'alias')).resolves.toEqual({ ok: false });
    release();
    await expect(first).resolves.toEqual({ ok: true, value: 'held' });
  });

  it('allows only one parallel claim across task aliases', async () => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1'));

    const results = await Promise.all([
      teamClaimTask(teamName, '1', 'worker-1', null, cwd),
      teamClaimTask(teamName, 'task-1', 'worker-2', null, cwd),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);

    const persisted = await teamReadTask(teamName, '1', cwd);
    expect(persisted?.status).toBe('in_progress');
    expect(['worker-1', 'worker-2']).toContain(persisted?.owner);
  });

  it('blocks a claim until every persisted dependency is completed', async () => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'pending', { depends_on: ['2'], blocked_by: ['2'] }));
    await writeTask(cwd, task('2'));
    const before = await readFile(taskPath(cwd, '1'), 'utf8');

    await expect(teamClaimTask(teamName, '1', 'worker-1', null, cwd)).resolves.toEqual({
      ok: false,
      error: 'blocked_dependency',
      dependencies: ['2'],
    });
    expect(await readFile(taskPath(cwd, '1'), 'utf8')).toBe(before);

    await writeTask(cwd, task('2', 'completed'));
    await expect(teamClaimTask(teamName, 'task-1', 'worker-1', null, cwd))
      .resolves.toMatchObject({ ok: true, task: { status: 'in_progress', owner: 'worker-1' } });
  });

  it('accepts legacy blocked_by-only dependencies from a valid producer', async () => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'pending', { blocked_by: ['2'] }));
    await writeTask(cwd, task('2', 'completed'));

    await expect(teamClaimTask(teamName, '1', 'worker-1', null, cwd))
      .resolves.toMatchObject({ ok: true, task: { status: 'in_progress', owner: 'worker-1' } });
  });

  it('normalizes nullable result and error fields on read, list, and claim', async () => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'pending', {
      result: null as unknown as string,
      error: null as unknown as string,
    }));
    const path = taskPath(cwd, '1');
    const before = await readFile(path, 'utf8');

    const read = await teamReadTask(teamName, '1', cwd);
    expect(read).not.toHaveProperty('result');
    expect(read).not.toHaveProperty('error');
    const listed = await teamListTasks(teamName, cwd);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('result');
    expect(listed[0]).not.toHaveProperty('error');
    expect(await readFile(path, 'utf8')).toBe(before);

    await expect(teamClaimTask(teamName, '1', 'worker-1', null, cwd))
      .resolves.toMatchObject({ ok: true, task: { status: 'in_progress' } });
    const claimed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(claimed).not.toHaveProperty('result');
    expect(claimed).not.toHaveProperty('error');
  });

  it.each([
    ['result', { unexpected: true }],
    ['error', 42],
  ] as const)('rejects non-string %s values without rewriting the task', async (field, value) => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'pending', { [field]: value } as Partial<TeamTask>));
    const path = taskPath(cwd, '1');
    const before = await readFile(path, 'utf8');

    await expect(teamReadTask(teamName, '1', cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamListTasks(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamClaimTask(teamName, '1', 'worker-1', null, cwd))
      .rejects.toThrow('invalid_persisted_state');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('persists create dependencies and keeps updates canonical', async () => {
    await writeTeamConfig(cwd);
    const predecessor = await teamCreateTask(teamName, {
      subject: 'Predecessor', description: 'Complete first', status: 'completed',
    }, cwd);
    const replacement = await teamCreateTask(teamName, {
      subject: 'Replacement predecessor', description: 'Also complete first', status: 'completed',
    }, cwd);
    const created = await teamCreateTask(teamName, {
      subject: 'Created dependent', description: 'Persist dependency fields', status: 'pending',
      blocked_by: [predecessor.id],
    }, cwd);
    expect(created).toMatchObject({ blocked_by: ['1'], depends_on: ['1'] });
    await expect(teamReadTask(teamName, created.id, cwd))
      .resolves.toMatchObject({ blocked_by: ['1'], depends_on: ['1'] });

    const independent = await teamCreateTask(teamName, {
      subject: 'Independent', description: 'Wait for predecessor', status: 'pending',
    }, cwd);
    expect(independent).toMatchObject({ depends_on: [] });
    expect(independent).not.toHaveProperty('blocked_by');
    await expect(teamListTasks(teamName, cwd)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: independent.id, depends_on: [] })]),
    );
    await expect(teamUpdateTask(teamName, independent.id, { blocked_by: [predecessor.id] }, cwd))
      .resolves.toMatchObject({ blocked_by: ['1'], depends_on: ['1'] });
    await expect(teamUpdateTask(teamName, independent.id, { blocked_by: [replacement.id] }, cwd))
      .resolves.toMatchObject({ blocked_by: ['2'], depends_on: ['2'] });
    await expect(teamUpdateTask(teamName, independent.id, { depends_on: [] }, cwd))
      .resolves.toMatchObject({ blocked_by: [], depends_on: [] });
    await expect(teamClaimTask(teamName, independent.id, 'worker-1', null, cwd))
      .resolves.toMatchObject({ ok: true, task: { id: independent.id, status: 'in_progress' } });
  });

  it.each([
    ['mismatched dependency fields', { depends_on: ['1'], blocked_by: ['2'] }],
    ['duplicate dependency ids', { blocked_by: ['1', '1'] }],
    ['non-canonical dependency id', { blocked_by: ['task-1'] }],
    ['self dependency', { blocked_by: ['1'] }],
  ] satisfies Array<[string, Partial<TeamTask>]>)('rejects malformed create dependency data before writing', async (_label, dependencies) => {
    await writeTeamConfig(cwd);
    const configPath = join(teamRoot(cwd), 'config.json');
    const beforeConfig = await readFile(configPath, 'utf8');

    await expect(teamCreateTask(teamName, {
      subject: 'Malformed', description: 'Must not persist', status: 'pending', ...dependencies,
    }, cwd)).rejects.toThrow('invalid_task_dependencies');
    await expect(teamReadTask(teamName, '1', cwd)).resolves.toBeNull();
    expect(await readFile(configPath, 'utf8')).toBe(beforeConfig);
  });

  it('rejects malformed update dependencies without changing persisted bytes', async () => {
    await writeTeamConfig(cwd);
    const created = await teamCreateTask(teamName, {
      subject: 'Task', description: 'Must remain unchanged', status: 'pending', blocked_by: [],
    }, cwd);
    const path = taskPath(cwd, created.id);
    const before = await readFile(path, 'utf8');

    await expect(teamUpdateTask(teamName, created.id, { blocked_by: ['task-1'] }, cwd))
      .rejects.toThrow('invalid_task_dependencies');
    expect(await readFile(path, 'utf8')).toBe(before);
    await expect(teamReadTask(teamName, created.id, cwd))
      .resolves.toMatchObject({ blocked_by: [], depends_on: [] });
  });

  it.each([
    ['status', { status: 'done' }],
    ['result', { result: 1 }],
    ['error', { error: false }],
    ['metadata', { metadata: ['not', 'an', 'object'] }],
    ['claim', { claim: { owner: 'worker-1', token: 1, leased_until: '2099-01-01T00:00:00.000Z' } }],
  ] as const)('rejects invalid %s updates without changing task bytes or version', async (_label, updates) => {
    await writeTeamConfig(cwd);
    const created = await teamCreateTask(teamName, {
      subject: 'Task', description: 'Must remain unchanged', status: 'pending',
    }, cwd);
    const path = taskPath(cwd, created.id);
    const before = await readFile(path, 'utf8');

    await expect(teamUpdateTask(teamName, created.id, updates, cwd))
      .rejects.toThrow('invalid_task_schema');
    expect(await readFile(path, 'utf8')).toBe(before);
    await expect(teamReadTask(teamName, created.id, cwd))
      .resolves.toMatchObject({ version: 1, status: 'pending' });
  });

  it('normalizes nullable optional update fields before publishing and returning', async () => {
    await writeTeamConfig(cwd);
    const created = await teamCreateTask(teamName, {
      subject: 'Task', description: 'Normalize nulls', status: 'pending',
    }, cwd);

    const updated = await teamUpdateTask(teamName, created.id, {
      owner: null,
      result: null,
      error: null,
    }, cwd);
    expect(updated).toMatchObject({ id: created.id, version: 2 });
    expect(updated).not.toHaveProperty('owner');
    expect(updated).not.toHaveProperty('result');
    expect(updated).not.toHaveProperty('error');
    await expect(teamReadTask(teamName, created.id, cwd)).resolves.toMatchObject({
      id: created.id,
      version: 2,
    });
    const persisted = JSON.parse(await readFile(taskPath(cwd, created.id), 'utf8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('owner');
    expect(persisted).not.toHaveProperty('result');
    expect(persisted).not.toHaveProperty('error');
  });

  it('round-trips valid task updates through the canonical schema', async () => {
    await writeTeamConfig(cwd);
    const created = await teamCreateTask(teamName, {
      subject: 'Task', description: 'Persist valid updates', status: 'pending',
    }, cwd);

    const updated = await teamUpdateTask(teamName, created.id, {
      status: 'blocked',
      owner: 'worker-1',
      metadata: { source: 'test', attempt: 1 },
    }, cwd);
    expect(updated).toMatchObject({
      id: created.id,
      status: 'blocked',
      owner: 'worker-1',
      metadata: { source: 'test', attempt: 1 },
      version: 2,
    });
    await expect(teamReadTask(teamName, created.id, cwd)).resolves.toEqual(updated);
  });

  it('rejects version overflow without changing persisted bytes or version', async () => {
    await writeTeamConfig(cwd);
    const created = await teamCreateTask(teamName, {
      subject: 'Task', description: 'Keep max version stable', status: 'pending',
    }, cwd);
    const path = taskPath(cwd, created.id);
    const maxVersionTask = { ...created, version: Number.MAX_SAFE_INTEGER };
    await writeFile(path, JSON.stringify(maxVersionTask, null, 2), 'utf8');
    const before = await readFile(path, 'utf8');

    await expect(teamUpdateTask(teamName, created.id, { subject: 'overflow' }, cwd))
      .rejects.toThrow('invalid_task_schema');
    expect(await readFile(path, 'utf8')).toBe(before);
    await expect(teamReadTask(teamName, created.id, cwd))
      .resolves.toMatchObject({ version: Number.MAX_SAFE_INTEGER, subject: created.subject });
  });

  it('rejects invalid task schema at create publish without creating a task', async () => {
    await writeTeamConfig(cwd);

    await expect(teamCreateTask(teamName, {
      subject: 'Malformed', description: 'Must not persist', status: 'pending',
      metadata: 'not an object' as unknown as Record<string, unknown>,
    }, cwd)).rejects.toThrow('invalid_task_schema');
    await expect(teamReadTask(teamName, '1', cwd)).resolves.toBeNull();
    await expect(teamListTasks(teamName, cwd)).resolves.toEqual([]);
  });

  it.each([
    ['mismatched dependency fields', { depends_on: [], blocked_by: ['2'] }],
    ['duplicate dependency ids', { depends_on: ['2', '2'], blocked_by: ['2', '2'] }],
    ['non-canonical dependency id', { depends_on: ['task-2'], blocked_by: ['task-2'] }],
  ] satisfies Array<[string, Partial<TeamTask>]>)('rejects %s without claiming or rewriting the task', async (_label, dependencies) => {
    await writeTeamConfig(cwd);
    await writeTask(cwd, task('1', 'pending', dependencies));
    await writeTask(cwd, task('2', 'completed'));
    const before = await readFile(taskPath(cwd, '1'), 'utf8');

    await expect(teamReadTask(teamName, '1', cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamListTasks(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamClaimTask(teamName, '1', 'worker-1', null, cwd))
      .rejects.toThrow('invalid_persisted_state');
    expect(await readFile(taskPath(cwd, '1'), 'utf8')).toBe(before);
  });

  it.each([
    ['wrong token', '2099-01-01T00:00:00.000Z', 'wrong-token', 'claim_conflict'],
    ['expired claim', '2000-01-01T00:00:00.000Z', 'token-1', 'lease_expired'],
  ] as const)('does not change the monitor snapshot for %s', async (_label, leasedUntil, claimToken, expectedError) => {
    await writeClaimedTask(cwd, '1', 'worker-1', leasedUntil);
    const baseline = snapshot({ existing: true });
    const snapshotPath = join(teamRoot(cwd), 'monitor-snapshot.json');
    await teamWriteMonitorSnapshot(teamName, baseline, cwd);
    const before = await readFile(snapshotPath, 'utf8');

    const result = await teamTransitionTaskStatus(teamName, 'task-1', 'in_progress', 'completed', claimToken, cwd);
    expect(result).toEqual({ ok: false, error: expectedError });
    expect(await readFile(snapshotPath, 'utf8')).toBe(before);
  });

  it('preserves every completion marker during parallel transitions and leaves no temporary files', async () => {
    const taskIds = ['1', '2', '3', '4', '5'];
    for (const id of taskIds) await writeClaimedTask(cwd, id);
    const baseline = snapshot();
    baseline.workerTurnCountByName = { 'worker-1': 9 };
    baseline.mailboxNotifiedByMessageId = { message: timestamp };
    await teamWriteMonitorSnapshot(teamName, baseline, cwd);

    const results = await Promise.all(taskIds.map((id) => teamTransitionTaskStatus(
      teamName, id, 'in_progress', 'completed', `token-${id}`, cwd, { result: `completed ${id}` },
    )));
    expect(results.every((result) => result.ok), JSON.stringify(results)).toBe(true);
    await expect(teamReadMonitorSnapshot(teamName, cwd)).resolves.toMatchObject({
      completedEventTaskIds: Object.fromEntries(taskIds.map((id) => [id, true])),
      workerTurnCountByName: { 'worker-1': 9 },
      mailboxNotifiedByMessageId: { message: timestamp },
    });
    const entries = await readdir(join(teamRoot(cwd), 'tasks'));
    expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  it('preserves completion markers across separate processes', async () => {
    const taskIds = ['11', '12', '13', '14'];
    for (const id of taskIds) await writeClaimedTask(cwd, id);
    await teamWriteMonitorSnapshot(teamName, snapshot(), cwd);

    const results = await Promise.all(taskIds.map((id) => runSeparateProcessTransition(cwd, id)));
    expect(results.every((result) => (result as { ok?: boolean }).ok), JSON.stringify(results)).toBe(true);
    await expect(teamReadMonitorSnapshot(teamName, cwd)).resolves.toMatchObject({
      completedEventTaskIds: Object.fromEntries(taskIds.map((id) => [id, true])),
    });
  });

  it('merges completion markers when a stale monitor snapshot is written', async () => {
    await writeClaimedTask(cwd, '1');
    await teamWriteMonitorSnapshot(teamName, snapshot(), cwd);
    await expect(teamTransitionTaskStatus(teamName, '1', 'in_progress', 'completed', 'token-1', cwd))
      .resolves.toMatchObject({ ok: true });

    await teamWriteMonitorSnapshot(teamName, snapshot(), cwd);
    await expect(teamReadMonitorSnapshot(teamName, cwd))
      .resolves.toMatchObject({ completedEventTaskIds: { '1': true } });
  });

  it('rebuilds a corrupt monitor snapshot after a committed completion', async () => {
    await writeClaimedTask(cwd, '1');
    const snapshotPath = join(teamRoot(cwd), 'monitor-snapshot.json');
    const corruptSnapshot = '{not-json';
    await writeFile(snapshotPath, corruptSnapshot, 'utf8');

    await expect(teamTransitionTaskStatus(teamName, '1', 'in_progress', 'completed', 'token-1', cwd))
      .resolves.toMatchObject({ ok: true, task: { status: 'completed' } });
    await expect(teamReadTask(teamName, '1', cwd))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(teamReadMonitorSnapshot(teamName, cwd))
      .resolves.toMatchObject({ completedEventTaskIds: { '1': true } });
  });

  it('keeps a committed task transition successful when snapshot I/O fails', async () => {
    await writeClaimedTask(cwd, '1');
    const snapshotPath = join(teamRoot(cwd), 'monitor-snapshot.json');
    await mkdir(snapshotPath);

    await expect(teamTransitionTaskStatus(teamName, '1', 'in_progress', 'completed', 'token-1', cwd))
      .resolves.toMatchObject({ ok: true, task: { status: 'completed' } });
    await expect(teamReadTask(teamName, '1', cwd))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(teamReadMonitorSnapshot(teamName, cwd)).resolves.toBeNull();
  });

  it('keeps a committed task transition successful when event append fails', async () => {
    await writeClaimedTask(cwd, '1');
    await teamWriteMonitorSnapshot(teamName, snapshot(), cwd);
    await mkdir(join(teamRoot(cwd), 'events.jsonl'));

    await expect(teamTransitionTaskStatus(teamName, '1', 'in_progress', 'completed', 'token-1', cwd))
      .resolves.toMatchObject({ ok: true, task: { status: 'completed' } });
    await expect(teamReadTask(teamName, '1', cwd))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(teamReadMonitorSnapshot(teamName, cwd))
      .resolves.toMatchObject({ completedEventTaskIds: {} });
  });

  it('updates only the completion marker while preserving fresh monitor fields', async () => {
    const current = snapshot();
    current.workerTurnCountByName = { 'worker-1': 17 };
    current.mailboxNotifiedByMessageId = { message: timestamp };
    await teamWriteMonitorSnapshot(teamName, current, cwd);

    await teamMarkTaskCompleted(teamName, '1', cwd);

    await expect(teamReadMonitorSnapshot(teamName, cwd)).resolves.toMatchObject({
      workerTurnCountByName: { 'worker-1': 17 },
      mailboxNotifiedByMessageId: { message: timestamp },
      completedEventTaskIds: { '1': true },
    });
  });

  it('rejects corrupt canonical tasks but treats snapshots as rebuildable cache', async () => {
    const corruptTask = '{"id":"1",';
    const canonicalPath = taskPath(cwd, '1');
    await writeFile(canonicalPath, corruptTask, 'utf8');
    await writeTask(cwd, task('1'), '1.json');
    await expect(teamReadTask(teamName, '1', cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamListTasks(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    expect(await readFile(canonicalPath, 'utf8')).toBe(corruptTask);

    const snapshotPath = join(teamRoot(cwd), 'monitor-snapshot.json');
    const corruptSnapshot = '{not-json';
    await writeFile(snapshotPath, corruptSnapshot, 'utf8');
    await expect(teamReadMonitorSnapshot(teamName, cwd)).resolves.toBeNull();
    expect(await readFile(snapshotPath, 'utf8')).toBe(corruptSnapshot);
  });

  it.each([false, true])('rejects a canonical task directory before considering a legacy task (%s legacy)', async (withLegacy) => {
    const canonicalPath = taskPath(cwd, '1');
    await mkdir(canonicalPath);
    if (withLegacy) await writeTask(cwd, task('1'), '1.json');

    await expect(teamReadTask(teamName, '1', cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamListTasks(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
  });

  it('rejects selected task symlinks consistently without following them', async () => {
    const targetPath = join(cwd, 'outside-task.json');
    await writeFile(targetPath, JSON.stringify(task('1')), 'utf8');
    const canonicalPath = taskPath(cwd, '1');
    await symlink(targetPath, canonicalPath);
    await writeTask(cwd, task('1', 'completed'), '1.json');

    await expect(teamReadTask(teamName, '1', cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamListTasks(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
  });

  it('rejects a selected legacy task symlink when canonical is absent', async () => {
    const targetPath = join(cwd, 'outside-task.json');
    await writeFile(targetPath, JSON.stringify(task('1')), 'utf8');
    await symlink(targetPath, join(teamRoot(cwd), 'tasks', '1.json'));

    await expect(teamReadTask(teamName, '1', cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamListTasks(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
  });

  it('prefers a legitimate regular canonical task over a legacy task', async () => {
    await writeTask(cwd, task('1', 'pending', { subject: 'canonical' }));
    await writeTask(cwd, task('1', 'completed', { subject: 'legacy' }), '1.json');

    await expect(teamReadTask(teamName, '1', cwd))
      .resolves.toMatchObject({ subject: 'canonical', status: 'pending' });
    await expect(teamListTasks(teamName, cwd))
      .resolves.toEqual([expect.objectContaining({ subject: 'canonical', status: 'pending' })]);
  });

  it('rejects malformed leases without rewriting the task', async () => {
    const malformed = JSON.stringify(task('1', 'in_progress', {
      owner: 'worker-1',
      claim: { owner: 'worker-1', token: 'token-1', leased_until: 'not-a-timestamp' },
    }), null, 2);
    const path = taskPath(cwd, '1');
    await writeFile(path, malformed, 'utf8');

    await expect(teamReadTask(teamName, '1', cwd)).rejects.toThrow('invalid_persisted_state');
    expect(await readFile(path, 'utf8')).toBe(malformed);
  });

  it('uses unique temporary files for concurrent atomic writes', async () => {
    const path = join(teamRoot(cwd), 'atomic.json');
    await Promise.all(Array.from({ length: 24 }, (_, index) => writeAtomic(path, JSON.stringify({ index }))));
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('index');
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
    expect((await readdir(teamRoot(cwd))).filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });
});

afterAll(async () => {
  const { previous, root } = environmentIsolation;
  if (previous.home === undefined) delete process.env.HOME;
  else process.env.HOME = previous.home;
  if (previous.userProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previous.userProfile;
  if (previous.stateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previous.stateDir;
  await rm(root, { recursive: true, force: true });
});
