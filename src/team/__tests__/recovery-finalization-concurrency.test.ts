import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRevisionedTeamConfig, saveTeamConfig, saveTeamConfigAtRevision, withTeamConfigMutationLock } from '../monitor.js';
import { finalizeRecoveryOwnerResult } from '../runtime-v2.js';
import { absPath, TeamPaths } from '../state-paths.js';
import type { TeamConfig } from '../types.js';

let cwd: string;
afterEach(() => { if (cwd) rmSync(cwd, { recursive: true, force: true }); });

describe('recovery terminal publication revision fence', () => {
  it('publishes no final when a competing normal config writer wins after the recovery snapshot', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'recovery-final-revision-race-'));
    const teamName = 'recovery-team';
    const config: TeamConfig = {
      name: teamName, worker_count: 1, workers: [{ name: 'worker-1', index: 1 }], agent_type: 'claude',
      created_at: new Date().toISOString(), tmux_session: 'recovery-team:0', state_revision: 5,
      active_recovery: {
        request_id: 'request-a', recovery_id: 'recovery-a', worker_name: 'worker-1', owner_epoch: 2,
        owner_nonce: 'owner-a', phase: 'active', state_revision: 5,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    } as TeamConfig;
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config));
    let firstRead = true;
    const publishFinal = vi.fn((_input, _recoveryId, result) => result);
    const result = {
      outcome: 'already_running' as const, committed: true as const, oldPaneId: '%1', newPaneId: '%1',
      requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 5, activation: 'active' as const,
      manifestSync: 'synced' as const, servicesSync: 'synced' as const, warnings: [], requestId: 'request-a',
      recoveryId: 'recovery-a', teamName, workerName: 'worker-1', updatedAt: new Date().toISOString(),
    };

    const finalized = await finalizeRecoveryOwnerResult({ teamName, cwd, workerName: 'worker-1', requestId: 'request-a' },
      'recovery-a', result, {
        readRevisionedConfig: async (name, workspace) => {
          const snapshot = await readRevisionedTeamConfig(name, workspace);
          if (firstRead) {
            firstRead = false;
            const competing = structuredClone(snapshot!.config);
            competing.next_task_id = 7;
            await saveTeamConfig(competing, workspace, competing.state_revision);
          }
          return snapshot;
        },
        saveConfigAtRevision: saveTeamConfigAtRevision,
        withConfigLock: withTeamConfigMutationLock,
        publishFinal,
      });

    expect(finalized).toMatchObject({ outcome: 'commit_unknown', error: 'stale_state_revision' });
    expect(publishFinal).not.toHaveBeenCalled();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      stateRevision: 6,
      config: { next_task_id: 7, active_recovery: { recovery_id: 'recovery-a' } },
    });
  });
});
