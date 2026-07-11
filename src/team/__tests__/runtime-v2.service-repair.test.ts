import { beforeEach, describe, expect, it, vi } from 'vitest';

const mergeMocks = vi.hoisted(() => ({
  registerWorker: vi.fn(async (_worker: string) => undefined),
  unregisterWorker: vi.fn(async (_worker: string) => undefined),
  drainAndStop: vi.fn(async () => ({ unmerged: [] as string[] })),
  startMergeOrchestrator: vi.fn(),
}));
const cadenceMocks = vi.hoisted(() => ({
  installCommitCadence: vi.fn(async (_context?: { workerName?: string }): Promise<{ method: 'hook' | 'fallback-poll' }> => ({ method: 'hook' })),
  startFallbackPoller: vi.fn(() => ({ stop: vi.fn() })),
  uninstallCommitCadence: vi.fn(async () => undefined),
}));

vi.mock('../merge-orchestrator.js', () => ({
  startMergeOrchestrator: mergeMocks.startMergeOrchestrator,
  recoverFromRestart: vi.fn(async () => undefined),
}));
vi.mock('../worker-commit-cadence.js', () => ({
  installCommitCadence: cadenceMocks.installCommitCadence,
  startFallbackPoller: cadenceMocks.startFallbackPoller,
  uninstallCommitCadence: cadenceMocks.uninstallCommitCadence,
}));

import { reconcileCommittedTeamServices } from '../runtime-v2.js';
import type { TeamConfig, WorkerInfo } from '../types.js';

const launch = (provider: 'codex' | 'gemini') => ({
  schema_version: 1 as const,
  provider,
  model: provider === 'codex' ? 'gpt-5-codex' : 'gemini-2.5-pro',
  binary: `/usr/bin/${provider}`,
  args: ['--model', provider === 'codex' ? 'gpt-5-codex' : 'gemini-2.5-pro'],
});

function config(overrides: Partial<TeamConfig> = {}): TeamConfig {
  const workers: WorkerInfo[] = [
    { name: 'worker-1', index: 1, role: 'executor', worker_cli: 'codex', assigned_tasks: [],
      worktree_path: '/repo/.omc/team/demo/worktrees/worker-1', launch_descriptor: launch('codex') },
    { name: 'worker-2', index: 2, role: 'executor', worker_cli: 'gemini', assigned_tasks: [],
      worktree_path: '/repo/.omc/team/demo/worktrees/worker-2', launch_descriptor: launch('gemini') },
  ];
  return {
    name: 'demo', worker_count: workers.length, workers, agent_type: 'claude', created_at: new Date().toISOString(),
    tmux_session: 'demo:0', leader_pane_id: null, hud_pane_id: null, resize_hook_name: null,
    resize_hook_target: null, worktree_mode: 'named',
    service_descriptor: { schema_version: 1, service_generation: 3, service_attempt_id: '3:owner',
      auto_merge_enabled: true, workspace_root: '/repo', leader_branch: 'main', cadence_policy: 'worker-auto-commit-v1' },
    ...overrides,
  } as TeamConfig;
}

