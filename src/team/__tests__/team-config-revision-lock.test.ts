import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateTeamConfigRevision, readRevisionedTeamConfig, readTeamConfig, readTeamManifest, saveTeamConfig, saveTeamConfigAtRevision, withScalingLock } from '../monitor.js';
import { absPath, TeamPaths } from '../state-paths.js';
import type { TeamConfig } from '../types.js';
import { withProcessIdentityFileLock, withProcessIdentityFileLockSync } from '../process-identity-lock.js';
import { currentProcessStartIdentity } from '../team-owner-epoch.js';
import { teamCreateTask, teamReadConfig, teamReadManifest, withTaskClaimLock } from '../team-ops.js';

let cwd: string;
const teamName = 'config-lock-team';

function initialConfig(): TeamConfig {
  return {
    name: teamName,
    task: 'config mutation test',
    worker_count: 1,
    max_workers: 20,
    workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
    agent_type: 'claude',
    worker_launch_mode: 'interactive',
    created_at: new Date().toISOString(),
    tmux_session: 'config-lock-team:0',
    next_task_id: 1,
    leader_pane_id: null,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    state_revision: 1,
    active_recovery: {
      request_id: 'request-a', recovery_id: 'recovery-a', worker_name: 'worker-1', owner_epoch: 1,
      owner_nonce: 'owner-a', phase: 'active', state_revision: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
  } as TeamConfig;
}

function writeConfig(config: TeamConfig): void {
  const path = absPath(cwd, TeamPaths.config(teamName));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
}

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'team-config-lock-')); writeConfig(initialConfig()); });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('team config revision transaction', () => {
  it('rejects recovery cleanup and publishes no final after a normal writer wins the revision', async () => {
    const normal = initialConfig();
    normal.next_task_id = 2;
    await saveTeamConfig(normal, cwd, normal.state_revision);
    expect(normal.state_revision).toBe(2);

    const finalPublished = vi.fn();
    const cleanup = { ...initialConfig(), state_revision: 2, active_recovery: undefined,
      last_recovery: { ...initialConfig().active_recovery!, phase: 'adopted' as const, state_revision: 2 } };
    await expect(saveTeamConfigAtRevision(cleanup, 1, cwd, finalPublished)).resolves.toBe(false);
    expect(finalPublished).not.toHaveBeenCalled();
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      stateRevision: 2,
      config: { next_task_id: 2, active_recovery: { recovery_id: 'recovery-a' } },
    });
  });

  it.each(['shutting_down', 'stopped'] as const)('rejects task admission when lifecycle is %s', async lifecycle_state => {
    const config = initialConfig();
    config.lifecycle_state = lifecycle_state;
    writeConfig(config);

    await expect(teamCreateTask(teamName, {
      subject: 'must not create', description: 'lifecycle fenced', status: 'pending', owner: undefined, blocked_by: [],
    }, cwd)).rejects.toThrow('team_mutation_busy');
    expect(existsSync(absPath(cwd, TeamPaths.taskFile(teamName, '1')))).toBe(false);
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      stateRevision: 1, config: { lifecycle_state },
    });
  });

  it('compensates a created task when the counter revision CAS loses', async () => {
    const saveAtRevision = vi.fn(async () => false);
    vi.resetModules();
    vi.doMock('../monitor.js', async importOriginal => ({
      ...await importOriginal<typeof import('../monitor.js')>(),
      saveTeamConfigAtRevision: saveAtRevision,
    }));

    try {
      const { teamCreateTask: createTask } = await import('../team-ops.js');
      await expect(createTask(teamName, {
        subject: 'racing task', description: 'must be compensated', status: 'pending', owner: undefined, blocked_by: [],
      }, cwd)).rejects.toThrow('stale_state_revision');
    } finally {
      vi.doUnmock('../monitor.js');
      vi.resetModules();
    }

    expect(saveAtRevision).toHaveBeenCalledWith(expect.objectContaining({
      name: teamName, next_task_id: 2, state_revision: 2,
    }), 1, cwd);
    expect(existsSync(absPath(cwd, TeamPaths.taskFile(teamName, '1')))).toBe(false);
    const persisted = await readRevisionedTeamConfig(teamName, cwd);
    expect(persisted?.stateRevision).toBe(1);
    expect(persisted?.config.lifecycle_state).toBeUndefined();
  });

  it('does not recreate a team when the authoritative config disappears before CAS', async () => {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    unlinkSync(configPath);
    const afterCommit = vi.fn();
    const stale = { ...initialConfig(), state_revision: 2,
      active_recovery: { ...initialConfig().active_recovery!, state_revision: 2 } };

    await expect(saveTeamConfigAtRevision(stale, 1, cwd, afterCommit)).resolves.toBe(false);
    expect(afterCommit).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(false);
  });

  it('does not commit authoritative config when manifest projection cannot be written', async () => {
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    mkdirSync(manifestPath, { recursive: true });
    const next = { ...initialConfig(), state_revision: 2, next_task_id: 99,
      active_recovery: { ...initialConfig().active_recovery!, state_revision: 2 } };

    await expect(saveTeamConfigAtRevision(next, 1, cwd)).rejects.toThrow('invalid_persisted_state');
    const persisted = await readRevisionedTeamConfig(teamName, cwd);
    expect(persisted?.stateRevision).toBe(1);
    expect(persisted?.config.next_task_id).toBe(1);
  });

  it('holds the config lock through terminal publication and rejects a stale competing writer', async () => {
    let releaseFinal!: () => void;
    const finalRelease = new Promise<void>(resolve => { releaseFinal = resolve; });
    let finalEntered!: () => void;
    const entered = new Promise<void>(resolve => { finalEntered = resolve; });
    const cleanup = { ...initialConfig(), state_revision: 2, active_recovery: undefined,
      last_recovery: { ...initialConfig().active_recovery!, phase: 'adopted' as const, state_revision: 2 } };
    const recoveryCommit = saveTeamConfigAtRevision(cleanup, 1, cwd, async () => {
      finalEntered();
      await finalRelease;
    });
    await entered;

    const staleNormal = initialConfig();
    staleNormal.next_task_id = 9;
    let normalSettled = false;
    const normalWrite = saveTeamConfig(staleNormal, cwd, staleNormal.state_revision).finally(() => { normalSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(normalSettled).toBe(false);

    releaseFinal();
    await expect(recoveryCommit).resolves.toBe(true);
    await expect(normalWrite).rejects.toThrow('stale_state_revision');
    const persisted = await readRevisionedTeamConfig(teamName, cwd);
    expect(persisted).toMatchObject({ stateRevision: 2, config: { last_recovery: { recovery_id: 'recovery-a' } } });
    expect(persisted?.config.active_recovery).toBeUndefined();
  });

  it('reclaims a config lock only after its persisted process identity is dead', async () => {
    const lockPath = absPath(cwd, TeamPaths.configMutationLock(teamName));
    writeFileSync(lockPath, JSON.stringify({ schema_version: 1, pid: 2_147_483_647,
      process_started_at: 'linux:1', nonce: 'dead-lock', created_at: new Date().toISOString() }));
    const config = initialConfig();
    config.next_task_id = 3;

    await expect(saveTeamConfig(config, cwd, config.state_revision)).resolves.toBeUndefined();
    expect(existsSync(lockPath)).toBe(false);
    expect(config.state_revision).toBe(2);
  });


  it('rejects a stale pre-incremented writer that would restore cleared recovery state', async () => {
    const cleanup = { ...initialConfig(), state_revision: 2, active_recovery: undefined,
      last_recovery: { ...initialConfig().active_recovery!, phase: 'adopted' as const, state_revision: 2 } };
    await expect(saveTeamConfigAtRevision(cleanup, 1, cwd)).resolves.toBe(true);
    const stalePreincremented = initialConfig();
    stalePreincremented.state_revision = 2;
    stalePreincremented.active_recovery = { ...stalePreincremented.active_recovery!, state_revision: 2 };
    stalePreincremented.next_task_id = 11;

    await expect(saveTeamConfig(stalePreincremented, cwd, 1)).rejects.toThrow('stale_state_revision');
    const persisted = await readRevisionedTeamConfig(teamName, cwd);
    expect(persisted).toMatchObject({ stateRevision: 2, config: { last_recovery: { recovery_id: 'recovery-a' } } });
    expect(persisted?.config.active_recovery).toBeUndefined();
  });

  it('preserves a normal writer that wins immediately before concurrent legacy migration', async () => {
    const legacy = initialConfig();
    delete legacy.state_revision;
    delete legacy.active_recovery;
    writeConfig(legacy);
    const normal = structuredClone(legacy);
    normal.next_task_id = 13;

    const normalWrite = saveTeamConfig(normal, cwd);
    const migration = migrateTeamConfigRevision(teamName, cwd);
    await expect(normalWrite).resolves.toBeUndefined();
    await expect(migration).resolves.toMatchObject({ stateRevision: 0, config: { next_task_id: 13 } });
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      stateRevision: 0, config: { next_task_id: 13 },
    });
  });

  it('never lets a divergent manifest override revisioned config authority', async () => {
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    writeFileSync(manifestPath, JSON.stringify({ schema_version: 2, state_revision: 99, name: teamName,
      workers: [{ name: 'worker-1', index: 1, pane_id: '%manifest' }], worker_count: 1, next_task_id: 99 }));

    const authoritative = await readRevisionedTeamConfig(teamName, cwd);
    expect(authoritative?.stateRevision).toBe(1);
    expect(authoritative?.config.next_task_id).not.toBe(99);
    expect(authoritative?.config.workers[0]?.pane_id).not.toBe('%manifest');
    await expect(readTeamConfig(teamName, cwd)).resolves.toMatchObject({ state_revision: 1,
      workers: [{ name: 'worker-1' }] });
    expect((await readTeamConfig(teamName, cwd))?.workers[0]?.pane_id).not.toBe('%manifest');
    expect((await teamReadConfig(teamName, cwd))?.workers[0]?.pane_id).not.toBe('%manifest');
    expect((await teamReadConfig(teamName, cwd))?.next_task_id).not.toBe(99);
  });

  it('refuses malformed authoritative config instead of bootstrapping from a divergent manifest', async () => {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const malformed = '{"name":"config-lock-team"';
    writeFileSync(configPath, malformed);
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    writeFileSync(manifestPath, JSON.stringify({ schema_version: 2, state_revision: 99, name: teamName,
      workers: [{ name: 'worker-1', index: 1, pane_id: '%stale' }], worker_count: 1, next_task_id: 99 }));

    await expect(readTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamReadConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(saveTeamConfig(initialConfig(), cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamCreateTask(teamName, { subject: 'must not create', description: 'stale manifest',
      status: 'pending', owner: undefined, blocked_by: [] }, cwd)).rejects.toThrow('invalid_persisted_state');
    expect(existsSync(absPath(cwd, TeamPaths.taskFile(teamName, '1')))).toBe(false);
    await expect(migrateTeamConfigRevision(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    expect(readFileSync(configPath, 'utf8')).toBe(malformed);
  });

  it('fails closed on a malformed manifest when authoritative config is absent', async () => {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    unlinkSync(configPath);
    writeFileSync(manifestPath, '{"schema_version":2');

    await expect(readTeamManifest(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(teamReadManifest(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(readTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');

    await expect(teamReadConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(migrateTeamConfigRevision(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
  });

  it.each([
    ['incomplete', { state_revision: 1 }],
    ['negative revision', { ...initialConfig(), state_revision: -1 }],
    ['mismatched path name', { ...initialConfig(), name: 'other-team' }],
    ['duplicate worker names', { ...initialConfig(), worker_count: 2, workers: [
      { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
      { name: 'worker-1', index: 2, role: 'executor', assigned_tasks: [] },
    ] }],
    ['duplicate worker indices', { ...initialConfig(), worker_count: 2, workers: [
      { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
      { name: 'worker-2', index: 1, role: 'executor', assigned_tasks: [] },
    ] }],
    ['whitespace canonical-equivalent worker names', { ...initialConfig(), worker_count: 2, workers: [
      { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
      { name: ' worker-1 ', index: 2, role: 'executor', assigned_tasks: [] },
    ] }],
    ['worker traversal name', { ...initialConfig(), workers: [{ name: '../worker-1', index: 1, role: 'executor', assigned_tasks: [] }] }],
    ['worker path separator name', { ...initialConfig(), workers: [{ name: 'worker/1', index: 1, role: 'executor', assigned_tasks: [] }] }],
    ['worker control-character name', { ...initialConfig(), workers: [{ name: 'worker-\u0001', index: 1, role: 'executor', assigned_tasks: [] }] }],
    ['malformed worker', { ...initialConfig(), workers: [{ name: 'worker-1', index: 'one' }] }],
    ['malformed policy', { ...initialConfig(), policy: { display_mode: 'auto' } }],
    ['malformed governance', { ...initialConfig(), governance: { delegation_only: true } }],
    ['malformed workspace', { ...initialConfig(), workspace_mode: 'outside' }],
    ['malformed pane', { ...initialConfig(), leader_pane_id: 7 }],
    ['malformed routing', { ...initialConfig(), resolved_routing: { executor: { primary: {}, fallback: {} } } }],
    ['mismatched active fence revision', { ...initialConfig(), active_recovery: { ...initialConfig().active_recovery!, state_revision: 2 } }],
    ['mismatched active scale-up fence revision', { ...initialConfig(), active_scale_up: { operation_id: 'up', phase: 'reserved', pid: 1, process_started_at: 'linux:1', state_revision: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }],
    ['mismatched active scale-down fence revision', { ...initialConfig(), active_scale_down: { operation_id: 'down', phase: 'draining', pid: 1, process_started_at: 'linux:1', workers: [], state_revision: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }],
    ['mismatched shutdown fence revision', { ...initialConfig(), shutdown_attempt: { nonce: 'shutdown', pid: 1, process_started_at: 'linux:1', state_revision: 2, created_at: new Date().toISOString() } }],
    ['mismatched all-dead fence revision', { ...initialConfig(), all_dead_recovery: { detected_at: new Date().toISOString(), deadline_at: new Date().toISOString(), state_revision: 2 } }],
    ['malformed owner', { ...initialConfig(), runtime_owner_epoch: { epoch: 1, nonce: 'owner' } }],
    ['malformed service', { ...initialConfig(), service_descriptor: { schema_version: 1, service_generation: 1 } }],
    ['malformed lifecycle', { ...initialConfig(), lifecycle_state: 'broken' }],
  ])('fails closed on %s authoritative config without consulting or replacing its manifest', async (_name, config) => {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const bytes = JSON.stringify(config);
    writeFileSync(configPath, bytes);
    writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify({ schema_version: 2, name: teamName, workers: [] }));

    await expect(readRevisionedTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(readTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(saveTeamConfig(initialConfig(), cwd)).rejects.toThrow('invalid_persisted_state');
    expect(readFileSync(configPath, 'utf8')).toBe(bytes);
  });

  it('rejects a path-mismatched persisted config before migration writes a projection', async () => {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    const bytes = JSON.stringify({ ...initialConfig(), name: 'other-team' });
    writeFileSync(configPath, bytes);
    const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
    const manifestBytes = JSON.stringify({ schema_version: 2, name: teamName, workers: [] });
    writeFileSync(manifestPath, manifestBytes);

    await expect(migrateTeamConfigRevision(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    expect(readFileSync(configPath, 'utf8')).toBe(bytes);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBytes);
    expect(existsSync(absPath(cwd, TeamPaths.configMutationLock(teamName)))).toBe(false);
  });

  it('rejects an incomplete unrevisioned config while accepting the historical core and absence', async () => {
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    writeFileSync(configPath, JSON.stringify({ name: teamName, workers: [] }));
    await expect(readRevisionedTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(readTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');

    const legacy = initialConfig();
    delete legacy.state_revision;
    delete legacy.active_recovery;
    writeConfig(legacy);
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toBeNull();

    unlinkSync(configPath);
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toBeNull();
  });

  it('accepts complete revisioned lifecycle fences and migrates only a valid unrevisioned legacy config', async () => {
    const now = new Date().toISOString();
    const fenced = {
      ...initialConfig(),
      lifecycle_state: 'shutting_down' as const,
      runtime_owner_epoch: { epoch: 1, nonce: 'owner', pid: 123, process_started_at: 'linux:1', created_at: now },
      active_scale_up: { operation_id: 'up', phase: 'effects' as const, pid: 123, process_started_at: 'linux:1', state_revision: 1, created_at: now, updated_at: now },
      active_scale_down: { operation_id: 'down', phase: 'draining' as const, pid: 123, process_started_at: 'linux:1', workers: [], state_revision: 1, created_at: now, updated_at: now },
      shutdown_attempt: { nonce: 'shutdown', pid: 123, process_started_at: 'linux:1', state_revision: 1, created_at: now },
      all_dead_recovery: { detected_at: now, deadline_at: now, state_revision: 1 },
      service_descriptor: { schema_version: 1 as const, service_generation: 1, service_attempt_id: 'service', auto_merge_enabled: false, workspace_root: cwd, cadence_policy: 'disabled' as const },
    } satisfies TeamConfig;
    writeConfig(fenced);
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({ stateRevision: 1, config: { active_scale_up: { operation_id: 'up' }, active_scale_down: { operation_id: 'down' } } });

    const legacy = initialConfig();
    delete legacy.state_revision;
    delete legacy.lifecycle_state;
    delete legacy.active_recovery;
    writeConfig(legacy);
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toBeNull();
    await expect(migrateTeamConfigRevision(teamName, cwd)).resolves.toMatchObject({ stateRevision: 0 });

    unlinkSync(absPath(cwd, TeamPaths.config(teamName)));
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toBeNull();
  });

  it('never steals a live task holder lock because its timestamp is old', async () => {
    const processStartedAt = currentProcessStartIdentity();
    expect(processStartedAt).not.toBeNull();
    const lockPath = join(absPath(cwd, TeamPaths.tasks(teamName)), '.lock-1');
    mkdirSync(join(lockPath, '..'), { recursive: true });
    const bytes = JSON.stringify({ schema_version: 1, pid: process.pid, process_started_at: processStartedAt,
      nonce: 'live-task-lock', created_at: '2000-01-01T00:00:00.000Z' });
    writeFileSync(lockPath, bytes);
    const effect = vi.fn();

    await expect(withTaskClaimLock(teamName, '1', cwd, effect)).resolves.toEqual({ ok: false });
    expect(effect).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, 'utf8')).toBe(bytes);
  });
  it('does not reclaim a lock owned by the current live process identity', async () => {
    const lockPath = absPath(cwd, TeamPaths.configMutationLock(teamName));
    const processStartedAt = currentProcessStartIdentity();
    expect(processStartedAt).not.toBeNull();
    const bytes = JSON.stringify({ schema_version: 1, pid: process.pid, process_started_at: processStartedAt,
      nonce: 'live-lock', created_at: new Date().toISOString() });
    writeFileSync(lockPath, bytes);
    const effect = vi.fn();

    await expect(withProcessIdentityFileLock(lockPath, effect, 30)).rejects.toThrow('process_identity_lock_timeout');
    expect(effect).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, 'utf8')).toBe(bytes);
  });

  it('does not reclaim an unverifiable malformed lock owner record', async () => {
    const lockPath = absPath(cwd, TeamPaths.configMutationLock(teamName));
    const bytes = '{"schema_version":1,"pid":';
    writeFileSync(lockPath, bytes);
    const effect = vi.fn();

    await expect(withProcessIdentityFileLock(lockPath, effect, 30)).rejects.toThrow('process_identity_lock_timeout');
    expect(effect).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, 'utf8')).toBe(bytes);
  });

  it('never reclaims parseable lock records with blank process identity', async () => {
    const lockPath = absPath(cwd, TeamPaths.configMutationLock(teamName));
    const bytes = JSON.stringify({ schema_version: 1, pid: process.pid, process_started_at: '',
      nonce: 'blank-identity', created_at: new Date().toISOString() });
    writeFileSync(lockPath, bytes);
    const asyncEffect = vi.fn();
    const syncEffect = vi.fn();

    await expect(withProcessIdentityFileLock(lockPath, asyncEffect, 30)).rejects.toThrow('process_identity_lock_timeout');
    expect(() => withProcessIdentityFileLockSync(lockPath, syncEffect)).toThrow('process_identity_lock_busy');
    expect(asyncEffect).not.toHaveBeenCalled();
    expect(syncEffect).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, 'utf8')).toBe(bytes);
  });

  it.each([
    process.platform === 'linux' ? 'linux:not-a-start-tick'
      : process.platform === 'win32' ? 'win32:not-a-start-tick' : 'darwin:not-seconds:not-micros',
    process.platform === 'linux' ? 'win32:123' : 'linux:123',
  ])('does not reclaim unverifiable process identity %s', async processStartedAt => {
    const lockPath = `${absPath(cwd, TeamPaths.configMutationLock(teamName))}.${processStartedAt.split(':')[0]}`;
    const bytes = JSON.stringify({ schema_version: 1, pid: process.pid, process_started_at: processStartedAt,
      nonce: 'unverifiable-identity', created_at: new Date().toISOString() });
    writeFileSync(lockPath, bytes);
    const asyncEffect = vi.fn();
    const syncEffect = vi.fn();

    await expect(withProcessIdentityFileLock(lockPath, asyncEffect, 30)).rejects.toThrow('process_identity_lock_timeout');
    expect(() => withProcessIdentityFileLockSync(lockPath, syncEffect)).toThrow('process_identity_lock_busy');
    expect(asyncEffect).not.toHaveBeenCalled();
    expect(syncEffect).not.toHaveBeenCalled();
    expect(readFileSync(lockPath, 'utf8')).toBe(bytes);
  });

  it('reclaims a crashed scaling lock only after positive process death', async () => {
    const lockPath = absPath(cwd, TeamPaths.scalingLock(teamName));
    writeFileSync(lockPath, JSON.stringify({ schema_version: 1, pid: 2_147_483_647,
      process_started_at: 'linux:1', nonce: 'dead-scaling-lock', created_at: new Date().toISOString() }));
    const effect = vi.fn(async () => 'resumed');

    await expect(withScalingLock(teamName, cwd, effect, 100)).resolves.toBe('resumed');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});
