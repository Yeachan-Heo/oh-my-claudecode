/**
 * purgeStalePluginCacheVersions against a real filesystem.
 *
 * The unit suite mocks `fs` wholesale, so it verifies the control flow but not
 * the syscall semantics the flow is built on. This file makes no mocks beyond
 * the config-dir lookup: every directory, symlink and rename below is real, so
 * a wrong assumption about `rename(2)` or `symlink(2)` fails here instead of
 * surviving as a green unit test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, rmSync,
  existsSync, lstatSync, readdirSync, readlinkSync, utimesSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let configDir: string;
vi.mock('../utils/config-dir.js', () => ({
  getClaudeConfigDir: vi.fn(() => configDir),
}));

const { purgeStalePluginCacheVersions } = await import('../utils/paths.js');

const PLUGIN = 'omc/oh-my-claudecode';
const STALE = '4.15.6';
const ACTIVE = '4.15.10';
/** Older versions OMC leaves behind as symlinks pointing at the demoted one. */
const LEGACY = ['4.13.5', '4.14.0'];

let pluginDir: string;

/** Age a path past STALE_THRESHOLD_MS (24 h) so the grace period lets it go. */
function makeStale(path: string) {
  const old = new Date(Date.now() - 26 * 60 * 60 * 1000);
  utimesSync(path, old, old);
}

/** A complete plugin root — everything `isPluginRoot()` in scripts/run.cjs wants. */
function writeVersion(version: string) {
  const dir = join(pluginDir, version);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'run.cjs'), `// ${version}\n`);
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), '{}\n');
  return dir;
}

function installedPlugins() {
  writeFileSync(
    join(configDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'oh-my-claudecode@omc': [{ installPath: join(pluginDir, ACTIVE), version: ACTIVE }] },
    }),
  );
}

/**
 * A hook resolves through `version` only when the path satisfies the runner's own
 * check — `isPluginRoot()` in scripts/run.cjs, reproduced here so the assertions
 * mean "a pinned session still works", not "some file exists".
 */
function hookResolves(version: string): boolean {
  const root = join(pluginDir, version);
  return existsSync(join(root, 'hooks', 'hooks.json'))
    && existsSync(join(root, 'scripts', 'run.cjs'))
    && existsSync(join(root, 'scripts'));
}

/**
 * Make process liveness deterministic: this process is alive, every other pid is
 * gone.  The fixtures bake a pid into the aside directory name, and whether that
 * pid happens to exist on the host is not ours to assume — worse, a pid owned by
 * another user reports EPERM, which counts as alive, so a low pid on a CI runner
 * would silently turn the interrupted-relink cases into in-flight ones.
 */
function stubOwnerLiveness() {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (pid === process.pid) return true;
    const err = new Error('ESRCH') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  }) as unknown as typeof process.kill);
}

beforeEach(() => {
  stubOwnerLiveness();
  configDir = mkdtempSync(join(tmpdir(), 'omc-purge-real-'));
  pluginDir = join(configDir, 'plugins', 'cache', PLUGIN);
  mkdirSync(pluginDir, { recursive: true });
  writeVersion(ACTIVE);
  installedPlugins();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
});

