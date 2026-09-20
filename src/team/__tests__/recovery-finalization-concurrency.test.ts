import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRevisionedTeamConfig, saveTeamConfig, saveTeamConfigAtRevision, withTeamConfigMutationLock } from '../monitor.js';
import { finalizeRecoveryOwnerResult } from '../runtime-v2.js';
import { absPath, TeamPaths } from '../state-paths.js';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
import {
  activateTeamInstanceUnderLock,
  createTeamInstanceBinding,
  reserveTeamInstance,
  withTeamInstanceLifecycleLock,
} from '../team-instance.js';
import type { TeamConfig } from '../types.js';

let cwd: string;
const TEAM_INSTANCE_ID = '55555555-5555-4555-8555-555555555555';
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousOmcStateDir: string | undefined;
beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousOmcStateDir = process.env.OMC_STATE_DIR;
});
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = previousOmcStateDir;
  cwd = '';
});

function fixtureTmuxServerIdentity(): { socket_path: string; server_pid: number; process_started_at: string } {
  const processStartedAt = currentStrictProcessStartIdentity();
  if (!processStartedAt) throw new Error('fixture tmux process identity unavailable');
  return {
    socket_path: join(cwd, '.omc-fixture-tmux.sock'),
    server_pid: process.pid,
    process_started_at: processStartedAt,
  };
}

describe('recovery terminal publication revision fence', () => {
  it('publishes no final when a competing normal config writer wins after the recovery snapshot', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'recovery-final-revision-race-'));
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    process.env.OMC_STATE_DIR = join(cwd, 'omc-state');
    const teamName = 'recovery-team';
    const tmuxServerIdentity = fixtureTmuxServerIdentity();
    const instance = createTeamInstanceBinding({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
    await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
    const config: TeamConfig = {
      name: teamName, instance_id: TEAM_INSTANCE_ID, tmux_server_identity: tmuxServerIdentity,
      worker_count: 1, workers: [{ name: 'worker-1', index: 1 }], agent_type: 'claude',
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
    writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify({
      schema_version: 2,
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      tmux_server_identity: tmuxServerIdentity,
      task: '',
      leader: { session_id: `${teamName}:0`, worker_id: 'leader-fixed', role: 'leader' },
      policy: { display_mode: 'split_pane', worker_launch_mode: 'interactive', dispatch_mode: 'hook_preferred_with_fallback', dispatch_ack_timeout_ms: 15_000 },
      governance: { delegation_only: false, plan_approval_required: false, nested_teams_allowed: false, one_team_per_leader_session: true, cleanup_requires_all_workers_inactive: true },
      permissions_snapshot: { approval_mode: 'default', sandbox_mode: 'workspace-write', network_access: false },
      tmux_session: config.tmux_session,
      worker_count: config.worker_count,
      workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
      next_task_id: 1,
      created_at: config.created_at,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    }));
    await withTeamInstanceLifecycleLock(cwd, teamName, () => activateTeamInstanceUnderLock(instance));
    let firstRead = true;
    const publishFinal = vi.fn((_input, _recoveryId, result) => result);
    const result = {
      outcome: 'already_running' as const, committed: true as const, oldPaneId: '%1', newPaneId: '%1',
      requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 5, activation: 'active' as const,
      manifestSync: 'synced' as const, servicesSync: 'synced' as const, warnings: [], requestId: 'request-a',
      recoveryId: 'recovery-a', teamName, workerName: 'worker-1', updatedAt: new Date().toISOString(),
    };

    const finalized = await finalizeRecoveryOwnerResult({ teamName, cwd, workerName: 'worker-1', requestId: 'request-a', instanceId: TEAM_INSTANCE_ID },
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
