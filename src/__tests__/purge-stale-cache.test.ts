import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('../utils/config-dir.js', () => ({
  getConfigDir: vi.fn(() => '/mock/.claude'),
}));

import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { purgeStalePluginCacheVersions } from '../utils/paths.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedRmSync = vi.mocked(rmSync);

function dirent(name: string): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => true };
}

describe('purgeStalePluginCacheVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when installed_plugins.json does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    const result = purgeStalePluginCacheVersions();
    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it('removes stale versions not in installed_plugins.json', () => {
    const cacheDir = '/mock/.claude/plugins/cache';
    const activeVersion = join(cacheDir, 'my-marketplace/my-plugin/2.0.0');
    const staleVersion = join(cacheDir, 'my-marketplace/my-plugin/1.0.0');

    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      // installed_plugins.json, cache dir, and stale version all exist
      if (ps.includes('installed_plugins.json')) return true;
      if (ps === cacheDir) return true;
      if (ps === staleVersion) return true;
      if (ps === activeVersion) return true;
      return false;
    });

    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        'my-plugin@my-marketplace': [{
          installPath: activeVersion,
          version: '2.0.0',
        }],
      },
    }));

    // cache/ -> [my-marketplace]
    // my-marketplace/ -> [my-plugin]
    // my-plugin/ -> [1.0.0, 2.0.0]
    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('my-marketplace')] as any;
      if (ps.endsWith('my-marketplace')) return [dirent('my-plugin')] as any;
      if (ps.endsWith('my-plugin')) return [dirent('1.0.0'), dirent('2.0.0')] as any;
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();
    expect(result.removed).toBe(1);
    expect(result.removedPaths).toEqual([staleVersion]);
    expect(mockedRmSync).toHaveBeenCalledWith(staleVersion, { recursive: true, force: true });
    // Active version should NOT be removed
    expect(mockedRmSync).not.toHaveBeenCalledWith(activeVersion, expect.anything());
  });

  it('handles multiple marketplaces and plugins', () => {
    const cacheDir = '/mock/.claude/plugins/cache';
    const active1 = join(cacheDir, 'official/hookify/aa11');
    const active2 = join(cacheDir, 'omc/oh-my-claudecode/4.3.0');
    const stale1 = join(cacheDir, 'official/hookify/bb22');
    const stale2 = join(cacheDir, 'official/hookify/cc33');

    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      if (ps.includes('installed_plugins.json')) return true;
      if (ps === cacheDir) return true;
      // stale versions exist
      if (ps === stale1 || ps === stale2) return true;
      return false;
    });

    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        'hookify@official': [{ installPath: active1 }],
        'oh-my-claudecode@omc': [{ installPath: active2 }],
      },
    }));

    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('official'), dirent('omc')] as any;
      if (ps.endsWith('official')) return [dirent('hookify')] as any;
      if (ps.endsWith('hookify')) return [dirent('aa11'), dirent('bb22'), dirent('cc33')] as any;
      if (ps.endsWith('omc')) return [dirent('oh-my-claudecode')] as any;
      if (ps.endsWith('oh-my-claudecode')) return [dirent('4.3.0')] as any;
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();
    expect(result.removed).toBe(2);
    expect(result.removedPaths).toContain(stale1);
    expect(result.removedPaths).toContain(stale2);
  });

  it('does nothing when all cache versions are active', () => {
    const cacheDir = '/mock/.claude/plugins/cache';
    const active = join(cacheDir, 'omc/oh-my-claudecode/4.3.0');

    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      if (ps.includes('installed_plugins.json')) return true;
      if (ps === cacheDir) return true;
      return false;
    });

    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        'oh-my-claudecode@omc': [{ installPath: active }],
      },
    }));

    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('omc')] as any;
      if (ps.endsWith('omc')) return [dirent('oh-my-claudecode')] as any;
      if (ps.endsWith('oh-my-claudecode')) return [dirent('4.3.0')] as any;
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();
    expect(result.removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it('reports error for malformed installed_plugins.json', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('{ invalid json');

    const result = purgeStalePluginCacheVersions();
    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to parse installed_plugins.json');
  });
});