describe('purgeStalePluginCacheVersions on a real filesystem', () => {
  it('demotes a stale version to a redirect and keeps every pinned path resolving', () => {
    const stale = writeVersion(STALE);
    for (const v of LEGACY) symlinkSync(stale, join(pluginDir, v), 'dir');
    makeStale(stale);

    const result = purgeStalePluginCacheVersions();

    expect(result.symlinked).toBe(1);
    expect(result.errors).toEqual([]);
    expect(lstatSync(join(pluginDir, STALE)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, STALE))).toBe(join(pluginDir, ACTIVE));
    // The pinned path and everything chaining through it still resolve
    for (const v of [STALE, ...LEGACY]) expect(hookResolves(v)).toBe(true);
    // No aside directory survives a clean run
    expect(readdirSync(pluginDir).filter(n => n.includes('.omc-stale-'))).toEqual([]);
  });

  it('restores the backup when only a squatter holds the pinned path', () => {
    // Exactly the damage observed in the wild: the real version was moved aside
    // and something re-created the path with nothing but a .DS_Store.
    const stale = writeVersion(STALE);
    const aside = `${stale}.omc-stale-999999`;
    renameSync(stale, aside);
    mkdirSync(stale);
    writeFileSync(join(stale, '.DS_Store'), 'x');
    makeStale(aside);

    const result = purgeStalePluginCacheVersions();

    expect(result.restored).toBe(1);
    expect(result.errors).toEqual([]);
    expect(existsSync(aside)).toBe(false);
    // The intact payload is back — the squatter did not win
    expect(hookResolves(STALE)).toBe(true);
  });

  it('clears a dangling redirect and restores the backup over it', () => {
    // rename(dir -> symlink) raises ENOTDIR on POSIX, and existsSync cannot see
    // a dangling link, so this only works if the occupant is unlinked by lstat.
    const stale = writeVersion(STALE);
    const aside = `${stale}.omc-stale-999998`;
    renameSync(stale, aside);
    symlinkSync(join(pluginDir, 'gone-away'), stale, 'dir');
    expect(existsSync(stale)).toBe(false);            // follows the broken link
    expect(lstatSync(stale).isSymbolicLink()).toBe(true);

    const result = purgeStalePluginCacheVersions();

    expect(result.restored).toBe(1);
    expect(result.errors).toEqual([]);
    expect(lstatSync(stale).isDirectory()).toBe(true);
    expect(hookResolves(STALE)).toBe(true);
  });

  it('keeps the backup when the recreated path holds junk that is not payload', () => {
    // The old "any non-dotfile entry" heuristic accepted these as a usable
    // version, discarded the backup, and left pinned sessions resolving into a
    // directory the hook runner cannot load.  Windows sprinkles desktop.ini and
    // Thumbs.db; an interrupted extraction leaves a partial scripts/.
    // The last three are partial roots: each satisfies one of the runner's
    // requirements and none satisfies all of them, so none can run hooks.
    const junkShapes: string[][] = [
      ['desktop.ini'],
      ['Thumbs.db'],
      ['scripts', 'partial.txt'],
      ['hooks', 'hooks.json'],
      ['.claude-plugin', 'plugin.json'],
      ['scripts', 'run.cjs'],
    ];
    for (const junk of junkShapes) {
      rmSync(pluginDir, { recursive: true, force: true });
      mkdirSync(pluginDir, { recursive: true });
      writeVersion(ACTIVE);
      installedPlugins();

      const stale = writeVersion(STALE);
      const aside = `${stale}.omc-stale-999996`;
      renameSync(stale, aside);
      mkdirSync(join(stale, ...junk.slice(0, -1)), { recursive: true });
      writeFileSync(join(stale, ...junk), 'x');
      makeStale(aside);

      const result = purgeStalePluginCacheVersions();

      expect(result.restored, junk.join('/')).toBe(1);
      expect(hookResolves(STALE), junk.join('/')).toBe(true);
      expect(existsSync(aside), junk.join('/')).toBe(false);
    }
  });

  it('discards the backup when the path carries real plugin payload', () => {
    // The counter-case: a genuine reinstall must win over an older backup.
    const stale = writeVersion(STALE);
    const aside = `${stale}.omc-stale-999995`;
    renameSync(stale, aside);
    writeVersion(STALE);                       // reinstalled, has scripts/run.cjs
    mkdirSync(join(pluginDir, STALE, 'hooks'), { recursive: true });
    writeFileSync(join(pluginDir, STALE, 'hooks', 'hooks.json'), '{}');
    makeStale(aside);

    const result = purgeStalePluginCacheVersions();

    expect(result.restored).toBe(0);
    expect(existsSync(aside)).toBe(false);
    expect(hookResolves(STALE)).toBe(true);
  });

  it('leaves a backup alone while its owning purge is still running', () => {
    const stale = writeVersion(STALE);
    const aside = `${stale}.omc-stale-${process.pid}`;   // this process is alive
    renameSync(stale, aside);
    makeStale(aside);

    const result = purgeStalePluginCacheVersions();

    expect(result.restored).toBe(0);
    expect(result.errors).toEqual([]);
    expect(existsSync(join(aside, 'scripts', 'run.cjs'))).toBe(true);
  });

  it('reconciles the backup before relinking a squatter of the same name', () => {
    // Both entries present. Whichever order readdir returns them in, the backup
    // must be restored before the squatter can be demoted.
    const stale = writeVersion(STALE);
    const aside = `${stale}.omc-stale-999997`;
    renameSync(stale, aside);
    mkdirSync(stale);
    writeFileSync(join(stale, '.DS_Store'), 'x');
    makeStale(aside);
    makeStale(stale);

    const result = purgeStalePluginCacheVersions();

    expect(result.restored).toBe(1);
    expect(result.errors).toEqual([]);
    // Restored, then demoted normally — either way the payload is reachable
    expect(hookResolves(STALE)).toBe(true);
    expect(existsSync(aside)).toBe(false);
  });

  it('never destroys the namespace for an aside entry with no version prefix', () => {
    // A bare `.omc-stale-<pid>` has an empty prefix, so the "original" path is the
    // plugin namespace itself.  Renaming the entry over its own parent reports
    // ENOTEMPTY, which the placement helper would read as an occupied path and
    // clear recursively — taking the active version and every sibling with it.
    const stale = writeVersion(STALE);
    makeStale(stale);
    const orphan = join(pluginDir, '.omc-stale-999994');
    mkdirSync(join(orphan, 'scripts'), { recursive: true });
    writeFileSync(join(orphan, 'scripts', 'run.cjs'), '//\n');
    makeStale(orphan);

    const result = purgeStalePluginCacheVersions();

    // The namespace and the active version survive — this is the whole assertion
    expect(existsSync(pluginDir)).toBe(true);
    expect(hookResolves(ACTIVE)).toBe(true);
    expect(readdirSync(pluginDir)).toContain(ACTIVE);
    // The unattributable entry is left alone rather than acted on
    expect(existsSync(orphan)).toBe(true);
    expect(result.restored).toBe(0);
  });

  it('keeps the backup when the path redirects to a directory that is not a plugin root', () => {
    // existsSync only proves the link resolves.  The runner validates the
    // resolved root, so a redirect into some unrelated directory cannot run
    // hooks and must not count as a reason to discard the backup.
    const elsewhere = join(configDir, 'not-a-plugin');
    mkdirSync(join(elsewhere, 'random'), { recursive: true });

    const stale = writeVersion(STALE);
    const aside = `${stale}.omc-stale-999993`;
    renameSync(stale, aside);
    symlinkSync(elsewhere, stale, 'dir');
    expect(existsSync(stale)).toBe(true);       // the link resolves…
    expect(hookResolves(STALE)).toBe(false);    // …but it is not a root
    makeStale(aside);

    const result = purgeStalePluginCacheVersions();

    expect(result.restored).toBe(1);
    expect(hookResolves(STALE)).toBe(true);
    expect(existsSync(aside)).toBe(false);
  });

  it('discards the backup when the path redirects to a real plugin root', () => {
    // The counter-case: a completed redirect is usable and the backup is litter.
    const stale = writeVersion(STALE);
    const aside = `${stale}.omc-stale-999992`;
    renameSync(stale, aside);
    symlinkSync(join(pluginDir, ACTIVE), stale, 'dir');
    makeStale(aside);

    const result = purgeStalePluginCacheVersions();

    expect(result.restored).toBe(0);
    expect(existsSync(aside)).toBe(false);
    expect(hookResolves(STALE)).toBe(true);     // resolves through the redirect
  });

  it('deletes a stale version outright when no active sibling exists', () => {
    const orphanPlugin = join(configDir, 'plugins', 'cache', 'omc', 'other-plugin');
    const orphan = join(orphanPlugin, '1.0.0');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'marker'), 'x');
    makeStale(orphan);

    const result = purgeStalePluginCacheVersions();

    expect(result.removedPaths).toContain(orphan);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe('invariant across every cache shape', () => {
  // Enumerating the state space rather than picking cases by hand: this is what
  // surfaced the dangling-symlink ENOTDIR path and the unreported live-owner
  // skip.  Invariant — if payload existed anywhere before the purge, then after
  // it either the pinned path resolves, or an intact backup survives AND the
  // result says so (as an error, or as a backup left to its running owner).
  const OCCUPANTS = ['missing', 'empty-dir', 'dotfile-only', 'junk-only', 'partial-scripts', 'payload', 'live-symlink', 'dangling-link', 'file'] as const;
  const BACKUPS = ['none', 'payload-dead', 'payload-live', 'empty-dead', 'dotfile-dead'] as const;
  const DEAD_PID = 999997;

  function shape(occupant: typeof OCCUPANTS[number], backup: typeof BACKUPS[number]) {
    const V = join(pluginDir, STALE);
    if (occupant === 'empty-dir') mkdirSync(V, { recursive: true });
    else if (occupant === 'dotfile-only') { mkdirSync(V, { recursive: true }); writeFileSync(join(V, '.DS_Store'), 'x'); }
    else if (occupant === 'junk-only') { mkdirSync(V, { recursive: true }); writeFileSync(join(V, 'desktop.ini'), 'x'); }
    else if (occupant === 'partial-scripts') { mkdirSync(join(V, 'scripts'), { recursive: true }); writeFileSync(join(V, 'scripts', 'partial.txt'), 'x'); }
    else if (occupant === 'payload') writeVersion(STALE);
    else if (occupant === 'live-symlink') symlinkSync(join(pluginDir, ACTIVE), V, 'dir');
    else if (occupant === 'dangling-link') symlinkSync(join(pluginDir, 'gone-away'), V, 'dir');
    else if (occupant === 'file') writeFileSync(V, 'not a directory');

    let aside: string | null = null;
    if (backup !== 'none') {
      aside = `${V}.omc-stale-${backup.endsWith('live') ? process.pid : DEAD_PID}`;
      if (backup.startsWith('payload')) {
        // A backup this purge created came from a live version, so it is a
        // complete root — the same shape writeVersion() produces.
        mkdirSync(join(aside, 'scripts'), { recursive: true });
        writeFileSync(join(aside, 'scripts', 'run.cjs'), '//\n');
        mkdirSync(join(aside, 'hooks'), { recursive: true });
        writeFileSync(join(aside, 'hooks', 'hooks.json'), '{}\n');
      }
      else if (backup.startsWith('empty')) mkdirSync(aside, { recursive: true });
      else { mkdirSync(aside, { recursive: true }); writeFileSync(join(aside, '.DS_Store'), 'x'); }
    }
    for (const p of [V, aside].filter(Boolean) as string[]) {
      try { makeStale(p); } catch { /* symlinks and plain files cannot be aged */ }
    }
    return { V, aside };
  }

  /** A backup only counts as intact if it is a root the runner would load. */
  const loadableRoot = (dir: string) =>
    existsSync(join(dir, 'hooks', 'hooks.json'))
    && existsSync(join(dir, 'scripts', 'run.cjs'))
    && existsSync(join(dir, 'scripts'));

  const intactBackupSurvives = () =>
    readdirSync(pluginDir).filter(n => n.includes('.omc-stale-'))
      .some(n => loadableRoot(join(pluginDir, n)));

  it('never ends with a broken pinned path and nothing to show for it', () => {
    const violations: string[] = [];
    for (const occupant of OCCUPANTS) {
      for (const backup of BACKUPS) {
        // Each combination needs a clean cache; rebuild the fixture in place.
        rmSync(pluginDir, { recursive: true, force: true });
        mkdirSync(pluginDir, { recursive: true });
        writeVersion(ACTIVE);
        installedPlugins();

        const { V, aside } = shape(occupant, backup);
        // The invariant only binds when a loadable root existed to begin with:
        // a shape that never had one cannot be expected to resolve afterwards.
        const hadPayload = loadableRoot(V) || (!!aside && loadableRoot(aside));

        let result: ReturnType<typeof purgeStalePluginCacheVersions> | undefined;
        let threw: unknown = null;
        try { result = purgeStalePluginCacheVersions(); } catch (err) { threw = err; }

        const accounted = (result?.errors.length ?? 0) > 0 || (result?.skipped ?? 0) > 0;
        const held = threw === null
          && (!hadPayload || hookResolves(STALE) || (intactBackupSurvives() && accounted));
        if (!held) {
          violations.push(
            `${occupant} + ${backup}: resolves=${hookResolves(STALE)} ` +
            `backup=${intactBackupSurvives()} errors=${result?.errors.length ?? '-'} ` +
            `skipped=${result?.skipped ?? '-'} threw=${(threw as NodeJS.ErrnoException)?.code ?? '-'}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// POSIX only. Windows reports a rename collision as EPERM/EACCES and needs a
// privilege or developer mode for symlinkSync, so these exact codes are not the
// contract there — OCCUPIED_CODES widens for win32 instead. This file is not in
// the Windows CI allowlist in .github/workflows/ci.yml; the guard keeps it safe
// if it is ever added.
describe.skipIf(process.platform === 'win32')('syscall semantics this implementation relies on', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omc-posix-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const code = (fn: () => void): string => {
    try { fn(); return 'ok'; } catch (err) { return (err as NodeJS.ErrnoException).code ?? 'unknown'; }
  };
  const payloadDir = (name: string) => {
    const p = join(root, name);
    mkdirSync(join(p, 'inner'), { recursive: true });
    return p;
  };

  it('rename over an empty directory succeeds', () => {
    const src = payloadDir('src1');
    mkdirSync(join(root, 'dst1'));
    expect(code(() => renameSync(src, join(root, 'dst1')))).toBe('ok');
  });

  it('rename over a non-empty directory reports ENOTEMPTY', () => {
    const src = payloadDir('src2');
    mkdirSync(join(root, 'dst2'));
    writeFileSync(join(root, 'dst2', '.DS_Store'), 'x');
    expect(code(() => renameSync(src, join(root, 'dst2')))).toBe('ENOTEMPTY');
  });

  it('rename over a symlink reports ENOTDIR, dangling or not', () => {
    const live = payloadDir('live');
    symlinkSync(live, join(root, 'linkLive'), 'dir');
    symlinkSync(join(root, 'nowhere'), join(root, 'linkDead'), 'dir');
    expect(code(() => renameSync(payloadDir('src3'), join(root, 'linkLive')))).toBe('ENOTDIR');
    expect(code(() => renameSync(payloadDir('src4'), join(root, 'linkDead')))).toBe('ENOTDIR');
  });

  it('symlink onto an occupied path reports EEXIST', () => {
    mkdirSync(join(root, 'taken'));
    expect(code(() => symlinkSync(join(root, 'taken'), join(root, 'taken'), 'dir'))).toBe('EEXIST');
  });

  it('existsSync follows a dangling link while lstatSync sees it', () => {
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'), 'dir');
    expect(existsSync(join(root, 'dangling'))).toBe(false);
    expect(lstatSync(join(root, 'dangling')).isSymbolicLink()).toBe(true);
  });
});
