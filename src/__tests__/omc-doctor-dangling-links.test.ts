import { describe, test, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupDir, CACHE_VERSIONS, CLAUDE_MD_OPTOUT, commands, makeCache, movedAside, PLUGIN_ID, runCommand, writeRegistry, realEntries } from './helpers/omc-doctor-cache-fixture.js';
import { step1 } from './helpers/omc-doctor-step1.js';

// A path that does not exist and a link that points at nothing both fail a read with ENOENT, but only the first one is
// "nothing there". Every place of the script that reads the file system and takes ENOENT for "none" has to tell them
// apart: the cache commands refuse to move anything when a source cannot be read (a dangling link may hide the record
// of a live session), Step 1 says unknown instead of none. A link to nothing is made with a relative target that is not
// there; a junction cannot be created without a target on Windows, so the whole file runs on POSIX only.
const posix = process.platform !== 'win32';
const GONE = 'no-such-target';
const PLATFORMS = ['linux', 'darwin'] as const;

// A profile in which a move is certain: 5.8.0 is pinned, 5.7.0 is free and old.
const profile = () => {
  const { dir, cache } = makeCache(['5.7.0', '5.8.0']);
  writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] });
  return { dir, cache };
};
const dangling = (at: string) => {
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(GONE, at);
};
const platformPreload = (dir: string, name: string) => {
  const file = path.join(dir, `platform-${name}.cjs`);
  writeFileSync(file, `Object.defineProperty(process, 'platform', { value: '${name}' });\n`);
  return file;
};
const REFUSED = /Nothing moved: installed_plugins\.json, the cache occupancy records, the plugin root variables or a path in them could not be read completely/;

