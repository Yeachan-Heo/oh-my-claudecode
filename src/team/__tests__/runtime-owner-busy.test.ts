import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmuxMocks = vi.hoisted(() => ({
  tmuxExecAsync: vi.fn(async (_args: string[]) => ({ stdout: '', stderr: '' })),
  tmuxCmdAsync: vi.fn(async (_args: string[]): Promise<{ stdout: string; stderr: string }> => { throw new Error('tmux transport unavailable'); }),
}));
vi.mock('../../cli/tmux-utils.js', () => tmuxMocks);

import { readRecoveryOutcome, reserveRecoveryRequest } from '../recovery-request-store.js';
import { executeRecoverDeadWorkerV2Owner } from '../runtime-v2.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { readRevisionedTeamConfig } from '../monitor.js';
import { publishOwnerEpoch, readLatestOwnerEpoch } from '../team-owner-epoch.js';

const launchMetadata = { worker_cli: 'claude' as const,
  launch_descriptor: { schema_version: 1 as const, provider: 'claude' as const, model: null,
    binary: '/usr/bin/claude', args: ['--dangerously-skip-permissions'] } };

let cwd: string;
afterEach(() => {
  vi.clearAllMocks();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('runtime owner team mutation contention', () => {
  it('returns team_mutation_busy without publishing a terminal final for the waiting recovery', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-busy-'));
    const teamName = 'busy-team';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName,
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
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, 'waiting-recovery');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'waiting-request' }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId: 'waiting-recovery' });
    expect(readRecoveryOutcome(cwd, 'waiting-request')).toBeNull();
  });

  it('keeps recovery transient while a durable scale-down reservation is active', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-scale-down-busy-'));
    const teamName = 'scale-down-busy-team';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify({
      name: teamName, worker_count: 2,
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
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-2' }, 'scale-down-waiting-recovery');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-2', requestId: 'scale-down-waiting-request' }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'team_mutation_busy', recoveryId: 'scale-down-waiting-recovery' });
    expect(readRecoveryOutcome(cwd, 'scale-down-waiting-request')).toBeNull();
  });

  it('terminally rejects a persisted attempt secret with a mismatched durable identity tuple', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-attempt-secret-'));
    const teamName = 'attempt-team';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1', replacement_generation: 1 }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'attempt-team:0',
      lifecycle_state: 'active', state_revision: 3,
    }));
    reserveRecoveryRequest(cwd, 'attempt-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, 'attempt-recovery');
    const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, 'attempt-recovery'));
    mkdirSync(join(attemptPath, '..'), { recursive: true });
    writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: 'wrong-request',
      recovery_id: 'attempt-recovery', worker_name: 'worker-1', replacement_generation: 2,
      adoption_token: 'token', created_at: new Date().toISOString() }));

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'attempt-request' }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'invalid_persisted_state', recoveryId: 'attempt-recovery' });
    expect(readRecoveryOutcome(cwd, 'attempt-request')).toMatchObject({ kind: 'final', outcome: 'failed',
      error: { code: 'invalid_persisted_state' } });
  });


  it('rejects PID-reuse takeover when the active recovery belongs to a different attempt', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-pid-reuse-'));
    const teamName = 'pid-reuse-team';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, worker_count: 1, workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%1' }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'pid-reuse-team:0',
      lifecycle_state: 'active', state_revision: 3,
      active_recovery: { request_id: 'other-request', recovery_id: 'other-recovery', worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'reused-pid-owner', phase: 'active', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }));
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: 'linux:1', nonce: 'reused-pid-owner' });
    reserveRecoveryRequest(cwd, 'waiting-pid-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, 'waiting-pid-recovery');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'waiting-pid-request' }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'runtime_owner_fence_lost' });
    const owner = readLatestOwnerEpoch(cwd, teamName);
    expect(owner).toMatchObject({ epoch: 1, pid: process.pid, process_started_at: 'linux:1' });
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'other-recovery', owner_epoch: 1 } },
    });
  });
  it('retains a committed pane on unknown liveness without spawning a duplicate replacement', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-unknown-committed-pane-'));
    const teamName = 'committed-team';
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, pane_id: '%9', pane_attempt_id: 'attempt-a',
        recovery_id: 'committed-recovery', replacement_generation: 2 }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: 'committed-team:0',
      lifecycle_state: 'active', state_revision: 3,
      active_recovery: { request_id: 'committed-request', recovery_id: 'committed-recovery', worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'prior-owner', phase: 'active', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }));
    reserveRecoveryRequest(cwd, 'committed-request', { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, 'committed-recovery');
    const attemptPath = absPath(cwd, TeamPaths.recoveryAttempt(teamName, 'committed-recovery'));
    mkdirSync(join(attemptPath, '..'), { recursive: true });
    writeFileSync(attemptPath, JSON.stringify({ schema_version: 1, request_id: 'committed-request',
      recovery_id: 'committed-recovery', worker_name: 'worker-1', replacement_generation: 2,
      adoption_token: 'stable-token', created_at: new Date().toISOString() }));

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId: 'committed-request' }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'worker_liveness_unknown', recoveryId: 'committed-recovery' });
    expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
    expect(readRecoveryOutcome(cwd, 'committed-request')).toBeNull();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      config: { active_recovery: { recovery_id: 'committed-recovery' },
        workers: [{ pane_id: '%9', pane_attempt_id: 'attempt-a', replacement_generation: 2 }] },
    });
  });

  it.each(['alive', 'unknown', 'missing'] as const)('rechecks %s original-pane liveness after election before replay effects', async liveness => {
    cwd = mkdtempSync(join(tmpdir(), `runtime-owner-precommit-${liveness}-`));
    const teamName = `precommit-${liveness}-team`;
    const requestId = `request-${liveness}`;
    const recoveryId = `recovery-${liveness}`;
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      name: teamName, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, ...launchMetadata, replacement_generation: 1,
        ...(liveness === 'missing' ? {} : { pane_id: '%1' }) }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
      lifecycle_state: 'active', state_revision: 3,
      active_recovery: { request_id: requestId, recovery_id: recoveryId, worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'prior-owner', phase: 'reserved', state_revision: 3,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    }));
    reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
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
    if (liveness === 'alive') {
      tmuxMocks.tmuxCmdAsync.mockResolvedValueOnce({ stdout: '0', stderr: '' });
    } else if (liveness === 'unknown') {
      tmuxMocks.tmuxCmdAsync.mockRejectedValueOnce(new Error('tmux transport unavailable'));
    }

    const result = await executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId });
    expect(result).toMatchObject(liveness === 'alive'
      ? { outcome: 'already_running', recoveryId }
      : { outcome: 'failed', error: 'worker_liveness_unknown', recoveryId });
    expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
    const persisted = await readRevisionedTeamConfig(teamName, cwd);
    if (liveness === 'alive') {
      expect(readRecoveryOutcome(cwd, requestId)).toMatchObject({ kind: 'final', recovery_id: recoveryId });
      expect(persisted?.config.active_recovery).toBeUndefined();
    } else {
      expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
      expect(persisted?.config.active_recovery).toMatchObject({ recovery_id: recoveryId });
    }
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
    cwd = mkdtempSync(join(tmpdir(), 'runtime-owner-launch-metadata-'));
    const teamName = `launch-${expectedError}`;
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ name: teamName, worker_count: 1,
      workers: [{ name: 'worker-1', index: 1, worker_cli: 'claude', pane_id: '%1',
        ...(launchDescriptor ? { launch_descriptor: launchDescriptor } : {}) }],
      agent_type: 'claude', created_at: new Date().toISOString(), tmux_session: `${teamName}:0`,
      lifecycle_state: 'active', state_revision: 3 }));
    const requestId = `request-${expectedError}`;
    reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' },
    `recovery-${expectedError}`);

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
      .resolves.toMatchObject({ outcome: 'failed', error: expectedError });
    expect(tmuxMocks.tmuxExecAsync.mock.calls.some(([args]) => args[0] === 'split-window')).toBe(false);
  });

});
