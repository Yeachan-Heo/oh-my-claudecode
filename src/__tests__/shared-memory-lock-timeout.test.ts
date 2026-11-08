/**
 * Tests for writeEntry lock timeout behavior (issue fix).
 *
 * Verifies that writeEntry retries on lock contention using a 500ms timeout
 * rather than immediately falling back to an unlocked write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock getOmcRoot to use our test directory
const mockGetOmcRoot = vi.fn<(worktreeRoot?: string) => string>();
vi.mock('../lib/worktree-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worktree-paths.js')>();
  return {
    ...actual,
    getOmcRoot: (...args: [string?]) => mockGetOmcRoot(...args),
    validateWorkingDirectory: (dir?: string) => dir || '/tmp',
  };
});

import { writeEntry, readEntry } from '../lib/shared-memory.js';
import * as fileLock from '../lib/file-lock.js';

describe('writeEntry lock timeout', () => {
  let testDir: string;
  let omcDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `shared-memory-lock-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    omcDir = join(testDir, '.omc');
    mkdirSync(omcDir, { recursive: true });
    mockGetOmcRoot.mockReturnValue(omcDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('should pass timeoutMs and retryDelayMs options to withFileLockSync', () => {
    const spy = vi.spyOn(fileLock, 'withFileLockSync');

    writeEntry('ns', 'key1', 'value1');

    expect(spy).toHaveBeenCalledOnce();
    const [, , opts] = spy.mock.calls[0];
    expect(opts).toMatchObject({ timeoutMs: 500, retryDelayMs: 25 });
  });

  it('should succeed and return the entry when the lock is acquired immediately', () => {
    const entry = writeEntry('ns', 'key2', { data: 42 });

    expect(entry.key).toBe('key2');
    expect(entry.value).toEqual({ data: 42 });
    expect(entry.namespace).toBe('ns');

    const read = readEntry('ns', 'key2');
    expect(read).not.toBeNull();
    expect(read!.value).toEqual({ data: 42 });
  });

  it('should fall back to unlocked write after lock timeout exhaustion', () => {
    // Simulate withFileLockSync always throwing (lock never acquired within timeout)
    vi.spyOn(fileLock, 'withFileLockSync').mockImplementation(() => {
      throw new Error('Failed to acquire file lock');
    });

    // Should NOT throw — the catch block falls back to doWrite() directly
    expect(() => writeEntry('ns', 'key3', 'fallback-value')).not.toThrow();

    // Restore and verify the file was written via the fallback path
    vi.restoreAllMocks();
    const read = readEntry('ns', 'key3');
    expect(read).not.toBeNull();
    expect(read!.value).toBe('fallback-value');
  });

  it('should retry (not immediately fall back) when lock is briefly contended', () => {
    let callCount = 0;
    const original = fileLock.withFileLockSync;
    vi.spyOn(fileLock, 'withFileLockSync').mockImplementation(
      <T>(lockPath: string, fn: () => T, opts?: fileLock.FileLockOptions): T => {
        callCount++;
        expect(opts).toMatchObject({ timeoutMs: 500, retryDelayMs: 25 });
        return original(lockPath, fn, opts);
      },
    );

    writeEntry('ns', 'key4', 'retry-value');
    expect(callCount).toBe(1);

    const read = readEntry('ns', 'key4');
    expect(read!.value).toBe('retry-value');
  });

  it('should write the lock file path adjacent to the entry file', () => {
    const spy = vi.spyOn(fileLock, 'withFileLockSync');

    writeEntry('myns', 'mykey', 'v');

    const [lockPath] = spy.mock.calls[0];
    const entryPath = join(omcDir, 'state', 'shared-memory', 'myns', 'mykey.json');
    expect(lockPath).toBe(entryPath + '.lock');
  });
});
