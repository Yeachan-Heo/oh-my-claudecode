import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { processStartIdentities, publishCacheOccupancy, readOccupiedPluginRoots } from '../cache-occupancy.js';

describe('cache occupancy registry', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omc-occupancy-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('publishes an atomic, privacy-bounded record and reads the occupied root', async () => {
    const root = join(dir, 'plugins', '1.0.0');
    mkdirSync(root, { recursive: true });
    expect(await publishCacheOccupancy(root, dir)).toBe(true);
    const result = readOccupiedPluginRoots(dir);
    expect(result.unavailable).toBe(false);
    expect(result.roots).toEqual(new Set([root]));
    const files = readdirSync(join(dir, '.omc', 'cache-occupancy'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it('drops corrupt records without exposing their contents', () => {
    const registry = join(dir, '.omc', 'cache-occupancy');
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, `${'a'.repeat(64)}.json`), '{broken');
    expect(readOccupiedPluginRoots(dir).roots.size).toBe(0);
    expect(readdirSync(registry)).toEqual([]);
  });

  it('resolves Windows process identities in one PowerShell call', () => {
    const originalPlatform = process.platform;
    const exec = vi.fn(() => JSON.stringify([
      { Id: 41, StartTicks: '638933184000000001' },
      { Id: 42, StartTicks: '638933184000000002' },
    ])) as unknown as Parameters<typeof processStartIdentities>[1];
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(processStartIdentities([41, 42, 41], exec)).toEqual(new Map([
        [41, 'ticks:638933184000000001'],
        [42, 'ticks:638933184000000002'],
      ]));
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', expect.stringContaining("[string]$_.StartTime.ToUniversalTime().Ticks")],
        { encoding: 'utf8', windowsHide: true },
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('accepts a single realistic Windows identity and rejects numeric precision loss', () => {
    const originalPlatform = process.platform;
    const exec = vi.fn(() => JSON.stringify({ Id: 41, StartTicks: '638933184000000001' })) as unknown as Parameters<typeof processStartIdentities>[1];
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(processStartIdentities([41], exec)).toEqual(new Map([[41, 'ticks:638933184000000001']]));

      const rounded = vi.fn(() => JSON.stringify({ Id: 41, StartTicks: Number('638933184000000001') })) as unknown as Parameters<typeof processStartIdentities>[1];
      expect(processStartIdentities([41], rounded)).toEqual(new Map());
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
