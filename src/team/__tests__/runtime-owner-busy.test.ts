import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmuxMocks = vi.hoisted(() => {
  const state = {
    paneDeadState: '0' as '0' | '1' | 'unknown',
    serverIdentity: undefined as { socket_path: string; server_pid: number; process_started_at: string } | undefined,
    paneLiveness: new Map<string, 'alive' | 'dead' | 'unknown'>(),
  };
  return {
    tmuxExecAsync: vi.fn(async (args: string[]) => ({
      stdout: args.includes('list-panes') ? '%0\n%1\n%2\n%9\n%10\n' : '',
      stderr: '',
    })),
    tmuxCmdAsync: vi.fn(async (args: string[]): Promise<{ stdout: string; stderr: string }> => ({
      stdout: args.includes('#{pid}') ? `${process.pid}\n` : `${state.paneDeadState}\n`,
      stderr: '',
    })),
    setPaneDeadState: (value: '0' | '1' | 'unknown') => { state.paneDeadState = value; },
    setServerIdentity: (value: { socket_path: string; server_pid: number; process_started_at: string }) => { state.serverIdentity = value; },
    setPaneLiveness: (paneId: string, value: 'alive' | 'dead' | 'unknown') => { state.paneLiveness.set(paneId, value); },
    clearPaneLiveness: () => { state.paneLiveness.clear(); },
    getOwnedWorkerLiveness: vi.fn(async (ownership: { paneId: string }) => state.paneLiveness.get(ownership.paneId) ?? 'unknown'),
    getWorkerLiveness: vi.fn(async (paneId: string) => state.paneLiveness.get(paneId) ?? 'unknown'),
    captureOwnedTeamPane: vi.fn(async () => ''),
    workerPaneBelongsToOwnedProviderTarget: vi.fn(async () => true),
    observeTmuxServerIdentity: vi.fn(async () => 'matching' as const),
    verifyTeamTargetOwnership: vi.fn(async (target: { provider: 'tmux' | 'cmux'; providerTarget: string; paneId: string }) => ({
      kind: 'owned' as const,
      provider: target.provider,
      providerTarget: target.providerTarget,
      recipient: 'worker' as const,
      recipientRole: 'worker' as const,
      paneId: target.paneId,
    })),
  };
});
vi.mock('../../cli/tmux-utils.js', () => tmuxMocks);
vi.mock('../tmux-session.js', async importOriginal => ({
  ...await importOriginal<typeof import('../tmux-session.js')>(),
  ...tmuxMocks,
}));

import { canonicalRecoveryPayloadHash, readRecoveryFinalState, readRecoveryOutcome, reserveRecoveryRequest as persistRecoveryRequest, writeRecoveryPhase } from '../recovery-request-store.js';
import {
  executeRecoverDeadWorkerV2Owner,
  finalizeRecoveryOwnerResult,
  recoverDeadWorkerV2,
  setRuntimeOwnerRecoveryClient,
  type RuntimeOwnerRecoveryClient,
} from '../runtime-v2.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { readRevisionedTeamConfig, saveTeamConfigAtRevision } from '../monitor.js';
import { currentProcessStartIdentity, currentStrictProcessStartIdentity, isProcessIdentityDead, isValidProcessStartIdentity, publishOwnerEpoch, readLatestOwnerEpoch } from '../team-owner-epoch.js';
import { reserveTeamInstance } from '../team-instance.js';
import { runRecoverySaga } from '../recovery-saga.js';

function reserveRecoveryRequest(
  cwd: string,
  requestId: string,
  payload: Parameters<typeof persistRecoveryRequest>[2],
  recoveryId?: string,
): ReturnType<typeof persistRecoveryRequest> {
  persistFixtureAuthority(payload.teamName, cwd);
  return persistRecoveryRequest(cwd, requestId, payload, recoveryId);
}

const TEAM_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function currentLaunchRecord(teamName: string, recoveryId: string): Record<string, unknown> {
  return { schema_version: 1, attempt_id: '33333333-3333-4333-8333-333333333333',
    nonce: '44444444-4444-4444-8444-444444444444', instance_id: TEAM_INSTANCE_ID, team_name: teamName,
    worker_name: 'worker-1', pane_id: '%5', provider: 'claude', created_at: new Date().toISOString(),
    runtime_cli_path: '/runtime/cli.cjs',
    context: { kind: 'recovery', recovery_id: recoveryId, replacement_generation: 2, pane_attempt_id: 'pane-attempt-r' } };
}
function fixtureTmuxServerIdentity(cwd: string): { socket_path: string; server_pid: number; process_started_at: string } {
  const processStartedAt = currentStrictProcessStartIdentity();
  if (!processStartedAt) throw new Error('fixture tmux process identity unavailable');
  const identity = { socket_path: join(cwd, '.omc-fixture-tmux.sock'), server_pid: process.pid, process_started_at: processStartedAt };
  tmuxMocks.setServerIdentity(identity);
  return identity;
}

