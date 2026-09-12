import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const environmentIsolation = await vi.hoisted(async () => {
  const [{ mkdtempSync }, { join: pathJoin }] = await Promise.all([
    import('node:fs'),
    import('node:path'),
  ]);
  const previous = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    stateDir: process.env.OMC_STATE_DIR,
  };
  const root = mkdtempSync(pathJoin(process.cwd(), '.tmp-runtime-storage-boundary-import-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.OMC_STATE_DIR = pathJoin(root, 'state');
  return { previous, root };
});

const mocks = vi.hoisted(() => ({
  createTeamSession: vi.fn(),
  splitTeamWorkerPaneWithEvidence: vi.fn(),
  workerPaneBelongsToProviderTarget: vi.fn(),
  spawnOwnedWorkerInPane: vi.fn(),
  deliverStartupInbox: vi.fn(),
  retryStartupInboxSubmit: vi.fn(),
  probeStartupPaneActivity: vi.fn(),
  applyMainVerticalLayout: vi.fn(),
  killOwnedWorkerPane: vi.fn(),
  getWorkerLiveness: vi.fn(),
}));

const launchMocks = vi.hoisted(() => ({
  withWorkerLaunchAttemptFence: vi.fn(),
  retireAndCleanupCurrentWorkerLaunchAttempt: vi.fn(),
}));

const modelMocks = vi.hoisted(() => ({
  resolveValidatedBinaryPath: vi.fn(),
  buildValidatedWorkerLaunchDescriptor: vi.fn(),
  getWorkerEnv: vi.fn(),
  isPromptModeAgent: vi.fn(),
  getPromptModeArgs: vi.fn(),
  resolveDefaultWorkerModel: vi.fn(),
  resolveExternalModelsDefaults: vi.fn(),
  clearResolvedPathCache: vi.fn(),
}));

vi.mock('../tmux-session.js', async importOriginal => ({
  ...await importOriginal<typeof import('../tmux-session.js')>(),
  createTeamSession: mocks.createTeamSession,
  splitTeamWorkerPaneWithEvidence: mocks.splitTeamWorkerPaneWithEvidence,
  workerPaneBelongsToProviderTarget: mocks.workerPaneBelongsToProviderTarget,
  spawnOwnedWorkerInPane: mocks.spawnOwnedWorkerInPane,
  deliverStartupInbox: mocks.deliverStartupInbox,
  retryStartupInboxSubmit: mocks.retryStartupInboxSubmit,
  probeStartupPaneActivity: mocks.probeStartupPaneActivity,
  applyMainVerticalLayout: mocks.applyMainVerticalLayout,
  killOwnedWorkerPane: mocks.killOwnedWorkerPane,
  getWorkerLiveness: mocks.getWorkerLiveness,
}));

vi.mock('../worker-launch-ack.js', async importOriginal => ({
  ...await importOriginal<typeof import('../worker-launch-ack.js')>(),
  withWorkerLaunchAttemptFence: launchMocks.withWorkerLaunchAttemptFence,
  retireAndCleanupCurrentWorkerLaunchAttempt: launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt,
}));

vi.mock('../model-contract.js', async importOriginal => ({
  ...await importOriginal<typeof import('../model-contract.js')>(),
  resolveValidatedBinaryPath: modelMocks.resolveValidatedBinaryPath,
  buildValidatedWorkerLaunchDescriptor: modelMocks.buildValidatedWorkerLaunchDescriptor,
  getWorkerEnv: modelMocks.getWorkerEnv,
  isPromptModeAgent: modelMocks.isPromptModeAgent,
  getPromptModeArgs: modelMocks.getPromptModeArgs,
  resolveDefaultWorkerModel: modelMocks.resolveDefaultWorkerModel,
  resolveExternalModelsDefaults: modelMocks.resolveExternalModelsDefaults,
  clearResolvedPathCache: modelMocks.clearResolvedPathCache,
  assertHeadlessSupported: vi.fn(),
}));

import { absPath, TeamPaths } from '../state-paths.js';
import {
  teamCreateTask,
  teamReadMonitorSnapshot,
  teamReadTask,
  teamClaimTask,
  teamListTasks,
  teamTransitionTaskStatus,
  teamWriteMonitorSnapshot,
} from '../team-ops.js';
import { startTeamV2 } from '../runtime-v2.js';
import type { TeamTask } from '../types.js';

const teamName = 'boundary-team';
const createdAt = '2026-09-10T00:00:00.000Z';
const launchDescriptor = {
  schema_version: 1,
  provider: 'claude',
  model: null,
  binary: '/usr/bin/claude',
  args: [],
} as const;

function statePath(cwd: string, path: string): string {
  return absPath(cwd, path);
}

async function writeConfig(cwd: string): Promise<void> {
  const configPath = statePath(cwd, TeamPaths.config(teamName));
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    name: teamName,
    task: 'boundary storage',
    agent_type: 'claude',
    worker_launch_mode: 'interactive',
    worker_count: 1,
    max_workers: 20,
    workers: [{
      name: 'worker-1',
      index: 1,
      role: 'executor',
      worker_cli: 'claude',
      assigned_tasks: ['1'],
      pane_id: '%2',
      launch_descriptor: launchDescriptor,
      operational_state: 'active',
    }],
    created_at: createdAt,
    tmux_session: `${teamName}:0`,
    next_task_id: 2,
    leader_pane_id: '%1',
    hud_pane_id: null,
  }, null, 2), 'utf8');
}

