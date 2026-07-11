import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aliasActiveRecoveryRequest,
  readRecoveryOutcome,
  readRecoveryResult,
  readRecoveryFinalState,
  reserveRecoveryRequest,
  writeRecoveryFinal,
  writeRecoveryPhase,
} from '../recovery-request-store.js';
import { absPath, TeamPaths } from '../state-paths.js';

let cwd: string;
const payload = { operation: 'recover-worker' as const, workspaceHash: 'a'.repeat(64), teamName: 'team-a', workerName: 'worker-a' };
const pending = (phase: 'reserved' | 'active') => ({ schema_version: 1 as const, kind: 'phase' as const, request_id: 'request-a', recovery_id: 'recovery-a', team_name: 'team-a', worker_name: 'worker-a', phase, continuation: 'reserved' as const, adoption: 'pending' as const, services: 'pending' as const, manifest: 'repair_required' as const, updated_at: new Date().toISOString() });
const successResult = (requestId: string, recoveryId: string) => ({ outcome: 'already_running' as const, committed: true as const,
  oldPaneId: '%1', newPaneId: '%1', requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 1,
  activation: 'active' as const, manifestSync: 'synced' as const, servicesSync: 'synced' as const, warnings: [],
  requestId, recoveryId, teamName: requestId === 'request-a' ? 'team-a' : 'deleted-team', workerName: 'worker-a', updatedAt: new Date().toISOString() });
const failureResult = (requestId: string, recoveryId: string) => ({ outcome: 'failed' as const, committed: false as const,
  error: 'worker_not_found' as const, requestId, recoveryId, teamName: 'deleted-team', workerName: 'worker-a',
  updatedAt: new Date().toISOString() });
const reserveForFinal = (requestId: string, recoveryId: string, teamName = 'deleted-team') =>
  reserveRecoveryRequest(cwd, requestId, { operation: 'recover-worker', workspaceHash: 'a'.repeat(64),
    teamName, workerName: 'worker-a' }, recoveryId);