describe('runtime-v2 committed service reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mergeMocks.startMergeOrchestrator.mockResolvedValue({
      registerWorker: mergeMocks.registerWorker,
      unregisterWorker: mergeMocks.unregisterWorker,
      drainAndStop: mergeMocks.drainAndStop,
    });
  });

  it('fails closed when service metadata is absent', async () => {
    await expect(reconcileCommittedTeamServices(config({ service_descriptor: undefined }), '/repo'))
      .resolves.toBe('repair_required');
    expect(mergeMocks.startMergeOrchestrator).not.toHaveBeenCalled();
  });

  it('accepts an explicit disabled descriptor without service effects', async () => {
    await expect(reconcileCommittedTeamServices(config({
      service_descriptor: { schema_version: 1, service_generation: 1, service_attempt_id: '1:owner',
        auto_merge_enabled: false, workspace_root: '/repo', cadence_policy: 'disabled' },
    }), '/repo')).resolves.toBe('synced');
    expect(mergeMocks.startMergeOrchestrator).not.toHaveBeenCalled();
    expect(cadenceMocks.installCommitCadence).not.toHaveBeenCalled();
  });

  it('reconstructs every committed worker using persisted providers and service identity', async () => {
    await expect(reconcileCommittedTeamServices(config(), '/repo')).resolves.toBe('synced');
    expect(mergeMocks.startMergeOrchestrator).toHaveBeenCalledWith(expect.objectContaining({
      serviceGeneration: 3, serviceAttemptId: '3:owner', leaderBranch: 'main', repoRoot: '/repo',
    }));
    expect(mergeMocks.registerWorker.mock.calls.map(([worker]) => worker)).toEqual(['worker-1', 'worker-2']);
    expect(cadenceMocks.installCommitCadence).toHaveBeenCalledWith(expect.objectContaining({
      workerName: 'worker-1', agentType: 'codex', serviceGeneration: 3, attemptId: '3:owner',
    }));
    expect(cadenceMocks.installCommitCadence).toHaveBeenCalledWith(expect.objectContaining({
      workerName: 'worker-2', agentType: 'gemini', serviceGeneration: 3, attemptId: '3:owner',
    }));
  });

  it('does not duplicate exact-generation worker services on repeated reconciliation', async () => {
    const enabled = config({ name: 'demo-idempotent' });
    await expect(reconcileCommittedTeamServices(enabled, '/repo')).resolves.toBe('synced');
    await expect(reconcileCommittedTeamServices(enabled, '/repo')).resolves.toBe('synced');
    expect(mergeMocks.startMergeOrchestrator).toHaveBeenCalledTimes(1);
    expect(mergeMocks.registerWorker).toHaveBeenCalledTimes(2);
    expect(cadenceMocks.installCommitCadence).toHaveBeenCalledTimes(2);
    expect(cadenceMocks.startFallbackPoller).not.toHaveBeenCalled();
  });

  it('installs newly authoritative same-generation workers after reconciling the prior exact set', async () => {
    const oneWorker = config({ name: 'demo-same-generation-expand', worker_count: 1,
      workers: [config().workers[0]!] });
    const expanded = config({ name: 'demo-same-generation-expand' });

    await expect(reconcileCommittedTeamServices(oneWorker, '/repo')).resolves.toBe('synced');
    await expect(reconcileCommittedTeamServices(expanded, '/repo')).resolves.toBe('synced');
    await expect(reconcileCommittedTeamServices(expanded, '/repo')).resolves.toBe('synced');

    expect(mergeMocks.startMergeOrchestrator).toHaveBeenCalledTimes(1);
    expect(mergeMocks.registerWorker.mock.calls.map(([worker]) => worker)).toEqual(['worker-1', 'worker-2']);
    expect(cadenceMocks.installCommitCadence.mock.calls.map(([context]) => context!.workerName))
      .toEqual(['worker-1', 'worker-2']);
  });

  it('retains an incomplete expansion for retry after cadence installation fails', async () => {
    const oneWorker = config({ name: 'demo-same-generation-install-retry', worker_count: 1,
      workers: [config().workers[0]!] });
    const expanded = config({ name: 'demo-same-generation-install-retry' });

    await expect(reconcileCommittedTeamServices(oneWorker, '/repo')).resolves.toBe('synced');
    cadenceMocks.installCommitCadence.mockRejectedValueOnce(new Error('cadence settings unavailable'));
    await expect(reconcileCommittedTeamServices(expanded, '/repo')).resolves.toBe('repair_required');
    await expect(reconcileCommittedTeamServices(expanded, '/repo')).resolves.toBe('synced');

    expect(mergeMocks.registerWorker.mock.calls.map(([worker]) => worker)).toEqual(['worker-1', 'worker-2']);
    expect(cadenceMocks.installCommitCadence.mock.calls.map(([context]) => context!.workerName))
      .toEqual(['worker-1', 'worker-2', 'worker-2']);
  });

  it('removes stale same-generation services after scale-down and retries retained teardown', async () => {
    const enabled = config({ name: 'demo-scale-down-convergence' });
    const stalePoller = { stop: vi.fn() };
    cadenceMocks.installCommitCadence.mockImplementation(async (context?: { workerName?: string }) => (
      context?.workerName === 'worker-2' ? { method: 'fallback-poll' as const } : { method: 'hook' as const }
    ));
    cadenceMocks.startFallbackPoller.mockReturnValue(stalePoller);
    await expect(reconcileCommittedTeamServices(enabled, '/repo')).resolves.toBe('synced');

    const scaledDown = config({ name: 'demo-scale-down-convergence', worker_count: 1,
      workers: [enabled.workers[0]!] });
    cadenceMocks.uninstallCommitCadence.mockRejectedValueOnce(new Error('cadence hook busy'));
    await expect(reconcileCommittedTeamServices(scaledDown, '/repo')).resolves.toBe('repair_required');
    expect(mergeMocks.unregisterWorker).toHaveBeenCalledWith('worker-2');
    expect(stalePoller.stop).toHaveBeenCalledTimes(1);
    expect(cadenceMocks.uninstallCommitCadence).toHaveBeenCalledWith(expect.objectContaining({ workerName: 'worker-2' }));

    await expect(reconcileCommittedTeamServices(scaledDown, '/repo')).resolves.toBe('synced');
    expect(cadenceMocks.uninstallCommitCadence).toHaveBeenCalledTimes(2);
    await expect(reconcileCommittedTeamServices(scaledDown, '/repo')).resolves.toBe('synced');
    expect(mergeMocks.startMergeOrchestrator).toHaveBeenCalledTimes(1);
    expect(mergeMocks.registerWorker).toHaveBeenCalledTimes(2);
    expect(mergeMocks.unregisterWorker).toHaveBeenCalledTimes(1);
    expect(cadenceMocks.installCommitCadence).toHaveBeenCalledTimes(2);
  });

  it('does not repair services while a durable scale-up fence is active', async () => {
    const scaling = config({ name: 'demo-scale-up-fence' });
    scaling.active_scale_up = {
      operation_id: 'scale-up-1', phase: 'effects', pid: 1234,
      process_started_at: 'linux:123', state_revision: 2,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    await expect(reconcileCommittedTeamServices(scaling, '/repo')).resolves.toBe('repair_required');
    expect(mergeMocks.startMergeOrchestrator).not.toHaveBeenCalled();
    expect(cadenceMocks.installCommitCadence).not.toHaveBeenCalled();
  });

  it('reports repair_required when any committed worker metadata is incomplete', async () => {
    const broken = config();
    broken.workers[1] = { ...broken.workers[1]!, launch_descriptor: undefined };
    await expect(reconcileCommittedTeamServices(broken, '/repo')).resolves.toBe('repair_required');
    expect(mergeMocks.startMergeOrchestrator).not.toHaveBeenCalled();
  });
  it('drains stale enabled local services before reporting disabled state synced', async () => {
    const enabled = config({ name: 'demo-disable-transition' });
    await expect(reconcileCommittedTeamServices(enabled, '/repo')).resolves.toBe('synced');
    mergeMocks.drainAndStop.mockClear();

    const disabled = config({ name: 'demo-disable-transition',
      service_descriptor: { schema_version: 1, service_generation: 4, service_attempt_id: '4:owner',
        auto_merge_enabled: false, workspace_root: '/repo', cadence_policy: 'disabled' } });
    await expect(reconcileCommittedTeamServices(disabled, '/repo')).resolves.toBe('synced');
    expect(mergeMocks.drainAndStop).toHaveBeenCalledTimes(1);
    expect(cadenceMocks.uninstallCommitCadence).toHaveBeenCalled();
  });

  it('reports repair_required when disabled transition cannot uninstall cadence', async () => {
    const enabled = config({ name: 'demo-disable-failure' });
    await expect(reconcileCommittedTeamServices(enabled, '/repo')).resolves.toBe('synced');
    cadenceMocks.uninstallCommitCadence
      .mockRejectedValueOnce(new Error('hook busy 1'))
      .mockRejectedValueOnce(new Error('hook busy 2'))
      .mockRejectedValueOnce(new Error('hook still busy 1'))
      .mockRejectedValueOnce(new Error('hook still busy 2'));
    const disabled = config({ name: 'demo-disable-failure',
      service_descriptor: { schema_version: 1, service_generation: 4, service_attempt_id: '4:owner',
        auto_merge_enabled: false, workspace_root: '/repo', cadence_policy: 'disabled' } });
    await expect(reconcileCommittedTeamServices(disabled, '/repo')).resolves.toBe('repair_required');
    await expect(reconcileCommittedTeamServices(disabled, '/repo')).resolves.toBe('repair_required');
    await expect(reconcileCommittedTeamServices(disabled, '/repo')).resolves.toBe('synced');
  });

});
