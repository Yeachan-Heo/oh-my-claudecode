import { describe, test, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { read, commands, ageVersions, runCommand, digitVersions, backupDir, movedAside, PLUGIN_ID, addCache, makeCache, volumeFoldsCase, writeCaseFoldPreload, writeRegistryFile, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

describe('omc-doctor cache commands on a synthetic config directory (pins, registry shapes, failed moves)', { timeout: 120_000 }, () => {
  function makeConfigDir(versions: string[], pinned: string | null, installed = true, pluginId = 'oh-my-claudecode@omc') {
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
    const cache = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    for (const v of versions) {
      mkdirSync(path.join(cache, v), { recursive: true });
      writeFileSync(path.join(cache, v, 'package.json'), JSON.stringify({ version: v }));
    }
    if (versions.length) ageVersions(cache);
    if (installed) {
      const entries = [{ scope: 'user', version: pinned ?? '0.0.0' }];
      writeFileSync(
        path.join(dir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { [pluginId]: entries } }, null, 2),
      );
    }
    return { dir, cache };
  }


  test('both cache commands are present', () => {
    expect(commands).toHaveLength(2);
    expect(commands.some((c) => c.includes('does not update the plugin'))).toBe(true);
  });

  // An update installs a new version directory before it records it in installed_plugins.json, and the
  // commands cannot see it as protected in between. SessionStart's own cleanup skips a directory modified
  // within STALE_THRESHOLD_MS for the same reason, so both commands use that threshold.
  test('a version directory modified within the threshold is left alone, an older one is moved aside', () => {
    for (const command of commands) {
      for (const [minutesAgo, moved] of [[1, false], [9, false], [11, true], [60, true]] as const) {
        const { dir, cache } = makeConfigDir(['5.8.0', '5.8.1', '5.9.0'], '5.8.1');
        try {
          const then = new Date(Date.now() - minutesAgo * 60_000);
          utimesSync(path.join(cache, '5.9.0'), then, then);
          const result = runCommand(command, dir);
          expect({ minutesAgo, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ minutesAgo, status: 0, versions: moved ? '5.8.1' : '5.8.1,5.9.0', moved: moved ? 2 : 1 });
          expect(result.stdout.includes('modified in the last 10 minutes')).toBe(!moved);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // An update that refreshes a version directory that already exists overwrites its children in place (`cpSync` with
  // `force`); that changes the file only, not the date of the directory itself or of any level above it. The commands
  // therefore date a version by the newest of the directory and every entry below it, at any depth, at most 20000 of
  // them (a real cached version holds about 9000).
  describe('a version whose existing children are being refreshed is left alone', () => {
    const FRESH_LIMIT = 10 * 60_000;
    // Builds the configuration directory, adds the files to the unpinned version 5.9.0, ages everything an hour
    // back and then refreshes `fresh` (a path inside 5.9.0) in place, so that only that file has a new date.
    function refreshed(files: string[], fresh: string | null) {
      const made = makeConfigDir(['5.8.0', '5.8.1', '5.9.0'], '5.8.1');
      const version = path.join(made.cache, '5.9.0');
      for (const rel of files) {
        mkdirSync(path.dirname(path.join(version, rel)), { recursive: true });
        writeFileSync(path.join(version, rel), 'old');
      }
      ageVersions(made.cache);
      if (fresh) writeFileSync(path.join(version, fresh), 'new');
      return { ...made, version };
    }

    for (const [label, fresh, left] of [
      ['a file directly in the version', 'package.json', true],
      ['a file one directory down (dist/index.js)', path.join('dist', 'index.js'), true],
      ['a file three levels down', path.join('a', 'b', 'c.txt'), true],
      ['a file six levels down', path.join('a', 'b', 'c', 'd', 'e', 'f.txt'), true],
      ['nothing refreshed', null, false],
    ] as const) {
      test(`${label}: ${left ? 'left alone and reported' : 'moved aside like any old version'}`, () => {
        for (const command of commands) {
          const files = [path.join('dist', 'index.js'), path.join('dist', 'hooks', 'x.cjs'), path.join('a', 'b', 'c.txt'), path.join('a', 'b', 'c', 'd', 'e', 'f.txt')];
          const { dir, cache, version } = refreshed(files, fresh);
          try {
            // The directory itself, and every level above the refreshed file, still carries the old date, so a check of the directory date alone sees nothing.
            expect(Date.now() - statSync(version).mtimeMs).toBeGreaterThan(FRESH_LIMIT);
            const result = runCommand(command, dir);
            expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
              .toEqual({ status: 0, versions: left ? '5.8.1,5.9.0' : '5.8.1', moved: left ? 1 : 2 });
            expect(result.stdout.includes('modified in the last 10 minutes')).toBe(left);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      });
    }

    // The refreshed entry is a directory (the updater replaced a file in it, or created one) whose own date is new.
    test('a directory entry with a new date counts, at any depth', () => {
      for (const command of commands) {
        for (const deep of [path.join('dist', 'hooks'), path.join('a', 'b', 'c', 'd', 'e')]) {
          const { dir, cache, version } = refreshed([path.join(deep, 'x.cjs')], null);
          try {
            const now = new Date();
            utimesSync(path.join(version, deep), now, now);
            const result = runCommand(command, dir);
            expect({ deep, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ deep, versions: '5.8.1,5.9.0', moved: 1 });
            expect(result.stdout).toContain('modified in the last 10 minutes');
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });

    // The scan counts every entry it reads, files and directories at every depth. A flat first level of 5000 entries
    // (more than the old cap of 2000 for two levels) is fine now; the cap sits well above a real cached version (about
    // 9000 entries), and one entry beyond it cannot be judged. The large tree is nested, so only a count over the whole
    // tree reaches the cap: package.json, the directories a and a/b, 100 group directories and the files in them.
    test('a version with more than 20000 entries in its whole tree cannot be judged: it is skipped as unreadable, 20000 are fine', () => {
      const flat = (count: number) => Array.from({ length: count - 1 }, (_unused, i) => `f${i}`);
      const nested = (count: number) => Array.from({ length: count - 103 }, (_unused, i) => path.join('a', 'b', `g${i % 100}`, `f${i}`));
      for (const command of commands) {
        for (const [label, files, moved] of [['flat 5000', flat(5000), true], ['nested 20000', nested(20000), true], ['nested 20001', nested(20001), false]] as const) {
          const { dir, cache } = refreshed(files, null);
          try {
            const result = runCommand(command, dir);
            expect({ label, versions: digitVersions(cache), moved: movedAside(dir) })
              .toEqual({ label, versions: moved ? '5.8.1' : '5.8.1,5.9.0', moved: moved ? 2 : 1 });
            expect(/Could not judge 1 version/.test(result.stdout)).toBe(!moved);
            expect(result.stdout).not.toMatch(/Skipped/);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });

    test.skipIf(process.platform === 'win32')('a link inside a version is dated itself and never followed, so a link to its own directory does not loop', () => {
      for (const command of commands) {
        const { dir, cache, version } = refreshed(['package.json'], null);
        try {
          symlinkSync('.', path.join(version, 'self'));
          symlinkSync(path.join(cache, '5.8.1'), path.join(version, 'other'));
          // A link that is itself old but points at a file changed just now says nothing about the version.
          writeFileSync(path.join(dir, 'fresh.txt'), 'new');
          symlinkSync(path.join(dir, 'fresh.txt'), path.join(version, 'to-fresh-file'));
          ageVersions(cache);
          const result = runCommand(command, dir, { timeout: 20_000 });
          expect(result.error).toBeUndefined();
          expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.8.1', moved: 2 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  });

  test('the freshness threshold of both commands is the one the SessionStart cleanup uses', () => {
    const [, a, b, c] = /const STALE_THRESHOLD_MS = (\d+) \* (\d+) \* (\d+);/.exec(read('src/utils/paths.ts')) ?? [];
    const ms = Number(a) * Number(b) * Number(c);
    expect(ms).toBeGreaterThan(0);
    for (const command of commands) expect(command).toContain(`Date.now()-w<${ms}`);
    expect(ms / 60_000).toBe(10);
    expect(read('skills/omc-doctor/SKILL.md')).toContain('modified in the last 10 minutes');
  });

  test('the outdated-plugin command always says it only cleans up and does not update, the stale-cache command does not', () => {
    const [outdated, stale] = [commands.find((c) => c.includes('does not update the plugin')), commands.find((c) => !c.includes('does not update the plugin'))];
    expect(outdated).toBeDefined();
    expect(stale).toBeDefined();
    for (const [versions, pinned, installed] of [[['5.9.0'], '5.9.0', true], [['5.8.0', '5.9.0'], '5.9.0', true], [['5.8.0', '5.9.0'], null, false], [[], null, false]] as const) {
      const { dir } = makeConfigDir([...versions], pinned, installed);
      try {
        const result = runCommand(outdated!, dir);
        expect(result.stdout).toContain('only cleans up cached versions and does not update the plugin');
        expect(result.stdout).toContain('run the Updater line that Step 1 printed');
        expect(result.stdout).not.toMatch(/marketplace update|omc update/);
        expect(result.stdout).not.toContain('to fetch latest version');
        expect(runCommand(stale!, dir).stdout).not.toContain('does not update the plugin');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('pinned version is kept and unpinned versions are moved aside, not deleted', () => {
    for (const command of commands) {
      const { dir, cache } = makeConfigDir(['5.8.0', '5.8.1', '5.9.0'], '5.8.1');
      try {
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1');
        expect(movedAside(dir)).toBe(2);
        expect(readdirSync(cache).filter((n) => n.startsWith('.bak-'))).toEqual([]);
        expect(readdirSync(backupDir(dir)).some((n) => n.startsWith('5.8.0-'))).toBe(true);
        expect(existsSync(path.join(backupDir(dir), readdirSync(backupDir(dir)).find((n) => n.startsWith('5.9.0-'))!, 'package.json'))).toBe(true);
        expect(result.stdout).toMatch(/Moved 2 unprotected version/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('pin on the newest version (typical install): only older versions are moved aside', () => {
    for (const command of commands) {
      const { dir, cache } = makeConfigDir(['5.8.0', '5.9.0'], '5.9.0');
      try {
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.9.0');
        expect(movedAside(dir)).toBe(1);
        expect(result.stdout).toMatch(/Moved 1 unprotected version/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('every cached version pinned: nothing is moved and the protection is reported', () => {
    for (const command of commands) {
      const { dir, cache } = makeConfigDir(['5.9.0'], '5.9.0');
      try {
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.9.0');
        expect(movedAside(dir)).toBe(0);
        expect(result.stdout).toMatch(/Nothing to move/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a failed move reports the failure instead of claiming there is no cache', () => {
    for (const command of commands) {
      const { dir, cache } = makeConfigDir(['5.8.0', '5.9.0'], '5.9.0');
      try {
        // A file where the backup directory should go makes the move fail.
        writeFileSync(path.join(dir, 'plugins', 'backups'), 'not a directory');
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Cache move failed \(0 moved before the error\)/);
        expect(result.stdout).not.toMatch(/No plugin cache found|No cache to clean/);
        expect(digitVersions(cache)).toBe('5.8.0,5.9.0');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // An error other than a missing directory is not an absent cache: the commands report it with the path and the error
  // code and move nothing. A preload injects the error because the tests run as root, which ignores permissions.
  describe('a cache directory that cannot be read is reported, not mistaken for a missing one', () => {
    function failing(dir: string, rules: Array<{ fn: 'statSync' | 'readdirSync'; path: string; code: string }>) {
      const file = path.join(dir, 'fs-errors.cjs');
      writeFileSync(file, `const fs = require('fs'), path = require('path');
const rules = ${JSON.stringify(rules)};
for (const name of ['statSync', 'readdirSync']) {
  const real = fs[name];
  fs[name] = function (target, ...rest) {
    const rule = rules.find((r) => r.fn === name && path.resolve(String(target)) === r.path);
    if (rule) { const error = new Error(rule.code + ': injected'); error.code = rule.code; throw error; }
    return real.call(fs, target, ...rest);
  };
}
`);
      return file;
    }

    for (const code of ['EACCES', 'EIO']) {
      test(`the directory listing fails with ${code}: reported with the path and the code, nothing moved`, () => {
        for (const command of commands) {
          const { dir, cache } = makeConfigDir(['5.8.0', '5.9.0'], '5.9.0');
          try {
            const result = runCommand(command, dir, { preloads: [failing(dir, [{ fn: 'readdirSync', path: cache, code }])] });
            expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.8.0,5.9.0', moved: 0 });
            expect(result.stdout).toContain(`Nothing moved: could not read ${cache} (${code})`);
            expect(result.stdout).not.toMatch(/No plugin cache found|No cache to clean/);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      });
    }

    test.skipIf(process.platform === 'win32')('a file where the cache directory should be is reported as an error, not as a missing cache', () => {
      for (const command of commands) {
        const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
        try {
          const target = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, 'not a directory');
          const result = runCommand(command, dir);
          expect(result.status).toBe(0);
          expect(result.stdout).toContain(`Nothing moved: could not read ${target} (ENOTDIR)`);
          expect(result.stdout).not.toMatch(/No plugin cache found|No cache to clean/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // A cache directory whose `stat` fails is still a cache directory: it must not drop out of the list, or the other
    // marketplace would be cleaned while nothing says that this one was never looked at.
    test('with two marketplaces, an unreadable cache directory is reported and stops the run instead of being skipped', () => {
      for (const command of commands) {
        const { dir, cache } = makeConfigDir(['5.8.0', '5.9.0'], '5.9.0');
        const other = addCache(dir, ['5.7.0', '5.8.0'], 'oh-my-claudecode');
        try {
          writeRegistry(dir, { 'oh-my-claudecode@omc': [{ version: '5.9.0' }], 'oh-my-claudecode@oh-my-claudecode': [{ version: '5.8.0' }] });
          const rules = (['statSync', 'readdirSync'] as const).map((fn) => ({ fn, path: cache, code: 'EACCES' }));
          const result = runCommand(command, dir, { preloads: [failing(dir, rules)] });
          expect({ status: result.status, first: digitVersions(cache), second: digitVersions(other), moved: movedAside(dir) })
            .toEqual({ status: 0, first: '5.8.0,5.9.0', second: '5.7.0,5.8.0', moved: 0 });
          expect(result.stdout).toContain(`omc: Nothing moved: could not read ${cache} (EACCES)`);
          expect(result.stdout).not.toMatch(/No plugin cache found|No cache to clean|Moved/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  });

  test('without a cache directory the commands report that no cache was found', () => {
    for (const command of commands) {
      const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
      try {
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/No plugin cache found|No cache to clean/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('without a pinned version nothing is moved', () => {
    for (const command of commands) {
      const { dir, cache } = makeConfigDir(['5.8.0', '5.8.1'], null, false);
      try {
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.0,5.8.1');
        expect(movedAside(dir)).toBe(0);
        expect(result.stdout).toMatch(/Nothing moved/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('pinned version is compared by equality (5.8 is not protected by a 5.8.1 pin)', () => {
    for (const command of commands) {
      const { dir, cache } = makeConfigDir(['5.8', '5.8.1'], '5.8.1');
      try {
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1');
        expect(movedAside(dir)).toBe(1);
        expect(result.stdout).toMatch(/Moved 1 unprotected version/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('pinned versions are protected under all supported plugin IDs (legacy and new)', () => {
    for (const command of commands) {
      // Test with legacy ID 'oh-my-claudecode'
      const { dir, cache } = makeConfigDir(['5.8.0', '5.8.1', '5.9.0'], '5.8.1', true, 'oh-my-claudecode');
      try {
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1');
        expect(movedAside(dir)).toBe(2);
        expect(result.stdout).toMatch(/Kept protected cache versions/);
        expect(result.stdout).toMatch(/Moved 2 unprotected version/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The plugin IDs and the two registry layouts that the installer's resolver
  // (resolveInstalledOmcPluginRoots in src/installer/index.ts) reads.
  const OFFICIAL_IDS = ['oh-my-claudecode@omc', 'oh-my-claudecode', 'oh-my-claudecode@oh-my-claudecode'];
  const titleCase = (id: string) => id.replace(/(^|[-@])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
  // The cache namespace of a plugin ID: the marketplace part after the `@`, `omc` for the bare ID.
  const marketOf = (id: string) => (id.includes('@') ? id.slice(id.indexOf('@') + 1) : 'omc').toLowerCase();
  const layouts: Record<string, (plugins: Record<string, unknown>) => unknown> = {
    'plugins object': (plugins) => ({ version: 2, plugins }),
    'top-level map': (plugins) => plugins,
  };

  // The cache of a marketplace install lives in plugins/cache/<marketplace>/oh-my-claudecode, and the marketplace
  // is the part of the registered ID after the `@`. Step 1 reads that directory, so the repair commands must too.
  describe('the cache namespace follows the registry entry', () => {
    const idsAndMarkets: Array<[string, string]> = [['oh-my-claudecode@omc', 'omc'], ['oh-my-claudecode', 'omc'], ['oh-my-claudecode@oh-my-claudecode', 'oh-my-claudecode']];
    for (const [id, market] of idsAndMarkets) {
      test(`${id}: the versions of ${market} are cleaned in any letter case and a cache of the other namespace is left alone`, () => {
        for (const command of commands) {
          for (const spelled of [id, id.toUpperCase(), titleCase(id)]) {
            const { dir, cache } = makeCache(['5.7.0', '5.8.0', '5.9.0'], market);
            // One configuration directory with the cache of the other namespace on disk too.
            const otherCache = addCache(dir, ['6.0.0', '6.1.0'], market == 'omc' ? 'oh-my-claudecode' : 'omc');
            try {
              writeRegistry(dir, { [spelled]: [{ scope: 'user', version: '5.8.0' }] });
              const result = runCommand(command, dir);
              expect({ spelled, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ spelled, status: 0, versions: '5.8.0', moved: 2 });
              expect(result.stdout).toMatch(/Moved 2 unprotected version/);
              expect(result.stdout).not.toMatch(/No (plugin )?cache/);
              expect(digitVersions(otherCache)).toBe('6.0.0,6.1.0');
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        }
      });
    }

    test('an ID of each marketplace in the registry: both caches are cleaned, and each backup carries its marketplace', () => {
      for (const command of commands) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.0'], 'omc');
        const second = addCache(dir, ['5.7.0', '5.8.0'], 'oh-my-claudecode');
        try {
          writeRegistry(dir, { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0' }], 'oh-my-claudecode@oh-my-claudecode': [{ scope: 'user', version: '5.8.0' }] });
          const result = runCommand(command, dir);
          expect({ status: result.status, omc: digitVersions(cache), second: digitVersions(second), moved: movedAside(dir) }).toEqual({ status: 0, omc: '5.8.0', second: '5.8.0', moved: 2 });
          expect(readdirSync(backupDir(dir)).map((n) => n.replace(/-\d+$/, '')).sort()).toEqual(['5.7.0', 'oh-my-claudecode-5.7.0']);
          // With two directories every line says which one it is about, and the counts are those of that directory.
          expect(result.stdout).toMatch(/^omc: Moved 1 unprotected version/m);
          expect(result.stdout).toMatch(/^oh-my-claudecode: Moved 1 unprotected version/m);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test('a cache that exists only in a namespace no registry entry names is not touched, and the default namespace is omc', () => {
      for (const command of commands) {
        const stray = makeCache(['5.7.0', '5.8.0'], 'oh-my-claudecode');
        const plain = makeCache(['5.7.0', '5.8.0'], 'omc');
        try {
          writeRegistry(stray.dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const result = runCommand(command, stray.dir);
          expect(result.stdout).toMatch(/No (plugin )?cache/);
          expect({ versions: digitVersions(stray.cache), moved: movedAside(stray.dir) }).toEqual({ versions: '5.7.0,5.8.0', moved: 0 });
          // Without a registry the old default applies and, as before, nothing is pinned so nothing is moved.
          const none = runCommand(command, plain.dir);
          expect(none.stdout).toMatch(/no pinned (cache )?version found|Nothing moved/);
          expect(digitVersions(plain.cache)).toBe('5.7.0,5.8.0');
        } finally {
          rmSync(stray.dir, { recursive: true, force: true });
          rmSync(plain.dir, { recursive: true, force: true });
        }
      }
    });

    test('a registry that names only another marketplace than the one holding the cache says which directory it looked in', () => {
      for (const command of commands) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.0'], 'omc');
        try {
          writeRegistry(dir, { 'oh-my-claudecode@oh-my-claudecode': [{ scope: 'user', version: '5.8.0' }] });
          const result = runCommand(command, dir);
          expect(result.stdout).toMatch(/No (plugin cache found|cache to clean) in plugins\/cache\/oh-my-claudecode/);
          expect({ versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ versions: '5.7.0,5.8.0', moved: 0 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  });

  test('both commands compute the protected set with the same code, and it names the IDs the installer accepts', () => {
    const segment = (c: string) => c.slice(c.indexOf('const v='), c.indexOf('const free='));
    expect(segment(commands[0]).length).toBeGreaterThan(500);
    expect(segment(commands[1])).toBe(segment(commands[0]));
    const installerIds = /PLUGIN_IDS\s*=\s*new Set\(\[([^\]]*)\]/.exec(read('src/installer/index.ts'));
    expect(installerIds).not.toBeNull();
    const accepted = [...installerIds![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(accepted).toEqual([...OFFICIAL_IDS].sort());
    for (const command of commands) for (const id of accepted) expect(command).toContain(`'${id}'`);
  });

  // For every supported ID, every letter case and both registry layouts: the key
  // pins its own versions (by version, and by installPath with another scope),
  // a canonical key pins a third, and one version is free. The free version
  // must be moved: a key that is not recognised would fail closed (nothing
  // moved), which a "version kept" check alone cannot tell from protection.
  for (const id of OFFICIAL_IDS) {
    test(`${id}: every letter case and both registry layouts protect the versions it pins while a free version is moved`, () => {
      const anchorId = OFFICIAL_IDS.find((other) => other !== id)!;
      for (const command of commands) {
        for (const spelled of [id, id.toUpperCase(), titleCase(id)]) {
          for (const [layout, wrap] of Object.entries(layouts)) {
            const { dir, cache } = makeCache(['5.6.0', '5.7.0', '5.8.0', '5.9.0']);
            try {
              writeRegistryFile(dir, wrap({
                [anchorId]: [{ scope: 'user', version: '5.7.0' }],
                [spelled]: [
                  { scope: 'user', version: '5.8.0' },
                  { scope: 'project', projectPath: '/work/project', installPath: path.join(cache, '5.9.0') },
                ],
              }));
              const result = runCommand(command, dir);
              expect({ spelled, layout, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
                .toEqual({ spelled, layout, status: 0, versions: '5.7.0,5.8.0,5.9.0', moved: 1 });
              expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.6\.0-/);
              expect(result.stdout).toMatch(/Moved 1 unprotected version/);
              expect(result.stdout).not.toMatch(/Nothing moved/);
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        }
      }
    });
  }

  // A pinned version spelled in another letter case than its cache directory names that directory wherever the volume
  // folds case (found by device and inode), whatever platform the process reports: a Windows drive under WSL2 folds case
  // under `linux`, and so does a real Windows volume under a simulated `linux`. Where the volume tells the names apart
  // (also under a reported win32 or darwin) the pin names no directory, so no pin is found and nothing moves.
  test('a pinned version spelled in another letter case protects the directory where the volume folds case, under every platform name', () => {
    for (const command of commands) {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const { dir, cache } = makeCache(['5.1.0', '5.9.0-beta']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0-BETA' }] });
          const preload = path.join(dir, 'platform.cjs');
          writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: '${platform}' });\n`);
          const result = runCommand(command, dir, { preloads: [preload] });
          expect({ platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
            volumeFoldsCase()
              ? { platform, status: 0, versions: '5.9.0-beta', moved: 1 }
              : { platform, status: 0, versions: '5.1.0,5.9.0-beta', moved: 0 },
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The same pin on a volume that ignores letter case, under every platform name: the case-sensitive test volume gets
  // that alias from a preload, a real folding volume (a Windows runner, a casefold directory) has it already.
  test('on a volume that folds case a pin spelled in another letter case protects the directory under every platform name', () => {
    for (const command of commands) {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const { dir, cache } = makeCache(['5.1.0', '5.9.0-beta']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0-BETA' }] });
          const preload = path.join(dir, 'platform.cjs');
          writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: '${platform}' });\n`);
          const result = runCommand(command, dir, { preloads: [preload, writeCaseFoldPreload(dir)] });
          expect({ platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ platform, status: 0, versions: '5.9.0-beta', moved: 1 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a pin under a differently spelled ID is enough on its own, and its installPath may carry padding', () => {
    for (const command of commands) {
      for (const id of OFFICIAL_IDS) {
        for (const [layout, wrap] of Object.entries(layouts)) {
          const { dir, cache } = makeCache(['5.8.0', '5.9.0'], marketOf(id));
          try {
            writeRegistryFile(dir, wrap({ [titleCase(id)]: [{ scope: 'user', installPath: ` ${path.join(cache, '5.9.0')} ` }] }));
            const result = runCommand(command, dir);
            expect({ id, layout, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
              .toEqual({ id, layout, status: 0, versions: '5.9.0', moved: 1 });
            expect(result.stdout).toMatch(/Moved 1 unprotected version/);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });

  test('a version written with surrounding spaces still protects the version it names', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: ' 5.9.0 ' }] });
        const result = runCommand(command, dir);
        expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.9.0', moved: 1 });
        expect(result.stdout).toMatch(/Moved 1 unprotected version/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('the same ID spelled two ways keeps the versions pinned under both spellings', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
      try {
        writeRegistry(dir, {
          [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }],
          [PLUGIN_ID.toUpperCase()]: [{ scope: 'user', version: '5.9.0' }],
        });
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1,5.9.0');
        expect(movedAside(dir)).toBe(1);
        expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.8\.0-/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('plugins of other IDs neither protect a version nor block the move', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.7.0', '5.8.1']);
      try {
        writeRegistry(dir, {
          [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }],
          'other-plugin@market': [{ scope: 'user', version: '5.7.0', installPath: path.join(dir, 'plugins', 'cache', 'market', 'other-plugin', '5.7.0') }],
        });
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1');
        expect(movedAside(dir)).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A root variable that names no existing directory takes no part in the conflict check (as in Step 1), but a path it names
  // inside a cached version still protects that version.
  test('a stale plugin root variable next to an existing one is no conflict, two existing different directories are, and a stale path into a version still protects it', () => {
    for (const command of commands) {
      for (const [label, env, versions, moved] of [
        ['stale OMC root, existing CLAUDE root', (dir: string) => ({ OMC_PLUGIN_ROOT: path.join(dir, 'gone'), CLAUDE_PLUGIN_ROOT: dir }), '5.8.0', 1],
        ['existing OMC root, stale CLAUDE root', (dir: string) => ({ OMC_PLUGIN_ROOT: dir, CLAUDE_PLUGIN_ROOT: path.join(dir, 'gone') }), '5.8.0', 1],
        ['two different existing roots', (dir: string) => ({ OMC_PLUGIN_ROOT: dir, CLAUDE_PLUGIN_ROOT: path.join(dir, 'plugins') }), '5.7.0,5.8.0', 0],
        ['a stale path inside a free version', (dir: string) => ({ OMC_PLUGIN_ROOT: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.0', 'gone'), CLAUDE_PLUGIN_ROOT: dir }), '5.7.0,5.8.0', 0],
      ] as const) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const result = runCommand(command, dir, { env: env(dir) });
          expect({ label, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ label, status: 0, versions, moved });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
});