function fixtureManifest(config: Record<string, any>, serverIdentity: ReturnType<typeof fixtureTmuxServerIdentity>): Record<string, any> {
  return {
    schema_version: 2,
    state_revision: config.state_revision,
    name: config.name,
    instance_id: config.instance_id,
    tmux_server_identity: serverIdentity,
    task: config.task ?? '',
    leader: { session_id: `${config.name}:0`, worker_id: 'leader-fixed', role: 'leader' },
    policy: config.policy ?? {
      display_mode: 'split_pane',
      worker_launch_mode: config.worker_launch_mode ?? 'interactive',
      dispatch_mode: 'hook_preferred_with_fallback',
      dispatch_ack_timeout_ms: 15_000,
    },
    governance: config.governance ?? {
      delegation_only: false,
      plan_approval_required: false,
      nested_teams_allowed: false,
      one_team_per_leader_session: true,
      cleanup_requires_all_workers_inactive: true,
    },
    permissions_snapshot: { approval_mode: 'default', sandbox_mode: 'workspace-write', network_access: false },
    tmux_session: config.tmux_session,
    worker_count: config.worker_count,
    workers: Array.isArray(config.workers)
      ? config.workers.map((worker: Record<string, any>) => ({
        role: worker.role ?? worker.worker_cli ?? config.agent_type ?? 'worker',
        assigned_tasks: worker.assigned_tasks ?? [],
        ...worker,
      }))
      : [],
    next_task_id: config.next_task_id ?? 1,
    created_at: config.created_at,
    leader_cwd: config.leader_cwd,
    team_state_root: config.team_state_root,
    leader_pane_id: config.leader_pane_id ?? null,
    hud_pane_id: config.hud_pane_id ?? null,
    resize_hook_name: config.resize_hook_name ?? null,
    resize_hook_target: config.resize_hook_target ?? null,
  };
}

function persistFixtureAuthority(teamName: string, cwd: string): void {
  const configPath = absPath(cwd, TeamPaths.config(teamName));
  if (!existsSync(configPath)) return;
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
  const serverIdentity = fixtureTmuxServerIdentity(cwd);
  config.instance_id = config.instance_id ?? TEAM_INSTANCE_ID;
  config.tmux_server_identity = serverIdentity;
  config.leader_pane_id = /^%\d+$/.test(String(config.leader_pane_id ?? ''))
    ? config.leader_pane_id
    : '%0';
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify(fixtureManifest(config, serverIdentity)));
}

async function reserveFixtureInstance(teamName: string, cwd: string, instanceId = TEAM_INSTANCE_ID): Promise<void> {
  await reserveTeamInstance({ teamName, cwd, instanceId });
}

const launchMetadata = { worker_cli: 'claude' as const,
  launch_descriptor: { schema_version: 1 as const, provider: 'claude' as const, model: null,
    binary: '/usr/bin/claude', args: ['--dangerously-skip-permissions'] } };

let cwd: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousOmcStateDir: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousOmcStateDir = process.env.OMC_STATE_DIR;
});

function mkdtempFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.OMC_STATE_DIR;
  return root;
}

function hostValidDeadProcessStartIdentity(pid: number): string {
  const current = currentProcessStartIdentity();
  expect(current).not.toBeNull();
  expect(isValidProcessStartIdentity(current)).toBe(true);

  const darwin = /^darwin:([1-9]\d*):(\d+)$/.exec(current!);
  const numeric = /^(linux|win32):([1-9]\d*)$/.exec(current!);
  let dead: string;
  if (darwin) {
    const micros = Number(darwin[2]);
    dead = micros === 0
      ? `darwin:${Number(darwin[1]) + 1}:0`
      : `darwin:${darwin[1]}:${micros === 999_999 ? micros - 1 : micros + 1}`;
  } else if (numeric) {
    dead = `${numeric[1]}:${Number(numeric[2]) + 1}`;
  } else {
    const separator = current!.indexOf(':');
    dead = `${current!.slice(0, separator)}:${current!.slice(separator + 1)}-different`;
  }

  expect(dead).not.toBe(current);
  expect(isValidProcessStartIdentity(dead)).toBe(true);
  expect(isProcessIdentityDead({ pid, process_started_at: dead })).toBe(true);
  return dead;
}

afterEach(() => {
  vi.clearAllMocks();
  tmuxMocks.setPaneDeadState('0');
  tmuxMocks.clearPaneLiveness();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousOmcStateDir;
});

