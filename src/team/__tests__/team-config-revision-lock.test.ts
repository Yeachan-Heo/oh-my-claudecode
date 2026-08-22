import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateTeamConfigRevision, readRevisionedTeamConfig, readTeamConfig, readTeamManifest, saveTeamConfig, saveTeamConfigAtRevision,
  assertActiveFenceOwnershipTransition, withScalingLock } from '../monitor.js';
import { absPath, TeamPaths } from '../state-paths.js';
import type { TeamConfig } from '../types.js';
import { withProcessIdentityFileLock, withProcessIdentityFileLockSync } from '../process-identity-lock.js';
import { currentProcessStartIdentity } from '../team-owner-epoch.js';
import { teamCreateTask, teamReadConfig, teamReadManifest, withTaskClaimLock } from '../team-ops.js';

let cwd: string;
const teamName = 'config-lock-team';
const deadProcessStart = process.platform === 'darwin' ? 'darwin:1:0' : process.platform === 'win32' ? 'win32:1' : 'linux:1';

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
    }, { release: { active_recovery: true } });
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
      process_started_at: deadProcessStart, nonce: 'dead-lock', created_at: new Date().toISOString() }));
    const config = initialConfig();
    config.next_task_id = 3;

    await expect(saveTeamConfig(config, cwd, config.state_revision)).resolves.toBeUndefined();
    expect(existsSync(lockPath)).toBe(false);
    expect(config.state_revision).toBe(2);
  });


  it('rejects a stale pre-incremented writer that would restore cleared recovery state', async () => {
    const cleanup = { ...initialConfig(), state_revision: 2, active_recovery: undefined,
      last_recovery: { ...initialConfig().active_recovery!, phase: 'adopted' as const, state_revision: 2 } };
    await expect(saveTeamConfigAtRevision(cleanup, 1, cwd, undefined, {
      release: { active_recovery: true },
    })).resolves.toBe(true);
    const stalePreincremented = initialConfig();
    stalePreincremented.state_revision = 2;
    stalePreincremented.active_recovery = { ...stalePreincremented.active_recovery!, state_revision: 2 };
    stalePreincremented.next_task_id = 11;

    await expect(saveTeamConfig(stalePreincremented, cwd, 1)).rejects.toThrow('stale_state_revision');
    const persisted = await readRevisionedTeamConfig(teamName, cwd);
    expect(persisted).toMatchObject({ stateRevision: 2, config: { last_recovery: { recovery_id: 'recovery-a' } } });
    expect(persisted?.config.active_recovery).toBeUndefined();
  });

  it('migration preserves an immediately preceding normal legacy write', async () => {
    const legacy = initialConfig();
    delete legacy.state_revision;
    delete legacy.active_recovery;
    writeConfig(legacy);
    const normal = structuredClone(legacy);
    normal.next_task_id = 13;

    await expect(saveTeamConfig(normal, cwd)).resolves.toBeUndefined();
    await expect(migrateTeamConfigRevision(teamName, cwd)).resolves.toMatchObject({ stateRevision: 0, config: { next_task_id: 13 } });
    await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({
      stateRevision: 0, config: { next_task_id: 13 },
    });
  });

  describe('legacy config/manifest max_workers merge (#3744)', () => {
    function writeLegacyConfig(maxWorkers: number | undefined): void {
      const { state_revision: _revision, active_recovery: _recovery, max_workers: _default, ...legacy } = initialConfig();
      writeConfig({ ...legacy, ...(maxWorkers === undefined ? {} : { max_workers: maxWorkers }) } as TeamConfig);
    }

    function writeMergeManifest(): void {
      writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify({ schema_version: 2, name: teamName,
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%manifest' }],
        worker_count: 1, next_task_id: 1, created_at: new Date().toISOString(), tmux_session: `${teamName}:0` }));
    }

    it('honors an explicit configured cap below the legacy default of 20 in both read paths', async () => {
      writeLegacyConfig(3);
      writeMergeManifest();

      await expect(readTeamConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 3 });
      await expect(teamReadConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 3 });
    });

    it('keeps the default cap of 20 when the legacy config omits max_workers', async () => {
      writeLegacyConfig(undefined);
      writeMergeManifest();

      await expect(readTeamConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 20 });
      await expect(teamReadConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 20 });
    });

    it('clamps an oversized configured cap to the hard ceiling of 20 in both read paths', async () => {
      writeLegacyConfig(50);
      writeMergeManifest();

      await expect(readTeamConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 20 });
      await expect(teamReadConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 20 });
    });

    it('returns a revisioned sub-ceiling cap verbatim without consulting the manifest merge', async () => {
      writeConfig({ ...initialConfig(), max_workers: 3 });
      writeFileSync(absPath(cwd, TeamPaths.manifest(teamName)), JSON.stringify({ schema_version: 2,
        state_revision: 99, name: teamName, next_task_id: 99,
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%manifest' }],
        worker_count: 1 }));

      await expect(readTeamConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 3, next_task_id: 1 });
      await expect(teamReadConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 3, next_task_id: 1 });
      expect((await teamReadConfig(teamName, cwd))?.workers[0]?.pane_id).not.toBe('%manifest');
      await expect(readRevisionedTeamConfig(teamName, cwd)).resolves.toMatchObject({ config: { max_workers: 3, next_task_id: 1 } });
    });

    it('migrates a manifest-only team at the legacy default cap', async () => {
      unlinkSync(absPath(cwd, TeamPaths.config(teamName)));
      writeMergeManifest();

      await expect(migrateTeamConfigRevision(teamName, cwd)).resolves.toMatchObject({ config: { max_workers: 20 } });
      await expect(readTeamConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: 20 });
    });

    it.each([0, -1, 1.5])('rejects a legacy config carrying invalid cap %s through every reader and migration', async maxWorkers => {
      writeLegacyConfig(maxWorkers);
      writeMergeManifest();

      await expect(readTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
      await expect(teamReadConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
      await expect(readRevisionedTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
      await expect(migrateTeamConfigRevision(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    });

    it.each([0, -1, 1.5])('rejects a revisioned config carrying invalid cap %s through every reader and migration', async maxWorkers => {
      writeConfig({ ...initialConfig(), max_workers: maxWorkers });

      await expect(readTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
      await expect(teamReadConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
      await expect(readRevisionedTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
      await expect(migrateTeamConfigRevision(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
    });

    it.each([0, -1, 1.5])('refuses to persist invalid cap %s through both writers', async maxWorkers => {
      await expect(saveTeamConfig({ ...initialConfig(), max_workers: maxWorkers }, cwd)).rejects.toThrow('invalid_persisted_state');
      await expect(saveTeamConfigAtRevision({ ...initialConfig(), max_workers: maxWorkers, state_revision: 2 }, 1, cwd))
        .rejects.toThrow('invalid_persisted_state');
    });

    it.each([1, 20])('keeps configured boundary cap %s valid through both readers', async maxWorkers => {
      writeLegacyConfig(maxWorkers);
      writeMergeManifest();

      await expect(readTeamConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: maxWorkers });
      await expect(teamReadConfig(teamName, cwd)).resolves.toMatchObject({ max_workers: maxWorkers });
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
    ['mismatched active scale-up fence revision', { ...initialConfig(), active_scale_up: { operation_id: 'up', phase: 'reserved' as const, pid: 1, process_started_at: 'linux:1', state_revision: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }],
    ['mismatched active scale-down fence revision', { ...initialConfig(), active_scale_down: { operation_id: 'down', phase: 'draining' as const, pid: 1, process_started_at: 'linux:1', workers: [], state_revision: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }],
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

  it('accepts and round-trips a committed scale-up fence through real save/load', async () => {
    const now = new Date().toISOString();
    const base = initialConfig();
    // Start from a clean revisioned config without recovery, with committed scale-up.
    writeConfig({
      ...base,
      active_recovery: undefined,
      active_scale_up: {
        operation_id: 'scale-up-committed',
        phase: 'committed',
        pid: 42,
        process_started_at: 'linux:1',
        state_revision: 1,
        created_at: now,
        updated_at: now,
      },
    });
    const loaded = await readRevisionedTeamConfig(teamName, cwd);
    expect(loaded?.config.active_scale_up?.phase).toBe('committed');
    expect(loaded?.config.active_scale_up?.state_revision).toBe(loaded?.config.state_revision);

    // Advance revision while retaining committed fence with intentionally stale fence revision.
    // saveTeamConfigAtRevision must align all active fences to config.state_revision.
    const nextRevision = loaded!.stateRevision + 1;
    const advanced = {
      ...loaded!.config,
      state_revision: nextRevision,
      active_recovery: {
        request_id: 'r1', recovery_id: 'rec1', worker_name: 'worker-1',
        owner_epoch: 1, owner_nonce: 'n1', phase: 'reserved' as const,
        state_revision: nextRevision, created_at: now, updated_at: now,
      },
      active_scale_up: { ...loaded!.config.active_scale_up!, state_revision: loaded!.stateRevision },
    };
    await expect(saveTeamConfigAtRevision(advanced, loaded!.stateRevision, cwd)).resolves.toBe(true);
    const after = await readRevisionedTeamConfig(teamName, cwd);
    expect(after?.config.active_scale_up?.phase).toBe('committed');
    expect(after?.config.active_scale_up?.state_revision).toBe(after?.config.state_revision);
    expect(after?.config.active_recovery?.state_revision).toBe(after?.config.state_revision);
  });

  it('rejects a malformed scale-up phase that is not in the canonical set', async () => {
    const now = new Date().toISOString();
    const bad = {
      ...initialConfig(),
      active_scale_up: {
        operation_id: 'scale-up-bad', phase: 'finished', pid: 1,
        process_started_at: 'linux:1', state_revision: 1,
        created_at: now, updated_at: now,
      },
    };
    const configPath = absPath(cwd, TeamPaths.config(teamName));
    writeFileSync(configPath, JSON.stringify(bad));
    await expect(readRevisionedTeamConfig(teamName, cwd)).rejects.toThrow('invalid_persisted_state');
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
      process_started_at: deadProcessStart, nonce: 'dead-scaling-lock', created_at: new Date().toISOString() }));
    const effect = vi.fn(async () => 'resumed');

    await expect(withScalingLock(teamName, cwd, effect, 100)).resolves.toBe('resumed');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });


  // ── CAS fence ownership trust boundary (exact-head 70d5 P1) ──────────────

  it('rejects foreign active_scale_up ownership substitution at matching revision', async () => {
    const now = new Date().toISOString();
    writeConfig({
      ...initialConfig(),
      active_recovery: undefined,
      active_scale_up: {
        operation_id: 'owner-A', phase: 'effects' as const, pid: 111, process_started_at: 'linux:owner-A',
        state_revision: 1, created_at: now, updated_at: now,
      },
    });
    const foreign = {
      ...initialConfig(),
      state_revision: 2,
      active_recovery: undefined,
      active_scale_up: {
        operation_id: 'owner-B', phase: 'effects' as const, pid: 222, process_started_at: 'linux:owner-B',
        state_revision: 2, created_at: now, updated_at: now,
      },
    };
    await expect(saveTeamConfigAtRevision(foreign, 1, cwd)).rejects.toThrow('invalid_persisted_state');
    const after = await readRevisionedTeamConfig(teamName, cwd);
    expect(after?.config.active_scale_up?.operation_id).toBe('owner-A');
    expect(after?.stateRevision).toBe(1);
  });

  it('accepts same-owner scale-up phase transition with revision rebase', async () => {
    const now = new Date().toISOString();
    writeConfig({
      ...initialConfig(),
      active_recovery: undefined,
      active_scale_up: {
        operation_id: 'owner-A', phase: 'reserved' as const, pid: 111, process_started_at: 'linux:owner-A',
        state_revision: 1, created_at: now, updated_at: now,
      },
    });
    const advanced = {
      ...initialConfig(),
      state_revision: 2,
      active_recovery: undefined,
      active_scale_up: {
        operation_id: 'owner-A', phase: 'effects' as const, pid: 111, process_started_at: 'linux:owner-A',
        state_revision: 2, created_at: now, updated_at: now,
      },
    };
    await expect(saveTeamConfigAtRevision(advanced, 1, cwd)).resolves.toBe(true);
    const after = await readRevisionedTeamConfig(teamName, cwd);
    expect(after?.config.active_scale_up?.phase).toBe('effects');
    expect(after?.config.active_scale_up?.operation_id).toBe('owner-A');
    expect(after?.config.active_scale_up?.state_revision).toBe(2);
  });

  it('rejects clearing active_scale_up without release authorization', async () => {
    const now = new Date().toISOString();
    writeConfig({
      ...initialConfig(),
      active_recovery: undefined,
      active_scale_up: {
        operation_id: 'owner-A', phase: 'committed' as const, pid: 111, process_started_at: 'linux:owner-A',
        state_revision: 1, created_at: now, updated_at: now,
      },
    });
    const cleared = {
      ...initialConfig(),
      state_revision: 2,
      active_recovery: undefined,
      active_scale_up: undefined,
    };
    await expect(saveTeamConfigAtRevision(cleared, 1, cwd)).rejects.toThrow('invalid_persisted_state');
    await expect(saveTeamConfigAtRevision(cleared, 1, cwd, undefined, {
      release: { active_scale_up: true },
    })).resolves.toBe(true);
    const after = await readRevisionedTeamConfig(teamName, cwd);
    expect(after?.config.active_scale_up).toBeUndefined();
  });

  it('rejects foreign active_recovery substitution', async () => {
    const base = initialConfig(); // has active_recovery recovery-a
    const foreign = {
      ...base,
      state_revision: 2,
      active_recovery: {
        ...base.active_recovery!,
        recovery_id: 'foreign-recovery',
        request_id: 'foreign-request',
        owner_epoch: 99,
        owner_nonce: 'foreign-nonce',
        state_revision: 2,
      },
    };
    await expect(saveTeamConfigAtRevision(foreign, 1, cwd)).rejects.toThrow('invalid_persisted_state');
  });

  it('rejects foreign active_scale_down ownership substitution and worker retarget', async () => {
    const now = new Date().toISOString();
    writeConfig({
      ...initialConfig(),
      active_recovery: undefined,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
      ],
      worker_count: 2,
      active_scale_down: {
        operation_id: 'sd-A', phase: 'failed' as const, pid: 111, process_started_at: 'linux:A',
        workers: [{ name: 'worker-2' }],
        state_revision: 1, failure_reason: 'pane_cleanup_failed',
        created_at: now, updated_at: now,
      },
    });
    // Foreign owner + different target worker
    const foreign = {
      ...initialConfig(),
      state_revision: 2,
      active_recovery: undefined,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
      ],
      worker_count: 2,
      active_scale_down: {
        operation_id: 'sd-B', phase: 'draining' as const, pid: 222, process_started_at: 'linux:B',
        workers: [{ name: 'worker-1' }], // retarget!
        state_revision: 2, created_at: now, updated_at: now,
      },
    };
    await expect(saveTeamConfigAtRevision(foreign, 1, cwd)).rejects.toThrow('invalid_persisted_state');
    const after = await readRevisionedTeamConfig(teamName, cwd);
    expect(after?.config.active_scale_down?.operation_id).toBe('sd-A');
    expect(after?.config.active_scale_down?.workers).toEqual([{ name: 'worker-2' }]);
  });

  it('rejects stale expected revision even for same-owner transition', async () => {
    const now = new Date().toISOString();
    writeConfig({
      ...initialConfig(),
      active_recovery: undefined,
      active_scale_up: {
        operation_id: 'owner-A', phase: 'reserved' as const, pid: 111, process_started_at: 'linux:A',
        state_revision: 1, created_at: now, updated_at: now,
      },
    });
    const advanced = {
      ...initialConfig(),
      state_revision: 2,
      active_recovery: undefined,
      active_scale_up: {
        operation_id: 'owner-A', phase: 'effects' as const, pid: 111, process_started_at: 'linux:A',
        state_revision: 2, created_at: now, updated_at: now,
      },
    };
    await expect(saveTeamConfigAtRevision(advanced, 0, cwd)).resolves.toBe(false);
  });

  it('rejects empty/non-string launch_attempt_id on worker rows', async () => {
    const base = initialConfig();
    const badEmpty = {
      ...base,
      state_revision: 2,
      active_recovery: { ...base.active_recovery!, state_revision: 2 },
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], launch_attempt_id: '' }],
    };
    await expect(saveTeamConfigAtRevision(badEmpty as any, 1, cwd)).rejects.toThrow('invalid_persisted_state');
    const badNull = {
      ...base,
      state_revision: 2,
      active_recovery: { ...base.active_recovery!, state_revision: 2 },
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], launch_attempt_id: null }],
    };
    await expect(saveTeamConfigAtRevision(badNull as any, 1, cwd)).rejects.toThrow('invalid_persisted_state');
  });

  it('accepts non-empty launch_attempt_id strings (UUID and attempt-scoped forms)', async () => {
    const base = initialConfig();
    for (const id of ['123e4567-e89b-12d3-a456-426614174000', 'attempt-worker-1']) {
      const good = {
        ...base,
        state_revision: 2,
        active_recovery: { ...base.active_recovery!, state_revision: 2 },
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], launch_attempt_id: id }],
      };
      await expect(saveTeamConfigAtRevision(good, 1, cwd)).resolves.toBe(true);
      // Reset for next iteration
      writeConfig(base);
    }
  });



  it('authorizes same-owner failed→draining scale-down resume with identical workers', () => {
    const now = new Date().toISOString();
    const workers = [{ name: 'worker-2', pane_id: '%2' }];
    const current = {
      ...initialConfig(),
      active_recovery: undefined,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
      ],
      worker_count: 2,
      active_scale_down: {
        operation_id: 'sd-resume', phase: 'failed' as const, pid: 111, process_started_at: 'linux:A',
        workers, state_revision: 1, failure_reason: 'pane_cleanup_failed',
        created_at: now, updated_at: now,
      },
    };
    const proposed = {
      ...current,
      state_revision: 2,
      active_scale_down: {
        ...current.active_scale_down!,
        phase: 'draining' as const,
        state_revision: 2,
        updated_at: now,
        failure_reason: undefined,
      },
    };
    expect(() => assertActiveFenceOwnershipTransition(current, proposed)).not.toThrow();
  });

  it('rejects failed→draining scale-down when workers are retargeted', () => {
    const now = new Date().toISOString();
    const current = {
      ...initialConfig(),
      active_recovery: undefined,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
      ],
      worker_count: 2,
      active_scale_down: {
        operation_id: 'sd-resume', phase: 'failed' as const, pid: 111, process_started_at: 'linux:A',
        workers: [{ name: 'worker-2' }], state_revision: 1, failure_reason: 'x',
        created_at: now, updated_at: now,
      },
    };
    const proposed = {
      ...current,
      state_revision: 2,
      active_scale_down: {
        ...current.active_scale_down!,
        phase: 'draining' as const,
        workers: [{ name: 'worker-1' }], // retarget forbidden
        state_revision: 2,
        updated_at: now,
      },
    };
    expect(() => assertActiveFenceOwnershipTransition(current, proposed)).toThrow('invalid_persisted_state');
  });

  it('persists same-owner failed→draining scale-down resume through real CAS', async () => {
    const now = new Date().toISOString();
    writeConfig({
      ...initialConfig(),
      active_recovery: undefined,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
      ],
      worker_count: 2,
      active_scale_down: {
        operation_id: 'sd-cas-resume', phase: 'failed', pid: 42, process_started_at: 'linux:owner',
        workers: [{ name: 'worker-2', pane_id: '%2' }],
        state_revision: 1, failure_reason: 'pane_cleanup_failed',
        created_at: now, updated_at: now,
      },
    } as any);
    const advanced = {
      ...initialConfig(),
      active_recovery: undefined,
      state_revision: 2,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
      ],
      worker_count: 2,
      active_scale_down: {
        operation_id: 'sd-cas-resume', phase: 'draining' as const, pid: 42, process_started_at: 'linux:owner',
        workers: [{ name: 'worker-2', pane_id: '%2' }],
        state_revision: 2, created_at: now, updated_at: now,
      },
    };
    await expect(saveTeamConfigAtRevision(advanced, 1, cwd)).resolves.toBe(true);
    const after = await readRevisionedTeamConfig(teamName, cwd);
    expect(after?.config.active_scale_down?.phase).toBe('draining');
    expect(after?.config.active_scale_down?.operation_id).toBe('sd-cas-resume');
    expect(after?.config.active_scale_down?.workers).toEqual([{ name: 'worker-2', pane_id: '%2' }]);
  });

});
