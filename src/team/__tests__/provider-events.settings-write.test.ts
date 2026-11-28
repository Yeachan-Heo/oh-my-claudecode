// A claude worker starting during a scale-up may read the hook settings while
// the team rewrites them, or another writer may rewrite them at the same time.
// This writes the file in two steps, as a slow disk could, and reads the
// settings path or runs the other writer between them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const probe = vi.hoisted(() => ({ path: '', seen: [] as string[], between: null as null | (() => Promise<unknown>), rmError: null as null | Error }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile = (async (file: Parameters<typeof actual.writeFile>[0], data: unknown) => {
    const text = String(data);
    await actual.writeFile(file, text.slice(0, text.length / 2));
    probe.seen.push(await actual.readFile(probe.path, 'utf8').catch(() => '<absent>'));
    const between = probe.between;
    probe.between = null;
    await between?.();
    await actual.appendFile(file, text.slice(text.length / 2));
  }) as typeof actual.writeFile;
  const rm = (async (...args: Parameters<typeof actual.rm>) => {
    if (probe.rmError) throw probe.rmError;
    await actual.rm(...args);
  }) as typeof actual.rm;
  return { ...actual, writeFile, rm, default: { ...actual, writeFile, rm } };
});

import { providerEventSettingsPath, writeProviderEventSettings } from '../provider-events.js';

describe('writeProviderEventSettings while a reader looks', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'provider-events-settings-write-'));
    probe.path = providerEventSettingsPath(root);
    probe.seen = [];
    probe.between = null;
    probe.rmError = null;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('never shows a reader half a settings file, on the first write or a rewrite', async () => {
    await writeProviderEventSettings(root);
    await writeProviderEventSettings(root);
    expect(probe.seen).toHaveLength(2);
    expect(probe.seen[0]).toBe('<absent>');
    expect(() => JSON.parse(probe.seen[1]!)).not.toThrow();
    expect(Object.keys(JSON.parse(readFileSync(probe.path, 'utf8')).hooks)).toHaveLength(4);
  });

  it.each(['another process', 'the same process a moment later'] as const)('keeps the file whole when %s rewrites it during a write', async writer => {
    const pid = Object.getOwnPropertyDescriptor(process, 'pid')!;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    probe.between = async () => {
      if (writer === 'another process') Object.defineProperty(process, 'pid', { ...pid, value: process.pid + 1 });
      else now.mockReturnValue(1_001);
      await writeProviderEventSettings(root);
    };
    try {
      await writeProviderEventSettings(root);
    } finally {
      Object.defineProperty(process, 'pid', pid);
      now.mockRestore();
    }
    expect(probe.seen).toHaveLength(2);
    expect(Object.keys(JSON.parse(readFileSync(probe.path, 'utf8')).hooks)).toHaveLength(4);
  });

  it('leaves no temporary file when the write fails halfway', async () => {
    probe.between = async () => { throw new Error('disk full'); };
    await expect(writeProviderEventSettings(root)).rejects.toThrow('disk full');
    expect(probe.seen).toHaveLength(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it('leaves no temporary file when the rename fails', async () => {
    // A file cannot be renamed over a directory.
    mkdirSync(probe.path);
    await expect(writeProviderEventSettings(root)).rejects.toThrow();
    expect(probe.seen).toHaveLength(1);
    expect(readdirSync(root)).toEqual([basename(probe.path)]);
  });

  it('reports the write failure when the temporary file cannot be removed either', async () => {
    probe.between = async () => { throw new Error('disk full'); };
    probe.rmError = new Error('rm failed');
    await expect(writeProviderEventSettings(root)).rejects.toThrow('disk full');
  });
});
