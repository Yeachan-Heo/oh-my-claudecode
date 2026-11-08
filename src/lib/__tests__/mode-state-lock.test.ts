import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProcessStartIdentitySync } from '../../platform/process-utils.js';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const fsControl = vi.hoisted(() => ({
  racePath: undefined as string | undefined,
  replacement: undefined as Record<string, unknown> | undefined,
  injected: false,
}));

// Fires once when the liveness probe inspects `pid`, i.e. between the
// reclaimer's identity capture and its quarantine rename.
const probeControl = vi.hoisted(() => ({
  pid: undefined as number | undefined,
  onProbe: undefined as undefined | (() => void),
  fire(pid: unknown): void {
    if (pid !== this.pid || !this.onProbe) return;
    const hook = this.onProbe;
    this.onProbe = undefined;
    hook();
  },
}));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    // scripts/lib/state-lock.mjs probes Linux liveness through /proc/<pid>/stat.
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      const match = typeof path === 'string' ? /^\/proc\/(\d+)\/stat$/.exec(path) : null;
      if (match) probeControl.fire(Number(match[1]));
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
    renameSync: (from: string, to: string) => {
      actual.renameSync(from, to);
      if (from === fsControl.racePath && !fsControl.injected && fsControl.replacement) {
        fsControl.injected = true;
        actual.writeFileSync(from, JSON.stringify(fsControl.replacement));
      }
    },
  };
});

// scripts/lib/state-lock.mjs probes win32/darwin liveness through spawnSync.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: ((command: string, args?: readonly string[], ...rest: unknown[]) => {
      const pid = probeControl.pid;
      if (pid !== undefined && (args ?? []).some(arg => new RegExp(`\\b${pid}\\b`).test(arg))) probeControl.fire(pid);
      return (actual.spawnSync as (...a: unknown[]) => unknown)(command, args, ...rest);
    }) as typeof actual.spawnSync,
  };
});

// src/lib/mode-state-io.ts probes liveness through getProcessStartIdentitySync.
vi.mock('../../platform/process-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../platform/process-utils.js')>();
  return {
    ...actual,
    getProcessStartIdentitySync: (pid: number) => {
      probeControl.fire(pid);
      return actual.getProcessStartIdentitySync(pid);
    },
  };
});

import {
  captureStateFileGeneration,
  clearStateFileLocked,
  getStateMutationLockFailureMessage,
  withStateFileMutationLock,
} from '../mode-state-io.js';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { withStateFileLockSync as withHookStateFileLockSync } from '../../../scripts/lib/state-lock.mjs';

const directories: string[] = [];

function processStart(): string {
  const identity = getProcessStartIdentitySync(process.pid);
  if (identity === null) throw new Error('current process identity unavailable');
  return identity;
}

function owner(pid: number, processStart: string): Record<string, unknown> {
  return {
    version: 1,
    pid,
    processStart,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
}

afterEach(() => {
  fsControl.racePath = undefined;
  fsControl.replacement = undefined;
  fsControl.injected = false;
  probeControl.pid = undefined;
  probeControl.onProbe = undefined;
  delete process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('state mutation lock fallback', () => {
  it('does not delete a replacement owner observed during stale reclamation', () => {
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE = '1';
    const directory = mkdtempSync(join(tmpdir(), 'mode-state-lock-race-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const lockPath = `${statePath}.mutation.lock`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(owner(999999999, '1')));
    fsControl.racePath = lockPath;
    fsControl.replacement = owner(process.pid, processStart());

    const result = withStateFileMutationLock(statePath, () => 'held');

    expect(fsControl.injected).toBe(true);
    expect(result).toEqual({ acquired: false, value: undefined });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(fsControl.replacement);
    expect(getStateMutationLockFailureMessage()).toContain('contention');
  });
});

describe('dead-owner reclaim rechecks the owner record before quarantine', () => {
  const DEAD_PID = 999999999;

  // The dead owner's record is replaced by a live owner between the liveness
  // probe and the quarantine rename. Rewriting the file in place keeps its
  // dev/ino, which is what inode reuse after unlink + republish looks like, so
  // the identity recheck alone cannot see the change. A third contender then
  // publishes as soon as the pathname is vacated by the rename.
  it.each([
    ['src/lib/mode-state-io.ts', (statePath: string) => withStateFileMutationLock(statePath, () => 'held')],
    ['scripts/lib/state-lock.mjs', (statePath: string) => withHookStateFileLockSync(statePath, () => 'held')],
  ])('%s leaves a same-inode live replacement in place', (_twin, acquire) => {
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE = '1';
    const directory = mkdtempSync(join(tmpdir(), 'mode-state-lock-reuse-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    const lockPath = `${statePath}.mutation.lock`;
    const liveReplacement = owner(process.pid, processStart());
    writeFileSync(lockPath, JSON.stringify(owner(DEAD_PID, '1')));
    probeControl.pid = DEAD_PID;
    probeControl.onProbe = () => writeFileSync(lockPath, JSON.stringify(liveReplacement));
    fsControl.racePath = lockPath;
    fsControl.replacement = owner(process.pid, processStart());

    const result = acquire(statePath);

    expect(probeControl.onProbe).toBeUndefined();
    expect(fsControl.injected).toBe(false);
    expect(result).toEqual({ acquired: false, value: undefined });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(liveReplacement);
  });
});

describe('generation-bound clear', () => {
  function capturedState(): { statePath: string; generation: NonNullable<ReturnType<typeof captureStateFileGeneration>>['generation'] } {
    const directory = mkdtempSync(join(tmpdir(), 'mode-state-generation-'));
    directories.push(directory);
    const statePath = join(directory, 'state.json');
    writeFileSync(statePath, JSON.stringify({ active: true }));
    const captured = captureStateFileGeneration(statePath);
    if (!captured) throw new Error('state generation unavailable');
    return { statePath, generation: captured.generation };
  }

  function asPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    try {
      return run();
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original });
    }
  }

  // Prime the cached own-process identity on the real platform so the
  // simulated platform below only affects the identity comparison.
  function primeLockIdentity(): void {
    const { statePath } = capturedState();
    expect(clearStateFileLocked(statePath)).toBe(true);
  }

  it('captures generations with exact BigInt ids', () => {
    const { generation } = capturedState();
    expect(typeof generation.dev).toBe('bigint');
    expect(typeof generation.ino).toBe('bigint');
  });

  it('clears a generation whose dev was reported as 0 on win32 (#4156)', () => {
    primeLockIdentity();
    const { statePath, generation } = capturedState();
    expect(asPlatform('win32', () => clearStateFileLocked(statePath, { ...generation, dev: 0n }))).toBe(true);
    expect(existsSync(statePath)).toBe(false);
  });

  it('still refuses a generation with a different ino under zero-dev tolerance', () => {
    primeLockIdentity();
    const { statePath, generation } = capturedState();
    expect(asPlatform('win32', () => clearStateFileLocked(statePath, { ...generation, dev: 0n, ino: generation.ino + 2n }))).toBe(false);
    expect(existsSync(statePath)).toBe(true);
  });
});
