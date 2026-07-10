import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aliasActiveRecoveryRequest,
  readRecoveryOutcome,
  readRecoveryResult,
  reserveRecoveryRequest,
  writeRecoveryFinal,
  writeRecoveryPhase,
} from '../recovery-request-store.js';

let cwd: string;
const payload = { operation: 'recover-worker' as const, workspaceHash: 'workspace-a', teamName: 'team-a', workerName: 'worker-a' };
const pending = (phase: 'reserved' | 'active') => ({ schema_version: 1 as const, kind: 'phase' as const, request_id: 'request-a', recovery_id: 'recovery-a', team_name: 'team-a', worker_name: 'worker-a', phase, continuation: 'reserved' as const, adoption: 'pending' as const, services: 'pending' as const, manifest: 'repair_required' as const, updated_at: new Date().toISOString() });

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

  it('uses final outcome over phases and otherwise returns the newest durable phase', () => {
    writeRecoveryPhase(cwd, pending('reserved'));
    writeRecoveryPhase(cwd, pending('active'));
    expect(readRecoveryOutcome(cwd, 'request-a')).toMatchObject({ kind: 'phase', phase: 'active' });
    writeRecoveryFinal(cwd, { schema_version: 1, kind: 'final', request_id: 'request-a', recovery_id: 'recovery-a', team_name: 'team-a', worker_name: 'worker-a', outcome: 'succeeded', result: { ok: true } as never, continuation: 'adopted', adoption: 'adopted', services: 'synced', manifest: 'synced', completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    expect(readRecoveryOutcome(cwd, 'request-a')).toMatchObject({ kind: 'final', outcome: 'succeeded' });
  });

  it('retains failed and succeeded final lookup independently of deleted team state', () => {
    writeRecoveryFinal(cwd, { schema_version: 1, kind: 'final', request_id: 'failed', recovery_id: 'r1', team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'failed', error: { code: 'worker_not_found' }, continuation: 'none', adoption: 'not_started', services: 'terminal_degraded', manifest: 'repair_required', completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    writeRecoveryFinal(cwd, { schema_version: 1, kind: 'final', request_id: 'succeeded', recovery_id: 'r2', team_name: 'deleted-team', worker_name: 'worker-a', outcome: 'succeeded', result: { ok: true } as never, continuation: 'none', adoption: 'not_started', services: 'synced', manifest: 'synced', completed_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' });
    expect(readRecoveryOutcome(cwd, 'failed')).toMatchObject({ outcome: 'failed', error: { code: 'worker_not_found' } });
    expect(readRecoveryResult(cwd, 'succeeded')).toMatchObject({ ok: true });
  });
});
