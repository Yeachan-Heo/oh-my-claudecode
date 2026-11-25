import { describe, test, expect } from 'vitest';
import { existsSync, lstatSync, lutimesSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backupDir, commands, digitEntries, digitVersions, makeCache, movedAside, PLUGIN_ID, runCommand, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { ownHost, writeRecord } from './helpers/omc-doctor-occupancy-fixture.js';

// A version that a repair command moves away leaves a link at its name, to the newest version that is still a real directory of the cache (the
// way the cleanup of SessionStart replaces an old version): a session that picked the root of that version before the move and publishes its
// record only after the last read of the records is not seen by that read, but its root still opens.
describe('omc-doctor cache commands: a link at the place of a moved version', { timeout: 120_000 }, () => {
  const HOUR = 3_600_000;

  const link = (target: string, at: string) => {
    if (process.platform === 'win32') symlinkSync(path.resolve(path.dirname(at), target), at, 'junction');
    else symlinkSync(target, at);
  };
  const age = (entry: string, ageMs = HOUR) => {
    const then = new Date(Date.now() - ageMs);
    lutimesSync(entry, then, then);
  };
  // 5.9.0 is pinned, every other version is free; the directory of the occupancy records exists, so that a record can be published into it.
  const setup = (versions: string[]) => {
    const made = makeCache(versions);
    writeRegistry(made.dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
    mkdirSync(path.join(made.dir, '.omc', 'cache-occupancy'), { recursive: true });
    return made;
  };
  const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });
  const preloadOf = (dir: string, name: string, text: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  // A session publishes its record for HELD_DIR right after the n-th read of the occupancy directory returned: the read has taken its snapshot
  // and cannot see the record. The reads of one run are the check of every cache (1), the start of the move (2), the read after the choice (3),
  // the last read before the rename (4) and the read after the move (5).
  const publishAfterRead = (at: number) => `const fs = require('fs'), path = require('path'), crypto = require('crypto'); const real = fs.readdirSync; let reads = 0;
fs.readdirSync = function (target, ...rest) {
  const names = real.call(this, target, ...rest);
  if (String(target).endsWith('cache-occupancy') && ++reads === ${at}) {
    const record = JSON.stringify({ version: 1, pid: process.pid, pluginRoot: process.env.HELD_DIR, host: ${JSON.stringify(ownHost())}, updatedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(String(target), crypto.createHash('sha256').update(record).digest('hex') + '.json'), record);
  }
  return names;
};
`;
  const opens = (root: string) => existsSync(path.join(root, 'package.json'));
  // What a path is and where it leads, answered as data (a missing path is no link and leads nowhere) so that a missing link is a failed comparison, not an error.
  const isLink = (at: string) => {
    try {
      return lstatSync(at).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const leadsTo = (at: string) => {
    try {
      return realpathSync(at);
    } catch {
      return '';
    }
  };

  test('a record published right after the last read of the records finds its root open, for both commands', () => {
    for (const command of commands) {
      const { dir, cache } = setup(['5.8.0', '5.9.0']);
      try {
        const preload = preloadOf(dir, 'publish-after-last-read.cjs', publishAfterRead(5));
        const result = runCommand(command, dir, { preloads: [preload], env: { HELD_DIR: path.join(cache, '5.8.0') }, timeout: 60_000 });
        expect({ command, status: result.status, moved: movedAside(dir), says: /Moved 1 unprotected version/.test(result.stdout) }).toEqual({ command, status: 0, moved: 1, says: true });
        expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.8\.0-/);
        // The root of the record opens, through a link to the version that stays.
        expect({ command, opens: opens(path.join(cache, '5.8.0')), link: isLink(path.join(cache, '5.8.0')), target: leadsTo(path.join(cache, '5.8.0')) }).toEqual({
          command,
          opens: true,
          link: true,
          target: realpathSync(path.join(cache, '5.9.0')),
        });
        if (process.platform !== 'win32') expect(readlinkSync(path.join(cache, '5.8.0'))).toBe('5.9.0');
      } finally {
        clean(dir);
      }
    }
  });

  test('a version put back after the move gets its directory back and no link', () => {
    for (const command of commands) {
      const { dir, cache } = setup(['5.8.0', '5.9.0']);
      try {
        const preload = preloadOf(dir, 'publish-before-last-read.cjs', publishAfterRead(4));
        const result = runCommand(command, dir, { preloads: [preload], env: { HELD_DIR: path.join(cache, '5.8.0') }, timeout: 60_000 });
        expect({ command, status: result.status, moved: movedAside(dir), skipped: /Skipped 1 version/.test(result.stdout) }).toEqual({ command, status: 0, moved: 0, skipped: true });
        expect({ command, link: lstatSync(path.join(cache, '5.8.0')).isSymbolicLink(), directory: lstatSync(path.join(cache, '5.8.0')).isDirectory(), opens: opens(path.join(cache, '5.8.0')) }).toEqual({
          command,
          link: false,
          directory: true,
          opens: true,
        });
      } finally {
        clean(dir);
      }
    }
  });

  test('the link is dated by itself: it stays for 10 minutes, then the next run moves it as a link and leaves no new one', () => {
    for (const command of commands) {
      const { dir, cache } = setup(['5.8.0', '5.9.0']);
      try {
        expect(runCommand(command, dir, { timeout: 60_000 }).status).toBe(0);
        expect(isLink(path.join(cache, '5.8.0'))).toBe(true);
        // At once: the link is new, it is left alone as every link is, and nothing more is moved.
        const again = runCommand(command, dir, { timeout: 60_000 });
        expect(again.status).toBe(0);
        expect(again.stdout).toMatch(/Moved 0 unprotected version/);
        expect(again.stdout).toMatch(/Left 1 version\(s\) modified in the last 10 minutes alone/);
        expect({ command, versions: digitEntries(cache), moved: movedAside(dir) }).toEqual({ command, versions: '5.8.0,5.9.0', moved: 1 });
        // An hour later: the link is moved as the link, the tree it led to is not touched, and no link takes its place.
        age(path.join(cache, '5.8.0'));
        const later = runCommand(command, dir, { timeout: 60_000 });
        expect(later.status).toBe(0);
        expect(later.stdout).toMatch(/Moved 1 unprotected version/);
        expect({ command, versions: digitVersions(cache), moved: movedAside(dir), target: opens(path.join(cache, '5.9.0')) }).toEqual({ command, versions: '5.9.0', moved: 2, target: true });
        const moved = readdirSync(backupDir(dir)).filter((name) => name.startsWith('5.8.0-')).map((name) => lstatSync(path.join(backupDir(dir), name)).isSymbolicLink());
        expect({ command, moved: moved.sort() }).toEqual({ command, moved: [false, true] });
      } finally {
        clean(dir);
      }
    }
  });

  test('a session that published its record for the link keeps the link on the next run, as long as the link is old enough to be moved', () => {
    for (const command of commands) {
      const { dir, cache } = setup(['5.8.0', '5.9.0']);
      try {
        const preload = preloadOf(dir, 'publish-after-last-read.cjs', publishAfterRead(5));
        expect(runCommand(command, dir, { preloads: [preload], env: { HELD_DIR: path.join(cache, '5.8.0') }, timeout: 60_000 }).status).toBe(0);
        // The session that published late is still running (a record of a live process, as the test process is one), and the link is old.
        writeRecord(dir, path.join(cache, '5.8.0'));
        age(path.join(cache, '5.8.0'));
        const later = runCommand(command, dir, { timeout: 60_000 });
        expect(later.status).toBe(0);
        // The record names 5.8.0, which is now a link: the link is protected (with the version it leads to) and stays, and its root still opens.
        expect(later.stdout).toMatch(/Nothing to move/);
        expect({ command, versions: digitEntries(cache), opens: opens(path.join(cache, '5.8.0')), moved: movedAside(dir) }).toEqual({ command, versions: '5.8.0,5.9.0', opens: true, moved: 1 });
      } finally {
        clean(dir);
      }
    }
  });

  test('every moved real directory is replaced by a link to the version that stays', () => {
    for (const command of commands) {
      const { dir, cache } = setup(['5.6.0', '5.7.0', '5.8.0', '5.9.0']);
      try {
        const result = runCommand(command, dir, { timeout: 60_000 });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Moved 3 unprotected version/);
        for (const name of ['5.6.0', '5.7.0', '5.8.0']) {
          expect({ command, name, link: isLink(path.join(cache, name)), target: leadsTo(path.join(cache, name)) }).toEqual({
            command,
            name,
            link: true,
            target: realpathSync(path.join(cache, '5.9.0')),
          });
        }
        expect(movedAside(dir)).toBe(3);
        expect(result.stdout).not.toMatch(/Left no link/);
      } finally {
        clean(dir);
      }
    }
  });

  test('a version with no real directory left to lead to is moved without a link and without a message about one', () => {
    for (const command of commands) {
      const { dir, cache } = setup(['5.8.0']);
      try {
        // The pinned version is a link to a directory outside the cache: it is protected, and it is no version to lead to.
        mkdirSync(path.join(dir, 'outside'));
        link(path.join('..', '..', '..', '..', 'outside'), path.join(cache, '5.9.0'));
        const result = runCommand(command, dir, { timeout: 60_000 });
        expect({ command, status: result.status, left: readdirSync(cache), moved: movedAside(dir) }).toEqual({ command, status: 0, left: ['5.9.0'], moved: 1 });
        expect(result.stdout).toMatch(/Moved 1 unprotected version/);
        expect(result.stdout).not.toMatch(/Left no link/);
      } finally {
        clean(dir);
      }
    }
  });

  test('a link that is moved away (one of SessionStart) leaves no new link, and the version it led to is not moved', () => {
    for (const command of commands) {
      const { dir, cache } = setup(['5.9.0']);
      try {
        link('5.9.0', path.join(cache, '5.7.0'));
        age(path.join(cache, '5.7.0'));
        const result = runCommand(command, dir, { timeout: 60_000 });
        expect({ command, status: result.status, left: readdirSync(cache), moved: movedAside(dir) }).toEqual({ command, status: 0, left: ['5.9.0'], moved: 1 });
        expect(lstatSync(path.join(backupDir(dir), readdirSync(backupDir(dir))[0])).isSymbolicLink()).toBe(true);
      } finally {
        clean(dir);
      }
    }
  });

  test('a link that cannot be made does not stop the command: the version is in the backup and the command says that nothing is left in its place', () => {
    const refuse = `const fs = require('fs');
fs.symlinkSync = function () { const error = new Error('operation not permitted'); error.code = 'EPERM'; throw error; };
`;
    for (const command of commands) {
      const { dir, cache } = setup(['5.7.0', '5.8.0', '5.9.0']);
      try {
        const preload = preloadOf(dir, 'refuse-link.cjs', refuse);
        const result = runCommand(command, dir, { preloads: [preload], timeout: 60_000 });
        expect({ command, status: result.status, left: readdirSync(cache), moved: movedAside(dir) }).toEqual({ command, status: 0, left: ['5.9.0'], moved: 2 });
        expect(result.stdout).toMatch(/Moved 2 unprotected version/);
        expect(result.stdout).toMatch(/Left no link at the place of 2 moved version\(s\)/);
      } finally {
        clean(dir);
      }
    }
  });

  // The link is a relative one on POSIX and a junction with an absolute target on Windows, as SessionStart makes it. The Windows branch is run
  // here by a process that reports another platform (the volume stays the real one); a junction needs no privilege, a symbolic link does.
  test('the link is relative on POSIX and a junction with an absolute target on Windows', () => {
    const watch = `const fs = require('fs'); const real = fs.symlinkSync;
Object.defineProperty(process, 'platform', { value: process.env.REPORT_AS });
fs.symlinkSync = function (target, at, type) {
  fs.appendFileSync(process.env.LINK_LOG, JSON.stringify({ target, at, type: type === undefined ? null : type }) + '\\n');
  return real.call(fs, target, at, type);
};
`;
    for (const command of commands) {
      for (const platform of process.platform === 'win32' ? ['win32'] : ['linux', 'win32']) {
        const { dir, cache } = setup(['5.8.0', '5.9.0']);
        try {
          const preload = preloadOf(dir, 'watch-link.cjs', watch);
          const log = path.join(dir, 'links.log');
          const result = runCommand(command, dir, { preloads: [preload], env: { REPORT_AS: platform, LINK_LOG: log }, timeout: 60_000 });
          expect({ command, platform, status: result.status }).toEqual({ command, platform, status: 0 });
          const made = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
          const windows = platform === 'win32';
          expect({ command, platform, made }).toEqual({
            command,
            platform,
            made: [{ target: windows ? path.join(cache, '5.9.0') : '5.9.0', at: path.join(cache, '5.8.0'), type: windows ? 'junction' : null }],
          });
        } finally {
          clean(dir);
        }
      }
    }
  });
});
