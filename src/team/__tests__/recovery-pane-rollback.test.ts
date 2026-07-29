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
  isPromptModeAgent: vi.fn(() => false),
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
      leader_pane_id: '%leader',
    }));
    reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker',
      workspaceHash: createHash('sha256').update(cwd).digest('hex'), teamName, workerName: 'worker-1' }, recoveryId);
    paneMocks.getWorkerLiveness.mockResolvedValueOnce('dead').mockResolvedValue('alive');

    await expect(executeRecoverDeadWorkerV2Owner({ teamName, cwd, workerName: 'worker-1', requestId }))
      .resolves.toMatchObject({ outcome: 'failed', error: 'spawn_failed', recoveryId });

    expect(paneMocks.splitTeamWorkerPaneWithEvidence).toHaveBeenCalled();
    expect(paneMocks.spawnWorkerInPane).toHaveBeenCalled();
    expect(paneMocks.killTeamPane).toHaveBeenCalledTimes(2);
    const evidenceRoot = absPath(cwd, `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}`);
    const evidenceFiles = readdirSync(evidenceRoot);
    expect(evidenceFiles).toHaveLength(1);
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, evidenceFiles[0]!), 'utf8'));
    expect(evidence).toMatchObject({ schema_version: 1, team_name: teamName, worker_name: 'worker-1',
      request_id: requestId, recovery_id: recoveryId, pane_id: '%2', reason: 'spawn failed --api-key=<redacted> after pane creation', liveness: 'alive' });
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
