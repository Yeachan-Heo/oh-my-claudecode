import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileHandle } from 'fs/promises';

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
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
});
