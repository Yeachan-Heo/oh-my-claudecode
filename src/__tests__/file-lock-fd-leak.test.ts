import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
    writeSync: vi.fn(actual.writeSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

import {
  openSync as mockOpenSync,
  closeSync as mockCloseSync,
  writeSync as mockWriteSync,
  unlinkSync as mockUnlinkSync,
} from 'fs';
import { acquireFileLockSync } from '../lib/file-lock.js';

const mockedOpenSync = vi.mocked(mockOpenSync);
const mockedCloseSync = vi.mocked(mockCloseSync);
const mockedWriteSync = vi.mocked(mockWriteSync);
const mockedUnlinkSync = vi.mocked(mockUnlinkSync);

describe('file-lock fd leak on writeSync failure', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `file-lock-fd-leak-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    vi.clearAllMocks();
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    mockedOpenSync.mockImplementation(realFs.openSync);
    mockedCloseSync.mockImplementation(realFs.closeSync);
    mockedWriteSync.mockImplementation(realFs.writeSync as typeof mockWriteSync);
    mockedUnlinkSync.mockImplementation(realFs.unlinkSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should close fd and unlink lock file when writeSync throws on primary path', async () => {
    const realFs = await vi.importActual<typeof import('fs')>('fs');

    const capturedFds: number[] = [];
    const closedFds: number[] = [];

    mockedOpenSync.mockImplementation((...args: Parameters<typeof mockOpenSync>) => {
      const fd = realFs.openSync(...args);
      capturedFds.push(fd);
      return fd;
    });

    mockedCloseSync.mockImplementation((fd) => {
      closedFds.push(fd as number);
      realFs.closeSync(fd);
    });

    mockedUnlinkSync.mockImplementation(realFs.unlinkSync);

    mockedWriteSync.mockImplementation(() => {
      throw new Error('simulated write failure');
    });

    const lockPath = join(testDir, 'primary.lock');

    expect(() => acquireFileLockSync(lockPath)).toThrow('simulated write failure');

    expect(capturedFds).toHaveLength(1);
    expect(closedFds).toContain(capturedFds[0]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('should close fd and unlink lock file when writeSync throws on retry path', async () => {
    const realFs = await vi.importActual<typeof import('fs')>('fs');

    const capturedFds: number[] = [];
    const closedFds: number[] = [];

    mockedOpenSync.mockImplementation((...args: Parameters<typeof mockOpenSync>) => {
      const fd = realFs.openSync(...args);
      capturedFds.push(fd);
      return fd;
    });

    mockedCloseSync.mockImplementation((fd) => {
      closedFds.push(fd as number);
      realFs.closeSync(fd);
    });

    mockedUnlinkSync.mockImplementation(realFs.unlinkSync);

    // writeSync always throws; primary path hits EEXIST so openSync only runs once (retry)
    mockedWriteSync.mockImplementation(() => {
      throw new Error('simulated write failure on retry');
    });

    const lockPath = join(testDir, 'retry.lock');

    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, timestamp: Date.now() - 60_000 }));
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);

    const handle = acquireFileLockSync(lockPath, { staleLockMs: 1000 });
    expect(handle).toBeNull();

    expect(capturedFds).toHaveLength(1);
    expect(closedFds).toContain(capturedFds[0]);
    expect(existsSync(lockPath)).toBe(false);
  });
});
