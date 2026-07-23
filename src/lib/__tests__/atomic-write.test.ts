import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileHandle } from 'fs/promises';

import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { withStateFileLockSync, releaseStateFileLockSync, acquireStateFileLockSync } from '../../../scripts/lib/atomic-write.mjs';
import {
  acquireMutationLockAt,
  releaseMutationLockSync,
  isMutationLockOwnerLive,
  validateMutationLockOwner,
  __testCurrentProcessStart,
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
    writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() }));

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
    // so the lock artifact is never inspected; build a live-looking owner
    // without depending on /proc (absent on macOS). processStart is an opaque
    // token here.
    writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({ version: 1, pid: process.pid, processStart: currentProcessStart(), createdAt: new Date().toISOString(), nonce: randomUUID() }));

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
    // Owner A acquired the lock legitimately (processStart is an opaque token
    // for the release-path owner comparison; any validated string suffices and
    // avoids a /proc dependency that does not exist on macOS).
    const ownerA = { version: 1, pid: 4242, processStart: '4242', createdAt: new Date().toISOString(), nonce: randomUUID() };
    writeFileSync(lockPath, JSON.stringify(ownerA));
    // While A held it, A's owner file became transiently unreadable, B stole the
    // lock via linkSync (stale-reclaim), publishing owner B at the same path.
    const ownerB = { version: 1, pid: 5252, processStart: '5252', createdAt: new Date().toISOString(), nonce: randomUUID() };
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
    const owner = { version: 1, pid: 4242, processStart: '4242', createdAt: new Date().toISOString(), nonce: randomUUID() };
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
 * Returns the process_start value production computes for the CURRENT pid on
 * this platform (Linux /proc jiffies; non-linux ms-epoch). B5: tests that plant
 * a "live" owner MUST use this - NOT a re-derived ms epoch - so the planted
 * owner matches what processStartIdentity computes on the CI platform. A
 * re-derived Date.now()-uptime epoch never matches Linux jiffies and also races
 * Math.floor on non-linux, so the owner was misclassified as PID-reused.
 */
function currentProcessStart(): string {
  // __testCurrentProcessStart() calls processStartIdentity(process.pid), which
  // resolves on every supported platform under NODE_ENV=test (jiffies on Linux,
  // ms-epoch on mac/win). The .mjs seam computes the same value; the TS seam is
  // authoritative for the TS code path under test.
  return __testCurrentProcessStart() as string;
}

/** Enable the B8 flock-less test seam for the current test, restoring afterEach. */
function enableForceFlockless(): void {
  process.env.NODE_ENV = 'test';
  process.env.OMC_TEST_FORCE_FLOCKLESS = '1';
}

