import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';

const atomicWriteControl = vi.hoisted(() => ({
  failCanonicalPath: undefined as string | undefined,
  triggerReadPath: undefined as string | undefined,
  corruptSiblingPath: undefined as string | undefined,
  readTriggered: false,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (
      path: string | URL,
      data: string | Uint8Array,
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      const target = atomicWriteControl.failCanonicalPath;
      if (target && String(path).startsWith(`${target}.`)) {
        throw new Error('injected_task_publication_interruption');
      }
      return actual.writeFile(path, data, options);
    },
    readFile: async (
      path: string | URL,
      options?: Parameters<typeof actual.readFile>[1],
    ) => {
      if (atomicWriteControl.triggerReadPath
        && String(path) === atomicWriteControl.triggerReadPath
        && !atomicWriteControl.readTriggered) {
        atomicWriteControl.readTriggered = true;
        if (atomicWriteControl.corruptSiblingPath) {
          await actual.writeFile(atomicWriteControl.corruptSiblingPath, '{corrupt sibling', 'utf8');
        }
      }
      return actual.readFile(path, options);
    },
  };
});

import { enqueueDispatchRequest, listDispatchRequests, transitionDispatchRequest } from '../dispatch-queue.js';
import { readRecoveryOutcome, reserveRecoveryRequest } from '../recovery-request-store.js';
import { hashTaskRecoveryCheckpointPayload, taskRecoveryClaimTokenHash } from '../task-recovery-checkpoint.js';
import { absPath, TeamPaths } from '../state-paths.js';
import {
  getWorkerStartupEvidencePolicy,
  settleStartupEvidence,
  promptModeRecoveryRequiresProgressEvidence,
  waitForStartupEvidenceBudget,
} from '../runtime-v2.js';

const mocks = vi.hoisted(() => ({
  createTeamSession: vi.fn(),
  spawnWorkerInPane: vi.fn(),
  spawnOwnedWorkerInPane: vi.fn(),
  deliverStartupInbox: vi.fn(),
  probeStartupPaneActivity: vi.fn(),
  retryStartupInboxSubmit: vi.fn(),
  sendToWorker: vi.fn(),
  waitForPaneReady: vi.fn(),
  applyMainVerticalLayout: vi.fn(),
  killWorkerPanes: vi.fn(async () => undefined),
  killOwnedWorkerPane: vi.fn<(ownership: { paneId: string }) => Promise<void>>(async () => {}),
  killTeamSession: vi.fn(async () => {}),
  resolveSplitPaneWorkerPaneIds: vi.fn(async (_session: string | undefined, paneIds: string[]) => paneIds),
  getWorkerLiveness: vi.fn<(paneId: string) => Promise<string>>(async () => 'dead'),
  execFile: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0 })),
  tmuxExecAsync: vi.fn(),
  autoStartupEvidence: true,
  nextStartupTaskId: 1,
  nextSplitPaneId: 2,
  cmuxSplitPaneId: null as string | null,
  workerPaneBelongsToProviderTarget: vi.fn(async () => true),
}));

const launchMocks = vi.hoisted(() => ({
  withWorkerLaunchAttemptFence: vi.fn(async (_attempt: unknown, fn: () => Promise<unknown>) => ({ ok: true as const, value: await fn() })),
  retireWorkerLaunchAttempt: vi.fn(async () => true),
  terminateWorkerLaunchProvider: vi.fn(async () => true),
  retireAndCleanupCurrentWorkerLaunchAttempt: vi.fn(async (_attempt: unknown, _reason: string, cleanup: () => Promise<boolean>) => cleanup()),
  loadWorkerLaunchAttempt: vi.fn(async () => ({})),
  loadCurrentWorkerLaunchAttempt: vi.fn(async () => null),
  isWorkerLaunchAttemptAccepted: vi.fn(async () => true),
  isWorkerLaunchAttemptCurrent: vi.fn(async () => true),
}));

const mergeMocks = vi.hoisted(() => ({
  startMergeOrchestrator: vi.fn(),
  recoverFromRestart: vi.fn(async () => undefined),
  registerWorker: vi.fn(async () => undefined),
  unregisterWorker: vi.fn(async () => undefined),
  drainAndStop: vi.fn(async () => ({ unmerged: [] })),
}));

const cadenceMocks = vi.hoisted(() => ({
  installCommitCadence: vi.fn(async () => ({ method: 'hook' })),
  startFallbackPoller: vi.fn(() => ({ stop: vi.fn() })),
  uninstallCommitCadence: vi.fn(async () => undefined),
}));

const modelContractMocks = vi.hoisted(() => ({
  buildWorkerArgv: vi.fn((_agentType: string, _config: unknown) => ['/usr/bin/claude']),
  resolveValidatedBinaryPath: vi.fn(() => '/usr/bin/claude'),
  clearResolvedPathCache: vi.fn(),
  getWorkerEnv: vi.fn(() => ({ OMC_TEAM_WORKER: 'dispatch-team/worker-1' })),
  isPromptModeAgent: vi.fn(() => false),
  getPromptModeArgs: vi.fn((_agentType: string, instruction: string) => [instruction]),
  resolveClaudeWorkerModel: vi.fn(() => undefined),
  normalizeExternalModelsDefaults: vi.fn((defaults: unknown) => defaults),
  resolveExternalModelsDefaults: vi.fn((defaults: unknown) => defaults),
  resolveDefaultWorkerModel: vi.fn((agentType: string, _env?: NodeJS.ProcessEnv, defaults?: { cursorModel?: string }) => {
    if (agentType === 'claude') return undefined;
    const keys: Record<string, string[]> = {
      codex: ['OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL', 'OMC_CODEX_DEFAULT_MODEL'],
      gemini: ['OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL', 'OMC_GEMINI_DEFAULT_MODEL'],
      antigravity: ['OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL', 'OMC_ANTIGRAVITY_DEFAULT_MODEL'],
      grok: ['OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL', 'OMC_GROK_DEFAULT_MODEL'],
      cursor: ['OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL', 'OMC_CURSOR_DEFAULT_MODEL'],
    };
    return keys[agentType]?.map(key => process.env[key]).find(Boolean) ?? (agentType === 'cursor' ? defaults?.cursorModel : undefined);
  }),
  buildValidatedWorkerLaunchDescriptor: vi.fn((agentType: string, config: { model?: string; resolvedBinaryPath?: string }, appendedArgs: string[] = []) => {
    const [binary, ...args] = modelContractMocks.buildWorkerArgv(agentType, config);
    return { schema_version: 1, provider: agentType, model: config.model ?? null,
      binary: binary ?? config.resolvedBinaryPath ?? `/usr/bin/${agentType}`, args: [...args, ...appendedArgs] };
  }),
  validateWorkerLaunchDescriptor: vi.fn((value: unknown) => value),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: mocks.execFile,
    spawnSync: mocks.spawnSync,
  };
});

vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
  return {
    ...actual,
    tmuxExecAsync: mocks.tmuxExecAsync,
  };
});

vi.mock('../model-contract.js', () => ({
  buildWorkerArgv: modelContractMocks.buildWorkerArgv,
  resolveValidatedBinaryPath: modelContractMocks.resolveValidatedBinaryPath,
  clearResolvedPathCache: modelContractMocks.clearResolvedPathCache,
  getWorkerEnv: modelContractMocks.getWorkerEnv,
  isPromptModeAgent: modelContractMocks.isPromptModeAgent,
  getPromptModeArgs: modelContractMocks.getPromptModeArgs,
  resolveClaudeWorkerModel: modelContractMocks.resolveClaudeWorkerModel,
  normalizeExternalModelsDefaults: modelContractMocks.normalizeExternalModelsDefaults,
  resolveExternalModelsDefaults: modelContractMocks.resolveExternalModelsDefaults,
  resolveDefaultWorkerModel: modelContractMocks.resolveDefaultWorkerModel,
  buildValidatedWorkerLaunchDescriptor: modelContractMocks.buildValidatedWorkerLaunchDescriptor,
  validateWorkerLaunchDescriptor: modelContractMocks.validateWorkerLaunchDescriptor,
  assertHeadlessSupported: () => {},
  isHeadlessSupportedOnPlatform: () => true,
}));

vi.mock('../worker-launch-ack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker-launch-ack.js')>();
  return {
    ...actual,
    withWorkerLaunchAttemptFence: launchMocks.withWorkerLaunchAttemptFence,
    retireWorkerLaunchAttempt: launchMocks.retireWorkerLaunchAttempt,
    terminateWorkerLaunchProvider: launchMocks.terminateWorkerLaunchProvider,
    retireAndCleanupCurrentWorkerLaunchAttempt: launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt,
    loadWorkerLaunchAttempt: launchMocks.loadWorkerLaunchAttempt,
    loadCurrentWorkerLaunchAttempt: launchMocks.loadCurrentWorkerLaunchAttempt,
    isWorkerLaunchAttemptAccepted: launchMocks.isWorkerLaunchAttemptAccepted,
    isWorkerLaunchAttemptCurrent: launchMocks.isWorkerLaunchAttemptCurrent,
  };
});

vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    createTeamSession: mocks.createTeamSession,
    spawnWorkerInPane: mocks.spawnWorkerInPane,
    spawnOwnedWorkerInPane: mocks.spawnOwnedWorkerInPane,
    deliverStartupInbox: mocks.deliverStartupInbox,
    probeStartupPaneActivity: mocks.probeStartupPaneActivity,
    retryStartupInboxSubmit: mocks.retryStartupInboxSubmit,
    sendToWorker: mocks.sendToWorker,
    waitForPaneReady: mocks.waitForPaneReady,
    applyMainVerticalLayout: mocks.applyMainVerticalLayout,
    splitTeamWorkerPaneWithEvidence: async (
      splitTarget: string,
      direction: 'right' | 'down',
      cwd: string,
      provider?: 'tmux' | 'cmux',
    ) => provider === 'cmux' && mocks.cmuxSplitPaneId
      ? {
          commandSucceeded: true,
          provider,
          splitTarget,
          direction,
          rawOutput: `${mocks.cmuxSplitPaneId}\n`,
          stderr: '',
          paneId: mocks.cmuxSplitPaneId,
        }
      : actual.splitTeamWorkerPaneWithEvidence(splitTarget, direction, cwd, provider),
    workerPaneBelongsToProviderTarget: mocks.workerPaneBelongsToProviderTarget,
    killWorkerPanes: mocks.killWorkerPanes,
    killOwnedWorkerPane: mocks.killOwnedWorkerPane,
    killTeamSession: mocks.killTeamSession,
    resolveSplitPaneWorkerPaneIds: mocks.resolveSplitPaneWorkerPaneIds,
    getWorkerLiveness: mocks.getWorkerLiveness,
  };
});

vi.mock('../merge-orchestrator.js', () => ({
  startMergeOrchestrator: mergeMocks.startMergeOrchestrator,
  recoverFromRestart: mergeMocks.recoverFromRestart,
}));

vi.mock('../worker-commit-cadence.js', () => ({
  installCommitCadence: cadenceMocks.installCommitCadence,
  startFallbackPoller: cadenceMocks.startFallbackPoller,
  uninstallCommitCadence: cadenceMocks.uninstallCommitCadence,
}));

vi.mock('../../platform/process-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../platform/process-utils.js')>(),
  isProcessIdentityLive: async (pid: number, identity: string) =>
    pid === process.pid && identity === 'fixture-provider-start' ? 'live' : 'unknown',
}));

