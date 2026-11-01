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
/** lstat result for a redirect symlink. */
function symlinkStats() {
    return {
        isSymbolicLink: () => true,
        isDirectory: () => false,
    };
}
/** Node error with a specific errno code, for simulating fs races. */
function fsError(code) {
    const err = new Error(code);
    err.code = code;
    return err;
}
/** Pid the fixtures use for an owner that has exited. */
const DEAD_OWNER_PID = 999997;
/**
 * Make process liveness deterministic: this process is alive, every other pid is
 * gone. Without it the fixtures depend on whether the host happens to be running
 * something at the pid baked into the directory name — and a pid owned by another
 * user reports EPERM, which isAsideOwnerAlive counts as alive, so a low pid on a
 * CI runner would silently flip the dead-owner cases into in-flight ones.
 */
function stubOwnerLiveness() {
    return vi.spyOn(process, 'kill').mockImplementation(((pid) => {
        if (pid === process.pid)
            return true;
        throw fsError('ESRCH');
    }));
}
function dirent(name) {
    return { name, isDirectory: () => true, isSymbolicLink: () => false };
}
function fileDirent(name) {
    return { name, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true };
}
let nextIno = 0n;
/** Return a stat result with mtime N ms ago.
 * Default must exceed STALE_THRESHOLD_MS (24 h) in src/utils/paths.ts.
 * Each call gets its own bigint identity, so mocked paths never alias each other. */
