import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
        readdirSync: vi.fn(),
        statSync: vi.fn(),
        lstatSync: vi.fn(),
        realpathSync: vi.fn(),
        rmSync: vi.fn(),
        unlinkSync: vi.fn(),
        renameSync: vi.fn(),
        symlinkSync: vi.fn(),
    };
});
vi.mock('../utils/config-dir.js', () => ({
    getClaudeConfigDir: vi.fn(() => '/mock/.claude'),
}));
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync, rmSync, renameSync, symlinkSync, unlinkSync, } from 'fs';
import { purgeStalePluginCacheVersions } from '../utils/paths.js';
import { pathRootForTraversal } from '../utils/plugin-cache-validation.js';
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedStatSync = vi.mocked(statSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedRenameSync = vi.mocked(renameSync);
const mockedLstatSync = vi.mocked(lstatSync);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedSymlinkSync = vi.mocked(symlinkSync);
/** lstat result for a real directory. */
function dirStats() {
    return {
        isSymbolicLink: () => false,
        isDirectory: () => true,
    };
}
function dirent(name) {
    return { name, isDirectory: () => true, isSymbolicLink: () => false };
}
function fileDirent(name) {
    return { name, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true };
}
/** Return a stat result with mtime N ms ago.
 * Default must exceed STALE_THRESHOLD_MS (24 h) in src/utils/paths.ts. */
function staleStats(ageMs = 25 * 60 * 60 * 1000) {
    return { mtimeMs: Date.now() - ageMs, size: 1, isDirectory: () => true };
}
describe('purgeStalePluginCacheVersions validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockedStatSync.mockReturnValue(staleStats());
        mockedRenameSync.mockImplementation(() => undefined);
        mockedSymlinkSync.mockImplementation(() => undefined);
        mockedRmSync.mockImplementation(() => undefined);
        mockedUnlinkSync.mockImplementation(() => undefined);
        mockedLstatSync.mockImplementation(() => dirStats());
        mockedRealpathSync.mockImplementation((path) => String(path));
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('includes server and share in extended UNC roots', () => {
        expect(pathRootForTraversal('\\\\?\\UNC\\server\\share\\plugins\\cache\\stale')).toBe('\\\\?\\UNC\\server\\share\\');
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
            if (ps === active1)
                return [fileDirent('README.md')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            if (ps.endsWith('oh-my-claudecode'))
                return [dirent('4.3.0')];
            return [];
        });
        const result = purgeStalePluginCacheVersions();
        // Both stale hookify versions share a namespace with active1 → symlinked.
        expect(result.symlinked).toBe(2);
        expect(result.removed).toBe(0);
        expect(result.symlinkPaths).toContain(stale1);
        expect(result.symlinkPaths).toContain(stale2);
    });
    it('preserves a stale version when registry casing aliases the same directory', () => {
        const cacheDir = '/mock/.claude/plugins/cache';
        const pluginDir = join(cacheDir, 'omc/oh-my-claudecode');
        const activeVersion = join(pluginDir, '4.15.6-beta');
        const staleVersion = join(pluginDir, '4.15.6-BETA');
        const sameDirectoryStats = {
            ...staleStats(),
            dev: 1,
            ino: 12345,
        };
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            value: 'darwin',
            configurable: true,
        });
        try {
            mockedExistsSync.mockImplementation((p) => {
                const ps = String(p);
                return (ps.includes('installed_plugins.json') ||
                    ps === cacheDir ||
                    ps === activeVersion ||
                    ps === staleVersion ||
                    ps.startsWith(`${activeVersion}/`) ||
                    ps.startsWith(`${staleVersion}/`));
            });
            mockedReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                plugins: { 'oh-my-claudecode@omc': [{ installPath: activeVersion }] },
            }));
            mockedStatSync.mockImplementation((p) => {
                const ps = String(p);
                return ps === activeVersion || ps === staleVersion ? sameDirectoryStats : staleStats();
            });
            mockedReaddirSync.mockImplementation((p, _opts) => {
                const ps = String(p);
                if (ps === cacheDir)
                    return [dirent('omc')];
                if (ps.endsWith('omc'))
                    return [dirent('oh-my-claudecode')];
                if (ps === pluginDir)
                    return [dirent('4.15.6-BETA')];
                return [];
            });
            const result = purgeStalePluginCacheVersions();
            expect(result.symlinked).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(mockedRenameSync).not.toHaveBeenCalledWith(staleVersion, expect.any(String));
            expect(mockedSymlinkSync).not.toHaveBeenCalled();
        }
        finally {
            Object.defineProperty(process, 'platform', {
                value: originalPlatform,
                configurable: true,
            });
        }
    });
    it('matches an active namespace with a case-aliased parent by filesystem identity', () => {
        const cacheDir = '/mock/.claude/plugins/cache';
        const marketDir = join(cacheDir, 'omc');
        const pluginDir = join(marketDir, 'Oh-My-ClaudeCode');
        const aliasedPluginDir = join(marketDir, 'oh-my-claudecode');
        const registeredActive = join(aliasedPluginDir, '4.15.10');
        const active = join(pluginDir, '4.15.10');
        const stale = join(pluginDir, '4.15.6');
        const namespaceStats = { ...staleStats(), dev: 1, ino: 101 };
        const activeStats = { ...staleStats(), dev: 1, ino: 102 };
        const staleVersionStats = {
            ...staleStats(),
            dev: 1,
            ino: 103,
        };
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            value: 'darwin',
            configurable: true,
        });
        try {
            mockedExistsSync.mockImplementation((p) => {
                const ps = String(p);
                return (ps.includes('installed_plugins.json') ||
                    ps === cacheDir ||
                    ps === registeredActive ||
                    ps === active ||
                    ps === stale);
            });
            mockedReadFileSync.mockReturnValue(JSON.stringify({
                version: 2,
                plugins: {
                    'oh-my-claudecode@omc': [{ installPath: registeredActive }],
                },
            }));
            mockedStatSync.mockImplementation((p) => {
                const ps = String(p);
                if (ps === pluginDir || ps === aliasedPluginDir)
                    return namespaceStats;
                if (ps === registeredActive || ps === active)
                    return activeStats;
                if (ps === stale)
                    return staleVersionStats;
                return staleStats();
            });
            mockedReaddirSync.mockImplementation((p, _opts) => {
                const ps = String(p);
                if (ps === cacheDir)
                    return [dirent('omc')];
                if (ps === marketDir)
                    return [dirent('Oh-My-ClaudeCode')];
                if (ps === pluginDir)
                    return [dirent('4.15.6'), dirent('4.15.10')];
                return [];
            });
            const result = purgeStalePluginCacheVersions();
            expect(result.symlinked).toBe(0);
            expect(result.removed).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(mockedRmSync).not.toHaveBeenCalledWith(stale, {
                recursive: true,
                force: true,
            });
            expect(mockedRenameSync).not.toHaveBeenCalledWith(stale, expect.any(String));
        }
        finally {
            Object.defineProperty(process, 'platform', {
                value: originalPlatform,
                configurable: true,
            });
        }
    });
    it('rolls back when a generic active root empties between validation scans', () => {
        const cacheDir = '/mock/.claude/plugins/cache';
        const active = join(cacheDir, 'official/hookify/aa11');
        const stale = join(cacheDir, 'official/hookify/bb22');
        const activeEntries = [[fileDirent('README.md')], [], [fileDirent('README.md')], [fileDirent('README.md')]];
        let activeReads = 0;
        mockedExistsSync.mockImplementation((p) => {
            const ps = String(p);
            return ps.includes('installed_plugins.json') || ps === cacheDir || ps === active || ps === stale;
        });
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            version: 2,
            plugins: { 'hookify@official': [{ installPath: active }] },
        }));
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('official')];
            if (ps.endsWith('official'))
                return [dirent('hookify')];
            if (ps.endsWith('hookify'))
                return [dirent('aa11'), dirent('bb22')];
            if (ps === active)
                return activeEntries[Math.min(activeReads++, activeEntries.length - 1)];
            return [];
        });
        const result = purgeStalePluginCacheVersions();
        expect(activeReads).toBe(2);
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(mockedRenameSync).toHaveBeenCalledWith(stale, expect.stringContaining(`${stale}.omc-stale-`));
        expect(mockedRenameSync).toHaveBeenCalledWith(expect.stringContaining(`${stale}.omc-stale-`), stale);
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
});
//# sourceMappingURL=purge-stale-cache-validation.test.js.map