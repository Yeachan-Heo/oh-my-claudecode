import { describe, test, expect } from 'vitest';
import { existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backupDir, commands, makeCache, movedAside, PLUGIN_ID, runCommand, sharedSections, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

// A version directory of the cache can be a link: SessionStart replaces a stale version with a redirect to the active one
// (`5.7.0 -> 5.8.0`) so that a running session whose path points at the old name keeps working. The commands date such an
// entry by the link itself (`lstatSync`), never by the tree it points to: a redirect created a moment ago is new, whatever
// the dates in its target, and is not moved before the race guard (10 minutes) has passed; an old redirect is moved as the
// link only and its target is not touched. A POSIX symlink is a relative link; Windows gets a junction with an absolute
// target (no privilege needed), which is also what SessionStart creates there.
describe('omc-doctor: a version directory that is a link is dated by the link itself', { timeout: 120_000 }, () => {
  const THRESHOLD = 600_000;
  const HOUR = 3_600_000;

  function link(target: string, at: string) {
    if (process.platform === 'win32') symlinkSync(path.resolve(path.dirname(at), target), at, 'junction');
    else symlinkSync(target, at);
  }
  const date = (entry: string, ageMs: number) => {
    const then = new Date(Date.now() - ageMs);
    lutimesSync(entry, then, then);
  };

  const run = (command: string, build: (cache: string, dir: string) => void) => {
    const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
    try {
      writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
      // 5.8.0 is a free version too, so it is moved in every case below; the case is about the entry `5.7.0`.
      build(cache, dir);
      const result = runCommand(command, dir, { timeout: 60_000 });
      expect(result.status).toBe(0);
      return {
        result,
        dir,
        cache,
        moved: existsSync(backupDir(dir)) ? readdirSync(backupDir(dir)).map((n) => n.replace(/-\d+$/, '')).sort() : [],
        left: readdirSync(cache).sort(),
      };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  };
  const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

  test('both commands carry one dating function, which never follows a link', () => {
    const dating = (command: string) => sharedSections(command).get('modification dates') ?? '';
    expect(commands).toHaveLength(2);
    const [one, two] = commands.map(dating);
    expect(one).not.toBe('');
    expect(two).toBe(one);
    expect(one).toContain('fs.lstatSync(entry)');
    expect(one).not.toMatch(/(?<!l)statSync/);
  });

  test('a redirect created a moment ago to an older pinned version is not moved, and the same link dated before the threshold is', () => {
    for (const command of commands) {
      const fresh = run(command, (cache) => {
        link('5.9.0', path.join(cache, '5.7.0'));
      });
      try {
        // The target tree is an hour old; only the link is new.
        expect(fresh.left).toContain('5.7.0');
        expect(lstatSync(path.join(fresh.cache, '5.7.0')).isSymbolicLink()).toBe(true);
        expect(fresh.moved).toEqual(['5.8.0']);
        expect(fresh.result.stdout).toMatch(/Left 1 version\(s\) modified in the last 10 minutes alone/);
      } finally {
        clean(fresh.dir);
      }
      const aged = run(command, (cache) => {
        link('5.9.0', path.join(cache, '5.7.0'));
        date(path.join(cache, '5.7.0'), THRESHOLD + 60_000);
      });
      try {
        expect(aged.left).toEqual(['5.9.0']);
        expect(aged.moved).toEqual(['5.7.0', '5.8.0']);
        const backup = readdirSync(backupDir(aged.dir)).find((n) => n.startsWith('5.7.0-')) ?? '';
        expect(lstatSync(path.join(backupDir(aged.dir), backup)).isSymbolicLink()).toBe(true);
        expect(existsSync(path.join(aged.cache, '5.9.0', 'package.json'))).toBe(true);
      } finally {
        clean(aged.dir);
      }
    }
  });

  test('a redirect to a directory outside the cache follows the same rule, and moving the old one leaves the outside tree alone', () => {
    for (const command of commands) {
      for (const age of [0, HOUR]) {
        const out = run(command, (cache, dir) => {
          const outside = path.join(dir, 'outside');
          mkdirSync(outside);
          writeFileSync(path.join(outside, 'file.txt'), 'x');
          // The files of the target are old, the link is new or old: only the link counts.
          date(path.join(outside, 'file.txt'), HOUR);
          date(outside, HOUR);
          link(path.join('..', '..', '..', '..', 'outside'), path.join(cache, '5.7.0'));
          if (age) date(path.join(cache, '5.7.0'), age);
        });
        try {
          expect({ age, kept: out.left.includes('5.7.0'), moved: out.moved.includes('5.7.0') }).toEqual({ age, kept: age === 0, moved: age !== 0 });
          expect(existsSync(path.join(out.dir, 'outside', 'file.txt'))).toBe(true);
        } finally {
          clean(out.dir);
        }
      }
    }
  });

  test('an old redirect is moved as the link even when its target tree was modified a moment ago', () => {
    for (const command of commands) {
      const out = run(command, (cache) => {
        link('5.8.0', path.join(cache, '5.7.0'));
        date(path.join(cache, '5.7.0'), HOUR);
        // 5.8.0 is a real directory that was just written: it is left alone by the same rule, the redirect to it is not.
        writeFileSync(path.join(cache, '5.8.0', 'new.txt'), 'x');
      });
      try {
        expect(out.moved).toEqual(['5.7.0']);
        expect(out.left).toEqual(['5.8.0', '5.9.0']);
      } finally {
        clean(out.dir);
      }
    }
  });

  // A junction cannot be created without an existing target on Windows, so the dangling case runs on POSIX only.
  test.skipIf(process.platform === 'win32')('a dangling redirect is dated by itself: a new one stays, an old one is moved, neither is an error', () => {
    for (const command of commands) {
      for (const age of [0, HOUR]) {
        const out = run(command, (cache) => {
          symlinkSync('no-such-version', path.join(cache, '5.7.0'));
          if (age) date(path.join(cache, '5.7.0'), age);
        });
        try {
          expect({ age, kept: out.left.includes('5.7.0'), moved: out.moved.includes('5.7.0') }).toEqual({ age, kept: age === 0, moved: age !== 0 });
          expect(out.result.stdout).not.toMatch(/Could not judge/);
          expect(out.result.stdout).not.toMatch(/Cache move failed/);
          expect(movedAside(out.dir)).toBe(age ? 2 : 1);
        } finally {
          clean(out.dir);
        }
      }
    }
  });
});