const writeRawFinal = (requestId: string, value: unknown) => {
  const path = absPath(cwd, TeamPaths.recoveryRequestResult(requestId));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const corruptNewestPhase = (from: string, to: string) => {
  writeRecoveryPhase(cwd, pending('reserved'));
  writeRecoveryPhase(cwd, pending('active'));
  const directory = join(absPath(cwd, TeamPaths.recoveryRequestPending('request-a')), '..', 'phases', 'request-a');
  const path = join(directory, readdirSync(directory).sort().reverse()[0]!);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
};

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'omc-recovery-request-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe('global recovery request store', () => {
  it('joins a repeated request with the same canonical payload and rejects a reused ID before a new recovery is reserved', () => {
    const first = reserveRecoveryRequest(cwd, 'request-a', payload, 'recovery-a');
    expect(first).toMatchObject({ kind: 'created', reservation: { recovery_id: 'recovery-a' } });
    expect(reserveRecoveryRequest(cwd, 'request-a', payload, 'recovery-b')).toMatchObject({ kind: 'joined', reservation: { recovery_id: 'recovery-a' } });
    expect(reserveRecoveryRequest(cwd, 'request-a', { ...payload, teamName: 'team-b' }, 'recovery-b')).toMatchObject({ kind: 'conflict', reservation: { team_name: 'team-a' } });
  });

  it('publishes a deterministic alias to an active compatible recovery and refuses a hash/team mismatch', () => {
    const active = reserveRecoveryRequest(cwd, 'request-a', payload, 'recovery-a').reservation;
    expect(aliasActiveRecoveryRequest(cwd, 'request-b', payload, active)).toMatchObject({ kind: 'aliased', reservation: { kind: 'alias', recovery_id: 'recovery-a', alias_of_request_id: 'request-a' } });
    expect(aliasActiveRecoveryRequest(cwd, 'request-c', { ...payload, workspaceHash: 'other' }, active)).toMatchObject({ kind: 'conflict' });
  });

  it('resolves a disconnected alias to its canonical phase before a final is published', () => {
    const active = reserveRecoveryRequest(cwd, 'request-a', payload, 'recovery-a').reservation;
    aliasActiveRecoveryRequest(cwd, 'request-b', payload, active);
    mkdirSync(absPath(cwd, TeamPaths.root('team-a')), { recursive: true });
    rmSync(absPath(cwd, TeamPaths.root('team-a')), { recursive: true });
    writeRecoveryPhase(cwd, pending('active'));

    expect(readRecoveryOutcome(cwd, 'request-b')).toEqual(readRecoveryOutcome(cwd, 'request-a'));
  });

  it('resolves a disconnected alias to its canonical final after team state is deleted', () => {
    const active = reserveRecoveryRequest(cwd, 'request-a', payload, 'recovery-a').reservation;
    aliasActiveRecoveryRequest(cwd, 'request-b', payload, active);
    writeRecoveryFinal(cwd, { schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a',
      team_name: 'team-a', worker_name: 'worker-a', outcome: 'succeeded', result: successResult('request-a', 'recovery-a'),
      continuation: 'none', adoption: 'not_started', services: 'synced', manifest: 'synced',
      completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    mkdirSync(absPath(cwd, TeamPaths.root('team-a')), { recursive: true });
    rmSync(absPath(cwd, TeamPaths.root('team-a')), { recursive: true });

    expect(readRecoveryOutcome(cwd, 'request-b')).toEqual(readRecoveryOutcome(cwd, 'request-a'));
  });

  it('fails closed for self-inconsistent immutable reservation tuples without publishing a final', () => {
    const requestId = 'inconsistent';
    const path = absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
    const mutations: Array<[string, string | RegExp, string]> = [
      ['team', '"team_name":"team-a"', '"team_name":"team-b"'],
      ['worker', '"worker_name":"worker-a"', '"worker_name":"worker-b"'],
      ['workspace', `"workspace_hash":"${'a'.repeat(64)}"`, `"workspace_hash":"${'b'.repeat(64)}"`],
      ['operation', '"operation":"recover-worker"', '"operation":"recover-workeX"'],
      ['payload hash', /"payload_hash":"[a-f0-9]{64}"/, `"payload_hash":"${'b'.repeat(64)}"`],
    ];
    for (const [name, from, to] of mutations) {
      reserveRecoveryRequest(cwd, requestId, payload, 'recovery-a');
      const original = readFileSync(path, 'utf8');
      const corrupted = original.replace(from, to);
      writeFileSync(path, corrupted);
      expect(readRecoveryOutcome(cwd, requestId), name).toBeNull();
      expect(readRecoveryFinalState(cwd, requestId), name).toEqual({ kind: 'missing' });
      rmSync(path);
    }
  });

  it('rejects traversal request ids before any recovery path is derived', () => {
    expect(() => reserveRecoveryRequest(cwd, '../../../../tmp/owned', payload, 'recovery-a'))
      .toThrow('invalid_recovery_request_id');
    expect(() => reserveRecoveryRequest(cwd, 'request-safe', payload, '../recovery'))
      .toThrow('invalid_recovery_request_id');
    expect(() => readRecoveryFinalState(cwd, '../owned')).toThrow('invalid_recovery_request_id');
  });

  it('uses final outcome over phases and otherwise returns the newest durable phase', () => {
    reserveForFinal('request-a', 'recovery-a', 'team-a');
    writeRecoveryPhase(cwd, pending('reserved'));
    writeRecoveryPhase(cwd, pending('active'));
    expect(readRecoveryOutcome(cwd, 'request-a')).toMatchObject({ kind: 'phase', phase: 'active' });
    writeRecoveryFinal(cwd, { schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a', team_name: 'team-a', worker_name: 'worker-a', outcome: 'succeeded', result: successResult('request-a', 'recovery-a'), continuation: 'none', adoption: 'not_started', services: 'synced', manifest: 'synced', completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    expect(readRecoveryOutcome(cwd, 'request-a')).toMatchObject({ kind: 'final', outcome: 'succeeded' });
  });

  it('rejects phase publication unless its tuple exactly matches the canonical reservation', () => {
    reserveForFinal('request-a', 'recovery-a', 'team-a');
    const conflicts = [
      { name: 'recovery', phase: { ...pending('active'), recovery_id: 'recovery-b' } },
      { name: 'team', phase: { ...pending('active'), team_name: 'team-b' } },
      { name: 'worker', phase: { ...pending('active'), worker_name: 'worker-b' } },
      { name: 'request path', phase: { ...pending('active'), request_id: 'request-b' } },
    ];
    for (const { name, phase } of conflicts) {
      expect(() => writeRecoveryPhase(cwd, phase), name).toThrow('invalid_persisted_state');
    }
    expect(readRecoveryOutcome(cwd, 'request-a')).toBeNull();
  });

  it('fails closed when the newest immutable phase conflicts with its canonical reservation', () => {
    const conflicts: Array<[string, string, string]> = [
      ['recovery', '"recovery_id":"recovery-a"', '"recovery_id":"recovery-b"'],
      ['team', '"team_name":"team-a"', '"team_name":"team-b"'],
      ['worker', '"worker_name":"worker-a"', '"worker_name":"worker-b"'],
      ['request path', '"request_id":"request-a"', '"request_id":"request-b"'],
    ];
    for (const [name, from, to] of conflicts) {
      reserveForFinal('request-a', 'recovery-a', 'team-a');
      corruptNewestPhase(from, to);
      expect(readRecoveryOutcome(cwd, 'request-a'), name).toBeNull();
      rmSync(absPath(cwd, TeamPaths.recoveryRequestPending('request-a')));
      rmSync(join(absPath(cwd, TeamPaths.recoveryRequestPending('request-a')), '..', 'phases'), { recursive: true, force: true });
    }
  });

  it('repairs a missing workspace-scoped final index with exact immutable bytes', () => {
    reserveForFinal('repair-index', 'recovery-index');
    writeRecoveryFinal(cwd, { schema_version: 1, kind: 'final', request_id: 'repair-index', recovery_id: 'recovery-index',
      team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'failed', result: failureResult('repair-index', 'recovery-index'),
      error: { code: 'worker_not_found', commit_uncertain: false }, continuation: 'none', adoption: 'not_started',
      services: 'terminal_degraded', manifest: 'repair_required', completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    const requestPath = absPath(cwd, TeamPaths.recoveryRequestResult('repair-index'));
    const indexPath = absPath(cwd, TeamPaths.recoveryResultByTeam('a'.repeat(64), 'deleted-team', 'recovery-index'));
    unlinkSync(indexPath);
    expect(readRecoveryFinalState(cwd, 'repair-index')).toMatchObject({ kind: 'valid' });
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, 'utf8')).toBe(readFileSync(requestPath, 'utf8'));
    writeFileSync(indexPath, '{"schema_version":1');
    expect(readRecoveryFinalState(cwd, 'repair-index')).toMatchObject({ kind: 'valid' });
    expect(readFileSync(indexPath, 'utf8')).toBe(readFileSync(requestPath, 'utf8'));
    writeFileSync(indexPath, JSON.stringify({ schema_version: 1, kind: 'final', request_id: 'other' }));
    expect(readRecoveryFinalState(cwd, 'repair-index')).toMatchObject({ kind: 'valid' });
    expect(readFileSync(indexPath, 'utf8')).toBe(readFileSync(requestPath, 'utf8'));
  });

  it('retains failed and succeeded final lookup independently of deleted team state', () => {
    reserveForFinal('failed', 'r1');
    reserveForFinal('succeeded', 'r2');
    writeRecoveryFinal(cwd, { schema_version: 1, kind: 'final', request_id: 'failed', recovery_id: 'r1', team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'failed', result: failureResult('failed', 'r1'), error: { code: 'worker_not_found', commit_uncertain: false }, continuation: 'none', adoption: 'not_started', services: 'terminal_degraded', manifest: 'repair_required', completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    writeRecoveryFinal(cwd, { schema_version: 1, kind: 'final', request_id: 'succeeded', recovery_id: 'r2', team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'succeeded', result: successResult('succeeded', 'r2'), continuation: 'none', adoption: 'not_started', services: 'synced', manifest: 'synced', completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    expect(readRecoveryOutcome(cwd, 'failed')).toMatchObject({ outcome: 'failed', error: { code: 'worker_not_found' } });
    expect(readRecoveryResult(cwd, 'succeeded')).toMatchObject({ outcome: 'already_running', recoveryId: 'r2' });
  });

  it('rejects a durable final whose outer and embedded identity tuples disagree', () => {
    reserveForFinal('mismatch', 'outer-recovery');
    writeRawFinal('mismatch', { schema_version: 1, kind: 'final', request_id: 'mismatch', recovery_id: 'outer-recovery',
      team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'succeeded',
      result: successResult('mismatch', 'embedded-recovery'), continuation: 'none', adoption: 'not_started',
      services: 'synced', manifest: 'synced', completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    expect(readRecoveryOutcome(cwd, 'mismatch')).toBeNull();
    expect(readRecoveryResult(cwd, 'mismatch')).toBeNull();
  });

  it('rejects a tuple-matching final with an incomplete embedded result envelope', () => {
    reserveForFinal('incomplete', 'r3');
    writeRawFinal('incomplete', { schema_version: 1, kind: 'final', request_id: 'incomplete', recovery_id: 'r3',
      team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'failed',
      result: { outcome: 'failed', requestId: 'incomplete', recoveryId: 'r3', teamName: 'deleted-team',
        workerName: 'worker-a', updatedAt: new Date().toISOString() } as never,
      error: { code: 'worker_not_found', commit_uncertain: false }, continuation: 'none', adoption: 'not_started',
      services: 'terminal_degraded', manifest: 'repair_required', completed_at: new Date().toISOString(),
      expires_at: '2099-01-01T00:00:00.000Z' });
    expect(readRecoveryOutcome(cwd, 'incomplete')).toBeNull();
    expect(readRecoveryResult(cwd, 'incomplete')).toBeNull();
  });

  it('rejects malformed successful pane identities before immutable final publication', () => {
    for (const [requestId, result] of [
      ['blank-new-pane', { ...successResult('blank-new-pane', 'pane-r1'), newPaneId: '   ' }],
      ['blank-old-pane', { ...successResult('blank-old-pane', 'pane-r2'), outcome: 'recovered' as const, oldPaneId: '' }],
    ] as const) {
      const recoveryId = result.recoveryId;
      reserveForFinal(requestId, recoveryId);
      expect(() => writeRecoveryFinal(cwd, {
        schema_version: 1, kind: 'final', request_id: requestId, recovery_id: recoveryId,
        team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'succeeded', result,
        continuation: 'none', adoption: 'not_started', services: 'synced', manifest: 'synced',
        completed_at: result.updatedAt, expires_at: '2099-01-01T00:00:00.000Z',
      })).toThrow('invalid_persisted_state');
      expect(readRecoveryFinalState(cwd, requestId)).toEqual({ kind: 'missing' });
      expect(readRecoveryOutcome(cwd, requestId)).toBeNull();
    }
  });

  it('rejects tuple-matching finals whose embedded and outer producer invariants conflict', () => {
    const cases: Array<[string, (record: Record<string, unknown>, result: Record<string, unknown>) => void]> = [
      ['array-map', (_record, result) => { result.continuationSequenceByTask = []; }],
      ['task-key-mismatch', (_record, result) => { result.requeuedTaskIds = ['1']; result.continuationSequenceByTask = { '2': 1 }; }],
      ['outer-adoption-mismatch', (record, result) => {
        result.requeuedTaskIds = ['1']; result.continuationSequenceByTask = { '1': 1 };
        record.continuation = 'none'; record.adoption = 'not_started';
      }],
      ['service-warning-mismatch', (record, result) => {
        result.servicesSync = 'repair_required'; result.activation = 'active'; result.warnings = [];
        record.services = 'repair_required';
      }],
    ];
    for (const [name, mutate] of cases) {
      const requestId = `cross-${name}`;
      const recoveryId = `recovery-${name}`;
      reserveForFinal(requestId, recoveryId);
      const result: Record<string, unknown> = { ...successResult(requestId, recoveryId), outcome: 'recovered' };
      const record: Record<string, unknown> = { schema_version: 1, kind: 'final', request_id: requestId,
        recovery_id: recoveryId, team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'succeeded', result,
        continuation: 'none', adoption: 'not_started', services: 'synced', manifest: 'synced',
        completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' };
      mutate(record, result);
      writeRawFinal(requestId, record);
      expect(readRecoveryFinalState(cwd, requestId), name).toEqual({ kind: 'invalid' });
      expect(readRecoveryOutcome(cwd, requestId), name).toBeNull();
    }
  });
});