describe('runtime owner team mutation contention', () => {
  it('returns team_mutation_busy without publishing a terminal final for the waiting recovery', async () => {
    cwd = mkdtempFixture('runtime-owner-busy-');
    const teamName = 'busy-team';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
      agent_type: 'claude',
      created_at: new Date().toISOString(),
      tmux_session: 'busy-team:0',
      lifecycle_state: 'active',
      state_revision: 3,
      active_recovery: {
        request_id: 'other-request', recovery_id: 'other-recovery', worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'other-owner', phase: 'active', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    }));
    reserveRecoveryRequest(cwd, 'waiting-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'waiting-recovery');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'waiting-request', instanceId: TEAM_INSTANCE_ID }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId: 'waiting-recovery' });
    expect(readRecoveryOutcome(cwd, 'waiting-request')).toBeNull();
  });

  it('keeps recovery transient while a durable scale-down reservation is active', async () => {
    cwd = mkdtempFixture('runtime-owner-scale-down-busy-');
    const teamName = 'scale-down-busy-team';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 2,
      workers: [
        { name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 },
        { name: 'worker-2', index: 2, ...launchMetadata, pane_id: '%2', replacement_generation: 1 },
      ],
      agent_type: 'claude', created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 3,
      active_scale_down: { operation_id: 'scale-down-1', phase: 'draining', pid: 999999,
        process_started_at: 'linux:1', workers: [{ name: 'worker-2', pane_id: '%2' }],
        state_revision: 3, created_at: now, updated_at: now },
    }));
    reserveRecoveryRequest(cwd, 'scale-down-waiting-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-2', instanceId: TEAM_INSTANCE_ID }, 'scale-down-waiting-recovery');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-2', requestId: 'scale-down-waiting-request', instanceId: TEAM_INSTANCE_ID }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId: 'scale-down-waiting-recovery' });
    expect(readRecoveryOutcome(cwd, 'scale-down-waiting-request')).toBeNull();
  });

  it('rejects a stale recovery owner before publishing an epoch or active fence', async () => {
    cwd = mkdtempFixture('runtime-owner-stale-instance-');
    const teamName = 'stale-instance-team';
    await reserveFixtureInstance(teamName, cwd, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1' }],
      agent_type: 'claude',
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      lifecycle_state: 'active',
      state_revision: 3,
    }));
    reserveRecoveryRequest(cwd, 'stale-instance-request', {
      operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'),
      teamName,
      workerName: 'worker-1',
      instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }, 'stale-instance-recovery');

    await expect(executeRecoverDeadWorkerV2Owner({
      teamName,
      cwd,
      workerName: 'worker-1',
      requestId: 'stale-instance-request',
      instanceId: TEAM_INSTANCE_ID,
    } as Parameters<typeof executeRecoverDeadWorkerV2Owner>[0])).resolves.toMatchObject({
      outcome: 'failed',
      error: 'invalid_persisted_state',
      recoveryId: 'stale-instance-recovery',
    });
    expect(readLatestOwnerEpoch(cwd, teamName)).toBeNull();
    const staleConfig = await readRevisionedTeamConfig(teamName, cwd);
    expect(staleConfig?.config.instance_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(staleConfig?.config.active_recovery).toBeUndefined();
  });

  it('retains an existing request ID instance when the same name now hosts a replacement', async () => {
    cwd = mkdtempFixture('runtime-owner-replay-instance-');
    const teamName = 'replay-instance-team';
    const replacementInstanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await reserveFixtureInstance(teamName, cwd, replacementInstanceId);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
      instance_id: replacementInstanceId,
      worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1' }],
      agent_type: 'claude',
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      lifecycle_state: 'active',
      state_revision: 1,
    }));
    const originalInstanceId = TEAM_INSTANCE_ID;
    reserveRecoveryRequest(cwd, 'replay-request', {
      operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'),
      teamName,
      workerName: 'worker-1',
      instanceId: originalInstanceId,
    }, 'replay-recovery');

    const request: RuntimeOwnerRecoveryClient['requestRuntimeOwnerRecovery'] = vi.fn(async input => ({
      outcome: 'failed' as const,
      committed: false as const,
      error: 'worker_liveness_unknown' as const,
      requestId: 'replay-request',
      recoveryId: 'replay-recovery',
      teamName,
      workerName: 'worker-1',
      updatedAt: new Date().toISOString(),
      message: input.instanceId,
    }));
    setRuntimeOwnerRecoveryClient({ requestRuntimeOwnerRecovery: request });
    try {
      await recoverDeadWorkerV2(teamName, cwd, { workerName: 'worker-1', requestId: 'replay-request' });
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ instanceId: originalInstanceId }));
    } finally {
      setRuntimeOwnerRecoveryClient(undefined);
    }
  });

  it('terminally rejects a persisted attempt secret with a mismatched durable identity tuple', async () => {
    cwd = mkdtempFixture('runtime-owner-attempt-secret-');
    const teamName = 'attempt-team';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'attempt-team:0',
      lifecycle_state: 'active', state_revision: 3,
    }));
    reserveRecoveryRequest(cwd, 'attempt-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'attempt-recovery');
    const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, 'attempt-recovery'));
    mkdirSync(join(attemptPath, '..'), { recursive: true });
    writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: 'wrong-request',
      recovery_id: 'attempt-recovery', worker_name: 'worker-1', replacement_generation: 2,
      adoption_token: 'token', created_at: new Date().toISOString() }));

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'attempt-request', instanceId: TEAM_INSTANCE_ID }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'invalid_persisted_state', recoveryId: 'attempt-recovery' });
    expect(readRecoveryOutcome(cwd, 'attempt-request')).toMatchObject({ kind: 'final', outcome: 'failed',
      error: { code: 'invalid_persisted_state' } });
  });


  it('rejects PID-reuse takeover when the active recovery belongs to a different attempt', async () => {
    cwd = mkdtempFixture('runtime-owner-pid-reuse-');
    const teamName = 'pid-reuse-team';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1, workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1' }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'pid-reuse-team:0',
      lifecycle_state: 'active', state_revision: 3,
      active_recovery: { request_id: 'other-request', recovery_id: 'other-recovery', worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'reused-pid-owner', phase: 'active', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }));
    const processStartedAt = hostValidDeadProcessStartIdentity(process.pid);
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt, nonce: 'reused-pid-owner' });
    reserveRecoveryRequest(cwd, 'waiting-pid-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'waiting-pid-recovery');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'waiting-pid-request', instanceId: TEAM_INSTANCE_ID }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'runtime_owner_fence_lost' });
    const owner = readLatestOwnerEpoch(cwd, teamName);
    expect(owner).toMatchObject({ epoch: 1, pid: process.pid, process_started_at: processStartedAt });
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'other-recovery', owner_epoch: 1 } },
    });
  });
  it('retains a committed pane on unknown liveness without spawning a duplicate replacement', async () => {
    cwd = mkdtempFixture('runtime-owner-unknown-committed-pane-');
    const teamName = 'committed-team';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%9', pane_attempt_id: 'attempt-a',
        recovery_id: 'committed-recovery', replacement_generation: 2 }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'committed-team:0',
      lifecycle_state: 'active', state_revision: 3,
      active_recovery: { request_id: 'committed-request', recovery_id: 'committed-recovery', worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'prior-owner', phase: 'active', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }));
    reserveRecoveryRequest(cwd, 'committed-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'committed-recovery');
    const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, 'committed-recovery'));
    mkdirSync(join(attemptPath, '..'), { recursive: true });
    writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: 'committed-request',
      recovery_id: 'committed-recovery', worker_name: 'worker-1', replacement_generation: 2,
      adoption_token: 'stable-token', created_at: new Date().toISOString() }));
    tmuxMocks.setPaneLiveness('%9', 'unknown');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'committed-request', instanceId: TEAM_INSTANCE_ID }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown', recoveryId: 'committed-recovery' });
    expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
    expect(readRecoveryOutcome(cwd, 'committed-request')).toBeNull();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'committed-recovery' },
        workers: [{ pane_id: '%9', pane_attempt_id: 'attempt-a', replacement_generation: 2 }] },
    });
  });

  it.each(['alive', 'unknown', 'missing'] as const)('rechecks %s original-pane liveness after election before replay effects', async liveness => {
    cwd = mkdtempFixture(`runtime-owner-precommit-${liveness}-`);
    const teamName = `precommit-${liveness}-team`;
    await reserveFixtureInstance(teamName, cwd);
    const requestId = `request-${liveness}`;
    const recoveryId = `recovery-${liveness}`;
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1,
        ...(liveness === 'missing' ? {} : { pane_id: '%1' }) }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
      lifecycle_state: 'active', state_revision: 3,
      active_recovery: { request_id: requestId, recovery_id: recoveryId, worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'prior-owner', phase: 'reserved', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }));
    reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);
    const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, recoveryId));
    mkdirSync(join(attemptPath, '..'), { recursive: true });
    writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: requestId,
      recovery_id: recoveryId, worker_name: 'worker-1', replacement_generation: 2,
      adoption_token: 'stable-token', created_at: new Date().toISOString() }));
    const taskPath = absPath(cwd, TeamPaths.taskFile(teamName, '1'));
    if (liveness === 'missing') {
      mkdirSync(join(taskPath, '..'), { recursive: true });
      writeFileSync(taskPath, JSON.stringify({ id: '1', subject: 'owned task', description: 'must not requeue',
        status: 'in_progress', owner: 'worker-1', version: 1, blocked_by: [], created_at: new Date().toISOString() }));
    }
    tmuxMocks.setPaneDeadState(liveness === 'alive' ? '0' : liveness === 'unknown' ? 'unknown' : '1');
    if (liveness !== 'missing') tmuxMocks.setPaneLiveness('%1', liveness);

    const result = await executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID });
    expect(result).toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown', recoveryId });
    expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
    const persisted = await readRevisionedTeamConfig(teamName, cwd);
    expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
    expect(persisted?.config.active_recovery).toMatchObject({ recovery_id: recoveryId });
    if (liveness === 'missing') {
      const task = JSON.parse(readFileSync(taskPath, 'utf8'));
      expect(task).toMatchObject({ status: 'in_progress', owner: 'worker-1' });
      expect(task.recovery_reservation).toBeUndefined();
    }
  });
  it.each([
    ['launch_metadata_incomplete', undefined],
    ['launch_descriptor_unresolvable', { schema_version: 1, provider: 'claude', model: null, binary: 'claude', args: [] }],
  ] as const)('rejects %s before recovery pane effects', async (expectedError, launchDescriptor) => {
    cwd = mkdtempFixture('runtime-owner-launch-metadata-');
    const teamName = launchDescriptor ? 'bad-descriptor' : 'missing-metadata';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, worker_cli: 'claude', pane_id: '%1',
        ...(launchDescriptor ? { launch_descriptor: launchDescriptor } : {}) }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
      lifecycle_state: 'active', state_revision: 3 }));
    const requestId = `request-${expectedError}`;
    reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID },
    `recovery-${expectedError}`);

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
      .resolves.toMatchObject({ outcome: 'failed', error: expectedError });
    expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
  });


  it('allows recovery past a committed scale-up fence without team_mutation_busy', async () => {
    cwd = mkdtempFixture('runtime-owner-committed-scale-up-');
    const teamName = 'committed-scale-up-team';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
      agent_type: 'claude', created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 3,
      // Durable post-commit fence after release write failure — reconcilable, non-blocking.
      active_scale_up: {
        operation_id: 'scale-up-committed-1', phase: 'committed', pid: 999999,
        process_started_at: 'linux:1', state_revision: 3, created_at: now, updated_at: now,
      },
    }));
    reserveRecoveryRequest(cwd, 'committed-scale-up-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'committed-scale-up-recovery');

    const result = await executeRecoverDeadWorkerV2Owner({
      teamName, cwd, workerName: 'worker-1', requestId: 'committed-scale-up-request', instanceId: TEAM_INSTANCE_ID,
    });
    expect(result.recoveryId).toBe('committed-scale-up-recovery');
    // Recovery is allowed to proceed past the fence (may fail later for other reasons).
    if (result.outcome === 'failed') {
      expect(result.error).not.toBe('team_mutation_busy');
    } else {
      expect(['recovered', 'already_running']).toContain(result.outcome);
    }
  });

  it.each(['reserved', 'effects', 'failed'] as const)(
    'keeps recovery blocked while scale-up fence phase is %s',
    async (phase) => {
      cwd = mkdtempFixture(`runtime-owner-scale-up-${phase}-`);
      const teamName = `scale-up-${phase}-team`;
      await reserveFixtureInstance(teamName, cwd);
      const configPath = absPath(cwd, TeamPaths.config(teamName));
      mkdirSync(join(configPath, '..'), { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(configPath, JSON.stringify({
        name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
        workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
        agent_type: 'claude', created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 3,
        active_scale_up: {
          operation_id: `scale-up-${phase}-1`, phase, pid: 999999,
          process_started_at: 'linux:1', state_revision: 3, created_at: now, updated_at: now,
          ...(phase === 'failed' ? { failure_reason: 'test' } : {}),
        },
      }));
      const requestId = `scale-up-${phase}-request`;
      const recoveryId = `scale-up-${phase}-recovery`;
      reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
        workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, recoveryId);

      await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID }))
        .resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId });
      expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
    },
  );

  it('does not treat non-committed phase labels as committed even if other fields look durable', async () => {
    cwd = mkdtempFixture('runtime-owner-stale-scale-up-label-');
    const teamName = 'stale-scale-up-label-team';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
      agent_type: 'claude', created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 3,
      // Foreign/stale-looking fence without the atomic committed phase proof.
      active_scale_up: {
        operation_id: 'foreign-op', phase: 'effects', pid: 1,
        process_started_at: 'linux:foreign', state_revision: 3, created_at: now, updated_at: now,
      },
    }));
    reserveRecoveryRequest(cwd, 'stale-label-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'stale-label-recovery');

    await expect(executeRecoverDeadWorkerV2Owner({
      teamName, cwd, workerName: 'worker-1', requestId: 'stale-label-request', instanceId: TEAM_INSTANCE_ID,
    })).resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId: 'stale-label-recovery' });
  });

  it('reconciles a live committed replacement through activation, adoption, services, and run publication', async () => {
    cwd = mkdtempFixture('runtime-owner-committed-replay-');
    const input = {
      requestId: 'committed-replay-request',
      recoveryId: 'committed-replay-recovery',
      teamName: 'committed-replay-team',
      workerName: 'worker-1',
      replacementGeneration: 2,
      adoptionToken: 'committed-replay-token',
      originalPaneId: '%old',
    };
    const task = {
      id: '1',
      status: 'in_progress',
      owner: 'worker-1',
      version: 3,
    };
    const activatePane = vi.fn(async () => ({ ok: true as const }));
    const adoptAll = vi.fn(async () => ({
      ok: true as const,
      continuations: [{
        taskId: '1',
        taskVersion: 3,
        sequence: 7,
        payload: { prompt: 'continue' },
        claimToken: 'claim-token',
      }],
    }));
    const repairServices = vi.fn(async () => 'synced' as const);
    const writeRun = vi.fn(async () => undefined);
    reserveRecoveryRequest(cwd, input.requestId, {
      operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'),
      teamName: input.teamName,
      workerName: input.workerName,
      instanceId: TEAM_INSTANCE_ID,
    }, input.recoveryId);

    const result = await runRecoverySaga(input, {
      cwd,
      getLiveness: async () => 'alive',
      isCommittedReplacement: async () => true,
      listOwnedInProgressTasks: async () => [task] as never,
      validateCheckpoint: async () => ({ ok: true as const, sequence: 7 }),
      requeue: async () => ({ ok: true as const, sequence: 7 }),
      spawnGatedPane: async () => ({
        ok: true as const,
        paneId: '%replacement',
        paneAttemptId: 'replacement-attempt',
        committed: true,
        stateRevision: 9,
        manifestSync: 'synced' as const,
      }),
      activatePane,
      adoptAll,
      writeRun,
      persistActive: async () => ({ stateRevision: 9, manifestSync: 'synced' as const }),
      repairServices,
      killAttemptPane: async () => undefined,
    });

    expect(result).toMatchObject({
      outcome: 'recovered',
      oldPaneId: '%old',
      newPaneId: '%replacement',
      activation: 'active',
      servicesSync: 'synced',
    });
    expect(activatePane).toHaveBeenCalledWith(input, 'replacement-attempt');
    expect(adoptAll).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ recoveryId: input.recoveryId }),
      ['1'],
    );
    expect(repairServices).toHaveBeenCalledWith(input);
    expect(writeRun).toHaveBeenCalledWith(input, 'replacement-attempt', expect.any(Array));
  });


});