async function writeTask(cwd: string, task: TeamTask): Promise<void> {
  const taskPath = statePath(cwd, TeamPaths.taskFile(teamName, task.id));
  await mkdir(dirname(taskPath), { recursive: true });
  await writeFile(taskPath, JSON.stringify(task, null, 2), 'utf8');
}

function validTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: '1',
    subject: 'Boundary task',
    description: 'Exercise canonical storage boundaries.',
    status: 'in_progress',
    owner: 'worker-1',
    version: 1,
    claim: { owner: 'worker-1', token: 'claim-token', leased_until: '2099-01-01T00:00:00.000Z' },
    created_at: createdAt,
    ...overrides,
  };
}

const baselineSnapshot = {
  taskStatusById: { '1': 'in_progress' },
  workerAliveByName: { 'worker-1': true },
  workerLivenessByName: { 'worker-1': 'alive' as const },
  workerStateByName: { 'worker-1': 'working' },
  workerTurnCountByName: { 'worker-1': 2 },
  workerTaskIdByName: { 'worker-1': '1' },
  mailboxNotifiedByMessageId: { message: 'notified' },
  completedEventTaskIds: { existing: true },
};

describe('runtime storage boundaries', () => {
  let cwd: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-storage-boundary-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousStateDir = process.env.OMC_STATE_DIR;
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    process.env.OMC_STATE_DIR = join(cwd, 'private-state-root');

    mocks.createTeamSession.mockReset();
    mocks.createTeamSession.mockResolvedValue({
      sessionName: `${teamName}:0`,
      leaderPaneId: '%1',
      workerPaneIds: [],
      sessionMode: 'split-pane',
    });
    mocks.splitTeamWorkerPaneWithEvidence.mockReset();
    mocks.splitTeamWorkerPaneWithEvidence.mockResolvedValue({
      commandSucceeded: true,
      provider: 'tmux',
      splitTarget: '%1',
      direction: 'right',
      rawOutput: '%2\n',
      stderr: '',
      paneId: '%2',
    });
    mocks.workerPaneBelongsToProviderTarget.mockReset();
    mocks.workerPaneBelongsToProviderTarget.mockResolvedValue(true);
    mocks.spawnOwnedWorkerInPane.mockReset();
    mocks.spawnOwnedWorkerInPane.mockImplementation(async (
      _sessionName: string,
      ownership: { paneId: string },
      paneConfig: { teamName: string; workerName: string; provider: 'claude' },
    ) => ({
      ownership,
      provider: paneConfig.provider,
      attempt: {
        schema_version: 1,
        attempt_id: `attempt-${paneConfig.teamName}-${paneConfig.workerName}`,
        nonce: `nonce-${paneConfig.workerName}`,
        team_name: paneConfig.teamName,
        worker_name: paneConfig.workerName,
        pane_id: ownership.paneId,
        provider: paneConfig.provider,
        created_at: new Date().toISOString(),
        runtimeCliPath: '/runtime-cli.cjs',
      },
    }));
    mocks.deliverStartupInbox.mockReset();
    mocks.deliverStartupInbox.mockImplementation(async (context: {
      attempt: { team_name: string; worker_name: string; attempt_id: string };
    }) => {
      const statusPath = statePath(cwd, TeamPaths.workerStatus(context.attempt.team_name, context.attempt.worker_name));
      await mkdir(dirname(statusPath), { recursive: true });
      await writeFile(statusPath, JSON.stringify({
        state: 'working',
        current_task_id: '1',
        updated_at: new Date().toISOString(),
        launch_attempt_id: context.attempt.attempt_id,
      }), 'utf8');
      return { ok: true, kind: 'attempted_unconfirmed' };
    });
    mocks.retryStartupInboxSubmit.mockReset();
    mocks.retryStartupInboxSubmit.mockResolvedValue('unavailable');
    mocks.probeStartupPaneActivity.mockReset();
    mocks.probeStartupPaneActivity.mockResolvedValue('unknown');
    mocks.applyMainVerticalLayout.mockReset();
    mocks.applyMainVerticalLayout.mockResolvedValue(undefined);
    mocks.killOwnedWorkerPane.mockReset();
    mocks.killOwnedWorkerPane.mockResolvedValue(undefined);
    mocks.getWorkerLiveness.mockReset();
    mocks.getWorkerLiveness.mockResolvedValue('alive');

    launchMocks.withWorkerLaunchAttemptFence.mockReset();
    launchMocks.withWorkerLaunchAttemptFence.mockImplementation(async (_attempt: unknown, fn: () => Promise<unknown>) => ({
      ok: true as const,
      value: await fn(),
    }));
    launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt.mockReset();
    launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt.mockImplementation(async (
      _attempt: unknown,
      _reason: string,
      cleanup: () => Promise<boolean>,
    ) => cleanup());

    modelMocks.resolveValidatedBinaryPath.mockReset();
    modelMocks.resolveValidatedBinaryPath.mockReturnValue('/usr/bin/claude');
    modelMocks.buildValidatedWorkerLaunchDescriptor.mockReset();
    modelMocks.buildValidatedWorkerLaunchDescriptor.mockReturnValue(launchDescriptor);
    modelMocks.getWorkerEnv.mockReset();
    modelMocks.getWorkerEnv.mockImplementation((name: string, worker: string) => ({
      OMC_TEAM_WORKER: `${name}/${worker}`,
    }));
    modelMocks.isPromptModeAgent.mockReset();
    modelMocks.isPromptModeAgent.mockReturnValue(false);
    modelMocks.getPromptModeArgs.mockReset();
    modelMocks.getPromptModeArgs.mockImplementation((_agentType: string, prompt: string) => [prompt]);
    modelMocks.resolveDefaultWorkerModel.mockReset();
    modelMocks.resolveDefaultWorkerModel.mockReturnValue(undefined);
    modelMocks.resolveExternalModelsDefaults.mockReset();
    modelMocks.resolveExternalModelsDefaults.mockReturnValue(undefined);
    modelMocks.clearResolvedPathCache.mockReset();
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

  it('boundary: startup writes tasks readable, listable, and claimable through canonical storage', async () => {
    const runtime = await startTeamV2({
      teamName,
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Startup task', description: 'Read me canonically.', owner: 'worker-1' }],
      cwd,
      pluginConfig: {},
    });

    const taskPath = statePath(cwd, TeamPaths.taskFile(teamName, '1'));
    const raw = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ id: '1', status: 'pending', owner: 'worker-1', version: 1 });
    expect(raw.created_at).toEqual(expect.any(String));
    expect(raw).not.toHaveProperty('result');
    await expect(teamReadTask(teamName, '1', cwd)).resolves.toMatchObject({
      id: '1', status: 'pending', owner: 'worker-1', version: 1,
    });
    await expect(teamListTasks(teamName, cwd)).resolves.toMatchObject([{ id: '1', status: 'pending', version: 1 }]);
    await expect(teamClaimTask(teamName, '1', 'worker-1', null, cwd)).resolves.toMatchObject({ ok: true });
    expect(runtime.teamName).toBe(teamName);
  });

  it('boundary: startup and create task records share canonical optional-field shape', async () => {
    await startTeamV2({
      teamName,
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Startup shape', description: 'Compare with create.', owner: undefined }],
      cwd,
      pluginConfig: {},
    });

    const startup = await teamReadTask(teamName, '1', cwd);
    const created = await teamCreateTask(teamName, {
      subject: 'Created shape',
      description: 'Compare with startup.',
      status: 'pending',
      owner: undefined,
    }, cwd);

    expect(startup).toMatchObject({ id: '1', status: 'pending', version: 1, depends_on: [] });
    expect(created).toMatchObject({ id: '2', status: 'pending', version: 1, depends_on: [] });
    expect(startup).not.toHaveProperty('owner');
    expect(startup).not.toHaveProperty('result');
    expect(startup).not.toHaveProperty('error');
    expect(created).not.toHaveProperty('owner');
    expect(created).not.toHaveProperty('result');
    expect(created).not.toHaveProperty('error');
  });

  it.each([
    ['wrong token', '2099-01-01T00:00:00.000Z', 'wrong-token', 'claim_conflict'],
    ['expired claim', '2000-01-01T00:00:00.000Z', 'claim-token', 'lease_expired'],
  ] as const)('boundary: unsuccessful completion does not mutate the monitor snapshot (%s)', async (
    _label,
    leasedUntil,
    claimToken,
    expectedError,
  ) => {
    await writeConfig(cwd);
    await writeTask(cwd, validTask({
      claim: { owner: 'worker-1', token: 'claim-token', leased_until: leasedUntil },
    }));
    await teamWriteMonitorSnapshot(teamName, baselineSnapshot, cwd);
    const snapshotPath = statePath(cwd, TeamPaths.monitorSnapshot(teamName));
    const before = await readFile(snapshotPath, 'utf8');

    await expect(teamTransitionTaskStatus(
      teamName,
      '1',
      'in_progress',
      'completed',
      claimToken,
      cwd,
      { result: 'should not persist' },
    )).resolves.toEqual({ ok: false, error: expectedError });
    expect(await readFile(snapshotPath, 'utf8')).toBe(before);
  });

  it('boundary: successful completion persists its marker after the task transition', async () => {
    await writeConfig(cwd);
    await writeTask(cwd, validTask());
    await teamWriteMonitorSnapshot(teamName, baselineSnapshot, cwd);

    await expect(teamTransitionTaskStatus(
      teamName,
      '1',
      'in_progress',
      'completed',
      'claim-token',
      cwd,
      { result: 'Done' },
    )).resolves.toMatchObject({ ok: true });

    await expect(teamReadMonitorSnapshot(teamName, cwd)).resolves.toMatchObject({
      completedEventTaskIds: { existing: true, '1': true },
    });
  });

  it('boundary: concurrent successful completions preserve both snapshot markers', async () => {
    await writeConfig(cwd);
    await writeTask(cwd, validTask({
      id: '1',
      claim: { owner: 'worker-1', token: 'claim-token-1', leased_until: '2099-01-01T00:00:00.000Z' },
    }));
    await writeTask(cwd, validTask({
      id: '2',
      claim: { owner: 'worker-1', token: 'claim-token-2', leased_until: '2099-01-01T00:00:00.000Z' },
    }));
    await teamWriteMonitorSnapshot(teamName, {
      ...baselineSnapshot,
      taskStatusById: { '1': 'in_progress', '2': 'in_progress' },
      workerTaskIdByName: { 'worker-1': '1' },
      completedEventTaskIds: {},
    }, cwd);

    await Promise.all([
      teamTransitionTaskStatus(teamName, '1', 'in_progress', 'completed', 'claim-token-1', cwd, { result: 'One' }),
      teamTransitionTaskStatus(teamName, '2', 'in_progress', 'completed', 'claim-token-2', cwd, { result: 'Two' }),
    ]);

    await expect(teamReadMonitorSnapshot(teamName, cwd)).resolves.toMatchObject({
      completedEventTaskIds: { '1': true, '2': true },
    });
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
