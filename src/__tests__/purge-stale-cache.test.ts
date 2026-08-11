import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
    symlinkSync: vi.fn(),
  };
});

vi.mock('../utils/config-dir.js', () => ({
  getClaudeConfigDir: vi.fn(() => '/mock/.claude'),
}));

import { existsSync, readFileSync, readdirSync, statSync, rmSync, renameSync, symlinkSync } from 'fs';
import { purgeStalePluginCacheVersions } from '../utils/paths.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedStatSync = vi.mocked(statSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedRenameSync = vi.mocked(renameSync);
const mockedSymlinkSync = vi.mocked(symlinkSync);

/** Node error with a specific errno code, for simulating fs races. */
function fsError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function dirent(name: string): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => true };
}

/** Return a stat result with mtime N ms ago.
 * Default must exceed STALE_THRESHOLD_MS (24 h) in src/utils/paths.ts. */
function staleStats(ageMs: number = 25 * 60 * 60 * 1000) {
  return { mtimeMs: Date.now() - ageMs } as ReturnType<typeof statSync>;
}

/** Return a stat result modified very recently */
function freshStats() {
  return { mtimeMs: Date.now() - 1000 } as ReturnType<typeof statSync>;
}

describe('purgeStalePluginCacheVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: statSync returns stale timestamps
    mockedStatSync.mockReturnValue(staleStats());
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

    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('my-marketplace')] as any;
      if (ps.endsWith('my-marketplace')) return [dirent('my-plugin')] as any;
      if (ps.endsWith('my-plugin')) return [dirent('1.0.0'), dirent('2.0.0')] as any;
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();
    // Stale version shares a namespace with the active version, so it is
    // symlinked rather than deleted (fix for #2543).
    expect(result.symlinked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.symlinkPaths).toEqual([staleVersion]);
    // The real dir is moved aside — never deleted outright — before the
    // symlink is created, so the path is never missing.
    expect(mockedRenameSync).toHaveBeenCalledWith(staleVersion, expect.stringContaining(`${staleVersion}.omc-stale-`));
    expect(mockedRmSync).not.toHaveBeenCalledWith(staleVersion, { recursive: true, force: true });
    expect(mockedSymlinkSync).toHaveBeenCalledWith(activeVersion, staleVersion, 'dir');
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
    // Both stale hookify versions share a namespace with active1 → symlinked.
    expect(result.symlinked).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.symlinkPaths).toContain(stale1);
    expect(result.symlinkPaths).toContain(stale2);
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

  // --- C2 fix: trailing slash in installPath ---
  it('matches installPath with trailing slash correctly', () => {
    const cacheDir = '/mock/.claude/plugins/cache';
    const versionDir = join(cacheDir, 'omc/plugin/1.0.0');

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        'plugin@omc': [{
          // installPath has trailing slash
          installPath: versionDir + '/',
        }],
      },
    }));

    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('omc')] as any;
      if (ps.endsWith('omc')) return [dirent('plugin')] as any;
      if (ps.endsWith('plugin')) return [dirent('1.0.0')] as any;
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();
    // Should NOT remove the active version despite trailing slash
    expect(result.removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  // --- C2 fix: installPath points to subdirectory ---
  it('preserves version when installPath points to a subdirectory', () => {
    const cacheDir = '/mock/.claude/plugins/cache';
    const versionDir = join(cacheDir, 'omc/plugin/2.0.0');

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        'plugin@omc': [{
          // installPath points into a subdirectory
          installPath: versionDir + '/dist',
        }],
      },
    }));

    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('omc')] as any;
      if (ps.endsWith('omc')) return [dirent('plugin')] as any;
      if (ps.endsWith('plugin')) return [dirent('2.0.0')] as any;
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();
    // Should NOT remove — active installPath is within this version dir
    expect(result.removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  // --- C3 fix: recently modified directories are skipped ---
  function setupFreshNonActiveCache() {
    const cacheDir = '/mock/.claude/plugins/cache';
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: { 'plugin@omc': [{ installPath: '/other/path' }] },
    }));
    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('omc')] as any;
      if (ps.endsWith('omc')) return [dirent('plugin')] as any;
      if (ps.endsWith('plugin')) return [dirent('1.0.0')] as any;
      return [] as any;
    });
    mockedStatSync.mockReturnValue(freshStats());
  }

  it('skips recently modified directories (race condition guard)', () => {
    setupFreshNonActiveCache();
    const result = purgeStalePluginCacheVersions();
    expect(result.removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  // --- skipGracePeriod option ---
  it('removes fresh directories when skipGracePeriod is true', () => {
    setupFreshNonActiveCache();
    const result = purgeStalePluginCacheVersions({ skipGracePeriod: true });
    expect(result.removed).toBe(1);
    expect(mockedRmSync).toHaveBeenCalled();
  });

  it('still respects grace period when skipGracePeriod is false', () => {
    setupFreshNonActiveCache();
    const result = purgeStalePluginCacheVersions({ skipGracePeriod: false });
    expect(result.removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  // --- S5 fix: unexpected top-level structure ---
  it('reports error for unexpected plugins structure (array)', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: [1, 2, 3],
    }));

    const result = purgeStalePluginCacheVersions();
    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('unexpected top-level structure');
  });

  // --- #2543 regression: symlink-instead-of-delete ---

  it('replaces stale version dir with symlink to active version in same namespace', () => {
    // Scenario: CLAUDE_PLUGIN_ROOT=4.14.4 in a running session; 4.14.5 installed;
    // purge runs after grace period.  4.14.4 must become a symlink, not disappear.
    const cacheDir = '/mock/.claude/plugins/cache';
    const activeVersion = join(cacheDir, 'omc/oh-my-claudecode/4.14.5');
    const staleVersion = join(cacheDir, 'omc/oh-my-claudecode/4.14.4');

    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      if (ps.includes('installed_plugins.json')) return true;
      if (ps === cacheDir) return true;
      if (ps === staleVersion || ps === activeVersion) return true;
      return false;
    });

    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        'oh-my-claudecode@omc': [{ installPath: activeVersion, version: '4.14.5' }],
      },
    }));

    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('omc')] as any;
      if (ps.endsWith('omc')) return [dirent('oh-my-claudecode')] as any;
      if (ps.endsWith('oh-my-claudecode')) return [dirent('4.14.4'), dirent('4.14.5')] as any;
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();

    expect(result.symlinked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.symlinkPaths).toEqual([staleVersion]);
    // Real dir moved aside first, then symlink created in its place
    expect(mockedRenameSync).toHaveBeenCalledWith(staleVersion, expect.stringContaining(`${staleVersion}.omc-stale-`));
    expect(mockedSymlinkSync).toHaveBeenCalledWith(activeVersion, staleVersion, 'dir');
    // Active version untouched
    expect(mockedRmSync).not.toHaveBeenCalledWith(activeVersion, expect.anything());
    expect(mockedSymlinkSync).not.toHaveBeenCalledWith(expect.anything(), activeVersion, expect.anything());
  });

  // --- regression: the relink must never leave the path missing ---

  /** Single stale version alongside one active version in the same namespace. */
  function setupRelinkScenario() {
    const cacheDir = '/mock/.claude/plugins/cache';
    const activeVersion = join(cacheDir, 'omc/oh-my-claudecode/4.15.10');
    const staleVersion = join(cacheDir, 'omc/oh-my-claudecode/4.15.6');

    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      if (ps.includes('installed_plugins.json')) return true;
      if (ps === cacheDir) return true;
      if (ps === staleVersion || ps === activeVersion) return true;
      return ps.includes('.omc-stale-');
    });
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        'oh-my-claudecode@omc': [{ installPath: activeVersion, version: '4.15.10' }],
      },
    }));
    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('omc')] as any;
      if (ps.endsWith('omc')) return [dirent('oh-my-claudecode')] as any;
      if (ps.endsWith('oh-my-claudecode')) return [dirent('4.15.6'), dirent('4.15.10')] as any;
      return [] as any;
    });
    return { activeVersion, staleVersion };
  }

  it('retries the symlink when the path is re-created inside the swap window', () => {
    // A concurrent writer (Finder .DS_Store, Spotlight, another session's purge)
    // re-creates the path after the stale dir is moved aside, making the first
    // symlinkSync fail with EEXIST.  The redirect must still end up in place.
    const { activeVersion, staleVersion } = setupRelinkScenario();
    mockedSymlinkSync
      .mockImplementationOnce(() => { throw fsError('EEXIST'); })
      .mockImplementationOnce(() => undefined);

    const result = purgeStalePluginCacheVersions();

    expect(result.symlinked).toBe(1);
    expect(result.errors).toEqual([]);
    expect(mockedSymlinkSync).toHaveBeenCalledTimes(2);
    // The squatter is cleared before the retry
    expect(mockedRmSync).toHaveBeenCalledWith(staleVersion, { recursive: true, force: true });
    expect(mockedSymlinkSync).toHaveBeenLastCalledWith(activeVersion, staleVersion, 'dir');
  });

  it('restores the stale dir when the symlink can never be placed', () => {
    // Worst case: every attempt loses the race.  The original directory must be
    // moved back so a session pinned to it via CLAUDE_PLUGIN_ROOT keeps working.
    const { staleVersion } = setupRelinkScenario();
    mockedSymlinkSync.mockImplementation(() => { throw fsError('EEXIST'); });

    const result = purgeStalePluginCacheVersions();

    expect(result.symlinked).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(staleVersion);
    // Moved aside, then moved back — the path is a real directory again
    const asideDir = mockedRenameSync.mock.calls[0][1];
    expect(String(asideDir)).toContain(`${staleVersion}.omc-stale-`);
    expect(mockedRenameSync).toHaveBeenLastCalledWith(asideDir, staleVersion);
  });

  it('restores the stale dir when symlink fails with a non-EEXIST error', () => {
    // EPERM/EACCES must not be retried, but must still roll back.
    const { staleVersion } = setupRelinkScenario();
    mockedSymlinkSync.mockImplementation(() => { throw fsError('EPERM'); });

    const result = purgeStalePluginCacheVersions();

    expect(result.symlinked).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(mockedSymlinkSync).toHaveBeenCalledTimes(1);
    const asideDir = mockedRenameSync.mock.calls[0][1];
    expect(mockedRenameSync).toHaveBeenLastCalledWith(asideDir, staleVersion);
  });

  it('deletes stale version dir when no active version exists in namespace', () => {
    // When the active installPath is outside the plugin namespace there is no
    // live version to redirect to, so deletion (original behaviour) applies.
    const cacheDir = '/mock/.claude/plugins/cache';
    const staleVersion = join(cacheDir, 'omc/plugin/1.0.0');

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        // installPath is outside the omc/plugin namespace
        'plugin@other': [{ installPath: '/completely/different/path/2.0.0' }],
      },
    }));

    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('omc')] as any;
      if (ps.endsWith('omc')) return [dirent('plugin')] as any;
      if (ps.endsWith('plugin')) return [dirent('1.0.0')] as any;
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();

    expect(result.removed).toBe(1);
    expect(result.symlinked).toBe(0);
    expect(result.removedPaths).toEqual([staleVersion]);
    expect(mockedRmSync).toHaveBeenCalledWith(staleVersion, { recursive: true, force: true });
    expect(mockedSymlinkSync).not.toHaveBeenCalled();
  });

  it('skips version directory entries where isDirectory() returns false (existing symlinks)', () => {
    // readdirSync with withFileTypes returns isDirectory()=false for symlinks on
    // Linux/macOS. The purge loop must leave these alone.
    const cacheDir = '/mock/.claude/plugins/cache';
    const activeVersion = join(cacheDir, 'omc/oh-my-claudecode/4.14.5');

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      plugins: {
        'oh-my-claudecode@omc': [{ installPath: activeVersion }],
      },
    }));

    mockedReaddirSync.mockImplementation((p, _opts?) => {
      const ps = String(p);
      if (ps === cacheDir) return [dirent('omc')] as any;
      if (ps.endsWith('omc')) return [dirent('oh-my-claudecode')] as any;
      if (ps.endsWith('oh-my-claudecode')) {
        // 4.14.4 is a symlink (isDirectory returns false), 4.14.5 is a real dir
        return [
          { name: '4.14.4', isDirectory: () => false },
          dirent('4.14.5'),
        ] as any;
      }
      return [] as any;
    });

    const result = purgeStalePluginCacheVersions();

    // The symlink entry must not be touched
    expect(result.removed).toBe(0);
    expect(result.symlinked).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
    expect(mockedSymlinkSync).not.toHaveBeenCalled();
  });
});
