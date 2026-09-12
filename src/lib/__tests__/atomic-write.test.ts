import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileHandle } from 'fs/promises';

import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getProcessStartIdentitySync } from '../../platform/process-utils.js';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import { withStateFileLockSync } from '../../../scripts/lib/atomic-write.mjs';

import { tmpdir } from 'os';

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

import {
  atomicWriteBatchSync,
  atomicWriteFileSync,
  atomicWriteJson,
} from '../atomic-write.js';

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

  it('publishes a normal atomic write under Windows stat semantics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-win32-'));
    directories.push(directory);
    const filePath = join(directory, 'state.json');
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await atomicWriteJson(filePath, { status: 'new' });
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ status: 'new' });
  });

  it.each(['hardlink', 'special', 'replacement', 'permissions'])(
    'rejects an untrusted temporary generation (%s) before rename',
    async kind => {
      const directory = mkdtempSync(join(tmpdir(), `atomic-write-${kind}-`));
      directories.push(directory);
      const filePath = join(directory, 'state.json');
      const oldValue = { status: 'old' };
      writeFileSync(filePath, JSON.stringify(oldValue));
      let extraPath: string | undefined;

      fsPromisesControl.writeHook = () => {
        const tempName = readdirSync(directory).find(name => name.startsWith('.state.json.tmp.'));
        if (!tempName) throw new Error('atomic temp generation unavailable');
        const tempPath = join(directory, tempName);
        if (kind === 'hardlink') {
          extraPath = `${tempPath}.link`;
          linkSync(tempPath, extraPath);
        } else if (kind === 'special') {
          unlinkSync(tempPath);
          mkdirSync(tempPath);
        } else if (kind === 'replacement') {
          unlinkSync(tempPath);
          writeFileSync(tempPath, 'attacker replacement');
        } else {
          chmodSync(tempPath, 0o644);
        }
      };

      await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toThrow(
        /private regular single-link|replaced before rename/,
      );

      expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(oldValue);
      if (extraPath !== undefined) rmSync(extraPath, { force: true });
    },
  );

  it('rejects a temp replacement at rename without overwriting the foreign target', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-publication-race-'));
    directories.push(directory);
    const filePath = join(directory, 'state.json');
    const oldValue = { status: 'old' };
    writeFileSync(filePath, JSON.stringify(oldValue));
    let raced = false;
    fsPromisesControl.renameHook = async from => {
      if (raced) return;
      raced = true;
      unlinkSync(from.toString());
      writeFileSync(from.toString(), JSON.stringify({ status: 'attacker' }));
    };

    await expect(atomicWriteJson(filePath, { status: 'new' })).rejects.toThrow(
      'target was replaced at publication',
    );
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ status: 'attacker' });
    expect(readdirSync(directory)).toEqual(['state.json']);
  });

  it.each(['sync', 'batch'] as const)(
    'rolls back the prior target when %s publication loses its ownership hook',
    kind => {
      const directory = mkdtempSync(join(tmpdir(), `atomic-write-${kind}-boundary-`));
      directories.push(directory);
      const filePath = join(directory, 'state.json');
      writeFileSync(filePath, 'old', 'utf8');
      const hooks = { afterRename: () => { throw new Error('publication fenced'); } };

      if (kind === 'sync') {
        expect(() => atomicWriteFileSync(filePath, 'new', hooks)).toThrow(
          'publication fenced',
        );
      } else {
        expect(() => atomicWriteBatchSync([{ path: filePath, content: 'new' }], hooks)).toThrow(
          'publication fenced',
        );
      }
      expect(readFileSync(filePath, 'utf8')).toBe('old');
      expect(readdirSync(directory)).toEqual(['state.json']);
    },
  );

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

  it('reclaims stale generic lock artifacts under the SQLite guard', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-'));
    directories.push(directory);
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const filePath = join(directory, 'state.json');
    writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() }));

    expect(withStateFileLockSync(filePath, () => 'written')).toEqual({ acquired: true, value: 'written' });
    expect(existsSync(`${filePath}.mutation.lock`)).toBe(false);
  });

  it('rejects a live lock artifact without an unlocked fallback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-write-lock-live-'));
    directories.push(directory);
    process.env.NODE_ENV = 'test';
    process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
    const filePath = join(directory, 'state.json');
    const processStart = getProcessStartIdentitySync(process.pid);
    if (processStart === null) throw new Error('current process identity unavailable');
    writeFileSync(`${filePath}.mutation.lock`, JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() }));

    expect(withStateFileLockSync(filePath, () => 'written')).toEqual({ acquired: false, value: undefined });
    expect(existsSync(`${filePath}.mutation.lock`)).toBe(true);
  });
});
