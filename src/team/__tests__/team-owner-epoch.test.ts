import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireSuccessorOwnerEpoch,
  checkOwnerFence,
  currentProcessStartIdentity,
  currentStrictProcessStartIdentity,
  isActiveRecoveryEffect,
  isProcessIdentityDead,
  isValidProcessStartIdentity,
  isValidStrictProcessStartIdentity,
  isFencedServiceMaintenance,
  isFreshRecoveryElection,
  isSameAttemptSuccessorRebind,
  observeProcessIdentity,
  publishOwnerEpoch,
  strictProcessStartIdentityForPlatform,
  processStartIdentityForPlatform,
  readLatestOwnerEpoch,
  requireOwnerFence,
  requireOwnerProcessIdentity,
} from '../team-owner-epoch.js';
import { TeamPaths, absPath } from '../state-paths.js';
import type { TeamConfig } from '../types.js';

let cwd: string;
let restoreFixtureEnv: (() => void) | undefined;
const teamName = 'owner-team';
const start = currentProcessStartIdentity();
const otherStart = process.platform === 'darwin' ? 'darwin:1:0' : process.platform === 'win32' ? 'win32:1' : 'linux:1';
const baseConfig = (overrides: Record<string, unknown> = {}) => ({ state_revision: 7, lifecycle_state: 'active', runtime_owner_epoch: { epoch: 1, nonce: 'one' }, ...overrides }) as TeamConfig;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omc-owner-epoch-'));
  const home = process.env.HOME;
  const userProfile = process.env.USERPROFILE;
  const stateDir = process.env.OMC_STATE_DIR;
  process.env.HOME = cwd;
  process.env.USERPROFILE = cwd;
  delete process.env.OMC_STATE_DIR;
  restoreFixtureEnv = () => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userProfile;
    if (stateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = stateDir;
  };
});
afterEach(() => {
  const restore = restoreFixtureEnv;
  restoreFixtureEnv = undefined;
  try {
    restore?.();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

  it('rejects a successor-election loser that observes another process identity as winner', () => {
    const winner = publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: otherStart, nonce: 'winner' });
    const loserObserved = publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'loser' });
    expect(loserObserved).toEqual(winner);
    expect(() => requireOwnerProcessIdentity(loserObserved, process.pid, start)).toThrow('runtime_owner_fence_lost');
  });


  it('derives subsecond process-start identities from native macOS sysctl and exact Windows ticks', () => {
    const kinfo = Buffer.alloc(160);
    kinfo.writeBigUInt64LE(1_783_701_296n, 0);
    kinfo.writeBigUInt64LE(123_456n, 8);
    kinfo.writeBigUInt64LE(1_783_701_396n, 120);
    kinfo.writeBigUInt64LE(999_999n, 128);
    const exec = vi.fn((file: string) => file === 'powershell.exe'
      ? '638878752000000000\n'
      : kinfo) as unknown as typeof import('node:child_process').execFileSync;
    expect(processStartIdentityForPlatform(42, 'darwin', exec)).toBe('darwin:1783701296:123456');
    expect(processStartIdentityForPlatform(42, 'win32', exec)).toBe('win32:638878752000000000');
    expect(exec).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-b', 'kern.proc.pid.42'],
      { encoding: null, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    expect(exec).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-NoProfile', '-NonInteractive']),
      { encoding: 'utf8', windowsHide: true });
    const reusedKinfo = Buffer.from(kinfo);
    reusedKinfo.writeBigUInt64LE(654_321n, 8);
    const reused = vi.fn(() => reusedKinfo) as unknown as typeof import('node:child_process').execFileSync;
    expect(processStartIdentityForPlatform(42, 'darwin', reused)).toBe('darwin:1783701296:654321');
    const fallback = vi.fn((file: string) => {
      if (file === '/usr/sbin/sysctl') throw new Error('sysctl missing');
      return 'Wed Jul 15 23:00:00 2026\n';
    }) as unknown as typeof import('node:child_process').execFileSync;
    expect(processStartIdentityForPlatform(42, 'darwin', fallback)).toBe(`darwin:${Math.floor(Date.parse('Wed Jul 15 23:00:00 2026') / 1000)}:0`);
    expect(fallback).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '42'], {
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const missingHelpers = vi.fn(() => { throw new Error('missing'); }) as unknown as typeof import('node:child_process').execFileSync;
    expect(processStartIdentityForPlatform(42, 'darwin', missingHelpers)).toBeNull();
  });
  it('binds strict Linux identities to boot id and start ticks', () => {
    const fields = Array.from({ length: 20 }, () => '1');
    fields[18] = '456';
    const read = vi.fn((path: string) => path.endsWith('/stat')
      ? `42 (node) S ${fields.join(' ')}`
      : 'boot-id\n') as unknown as typeof import('node:fs').readFileSync;
    const exec = vi.fn() as unknown as typeof import('node:child_process').execFileSync;
    expect(strictProcessStartIdentityForPlatform(42, 'linux', exec, read)).toBe('linux:boot-id:456');
    expect(read).toHaveBeenCalledWith('/proc/42/stat', 'utf8');
    expect(read).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8');
    expect(exec).not.toHaveBeenCalled();
    expect(isValidStrictProcessStartIdentity('linux:boot-id:456', 'linux')).toBe(true);
    expect(isValidStrictProcessStartIdentity('linux:456', 'linux')).toBe(false);
    const invalidBoot = vi.fn((path: string) => path.endsWith('/stat') ? `42 (node) S ${fields.join(' ')}` : 'boot id\n') as unknown as typeof import('node:fs').readFileSync;
    expect(strictProcessStartIdentityForPlatform(42, 'linux', exec, invalidBoot)).toBeNull();
  });
  it('rejects invalid strict pids and never uses the Darwin ps fallback', () => {
    const exec = vi.fn(() => 'Wed Jul 15 23:00:00 2026\n') as unknown as typeof import('node:child_process').execFileSync;
    const read = vi.fn(() => '') as unknown as typeof import('node:fs').readFileSync;
    expect(strictProcessStartIdentityForPlatform(0, 'linux', exec, read)).toBeNull();
    expect(strictProcessStartIdentityForPlatform(1.5, 'linux', exec, read)).toBeNull();
    expect(strictProcessStartIdentityForPlatform(2_147_483_648, 'darwin', exec, read)).toBeNull();
    expect(strictProcessStartIdentityForPlatform(process.pid, 'win32', exec, read)).toBeNull();
    expect(strictProcessStartIdentityForPlatform(process.pid, 'aix', exec, read)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(isValidStrictProcessStartIdentity('darwin:1783701296:0', 'darwin')).toBe(false);
    expect(isValidStrictProcessStartIdentity('win32:638878752000000000', 'win32')).toBe(false);
  });
  it('uses the native Darwin probe for a current process when available', () => {
    const exec = vi.fn(() => 'Wed Jul 15 23:00:00 2026\n') as unknown as typeof import('node:child_process').execFileSync;
    const identity = strictProcessStartIdentityForPlatform(process.pid, 'darwin', exec);
    expect(exec).not.toHaveBeenCalled();
    if (process.platform === 'darwin') {
      expect(identity).toMatch(/^darwin:[1-9]\d*:[1-9]\d*$/);
      expect(currentStrictProcessStartIdentity()).toBe(identity);
    } else {
      expect(identity).toBeNull();
    }
  });
  it('does not declare a live Darwin process dead when precision falls back to seconds', () => {
    if (process.platform !== 'darwin') return;
    expect(start).toMatch(/^darwin:[1-9]\d*:0$/);
    const nativePrecisionIdentity = start!.replace(/:0$/, ':123456');
    expect(isProcessIdentityDead({ pid: process.pid, process_started_at: nativePrecisionIdentity })).toBe(false);
  });
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('observes only the recorded strict process incarnation', () => {
    const identity = currentStrictProcessStartIdentity();
    expect(isValidStrictProcessStartIdentity(identity)).toBe(true);
    expect(observeProcessIdentity({ pid: process.pid, process_started_at: identity! })).toBe('matching');
    const parts = identity!.split(':');
    parts[parts.length - 1] = parts[parts.length - 1] === '1' ? '2' : '1';
    expect(observeProcessIdentity({ pid: process.pid, process_started_at: parts.join(':') })).toBe('dead');
    expect(observeProcessIdentity({ pid: process.pid, process_started_at: 'unverified' })).toBe('unknown');
  });
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('distinguishes a missing process from denied observation', () => {
    const identity = currentStrictProcessStartIdentity();
    expect(isValidStrictProcessStartIdentity(identity)).toBe(true);
    const kill = vi.spyOn(process, 'kill');
    try {
      kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
      expect(observeProcessIdentity({ pid: process.pid, process_started_at: identity! })).toBe('unknown');
      kill.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); });
      expect(observeProcessIdentity({ pid: process.pid, process_started_at: identity! })).toBe('dead');
    } finally {
      kill.mockRestore();
    }
  });
  it('refuses a successor while a process remains live even when its heartbeat is stale, but allows confirmed-dead takeover', () => {
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'live', heartbeat: { observed_at: '2000-01-01T00:00:00.000Z' } });
    expect(() => acquireSuccessorOwnerEpoch(cwd, teamName, { pid: process.pid, processStartedAt: start!, nonce: 'blocked' })).toThrow('runtime_owner_not_confirmed_dead');
    rmSync(absPath(cwd, TeamPaths.ownerEpochs(teamName)), { recursive: true });
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: otherStart, nonce: 'dead' });
    expect(acquireSuccessorOwnerEpoch(cwd, teamName, { pid: process.pid, processStartedAt: start!, nonce: 'successor' })).toMatchObject({ epoch: 2, nonce: 'successor' });
  });

  it('fences stale predecessors and recognizes only the exact fresh, rebind, active, and maintenance predicates', () => {
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'one' });
    publishOwnerEpoch(cwd, teamName, 2, { pid: process.pid, processStartedAt: start!, nonce: 'two' });
    expect(checkOwnerFence(cwd, teamName, { epoch: 1, nonce: 'one' })).toEqual({ ok: false, reason: 'superseded' });
    expect(() => requireOwnerFence(cwd, teamName, { epoch: 1, nonce: 'one' })).toThrow('runtime_owner_fence_lost');
    expect(isFreshRecoveryElection(baseConfig(), { epoch: 1, nonce: 'one' }, 7)).toBe(true);
    const prior = { epoch: 1, nonce: 'one', pid: process.pid, process_started_at: otherStart, created_at: '2026-01-01T00:00:00.000Z' };
    const attempt = { request_id: 'request', recovery_id: 'recovery', owner_epoch: 1, owner_nonce: 'one' };
    expect(isSameAttemptSuccessorRebind(baseConfig({ active_recovery: attempt }), prior, { epoch: 2, nonce: 'two' }, 'request', 'recovery')).toBe(true);
    expect(isActiveRecoveryEffect(baseConfig({ runtime_owner_epoch: { epoch: 2, nonce: 'two' }, active_recovery: { ...attempt, owner_epoch: 2, owner_nonce: 'two' } }), { epoch: 2, nonce: 'two' }, 'request', 'recovery')).toBe(true);
    expect(isFencedServiceMaintenance(baseConfig({ runtime_owner_epoch: { epoch: 2, nonce: 'two' }, service_recovery: { epoch: 2, nonce: 'two' } }), { epoch: 2, nonce: 'two' })).toBe(true);
  });

  it('treats blank or malformed live-PID identities as unverifiable, never dead', () => {
    expect(isValidProcessStartIdentity('')).toBe(false);
    expect(isValidProcessStartIdentity('malformed')).toBe(false);
    expect(isProcessIdentityDead({ pid: process.pid, process_started_at: '' })).toBe(false);
    expect(isProcessIdentityDead({ pid: process.pid, process_started_at: 'malformed' })).toBe(false);
    const malformedSamePlatform = process.platform === 'linux' ? 'linux:not-a-start-tick'
      : process.platform === 'win32' ? 'win32:not-a-start-tick' : 'darwin:not-seconds:not-micros';
    const crossPlatform = process.platform === 'linux' ? 'win32:123' : 'linux:123';
    expect(isValidProcessStartIdentity(malformedSamePlatform)).toBe(false);
    expect(isValidProcessStartIdentity(crossPlatform)).toBe(false);
    expect(isProcessIdentityDead({ pid: 2_147_483_647, process_started_at: malformedSamePlatform })).toBe(false);
    expect(isProcessIdentityDead({ pid: 2_147_483_647, process_started_at: crossPlatform })).toBe(false);
    expect(() => publishOwnerEpoch(cwd, 'blank-owner-team', 1, {
      pid: process.pid, processStartedAt: '', nonce: 'blank-owner',
    })).toThrow('process_start_identity_unavailable');
  });

  it('never falls back to an older owner when the highest epoch is malformed', () => {
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'one' });
    const epoch2 = absPath(cwd, TeamPaths.ownerEpoch(teamName, 2));
    writeFileSync(epoch2, '{"schema_version":1');

    expect(() => readLatestOwnerEpoch(cwd, teamName)).toThrow('invalid_owner_epoch_record');
    expect(checkOwnerFence(cwd, teamName, { epoch: 1, nonce: 'one' })).toEqual({ ok: false, reason: 'malformed' });
    expect(() => requireOwnerFence(cwd, teamName, { epoch: 1, nonce: 'one' })).toThrow('runtime_owner_fence_lost');
  });

  it('rejects a valid signed owner epoch copied under a newer filename', () => {
    publishOwnerEpoch(cwd, teamName, 1, { pid: process.pid, processStartedAt: start!, nonce: 'one' });
    publishOwnerEpoch(cwd, teamName, 2, { pid: process.pid, processStartedAt: start!, nonce: 'two' });
    const epoch2 = absPath(cwd, TeamPaths.ownerEpoch(teamName, 2));
    const epoch3 = absPath(cwd, TeamPaths.ownerEpoch(teamName, 3));
    writeFileSync(epoch3, readFileSync(epoch2));

    expect(() => readLatestOwnerEpoch(cwd, teamName)).toThrow('invalid_owner_epoch_record');
    expect(checkOwnerFence(cwd, teamName, { epoch: 2, nonce: 'two' })).toEqual({ ok: false, reason: 'malformed' });
  });
});
