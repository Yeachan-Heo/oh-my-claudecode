import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paneMocks = vi.hoisted(() => ({
  getWorkerLiveness: vi.fn(),
  splitTeamWorkerPane: vi.fn(async () => '%2'),
  splitTeamWorkerPaneWithEvidence: vi.fn(async () => ({ commandSucceeded: true, provider: 'tmux' as const,
    splitTarget: '%leader', direction: 'right' as const, rawOutput: '%2\n', stderr: '', paneId: '%2' as string | null })),
  spawnWorkerInPane: vi.fn(async (_sessionName: string, _paneId: string, _config: unknown) => { throw new Error('spawn failed --api-key SUPERSECRET after pane creation'); }),
  spawnOwnedWorkerInPane: vi.fn(),
  killTeamPane: vi.fn(async (_paneId: string) => { throw new Error('pane still alive'); }),
  killOwnedWorkerPane: vi.fn(),
}));

vi.mock('../../cli/tmux-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../cli/tmux-utils.js')>(),
  tmuxExecAsync: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
vi.mock('../tmux-session.js', async importOriginal => ({
  ...await importOriginal<typeof import('../tmux-session.js')>(),
  ...paneMocks,
}));
vi.mock('../model-contract.js', async importOriginal => ({
  ...await importOriginal<typeof import('../model-contract.js')>(),
  getContract: vi.fn(() => ({})),
  resolveValidatedBinaryPath: vi.fn(() => '/bin/echo'),
  buildWorkerArgv: vi.fn(() => ['/bin/echo']),
  getWorkerEnv: vi.fn(() => ({})),
}));

paneMocks.spawnOwnedWorkerInPane.mockImplementation(async (sessionName: string, ownership: { paneId: string }, config: unknown) => {
  await paneMocks.spawnWorkerInPane(sessionName, ownership.paneId, config);
  return { ownership };
});
paneMocks.killOwnedWorkerPane.mockImplementation(async (ownership: { paneId: string }) => {
  await paneMocks.killTeamPane(ownership.paneId);
});

import { reserveRecoveryRequest } from '../recovery-request-store.js';
import { executeRecoverDeadWorkerV2Owner } from '../runtime-v2.js';
import { absPath, TeamPaths } from '../state-paths.js';
import {
  awaitWorkerLaunchAcknowledgement,
  buildWorkerLaunchBootstrapSpec,
  prepareWorkerLaunchAttempt,
  loadCurrentWorkerLaunchAttempt,
  runWorkerLaunchBootstrap,
} from '../worker-launch-ack.js';

const launchMetadata = { worker_cli: 'claude' as const,
  launch_descriptor: { schema_version: 1 as const, provider: 'claude' as const, model: null,
    binary: '/bin/echo', args: [] } };

