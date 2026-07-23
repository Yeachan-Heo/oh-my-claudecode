import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileHandle } from 'fs/promises';

import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { withStateFileLockSync, releaseStateFileLockSync, acquireStateFileLockSync, renewMutationLock as renewStateFileLock } from '../../../scripts/lib/atomic-write.mjs';
import {
  acquireMutationLockAt,
  releaseMutationLockSync,
  renewMutationLock,
  validateMutationLockOwner,
  type MutationLockOwner,
} from '../mode-state-io.js';

const fsPromisesControl = vi.hoisted(() => ({
  renameHook: undefined as undefined | ((from: string | URL, to: string | URL) => Promise<void>),
  openHook: undefined as undefined | (() => Promise<void>),
  writeHook: undefined as undefined | ((fd: FileHandle) => void),
}));

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: async (from: string | URL, to: string | URL) => {
      await fsPromisesControl.renameHook?.(from, to);
      await actual.rename(from, to);
    },
    open: async (
      filePath: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      await fsPromisesControl.openHook?.();
      const fd = await actual.open(filePath, flags, mode);
      fsPromisesControl.writeHook?.(fd);
      return fd;
    },
  };
});

import { atomicWriteJson } from '../atomic-write.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

describe('atomicWriteJson', () => {
  const directories: string[] = [];

  afterEach(() => {
    fsPromisesControl.renameHook = undefined;
    fsPromisesControl.openHook = undefined;
    fsPromisesControl.writeHook = undefined;
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('publishes only complete JSON while rename is pending', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    directories.push(directory);
    const filePath = join(directory, 'state.json');
    const oldValue = { status: 'old' };
    const nextValue = { status: 'new', items: ['complete'] };
    const renameEntered = deferred();
    const releaseRename = deferred();
    writeFileSync(filePath, JSON.stringify(oldValue));
    fsPromisesControl.renameHook = async (_from, to) => {
      if (to === filePath) {
        renameEntered.resolve();
        await releaseRename.promise;
      }
    };

    const writer = atomicWriteJson(filePath, nextValue);
    try {
      await renameEntered.promise;
      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
    } finally {
      releaseRename.resolve();
    }
    await writer;

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(nextValue);
  });

  it('completes short writes before renaming the JSON payload', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-short-write-'));
    directories.push(directory);
    const filePath = join(directory, 'state.json');
    const nextValue = { status: 'new', items: ['complete', 'utf8-✓'] };
    const expectedContent = JSON.stringify(nextValue, null, 2);
    const writeOffsets: number[] = [];

    fsPromisesControl.writeHook = fd => {
      const originalWrite = fd.write.bind(fd);
      Object.defineProperty(fd, 'write', {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          writeOffsets.push(offset);
          return originalWrite(buffer, offset, Math.min(length, 3), position);
        },
      });
    };
    fsPromisesControl.renameHook = async (from, to) => {
      if (to === filePath) {
        expect(readFileSync(from)).toEqual(Buffer.from(expectedContent, 'utf8'));
      }
    };

    await atomicWriteJson(filePath, nextValue);

    expect(writeOffsets).toEqual(
      Array.from({ length: Math.ceil(Buffer.byteLength(expectedContent) / 3) }, (_, index) => index * 3),
    );
    expect(readFileSync(filePath, 'utf8')).toBe(expectedContent);
  });

  it('rejects zero-byte write progress, preserves the old target, and removes the temp file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-zero-progress-'));
    directories.push(directory);
    const filePath = join(directory, 'state.json');
    const oldValue = { status: 'old' };
    writeFileSync(filePath, JSON.stringify(oldValue));
    fsPromisesControl.writeHook = fd => {
      Object.defineProperty(fd, 'write', {
        value: async (buffer: Buffer) => ({ bytesWritten: 0, buffer }),
      });
    };

    await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toThrow(
      'Failed to write complete JSON payload',
    );

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
    expect(readdirSync(directory)).toEqual(['state.json']);
  });

  it('propagates FileHandle write failures, preserves the old target, and removes the temp file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-write-error-'));
    directories.push(directory);
    const filePath = join(directory, 'state.json');
    const oldValue = { status: 'old' };
    const failure = new Error('temp write failed');
    writeFileSync(filePath, JSON.stringify(oldValue));
    fsPromisesControl.writeHook = fd => {
      Object.defineProperty(fd, 'write', {
        value: async () => { throw failure; },
      });
    };

    await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toBe(failure);

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
    expect(readdirSync(directory)).toEqual(['state.json']);
  });

  it('creates missing parents and publishes owner-only replacement files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-parent-'));
    directories.push(directory);
    const filePath = join(directory, 'nested', 'state.json');

    await atomicWriteJson(filePath, { status: 'new' });

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ status: 'new' });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('propagates temp write failures without publishing a target', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-write-error-'));
    directories.push(directory);
    const filePath = join(directory, 'state.json');
    const failure = new Error('temp write failed');
    fsPromisesControl.openHook = async () => { throw failure; };

    await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toBe(failure);

    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('propagates rename failures, preserves the old target, and removes the temp file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-error-'));
    directories.push(directory);
    const filePath = join(directory, 'state.json');
    const oldValue = { status: 'old' };
    const failure = new Error('rename failed');
    writeFileSync(filePath, JSON.stringify(oldValue));
    fsPromisesControl.renameHook = async () => { throw failure; };

    await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toBe(failure);

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
    expect(readdirSync(directory)).toEqual(['state.json']);
    expect(existsSync(filePath)).toBe(true);
  });

  it('bypasses stale generic lock artifacts without flock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-'));
    directories.push(directory);
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const filePath = join(directory, 'state.json');
    writeFileSync(`${filePath}.mutation.lock`, JSON.stringify(freshLeaseOwner(999999999, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())));

    expect(withStateFileLockSync(filePath, () => 'written')).toEqual({ acquired: true, value: 'written' });
    expect(existsSync(`${filePath}.mutation.lock`)).toBe(true);
  });

  it('preserves legacy unlocked behavior without flock even when a lock artifact exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-live-'));
    directories.push(directory);
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const filePath = join(directory, 'state.json');
    // OMC_TEST_FLOCK_AVAILABLE=0 short-circuits acquire to { unlocked: true },
    // so the lock artifact is never inspected; build a valid lease owner
    // (expires_at in the future) without depending on /proc (absent on macOS).
    writeFileSync(`${filePath}.mutation.lock`, JSON.stringify(freshLeaseOwner(process.pid)));

    expect(withStateFileLockSync(filePath, () => 'written')).toEqual({ acquired: true, value: 'written' });
    expect(existsSync(`${filePath}.mutation.lock`)).toBe(true);
  });

  it('flock-less release after steal: owner mismatch leaves the live lock in place', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-release-steal-'));
    directories.push(directory);
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const filePath = join(directory, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    // Owner A acquired the lock legitimately. createdAt is the release-path
    // ownership token (pid + nonce + createdAt); any validated lease owner
    // suffices and avoids a /proc dependency that does not exist on macOS.
    const ownerA = freshLeaseOwner(4242);
    writeFileSync(lockPath, JSON.stringify(ownerA));
    // While A held it, A's owner file became transiently unreadable, B stole the
    // lock via linkSync (expired-lease reclaim), publishing owner B at the path.
    const ownerB = freshLeaseOwner(5252);
    writeFileSync(lockPath, JSON.stringify(ownerB));
    const fd = openSync(join(directory, 'a-fd'), 'w');
    // A finishes and releases its (now-stale) handle.
    releaseStateFileLockSync({ fd, lockPath, owner: ownerA });

    // B's lock must survive: A's owner mismatched, so no unlink.
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(ownerB.nonce);
  });

  it('flock-less release: owner match unlinks the lock file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-release-match-'));
    directories.push(directory);
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const filePath = join(directory, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    const owner = freshLeaseOwner(4242);
    writeFileSync(lockPath, JSON.stringify(owner));
    const fd = openSync(join(directory, 'a-fd'), 'w');

    releaseStateFileLockSync({ fd, lockPath, owner });

    expect(existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B4: flock-less acquire -> contend -> release cycle, steal-prevention, and
// testable owner-liveness. These run on the REAL flock-less linkSync path.
// B8: on Linux CI, hasFlock is true so the flock branch would run and the
// flock-less else block would be skipped. The OMC_TEST_FORCE_FLOCKLESS=1 seam
// makes flockPath() return null (forcing the flock-less branch) WITHOUT tripping
// lockingDisabledForTest() (which stays false because OMC_TEST_FLOCK_AVAILABLE
// is not '0'), so exclusive locking stays enabled and the real flock-less
// acquire/reclaim/release code is exercised on Linux CI. requireExclusive=true
// forces the linkSync branch instead of the { unlocked: true } short-circuit.
// ---------------------------------------------------------------------------

/**
 * Builds a lease owner for tests. `expiresAt` controls the reclaim decision:
 * a future value = live (blocks steal); a past value = expired (reclaimable).
 * All lease tests are platform-agnostic (just expires_at + clock) - no /proc,
 * no jiffies, no EPERM - so they pass identically on Linux CI + macOS.
 */
function freshLeaseOwner(pid: number, createdAt?: string, expiresAt?: string): MutationLockOwner {
  const now = Date.now();
  return {
    version: 1,
    pid,
    createdAt: createdAt ?? new Date(now).toISOString(),
    expires_at: expiresAt ?? new Date(now + 300000).toISOString(),
    nonce: randomUUID(),
  };
}

/** Enable the B8 flock-less test seam for the current test, restoring afterEach. */
function enableForceFlockless(): void {
  process.env.NODE_ENV = 'test';
  process.env.OMC_TEST_FORCE_FLOCKLESS = '1';
}

describe('lease-based mutation lock: validateMutationLockOwner', () => {
  it('accepts a well-formed lease owner', () => {
    expect(validateMutationLockOwner(freshLeaseOwner(process.pid))).not.toBeNull();
  });

  it('rejects an owner with extra keys, wrong types, bad nonce, or missing expires_at', () => {
    expect(validateMutationLockOwner(null)).toBeNull();
    // v1 old liveness schema (no expires_at) is NOT a valid lease owner.
    expect(validateMutationLockOwner({ version: 1, pid: 1, createdAt: new Date().toISOString(), nonce: randomUUID() } as any)).toBeNull();
    expect(validateMutationLockOwner({ version: 2, pid: 1, createdAt: new Date().toISOString(), expires_at: 'not-a-date', nonce: randomUUID() })).toBeNull();
    expect(validateMutationLockOwner({ version: 2, pid: 1, createdAt: new Date().toISOString(), expires_at: new Date(Date.now() + 1000).toISOString(), nonce: 'not-a-uuid' })).toBeNull();
    expect(validateMutationLockOwner({ version: 3, pid: 1, createdAt: new Date().toISOString(), expires_at: new Date(Date.now() + 1000).toISOString(), nonce: randomUUID() } as any)).toBeNull();
    expect(validateMutationLockOwner({ version: 2, pid: 1, createdAt: new Date().toISOString(), expires_at: new Date(Date.now() + 1000).toISOString(), nonce: randomUUID(), extra: 1 } as any)).toBeNull();
  });
});

describe('lease-based mutation lock: release unlinks the holder\'s own lock', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    delete process.env.OMC_TEST_FORCE_FLOCKLESS;
  });

  it('release unlinks the lock file the holder acquired', () => {
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-release-unlink-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    const a = acquireMutationLockAt(filePath, true);
    expect(a).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    // The holder releases its OWN lock: unlinkSync, no liveness check.
    releaseMutationLockSync(a);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('lease-based mutation lock: renewal', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    delete process.env.OMC_TEST_FORCE_FLOCKLESS;
  });

  it('atomically replaces a still-live owner record while preserving ownership', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-renew-ts-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lock = acquireMutationLockAt(filePath, true);
    expect(lock).not.toBeNull();

    const before = JSON.parse(readFileSync(`${filePath}.mutation.lock`, 'utf8')) as MutationLockOwner;
    expect(before.version).toBe(1);
    const flockAvailable = existsSync('/usr/bin/flock') || existsSync('/bin/flock');
    expect(renewMutationLock(lock)).toBe(flockAvailable);

    const after = JSON.parse(readFileSync(`${filePath}.mutation.lock`, 'utf8')) as MutationLockOwner;
    if (!flockAvailable) {
      expect(after).toEqual(before);
      releaseMutationLockSync(lock);
      return;
    }
    expect(after).toMatchObject({
      version: before.version,
      pid: before.pid,
      createdAt: before.createdAt,
      nonce: before.nonce,
    });
    expect(Date.parse(after.expires_at)).toBeGreaterThanOrEqual(Date.parse(before.expires_at));
    releaseMutationLockSync(lock);
  });

  it('uses the guarded renewal path in the hook runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-renew-mjs-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lock = acquireStateFileLockSync(filePath, 50, true);
    expect(lock).not.toBeNull();

    const before = JSON.parse(readFileSync(`${filePath}.mutation.lock`, 'utf8')) as MutationLockOwner;
    const flockAvailable = existsSync('/usr/bin/flock') || existsSync('/bin/flock');
    expect(renewStateFileLock(lock)).toBe(flockAvailable);
    const after = JSON.parse(readFileSync(`${filePath}.mutation.lock`, 'utf8')) as MutationLockOwner;
    expect(after.nonce).toBe(before.nonce);
    expect(Date.parse(after.expires_at)).toBeGreaterThanOrEqual(Date.parse(before.expires_at));
    releaseStateFileLockSync(lock);
  });

  it('fails closed without the reclaim guard and preserves a replacement owner', () => {
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-renew-no-guard-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    const lock = acquireMutationLockAt(filePath, true);
    expect(lock).not.toBeNull();

    const replacement = freshLeaseOwner(process.pid + 1);
    writeFileSync(lockPath, JSON.stringify(replacement));

    expect(renewMutationLock(lock)).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
    releaseMutationLockSync(lock);
  });

  it('does not overwrite a replacement owner while renewing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-renew-replaced-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    const lock = acquireMutationLockAt(filePath, true);
    expect(lock).not.toBeNull();

    const replacement = freshLeaseOwner(process.pid + 1);
    writeFileSync(lockPath, JSON.stringify(replacement));

    expect(renewMutationLock(lock)).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement);
    releaseMutationLockSync(lock);
  });

  it('does not renew an owner whose on-disk lease has expired', () => {
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-renew-expired-mjs-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lock = acquireStateFileLockSync(filePath, 50, true);
    expect(lock).not.toBeNull();
    const lockPath = `${filePath}.mutation.lock`;
    const owner = (lock as { owner: MutationLockOwner }).owner;
    writeFileSync(lockPath, JSON.stringify({ ...owner, expires_at: new Date(Date.now() - 1).toISOString() }));

    expect(renewStateFileLock(lock)).toBe(false);
    releaseStateFileLockSync(lock);
  });
});

