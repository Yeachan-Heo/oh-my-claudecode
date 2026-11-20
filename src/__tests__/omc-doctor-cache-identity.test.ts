import { describe, test, expect } from 'vitest';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { commands, ageVersions, runCommand, digitVersions, backupDir, movedAside, PLUGIN_ID, makeCache, upperBelow, volumeFoldsCase, writeCaseFoldPreload, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

describe('omc-doctor cache commands on a synthetic config directory (identity of paths)', { timeout: 120_000 }, () => {
  // Whether another spelling names an existing path here, without a preload: only where the volume folds letter case.
  const folds = volumeFoldsCase();
  // A symlink on POSIX; a junction with an absolute target on Windows (no privilege needed).
  function link(target: string, at: string) {
    if (process.platform === 'win32') symlinkSync(path.resolve(path.dirname(at), target), at, 'junction');
    else symlinkSync(target, at);
  }
  // An occupancy record of this live process; a record without a start identity is kept while its process is alive.
  function writeRecord(dir: string, root: string): string {
    const record = { version: 1, pid: process.pid, pluginRoot: root, updatedAt: new Date().toISOString() };
    const directory = path.join(dir, '.omc', 'cache-occupancy');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${createHash('sha256').update(JSON.stringify(record)).digest('hex')}.json`);
    writeFileSync(file, JSON.stringify(record));
    return file;
  }

  // On WSL2 with the configuration directory on a Windows drive the platform is `linux` while the volume ignores letter
  // case, so the platform name says nothing about whether two spellings are one directory. Existing paths are compared by
  // device and inode as well; the preload gives the case-sensitive test volume that alias.
  describe('a letter-case alias on a volume that ignores case under a platform that reports linux', () => {
    // 5.1.0 is free, 5.8.0 is pinned (that is what lets the move loop run), 5.9.0 is only reached through an alias.
    type Source = { label: string; versions?: string[]; setup: (dir: string, cache: string, upper: string) => { env?: Record<string, string> } | void };
    const sources: Source[] = [
      { label: 'the plugin root of an occupancy record', setup: (d, _c, upper) => { writeRecord(d, upper); } },
      { label: 'OMC_PLUGIN_ROOT', setup: (_d, _c, upper) => ({ env: { OMC_PLUGIN_ROOT: upper } }) },
      { label: 'CLAUDE_PLUGIN_ROOT', setup: (_d, _c, upper) => ({ env: { CLAUDE_PLUGIN_ROOT: upper } }) },
      { label: 'the installPath of another plugin', setup: (d, _c, upper) => { writeRegistry(d, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }], 'other-plugin@market': [{ scope: 'user', installPath: upper }] }); } },
      { label: 'the installPath of a pin', setup: (d, _c, upper) => { writeRegistry(d, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }, { scope: 'user', installPath: upper }] }); } },
      { label: 'a path below the version', setup: (_d, _c, upper) => ({ env: { OMC_PLUGIN_ROOT: path.join(upper, 'scripts') } }) },
    ];
    const run = (command: string, source: Source, casefold: boolean) => {
      const { dir, cache } = makeCache(['5.1.0', '5.8.0', '5.9.0']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
        mkdirSync(path.join(cache, '5.9.0', 'scripts'), { recursive: true });
        ageVersions(cache);
        const extra = source.setup(dir, cache, upperBelow(dir, path.join(cache, '5.9.0')));
        const result = runCommand(command, dir, { env: (extra && extra.env) || {}, preloads: casefold ? [writeCaseFoldPreload(dir)] : [] });
        return { status: result.status, versions: digitVersions(cache), moved: movedAside(dir), stdout: result.stdout };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test('every source of protection keeps the version it names through the alias, in both commands', () => {
      for (const command of commands) {
        for (const source of sources) {
          const got = run(command, source, true);
          expect({ source: source.label, status: got.status, versions: got.versions, moved: got.moved }).toEqual({ source: source.label, status: 0, versions: '5.8.0,5.9.0', moved: 1 });
          // Control: on a volume that does tell the names apart, the alias names no directory and protects nothing.
          const plain = run(command, source, false);
          expect({ source: source.label, versions: plain.versions }).toEqual({ source: source.label, versions: folds ? '5.8.0,5.9.0' : '5.8.0' });
        }
      }
    });

    test('a pin whose version differs from the directory only in letter case protects that directory', () => {
      for (const command of commands) {
        for (const casefold of [true, false]) {
          const { dir, cache } = makeCache(['5.1.0', '5.8.0', '5.9.0-rc1']);
          try {
            writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }, { scope: 'user', version: '5.9.0-RC1' }] });
            const result = runCommand(command, dir, { preloads: casefold ? [writeCaseFoldPreload(dir)] : [] });
            expect({ casefold, status: result.status, versions: digitVersions(cache) }).toEqual({ casefold, status: 0, versions: casefold || folds ? '5.8.0,5.9.0-rc1' : '5.8.0' });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });

    test('the two plugin root variables naming one directory by two spellings are not a conflict, two different directories still are', () => {
      for (const command of commands) {
        for (const second of ['5.9.0', '5.8.0'] as const) {
          const { dir, cache } = makeCache(['5.1.0', '5.8.0', '5.9.0']);
          try {
            writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
            const env = { OMC_PLUGIN_ROOT: path.join(cache, '5.9.0'), CLAUDE_PLUGIN_ROOT: upperBelow(dir, path.join(cache, second)) };
            const result = runCommand(command, dir, { env, preloads: [writeCaseFoldPreload(dir)] });
            expect({ second, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual(
              second === '5.9.0'
                ? { second, status: 0, versions: '5.8.0,5.9.0', moved: 1 }
                : { second, status: 0, versions: '5.1.0,5.8.0,5.9.0', moved: 0 },
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });

    // The alias may lead through a link version too: the link is read under its alias and both the link and its target are protected.
    test('an alias that names a link version keeps the link and the directory it points to', () => {
      for (const command of commands) {
        const { dir, cache } = makeCache(['5.1.0', '5.8.0', '5.9.0']);
        try {
          link('5.9.0', path.join(cache, '5.9.1'));
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          writeRecord(dir, upperBelow(dir, path.join(cache, '5.9.1')));
          const result = runCommand(command, dir, { preloads: [writeCaseFoldPreload(dir)] });
          expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.8.0,5.9.0,5.9.1', moved: 1 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // A file system that reports inode 0 for everything gives no identity; counting it would make all versions one directory.
    test('a file system that reports inode 0 gives no identity, so the name comparison alone decides', () => {
      const zeroInode = "const fs = require('fs'); const real = fs.lstatSync; fs.lstatSync = function (target, options) { const stat = real.call(fs, target, options); if (options && options.bigint) stat.ino = 0n; return stat; };\n";
      for (const command of commands) {
        const { dir, cache } = makeCache(['5.1.0', '5.8.0', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const preload = path.join(dir, 'zero-inode.cjs');
          writeFileSync(preload, zeroInode);
          const result = runCommand(command, dir, { preloads: [preload] });
          expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.8.0', moved: 2 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // The identity of the version directory is its own: a link that nothing refers to is not protected because the
    // directory it points to is, with or without the alias.
    test('a link nothing refers to is still moved aside when only its target is named through the alias', () => {
      for (const command of commands) {
        const { dir, cache } = makeCache(['5.1.0', '5.8.0', '5.9.0']);
        try {
          link('5.9.0', path.join(cache, '5.9.1'));
          ageVersions(cache); // a link is dated itself, so a link created just now would be left alone
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          writeRecord(dir, upperBelow(dir, path.join(cache, '5.9.0')));
          const result = runCommand(command, dir, { preloads: [writeCaseFoldPreload(dir)] });
          expect({ status: result.status, versions: digitVersions(cache) }).toEqual({ status: 0, versions: '5.8.0,5.9.0' });
          expect(readdirSync(backupDir(dir)).map((n) => n.replace(/-\d+$/, '')).sort()).toEqual(['5.1.0', '5.9.1']);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  });
});