describe.skipIf(!posix)('omc-doctor: a link that points at nothing is not an absent file or directory', { timeout: 120_000 }, () => {
  // Where the link is put, relative to the config directory; none of them exists as a real path.
  const places: Array<[string, (dir: string) => void]> = [
    ['the directory of the occupancy records', (dir) => dangling(path.join(dir, '.omc', 'cache-occupancy'))],
    ['the .omc directory above the records', (dir) => dangling(path.join(dir, '.omc'))],
  ];

  test.each(places)('both cache commands refuse, with exit code 1 and nothing moved, when %s is a link to nothing', (_name, make) => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const { dir, cache } = profile();
        try {
          make(dir);
          const result = runCommand(command, dir, { preloads: [platformPreload(dir, platform)], timeout: 20_000 });
          expect({ command, platform, status: result.status, refused: REFUSED.test(result.stdout) }).toEqual({ command, platform, status: 1, refused: true });
          expect(readdirSync(cache).sort()).toEqual(['5.7.0', '5.8.0']);
          expect(movedAside(dir)).toBe(0);
          expect(existsSync(backupDir(dir))).toBe(false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('the same profile with the directory really absent, or a link to a directory that exists, moves the free version', () => {
    for (const command of commands) {
      for (const make of [(_dir: string) => undefined, (dir: string) => { mkdirSync(path.join(dir, 'elsewhere'), { recursive: true }); mkdirSync(path.join(dir, '.omc')); symlinkSync(path.join('..', 'elsewhere'), path.join(dir, '.omc', 'cache-occupancy')); }]) {
        const { dir, cache } = profile();
        try {
          make(dir);
          const result = runCommand(command, dir, { timeout: 20_000 });
          expect({ command, status: result.status, moved: result.stdout.includes('Moved 1 unprotected version(s)') }).toEqual({ command, status: 0, moved: true });
          expect(realEntries(cache)).toEqual(['5.8.0']);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a link to nothing as the registry file stops both cache commands and makes Step 1 say unknown, a missing file does neither', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        rmSync(path.join(dir, 'plugins', 'installed_plugins.json'));
        symlinkSync(GONE, path.join(dir, 'plugins', 'installed_plugins.json'));
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, refused: REFUSED.test(result.stdout), cause: result.stdout.includes('a link on the way to the file points at nothing') }).toEqual({ command, status: 1, refused: true, cause: true });
        expect(readdirSync(cache).sort()).toEqual(['5.7.0', '5.8.0']);
        rmSync(path.join(dir, 'plugins', 'installed_plugins.json'));
        const missing = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: missing.status, text: missing.stdout.includes('no pinned') }).toEqual({ command, status: 0, text: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const linked = step1({ setup: (dir) => symlinkSync(GONE, path.join(dir, 'plugins', 'installed_plugins.json')) });
    expect(linked.Channel).toMatch(/^unknown \(installed_plugins\.json could not be read completely/);
    expect(step1({}).Channel).toBe('npm');
  });

  test('a cache directory that is a link to nothing is reported as unreadable by both cache commands and by Step 6, an absent one is not', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        rmSync(cache, { recursive: true, force: true });
        symlinkSync(GONE, cache);
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, text: result.stdout.includes(`Nothing moved: could not read ${cache} (ENOENT: a link on the way points at nothing)`) }).toEqual({ command, status: 1, text: true });
        const six = runCommand(CACHE_VERSIONS, dir, { timeout: 20_000 });
        expect(six.stdout).toContain(`could not read ${cache} (ENOENT)`);
        rmSync(cache);
        const absent = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: absent.status, text: /No (plugin cache found|cache to clean)/.test(absent.stdout) }).toEqual({ command, status: 0, text: true });
        expect(runCommand(CACHE_VERSIONS, dir, { timeout: 20_000 }).stdout).toBe('0 versions\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a pinned version directory that is a link to nothing is still the pinned version: it is kept and the free one moves', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.7.0']);
      try {
        symlinkSync(GONE, path.join(cache, '5.8.0'));
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] });
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, kept: /Kept protected cache versions.*5\.8\.0/.test(result.stdout), moved: result.stdout.includes('Moved 1 unprotected version(s)') }).toEqual({ command, status: 0, kept: true, moved: true });
        expect(readdirSync(cache)).toEqual(['5.8.0']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The destination of a move is never "free" by an ENOENT either: a link to nothing as plugins/backups, or as a directory
  // above it, cannot be resolved, so the command refuses with exit code 1 before it moves anything (the destination is
  // resolved first, see omc-doctor-backup-destination.test.ts).
  test('a backups directory that is a link to nothing makes both cache commands refuse with exit code 1 and move nothing', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        symlinkSync(GONE, path.join(dir, 'plugins', 'backups'));
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, refused: /Nothing moved: the backup directory .* points at nothing/.test(result.stdout) }).toEqual({ command, status: 1, refused: true });
        expect(readdirSync(cache).sort()).toEqual(['5.7.0', '5.8.0']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('an opt-out file that is a link to nothing is neither enabled nor disabled, a missing one is enabled', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-optout-'));
    try {
      expect(runCommand(CLAUDE_MD_OPTOUT, dir).stdout).toBe('CLAUDE.md management enabled\n');
      symlinkSync(GONE, path.join(dir, '.omc-config.json'));
      expect(runCommand(CLAUDE_MD_OPTOUT, dir).stdout).toBe('CLAUDE.md management unknown: could not read .omc-config.json (ENOENT)\n');
      rmSync(path.join(dir, '.omc-config.json'));
      writeFileSync(path.join(dir, '.omc-config.json'), JSON.stringify({ claudeMdEnabled: false }));
      expect(runCommand(CLAUDE_MD_OPTOUT, dir).stdout).toBe('CLAUDE.md management disabled by claudeMdEnabled: false\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a manifest of the loaded root that is a link to nothing is a manifest with no usable version, a missing one is no manifest', () => {
    const marketplace = (link: boolean) =>
      step1({
        plugins: (dir) => ({ [PLUGIN_ID]: [{ version: '5.8.0', installPath: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0') }] }),
        cache: { omc: ['5.8.0'] },
        env: (dir) => ({ CLAUDE_PLUGIN_ROOT: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0') }),
        setup: (dir) => {
          if (link) symlinkSync(GONE, path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0', 'package.json'));
        },
      });
    expect('Note' in marketplace(false)).toBe(false);
    expect(marketplace(true)).toMatchObject({ Channel: 'marketplace omc', Installed: '5.8.0', Note: expect.stringContaining('holds no usable version') });
  });
});

// Not every unreadable path is a link to nothing: a loop and a file where a directory should be are unreadable too, and
// stayed so before. Controls for the three answers of one function (there, absent, cannot be read).
describe.skipIf(!posix)('omc-doctor: the other ways a path cannot be read keep stopping the cache commands', { timeout: 120_000 }, () => {
  test('a loop in place of the occupancy directory, or a file in place of .omc, refuses like a link to nothing', () => {
    for (const command of commands) {
      for (const make of [
        (dir: string) => { mkdirSync(path.join(dir, '.omc')); symlinkSync('cache-occupancy', path.join(dir, '.omc', 'cache-occupancy')); },
        (dir: string) => writeFileSync(path.join(dir, '.omc'), 'not a directory'),
      ]) {
        const { dir, cache } = profile();
        try {
          make(dir);
          const result = runCommand(command, dir, { timeout: 20_000 });
          expect({ command, status: result.status, refused: REFUSED.test(result.stdout) }).toEqual({ command, status: 1, refused: true });
          expect(readdirSync(cache).sort()).toEqual(['5.7.0', '5.8.0']);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a cache of a profile whose plugins directory holds nothing at all still reports a missing cache, exit 0', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-absent-'));
    try {
      mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
      for (const command of commands) {
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, text: /No (plugin cache found|cache to clean)/.test(result.stdout) }).toEqual({ command, status: 0, text: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
