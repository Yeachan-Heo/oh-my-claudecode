import { describe, test, expect } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commands, runCommand, digitVersions, backupDir, movedAside, PLUGIN_ID, makeCache, writeRegistryFile, writeRegistry, realEntries } from './helpers/omc-doctor-cache-fixture.js';

describe('omc-doctor cache commands on a synthetic config directory (registry shapes, occupancy records, failed moves)', { timeout: 120_000 }, () => {
  test('a registry of an unsupported shape moves nothing and says it could not be read completely', () => {
    const shapes: Record<string, unknown> = {
      'top-level array': '[]',
      'top-level null': 'null',
      'top-level string': '"text"',
      'top-level number': '42',
      'no plugins and no entries': { version: 2 },
      'plugins is null': { version: 2, plugins: null },
      'plugins is an array': { version: 2, plugins: [] },
      'plugins is a string': { version: 2, plugins: 'x' },
      'top-level map with a stray non-entry key': { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }], version: 2 },
    };
    for (const command of commands) {
      for (const [label, content] of Object.entries(shapes)) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistryFile(dir, content);
          const result = runCommand(command, dir);
          expect({ label, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ label, status: 1, versions: '5.8.0,5.8.1,5.9.0', moved: 0 });
          expect(result.stdout).toMatch(/Nothing moved: .*could not be read completely/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a version registered only by installPath is protected, also when the path points below it', () => {
    for (const command of commands) {
      for (const suffix of ['', 'hooks']) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, {
            [PLUGIN_ID]: [
              { scope: 'user', version: '5.8.1' },
              { scope: 'user', installPath: path.join(cache, '5.9.0', suffix) },
            ],
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
    }
  });

  test('an installPath-only entry is a pin on its own', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', installPath: path.join(cache, '5.9.0') }] });
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.9.0');
        expect(movedAside(dir)).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('an occupancy registry that cannot be read completely moves nothing', () => {
    const break_ = {
      'registry path is a file': (dir: string) => {
        mkdirSync(path.join(dir, '.omc'), { recursive: true });
        writeFileSync(path.join(dir, '.omc', 'cache-occupancy'), 'not a directory');
      },
      'a record is not valid JSON': (dir: string) => {
        mkdirSync(path.join(dir, '.omc', 'cache-occupancy'), { recursive: true });
        writeFileSync(path.join(dir, '.omc', 'cache-occupancy', `${'a'.repeat(64)}.json`), '{ truncated');
      },
      'a record has no plugin root': (dir: string) => {
        mkdirSync(path.join(dir, '.omc', 'cache-occupancy'), { recursive: true });
        writeFileSync(path.join(dir, '.omc', 'cache-occupancy', `${'b'.repeat(64)}.json`), JSON.stringify({ version: 1, pid: process.pid }));
      },
      'a record has an empty plugin root': (dir: string) => {
        mkdirSync(path.join(dir, '.omc', 'cache-occupancy'), { recursive: true });
        writeFileSync(path.join(dir, '.omc', 'cache-occupancy', `${'c'.repeat(64)}.json`), JSON.stringify({ version: 1, pid: process.pid, pluginRoot: '' }));
      },
      'a record has a blank plugin root': (dir: string) => {
        mkdirSync(path.join(dir, '.omc', 'cache-occupancy'), { recursive: true });
        writeFileSync(path.join(dir, '.omc', 'cache-occupancy', `${'d'.repeat(64)}.json`), JSON.stringify({ version: 1, pid: process.pid, pluginRoot: '  ' }));
      },
      'a record has a plugin root that is not a string': (dir: string) => {
        mkdirSync(path.join(dir, '.omc', 'cache-occupancy'), { recursive: true });
        writeFileSync(path.join(dir, '.omc', 'cache-occupancy', `${'e'.repeat(64)}.json`), JSON.stringify({ version: 1, pid: process.pid, pluginRoot: 42 }));
      },
    };
    for (const command of commands) {
      for (const [label, breakIt] of Object.entries(break_)) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
          breakIt(dir);
          const result = runCommand(command, dir);
          expect({ label, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ label, status: 1, versions: '5.8.0,5.8.1,5.9.0', moved: 0 });
          expect(result.stdout).toMatch(/Nothing moved/);
          expect(result.stdout).not.toMatch(/Moved \d/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a registry that cannot be traversed completely moves nothing', () => {
    const registries: Record<string, (cache: string) => Record<string, unknown>> = {
      'null entry before a valid pin under a later ID': () => ({
        [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }],
        'oh-my-claudecode': [null, { scope: 'user', version: '5.9.0' }],
      }),
      'entry that is not an object': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }, 'junk'] }),
      'entries that are not an array': () => ({
        [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }],
        'oh-my-claudecode': { scope: 'user', version: '5.9.0' },
      }),
      'empty string instead of the entries': () => ({
        [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }],
        'oh-my-claudecode': '',
      }),
      'installPath that is not a string': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }, { scope: 'user', installPath: 42 }] }),
      'empty installPath': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }, { scope: 'user', version: '5.9.0', installPath: '' }] }),
      'blank installPath': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }, { scope: 'user', version: '5.9.0', installPath: '  ' }] }),
      'entry with neither version nor installPath': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }, { scope: 'user' }] }),
      'empty entry list under a supported ID': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }], 'oh-my-claudecode@oh-my-claudecode': [] }),
      'empty entry list under an unrelated key': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }], 'other-plugin@market': [] }),
      'entries that are not an array under an unrelated key': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }], 'other-plugin@market': { scope: 'user' } }),
      'a non-empty string instead of the entries under an unrelated key': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }], 'other-plugin@market': 'junk' }),
      'an object with a length instead of the entries under an unrelated key': () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }], 'other-plugin@market': { length: 3 } }),
      'key that only resembles a supported ID': () => ({
        [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }],
        'oh-my-claudecode@omc-fork': [{ scope: 'user', version: '5.9.0' }],
      }),
      'upper-case key that is not a supported ID': () => ({
        [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }],
        'OH-MY-CLAUDECODE@OTHER': [{ scope: 'user', version: '5.9.0' }],
      }),
    };
    for (const command of commands) {
      for (const [label, registry] of Object.entries(registries)) {
        const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, registry(cache));
          const result = runCommand(command, dir);
          expect({ label, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ label, status: 1, versions: '5.8.0,5.8.1,5.9.0', moved: 0 });
          expect(result.stdout).toMatch(/Nothing moved: .*could not be read completely/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
  // An entry under a key that is not an OMC plugin ID is read like one under a supported ID: an entry that lost
  // its installPath may have pointed into the cache, and a registry that cannot be read completely moves nothing.
  test('a malformed entry under an unrelated plugin ID makes the registry unreadable, before or after the pin, in both commands', () => {
    const shapes: Record<string, (cache: string) => unknown[]> = {
      'a null entry': () => [null],
      'a valid entry followed by a null entry': (cache) => [{ scope: 'user', installPath: path.join(cache, '5.9.0') }, null],
      'a null entry followed by a valid entry': (cache) => [null, { scope: 'user', installPath: path.join(cache, '5.9.0') }],
      'a string entry': () => ['junk'],
      'a number entry': () => [42],
      'a nested array': (cache) => [[{ scope: 'user', installPath: path.join(cache, '5.9.0') }]],
      'an empty nested array': () => [[]],
      'an object with neither version nor installPath': () => [{ scope: 'user' }],
      'an object with null fields only': () => [{ version: null, installPath: null }],
      'a blank installPath': () => [{ scope: 'user', installPath: '  ' }],
      'an installPath that is not a string': () => [{ scope: 'user', installPath: 42 }],
      'a version that is not a string': () => [{ scope: 'user', version: 5 }],
      'a blank version beside a valid installPath': (cache) => [{ scope: 'user', version: '', installPath: path.join(cache, '5.9.0') }],
    };
    for (const command of commands) {
      for (const [label, entries] of Object.entries(shapes)) {
        for (const position of ['before', 'after'] as const) {
          const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
          try {
            const pin = { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] };
            const other = { 'other-plugin@market': entries(cache) };
            writeRegistry(dir, position === 'before' ? { ...other, ...pin } : { ...pin, ...other });
            const result = runCommand(command, dir);
            expect({ label, position, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) })
              .toEqual({ label, position, status: 1, versions: '5.8.0,5.8.1,5.9.0', moved: 0 });
            expect(result.stdout).toMatch(/Nothing moved: .*could not be read completely/);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });

  test('well-formed entries under an unrelated plugin ID, with or without an installPath or with a null field, do not block the move', () => {
    const ok = (dir: string): Record<string, unknown[]> => ({
      'other-plugin@market': [{ scope: 'user', version: '1.0.0' }, { scope: 'user', installPath: path.join(dir, 'nowhere') }, { scope: 'user', version: '1.0.0', installPath: path.join(dir, 'nowhere') }, { scope: 'user', version: null, installPath: path.join(dir, 'nowhere') }, { scope: 'user', version: '1.0.0', installPath: null }],
    });
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }], ...ok(dir) });
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1');
        expect(movedAside(dir)).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('the installPath of an unrelated plugin is trimmed like the others and still protects the version it points into', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.8.1', '5.9.0']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }], 'other-plugin@market': [{ scope: 'user', installPath: `  ${path.join(cache, '5.9.0')}  ` }] });
        const result = runCommand(command, dir);
        expect(result.status).toBe(0);
        expect(digitVersions(cache)).toBe('5.8.1,5.9.0');
        expect(movedAside(dir)).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A preload that makes the K-th renameSync of the command throw, so the move
  // fails after K-1 versions were already moved (a chmod would not stop a root
  // user, and a directory that blocks the first move would not reach a later one).
  // On Windows a directory that another process holds open fails the same way, with EPERM or EBUSY; a backup directory on
  // another volume than the cache fails with EXDEV, and stops the run the same way.
  const failRenamePreload = `const fs = require('fs'); const real = fs.renameSync; let calls = 0;
fs.renameSync = function (...args) {
  calls += 1;
  if (calls === Number(process.env.RENAME_FAIL_AT)) { const e = new Error('injected rename failure'); e.code = process.env.RENAME_FAIL_CODE; throw e; }
  return real.apply(this, args);
};
`;

  test('a move that fails at the first, a middle or the last version reports the count and leaves every version in exactly one place', () => {
    const all = ['5.5.0', '5.6.0', '5.7.0', '5.8.0', '5.9.0'];
    for (const command of commands) {
      for (const [failAt, code] of [[1, 'EIO'], [2, 'EIO'], [3, 'EIO'], [2, 'EPERM'], [2, 'EBUSY'], [2, 'EXDEV']] as const) {
        const { dir, cache } = makeCache(all);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }, { scope: 'user', version: '5.9.0' }] });
          const preload = path.join(dir, 'fail-rename.cjs');
          writeFileSync(preload, failRenamePreload);
          const result = runCommand(command, dir, { preloads: [preload], env: { RENAME_FAIL_AT: String(failAt), RENAME_FAIL_CODE: code } });
          const moved = failAt - 1;
          const inBackup = readdirSync(backupDir(dir)).map((n) => n.replace(/-\d+$/, '')).sort();
          const inCache = realEntries(cache).filter((n) => /^\d/.test(n)).sort();
          expect({ failAt, code, status: result.status, moved: inBackup.length }).toEqual({ failAt, code, status: 1, moved });
          expect([...inBackup, ...inCache].sort()).toEqual(all);
          expect(inCache).toEqual(expect.arrayContaining(['5.8.0', '5.9.0']));
          for (const name of readdirSync(backupDir(dir))) expect(existsSync(path.join(backupDir(dir), name, 'package.json'))).toBe(true);
          for (const name of inCache) expect(existsSync(path.join(cache, name, 'package.json'))).toBe(true);
          expect(result.stdout).toContain(`Cache move failed (${moved} moved before the error): injected rename failure`);
          expect(result.stdout).not.toMatch(/Moved \d|No plugin cache found|No cache to clean/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
});
