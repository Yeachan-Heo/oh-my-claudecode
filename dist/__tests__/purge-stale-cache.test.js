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
        rmSync: vi.fn(),
        unlinkSync: vi.fn(),
        renameSync: vi.fn(),
        symlinkSync: vi.fn(),
    };
});
vi.mock('../utils/config-dir.js', () => ({
    getClaudeConfigDir: vi.fn(() => '/mock/.claude'),
}));
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, rmSync, renameSync, symlinkSync, unlinkSync } from 'fs';
import { purgeStalePluginCacheVersions } from '../utils/paths.js';
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedStatSync = vi.mocked(statSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedRenameSync = vi.mocked(renameSync);
const mockedLstatSync = vi.mocked(lstatSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedSymlinkSync = vi.mocked(symlinkSync);
/** lstat result for a real directory. */
function dirStats() {
    return { isSymbolicLink: () => false, isDirectory: () => true };
}
/** lstat result for a redirect symlink. */
function symlinkStats() {
    return { isSymbolicLink: () => true, isDirectory: () => false };
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
        // clearAllMocks() keeps implementations, so a test that makes an fs call
        // throw would leak into whichever test runs next.  Restore benign defaults
        // here so the file passes under --sequence.shuffle too.
        mockedRenameSync.mockImplementation(() => undefined);
        mockedSymlinkSync.mockImplementation(() => undefined);
        mockedRmSync.mockImplementation(() => undefined);
        mockedUnlinkSync.mockImplementation(() => undefined);
        mockedLstatSync.mockImplementation(() => dirStats());
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
    // --- #2543 regression: symlink-instead-of-delete ---
    it('replaces stale version dir with symlink to active version in same namespace', () => {
        // Scenario: CLAUDE_PLUGIN_ROOT=4.14.4 in a running session; 4.14.5 installed;
        // purge runs after grace period.  4.14.4 must become a symlink, not disappear.
        const cacheDir = '/mock/.claude/plugins/cache';
        const activeVersion = join(cacheDir, 'omc/oh-my-claudecode/4.14.5');
        const staleVersion = join(cacheDir, 'omc/oh-my-claudecode/4.14.4');
        mockedExistsSync.mockImplementation((p) => {
            const ps = String(p);
            if (ps.includes('installed_plugins.json'))
                return true;
            if (ps === cacheDir)
                return true;
            if (ps === staleVersion || ps === activeVersion)
                return true;
            return false;
        });
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: activeVersion, version: '4.14.5' }],
            },
        }));
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            if (ps.endsWith('oh-my-claudecode'))
                return [dirent('4.14.4'), dirent('4.14.5')];
            return [];
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
            if (ps.includes('installed_plugins.json'))
                return true;
            if (ps === cacheDir)
                return true;
            if (ps === staleVersion || ps === activeVersion)
                return true;
            // isUsableVersionPath probes plugin-root markers; both real versions have them
            if (ps.startsWith(`${staleVersion}/`) || ps.startsWith(`${activeVersion}/`))
                return true;
            // A fresh relink starts with no aside path — if one appeared to exist and
            // to carry markers, relinkStaleVersionDir would refuse to overwrite it.
            return false;
        });
        // …and lstat must agree, or isUsableVersionPath would treat it as a directory
        mockedLstatSync.mockImplementation((p) => {
            if (String(p).includes('.omc-stale-'))
                throw fsError('ENOENT');
            return dirStats();
        });
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            version: 2,
            plugins: {
                'oh-my-claudecode@omc': [{ installPath: activeVersion, version: '4.15.10' }],
            },
        }));
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            if (ps.endsWith('oh-my-claudecode'))
                return [dirent('4.15.6'), dirent('4.15.10')];
            return [];
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
    it('retries the rollback when the squatter also blocks the restore', () => {
        // The race that produced EEXIST on the symlink can re-take the path between
        // the final clear and the restore rename.  If the rollback is not retried the
        // original is stranded at the aside path while the squatter holds the pinned
        // path — the failure this helper exists to prevent.
        const { staleVersion } = setupRelinkScenario();
        mockedSymlinkSync.mockImplementation(() => { throw fsError('EEXIST'); });
        let restoreAttempts = 0;
        mockedRenameSync.mockImplementation(((from, to) => {
            if (String(to) === staleVersion) {
                restoreAttempts++;
                if (restoreAttempts === 1)
                    throw fsError('ENOTEMPTY');
            }
            return undefined;
        }));
        const result = purgeStalePluginCacheVersions();
        expect(restoreAttempts).toBeGreaterThan(1);
        // Restore eventually succeeded, so the original is back at the pinned path
        const restores = mockedRenameSync.mock.calls.filter(c => String(c[1]) === staleVersion);
        expect(String(restores[restores.length - 1][0])).toContain(`${staleVersion}.omc-stale-`);
        // The reported error is the symlink failure, not a lost original
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).not.toContain('could not restore');
    });
    it('reports the original as stranded when neither symlink nor restore can be placed', () => {
        // Worst case: the squatter wins every attempt on both halves.  The error must
        // say where the original went instead of silently reporting a symlink failure.
        const { staleVersion } = setupRelinkScenario();
        mockedSymlinkSync.mockImplementation(() => { throw fsError('EEXIST'); });
        mockedRenameSync.mockImplementation(((_from, to) => {
            if (String(to) === staleVersion)
                throw fsError('ENOTEMPTY');
            return undefined;
        }));
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('could not restore the original');
        expect(result.errors[0]).toContain('.omc-stale-');
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
    // --- regression: an interrupted relink is repaired, not mistaken for a version ---
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
    it('restores the version path from an aside dir left by an interrupted relink', () => {
        // The pinned path is gone and its aside copy survived — move it back so
        // CLAUDE_PLUGIN_ROOT resolves again.
        const { originalDir, asideDir } = setupInterruptedRelink('missing');
        const result = purgeStalePluginCacheVersions();
        expect(result.restored).toBe(1);
        expect(result.restoredPaths).toEqual([originalDir]);
        expect(mockedRenameSync).toHaveBeenCalledWith(asideDir, originalDir);
        // The aside dir must never be demoted or deleted as if it were a version
        expect(mockedSymlinkSync).not.toHaveBeenCalledWith(expect.anything(), asideDir, expect.anything());
        expect(mockedRmSync).not.toHaveBeenCalledWith(asideDir, expect.anything());
    });
    it('keeps the aside copy when the version path holds only a squatter', () => {
        // A dir containing nothing but .DS_Store is the squatter that caused the
        // EEXIST, not a completed redirect.  Deleting the aside here would throw
        // away the only intact copy and leave pinned sessions broken.
        const { originalDir, asideDir } = setupInterruptedRelink('squatter');
        const result = purgeStalePluginCacheVersions();
        expect(result.restored).toBe(1);
        expect(result.restoredPaths).toEqual([originalDir]);
        expect(mockedRenameSync).toHaveBeenCalledWith(asideDir, originalDir);
        expect(mockedRmSync).not.toHaveBeenCalledWith(asideDir, expect.anything());
    });
    it('clears the squatter and retries when it blocks the restore rename', () => {
        const { originalDir, asideDir } = setupInterruptedRelink('squatter');
        let attempts = 0;
        mockedRenameSync.mockImplementation(((_from, to) => {
            if (String(to) === originalDir) {
                attempts++;
                if (attempts === 1)
                    throw fsError('ENOTEMPTY');
            }
            return undefined;
        }));
        const result = purgeStalePluginCacheVersions();
        expect(attempts).toBe(2);
        expect(mockedRmSync).toHaveBeenCalledWith(originalDir, { recursive: true, force: true });
        expect(result.restored).toBe(1);
        expect(mockedRenameSync).toHaveBeenCalledWith(asideDir, originalDir);
        // The restored version is then demoted normally, which is the intended
        // follow-up: it is stale and an active sibling exists.
        expect(result.symlinked).toBe(1);
    });
    it('leaves an aside dir alone while its owning purge is still running', () => {
        // A live owner means the swap is in flight.  Restoring its backup here would
        // make the owner's own EEXIST retry delete the real directory.
        // The fixture's owner pid is the dead one, so force this case to look live.
        const { originalDir, asideDir } = setupInterruptedRelink('missing');
        const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true));
        const result = purgeStalePluginCacheVersions();
        expect(result.restored).toBe(0);
        expect(result.errors).toEqual([]);
        expect(mockedRenameSync).not.toHaveBeenCalledWith(asideDir, originalDir);
        expect(mockedRmSync).not.toHaveBeenCalledWith(asideDir, expect.anything());
        // Skipping must be visible: if that pid was recycled, nothing else would
        // ever reclaim the backup and the pinned path would stay broken silently.
        expect(result.skipped).toBe(1);
        expect(result.skippedPaths[0]).toContain(asideDir);
        expect(result.skippedPaths[0]).toContain('still running');
        killSpy.mockRestore();
    });
    it('reconciles aside entries before relinking a squatter that shares their name', () => {
        // Filesystem order can put the squatter first.  Relinking it first would
        // clear the aside backup before anyone knows the symlink can be placed.
        const cacheDir = '/mock/.claude/plugins/cache';
        const activeVersion = join(cacheDir, 'omc/oh-my-claudecode/4.15.10');
        const originalDir = join(cacheDir, 'omc/oh-my-claudecode/4.15.6');
        const asideDir = `${originalDir}.omc-stale-${DEAD_OWNER_PID}`;
        mockedLstatSync.mockImplementation((p) => (String(p) === originalDir ? dirStats() : dirStats()));
        mockedExistsSync.mockImplementation((p) => {
            const ps = String(p);
            if (ps.includes('installed_plugins.json'))
                return true;
            return ps === cacheDir || ps === originalDir || ps === activeVersion || ps === asideDir;
        });
        mockedReadFileSync.mockReturnValue(JSON.stringify({
            version: 2,
            plugins: { 'oh-my-claudecode@omc': [{ installPath: activeVersion, version: '4.15.10' }] },
        }));
        mockedReaddirSync.mockImplementation((p, opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            // squatter listed FIRST, aside second — the order that used to lose data
            if (ps.endsWith('oh-my-claudecode')) {
                return [dirent('4.15.6'), dirent(`4.15.6.omc-stale-${DEAD_OWNER_PID}`), dirent('4.15.10')];
            }
            if (ps === originalDir && !opts?.withFileTypes)
                return ['.DS_Store'];
            return [];
        });
        const order = [];
        mockedRenameSync.mockImplementation(((from, to) => {
            order.push(`rename ${String(from).split('/').pop()} -> ${String(to).split('/').pop()}`);
            return undefined;
        }));
        mockedSymlinkSync.mockImplementation(((_t, at) => {
            order.push(`symlink at ${String(at).split('/').pop()}`);
            return undefined;
        }));
        const result = purgeStalePluginCacheVersions();
        // The backup is restored before the squatter is ever relinked
        expect(order[0]).toBe(`rename 4.15.6.omc-stale-${DEAD_OWNER_PID} -> 4.15.6`);
        expect(result.restored).toBe(1);
        // And the aside copy is never discarded
        expect(mockedRmSync).not.toHaveBeenCalledWith(asideDir, expect.anything());
    });
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
        expect(mockedRmSync).toHaveBeenCalledWith(asideDir, { recursive: true, force: true });
        expect(mockedRenameSync).not.toHaveBeenCalledWith(asideDir, originalDir);
    });
    it('discards the aside copy when the version was reinstalled with payload', () => {
        const { originalDir, asideDir } = setupInterruptedRelink('payload');
        const result = purgeStalePluginCacheVersions();
        expect(result.restored).toBe(0);
        expect(mockedRmSync).toHaveBeenCalledWith(asideDir, { recursive: true, force: true });
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
        mockedReaddirSync.mockImplementation((p, _opts) => {
            const ps = String(p);
            if (ps === cacheDir)
                return [dirent('omc')];
            if (ps.endsWith('omc'))
                return [dirent('oh-my-claudecode')];
            if (ps.endsWith('oh-my-claudecode')) {
                // 4.14.4 is a symlink (isDirectory returns false), 4.14.5 is a real dir
                return [
                    { name: '4.14.4', isDirectory: () => false },
                    dirent('4.14.5'),
                ];
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