describe('flock-less mutation lock: acquire -> contend -> release cycle (B4.2/B4.3 .mjs)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    delete process.env.OMC_TEST_FORCE_FLOCKLESS;
  });

  it('A acquires, B fails while A is live (no steal), A releases, B acquires', () => {
    // B8: force the flock-less linkSync branch even on Linux CI (which has
    // flock) via OMC_TEST_FORCE_FLOCKLESS=1, without tripping
    // lockingDisabledForTest (exclusive locking stays enabled).
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-cycle-mjs-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    // requireExclusive forces linkSync instead of the { unlocked: true } short-circuit.
    const a = acquireStateFileLockSync(filePath, 50, true);
    expect(a).not.toBeNull();
    expect((a as { unlocked?: boolean }).unlocked).not.toBe(true);
    const lockPath = `${filePath}.mutation.lock`;
    expect(existsSync(lockPath)).toBe(true);

    // B (same process, live) tries while A holds -> must NOT steal. With a
    // small attempt budget it returns null without unlinking A's lock.
    const b = acquireStateFileLockSync(filePath, 3, true);
    expect(b).toBeNull();
    // A's lock survived the steal attempt (same nonce).
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(onDisk.nonce).toBe((a as { owner: MutationLockOwner }).owner.nonce);

    // A releases; B can now acquire.
    releaseStateFileLockSync(a);
    expect(existsSync(lockPath)).toBe(false);
    const b2 = acquireStateFileLockSync(filePath, 50, true);
    expect(b2).not.toBeNull();
    releaseStateFileLockSync(b2);
  });
});