let cwd = '';
afterEach(() => {
  vi.clearAllMocks();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('recovery pane rollback evidence', () => {
  it('retains the attempt and publishes durable evidence when pane cleanup cannot be verified', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-orphan-'));
    const teamName = 'orphan-team';
    const requestId = 'orphan-request';
    const recoveryId = 'orphan-recovery';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const workerCwd = join(cwd, 'worker-worktree');
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: workerCwd }],
      agent_type: 'claude',
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      lifecycle_state: 'active',
      state_revision: 1,
      leader_pane_id: '%leader',
    }));
    reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
    paneMocks.getWorkerLiveness.mockResolvedValueOnce('dead').mockResolvedValue('alive');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });

    expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalled();
    expect(paneMocks.spawnWorkerInPane).toHaveBeenCalled();
    expect(paneMocks.spawnOwnedWorkerInPane).toHaveBeenCalledWith(
      `${teamName}:0`,
      expect.objectContaining({ paneId: '%2' }),
      expect.objectContaining({ cwd: workerCwd, launchStateCwd: cwd }),
    );
    expect(paneMocks.killTeamPane).toHaveBeenCalledTimes(2);
    const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
    const evidenceFiles = readdirSync(evidenceRoot);
    expect(evidenceFiles).toHaveLength(1);
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]!), 'utf8'));
    expect(evidence).toMatchObject({ schema_version: 1, team_name: teamName, worker_name: 'worker-1',
      request_id: requestId, recovery_id: recoveryId, pane_id: '%2', reason: 'spawn failed --api-key=<redacted> after pane creation', liveness: 'alive' });
  });

  it('reconciles an accepted initial launch pointer before treating the worker as already running', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'omc-recovery-initial-pointer-'));
    const teamName = 'initial-pointer-team';
    const requestId = 'initial-pointer-request';
    const recoveryId = 'initial-pointer-recovery';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1, working_dir: cwd }],
      agent_type: 'claude',
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      lifecycle_state: 'active',
      state_revision: 1,
      leader_pane_id: '%leader',
    }));
    reserveRecoveryRequest(cwd, requestId, {
      operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'),
      teamName,
      workerName: 'worker-1',
    }, recoveryId);
    const launchAttempt = await prepareWorkerLaunchAttempt({
      cwd,
      teamName,
      workerName: 'worker-1',
      paneId: '%9',
      provider: 'claude',
      runtimeCliPath: '/runtime-cli.cjs',
      context: { kind: 'initial' },
    });
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', 'process.exit(0)'],
      cwd,
    ));
    await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 });
    await bootstrap;
    await expect(loadCurrentWorkerLaunchAttempt({
      cwd,
      teamName,
      workerName: 'worker-1',
      provider: 'claude',
    })).resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, pane_id: '%9', context: { kind: 'initial' } });
    paneMocks.getWorkerLiveness.mockResolvedValue('alive');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
      .resolves.toMatchObject({ outcome: 'already_running', committed: true, newPaneId: '%9' });
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.workers[0]).toMatchObject({
      pane_id: '%9',
      launch_attempt_id: launchAttempt.attempt_id,
      operational_state: 'active',
    });
    expect(paneMocks.splitTeamWorkerPaneWithEvidence).not.toHaveBeenCalled();
  });

  it('completes an idle Gemini recovery without requiring fabricated progress evidence', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'omc-recovery-idle-gemini-'));
    const teamName = 'idle-gemini-team';
    const requestId = 'idle-gemini-request';
    const recoveryId = 'idle-gemini-recovery';
    const serviceDescriptor = {
      schema_version: 1,
      service_generation: 1,
      service_attempt_id: 'service-attempt',
      workspace_root: cwd,
      auto_merge_enabled: false,
      cadence_policy: 'disabled',
    };
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      worker_count: 1,
      workers: [{
        name: 'worker-1',
        index: 1,
        worker_cli: 'gemini',
        launch_descriptor: { schema_version: 1, provider: 'gemini', model: null, binary: process.execPath, args: ['-e', 'process.exit(0)'] },
        pane_id: '%1',
        replacement_generation: 1,
        working_dir: cwd,
      }],
      agent_type: 'gemini',
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      lifecycle_state: 'active',
      state_revision: 1,
      leader_pane_id: '%0',
      service_descriptor: serviceDescriptor,
    }));
    writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify({
      schema_version: 2,
      name: teamName,
      state_revision: 1,
      task: 'test',
      leader: { session_id: 'leader', worker_id: 'leader-fixed', role: 'leader' },
      policy: { display_mode: 'split_pane', worker_launch_mode: 'interactive', dispatch_mode: 'hook_preferred_with_fallback', dispatch_ack_timeout_ms: 15000 },
      governance: { delegation_only: false, plan_approval_required: false, nested_teams_allowed: false, one_team_per_leader_session: true, cleanup_requires_all_workers_inactive: true },
      permissions_snapshot: { approval_mode: 'default', sandbox_mode: 'workspace-write', network_access: false },
      tmux_session: `${teamName}:0`,
      worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, role: 'gemini', assigned_tasks: [], worker_cli: 'gemini', pane_id: '%1' }],
      next_task_id: 1,
      created_at: new Date().toISOString(),
      leader_pane_id: '%0',
      service_descriptor: serviceDescriptor,
    }));
    reserveRecoveryRequest(cwd, requestId, {
      operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'),
      teamName,
      workerName: 'worker-1',
    }, recoveryId);
    paneMocks.getWorkerLiveness.mockResolvedValueOnce('dead').mockResolvedValue('alive');

    let bootstrapResult: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
    const previousGateSpec = process.env.OMC_RECOVERY_GATE_SPEC;
    const previousLaunchAttemptId = process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID;
    paneMocks.spawnOwnedWorkerInPane.mockImplementationOnce(async (
      _sessionName: string,
      ownership: { paneId: string },
      config: {
        cwd: string;
        launchStateCwd: string;
        teamName: string;
        workerName: string;
        provider: 'gemini';
        launchBootstrapPath: string;
        launchBinary: string;
        launchArgs: string[];
        envVars: Record<string, string>;
        launchContext?: { kind: 'recovery'; recovery_id: string; replacement_generation: number; pane_attempt_id: string };
      },
    ) => {
      const attempt = await prepareWorkerLaunchAttempt({
        cwd: config.launchStateCwd,
        teamName: config.teamName,
        workerName: config.workerName,
        paneId: ownership.paneId,
        provider: config.provider,
        runtimeCliPath: config.launchBootstrapPath,
        context: config.launchContext,
      });
      process.env.OMC_RECOVERY_GATE_SPEC = config.envVars.OMC_RECOVERY_GATE_SPEC;
      process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID = attempt.attempt_id;
      const spec = buildWorkerLaunchBootstrapSpec(
        attempt,
        [config.launchBinary, ...config.launchArgs],
        config.cwd,
      );
      bootstrapResult = runWorkerLaunchBootstrap(spec);
      const accepted = await awaitWorkerLaunchAcknowledgement(attempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      });
      if (!accepted.ok) throw new Error(`launch acknowledgement failed: ${accepted.reason}`);
      return { ownership, provider: config.provider, attempt };
    });

    try {
      await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
        .resolves.toMatchObject({ outcome: 'recovered', committed: true, recoveryId });
      expect(bootstrapResult).toBeDefined();
      await expect(bootstrapResult!).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
    } finally {
      if (previousGateSpec === undefined) delete process.env.OMC_RECOVERY_GATE_SPEC;
      else process.env.OMC_RECOVERY_GATE_SPEC = previousGateSpec;
      if (previousLaunchAttemptId === undefined) delete process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID;
      else process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID = previousLaunchAttemptId;
    }
  });

  it('publishes durable orphan evidence when split succeeds without a parseable pane id', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-unaddressable-'));
    const teamName = 'unaddressable-team';
    const requestId = 'unaddressable-request';
    const recoveryId = 'unaddressable-recovery';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
      lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
    }));
    reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
    paneMocks.getWorkerLiveness.mockResolvedValue('dead');
    paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({ commandSucceeded: true, provider: 'tmux',
      splitTarget: '%leader', direction: 'right', rawOutput: 'not-a-pane\n', stderr: '', paneId: null });

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });

    expect(paneMocks.spawnWorkerInPane).not.toHaveBeenCalled();
    const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
    const evidenceFiles = readdirSync(evidenceRoot);
    expect(evidenceFiles).toHaveLength(1);
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]!), 'utf8'));
    expect(evidence).toMatchObject({ schema_version: 1, team_name: teamName, worker_name: 'worker-1',
      request_id: requestId, recovery_id: recoveryId, pane_id: null, reason: 'pane_identity_pane_id_missing',
      liveness: 'unknown', unaddressable: true,
      split: { commandSucceeded: true, provider: 'tmux', rawOutput: 'not-a-pane', paneId: null } });
  });

  it('persists failed split stdout and stderr as durable recovery orphan evidence', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-split-failed-'));
    const teamName = 'split-failed-team';
    const requestId = 'split-failed-request';
    const recoveryId = 'split-failed-recovery';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
      lifecycle_state: 'active', state_revision: 1, leader_pane_id: '%leader',
    }));
    reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
    paneMocks.getWorkerLiveness.mockResolvedValue('dead');
    paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({ commandSucceeded: false, provider: 'tmux',
      splitTarget: '%leader', direction: 'right', rawOutput: '%orphan\n', stderr: 'transport interrupted', paneId: null });

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });

    const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
    const evidenceFiles = readdirSync(evidenceRoot);
    expect(evidenceFiles).toHaveLength(1);
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]!), 'utf8'));
    expect(evidence).toMatchObject({ reason: 'pane_identity_split_failed', unaddressable: true,
      split: { commandSucceeded: false, provider: 'tmux', rawOutput: '%orphan', stderr: 'transport interrupted', paneId: null } });
  });

  it('never launches or kills when recovery split aliases the leader pane', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'recovery-pane-leader-alias-'));
    const teamName = 'leader-alias-team';
    const requestId = 'leader-alias-request';
    const recoveryId = 'leader-alias-recovery';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, working_dir: cwd }],
      agent_type: 'claude',
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      lifecycle_state: 'active',
      state_revision: 1,
      leader_pane_id: '%9',
    }));
    reserveRecoveryRequest(cwd, requestId, {
      operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'),
      teamName,
      workerName: 'worker-1',
    }, recoveryId);
    paneMocks.getWorkerLiveness.mockResolvedValue('dead');
    paneMocks.splitTeamWorkerPaneWithEvidence.mockResolvedValueOnce({
      commandSucceeded: true,
      provider: 'tmux',
      splitTarget: '%9',
      direction: 'right',
      rawOutput: '%9\n',
      stderr: '',
      paneId: '%9',
    });

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });

    expect(paneMocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    expect(paneMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
    const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
    const evidenceFiles = readdirSync(evidenceRoot);
    expect(evidenceFiles).toHaveLength(1);
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]!), 'utf8'));
    expect(evidence).toMatchObject({ reason: 'pane_identity_leader_alias', pane_id: null, unaddressable: true });
  });
});
