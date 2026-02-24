import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
        readdirSync: vi.fn(),
        statSync: vi.fn(),
        rmSync: vi.fn(),
        unlinkSync: vi.fn(),
    };
});
vi.mock('../utils/config-dir.js', () => ({
    getConfigDir: vi.fn(() => '/mock/.claude'),
}));
import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'fs';
import { purgeStalePluginCacheVersions } from '../utils/paths.js';
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedStatSync = vi.mocked(statSync);
const mockedRmSync = vi.mocked(rmSync);
function dirent(name) {
    return { name, isDirectory: () => true };
}
/** Return a stat result with mtime N ms ago.
 * Default must exceed STALE_THRESHOLD_MS (24 h) in src/utils/paths.ts. */
function staleStats(ageMs = 25 * 60 * 60 * 1000) {
    return { mtimeMs: Date.now() - ageMs };
}
/** Return a stat result modified very recently */
function freshStats() {
    return { mtimeMs: Date.now() - 1000 };
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
            if (ps.includes('installed_plugins.json'))
                return true;
            if (ps === cacheDir)
                return true;
            if (ps === staleVersion)
                return true;
            if (ps === activeVersion)
                return true;
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
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('my-marketplace')];
            if (ps.endsWith('my-marketplace'))
                return [dirent('my-plugin')];
            if (ps.endsWith('my-plugin'))
                return [dirent('1.0.0'), dirent('2.0.0')];
            return [];
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
            if (ps.includes('installed_plugins.json'))
                return true;
            if (ps === cacheDir)
                return true;
            if (ps === stale1 || ps === stale2)
                return true;
            return false;
        });
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            version: 2,
            plugins: {
                'hookify@official': [{ installPath: active1 }],
                'oh-my-claudecode@omc': [{ installPath: active2 }],
            },
        }));
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('official'), dirent('omc')];
            if (ps.endsWith('official'))
                return [dirent('hookify')];
            if (ps.endsWith('hookify'))
                return [dirent('aa11'), dirent('bb22'), dirent('cc33')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            if (ps.endsWith('oh-my-claudecode'))
                return [dirent('4.3.0')];
            return [];
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
            if (ps.includes('installed_plugins.json'))
                return true;
            if (ps === cacheDir)
                return true;
            return false;
        });
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: active }],
            },
        }));
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            if (ps.endsWith('oh-my-claudecode'))
                return [dirent('4.3.0')];
            return [];
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
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('plugin')];
            if (ps.endsWith('plugin'))
                return [dirent('1.0.0')];
            return [];
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
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('plugin')];
            if (ps.endsWith('plugin'))
                return [dirent('2.0.0')];
            return [];
        });
        const result = purgeStalePluginCacheVersions();
        // Should NOT remove — active installPath is within this version dir
        expect(result.removed).toBe(0);
        expect(mockedRmSync).not.toHaveBeenCalled();
    });
    // --- C3 fix: recently modified directories are skipped ---
    it('skips recently modified directories (race condition guard)', () => {
        const cacheDir = '/mock/.claude/plugins/cache';
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            version: 2,
            plugins: { 'plugin@omc': [{ installPath: '/other/path' }] },
        }));
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('plugin')];
            if (ps.endsWith('plugin'))
                return [dirent('1.0.0')];
            return [];
        });
        // Directory was just modified (fresh) — should be skipped
        mockedStatSync.mockReturnValue(freshStats());
        const result = purgeStalePluginCacheVersions();
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
});
//# sourceMappingURL=purge-stale-cache.test.js.map