describe('runtime v2 startup inbox dispatch', () => {
  type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };

  let cwd: string;
  let restoreFixtureEnv: (() => void) | undefined;
  let startupDeliveryGate: Deferred<void> | undefined;
  const originalCwd = process.cwd();

  function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>['resolve'];
    let reject!: Deferred<T>['reject'];
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  async function mkdtempFixture(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousOmcStateDir = process.env.OMC_STATE_DIR;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
    restoreFixtureEnv = () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = previousOmcStateDir;
    };
    return root;
  }

  async function flushRealIo(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  type RecoveryProvider = 'codex' | 'cursor';

  async function seedOwnerRecoveryFixture(
    provider: RecoveryProvider,
    label: string,
  ): Promise<{ teamName: string; requestId: string; recoveryId: string; correlationKey: string }> {
    const teamName = 'dispatch-team';
    const requestId = `owner-${provider}-${label}-request`;
    const recoveryId = `owner-${provider}-${label}-recovery`;
    const createdAt = new Date().toISOString();
    const launchDescriptor = {
      schema_version: 1,
      provider,
      model: null,
      binary: `/usr/bin/${provider}`,
      args: [],
    };
    const worker = {
      name: 'worker-1',
      index: 1,
      worker_cli: provider,
      launch_descriptor: launchDescriptor,
      assigned_tasks: [],
      pane_id: '%91',
      working_dir: cwd,
    };
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    await mkdir(join(configPath, '..'), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      name: teamName,
      task: 'owner recovery startup settlement',
      agent_type: provider,
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [worker],
      created_at: createdAt,
      tmux_session: 'dispatch-session',
      state_revision: 0,
      lifecycle_state: 'active',
      leader_pane_id: '%1',
      next_task_id: 1,
      workspace_mode: 'single',
      worktree_mode: 'disabled',
      service_descriptor: {
        schema_version: 1,
        service_generation: 1,
        service_attempt_id: 'service-attempt',
        auto_merge_enabled: false,
        workspace_root: cwd,
        cadence_policy: 'disabled',
      },
    }), 'utf8');
    await writeFile(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify({
      schema_version: 2,
      state_revision: 0,
      name: teamName,
      task: 'owner recovery startup settlement',
      leader: { session_id: 'dispatch-session', worker_id: 'leader-fixed', role: 'leader' },
      tmux_session: 'dispatch-session',
      worker_count: 1,
      workers: [worker],
      next_task_id: 1,
      created_at: createdAt,
    }), 'utf8');
    reserveRecoveryRequest(cwd, requestId, {
      operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'),
      teamName,
      workerName: 'worker-1',
    }, recoveryId);
    return {
      teamName,
      requestId,
      recoveryId,
      correlationKey: `recovery:${recoveryId}:attempt-worker-1`,
    };
  }

  function configureOwnerPaneLifecycle(): Set<string> {
    const deadPanes = new Set(['%91']);
    launchMocks.loadCurrentWorkerLaunchAttempt.mockResolvedValue(null);
    launchMocks.isWorkerLaunchAttemptCurrent.mockResolvedValue(true);
    mocks.getWorkerLiveness.mockImplementation(async (paneId: string) => (
      deadPanes.has(paneId) ? 'dead' : 'alive'
    ));
    mocks.killOwnedWorkerPane.mockImplementation(async (ownership: { paneId: string }) => {
      deadPanes.add(ownership.paneId);
    });
    return deadPanes;
  }

  type OwnerEvidenceMode = 'current' | 'stale' | 'none' | 'probe-throw';

  function configureOwnerEvidenceProbe(
    mode: OwnerEvidenceMode,
    probeGate: Deferred<void>,
    evidenceGate: Deferred<void>,
  ): void {
    mocks.probeStartupPaneActivity.mockImplementation(async (context: {
      attempt: { attempt_id: string; team_name: string; worker_name: string };
    }) => {
      probeGate.resolve();
      if (mode === 'probe-throw') throw new Error('activity probe failed');
      if (mode === 'none') return 'busy';
      setTimeout(() => {
        void (async () => {
          const workerDir = absPath(cwd, TeamPaths.workerDir(
            context.attempt.team_name,
            context.attempt.worker_name,
          ));
          await mkdir(workerDir, { recursive: true });
          await writeFile(absPath(cwd, TeamPaths.workerStatus(
            context.attempt.team_name,
            context.attempt.worker_name,
          )), JSON.stringify({
            state: 'working',
            current_task_id: '1',
            updated_at: new Date().toISOString(),
            launch_attempt_id: mode === 'current' ? context.attempt.attempt_id : 'stale-attempt',
          }), 'utf8');
        })().then(evidenceGate.resolve, evidenceGate.reject);
      }, 1_500);
      return 'busy';
    });
  }

  async function seedRecoveryDispatchCheckpoint(
    fixture: { teamName: string; recoveryId: string; correlationKey: string },
    status: 'pending' | 'notified' | 'failed',
  ): Promise<void> {
    const queued = await enqueueDispatchRequest(fixture.teamName, {
      kind: 'inbox',
      to_worker: 'worker-1',
      worker_index: 1,
      pane_id: '%2',
      trigger_message: 'restart checkpoint dispatch',
      transport_preference: 'transport_direct',
      fallback_allowed: true,
      inbox_correlation_key: fixture.correlationKey,
    }, cwd);
    if (status !== 'pending') {
      await transitionDispatchRequest(
        fixture.teamName,
        queued.request.request_id,
        'pending',
        status,
        { last_reason: `checkpoint_${status}` },
        cwd,
      );
    }
  }

  it('does not require progress evidence for an idle prompt-mode recovery', () => {
    expect(promptModeRecoveryRequiresProgressEvidence(true, 0)).toBe(false);
    expect(promptModeRecoveryRequiresProgressEvidence(true, 1)).toBe(true);
    expect(promptModeRecoveryRequiresProgressEvidence(false, 0)).toBe(false);
  });
  beforeEach(() => {
    vi.resetModules();
    atomicWriteControl.failCanonicalPath = undefined;
    atomicWriteControl.triggerReadPath = undefined;
    atomicWriteControl.corruptSiblingPath = undefined;
    atomicWriteControl.readTriggered = false;
    startupDeliveryGate = undefined;
    mocks.createTeamSession.mockReset();
    mocks.spawnWorkerInPane.mockReset();
    mocks.spawnOwnedWorkerInPane.mockReset();
    mocks.deliverStartupInbox.mockReset();
    mocks.probeStartupPaneActivity.mockReset();
    mocks.retryStartupInboxSubmit.mockReset();
    mocks.sendToWorker.mockReset();
    mocks.waitForPaneReady.mockReset();
    mocks.applyMainVerticalLayout.mockReset();
    mocks.killWorkerPanes.mockReset();
    mocks.killTeamSession.mockReset();
    mocks.resolveSplitPaneWorkerPaneIds.mockReset();
    mocks.killOwnedWorkerPane.mockClear();
    mocks.getWorkerLiveness.mockReset();
    mocks.workerPaneBelongsToProviderTarget.mockReset();
    mocks.killTeamSession.mockResolvedValue(undefined);
    mocks.killWorkerPanes.mockResolvedValue(undefined);
    mocks.resolveSplitPaneWorkerPaneIds.mockImplementation(async (_session: string | undefined, paneIds: string[]) => paneIds);
    mocks.getWorkerLiveness.mockImplementation(async () => mocks.killOwnedWorkerPane.mock.calls.length > 0 ? 'dead' : 'alive');
    mocks.workerPaneBelongsToProviderTarget.mockResolvedValue(true);
    mocks.execFile.mockReset();
    mocks.spawnSync.mockReset();
    modelContractMocks.buildWorkerArgv.mockReset();
    modelContractMocks.resolveValidatedBinaryPath.mockReset();
    modelContractMocks.getWorkerEnv.mockReset();
    modelContractMocks.isPromptModeAgent.mockReset();
    modelContractMocks.getPromptModeArgs.mockReset();
    modelContractMocks.resolveClaudeWorkerModel.mockReset();
    modelContractMocks.buildValidatedWorkerLaunchDescriptor.mockClear();
    modelContractMocks.validateWorkerLaunchDescriptor.mockClear();
    mergeMocks.startMergeOrchestrator.mockReset();
    mergeMocks.recoverFromRestart.mockReset();
    mergeMocks.registerWorker.mockReset();
    mergeMocks.unregisterWorker.mockReset();
    mergeMocks.drainAndStop.mockReset();
    cadenceMocks.installCommitCadence.mockReset();
    cadenceMocks.startFallbackPoller.mockReset();
    cadenceMocks.uninstallCommitCadence.mockReset();
    launchMocks.withWorkerLaunchAttemptFence.mockReset();
    launchMocks.withWorkerLaunchAttemptFence.mockImplementation(async (_attempt: unknown, fn: () => Promise<unknown>) => ({ ok: true as const, value: await fn() }));
    launchMocks.retireWorkerLaunchAttempt.mockReset();
    launchMocks.retireWorkerLaunchAttempt.mockResolvedValue(true);
    launchMocks.terminateWorkerLaunchProvider.mockReset();
    launchMocks.terminateWorkerLaunchProvider.mockResolvedValue(true);
    launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt.mockReset();
    launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt.mockImplementation(async (_attempt: unknown, _reason: string, cleanup: () => Promise<boolean>) => cleanup());
    launchMocks.loadWorkerLaunchAttempt.mockReset();
    launchMocks.loadWorkerLaunchAttempt.mockResolvedValue({});
    launchMocks.loadCurrentWorkerLaunchAttempt.mockReset();
    launchMocks.loadCurrentWorkerLaunchAttempt.mockResolvedValue(null);
    launchMocks.isWorkerLaunchAttemptAccepted.mockReset();
    launchMocks.isWorkerLaunchAttemptAccepted.mockResolvedValue(true);
    launchMocks.isWorkerLaunchAttemptCurrent.mockReset();
    launchMocks.isWorkerLaunchAttemptCurrent.mockResolvedValue(true);

    mocks.createTeamSession.mockResolvedValue({
      sessionName: 'dispatch-session',
      leaderPaneId: '%1',
      workerPaneIds: [],
      sessionMode: 'split-pane',
    });
    mocks.spawnWorkerInPane.mockResolvedValue(undefined);
    mocks.autoStartupEvidence = true;
    mocks.nextStartupTaskId = 1;
    mocks.nextSplitPaneId = 2;
    mocks.cmuxSplitPaneId = null;
    mocks.spawnOwnedWorkerInPane.mockImplementation(async (
      sessionName: string,
      ownership: { paneId: string },
      config: {
        teamName: string;
        workerName: string;
        provider: string;
        envVars?: Record<string, string>;
      },
    ) => {
      const attempt = {
        schema_version: 1,
        attempt_id: `attempt-${config.workerName}`,
        nonce: `nonce-${config.workerName}`,
        team_name: config.teamName,
        worker_name: config.workerName,
        pane_id: ownership.paneId,
        provider: config.provider,
        created_at: new Date().toISOString(),
        expectedPath: '/tmp/expected.json',
        ackPath: '/tmp/ack.json',
        decisionPath: '/tmp/decision.json',
        runtimeCliPath: '/tmp/runtime-cli.cjs',
      };
      await mocks.spawnWorkerInPane(sessionName, ownership.paneId, {
        ...config,
        envVars: {
          ...config.envVars,
          OMC_WORKER_LAUNCH_ATTEMPT_ID: attempt.attempt_id,
        },
      });
      const recoveryGateSpec = config.envVars?.OMC_RECOVERY_GATE_SPEC;
      if (recoveryGateSpec) {
        const gate = JSON.parse(recoveryGateSpec) as {
          recoveryId: string;
          workerName: string;
          replacementGeneration: number;
          paneAttemptId: string;
          readyPath: string;
          runPath: string;
        };
        const launchAttempt = {
          recovery_id: gate.recoveryId,
          worker_name: gate.workerName,
          replacement_generation: gate.replacementGeneration,
          pane_attempt_id: gate.paneAttemptId,
          launch_attempt_id: attempt.attempt_id,
          launch_nonce: attempt.nonce,
          written_at: new Date().toISOString(),
        };
        await mkdir(join(gate.readyPath, '..'), { recursive: true });
        await writeFile(gate.readyPath, JSON.stringify(launchAttempt), 'utf8');
        await writeFile(`${gate.readyPath}.adoption-ready`, JSON.stringify(launchAttempt), 'utf8');
        await writeFile(`${gate.runPath}.launched`, JSON.stringify({
          ...launchAttempt,
          provider_pid: process.pid,
          provider_start_identity: 'fixture-provider-start',
        }), 'utf8');

        const manifestPath = absPath(cwd, TeamPaths.manifest(config.teamName));
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          workers?: Array<Record<string, unknown>>;
        };
        manifest.workers = (manifest.workers ?? []).map(worker => worker.name === gate.workerName
          ? {
            ...worker,
            pane_id: ownership.paneId,
            pane_attempt_id: gate.paneAttemptId,
            recovery_id: gate.recoveryId,
            replacement_generation: gate.replacementGeneration,
            worker_cli: config.provider,
          }
          : worker);
        await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
      }
      return {
        ownership,
        provider: config.provider,
        attempt,
      };
    });
    mocks.deliverStartupInbox.mockImplementation(async (context: { attempt: { attempt_id: string; team_name: string; worker_name: string }; ownership: { paneId: string } }, message: string) => {
      const sent = await mocks.sendToWorker('', context.ownership.paneId, message);
      if (!sent) {
        startupDeliveryGate?.resolve();
        return { ok: false, reason: 'startup_send_failed' };
      }
      if (mocks.autoStartupEvidence) {
        const taskId = String(mocks.nextStartupTaskId++);
        const workerDir = join(cwd, '.omc', 'state', 'team', context.attempt.team_name, 'workers', context.attempt.worker_name);
        await mkdir(workerDir, { recursive: true });
        await writeFile(join(workerDir, 'status.json'), JSON.stringify({
          state: 'working',
          current_task_id: taskId,
          updated_at: new Date().toISOString(),
          launch_attempt_id: context.attempt.attempt_id,
        }), 'utf8');
      }
      startupDeliveryGate?.resolve();
      return { ok: true, kind: 'attempted_unconfirmed' };
    });
    mocks.probeStartupPaneActivity.mockResolvedValue('unknown');
    mocks.retryStartupInboxSubmit.mockResolvedValue('unavailable');
    mocks.waitForPaneReady.mockResolvedValue(true);
    mocks.sendToWorker.mockResolvedValue(true);
    mocks.applyMainVerticalLayout.mockResolvedValue(undefined);
    mocks.spawnSync.mockReturnValue({ status: 0 });
    modelContractMocks.buildWorkerArgv.mockImplementation((agentType?: string) => [`/usr/bin/${agentType ?? 'claude'}`]);
    modelContractMocks.resolveValidatedBinaryPath.mockImplementation((agentType?: string) => `/usr/bin/${agentType ?? 'claude'}`);
    modelContractMocks.getWorkerEnv.mockImplementation((...args: unknown[]) => {
      const teamName = typeof args[0] === 'string' ? args[0] : 'dispatch-team';
      const workerName = typeof args[1] === 'string' ? args[1] : 'worker-1';
      return { OMC_TEAM_WORKER: `${teamName}/${workerName}` };
    });
    modelContractMocks.isPromptModeAgent.mockReturnValue(false);
    modelContractMocks.getPromptModeArgs.mockImplementation((_agentType: string, instruction: string) => [instruction]);
    modelContractMocks.resolveClaudeWorkerModel.mockReturnValue(undefined);
    mergeMocks.recoverFromRestart.mockResolvedValue(undefined);
    mergeMocks.registerWorker.mockResolvedValue(undefined);
    mergeMocks.unregisterWorker.mockResolvedValue(undefined);
    mergeMocks.drainAndStop.mockResolvedValue({ unmerged: [] });
    mergeMocks.startMergeOrchestrator.mockImplementation(async () => ({
      registerWorker: mergeMocks.registerWorker,
      unregisterWorker: mergeMocks.unregisterWorker,
      drainAndStop: mergeMocks.drainAndStop,
    }));
    cadenceMocks.installCommitCadence.mockResolvedValue({ method: 'hook' });
    cadenceMocks.startFallbackPoller.mockImplementation(() => ({ stop: vi.fn() }));
    cadenceMocks.uninstallCommitCadence.mockResolvedValue(undefined);
    mocks.execFile.mockImplementation((_file: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args[0] === 'split-window') {
        cb(null, '%2\n', '');
        return;
      }
      cb(null, '', '');
    });
    (mocks.execFile as unknown as Record<PropertyKey, unknown>)[promisify.custom] = async (_file: string, args: string[]) => {
      if (args[0] === 'split-window') {
        return { stdout: '%2\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    mocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'split-window') {
        return { stdout: `%${mocks.nextSplitPaneId++}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS;
    startupDeliveryGate = undefined;
    restoreFixtureEnv?.();
    restoreFixtureEnv = undefined;
    process.chdir(originalCwd);
    if (cwd) await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('writes durable inbox dispatch evidence when startup worker notification succeeds', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-dispatch-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify startup dispatch evidence' }],
      cwd,
    });

    expect(runtime.teamName).toBe('dispatch-team');
    expect(mocks.createTeamSession).toHaveBeenCalledWith('dispatch-team', 0, cwd, { newWindow: false });

    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.to_worker).toBe('worker-1');
    expect(requests[0]?.status).toBe('notified');
    expect(requests[0]?.transport_preference).toBe('transport_direct');
    expect(requests[0]?.fallback_allowed).toBe(true);
    expect(requests[0]?.inbox_correlation_key).toBe('startup:worker-1:1:attempt-worker-1');
    expect(requests[0]?.trigger_message).toContain('$OMC_TEAM_STATE_ROOT/workers/worker-1/inbox.md');
    expect(requests[0]?.trigger_message).toContain('execute now');
    expect(requests[0]?.trigger_message).toContain('concrete progress');

    const inboxPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'inbox.md');
    const inbox = await readFile(inboxPath, 'utf-8');
    expect(inbox).toContain('Dispatch test');
    expect(inbox).toContain('ACK/progress replies are not a stop signal');
    expect(mocks.sendToWorker).toHaveBeenCalledWith(
      '',
      '%2',
      expect.stringContaining('concrete progress'),
    );
    expect(mocks.spawnWorkerInPane).toHaveBeenCalledWith(
      'dispatch-session',
      '%2',
      expect.objectContaining({
        envVars: expect.objectContaining({
          OMC_TEAM_WORKER: 'dispatch-team/worker-1',
          OMC_TEAM_STATE_ROOT: join(cwd, '.omc', 'state', 'team', 'dispatch-team'),
          OMC_TEAM_LEADER_CWD: cwd,
        }),
      }),
    );
    expect(mocks.applyMainVerticalLayout).toHaveBeenCalledWith('dispatch-session', { required: true });
    const layoutOrder = mocks.applyMainVerticalLayout.mock.invocationCallOrder[0];
    const ownedSpawnOrder = mocks.spawnOwnedWorkerInPane.mock.invocationCallOrder[0];
    const providerOrder = mocks.spawnWorkerInPane.mock.invocationCallOrder[0];
    const inboxOrder = mocks.deliverStartupInbox.mock.invocationCallOrder[0];
    expect(layoutOrder).toBeLessThan(ownedSpawnOrder);
    expect(ownedSpawnOrder).toBeLessThan(providerOrder);
    expect(layoutOrder).toBeLessThan(providerOrder);
    expect(providerOrder).toBeLessThan(inboxOrder);
    const config = JSON.parse(await readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'config.json'), 'utf-8'));
    const manifest = JSON.parse(await readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'manifest.json'), 'utf-8'));
    expect(config.workers[0].launch_descriptor).toMatchObject({ provider: 'claude', binary: '/usr/bin/claude', args: [] });
    expect(manifest.workers[0].launch_descriptor).toEqual(config.workers[0].launch_descriptor);
    expect(config.service_descriptor).toMatchObject({ schema_version: 1, auto_merge_enabled: false, cadence_policy: 'disabled' });
  });

  it('does not publish a corrupt canonical task when startup publication is interrupted', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-atomic-task-publication-');
    const taskPath = absPath(cwd, TeamPaths.taskFile('dispatch-team', '1'));
    atomicWriteControl.failCanonicalPath = taskPath;
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Interrupted task', description: 'Must not leave a torn task file.' }],
      cwd,
    })).rejects.toThrow('injected_task_publication_interruption');

    await expect(readFile(taskPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.createTeamSession).not.toHaveBeenCalled();
  });

  it('persists dependencies and leaves dependent tasks out of startup dispatch', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-dependencies-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 2,
      agentTypes: ['claude', 'claude'],
      tasks: [
        { subject: 'Root task', description: 'Run first.' },
        { subject: 'Dependent task', description: 'Run second.', depends_on: ['1'] },
      ],
      cwd,
    });

    const dependent = JSON.parse(await readFile(
      join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks', 'task-2.json'),
      'utf8',
    )) as { depends_on?: string[]; status?: string; version?: number; result?: unknown };
    expect(dependent).toMatchObject({ depends_on: ['1'], status: 'pending', version: 1 });
    expect(dependent).not.toHaveProperty('result');
    expect(runtime.config.workers[1]?.pane_id).toBeUndefined();
    expect(runtime.config.workers[1]?.assigned_tasks).toEqual([]);
    expect(mocks.spawnWorkerInPane).toHaveBeenCalledTimes(1);
    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests.map(request => request.to_worker)).toEqual(['worker-1']);
  });

  it.each([
    ['out-of-range', [{ subject: 'Only task', description: 'invalid', depends_on: ['2'] }]],
    ['self-reference', [{ subject: 'Self task', description: 'invalid', depends_on: ['1'] }]],
    ['duplicate', [
      { subject: 'First task', description: 'valid' },
      { subject: 'Second task', description: 'valid' },
      { subject: 'Duplicate dependency', description: 'invalid', depends_on: ['1', '1'] },
    ]],
    ['mismatched-fields', [{
      subject: 'Mismatched fields',
      description: 'invalid',
      depends_on: ['1'],
      blocked_by: ['2'],
    }]],
    ['non-string-id', [{
      subject: 'Non-string dependency',
      description: 'invalid',
      depends_on: [1] as unknown as string[],
    }]],
    ['cycle', [
      { subject: 'First task', description: 'invalid', depends_on: ['2'] },
      { subject: 'Second task', description: 'invalid', depends_on: ['1'] },
    ]],
  ])('rejects %s task dependencies before startup side effects', async (_label, tasks) => {
    cwd = await mkdtempFixture('omc-runtime-v2-invalid-dependencies-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks,
      cwd,
    })).rejects.toThrow(/(?:invalid_task_dependenc(?:y|ies)|cyclic_task_dependency)/);
    expect(mocks.createTeamSession).not.toHaveBeenCalled();
    await expect(readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'config.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['unknown', [{ subject: 'Unknown owner', description: 'invalid', owner: 'worker-9' }]],
    ['blank', [{ subject: 'Blank owner', description: 'invalid', owner: '   ' }]],
    ['null', [{ subject: 'Null owner', description: 'invalid', owner: null as unknown as string }]],
    ['non-string', [{ subject: 'Numeric owner', description: 'invalid', owner: 7 as unknown as string }]],
    ['blocked unknown', [
      { subject: 'Root task', description: 'valid' },
      { subject: 'Blocked task', description: 'invalid', depends_on: ['1'], owner: 'worker-9' },
    ]],
  ])('rejects %s explicit task owner before state or pane side effects', async (_label, tasks) => {
    cwd = await mkdtempFixture('omc-runtime-v2-invalid-owner-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks,
      cwd,
    })).rejects.toThrow('invalid_task_owner');

    expect(mocks.createTeamSession).not.toHaveBeenCalled();
    await expect(readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'config.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks', 'task-1.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delivers trusted Cursor reviewer guidance in the default non-worktree inbox', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-cursor-bootstrap-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    await startTeamV2({
      teamName: 'cursor-bootstrap-team',
      workerCount: 1,
      agentTypes: ['cursor'],
      tasks: [{
        subject: 'Review the implementation',
        description: 'Inspect the change without editing files.',
        role: 'critic',
      }],
      cwd,
    });

    const config = JSON.parse(await readFile(
      join(cwd, '.omc', 'state', 'team', 'cursor-bootstrap-team', 'config.json'),
      'utf-8',
    ));
    expect(config.workers[0].role).toBe('critic');
    const inbox = await readFile(
      join(cwd, '.omc', 'state', 'team', 'cursor-bootstrap-team', 'workers', 'worker-1', 'inbox.md'),
      'utf-8',
    );
    expect(inbox).toContain('Agent-Type Guidance (cursor)');
    expect(inbox).toContain('The trusted runtime has provided a "REQUIRED: Structured Verdict Output" section');
    expect(inbox).toContain('do NOT edit, create, or delete any file');
    expect(inbox).toContain('The leader consumes your structured verdict to transition the task');
    expect(inbox).toContain('do NOT run `omc team api transition-task-status` for this reviewer assignment');
    expect(inbox).toContain('do NOT type `/exit` unless the leader sends an explicit shutdown');
    expect(inbox).toContain('REQUIRED: Structured Verdict Output');
    expect(inbox).toContain('Review the implementation');
  });

  it('settles every tmux worker between its split and provider spawn', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-layout-order-multi-');
    mocks.tmuxExecAsync.mockClear();
    mocks.applyMainVerticalLayout.mockClear();
    mocks.spawnOwnedWorkerInPane.mockClear();
    mocks.spawnWorkerInPane.mockClear();
    const { startTeamV2 } = await import('../runtime-v2.js');

    await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 2,
      agentTypes: ['claude', 'claude'],
      tasks: [
        { subject: 'Dispatch one', description: 'Verify first worker layout ordering' },
        { subject: 'Dispatch two', description: 'Verify second worker layout ordering' },
      ],
      cwd,
    });

    const splitOrders = mocks.tmuxExecAsync.mock.calls
      .map((call, index) => ({
        args: call[0] as string[],
        order: mocks.tmuxExecAsync.mock.invocationCallOrder[index]!,
      }))
      .filter(call => call.args[0] === 'split-window')
      .map(call => call.order);
    const layoutOrders = mocks.applyMainVerticalLayout.mock.invocationCallOrder;
    const ownedSpawnOrders = mocks.spawnOwnedWorkerInPane.mock.invocationCallOrder;
    const providerOrders = mocks.spawnWorkerInPane.mock.invocationCallOrder;

    expect(splitOrders).toHaveLength(2);
    expect(layoutOrders).toHaveLength(2);
    expect(ownedSpawnOrders).toHaveLength(2);
    expect(providerOrders).toHaveLength(2);
    for (let index = 0; index < 2; index++) {
      expect(splitOrders[index]!).toBeLessThan(layoutOrders[index]!);
      expect(layoutOrders[index]!).toBeLessThan(ownedSpawnOrders[index]!);
      expect(ownedSpawnOrders[index]!).toBeLessThan(providerOrders[index]!);
    }
  });

  it('leaves cmux startup on its native split and provider path', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-cmux-layout-isolation-');
    mocks.createTeamSession.mockResolvedValueOnce({
      sessionName: 'cmux:workspace-1',
      leaderPaneId: 'cmux-leader-1',
      workerPaneIds: [],
      sessionMode: 'split-pane',
    });
    mocks.cmuxSplitPaneId = 'cmux-worker-1';
    const { startTeamV2 } = await import('../runtime-v2.js');

    await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Cmux dispatch', description: 'Keep tmux layout commands out of cmux' }],
      cwd,
    });

    expect(mocks.applyMainVerticalLayout).not.toHaveBeenCalled();
    expect(mocks.spawnOwnedWorkerInPane).toHaveBeenCalledWith(
      'cmux:workspace-1',
      expect.objectContaining({ provider: 'cmux', paneId: 'cmux-worker-1' }),
      expect.objectContaining({ workerName: 'worker-1' }),
    );
    expect(mocks.spawnWorkerInPane).toHaveBeenCalledWith(
      'cmux:workspace-1',
      'cmux-worker-1',
      expect.objectContaining({ workerName: 'worker-1' }),
    );
    expect(mocks.deliverStartupInbox).toHaveBeenCalled();
  });

  it('persists startup task delegation plans and gives executable result evidence instructions', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-delegation-startup-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{
        subject: 'Investigate flaky runtime behavior',
        description: 'Investigate flaky runtime behavior across the team runtime',
        delegation: {
          mode: 'auto',
          required_parallel_probe: true,
          skip_allowed_reason_required: true,
        },
      }],
      cwd,
    });

    const taskPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks', 'task-1.json');
    const task = JSON.parse(await readFile(taskPath, 'utf-8')) as { delegation?: { mode?: string; required_parallel_probe?: boolean } };
    expect(task.delegation).toMatchObject({
      mode: 'auto',
      required_parallel_probe: true,
    });

    const inboxPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'inbox.md');
    const inbox = await readFile(inboxPath, 'utf-8');
    expect(inbox).toContain('"result"');
    expect(inbox).toContain('Subagent skip reason:');
    expect(inbox).toContain('only when explicitly allowed by the leader');
  });

  it('preserves startup failure evidence when a worker launch throws after scaffolding', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-startup-failure-');
    mocks.spawnWorkerInPane.mockRejectedValueOnce(new Error('claude launch exploded'));
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify startup failure evidence' }],
      cwd,
    })).rejects.toThrow('claude launch exploded');

    const markerPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'startup-failure.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf-8')) as {
      reason?: string;
      error?: string;
      recorded_at?: string;
    };
    expect(marker.reason).toBe('startup_failed_before_config_persisted');
    expect(marker.error).toContain('claude launch exploded');
    expect(marker.recorded_at).toBeTruthy();
    expect(mocks.killTeamSession).not.toHaveBeenCalled();
  });

  it('does not persist sensitive cmux worker command payloads in startup failure evidence', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-redacted-startup-failure-');
    const secret = 'SECRET_TOKEN_SHOULD_NOT_LEAK';
    modelContractMocks.getWorkerEnv.mockImplementation(() => ({
      OMC_TEAM_WORKER: 'dispatch-team/worker-1',
      SECRET_ENV: secret,
    }));
    modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/claude', '--api-key', secret]);
    mocks.spawnWorkerInPane.mockRejectedValueOnce(new Error(
      'cmux command failed for both current and legacy forms: current=send-surface ([redacted]); legacy=send ([redacted])',
    ));
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify redacted startup failure evidence' }],
      cwd,
    })).rejects.toThrow(/cmux command failed for both current and legacy forms/);

    const markerPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'startup-failure.json');
    const markerText = await readFile(markerPath, 'utf-8');
    expect(markerText).toContain('current=send-surface');
    expect(markerText).toContain('legacy=send');
    expect(markerText).not.toContain(secret);
    expect(markerText).not.toContain('SECRET_ENV');
    expect(markerText).not.toContain('--api-key');
  });

  it('does not persist sensitive primary cmux failure payloads in startup failure evidence', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-redacted-primary-failure-');
    const secret = 'SECRET_TOKEN_SHOULD_NOT_LEAK';
    modelContractMocks.getWorkerEnv.mockImplementation(() => ({
      OMC_TEAM_WORKER: 'dispatch-team/worker-1',
      SECRET_ENV: secret,
    }));
    modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/claude', '--api-key', secret]);
    mocks.spawnWorkerInPane.mockRejectedValueOnce(new Error(
      'cmux command failed for current form: current=send-surface (cmux transport timed out after partial write [redacted])',
    ));
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify redacted primary failure evidence' }],
      cwd,
    })).rejects.toThrow(/cmux command failed for current form/);

    const markerPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'startup-failure.json');
    const markerText = await readFile(markerPath, 'utf-8');
    expect(markerText).toContain('current=send-surface');
    expect(markerText).toContain('cmux transport timed out after partial write');
    expect(markerText).not.toContain(secret);
    expect(markerText).not.toContain('SECRET_ENV');
    expect(markerText).not.toContain('--api-key');
  });

  it('keeps dirty worktree preservation metadata when startup rollback records failure evidence', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-dirty-startup-failure-');
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    await writeFile(join(cwd, 'README.md'), 'dirty startup failure test\n', 'utf-8');
    await writeFile(join(cwd, 'AGENTS.md'), 'root agents\n', 'utf-8');
    execFileSync('git', ['add', 'README.md', 'AGENTS.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'pipe' });
    mocks.spawnWorkerInPane.mockImplementationOnce(async (_session, _pane, paneConfig: { cwd?: string }) => {
      await writeFile(join(paneConfig.cwd ?? cwd, 'dirty-startup.txt'), 'preserve me\n', 'utf-8');
      throw new Error('claude launch exploded after dirty worktree');
    });
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      pluginConfig: { team: { ops: { worktreeMode: 'named' } } },
      tasks: [{ subject: 'Dispatch test', description: 'Verify dirty worktree preservation evidence' }],
      cwd,
    })).rejects.toThrow('claude launch exploded after dirty worktree');

    const markerPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'startup-failure.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf-8')) as {
      error?: string;
      preserved?: Array<{ workerName?: string; path?: string; reason?: string }>;
    };
    const backupPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'worktree-root-agents.json');
    const worktreePath = join(cwd, '.omc', 'team', 'dispatch-team', 'worktrees', 'worker-1');
    expect(marker.error).toContain('claude launch exploded after dirty worktree');
    expect(marker.preserved?.[0]).toMatchObject({
      workerName: 'worker-1',
      path: worktreePath,
    });
    expect(marker.preserved?.[0]?.reason).toContain('worktree_dirty');
    await expect(readFile(backupPath, 'utf-8')).resolves.toContain('root agents');
    await expect(readFile(join(worktreePath, 'dirty-startup.txt'), 'utf-8')).resolves.toBe('preserve me\n');
  });


  it('persists runtime-v2 worktree contract fields for split-pane teams', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-worktree-contract-');
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    await writeFile(join(cwd, 'README.md'), 'worktree contract test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'pipe' });

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      pluginConfig: { team: { ops: { worktreeMode: 'named' } } },
      tasks: [{ subject: 'Worktree contract', description: 'Verify runtime-v2 worktree metadata' }],
      cwd,
    });

    expect(runtime.ownsWindow).toBe(false);
    expect(runtime.config.workspace_mode).toBe('worktree');
    expect(runtime.config.worktree_mode).toBe('named');
    expect(runtime.config.workers[0]).toMatchObject({
      working_dir: join(cwd, '.omc', 'team', 'dispatch-team', 'worktrees', 'worker-1'),
      worktree_repo_root: cwd,
      worktree_branch: 'omc-team/dispatch-team/worker-1',
      worktree_detached: false,
      worktree_created: true,
    });
    expect(mocks.spawnOwnedWorkerInPane).toHaveBeenCalledWith(
      'dispatch-session',
      expect.objectContaining({ paneId: '%2' }),
      expect.objectContaining({
        cwd: join(cwd, '.omc', 'team', 'dispatch-team', 'worktrees', 'worker-1'),
        launchStateCwd: cwd,
      }),
    );

    const configPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'config.json');
    const manifestPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'manifest.json');
    const persisted = JSON.parse(await readFile(configPath, 'utf-8'));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    expect(persisted.state_revision).toBe(1);
    expect(manifest.state_revision).toBe(1);
    expect(persisted.workspace_mode).toBe('worktree');
    expect(persisted.worktree_mode).toBe('named');
    expect(manifest.workspace_mode).toBe('worktree');
    expect(manifest.worktree_mode).toBe('named');

    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests[0]?.trigger_message).toContain('$OMC_TEAM_STATE_ROOT/workers/worker-1/inbox.md');
    expect(requests[0]?.trigger_message).not.toContain('$OMC_TEAM_STATE_ROOT/team/dispatch-team');
    expect(runtime.config.team_state_root).toBeDefined();
    const teamStateRoot = runtime.config.team_state_root!;
    expect(requests[0]?.trigger_message.replace('$OMC_TEAM_STATE_ROOT', teamStateRoot))
      .toContain(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'inbox.md'));

    const overlay = await readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'AGENTS.md'), 'utf-8');
    expect(overlay).toContain('$OMC_TEAM_STATE_ROOT/workers/worker-1/status.json');
    expect(overlay).not.toContain('$OMC_TEAM_STATE_ROOT/team/dispatch-team');
  });

  it('fails loudly when explicit auto-merge worker registration fails', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-auto-merge-fail-');
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    await writeFile(join(cwd, 'README.md'), 'auto merge fail loud test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feature-auto-merge'], { cwd, stdio: 'pipe' });
    mergeMocks.registerWorker.mockRejectedValueOnce(new Error('registration exploded'));

    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Auto merge fail', description: 'Registration failure must abort startup' }],
      cwd,
      autoMerge: true,
    })).rejects.toThrow(/auto-merge startup failed: registration exploded/);

    expect(mergeMocks.startMergeOrchestrator).toHaveBeenCalledTimes(1);
    expect(mergeMocks.registerWorker).toHaveBeenCalledWith('worker-1');
    expect(cadenceMocks.installCommitCadence).toHaveBeenCalledWith(expect.objectContaining({
      teamName: 'dispatch-team',
      workerName: 'worker-1',
      agentType: 'claude',
      enabled: true,
    }));
    expect(cadenceMocks.uninstallCommitCadence).toHaveBeenCalledWith(expect.objectContaining({
      workerName: 'worker-1',
    }));
  });

  it('wires auto-merge worker cadence and drains before unregistering on shutdown', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-auto-merge-cadence-');
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    await writeFile(join(cwd, 'README.md'), 'auto merge cadence test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feature-auto-merge'], { cwd, stdio: 'pipe' });
    cadenceMocks.installCommitCadence.mockResolvedValue({ method: 'fallback-poll' });

    const { startTeamV2, shutdownTeamV2 } = await import('../runtime-v2.js');

    await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['codex'],
      tasks: [{ subject: 'Auto merge cadence', description: 'Install fallback cadence and drain at shutdown' }],
      cwd,
      autoMerge: true,
    });

    expect(cadenceMocks.installCommitCadence).toHaveBeenCalledWith(expect.objectContaining({
      teamName: 'dispatch-team',
      workerName: 'worker-1',
      agentType: 'codex',
      enabled: true,
      worktreePath: join(cwd, '.omc', 'team', 'dispatch-team', 'worktrees', 'worker-1'),
    }));
    expect(cadenceMocks.startFallbackPoller).toHaveBeenCalledWith(
      join(cwd, '.omc', 'team', 'dispatch-team', 'worktrees', 'worker-1'),
      'worker-1',
    );

    await shutdownTeamV2('dispatch-team', cwd, { timeoutMs: 0, force: true });

    // This shutdown may be preserved (alive panes) or succeed (dead panes).
    // On preserved/rollback: orchestration is preserved for retry.
    // On success: drainAndStop is called by terminal finalization.
    if (mergeMocks.drainAndStop.mock.calls.length > 0) {
      expect(mergeMocks.drainAndStop.mock.invocationCallOrder[0])
        .toBeLessThan((mergeMocks.unregisterWorker.mock.invocationCallOrder[0] ?? Infinity));
    }
  });

  it('drains auto-merge before preserving state for live worker panes on shutdown', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-auto-merge-live-pane-');
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    await writeFile(join(cwd, 'README.md'), 'auto merge live pane test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feature-auto-merge'], { cwd, stdio: 'pipe' });
    cadenceMocks.installCommitCadence.mockResolvedValue({ method: 'fallback-poll' });
    mocks.getWorkerLiveness.mockResolvedValue('alive');

    const { startTeamV2, shutdownTeamV2 } = await import('../runtime-v2.js');

    await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['codex'],
      tasks: [{ subject: 'Auto merge cadence', description: 'Drain before live-pane preserve' }],
      cwd,
      autoMerge: true,
    });

    await shutdownTeamV2('dispatch-team', cwd, { timeoutMs: 0, force: true });

    // Retryable shutdown rollback preserves orchestration: drainAndStop
    // and cadence uninstall are skipped because the team is going back
    // to active for retry.
    expect(mergeMocks.drainAndStop).not.toHaveBeenCalled();
    expect(cadenceMocks.uninstallCommitCadence).not.toHaveBeenCalled();
  });


  it('kills the started team session and rolls back worktrees when manifest persistence fails', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-post-session-rollback-');
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    await writeFile(join(cwd, 'README.md'), 'post-session rollback test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'pipe' });
    mocks.createTeamSession.mockResolvedValueOnce({
      sessionName: 'dispatch-window',
      leaderPaneId: '%1',
      workerPaneIds: [],
      sessionMode: 'dedicated-window',
    });
    await mkdir(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'manifest.json'), { recursive: true });

    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      pluginConfig: { team: { ops: { worktreeMode: 'named' } } },
      tasks: [{ subject: 'Worktree rollback', description: 'Fail after tmux session starts' }],
      cwd,
      newWindow: true,
    })).rejects.toThrow();

    expect(mocks.killTeamSession).toHaveBeenCalledWith(
      'dispatch-window',
      [],
      '%1',
      { sessionMode: 'dedicated-window' },
    );
    await expect(readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'worktrees.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(cwd, '.omc', 'team', 'dispatch-team', 'worktrees', 'worker-1', 'AGENTS.md'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });


  it('rolls back clean native worktrees when startup fails before config is persisted', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-worktree-rollback-');
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    await writeFile(join(cwd, 'README.md'), 'worktree rollback test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'pipe' });
    mocks.createTeamSession.mockRejectedValueOnce(new Error('tmux_start_failed'));

    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      pluginConfig: { team: { ops: { worktreeMode: 'named' } } },
      tasks: [{ subject: 'Worktree rollback', description: 'Fail before config persists' }],
      cwd,
    })).rejects.toThrow('tmux_start_failed');

    await expect(readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'config.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'worktrees.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(cwd, '.omc', 'team', 'dispatch-team', 'worktrees', 'worker-1', 'AGENTS.md'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });


  it('uses owner-aware startup allocation when task owners are provided', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-owner-startup-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 2,
      agentTypes: ['claude', 'claude'],
      tasks: [
        { subject: 'Owner-routed task', description: 'Should start on worker-2', owner: 'worker-2' },
        { subject: 'Fallback task', description: 'Should start on worker-1' },
      ],
      cwd,
    });

    expect(runtime.config.workers.map((worker) => worker.name)).toEqual(['worker-1', 'worker-2']);

    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.to_worker)).toEqual(['worker-2', 'worker-1']);

    const spawnedWorkers = mocks.spawnWorkerInPane.mock.calls.map((call) => call[2]?.envVars?.OMC_TEAM_WORKER);
    expect(spawnedWorkers).toEqual(['dispatch-team/worker-2', 'dispatch-team/worker-1']);
  });


  it('uses explicit unowned task roles during startup allocation', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-unowned-role-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 2,
      agentTypes: ['codex', 'codex'],
      workerRoles: ['executor', 'test-engineer'],
      tasks: [
        { subject: 'Validate parser behavior', description: 'run focused tests', role: 'test-engineer' },
      ],
      cwd,
    });

    expect(runtime.config.workers.map((worker) => worker.role)).toEqual(['executor', 'test-engineer']);

    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests.map((request) => request.to_worker)).toEqual(['worker-2']);

    const spawnedWorkers = mocks.spawnWorkerInPane.mock.calls.map((call) => call[2]?.envVars?.OMC_TEAM_WORKER);
    expect(spawnedWorkers).toEqual(['dispatch-team/worker-2']);

    const taskPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks', 'task-1.json');
    const persistedTask = JSON.parse(await readFile(taskPath, 'utf-8'));
    expect(persistedTask.role).toBe('test-engineer');
  });

  it('preserves explicit worker roles in runtime config during startup fanout', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-worker-roles-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 2,
      agentTypes: ['codex', 'gemini'],
      workerRoles: ['architect', 'writer'],
      tasks: [
        { subject: 'Worker 1 (architect): draft launch plan', description: 'draft launch plan', owner: 'worker-1', role: 'architect' },
        { subject: 'Worker 2 (writer): draft launch plan', description: 'draft launch plan', owner: 'worker-2', role: 'writer' },
      ],
      cwd,
    });

    expect(runtime.config.workers.map((worker) => worker.role)).toEqual(['architect', 'writer']);

    const taskPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks', 'task-1.json');
    const persistedTask = JSON.parse(await readFile(taskPath, 'utf-8'));
    expect(persistedTask.role).toBe('architect');

    const configPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'config.json');
    const persisted = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(persisted.workers.map((worker: { role: string }) => worker.role)).toEqual(['architect', 'writer']);
  });

  it('routes inferred review work through alias-keyed resolved snapshot entries', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-alias-routing-');
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(
      join(cwd, '.claude', 'omc.jsonc'),
      JSON.stringify({
        team: {
          roleRouting: {
            reviewer: { provider: 'gemini' },
          },
        },
      }),
      'utf-8',
    );
    process.chdir(cwd);

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Review component naming', description: 'code review pass for PR' }],
      cwd,
    });

    expect(runtime.config.resolved_routing?.['code-reviewer']?.primary.provider).toBe('gemini');
    expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith('gemini', expect.any(Object));
  });

  it('routes an inferred reviewer task to a cursor worker carrying the verdict contract (issue #3880)', async () => {
    // This is the path the removed gates blocked end to end: `team.roleRouting`
    // naming cursor for a reviewer role was rejected at config load (loader) and
    // again at resolution (stage-router), and an inferred reviewer role threw in
    // resolveTaskAssignment. Nothing here passes an explicit role, so it
    // exercises inference rather than the explicit-role shortcut.
    cwd = await mkdtempFixture('omc-runtime-v2-cursor-role-routing-');
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(
      join(cwd, '.claude', 'omc.jsonc'),
      JSON.stringify({
        team: {
          roleRouting: {
            'code-reviewer': { provider: 'cursor', model: 'cursor-grok-4.6-high' },
          },
        },
      }),
      'utf-8',
    );
    process.chdir(cwd);

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'cursor-routing-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Review component naming', description: 'code review pass for PR' }],
      cwd,
    });

    // Routing snapshot honors cursor for a reviewer role.
    expect(runtime.config.resolved_routing?.['code-reviewer']?.primary.provider).toBe('cursor');
    expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith('cursor', expect.any(Object));

    // The worker is a cursor reviewer and owns a verdict-output file, which is
    // what lets the leader transition the task. Without it the task would
    // strand in_progress — the failure mode that kept these gates closed.
    const persisted = JSON.parse(await readFile(
      join(cwd, '.omc', 'state', 'team', 'cursor-routing-team', 'config.json'),
      'utf-8',
    ));
    expect(persisted.workers[0].worker_cli).toBe('cursor');
    expect(persisted.workers[0].role).toBe('code-reviewer');
    expect(persisted.workers[0].output_file).toBeTruthy();

    // And the reviewer contract actually reached the worker.
    const inbox = await readFile(
      join(cwd, '.omc', 'state', 'team', 'cursor-routing-team', 'workers', 'worker-1', 'inbox.md'),
      'utf-8',
    );
    expect(inbox).toContain('REQUIRED: Structured Verdict Output');
    expect(inbox).toContain('do NOT edit, create, or delete any file');
  });

  it('passes through dedicated-window startup requests', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-new-window-');
    const { startTeamV2 } = await import('../runtime-v2.js');

    await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify new-window startup wiring' }],
      cwd,
      newWindow: true,
    });

    expect(mocks.createTeamSession).toHaveBeenCalledWith('dispatch-team', 0, cwd, { newWindow: true });
  });

  it('fails closed when split aliases the leader pane before any worker launch or inbox delivery', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-leader-alias-');
    mocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'split-window') return { stdout: '%1\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['codex'],
      tasks: [{ subject: 'Dispatch test', description: 'Never alias the leader pane' }],
      cwd,
    });

    expect(mocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    expect(mocks.deliverStartupInbox).not.toHaveBeenCalled();
    expect(runtime.config.workers[0]?.pane_id).toBeUndefined();
    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
  });



  it('fails closed when a distinct split pane is not a member of the provider target', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-foreign-split-');
    mocks.workerPaneBelongsToProviderTarget
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['codex'],
      tasks: [{ subject: 'Dispatch test', description: 'Reject foreign split pane' }],
      cwd,
    })).rejects.toThrow('worker_pane_membership_unverified:%2');

    expect(mocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    expect(mocks.deliverStartupInbox).not.toHaveBeenCalled();
  });

  it('aborts startup without persisting a live worker when launch acknowledgement fails', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-start-delivery-fail-');
    mocks.spawnWorkerInPane.mockRejectedValueOnce(new Error('worker_start_ack_ack_timeout:worker-1:%2:attempt'));
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['codex'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify start command delivery failure aborts startup' }],
      cwd,
    })).rejects.toThrow('worker_start_ack_ack_timeout:worker-1:%2:attempt');

    expect(mocks.spawnWorkerInPane).toHaveBeenCalledTimes(1);
    expect(mocks.killTeamSession).not.toHaveBeenCalled();
    const configPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'config.json');
    const persisted = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(persisted.workers[0].pane_id).toBeUndefined();
    expect(persisted.workers[0].assigned_tasks).toEqual([]);
  });

  it('cleans the owned pane before provider launch when required layout fails', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-layout-failure-');
    mocks.applyMainVerticalLayout.mockRejectedValueOnce(new Error('layout failed'));
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Layout failure cleanup' }],
      cwd,
    })).rejects.toThrow('layout failed');
    expect(mocks.spawnOwnedWorkerInPane).not.toHaveBeenCalled();
    expect(mocks.spawnWorkerInPane).not.toHaveBeenCalled();
    expect(mocks.deliverStartupInbox).not.toHaveBeenCalled();
    expect(launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).not.toHaveBeenCalled();
    expect(mocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%2' }));
  });

  it('does not retain a torn-down worker pane as a future split target when startup readiness fails', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-no-autokill-ready-');
    mocks.deliverStartupInbox.mockResolvedValueOnce({ ok: false, reason: 'readiness_timeout' });
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify worker pane is preserved for leader cleanup' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.pane_id).toBe('%2');
    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    expect(mocks.execFile.mock.calls.some((call) => call[1]?.[0] === 'kill-pane')).toBe(false);
    expect(mocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%2' }));
  });

  it.each(['readiness_timeout', 'copy_mode'])(
    'uses a live pane after a cleaned %s startup failure',
    async (failureReason) => {
      cwd = await mkdtempFixture('omc-runtime-v2-cleaned-pane-split-');
      const deadPaneIds = new Set<string>();
      mocks.deliverStartupInbox.mockResolvedValueOnce({ ok: false, reason: failureReason });
      mocks.nextStartupTaskId = 2;
      mocks.killOwnedWorkerPane.mockImplementationOnce(async (...args: unknown[]) => {
        const [ownership] = args as [{ paneId: string }];
        deadPaneIds.add(ownership.paneId);
      });
      mocks.workerPaneBelongsToProviderTarget.mockImplementation(async (...args: unknown[]) => {
        const [{ paneId }] = args as [{ paneId: string }];
        return !deadPaneIds.has(paneId);
      });
      const { startTeamV2 } = await import('../runtime-v2.js');

      const runtime = await startTeamV2({
        teamName: 'dispatch-team',
        workerCount: 2,
        agentTypes: ['claude', 'claude'],
        tasks: [
          { subject: 'First dispatch', description: 'This worker fails startup and is cleaned up' },
          { subject: 'Second dispatch', description: 'This worker starts from a live split target' },
        ],
        cwd,
      });

      expect(runtime.config.workers[0]?.pane_id).toBe('%2');
      expect(runtime.config.workers[1]).toMatchObject({ pane_id: '%3', assigned_tasks: ['2'] });
      expect(mocks.spawnWorkerInPane).toHaveBeenNthCalledWith(
        2,
        'dispatch-session',
        '%3',
        expect.objectContaining({ workerName: 'worker-2' }),
      );
      expect(mocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%2' }));
    },
  );

  it('tears down the owned worker launch when startup notification fails', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-no-autokill-notify-');
    mocks.sendToWorker.mockResolvedValue(false);
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify notify failure leaves pane for leader action' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.pane_id).toBe('%2');
    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    expect(mocks.execFile.mock.calls.some((call) => call[1]?.[0] === 'kill-pane')).toBe(false);
    expect(mocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%2' }));

    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('failed');
    expect(requests[0]?.last_reason).toBe('worker_notify_failed:startup_send_failed');
    expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
  });

  it('fails closed when exact provider process cleanup cannot be verified', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-provider-cleanup-unverified-');
    mocks.sendToWorker.mockResolvedValue(false);
    launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt.mockResolvedValueOnce(false);
    mocks.killOwnedWorkerPane.mockClear();
    const { startTeamV2 } = await import('../runtime-v2.js');

    await expect(startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Reject unverified provider cleanup' }],
      cwd,
    })).rejects.toThrow('worker_startup_cleanup_unverified:worker-1:%2');
    expect(launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).toHaveBeenCalled();
    expect(mocks.killOwnedWorkerPane).not.toHaveBeenCalled();
  });

  it('requires Claude startup evidence without resending the startup inbox', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-claude-evidence-missing-');
    mocks.autoStartupEvidence = false;
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify Claude startup evidence gate' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.pane_id).toBe('%2');
    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);

    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('failed');
  });

  it('accepts delayed Codex evidence at exactly 18s within the provider evidence budget', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('codex');
    const startedAt = Date.now();
    let hasEvidence = false;
    setTimeout(() => { hasEvidence = true; }, 18_000);
    const wait = (budgetMs: number) => waitForStartupEvidenceBudget(async () => hasEvidence, budgetMs);
    const evidencePromise = (async () => {
      if (await wait(policy.initialBudgetMs)) return true;
      return wait(policy.finalRecheckBudgetMs);
    })();
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(17_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(true);
    expect(Date.now() - startedAt).toBe(18_000);
    expect(policy.resubmitAttempts).toBe(0);
  });

  it('times out Codex evidence at exactly 31s after one read-only recheck window', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('codex');
    const startedAt = Date.now();
    const wait = (budgetMs: number) => waitForStartupEvidenceBudget(async () => false, budgetMs);
    const evidencePromise = (async () => {
      if (await wait(policy.initialBudgetMs)) return true;
      return wait(policy.finalRecheckBudgetMs);
    })();
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(30_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(false);
    expect(Date.now() - startedAt).toBe(31_000);
    expect(policy).toMatchObject({
      initialBudgetMs: 30_000,
      finalRecheckBudgetMs: 1_000,
      resubmitAttempts: 0,
      resubmitBudgetMs: 0,
    });
  });

  it('accepts Codex evidence at 30.25s only through the final read-only recheck', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('codex');
    const startedAt = Date.now();
    let hasEvidence = false;
    setTimeout(() => { hasEvidence = true; }, 30_250);
    const wait = (budgetMs: number) => waitForStartupEvidenceBudget(async () => hasEvidence, budgetMs);
    const evidencePromise = (async () => {
      if (await wait(policy.initialBudgetMs)) return true;
      return wait(policy.finalRecheckBudgetMs);
    })();

    await vi.advanceTimersByTimeAsync(30_249);
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(true);
    expect(Date.now() - startedAt).toBe(30_250);
    expect(policy.resubmitAttempts).toBe(0);
  });

  it('keeps an engaged Claude pane alive until evidence lands deep in the engaged recheck window', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('claude');
    const startedAt = Date.now();
    let hasEvidence = false;
    setTimeout(() => { hasEvidence = true; }, 20_010);
    const evidencePromise = settleStartupEvidence(
      policy,
      budgetMs => waitForStartupEvidenceBudget(async () => hasEvidence, budgetMs),
      async () => 'pane_busy',
    );
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(20_249);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(true);
    expect(Date.now() - startedAt).toBe(20_250);
    expect(policy.engagedPaneRecheckBudgetMs).toBe(30_000);
  });

  it('gives a busy Cursor pane one read-only engaged recheck without resubmitting', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('cursor');
    const startedAt = Date.now();
    let hasEvidence = false;
    let probeCalls = 0;
    let retryCalls = 0;
    setTimeout(() => { hasEvidence = true; }, 31_500);
    const evidencePromise = settleStartupEvidence(
      policy,
      budgetMs => waitForStartupEvidenceBudget(async () => hasEvidence, budgetMs),
      async () => {
        retryCalls++;
        return 'resubmitted';
      },
      async () => {
        probeCalls++;
        return 'busy';
      },
    );
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(31_499);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(true);
    expect(Date.now() - startedAt).toBe(31_500);
    expect(probeCalls).toBe(1);
    expect(retryCalls).toBe(0);
    expect(policy).toMatchObject({
      initialBudgetMs: 30_000,
      engagedPaneRecheckBudgetMs: 30_000,
      resubmitAttempts: 0,
    });
  });

  it('bounds a busy Cursor pane to the initial plus one engaged evidence window', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('cursor');
    const startedAt = Date.now();
    let probeCalls = 0;
    let retryCalls = 0;
    const evidencePromise = settleStartupEvidence(
      policy,
      budgetMs => waitForStartupEvidenceBudget(async () => false, budgetMs),
      async () => {
        retryCalls++;
        return 'resubmitted';
      },
      async () => {
        probeCalls++;
        return 'busy';
      },
    );
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(false);
    expect(Date.now() - startedAt).toBe(60_000);
    expect(probeCalls).toBe(1);
    expect(retryCalls).toBe(0);
  });

  it.each(['idle', 'unknown', 'dead'] as const)(
    'does not grant Cursor engaged grace for a %s pane or treat it as evidence',
    async activity => {
      vi.useFakeTimers();
      const policy = getWorkerStartupEvidencePolicy('cursor');
      const evidencePromise = settleStartupEvidence(
        policy,
        budgetMs => waitForStartupEvidenceBudget(async () => false, budgetMs),
        undefined,
        async () => activity,
      );
      let settled = false;
      void evidencePromise.finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(30_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(evidencePromise).resolves.toBe(false);
    },
  );

  it('times out engaged Claude evidence at exactly 31.25s (initial budget plus engaged recheck)', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('claude');
    const startedAt = Date.now();
    const evidencePromise = settleStartupEvidence(
      policy,
      budgetMs => waitForStartupEvidenceBudget(async () => false, budgetMs),
      async () => 'pane_busy',
    );
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(31_249);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(false);
    expect(Date.now() - startedAt).toBe(31_250);
  });

  it('still fails an unengaged Claude pane at the fast 1.25s boundary', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('claude');
    const startedAt = Date.now();
    const evidencePromise = settleStartupEvidence(
      policy,
      budgetMs => waitForStartupEvidenceBudget(async () => false, budgetMs),
      async () => 'unavailable',
    );
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(1_249);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(false);
    expect(Date.now() - startedAt).toBe(1_250);
  });

  it('honors OMC_TEAM_ENGAGED_PANE_RECHECK_MS when bounding the engaged recheck', async () => {
    vi.useFakeTimers();
    process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '500';
    const policy = getWorkerStartupEvidencePolicy('claude');
    const startedAt = Date.now();
    expect(policy.engagedPaneRecheckBudgetMs).toBe(500);
    const evidencePromise = settleStartupEvidence(
      policy,
      budgetMs => waitForStartupEvidenceBudget(async () => false, budgetMs),
      async () => 'pane_busy',
    );

    await vi.advanceTimersByTimeAsync(1_750);
    await expect(evidencePromise).resolves.toBe(false);
    expect(Date.now() - startedAt).toBe(1_750);
  });

  it('accepts evidence published by the unavailable probe itself through the terminal budget-0 check', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('claude');
    const startedAt = Date.now();
    let hasEvidence = false;
    const evidencePromise = settleStartupEvidence(
      policy,
      budgetMs => waitForStartupEvidenceBudget(async () => hasEvidence, budgetMs),
      async () => {
        // The pane is not engaged, but the worker publishes status evidence at
        // the exact moment the probe runs; the terminal read-only check must
        // observe it instead of discarding a healthy launch.
        hasEvidence = true;
        return 'unavailable';
      },
    );
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(1_249);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(true);
    expect(Date.now() - startedAt).toBe(1_250);
  });

  it('clamps OMC_TEAM_ENGAGED_PANE_RECHECK_MS and rejects non-numeric overrides', async () => {
    vi.useFakeTimers();
    process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '9999999';
    expect(getWorkerStartupEvidencePolicy('claude').engagedPaneRecheckBudgetMs).toBe(120_000);
    process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '500abc';
    expect(getWorkerStartupEvidencePolicy('claude').engagedPaneRecheckBudgetMs).toBe(30_000);
    process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '0';
    expect(getWorkerStartupEvidencePolicy('claude').engagedPaneRecheckBudgetMs).toBe(30_000);
    process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '0.9';
    expect(getWorkerStartupEvidencePolicy('claude').engagedPaneRecheckBudgetMs).toBe(1);
    delete process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS;
    expect(getWorkerStartupEvidencePolicy('claude').engagedPaneRecheckBudgetMs).toBe(30_000);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('keeps Codex at 31s when no activity callback is supplied', async () => {
    vi.useFakeTimers();
    const policy = getWorkerStartupEvidencePolicy('codex');
    const startedAt = Date.now();
    expect(policy.engagedPaneRecheckBudgetMs).toBe(30_000);
    const evidencePromise = settleStartupEvidence(
      policy,
      budgetMs => waitForStartupEvidenceBudget(async () => false, budgetMs),
    );
    let settled = false;
    void evidencePromise.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(30_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(evidencePromise).resolves.toBe(false);
    expect(Date.now() - startedAt).toBe(31_000);
  });

  it.each(['codex', 'cursor'] as const)(
    'keeps a busy %s worker alive for current attempt evidence at 31.5s without retry or teardown',
    async provider => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      cwd = await mkdtempFixture(`omc-runtime-v2-${provider}-engaged-late-`);
      mocks.autoStartupEvidence = false;
      const deliveryGate = deferred<void>();
      const activityProbeGate = deferred<void>();
      const evidenceWriteGate = deferred<void>();
      startupDeliveryGate = deliveryGate;
      const startedAt = Date.now();
      let activityProbeCalls = 0;
      mocks.probeStartupPaneActivity.mockImplementation(async (context: {
        attempt: { attempt_id: string; team_name: string; worker_name: string };
      }) => {
        activityProbeCalls++;
        setTimeout(() => {
          void (async () => {
            const workerDir = join(
              cwd,
              '.omc',
              'state',
              'team',
              context.attempt.team_name,
              'workers',
              context.attempt.worker_name,
            );
            await mkdir(workerDir, { recursive: true });
            await writeFile(join(workerDir, 'status.json'), JSON.stringify({
              state: 'working',
              current_task_id: '1',
              updated_at: new Date().toISOString(),
              launch_attempt_id: context.attempt.attempt_id,
            }), 'utf8');
          })().then(evidenceWriteGate.resolve, evidenceWriteGate.reject);
        }, 1_500);
        activityProbeGate.resolve();
        return 'busy';
      });

      const { startTeamV2 } = await import('../runtime-v2.js');
      let startPromise: ReturnType<typeof startTeamV2> | undefined;
      try {
        startPromise = startTeamV2({
          teamName: 'dispatch-team',
          workerCount: 1,
          agentTypes: [provider],
          tasks: [{ subject: 'Dispatch test', description: `Verify delayed ${provider} startup evidence` }],
          cwd,
        });

        await deliveryGate.promise;
        await flushRealIo();
        await vi.advanceTimersByTimeAsync(30_000);
        await flushRealIo();
        await activityProbeGate.promise;
        await vi.advanceTimersByTimeAsync(1_500);
        await evidenceWriteGate.promise;
        await flushRealIo();
        await vi.advanceTimersByTimeAsync(250);

        const runtime = await startPromise;
        expect(runtime.config.workers[0]?.assigned_tasks).toEqual(['1']);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(31_500);
        expect(activityProbeCalls).toBe(1);
        expect(mocks.probeStartupPaneActivity).toHaveBeenCalledTimes(1);
        expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
        expect(mocks.retryStartupInboxSubmit).not.toHaveBeenCalled();
        expect(mocks.killOwnedWorkerPane).not.toHaveBeenCalled();
        const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
        expect(requests[0]).toMatchObject({ status: 'notified', last_reason: 'worker_startup_confirmed' });
      } finally {
        if (startPromise) await startPromise;
      }
    },
  );

  it.each(['codex', 'cursor'] as const)(
    'rejects stale %s evidence during busy grace and fails closed within the bounded override',
    async provider => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '2000';
      cwd = await mkdtempFixture(`omc-runtime-v2-${provider}-stale-engaged-`);
      mocks.autoStartupEvidence = false;
      const deliveryGate = deferred<void>();
      const activityProbeGate = deferred<void>();
      const evidenceWriteGate = deferred<void>();
      startupDeliveryGate = deliveryGate;
      mocks.probeStartupPaneActivity.mockImplementation(async (context: {
        attempt: { team_name: string; worker_name: string };
      }) => {
        setTimeout(() => {
          void (async () => {
            const workerDir = join(
              cwd,
              '.omc',
              'state',
              'team',
              context.attempt.team_name,
              context.attempt.worker_name,
            );
            await mkdir(workerDir, { recursive: true });
            await writeFile(join(workerDir, 'status.json'), JSON.stringify({
              state: 'working',
              current_task_id: '1',
              updated_at: new Date().toISOString(),
              launch_attempt_id: 'stale-attempt',
            }), 'utf8');
          })().then(evidenceWriteGate.resolve, evidenceWriteGate.reject);
        }, 1_500);
        activityProbeGate.resolve();
        return 'busy';
      });

      const { startTeamV2 } = await import('../runtime-v2.js');
      let startPromise: ReturnType<typeof startTeamV2> | undefined;
      try {
        startPromise = startTeamV2({
          teamName: 'dispatch-team',
          workerCount: 1,
          agentTypes: [provider],
          tasks: [{ subject: 'Dispatch test', description: `Reject stale ${provider} startup evidence` }],
          cwd,
        });

        await deliveryGate.promise;
        await flushRealIo();
        await vi.advanceTimersByTimeAsync(30_000);
        await flushRealIo();
        await activityProbeGate.promise;
        await vi.advanceTimersByTimeAsync(1_500);
        await evidenceWriteGate.promise;
        await flushRealIo();
        await vi.advanceTimersByTimeAsync(2_000);

        const runtime = await startPromise;
        expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
        expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
        expect(mocks.retryStartupInboxSubmit).not.toHaveBeenCalled();
        expect(mocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%2' }));
        const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
        expect(requests[0]).toMatchObject({ status: 'failed', last_reason: 'worker_startup_evidence_missing' });
      } finally {
        if (startPromise) await startPromise;
      }
    },
  );

  it.each(['codex', 'cursor'] as const)(
    'executes the actual %s recovery owner at the restart before-first-dispatch checkpoint',
    async provider => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      cwd = await mkdtempFixture(`omc-runtime-v2-owner-${provider}-before-dispatch-`);
      mocks.autoStartupEvidence = false;
      const fixture = await seedOwnerRecoveryFixture(provider, 'before-dispatch');
      configureOwnerPaneLifecycle();
      const deliveryGate = deferred<void>();
      const probeGate = deferred<void>();
      const evidenceGate = deferred<void>();
      startupDeliveryGate = deliveryGate;
      configureOwnerEvidenceProbe('current', probeGate, evidenceGate);

      const { executeRecoverDeadWorkerV2Owner } = await import('../runtime-v2.js');
      const startedAt = Date.now();
      const recoveryPromise = executeRecoverDeadWorkerV2Owner({
        teamName: fixture.teamName,
        cwd,
        workerName: 'worker-1',
        requestId: fixture.requestId,
      });

      await Promise.race([
        deliveryGate.promise,
        recoveryPromise.then(result => { throw new Error(`Recovery ended before delivery: ${JSON.stringify(result)}`); }),
      ]);
      await flushRealIo();
      await vi.advanceTimersByTimeAsync(30_000);
      await flushRealIo();
      await probeGate.promise;
      await vi.advanceTimersByTimeAsync(1_500);
      await evidenceGate.promise;
      await flushRealIo();
      await vi.advanceTimersByTimeAsync(250);

      const result = await recoveryPromise;
      expect(result).toMatchObject({
        outcome: 'recovered',
        committed: true,
        oldPaneId: '%91',
        newPaneId: '%2',
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(31_500);
      expect(mocks.deliverStartupInbox).toHaveBeenCalledTimes(1);
      expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
      expect(mocks.probeStartupPaneActivity).toHaveBeenCalledTimes(1);
      expect(mocks.retryStartupInboxSubmit).not.toHaveBeenCalled();
      expect(mocks.killOwnedWorkerPane).not.toHaveBeenCalled();
      expect(launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).not.toHaveBeenCalled();
      const requests = await listDispatchRequests(fixture.teamName, cwd, { kind: 'inbox' });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        status: 'notified',
        last_reason: 'worker_startup_confirmed',
        inbox_correlation_key: fixture.correlationKey,
      });
      expect(readRecoveryOutcome(cwd, fixture.requestId)).toMatchObject({
        kind: 'final',
        outcome: 'succeeded',
      });
    },
  );

  it('requeues the selected task through an exact read when a sibling corrupts after inventory', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    cwd = await mkdtempFixture('omc-runtime-v2-requeue-target-read-');
    mocks.autoStartupEvidence = false;
    const fixture = await seedOwnerRecoveryFixture('codex', 'target-read');
    const taskRoot = absPath(cwd, TeamPaths.tasks(fixture.teamName));
    const targetPath = absPath(cwd, TeamPaths.taskFile(fixture.teamName, '1'));
    const siblingPath = absPath(cwd, TeamPaths.taskFile(fixture.teamName, '2'));
    const claimToken = 'target-claim-token';
    const createdAt = new Date().toISOString();
    await mkdir(taskRoot, { recursive: true });
    await writeFile(targetPath, JSON.stringify({
      id: '1',
      subject: 'Recover target',
      description: 'Only this task should be requeued.',
      status: 'in_progress',
      owner: 'worker-1',
      version: 1,
      claim: { owner: 'worker-1', token: claimToken, leased_until: '2099-01-01T00:00:00.000Z' },
      created_at: createdAt,
    }));
    await writeFile(siblingPath, JSON.stringify({
      id: '2',
      subject: 'Unrelated sibling',
      description: 'This file is corrupted after inventory.',
      status: 'completed',
      version: 1,
      created_at: createdAt,
    }));
    const resumePayload = { resume: 'continue target' };
    const checkpointPath = absPath(cwd, TeamPaths.checkpoint(
      fixture.teamName,
      '1',
      taskRecoveryClaimTokenHash(claimToken),
      1,
    ));
    await mkdir(join(checkpointPath, '..'), { recursive: true });
    await writeFile(checkpointPath, JSON.stringify({
      schema_version: 1,
      team_name: fixture.teamName,
      task_id: '1',
      worker_name: 'worker-1',
      sequence: 1,
      task_version: 1,
      claim_token: claimToken,
      resume_payload_hash: hashTaskRecoveryCheckpointPayload(resumePayload),
      resume_payload: resumePayload,
      updated_at: createdAt,
    }));
    atomicWriteControl.triggerReadPath = checkpointPath;
    atomicWriteControl.corruptSiblingPath = siblingPath;

    configureOwnerPaneLifecycle();
    const deliveryGate = deferred<void>();
    const probeGate = deferred<void>();
    const evidenceGate = deferred<void>();
    startupDeliveryGate = deliveryGate;
    configureOwnerEvidenceProbe('current', probeGate, evidenceGate);

    const { executeRecoverDeadWorkerV2Owner } = await import('../runtime-v2.js');
    const recoveryPromise = executeRecoverDeadWorkerV2Owner({
      teamName: fixture.teamName,
      cwd,
      workerName: 'worker-1',
      requestId: fixture.requestId,
    });

    await deliveryGate.promise;
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(30_000);
    await flushRealIo();
    await probeGate.promise;
    await vi.advanceTimersByTimeAsync(1_500);
    await evidenceGate.promise;
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(250);

    await expect(recoveryPromise).resolves.toMatchObject({
      outcome: 'recovered',
      committed: true,
      requeuedTaskIds: ['1'],
    });
    expect(atomicWriteControl.readTriggered).toBe(true);
    await expect(readFile(siblingPath, 'utf8')).resolves.toBe('{corrupt sibling');
    const target = JSON.parse(await readFile(targetPath, 'utf8')) as {
      status?: string;
      recovery_adoption?: { recovery_id?: string };
    };
    expect(target).toMatchObject({
      status: 'in_progress',
      owner: 'worker-1',
      version: 3,
      claim: { owner: 'worker-1', token: expect.any(String) },
      recovery_adoption: { recovery_id: fixture.recoveryId, request_id: fixture.requestId },
    });
    expect(target).not.toHaveProperty('recovery_reservation');
    expect(target).not.toMatchObject({ claim: { token: claimToken } });
  });

  it.each([
    ['codex', 'stale'],
    ['cursor', 'stale'],
    ['codex', 'none'],
    ['cursor', 'none'],
    ['codex', 'probe-throw'],
    ['cursor', 'probe-throw'],
  ] as const)(
    'keeps a committed %s recovery replacement on postcommit %s startup failure',
    async (provider, mode) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '2000';
      cwd = await mkdtempFixture(`omc-runtime-v2-owner-${provider}-${mode}-`);
      mocks.autoStartupEvidence = false;
      const fixture = await seedOwnerRecoveryFixture(provider, mode);
      configureOwnerPaneLifecycle();
      const deliveryGate = deferred<void>();
      const probeGate = deferred<void>();
      const evidenceGate = deferred<void>();
      startupDeliveryGate = deliveryGate;
      configureOwnerEvidenceProbe(mode, probeGate, evidenceGate);

      const { executeRecoverDeadWorkerV2Owner } = await import('../runtime-v2.js');
      const recoveryPromise = executeRecoverDeadWorkerV2Owner({
        teamName: fixture.teamName,
        cwd,
        workerName: 'worker-1',
        requestId: fixture.requestId,
      });

      await deliveryGate.promise;
      await flushRealIo();
      await vi.advanceTimersByTimeAsync(30_000);
      await flushRealIo();
      await probeGate.promise;
      if (mode === 'stale') {
        await vi.advanceTimersByTimeAsync(1_500);
        await evidenceGate.promise;
        await flushRealIo();
      }
      await vi.advanceTimersByTimeAsync(2_000);

      const result = await recoveryPromise;
      expect(result).toMatchObject({
        outcome: 'failed',
        committed: false,
        error: 'runtime_owner_unavailable',
      });
      expect(mocks.deliverStartupInbox).toHaveBeenCalledTimes(1);
      expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
      expect(mocks.probeStartupPaneActivity).toHaveBeenCalledTimes(1);
      expect(mocks.retryStartupInboxSubmit).not.toHaveBeenCalled();
      expect(mocks.killOwnedWorkerPane).not.toHaveBeenCalled();
      expect(launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).not.toHaveBeenCalled();
      const requests = await listDispatchRequests(fixture.teamName, cwd, { kind: 'inbox' });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        status: 'failed',
        last_reason: 'worker_startup_evidence_missing',
      });
      const persistedConfig = JSON.parse(await readFile(
        absPath(cwd, TeamPaths.config(fixture.teamName)),
        'utf8',
      )) as {
        active_recovery?: { recovery_id?: string };
        workers?: Array<{ pane_id?: string; recovery_id?: string }>;
      };
      expect(persistedConfig.active_recovery?.recovery_id).toBe(fixture.recoveryId);
      expect(persistedConfig.workers?.[0]).toMatchObject({
        pane_id: '%2',
        recovery_id: fixture.recoveryId,
      });
      expect(readRecoveryOutcome(cwd, fixture.requestId)).not.toMatchObject({
        kind: 'final',
        outcome: 'succeeded',
      });
    },
  );

  it.each(['codex', 'cursor'] as const)(
    'fails closed at the restart pending-dispatch checkpoint for %s before notify or evidence polling',
    async provider => {
      cwd = await mkdtempFixture(`omc-runtime-v2-owner-${provider}-pending-dispatch-`);
      mocks.autoStartupEvidence = false;
      const fixture = await seedOwnerRecoveryFixture(provider, 'pending-dispatch');
      await seedRecoveryDispatchCheckpoint(fixture, 'pending');
      configureOwnerPaneLifecycle();

      const { executeRecoverDeadWorkerV2Owner } = await import('../runtime-v2.js');
      const result = await executeRecoverDeadWorkerV2Owner({
        teamName: fixture.teamName,
        cwd,
        workerName: 'worker-1',
        requestId: fixture.requestId,
      });

      expect(result).toMatchObject({
        outcome: 'failed',
        committed: false,
        error: 'runtime_owner_unavailable',
      });
      expect(mocks.deliverStartupInbox).not.toHaveBeenCalled();
      expect(mocks.sendToWorker).not.toHaveBeenCalled();
      expect(mocks.probeStartupPaneActivity).not.toHaveBeenCalled();
      expect(mocks.retryStartupInboxSubmit).not.toHaveBeenCalled();
      expect(mocks.killOwnedWorkerPane).not.toHaveBeenCalled();
      const requests = await listDispatchRequests(fixture.teamName, cwd, { kind: 'inbox' });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        status: 'pending',
        inbox_correlation_key: fixture.correlationKey,
      });
      expect(readRecoveryOutcome(cwd, fixture.requestId)).not.toMatchObject({
        kind: 'final',
        outcome: 'succeeded',
      });
    },
  );

  it.each([
    ['codex', 'notified', 'current'],
    ['cursor', 'notified', 'current'],
    ['codex', 'failed', 'none'],
    ['cursor', 'failed', 'none'],
  ] as const)(
    'characterizes the restart %s %s checkpoint with %s evidence without assuming universal deduplication',
    async (provider, checkpoint, mode) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '2000';
      cwd = await mkdtempFixture(`omc-runtime-v2-owner-${provider}-terminal-${checkpoint}-`);
      mocks.autoStartupEvidence = false;
      const fixture = await seedOwnerRecoveryFixture(provider, `terminal-${checkpoint}`);
      await seedRecoveryDispatchCheckpoint(fixture, checkpoint);
      configureOwnerPaneLifecycle();
      const deliveryGate = deferred<void>();
      const probeGate = deferred<void>();
      const evidenceGate = deferred<void>();
      startupDeliveryGate = deliveryGate;
      configureOwnerEvidenceProbe(mode, probeGate, evidenceGate);

      const { executeRecoverDeadWorkerV2Owner } = await import('../runtime-v2.js');
      const recoveryPromise = executeRecoverDeadWorkerV2Owner({
        teamName: fixture.teamName,
        cwd,
        workerName: 'worker-1',
        requestId: fixture.requestId,
      });

      await deliveryGate.promise;
      await flushRealIo();
      await vi.advanceTimersByTimeAsync(30_000);
      await flushRealIo();
      await probeGate.promise;
      if (mode === 'current') {
        await vi.advanceTimersByTimeAsync(1_500);
        await evidenceGate.promise;
        await flushRealIo();
        await vi.advanceTimersByTimeAsync(250);
      } else {
        await vi.advanceTimersByTimeAsync(2_000);
      }

      const result = await recoveryPromise;
      const requests = await listDispatchRequests(fixture.teamName, cwd, { kind: 'inbox' });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.status).toBe(checkpoint);
      expect(mocks.deliverStartupInbox).toHaveBeenCalledTimes(1);
      expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
      expect(mocks.probeStartupPaneActivity).toHaveBeenCalledTimes(1);
      expect(mocks.retryStartupInboxSubmit).not.toHaveBeenCalled();
      expect(mocks.killOwnedWorkerPane).not.toHaveBeenCalled();
      if (mode === 'current') {
        expect(result).toMatchObject({ outcome: 'recovered', committed: true, newPaneId: '%2' });
        expect(requests[1]).toMatchObject({ status: 'notified', last_reason: 'worker_startup_confirmed' });
      } else {
        expect(result).toMatchObject({
          outcome: 'failed',
          committed: false,
          error: 'runtime_owner_unavailable',
        });
        expect(requests[1]).toMatchObject({ status: 'failed', last_reason: 'worker_startup_evidence_missing' });
        expect(readRecoveryOutcome(cwd, fixture.requestId)).not.toMatchObject({
          kind: 'final',
          outcome: 'succeeded',
        });
      }
    },
  );

  it('rejects a stale worker status that predates the current startup trigger', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-stale-status-');
    mocks.autoStartupEvidence = false;
    const workerDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1');
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, 'status.json'), JSON.stringify({
      state: 'working',
      current_task_id: '1',
      updated_at: '2026-01-01T00:00:00.000Z',
    }), 'utf8');
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Reject stale status evidence' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests[0]).toMatchObject({ status: 'failed', last_reason: 'worker_startup_evidence_missing' });
    expect(mocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%2' }));
    expect(launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attempt_id: 'attempt-worker-1' }),
      'startup_dispatch_failed',
      expect.any(Function),
    );
  });

  it('rejects a stale task claim that predates the current startup trigger', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-stale-claim-');
    mocks.autoStartupEvidence = false;
    mocks.createTeamSession.mockImplementationOnce(async () => {
      const taskPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks', 'task-1.json');
      const task = JSON.parse(await readFile(taskPath, 'utf8'));
      await writeFile(taskPath, JSON.stringify({
        ...task,
        owner: 'worker-1',
        status: 'in_progress',
        version: 2,
        claim: { owner: 'worker-1', token: 'stale-token', leased_until: '2099-01-01T00:00:00.000Z' },
      }), 'utf8');
      return {
        sessionName: 'dispatch-session',
        leaderPaneId: '%1',
        workerPaneIds: [],
        sessionMode: 'split-pane',
      };
    });
    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Reject stale claim evidence' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests[0]).toMatchObject({ status: 'failed', last_reason: 'worker_startup_evidence_missing' });
  });

  it('does not treat ACK-only mailbox replies as Claude startup evidence or resend the startup inbox', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-claude-evidence-ack-');
    mocks.autoStartupEvidence = false;

    mocks.sendToWorker.mockImplementation(async () => {
      const mailboxDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'mailbox');
      await mkdir(mailboxDir, { recursive: true });
      await writeFile(join(mailboxDir, 'leader-fixed.json'), JSON.stringify({
        worker: 'leader-fixed',
        messages: [{
          message_id: 'msg-1',
          from_worker: 'worker-1',
          to_worker: 'leader-fixed',
          body: 'ACK: worker-1 initialized',
          created_at: new Date().toISOString(),
        }],
      }, null, 2), 'utf-8');
      return true;
    });

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify Claude mailbox ack evidence' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
  });

  it.each(['claim', 'status'] as const)('rejects fresh wrong-attempt %s evidence in isolation', async evidenceKind => {
    cwd = await mkdtempFixture(`omc-runtime-v2-wrong-attempt-${evidenceKind}-`);
    mocks.autoStartupEvidence = false;

    mocks.sendToWorker.mockImplementation(async () => {
      if (evidenceKind === 'claim') {
        const taskPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks', 'task-1.json');
        const task = JSON.parse(await readFile(taskPath, 'utf-8'));
        await writeFile(taskPath, JSON.stringify({
          ...task,
          status: 'in_progress',
          owner: 'worker-1',
          claim: {
            owner: 'worker-1',
            token: 'orphan-token',
            leased_until: '2099-01-01T00:00:00.000Z',
            launch_attempt_id: 'attempt-worker-orphan',
          },
        }, null, 2), 'utf-8');
      } else {
        const workerDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1');
        await mkdir(workerDir, { recursive: true });
        await writeFile(join(workerDir, 'status.json'), JSON.stringify({
          state: 'working',
          current_task_id: '1',
          launch_attempt_id: 'attempt-worker-orphan',
          updated_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
      }
      return true;
    });

    const { startTeamV2 } = await import('../runtime-v2.js');
    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Reject wrong-attempt evidence' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests[0]).toMatchObject({ status: 'failed', last_reason: 'worker_startup_evidence_missing' });
  });

  it('accepts Claude startup once the worker claims the task', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-claude-evidence-claim-');
    mocks.autoStartupEvidence = false;

    mocks.sendToWorker.mockImplementation(async () => {
      const taskDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks');
      const taskPath = join(taskDir, 'task-1.json');
      const existing = JSON.parse(await readFile(taskPath, 'utf-8'));
      await writeFile(taskPath, JSON.stringify({
        ...existing,
        status: 'in_progress',
        owner: 'worker-1',
        claim: {
          owner: 'worker-1',
          token: 'current-token',
          leased_until: '2099-01-01T00:00:00.000Z',
          launch_attempt_id: 'attempt-worker-1',
        },
      }, null, 2), 'utf-8');
      return true;
    });

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify Claude claim evidence' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual(['1']);
    expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
  });

  it('accepts Claude startup once worker status shows task progress', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-claude-evidence-status-');
    mocks.autoStartupEvidence = false;

    mocks.sendToWorker.mockImplementation(async () => {
      const workerDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1');
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, 'status.json'), JSON.stringify({
        state: 'working',
        current_task_id: '1',
        updated_at: new Date().toISOString(),
        launch_attempt_id: 'attempt-worker-1',
      }, null, 2), 'utf-8');
      return true;
    });

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify Claude status evidence' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual(['1']);
    expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
  });

  it('keeps a provider-started Claude worker alive when an engaged pane publishes evidence late (#3849)', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-claude-engaged-late-');
    mocks.autoStartupEvidence = false;

    // Issue #3849 reproduction shape: the provider is started and healthy, the
    // pane visibly consumed the startup trigger (spinner + esc-to-interrupt),
    // and the first-turn status evidence lands only after the initial budget.
    mocks.retryStartupInboxSubmit.mockImplementation(async () => {
      const workerDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1');
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, 'status.json'), JSON.stringify({
        state: 'working',
        current_task_id: '1',
        updated_at: new Date().toISOString(),
        launch_attempt_id: 'attempt-worker-1',
      }, null, 2), 'utf8');
      return 'pane_busy';
    });

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify engaged pane survives slow first-turn evidence' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual(['1']);
    expect(mocks.retryStartupInboxSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.killOwnedWorkerPane).not.toHaveBeenCalled();
    expect(launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).not.toHaveBeenCalledWith(
      expect.objectContaining({ attempt_id: 'attempt-worker-1' }),
      'startup_dispatch_failed',
      expect.any(Function),
    );
    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests[0]).toMatchObject({ status: 'notified', last_reason: 'worker_startup_confirmed' });
  });

  it('fails closed with verified teardown when an engaged Claude pane never publishes evidence', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-claude-engaged-dead-');
    mocks.autoStartupEvidence = false;
    process.env.OMC_TEAM_ENGAGED_PANE_RECHECK_MS = '250';

    mocks.retryStartupInboxSubmit.mockImplementation(async () => 'pane_busy');

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify engaged pane still fails closed without evidence' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests[0]).toMatchObject({ status: 'failed', last_reason: 'worker_startup_evidence_missing' });
    expect(mocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%2' }));
    expect(launchMocks.retireAndCleanupCurrentWorkerLaunchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attempt_id: 'attempt-worker-1' }),
      'startup_dispatch_failed',
      expect.any(Function),
    );
  });

  it('breaks the resubmit loop immediately and fails fast when the pane is not engaged', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-claude-unengaged-');
    mocks.autoStartupEvidence = false;

    mocks.retryStartupInboxSubmit.mockImplementation(async () => 'unavailable');
    const startedAt = Date.now();

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['claude'],
      tasks: [{ subject: 'Dispatch test', description: 'Verify unengaged pane fails fast' }],
      cwd,
    });

    expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
    expect(mocks.retryStartupInboxSubmit).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
    expect(requests[0]).toMatchObject({ status: 'failed', last_reason: 'worker_startup_evidence_missing' });
    expect(mocks.killOwnedWorkerPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%2' }));
  });

  it('direct grok launch resolves model from grok env vars and never calls resolveClaudeWorkerModel', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-grok-direct-');
    const originalGrokModel = process.env.OMC_GROK_DEFAULT_MODEL;
    const originalGrokExternal = process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
    delete process.env.OMC_GROK_DEFAULT_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
    try {
      const { startTeamV2 } = await import('../runtime-v2.js');

      await startTeamV2({
        teamName: 'dispatch-team',
        workerCount: 1,
        agentTypes: ['grok'],
        tasks: [{ subject: 'Grok dispatch', description: 'Verify direct grok model resolution' }],
        cwd,
      });

      // DIRECT grok launch: no grok env set → model is undefined (NOT a Claude id).
      expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
        'grok',
        expect.objectContaining({ model: undefined }),
      );
      // crucially, a grok worker must never fall through to the Claude/Bedrock resolver.
      expect(modelContractMocks.resolveClaudeWorkerModel).not.toHaveBeenCalled();
    } finally {
      if (originalGrokModel === undefined) delete process.env.OMC_GROK_DEFAULT_MODEL;
      else process.env.OMC_GROK_DEFAULT_MODEL = originalGrokModel;
      if (originalGrokExternal === undefined) delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
      else process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL = originalGrokExternal;
    }
  });

  it('direct cursor launch resolves model from cursor env vars, canonical outranking legacy', async () => {
    // `resolveDefaultModel` hardcoded `undefined` for cursor while every sibling
    // provider read its env vars, so a plain `omc team 1:cursor` ignored the
    // configured default entirely — it only applied via team.roleRouting.
    cwd = await mkdtempFixture('omc-runtime-v2-cursor-env-');
    const originalCursorModel = process.env.OMC_CURSOR_DEFAULT_MODEL;
    const originalCursorExternal = process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
    process.env.OMC_CURSOR_DEFAULT_MODEL = 'composer-2.5';
    process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL = 'cursor-grok-4.6-high';
    try {
      const { startTeamV2 } = await import('../runtime-v2.js');

      await startTeamV2({
        teamName: 'dispatch-team',
        workerCount: 1,
        agentTypes: ['cursor'],
        tasks: [{ subject: 'Cursor dispatch', description: 'Verify cursor env model passthrough' }],
        cwd,
      });

      expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
        'cursor',
        expect.objectContaining({ model: 'cursor-grok-4.6-high' }),
      );
      expect(modelContractMocks.resolveClaudeWorkerModel).not.toHaveBeenCalled();
    } finally {
      if (originalCursorModel === undefined) delete process.env.OMC_CURSOR_DEFAULT_MODEL;
      else process.env.OMC_CURSOR_DEFAULT_MODEL = originalCursorModel;
      if (originalCursorExternal === undefined) delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
      else process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL = originalCursorExternal;
    }
  });

  it('direct cursor launch resolves the configured cursor default when env is unset', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-cursor-config-');
    const originalCursorModel = process.env.OMC_CURSOR_DEFAULT_MODEL;
    const originalCursorExternal = process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
    delete process.env.OMC_CURSOR_DEFAULT_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
    try {
      const { startTeamV2 } = await import('../runtime-v2.js');

      const runtime = await startTeamV2({
        teamName: 'dispatch-team',
        workerCount: 1,
        agentTypes: ['cursor'],
        tasks: [{ subject: 'Cursor dispatch', description: 'Verify configured cursor model passthrough' }],
        pluginConfig: {
          externalModels: { defaults: { cursorModel: 'composer-2.5' } },
        },
        cwd,
      });

      expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
        'cursor',
        expect.objectContaining({ model: 'composer-2.5' }),
      );
      expect(runtime.config.external_models_defaults).toEqual({ cursorModel: 'composer-2.5' });
    } finally {
      if (originalCursorModel === undefined) delete process.env.OMC_CURSOR_DEFAULT_MODEL;
      else process.env.OMC_CURSOR_DEFAULT_MODEL = originalCursorModel;
      if (originalCursorExternal === undefined) delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
      else process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL = originalCursorExternal;
    }
  });

  it('direct cursor launch falls back to the legacy OMC_CURSOR_DEFAULT_MODEL', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-cursor-legacy-env-');
    const originalCursorModel = process.env.OMC_CURSOR_DEFAULT_MODEL;
    const originalCursorExternal = process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
    process.env.OMC_CURSOR_DEFAULT_MODEL = 'composer-2.5';
    try {
      const { startTeamV2 } = await import('../runtime-v2.js');

      await startTeamV2({
        teamName: 'dispatch-team',
        workerCount: 1,
        agentTypes: ['cursor'],
        tasks: [{ subject: 'Cursor dispatch', description: 'Verify legacy cursor env fallback' }],
        cwd,
      });

      expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
        'cursor',
        expect.objectContaining({ model: 'composer-2.5' }),
      );
    } finally {
      if (originalCursorModel === undefined) delete process.env.OMC_CURSOR_DEFAULT_MODEL;
      else process.env.OMC_CURSOR_DEFAULT_MODEL = originalCursorModel;
      if (originalCursorExternal === undefined) delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
      else process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL = originalCursorExternal;
    }
  });

  it('direct cursor launch with no cursor env leaves the model unset', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-cursor-no-env-');
    const originalCursorModel = process.env.OMC_CURSOR_DEFAULT_MODEL;
    const originalCursorExternal = process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
    delete process.env.OMC_CURSOR_DEFAULT_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
    try {
      const { startTeamV2 } = await import('../runtime-v2.js');

      await startTeamV2({
        teamName: 'dispatch-team',
        workerCount: 1,
        agentTypes: ['cursor'],
        tasks: [{ subject: 'Cursor dispatch', description: 'Verify cursor default stays unset' }],
        cwd,
      });

      // Unset must stay unset: cursor-agent picks its own model, and a Claude id
      // here would be invalid for it.
      expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
        'cursor',
        expect.objectContaining({ model: undefined }),
      );
      expect(modelContractMocks.resolveClaudeWorkerModel).not.toHaveBeenCalled();
    } finally {
      if (originalCursorModel === undefined) delete process.env.OMC_CURSOR_DEFAULT_MODEL;
      else process.env.OMC_CURSOR_DEFAULT_MODEL = originalCursorModel;
      if (originalCursorExternal === undefined) delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL;
      else process.env.OMC_EXTERNAL_MODELS_DEFAULT_CURSOR_MODEL = originalCursorExternal;
    }
  });

  it('direct grok launch passes OMC_GROK_DEFAULT_MODEL through to buildWorkerArgv', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-grok-model-');
    const originalGrokModel = process.env.OMC_GROK_DEFAULT_MODEL;
    const originalGrokExternal = process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
    delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
    process.env.OMC_GROK_DEFAULT_MODEL = 'grok-4-fast';
    try {
      const { startTeamV2 } = await import('../runtime-v2.js');

      await startTeamV2({
        teamName: 'dispatch-team',
        workerCount: 1,
        agentTypes: ['grok'],
        tasks: [{ subject: 'Grok dispatch', description: 'Verify grok env model passthrough' }],
        cwd,
      });

      expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(
        'grok',
        expect.objectContaining({ model: 'grok-4-fast' }),
      );
      expect(modelContractMocks.resolveClaudeWorkerModel).not.toHaveBeenCalled();
    } finally {
      if (originalGrokModel === undefined) delete process.env.OMC_GROK_DEFAULT_MODEL;
      else process.env.OMC_GROK_DEFAULT_MODEL = originalGrokModel;
      if (originalGrokExternal === undefined) delete process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
      else process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL = originalGrokExternal;
    }
  });

  it('keeps gemini prompt-mode launch args to a short inbox pointer and waits for claim evidence', async () => {
    cwd = await mkdtempFixture('omc-runtime-v2-gemini-prompt-');

    modelContractMocks.isPromptModeAgent.mockImplementation((agentType?: string) => agentType === 'gemini');
    mocks.spawnWorkerInPane.mockImplementation(async (_sessionName: string, _paneId: string, config: { envVars?: Record<string, string> }) => {
      const taskDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks');
      const canonicalTaskPath = join(taskDir, 'task-1.json');
      const legacyTaskPath = join(taskDir, '1.json');
      const taskPath = await readFile(canonicalTaskPath, 'utf-8')
        .then(() => canonicalTaskPath)
        .catch(async () => {
          await readFile(legacyTaskPath, 'utf-8');
          return legacyTaskPath;
        });
      const existing = JSON.parse(await readFile(taskPath, 'utf-8'));
      await writeFile(taskPath, JSON.stringify({
        ...existing,
        status: 'in_progress',
        owner: 'worker-1',
        claim: {
          owner: 'worker-1',
          token: 'gemini-current-token',
          leased_until: '2099-01-01T00:00:00.000Z',
          launch_attempt_id: config.envVars?.OMC_WORKER_LAUNCH_ATTEMPT_ID,
        },
      }, null, 2), 'utf-8');
    });

    const { startTeamV2 } = await import('../runtime-v2.js');

    const runtime = await startTeamV2({
      teamName: 'dispatch-team',
      workerCount: 1,
      agentTypes: ['gemini'],
      tasks: [{
        subject: 'Dispatch test',
        description: 'Reviewer seed says the worker may be blocked; verify prompt echo stays quiet.',
      }],
      cwd,
    });

    expect(modelContractMocks.getPromptModeArgs).toHaveBeenCalledWith(
      'gemini',
      expect.stringContaining('$OMC_TEAM_STATE_ROOT/workers/worker-1/inbox.md'),
    );
    const promptModeInstruction = modelContractMocks.getPromptModeArgs.mock.calls[0]?.[1];
    expect(promptModeInstruction).toContain('Open $OMC_TEAM_STATE_ROOT/workers/worker-1/inbox.md');
    expect(promptModeInstruction).not.toContain('claim-task');
    expect(promptModeInstruction).not.toContain('transition-task-status');
    expect(promptModeInstruction).not.toContain('blocked');
    expect(promptModeInstruction).not.toContain('Reviewer seed');
    expect(mocks.spawnWorkerInPane).toHaveBeenCalledWith(
      'dispatch-session',
      '%2',
      expect.objectContaining({
        launchBinary: '/usr/bin/gemini',
        launchArgs: expect.arrayContaining([
          expect.stringContaining('$OMC_TEAM_STATE_ROOT/workers/worker-1/inbox.md'),
        ]),
      }),
    );
    const launchArgs = mocks.spawnWorkerInPane.mock.calls[0]?.[2]?.launchArgs ?? [];
    expect(launchArgs.some((arg: string) => arg.includes('claim-task'))).toBe(false);
    expect(launchArgs.some((arg: string) => arg.includes('transition-task-status'))).toBe(false);
    expect(launchArgs.some((arg: string) => arg.includes('blocked'))).toBe(false);
    expect(launchArgs.some((arg: string) => arg.includes('Reviewer seed'))).toBe(false);
    const inboxPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'inbox.md');
    const inbox = await readFile(inboxPath, 'utf-8');
    expect(inbox).toContain('team api claim-task');
    expect(inbox).toContain('transition-task-status');
    expect(inbox).toContain('Reviewer seed says the worker may be blocked');
    expect(runtime.config.workers[0]?.assigned_tasks).toEqual(['1']);
    expect(mocks.sendToWorker).not.toHaveBeenCalled();
  });
});