function staleStats(ageMs = 25 * 60 * 60 * 1000) {
    return { mtimeMs: Date.now() - ageMs, size: 1, dev: 0n, ino: ++nextIno, isDirectory: () => true };
}
/** Return a stat result modified very recently */
function freshStats() {
    return { mtimeMs: Date.now() - 1000 };
}
describe('purgeStalePluginCacheVersions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: statSync returns stale timestamps
        mockedStatSync.mockImplementation(() => staleStats());
        // clearAllMocks() keeps implementations, so a test that makes an fs call
        // throw would leak into whichever test runs next.  Restore benign defaults
        // here so the file passes under --sequence.shuffle too.
        mockedRenameSync.mockImplementation(() => undefined);
        mockedSymlinkSync.mockImplementation(() => undefined);
        mockedRmSync.mockImplementation(() => undefined);
        mockedUnlinkSync.mockImplementation(() => undefined);
        mockedLstatSync.mockImplementation(() => dirStats());
        mockedRealpathSync.mockImplementation((path) => String(path));
        stubOwnerLiveness();
    });
    afterEach(() => {
        vi.restoreAllMocks();
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
                'my-plugin@my-marketplace': [
                    {
                        installPath: activeVersion,
                        version: '2.0.0',
                    },
                ],
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
            if (ps === activeVersion)
                return [fileDirent('README.md')];
            return [];
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
        expect(mockedRmSync).not.toHaveBeenCalledWith(staleVersion, {
            recursive: true,
            force: true,
        });
        expect(mockedSymlinkSync).toHaveBeenCalledWith(activeVersion, staleVersion, 'dir');
        // Active version should NOT be removed
        expect(mockedRmSync).not.toHaveBeenCalledWith(activeVersion, expect.anything());
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
                'plugin@omc': [
                    {
                        // installPath has trailing slash
                        installPath: versionDir + '/',
                    },
                ],
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
                'plugin@omc': [
                    {
                        // installPath points into a subdirectory
                        installPath: versionDir + '/dist',
                    },
                ],
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
    function setupFreshNonActiveCache() {
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
    /**
     * Cache where a previous relink died after moving 4.15.6 aside.
     * `occupant` describes what now sits at the original version path:
     *   'missing'  — nothing (the plain interrupted case)
     *   'squatter' — an empty dir holding only .DS_Store (a lost race)
     *   'redirect' — the symlink, i.e. the relink actually completed
     *   'payload'  — a real reinstalled version directory
     */
    function setupInterruptedRelink(occupant) {
        const cacheDir = '/mock/.claude/plugins/cache';
        const activeVersion = join(cacheDir, 'omc/oh-my-claudecode/4.15.10');
        const originalDir = join(cacheDir, 'omc/oh-my-claudecode/4.15.6');
        const asideDir = `${originalDir}.omc-stale-${DEAD_OWNER_PID}`;
        const originalExists = occupant !== 'missing';
        mockedLstatSync.mockImplementation((p) => {
            if (String(p) === originalDir) {
                if (occupant === 'missing')
                    throw fsError('ENOENT');
                return occupant === 'redirect' ? symlinkStats() : dirStats();
            }
            return dirStats();
        });
        mockedExistsSync.mockImplementation((p) => {
            const ps = String(p);
            if (ps.includes('installed_plugins.json'))
                return true;
            if (ps === cacheDir)
                return true;
            if (ps === activeVersion || ps === asideDir)
                return true;
            if (ps === originalDir)
                return originalExists;
            // Plugin-root markers: only a real payload directory carries them.  The
            // squatter cases deliberately do not, which is the whole point of the
            // marker check replacing the old "any non-dotfile" heuristic.
            if (ps.startsWith(`${activeVersion}/`) || ps.startsWith(`${asideDir}/`))
                return true;
            // Marker probes under the version path.  existsSync follows symlinks, so a
            // completed redirect resolves to the active version and shows its markers;
            // a squatter or a dangling link shows nothing.
            if (ps.startsWith(`${originalDir}/`))
                return occupant === 'payload' || occupant === 'redirect';
            return false;
        });
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: activeVersion, version: '4.15.10' }],
            },
        }));
        mockedReaddirSync.mockImplementation((p, opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            if (ps.endsWith('oh-my-claudecode')) {
                const entries = [dirent(`4.15.6.omc-stale-${DEAD_OWNER_PID}`), dirent('4.15.10')];
                if (originalExists)
                    entries.unshift(dirent('4.15.6'));
                return entries;
            }
            // isUsableVersionPath reads the occupant's entries (no withFileTypes)
            if (ps === originalDir && !opts?.withFileTypes) {
                return (occupant === 'payload' ? ['scripts', 'package.json'] : ['.DS_Store']);
            }
            return [];
        });
        return { activeVersion, originalDir, asideDir };
    }
    it('clears a dangling redirect symlink and restores the backup over it', () => {
        // lstat reports a symlink but the target is gone, so the path is unusable.
        // On a real filesystem renaming a directory over a symlink raises ENOTDIR
        // (verified on APFS), and existsSync-based removal cannot clear a dangling
        // link — both are modelled here; the integration test proves the real thing.
        const { originalDir, asideDir } = setupInterruptedRelink('redirect');
        mockedExistsSync.mockImplementation((p) => {
            const ps = String(p);
            // Dangling: existsSync follows the link, so neither the path itself nor any
            // marker probe through it resolves.
            if (ps === originalDir || ps.startsWith(`${originalDir}/`))
                return false;
            if (ps.includes('installed_plugins.json'))
                return true;
            return ps.includes('cache');
        });
        let danglingPresent = true;
        mockedUnlinkSync.mockImplementation(((p) => {
            if (String(p) === originalDir)
                danglingPresent = false;
            return undefined;
        }));
        mockedRenameSync.mockImplementation(((_from, to) => {
            if (String(to) === originalDir && danglingPresent)
                throw fsError('ENOTDIR');
            return undefined;
        }));
        const result = purgeStalePluginCacheVersions();
        // The link is unlinked (not rmSync'd — existsSync cannot see it) and the
        // rename then succeeds on the retry.
        expect(mockedUnlinkSync).toHaveBeenCalledWith(originalDir);
        expect(result.restored).toBe(1);
        expect(mockedRenameSync).toHaveBeenCalledWith(asideDir, originalDir);
    });
    it('discards the aside copy when the redirect symlink is already in place', () => {
        const { originalDir, asideDir } = setupInterruptedRelink('redirect');
        const result = purgeStalePluginCacheVersions();
        expect(result.restored).toBe(0);
        expect(mockedRmSync).toHaveBeenCalledWith(asideDir, {
            recursive: true,
            force: true,
        });
        expect(mockedRenameSync).not.toHaveBeenCalledWith(asideDir, originalDir);
    });
    it('discards the aside copy when the version was reinstalled with payload', () => {
        const { originalDir, asideDir } = setupInterruptedRelink('payload');
        const result = purgeStalePluginCacheVersions();
        expect(result.restored).toBe(0);
        expect(mockedRmSync).toHaveBeenCalledWith(asideDir, {
            recursive: true,
            force: true,
        });
        expect(mockedRenameSync).not.toHaveBeenCalledWith(asideDir, originalDir);
    });
    it('never treats an aside dir as a plugin version when picking a symlink target', () => {
        // compareSemverDesc must not see the aside suffix as a version candidate.
        const { activeVersion } = setupInterruptedRelink('redirect');
        purgeStalePluginCacheVersions();
        for (const call of mockedSymlinkSync.mock.calls) {
            expect(String(call[0])).toBe(activeVersion);
            expect(String(call[1])).not.toContain('.omc-stale-');
        }
        expect(mockedRenameSync).not.toHaveBeenCalledWith(expect.stringContaining(`.omc-stale-${DEAD_OWNER_PID}`), activeVersion);
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
        expect(result.removed).toBe(1);
        expect(result.symlinked).toBe(0);
        expect(result.removedPaths).toEqual([staleVersion]);
        expect(mockedRmSync).toHaveBeenCalledWith(staleVersion, {
            recursive: true,
            force: true,
        });
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
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            if (ps.endsWith('oh-my-claudecode')) {
                // 4.14.4 is a symlink (isDirectory returns false), 4.14.5 is a real dir
                return [{ name: '4.14.4', isDirectory: () => false }, dirent('4.14.5')];
            }
            return [];
        });
        const result = purgeStalePluginCacheVersions();
        // The symlink entry must not be touched
        expect(result.removed).toBe(0);
        expect(result.symlinked).toBe(0);
        expect(mockedRmSync).not.toHaveBeenCalled();
        expect(mockedSymlinkSync).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=purge-stale-cache.test.js.map