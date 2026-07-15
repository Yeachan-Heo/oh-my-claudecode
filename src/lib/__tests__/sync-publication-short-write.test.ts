import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const fsControl = vi.hoisted(() => ({
  maxBytes: 0,
  calls: 0,
}));

type WriteSync = (fd: number, buffer: string | Uint8Array, offset?: number | null, length?: number | string | null, position?: number | null) => number;


vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeSync: (...args: Parameters<WriteSync>) => {
      fsControl.calls += 1;
      const writeSync = actual.writeSync as unknown as WriteSync;
      const [fd, buffer, offset, length, position] = args;
      if (fsControl.maxBytes > 0 && typeof buffer === 'string') {
        const bytes = Buffer.from(buffer, typeof length === 'string' ? length as BufferEncoding : 'utf8');
        return writeSync(fd, bytes, 0, Math.min(bytes.length, fsControl.maxBytes), typeof offset === 'number' ? offset : null);
      }
      if (fsControl.maxBytes > 0 && Buffer.isBuffer(buffer) && typeof length === 'number') {
        return writeSync(fd, buffer, offset, Math.min(length, fsControl.maxBytes), position);
      }
      return writeSync(...args);
    },
  };
});

import { writeStateFileLocked } from '../mode-state-io.js';
// @ts-expect-error Hook runtime source is intentionally JavaScript-only.
import * as pluginAtomicWrite from '../../../scripts/lib/atomic-write.mjs';
// @ts-expect-error Hook template source is intentionally JavaScript-only.
import * as templateAtomicWrite from '../../../templates/hooks/lib/atomic-write.mjs';

const directories: string[] = [];

function fixturePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'sync-publication-short-write-'));
  directories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  fsControl.maxBytes = 0;
  fsControl.calls = 0;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('synchronous publication short writes', () => {
  it('completes TypeScript state and mutation-lock publications before exposing either path', () => {
    const statePath = fixturePath('state.json');
    const state = { active: true, workflowRunId: 'run-✓' };
    fsControl.maxBytes = 1;

    expect(writeStateFileLocked(statePath, state)).toBe(true);

    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(state);
    expect(() => readFileSync(`${statePath}.mutation.lock`, 'utf8')).toThrow(/ENOENT/);
    expect(fsControl.calls).toBeGreaterThan(Buffer.byteLength(JSON.stringify(state), 'utf8'));
  });

  it.each([
    ['plugin', pluginAtomicWrite],
    ['template', templateAtomicWrite],
  ])('completes short writes for %s state and lock publications', (_name, atomicWrite) => {
    const statePath = fixturePath('state.json');
    const content = JSON.stringify({ state: 'complete-✓' });
    fsControl.maxBytes = 2;

    atomicWrite.atomicWriteFileSync(statePath, content);
    expect(readFileSync(statePath, 'utf8')).toBe(content);

    expect(atomicWrite.withStateFileLockSync(statePath, () => 'held')).toEqual({ acquired: true, value: 'held' });
    expect(() => readFileSync(`${statePath}.mutation.lock`, 'utf8')).toThrow(/ENOENT/);
    expect(fsControl.calls).toBeGreaterThan(Buffer.byteLength(content, 'utf8') / 2);
  });
});