describe('recovery owner retry deadline', () => {
  const PAST_DEADLINE_MS = 301_000;
  const BEFORE_DEADLINE_MS = 240_000;

  function writeCurrentLaunch(teamName: string, record: Record<string, unknown>): void {
    const path = absPath(cwd, TeamPaths.workerLaunchCurrent(teamName, 'worker-1'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(record));
  }

  function writeIntent(teamName: string, requestId: string, recoveryId: string, ageMs: number): void {
    const workspaceHash = createHash('sha256').update(cwd).digest('hex');
    const path = absPath(cwd, TeamPaths.recoveryIntent(teamName, recoveryId));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema_version: 1, kind: 'recover-worker', request_id: requestId,
      recovery_id: recoveryId, operation: 'recover-worker', workspace_hash: workspaceHash,
      payload_hash: canonicalRecoveryPayloadHash({ operation: 'recover-worker', workspaceHash, teamName,
        workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }),
      team_name: teamName, worker_name: 'worker-1', instance_id: TEAM_INSTANCE_ID,
      created_at: new Date(Date.now() - ageMs).toISOString() }));
  }

  // An elected recovery whose original pane liveness stays unknown: the
  // transient failure a killed launch wrapper leaves behind.
  async function seedElectedUnknownLiveness(teamName: string, ageMs: number, worker: Record<string, unknown> = {}): Promise<void> {
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1, ...worker }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
      lifecycle_state: 'active', state_revision: 3,
      active_recovery: { request_id: 'stuck-request', recovery_id: 'stuck-recovery', worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'prior-owner', phase: 'reserved', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }));
    reserveRecoveryRequest(cwd, 'stuck-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'stuck-recovery');
    const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, 'stuck-recovery'));
    mkdirSync(join(attemptPath, '..'), { recursive: true });
    writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: 'stuck-request',
      recovery_id: 'stuck-recovery', worker_name: 'worker-1', replacement_generation: worker.recovery_id ? 1 : 2,
      adoption_token: 'stable-token', created_at: new Date().toISOString() }));
    writeIntent(teamName, 'stuck-request', 'stuck-recovery', ageMs);
    tmuxMocks.setPaneDeadState('unknown');
    tmuxMocks.setPaneLiveness('%1', 'unknown');
  }

  const execute = (teamName: string, requestId = 'stuck-request') =>
    executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId, instanceId: TEAM_INSTANCE_ID });

  it('keeps retrying a transient failure before the deadline', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-before-');
    await seedElectedUnknownLiveness('deadline-before', BEFORE_DEADLINE_MS);

    await expect(execute('deadline-before')).resolves.toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toBeNull();
    await expect(readRevisionedTeamConfig('deadline-before', cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery' } },
    });
  });

  it('fails an elected recovery past the deadline before any launch and releases active_recovery', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-elected-');
    await seedElectedUnknownLiveness('deadline-elected', PAST_DEADLINE_MS);

    await expect(execute('deadline-elected')).resolves.toMatchObject({ outcome: 'failed', error: 'recovery_request_timeout' });
    expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
    // The final uses a code the existing reader accepts, so older CLIs read it.
    const final = readRecoveryFinalState(cwd, 'stuck-request');
    expect(final.kind).toBe('valid');
    expect(final.kind === 'valid' && final.final).toMatchObject({ outcome: 'failed', recovery_id: 'stuck-recovery',
      error: { code: 'recovery_request_timeout', message: expect.stringContaining('deadline exceeded') } });
    const persisted = await readRevisionedTeamConfig('deadline-elected', cwd);
    expect(persisted?.config.active_recovery).toBeUndefined();
    expect(persisted?.config.last_recovery).toMatchObject({ recovery_id: 'stuck-recovery', phase: 'failed' });
  });

  it('keeps retrying past the deadline when a task record holds a reservation while the phase is still selected', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-task-reserved-');
    const teamName = 'deadline-task-reserved';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    writeRecoveryPhase(cwd, { schema_version: 1, kind: 'phase', request_id: 'stuck-request', recovery_id: 'stuck-recovery',
      team_name: teamName, worker_name: 'worker-1', phase: 'elected', continuation: 'selected', adoption: 'not_started',
      services: 'not_started', manifest: 'not_started', updated_at: new Date().toISOString() });
    const taskPath = absPath(cwd, TeamPaths.taskFile(teamName, '1'));
    mkdirSync(join(taskPath, '..'), { recursive: true });
    writeFileSync(taskPath, JSON.stringify({ id: '1', subject: 'reserved task', description: 'requeued for the replacement',
      status: 'pending', version: 2, blocked_by: [], created_at: new Date().toISOString(),
      recovery_reservation: { recovery_id: 'stuck-recovery', request_id: 'stuck-request', continuation_sequence: 1,
        checkpoint_path: 'checkpoint.json', checkpoint_hash: 'a'.repeat(64), replacement_worker: 'worker-1',
        replacement_generation: 2, adoption_token_hash: 'b'.repeat(64), reserved_at: new Date().toISOString() } }));

    const result = await execute(teamName);
    expect(result).not.toMatchObject({ error: 'recovery_request_timeout' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')?.kind).not.toBe('final');
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery' } },
    });
  });

  it('keeps retrying past the deadline once a replacement is committed to the worker row', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-committed-');
    await seedElectedUnknownLiveness('deadline-committed', PAST_DEADLINE_MS,
      { pane_id: '%9', pane_attempt_id: 'attempt-a', recovery_id: 'stuck-recovery', replacement_generation: 1 });
    tmuxMocks.setPaneLiveness('%9', 'unknown');

    await expect(execute('deadline-committed')).resolves.toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toBeNull();
    await expect(readRevisionedTeamConfig('deadline-committed', cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery' } },
    });
  });

  it('does not expire a recovery while another attempt of it runs in the same owner process', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-same-process-');
    const teamName = 'deadline-same-process';
    await seedElectedUnknownLiveness(teamName, BEFORE_DEADLINE_MS);
    // Attempt A passes the fence before the deadline, then pauses inside its
    // effects, where it could be about to write a task reservation.
    let entered!: () => void;
    const enteredEffects = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    tmuxMocks.observeTmuxServerIdentity.mockImplementationOnce(async () => {
      entered();
      await released;
      return 'matching' as const;
    });
    const attemptA = execute(teamName);
    await enteredEffects;

    writeIntent(teamName, 'stuck-request', 'stuck-recovery', PAST_DEADLINE_MS);
    let attemptBSettled = false;
    const attemptB = execute(teamName).finally(() => { attemptBSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const settledWhileAPaused = attemptBSettled;

    // A's effect lands, then A finishes.
    const taskPath = absPath(cwd, TeamPaths.taskFile(teamName, '1'));
    mkdirSync(join(taskPath, '..'), { recursive: true });
    writeFileSync(taskPath, JSON.stringify({ id: '1', subject: 'reserved task', description: 'requeued for the replacement',
      status: 'pending', version: 2, blocked_by: [], created_at: new Date().toISOString(),
      recovery_reservation: { recovery_id: 'stuck-recovery', request_id: 'stuck-request', continuation_sequence: 1,
        checkpoint_path: 'checkpoint.json', checkpoint_hash: 'a'.repeat(64), replacement_worker: 'worker-1',
        replacement_generation: 2, adoption_token_hash: 'b'.repeat(64), reserved_at: new Date().toISOString() } }));
    release();
    await attemptA;
    await expect(attemptB).resolves.not.toMatchObject({ error: 'recovery_request_timeout' });

    expect(settledWhileAPaused).toBe(false);
    expect(readRecoveryOutcome(cwd, 'stuck-request')?.kind).not.toBe('final');
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery' } },
    });
  });

  it('returns the final a preceding attempt published instead of re-electing the recovery', async () => {
    cwd = mkdtempFixture('runtime-owner-chain-final-');
    const teamName = 'chain-final';
    await seedElectedUnknownLiveness(teamName, BEFORE_DEADLINE_MS);
    let entered!: () => void;
    const enteredCheck = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    // Attempt A pauses at the tmux server check, then finds the server gone.
    tmuxMocks.observeTmuxServerIdentity.mockImplementationOnce((async () => {
      entered();
      await released;
      return 'unknown';
    }) as never);
    const attemptA = execute(teamName);
    await enteredCheck;
    const attemptB = execute(teamName);
    release();

    await expect(attemptA).resolves.toMatchObject({ outcome: 'failed', error: 'team_session_dead' });
    await expect(attemptB).resolves.toMatchObject({ outcome: 'failed', error: 'team_session_dead' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toMatchObject({ kind: 'final', error: { code: 'team_session_dead' } });
    expect((await readRevisionedTeamConfig(teamName, cwd))?.config.active_recovery).toBeUndefined();
  });

  it('keeps retrying past the deadline when a successor finds a persisted replacement launch for the recovery', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-persisted-launch-');
    const teamName = 'deadline-persisted-launch';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    // A predecessor owner persisted the replacement launch, then died before
    // committing the worker row. This process starts with no pending pane.
    writeCurrentLaunch(teamName, currentLaunchRecord(teamName, 'stuck-recovery'));

    const result = await execute(teamName);
    expect(result).not.toMatchObject({ error: 'recovery_request_timeout' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toBeNull();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery' } },
    });
  });

  it.each([
    ['an empty record', {}],
    ['a recovery context without identity', { context: { kind: 'recovery' } }],
  ])('keeps retrying past the deadline when the persisted launch is %s', async (_label, record) => {
    cwd = mkdtempFixture('runtime-owner-deadline-invalid-launch-');
    const teamName = 'deadline-invalid-launch';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    // A record the launch loader rejects cannot rule out a predecessor pane.
    writeCurrentLaunch(teamName, record);

    const result = await execute(teamName);
    expect(result).not.toMatchObject({ error: 'recovery_request_timeout' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toBeNull();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery' } },
    });
  });

  it('fails past the deadline when the persisted launch belongs to another recovery', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-other-launch-');
    const teamName = 'deadline-other-launch';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    writeCurrentLaunch(teamName, currentLaunchRecord(teamName, 'older-recovery'));

    await expect(execute(teamName)).resolves.toMatchObject({ outcome: 'failed', error: 'recovery_request_timeout' });
    expect((await readRevisionedTeamConfig(teamName, cwd))?.config.active_recovery).toBeUndefined();
  });

  // An owner that died right after splitting a recovery pane leaves only the
  // record it wrote before the split: no pending pane, launch record or worker row.
  const paneSplitDir = (teamName: string, recoveryId: string) =>
    absPath(cwd, TeamPaths.recoveryPaneSplits(teamName, recoveryId));
  function writePaneSplit(teamName: string, recoveryId: string): void {
    mkdirSync(paneSplitDir(teamName, recoveryId), { recursive: true });
    writeFileSync(join(paneSplitDir(teamName, recoveryId), 'attempt-x.json'), JSON.stringify({ schema_version: 1,
      recovery_id: recoveryId, request_id: 'stuck-request', worker_name: 'worker-1', pane_attempt_id: 'attempt-x' }));
  }

  it.each([
    ['present', (teamName: string) => writePaneSplit(teamName, 'stuck-recovery')],
    ['unreadable', (teamName: string) => {
      mkdirSync(join(paneSplitDir(teamName, 'stuck-recovery'), '..'), { recursive: true });
      writeFileSync(paneSplitDir(teamName, 'stuck-recovery'), 'not a directory');
    }],
  ])('keeps retrying past the deadline when a pane split record for the recovery is %s', async (_label, seed) => {
    cwd = mkdtempFixture('runtime-owner-deadline-pane-split-');
    const teamName = 'deadline-pane-split';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    seed(teamName);

    const result = await execute(teamName);
    expect(result).not.toMatchObject({ error: 'recovery_request_timeout' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toBeNull();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery' } },
    });
  });

  it('fails past the deadline when the pane split record belongs to another recovery', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-other-split-');
    const teamName = 'deadline-other-split';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    writePaneSplit(teamName, 'older-recovery');

    await expect(execute(teamName)).resolves.toMatchObject({ outcome: 'failed', error: 'recovery_request_timeout' });
    expect((await readRevisionedTeamConfig(teamName, cwd))?.config.active_recovery).toBeUndefined();
  });

  // An owner from a build without pane split records leaves only this
  // evidence for a split it could not prove: no record, pending pane or row.
  function writeRollbackFailure(teamName: string, recoveryId: string): void {
    const path = absPath(cwd, TeamPaths.recoveryPaneRollbackFailure(teamName, recoveryId, 'attempt-x', Date.now()));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema_version: 1, recovery_id: recoveryId, pane_id: null,
      pane_attempt_id: 'attempt-x', reason: 'pane_membership_unverified' }));
  }

  it.each([
    ['present', (teamName: string) => writeRollbackFailure(teamName, 'stuck-recovery')],
    ['unreadable', (teamName: string) => {
      const dir = join(absPath(cwd, TeamPaths.recoveryPaneRollbackFailure(teamName, 'stuck-recovery', 'a', 0)), '..');
      mkdirSync(join(dir, '..'), { recursive: true });
      writeFileSync(dir, 'not a directory');
    }],
  ])('keeps retrying past the deadline when rollback-failure evidence for the recovery is %s', async (_label, seed) => {
    cwd = mkdtempFixture('runtime-owner-deadline-rollback-evidence-');
    const teamName = 'deadline-rollback-evidence';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    seed(teamName);

    const result = await execute(teamName);
    expect(result).not.toMatchObject({ error: 'recovery_request_timeout' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toBeNull();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery' } },
    });
  });

  it('fails past the deadline when the rollback-failure evidence belongs to another recovery', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-other-evidence-');
    const teamName = 'deadline-other-evidence';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    writeRollbackFailure(teamName, 'older-recovery');

    await expect(execute(teamName)).resolves.toMatchObject({ outcome: 'failed', error: 'recovery_request_timeout' });
    expect((await readRevisionedTeamConfig(teamName, cwd))?.config.active_recovery).toBeUndefined();
  });

  it('falls through to the executor past the deadline when the task records cannot be read', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-corrupt-task-');
    const teamName = 'deadline-corrupt-task';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.workers = [{ ...config.workers[0], name: 'worker-2' }];
    writeFileSync(configPath, JSON.stringify(config));
    const taskPath = absPath(cwd, TeamPaths.taskFile(teamName, '9'));
    mkdirSync(join(taskPath, '..'), { recursive: true });
    writeFileSync(taskPath, '{ unrelated corrupt task');

    // The executor without the deadline reads no task here and ends with worker_not_found.
    await expect(execute(teamName)).resolves.toMatchObject({ outcome: 'failed', error: 'worker_not_found' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toMatchObject({ kind: 'final', error: { code: 'worker_not_found' } });
    expect((await readRevisionedTeamConfig(teamName, cwd))?.config.active_recovery).toBeUndefined();
  });

  it('publishes a saved timeout final after its owner died between the config save and the final', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-crash-');
    const teamName = 'deadline-crash';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    // The owner that decided the timeout is dead (this pid, another start).
    const deadStartedAt = hostValidDeadProcessStartIdentity(process.pid);
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: deadStartedAt, nonce: 'prior-owner' });
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.runtime_owner_epoch = { epoch: 1, nonce: 'prior-owner', pid: process.pid, process_started_at: deadStartedAt,
      created_at: new Date().toISOString() };
    writeFileSync(configPath, JSON.stringify(config));
    const input = { teamName, cwd, workerName: 'worker-1', requestId: 'stuck-request', instanceId: TEAM_INSTANCE_ID };
    const timeout = { outcome: 'failed' as const, committed: false as const, error: 'recovery_request_timeout' as const,
      message: 'Recovery owner deadline exceeded: no attempt finished within 300000 ms of admission.',
      requestId: 'stuck-request', recoveryId: 'stuck-recovery', teamName, workerName: 'worker-1', updatedAt: new Date().toISOString() };
    // The owner dies right after the config save, before it publishes the final.
    await finalizeRecoveryOwnerResult(input, 'stuck-recovery', timeout, {
      readRevisionedConfig: readRevisionedTeamConfig,
      saveConfigAtRevision: saveTeamConfigAtRevision,
      publishFinal: () => { throw new Error('owner died'); },
    });
    const saved = await readRevisionedTeamConfig(teamName, cwd);
    expect(saved?.config.active_recovery).toBeUndefined();
    expect(saved?.config.last_recovery).toMatchObject({ recovery_id: 'stuck-recovery', phase: 'failed' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toBeNull();

    await expect(execute(teamName)).resolves.toMatchObject({ outcome: 'failed', error: 'recovery_request_timeout' });
    expect(readRecoveryFinalState(cwd, 'stuck-request')).toMatchObject({ kind: 'valid',
      final: { outcome: 'failed', error: { code: 'recovery_request_timeout', message: expect.stringContaining('deadline exceeded') } } });
    expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
    expect((await readRevisionedTeamConfig(teamName, cwd))?.config.active_recovery).toBeUndefined();
  });

  it('fails a never-elected request past the deadline without touching the active recovery', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-unelected-');
    const teamName = 'deadline-unelected';
    await reserveFixtureInstance(teamName, cwd);
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, instance_id: TEAM_INSTANCE_ID, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
      lifecycle_state: 'active', state_revision: 3,
      active_recovery: { request_id: 'other-request', recovery_id: 'other-recovery', worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'other-owner', phase: 'active', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }));
    reserveRecoveryRequest(cwd, 'waiting-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1', instanceId: TEAM_INSTANCE_ID }, 'waiting-recovery');
    writeIntent(teamName, 'waiting-request', 'waiting-recovery', PAST_DEADLINE_MS);

    await expect(execute(teamName, 'waiting-request')).resolves.toMatchObject({ outcome: 'failed', error: 'recovery_request_timeout' });
    expect(readRecoveryFinalState(cwd, 'waiting-request')).toMatchObject({ kind: 'valid',
      final: { outcome: 'failed', recovery_id: 'waiting-recovery', error: { code: 'recovery_request_timeout' } } });
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'other-recovery' } },
    });
  });

  it('does not let a caller that is not the live owner finalize past the deadline', async () => {
    cwd = mkdtempFixture('runtime-owner-deadline-non-owner-');
    const teamName = 'deadline-non-owner';
    await seedElectedUnknownLiveness(teamName, PAST_DEADLINE_MS);
    // The parent process is alive, so it stands in for the detached owner.
    const ownerStartedAt = currentProcessStartIdentity(process.ppid);
    expect(ownerStartedAt).not.toBeNull();
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.ppid, processStartedAt: ownerStartedAt!, nonce: 'prior-owner' });

    await expect(execute(teamName)).resolves.toMatchObject({ outcome: 'failed', error: 'runtime_owner_fence_lost' });
    expect(readRecoveryOutcome(cwd, 'stuck-request')).toBeNull();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'stuck-recovery', owner_nonce: 'prior-owner' } },
    });
  });
});