describe('flock-less mutation lock: TS acquire -> contend -> release cycle (B4.3)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    delete process.env.OMC_TEST_FORCE_FLOCKLESS;
  });

  it('A acquires (TS), B fails while A is live, A releases via releaseMutationLockSync, B acquires', () => {
    // B8: force the flock-less branch on Linux CI.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-cycle-ts-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const a = acquireMutationLockAt(filePath, true);
    expect(a).not.toBeNull();
    expect((a as { unlocked?: boolean }).unlocked).not.toBe(true);

    // B cannot steal a live owner's lock.
    const b = acquireMutationLockAt(filePath, true);
    expect(b).toBeNull();

    // releaseMutationLock (the function B1 was filed against) is exercised
    // through the exported releaseMutationLockSync wrapper.
    releaseMutationLockSync(a);
    expect(existsSync(`${filePath}.mutation.lock`)).toBe(false);

    const b2 = acquireMutationLockAt(filePath, true);
    expect(b2).not.toBeNull();
    releaseMutationLockSync(b2);
  });
});

describe('flock-less mutation lock: steal-prevention (B4.4)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    delete process.env.OMC_TEST_FORCE_FLOCKLESS;
  });

  it('a valid (unexpired) lease is NOT stolen by a thief\'s reclaim attempt', () => {
    // B5/B6/B8: lease-based. A live owner = an unexpired lease. The thief
    // reads expires_at, sees it is in the future, and does NOT unlink. No pid
    // liveness is probed, so EPERM/PID-reuse/jiffies edge cases cannot arise.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-steal-prevent-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    // Plant a LIVE owner: expires_at far in the future.
    const liveOwner = freshLeaseOwner(process.pid, undefined, new Date(Date.now() + 60000).toISOString());
    writeFileSync(lockPath, JSON.stringify(liveOwner));

    // Thief B tries to acquire exclusively with a small budget. The unexpired
    // lease blocks the reclaim: B does NOT unlink, returns null.
    const b = acquireStateFileLockSync(filePath, 3, true);
    expect(b).toBeNull();
    // The live owner's lock file is still on disk, unchanged.
    expect(existsSync(lockPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(onDisk.nonce).toBe(liveOwner.nonce);
  });

  it('reclaims a lock whose lease has EXPIRED (holder crashed / did not release)', () => {
    // Lease-based reclaim: now >= expires_at -> the holder is gone -> RECLAIM.
    // This replaces the old "dead pid" reclaim; the lease is the sole signal.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-reclaim-expired-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    // Expired lease: expires_at in the past.
    const expired = freshLeaseOwner(999999999, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), new Date(Date.now() - 60 * 1000).toISOString());
    writeFileSync(lockPath, JSON.stringify(expired));

    const a = acquireStateFileLockSync(filePath, 50, true);
    expect(a).not.toBeNull();
    // A new owner now holds the lock (expired lease was reclaimed).
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe((a as { owner: MutationLockOwner }).owner.nonce);
    releaseStateFileLockSync(a);
  });

  it('reclaims a lock whose lease expired just now (fresh but expired)', () => {
    // Converged policy: reclaim depends ONLY on lease expiry, not on age. A
    // freshly-created lock with an already-expired lease is reclaimed (the
    // holder is gone), matching the flock path's immediate reclaim.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-reclaim-fresh-expired-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    const freshExpired = freshLeaseOwner(999999999, new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
    writeFileSync(lockPath, JSON.stringify(freshExpired));

    const a = acquireStateFileLockSync(filePath, 50, true);
    expect(a).not.toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe((a as { owner: MutationLockOwner }).owner.nonce);
    releaseStateFileLockSync(a);
  });

  it('reclaims a corrupt (unparseable) lock file (no valid lease)', () => {
    // A corrupt lock has no valid lease on record, so the owner cannot be live.
    // RECLAIM (unlink) immediately - no bounded loop, no permanent wedge.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-corrupt-reclaim-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    writeFileSync(lockPath, '{ not valid json');
    expect(readFileSync(lockPath, 'utf8')).toBe('{ not valid json');

    const a = acquireStateFileLockSync(filePath, 50, true);
    expect(a).not.toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe((a as { owner: MutationLockOwner }).owner.nonce);
    releaseStateFileLockSync(a);
  });

  it('recognizes the deployed v1 lease shape as a current live owner', () => {
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-v1-lease-shaped-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    const v1Lease = freshLeaseOwner(process.pid);
    writeFileSync(lockPath, JSON.stringify(v1Lease));

    expect(acquireStateFileLockSync(filePath, 3, true)).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(v1Lease);
  });

  it('fails closed for the legacy v1 processStart liveness shape', () => {
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-v1-liveness-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    const oldLivenessOwner = {
      version: 1,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      processStart: '12345',
      nonce: randomUUID(),
    };
    writeFileSync(lockPath, JSON.stringify(oldLivenessOwner));

    expect(acquireStateFileLockSync(filePath, 3, true)).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(oldLivenessOwner);
  });

  it('fails closed for an unsupported but structurally valid lease owner', () => {
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-unknown-lease-shaped-ts-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    const unknownLease = { ...freshLeaseOwner(process.pid), version: 99 };
    writeFileSync(lockPath, JSON.stringify(unknownLease));

    expect(acquireMutationLockAt(filePath, true)).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(unknownLease);
  });

  it('I/O-unreadable lock (EACCES) fails closed FOREVER - no steal, no bounded reclaim (B9)', () => {
    // B9: a lock we cannot read (EACCES via chmod 000) MAY belong to a live
    // owner; we just cannot read its lease. FAIL CLOSED: the thief returns null
    // and never unlinks, on every attempt - no bounded reclaim, no wedge-escape.
    // This is the direct fix for the old EACCES-on-unreadable-steals-a-live-lock
    // blocker. chmod 000 is portable on POSIX (Linux CI + macOS).
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-unreadable-failclosed-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    // Plant a valid lease owner, then make the file unreadable.
    const owner = freshLeaseOwner(process.pid, undefined, new Date(Date.now() + 60000).toISOString());
    writeFileSync(lockPath, JSON.stringify(owner));
    chmodSync(lockPath, 0o000);

    // Even with a full budget the thief cannot read the lease and must NOT steal.
    const a = acquireStateFileLockSync(filePath, 50, true);
    expect(a).toBeNull();
    // The unreadable lock is still on disk (never unlinked). Restore perms so
    // afterEach cleanup can remove it.
    chmodSync(lockPath, 0o600);
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(owner.nonce);
  });
});

describe('flock-less mutation lock: three-copy parity (B3)', () => {
  it('scripts/lib and templates/hooks/lib atomic-write.mjs are byte-identical', () => {
    const scripts = readFileSync(join(process.cwd(), 'scripts', 'lib', 'atomic-write.mjs'), 'utf8');
    const template = readFileSync(join(process.cwd(), 'templates', 'hooks', 'lib', 'atomic-write.mjs'), 'utf8');
    expect(template).toBe(scripts);
  });
});
