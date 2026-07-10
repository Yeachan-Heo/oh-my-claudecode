import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireSuccessorOwnerEpoch,
  checkOwnerFence,
  currentProcessStartIdentity,
  isActiveRecoveryEffect,
  isFencedServiceMaintenance,
  isFreshRecoveryElection,
  isSameAttemptSuccessorRebind,
  publishOwnerEpoch,
  readLatestOwnerEpoch,
  requireOwnerFence,
} from '../team-owner-epoch.js';
import { TeamPaths, absPath } from '../state-paths.js';
import type { TeamConfig } from '../types.js';

let cwd: string;
const teamName = 'owner-team';
const start = currentProcessStartIdentity();
const baseConfig = (overrides: Record<string, unknown> = {}) => ({ state_revision: 7, lifecycle_state: 'active', runtime_owner_epoch: { epoch: 1, nonce: 'one' }, ...overrides }) as TeamConfig;

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'omc-owner-epoch-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe('runtime owner epochs', () => {
  it('publishes a complete immutable epoch by hard link and removes its temporary publication file', () => {
    expect(start).not.toBeNull();
    const record = publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'one' });
    expect(readLatestOwnerEpoch(cwd, teamName)).toEqual(record);
    const names = readdirSync(absPath(cwd, TeamPaths.ownerEpochs(teamName)));
    expect(names).toEqual(['1.json']);
  });

  it('makes simultaneous successors observe the winning record without reclaiming or leaving temporary aliases', () => {
    const first = publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'first' });
    const second = publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'second' });
    expect(second).toEqual(first);
    expect(readdirSync(absPath(cwd, TeamPaths.ownerEpochs(teamName)))).toEqual(['1.json']);
  });

  it('refuses a successor while a process remains live even when its heartbeat is stale, but allows confirmed-dead takeover', () => {
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'live', heartbeat: { observed_at: '2000-01-01T00:00:00.000Z' } });
    expect(() => acquireSuccessorOwnerEpoch(cwd, teamName, { pid: process.pid, processStartedAt: start!, nonce: 'blocked' })).toThrow('runtime_owner_not_confirmed_dead');
    rmSync(absPath(cwd, TeamPaths.ownerEpochs(teamName)), { recursive: true });
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: 'definitely-old-start', nonce: 'dead' });
    expect(acquireSuccessorOwnerEpoch(cwd, teamName, { pid: process.pid, processStartedAt: start!, nonce: 'successor' })).toMatchObject({ epoch: 2, nonce: 'successor' });
  });

  it('fences stale predecessors and recognizes only the exact fresh, rebind, active, and maintenance predicates', () => {
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'one' });
    publishOwnerEpoch(cwd, teamName, 2, { pid: process.pid, processStartedAt: start!, nonce: 'two' });
    expect(checkOwnerFence(cwd, teamName, { epoch: 1, nonce: 'one' })).toEqual({ ok: false, reason: 'superseded' });
    expect(() => requireOwnerFence(cwd, teamName, { epoch: 1, nonce: 'one' })).toThrow('runtime_owner_fence_lost');
    expect(isFreshRecoveryElection(baseConfig(), { epoch: 1, nonce: 'one' }, 7)).toBe(true);
    const prior = { epoch: 1, nonce: 'one', pid: process.pid, process_started_at: 'old', created_at: '2026-01-01T00:00:00.000Z' };
    const attempt = { request_id: 'request', recovery_id: 'recovery', owner_epoch: 1, owner_nonce: 'one' };
    expect(isSameAttemptSuccessorRebind(baseConfig({ active_recovery: attempt }), prior, { epoch: 2, nonce: 'two' }, 'request', 'recovery')).toBe(true);
    expect(isActiveRecoveryEffect(baseConfig({ runtime_owner_epoch: { epoch: 2, nonce: 'two' }, active_recovery: { ...attempt, owner_epoch: 2, owner_nonce: 'two' } }), { epoch: 2, nonce: 'two' }, 'request', 'recovery')).toBe(true);
    expect(isFencedServiceMaintenance(baseConfig({ runtime_owner_epoch: { epoch: 2, nonce: 'two' }, service_recovery: { epoch: 2, nonce: 'two' } }), { epoch: 2, nonce: 'two' })).toBe(true);
  });
});