function freshOwner(pid: number, processStart: string): MutationLockOwner {
  return { version: 1, pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
}

describe('flock-less mutation lock: owner-liveness unit (B4.1)', () => {
  it('treats a dead pid as a dead (reclaimable) owner', () => {
    // 999999999 is not a live process on any test host.
    expect(isMutationLockOwnerLive(freshOwner(999999999, '1'))).toBe(false);
  });

  it('treats the live current process with matching process_start as live', () => {
    expect(isMutationLockOwnerLive(freshOwner(process.pid, currentProcessStart()))).toBe(true);
  });

  it('treats an alive pid with mismatched process_start as dead (PID reuse)', () => {
    // The pid is alive (it is us) but the recorded process_start is wrong, so
    // the original owner is gone (its pid was reused). Reclaimable.
    expect(isMutationLockOwnerLive(freshOwner(process.pid, '1'))).toBe(false);
  });

  it('treats an unverifiable external pid as live (never steal)', () => {
    // A live pid whose process_start we cannot resolve (processStartIdentity
    // returns null) must be treated as LIVE - stealing a claim is never safe
    // when ownership cannot be disproved. Spawn a real child so the pid is
    // genuinely alive on every platform; force the unknown-pid env seam so
    // Linux processStartIdentity also returns null for it (on non-linux a
    // non-self pid already returns null). B6 ensures isProcessAlive stays true
    // for a live pid (ESRCH-only dead).
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 60000)'], { stdio: 'ignore' });
    try {
      const pid = child.pid as number;
      process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID = String(pid);
      // isProcessAlive(pid)=true, processStartIdentity(pid)=null -> live (never steal).
      expect(isMutationLockOwnerLive(freshOwner(pid, '1'))).toBe(true);
    } finally {
      delete process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });
});

describe('flock-less mutation lock: validateMutationLockOwner (B4.1)', () => {
  it('accepts a well-formed owner', () => {
    expect(validateMutationLockOwner(freshOwner(process.pid, currentProcessStart()))).not.toBeNull();
  });

  it('rejects an owner with extra keys, wrong types, and bad nonce/processStart', () => {
    expect(validateMutationLockOwner(null)).toBeNull();
    expect(validateMutationLockOwner({ version: 1, pid: 1, processStart: 'x', createdAt: new Date().toISOString(), nonce: randomUUID() })).toBeNull();
    expect(validateMutationLockOwner({ version: 1, pid: 1, processStart: '1', createdAt: new Date().toISOString(), nonce: 'not-a-uuid' })).toBeNull();
    expect(validateMutationLockOwner({ version: 2, pid: 1, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() })).toBeNull();
    expect(validateMutationLockOwner({ version: 1, pid: 1, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID(), extra: 1 })).toBeNull();
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

  it('a live owner\'s lock is NOT unlinked by a thief\'s reclaim attempt', () => {
    // B8: force the flock-less branch on Linux CI.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-steal-prevent-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    // Plant a LIVE owner (the current process, matching process_start). B5:
    // currentProcessStart() now derives the value from processStartIdentity
    // itself (jiffies on Linux, ms-epoch on mac) so it matches what production
    // computes for this pid on the CI platform.
    const liveOwner = freshOwner(process.pid, currentProcessStart());
    writeFileSync(lockPath, JSON.stringify(liveOwner));

    // Thief B tries to acquire exclusively. The live owner must block the
    // reclaim: B reads the owner, isLockOwnerLive is true, so B does NOT unlink.
    const b = acquireStateFileLockSync(filePath, 3, true);
    expect(b).toBeNull();
    // The live owner's lock file is still on disk, unchanged.
    expect(existsSync(lockPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(onDisk.nonce).toBe(liveOwner.nonce);
  });

  it('reclaims a stale lock whose owner process is demonstrably dead', () => {
    // B8: force the flock-less branch on Linux CI.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-reclaim-dead-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    // Plant a stale lock owned by a dead pid. B7: the flock-less reclaim is now
    // liveness-only (the 1h age gate was removed to converge with the flock
    // path's immediate reclaim), so a demonstrably-dead owner is reclaimed.
    const stale = { version: 1, pid: 999999999, processStart: '1', createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), nonce: randomUUID() };
    writeFileSync(lockPath, JSON.stringify(stale));

    const a = acquireStateFileLockSync(filePath, 50, true);
    expect(a).not.toBeNull();
    // A new owner now holds the lock (reclaimed).
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe((a as { owner: MutationLockOwner }).owner.nonce);
    releaseStateFileLockSync(a);
  });

  it('reclaims a fresh lock whose owner process is demonstrably dead (B7 liveness-only convergence)', () => {
    // B7: the flock-less reclaim policy was converged with the flock path -
    // liveness-only, NO 1h age gate. A dead owner's lock is reclaimed as soon
    // as liveness proves the owner is gone, regardless of age (matching the
    // flock path's immediate reclaim). The prior staleness gate is gone.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-reclaim-fresh-dead-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    // Fresh lock owned by a dead pid. Liveness-only reclaim reclaims it.
    const fresh = { version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() };
    writeFileSync(lockPath, JSON.stringify(fresh));

    const a = acquireStateFileLockSync(filePath, 50, true);
    expect(a).not.toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe((a as { owner: MutationLockOwner }).owner.nonce);
    releaseStateFileLockSync(a);
  });

  it('reclaims a corrupt lock after a bounded number of attempts (B7 corrupt-lock bounded recovery)', () => {
    // B7: a corrupt/unparseable lock file previously wedged the lock PERMANENTLY
    // (readLockOwner -> null -> log unverifiable -> return null forever). Now
    // the flock-less path fails closed for most of the loop, then reclaims
    // (unlinks) the corrupt lock on the final attempts so recovery is bounded.
    enableForceFlockless();
    const dir = mkdtempSync(join(tmpdir(), 'aw-corrupt-recover-'));
    dirs.push(dir);
    const filePath = join(dir, 'state.json');
    const lockPath = `${filePath}.mutation.lock`;
    // Corrupt (unparseable) lock file.
    writeFileSync(lockPath, '{ not valid json');
    expect(readFileSync(lockPath, 'utf8')).toBe('{ not valid json');

    const a = acquireStateFileLockSync(filePath, 50, true);
    expect(a).not.toBeNull();
    // A new owner now holds the lock (corrupt lock was reclaimed).
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe((a as { owner: MutationLockOwner }).owner.nonce);
    releaseStateFileLockSync(a);
  });
});

describe('flock-less mutation lock: three-copy parity (B3)', () => {
  it('scripts/lib and templates/hooks/lib atomic-write.mjs are byte-identical', () => {
    const scripts = readFileSync(join(process.cwd(), 'scripts', 'lib', 'atomic-write.mjs'), 'utf8');
    const template = readFileSync(join(process.cwd(), 'templates', 'hooks', 'lib', 'atomic-write.mjs'), 'utf8');
    expect(template).toBe(scripts);
  });
});
