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
        renameSync: vi.fn(),
        symlinkSync: vi.fn(),
    };
});
vi.mock('../utils/config-dir.js', () => ({
    getClaudeConfigDir: vi.fn(() => '/mock/.claude'),
}));
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync, rmSync, renameSync, symlinkSync, } from 'fs';
import { purgeStalePluginCacheVersions } from '../utils/paths.js';
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedStatSync = vi.mocked(statSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedRenameSync = vi.mocked(renameSync);
const mockedLstatSync = vi.mocked(lstatSync);
const mockedRealpathSync = vi.mocked(realpathSync);
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
/** Return a stat result with mtime N ms ago.
 * Default must exceed STALE_THRESHOLD_MS (24 h) in src/utils/paths.ts. */
function staleStats(ageMs = 25 * 60 * 60 * 1000) {
    return { mtimeMs: Date.now() - ageMs, isDirectory: () => true };
}
describe('purgeStalePluginCacheVersions relink and recovery', () => {
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
        mockedLstatSync.mockImplementation(() => dirStats());
        mockedRealpathSync.mockImplementation((path) => String(path));
        stubOwnerLiveness();
    });
    afterEach(() => {
        vi.restoreAllMocks();
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
            if (ps === staleVersion || ps === activeVersion || ps.startsWith(activeVersion + '/'))
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
            .mockImplementationOnce(() => {
            throw fsError('EEXIST');
        })
            .mockImplementationOnce(() => undefined);
        const result = purgeStalePluginCacheVersions();
        expect(result.symlinked).toBe(1);
        expect(result.errors).toEqual([]);
        expect(mockedSymlinkSync).toHaveBeenCalledTimes(2);
        // The squatter is cleared before the retry
        expect(mockedRmSync).toHaveBeenCalledWith(staleVersion, {
            recursive: true,
            force: true,
        });
        expect(mockedSymlinkSync).toHaveBeenLastCalledWith(activeVersion, staleVersion, 'dir');
    });
    it('restores the stale dir when the symlink can never be placed', () => {
        // Worst case: every attempt loses the race.  The original directory must be
        // moved back so a session pinned to it via CLAUDE_PLUGIN_ROOT keeps working.
        const { staleVersion } = setupRelinkScenario();
        mockedSymlinkSync.mockImplementation(() => {
            throw fsError('EEXIST');
        });
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
        mockedSymlinkSync.mockImplementation(() => {
            throw fsError('EEXIST');
        });
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
        const restores = mockedRenameSync.mock.calls.filter((c) => String(c[1]) === staleVersion);
        expect(String(restores[restores.length - 1][0])).toContain(`${staleVersion}.omc-stale-`);
        // The reported error is the symlink failure, not a lost original
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).not.toContain('could not restore');
    });
    it('reports the original as stranded when neither symlink nor restore can be placed', () => {
        // Worst case: the squatter wins every attempt on both halves.  The error must
        // say where the original went instead of silently reporting a symlink failure.
        const { staleVersion } = setupRelinkScenario();
        mockedSymlinkSync.mockImplementation(() => {
            throw fsError('EEXIST');
        });
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
        mockedSymlinkSync.mockImplementation(() => {
            throw fsError('EPERM');
        });
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
        expect(mockedRmSync).toHaveBeenCalledWith(originalDir, {
            recursive: true,
            force: true,
        });
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
});
//# sourceMappingURL=purge-stale-cache-relink.test.js.map