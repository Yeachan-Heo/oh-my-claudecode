import { describe, test, expect } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { addCache, backupDir, bashBlocks, commands, guideSection, makeCache, movedAside, PLUGIN_ID, runBlock, runCommand, skillText, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

// Where a version is moved aside is as much a part of "reversible and outside the cache" as the version that is moved: a
// link in the way of the backup directory (plugins/backups, or its child oh-my-claudecode) may lead into a cached
// version, where the only recovery copy would be removed or relinked by the next cleanup. Every destination of a write,
// move, copy or mkdir that the doctor makes or tells the model to make is resolved through its links first and kept apart
// from every cache and source tree; a destination that cannot be resolved is refused like an overlap. Links are made with
// symlinkSync, which needs no privilege on POSIX only, so the whole file is POSIX only (a Windows junction cannot be made
// without a target).
const posix = process.platform !== 'win32';
const PLATFORMS = ['linux', 'darwin'] as const;
const GONE = 'no-such-target';
// A volume that ignores letter case names one directory by two spellings, so the case test below cannot run on it.
const foldsCase = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
  try {
    mkdirSync(path.join(probe, 'a'));
    return existsSync(path.join(probe, 'A'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const platformPreload = (dir: string, name: string) => {
  const file = path.join(dir, `platform-${name}.cjs`);
  writeFileSync(file, `Object.defineProperty(process, 'platform', { value: '${name}' });\n`);
  return file;
};
const link = (target: string, at: string) => {
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at);
};
// 5.8.0 is pinned, 5.7.0 and 5.9.0 are free and old; `saved` is a directory inside the pinned version.
const profile = () => {
  const { dir, cache } = makeCache(['5.7.0', '5.8.0', '5.9.0']);
  writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] });
  const inside = path.join(cache, '5.8.0', 'saved');
  mkdirSync(inside, { recursive: true });
  return { dir, cache, inside };
};
const ALL = ['5.7.0', '5.8.0', '5.9.0'];
const REFUSED = /Nothing moved: the backup directory \S+ (?:\(really \S+\) )?(?:is, or lies inside,|contains) (the plugin cache|the marketplace clones|the occupancy records|the plugin root|an install path of the registry) \(/;

interface Case {
  name: string;
  // Makes the destination; returns the directories that must stay empty, the tree the message names and the environment.
  make: (dir: string, cache: string, inside: string) => { watch: string[]; tree: string; env?: Record<string, string>; extra?: Record<string, unknown>; installPath?: string };
}
const cases: Case[] = [
  {
    name: 'plugins/backups is a link to a directory inside the pinned 5.8.0 (the example of the review)',
    make: (dir, _cache, inside) => {
      link(inside, path.join(dir, 'plugins', 'backups'));
      return { watch: [inside], tree: 'the plugin cache' };
    },
  },
  {
    name: 'its child oh-my-claudecode is such a link',
    make: (dir, _cache, inside) => {
      link(inside, path.join(dir, 'plugins', 'backups', 'oh-my-claudecode'));
      return { watch: [inside], tree: 'the plugin cache' };
    },
  },
  {
    name: 'a chain of three links ends inside the pinned version',
    make: (dir, _cache, inside) => {
      link(inside, path.join(dir, 'hop2'));
      link(path.join(dir, 'hop2'), path.join(dir, 'hop1'));
      link(path.join(dir, 'hop1'), path.join(dir, 'plugins', 'backups'));
      return { watch: [inside], tree: 'the plugin cache' };
    },
  },
  {
    name: 'a link to a directory inside the install path of another plugin',
    make: (dir) => {
      const other = path.join(dir, 'other-plugin', 'saved');
      mkdirSync(other, { recursive: true });
      link(other, path.join(dir, 'plugins', 'backups'));
      return { watch: [other], tree: 'an install path of the registry', extra: { 'other@market': [{ scope: 'user', version: '1.0.0', installPath: path.join(dir, 'other-plugin') }] } };
    },
  },
  {
    name: 'a link to a directory inside a pin whose install path is a checkout outside the cache',
    make: (dir) => {
      const saved = path.join(dir, 'checkout', 'saved');
      mkdirSync(saved, { recursive: true });
      link(saved, path.join(dir, 'plugins', 'backups'));
      return { watch: [saved], tree: 'an install path of the registry', installPath: path.join(dir, 'checkout') };
    },
  },
  {
    name: 'a link to a directory inside the plugin root of the session (OMC_PLUGIN_ROOT)',
    make: (dir) => {
      const saved = path.join(dir, 'root', 'saved');
      mkdirSync(saved, { recursive: true });
      link(saved, path.join(dir, 'plugins', 'backups'));
      return { watch: [saved], tree: 'the plugin root', env: { OMC_PLUGIN_ROOT: path.join(dir, 'root') } };
    },
  },
  {
    name: 'a link to a directory inside a marketplace clone',
    make: (dir) => {
      const saved = path.join(dir, 'plugins', 'marketplaces', 'omc', 'saved');
      mkdirSync(saved, { recursive: true });
      link(saved, path.join(dir, 'plugins', 'backups'));
      return { watch: [saved], tree: 'the marketplace clones' };
    },
  },
  {
    name: 'a link to the directory of the occupancy records',
    make: (dir) => {
      const records = path.join(dir, '.omc', 'cache-occupancy');
      mkdirSync(records, { recursive: true });
      link(records, path.join(dir, 'plugins', 'backups'));
      return { watch: [records], tree: 'the occupancy records' };
    },
  },
  {
    // The other direction: the destination is above the cache, so the cache lies inside it.
    name: 'the child is a link to the plugins directory, which holds the cache (a tree inside the destination)',
    make: (dir) => {
      link(path.join(dir, 'plugins'), path.join(dir, 'plugins', 'backups', 'oh-my-claudecode'));
      return { watch: [], tree: 'the plugin cache' };
    },
  },
];

describe.skipIf(!posix)('omc-doctor: the backup directory is resolved first and kept apart from every cache and source tree', { timeout: 180_000 }, () => {
  test.each(cases)('both cache commands refuse, with exit code 1, a named destination and tree and nothing moved, when $name', (item) => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const probe = profile();
        const { dir, cache, inside } = probe;
        const made = item.make(dir, cache, inside);
        // A registry that names another plugin or another install path is written again, the link stays.
        if (made.extra || made.installPath) writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath: made.installPath ?? path.join(cache, '5.8.0') }], ...(made.extra ?? {}) });
        try {
          const result = runCommand(command, dir, { preloads: [platformPreload(dir, platform)], env: made.env, timeout: 20_000 });
          const hit = REFUSED.exec(result.stdout);
          expect({ command, platform, status: result.status, tree: hit?.[1] }).toEqual({ command, platform, status: 1, tree: made.tree });
          expect(result.stdout).toContain(path.join(dir, 'plugins', 'backups'));
          expect(readdirSync(cache).sort()).toEqual(ALL);
          for (const watched of made.watch) expect({ watched, entries: readdirSync(watched) }).toEqual({ watched, entries: [] });
          expect(result.stdout).not.toMatch(/Moved \d/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // A cache namespace that is itself a link out of plugins/cache has its versions somewhere else: the plugin cache tree
  // as written does not hold them, so the namespace is a tree of its own and a destination inside it is refused.
  test.each([
    ['the namespace directory (plugins/cache/omc)', 'omc'],
    ['the plugin directory (plugins/cache/omc/oh-my-claudecode)', 'omc/oh-my-claudecode'],
  ])('a backup directory inside an unpinned version of a cache that %s relocated by a link is refused, nothing moved', (_name, moved) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const relocated = path.join(dir, 'relocated', moved);
        mkdirSync(path.dirname(relocated), { recursive: true });
        renameSync(path.join(dir, 'plugins', 'cache', moved), relocated);
        link(relocated, path.join(dir, 'plugins', 'cache', moved));
        const free = path.join(realpathSync(cache), '5.9.0');
        link(free, path.join(dir, 'plugins', 'backups'));
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, tree: REFUSED.exec(result.stdout)?.[1] }).toEqual({ command, status: 1, tree: 'the plugin cache' });
        expect(readdirSync(cache).sort()).toEqual(ALL);
        expect(result.stdout).not.toMatch(/Moved \d/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A cache root that can be searched but not listed (mode 0111, or an ACL that says so) hides its namespaces: one of them may hold the tree the backup
  // directory leads into, and the next cleanup of the payload removes a recovery copy there. The listing that fails is played by a preload, so the
  // case holds for a process that ignores the mode bits (root) too.
  test.each([['EACCES'], ['EPERM'], ['EIO']])('a plugin cache that cannot be listed (%s) is refused before anything is moved, as the overlap is where the listing works', (code) => {
    for (const command of commands) {
      for (const listed of [false, true]) {
        const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
        try {
          // A namespace that is a link out of the cache: only the listing of the cache root finds it.
          const hidden = path.join(dir, 'elsewhere', '9.9.9', 'skill-bodies', 'omc-doctor');
          mkdirSync(hidden, { recursive: true });
          link(path.join(dir, 'elsewhere'), path.join(dir, 'plugins', 'cache', 'other-namespace'));
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0', installPath: path.join(cache, '5.9.0') }] });
          link(hidden, path.join(dir, 'plugins', 'backups'));
          const preload = path.join(dir, 'unlistable.cjs');
          writeFileSync(preload, `const fs = require('fs'); const real = fs.readdirSync;\nfs.readdirSync = function (target, ...rest) {\n  if (!process.env.LISTABLE && String(target) === process.env.UNLISTABLE) throw Object.assign(new Error('${code}'), { code: '${code}' });\n  return real.call(this, target, ...rest);\n};\n`);
          const result = runCommand(command, dir, { preloads: [preload], env: { UNLISTABLE: path.join(dir, 'plugins', 'cache'), ...(listed ? { LISTABLE: '1' } : {}) }, timeout: 20_000 });
          // Listed, the namespace is found and the backup directory inside it is the overlap refusal; unlisted, the refusal says why.
          expect({ command, listed, status: result.status, said: result.stdout.includes('could not be read completely'), overlap: REFUSED.test(result.stdout), cache: readdirSync(cache).sort(), landed: readdirSync(hidden) })
            .toEqual({ command, listed, status: 1, said: !listed, overlap: listed, cache: ['5.8.0', '5.9.0'], landed: [] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The same for a namespace of the cache that the registry does not name: no cache command reads it, so the listing of the backup check is the only one
  // that can fail, and a version link inside it may lead to the tree the backup directory is in. A regular file among the namespaces (a stray file
  // of a file manager) hides nothing and is no refusal.
  test.each([['EACCES'], ['EPERM'], ['EIO']])('a cache namespace outside the registry that cannot be listed (%s) is refused before anything is moved, as the overlap is where the listing works', (code) => {
    for (const command of commands) {
      for (const listed of [false, true]) {
        const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
        try {
          const space = path.join(dir, 'plugins', 'cache', 'other-market', 'oh-my-claudecode');
          const hidden = path.join(dir, 'elsewhere', '9.9.9', 'skill-bodies', 'omc-doctor');
          mkdirSync(hidden, { recursive: true });
          link(path.join(dir, 'elsewhere', '9.9.9'), path.join(space, '9.9.9'));
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0', installPath: path.join(cache, '5.9.0') }] });
          link(hidden, path.join(dir, 'plugins', 'backups'));
          const preload = path.join(dir, 'unlistable.cjs');
          writeFileSync(preload, `const fs = require('fs'); const real = fs.readdirSync;\nfs.readdirSync = function (target, ...rest) {\n  if (!process.env.LISTABLE && String(target) === process.env.UNLISTABLE) throw Object.assign(new Error('${code}'), { code: '${code}' });\n  return real.call(this, target, ...rest);\n};\n`);
          const result = runCommand(command, dir, { preloads: [preload], env: { UNLISTABLE: space, ...(listed ? { LISTABLE: '1' } : {}) }, timeout: 20_000 });
          expect({ command, listed, status: result.status, said: result.stdout.includes('could not be read completely'), overlap: REFUSED.test(result.stdout), cache: readdirSync(cache).sort(), landed: readdirSync(hidden) })
            .toEqual({ command, listed, status: 1, said: !listed, overlap: listed, cache: ['5.8.0', '5.9.0'], landed: [] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a regular file among the namespaces of the cache is no refusal: the cleanup goes on', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
      try {
        writeFileSync(path.join(dir, 'plugins', 'cache', 'stray-file'), 'not a namespace');
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0', installPath: path.join(cache, '5.9.0') }] });
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, cache: readdirSync(cache).sort(), moved: movedAside(dir) }).toEqual({ command, status: 0, cache: ['5.9.0'], moved: 1 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A rename cannot cross a file system. A destination on another device than the cache (reported here by a preload that
  // gives everything under the vault another device number) is refused before the directory is created, not half way.
  test('a redirected backup directory on another file system than the cache is refused before anything is created or moved', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const vault = path.join(dir, 'vault');
        mkdirSync(vault, { recursive: true });
        link(vault, path.join(dir, 'plugins', 'backups'));
        const preload = path.join(dir, 'other-device.cjs');
        writeFileSync(preload, `const fs = require('fs');\nconst real = fs.statSync;\nfs.statSync = function (target, options) {\n  const stat = real.apply(this, arguments);\n  if (stat && String(target).includes(${JSON.stringify(path.sep + 'vault')}) && typeof stat.dev == 'bigint') stat.dev += 7n;\n  return stat;\n};\n`);
        const result = runCommand(command, dir, { preloads: [preload], timeout: 20_000 });
        expect({ command, status: result.status }).toEqual({ command, status: 1 });
        expect(result.stdout).toMatch(/Nothing moved: the backup directory \S+ \(really \S+\) is on another file system than the cache/);
        expect(result.stdout).not.toMatch(/Cache move failed|Moved \d/);
        expect(readdirSync(cache).sort()).toEqual(ALL);
        expect(readdirSync(vault)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test.each([
    ['plugins/backups is a link to nothing', (dir: string) => link(GONE, path.join(dir, 'plugins', 'backups')), /a link on the way to it points at nothing/],
    ['its child oh-my-claudecode is a link to nothing', (dir: string) => link(GONE, path.join(dir, 'plugins', 'backups', 'oh-my-claudecode')), /a link on the way to it points at nothing/],
    [
      'plugins/backups is a loop of two links',
      (dir: string) => {
        link('loop-b', path.join(dir, 'plugins', 'backups'));
        link('backups', path.join(dir, 'plugins', 'loop-b'));
      },
      /a link loop, or a part of the path that cannot be examined/,
    ],
  ])('a destination that cannot be resolved is refused with its cause, nothing moved: %s', (_name, make, cause) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        make(dir);
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, refused: /Nothing moved: the backup directory /.test(result.stdout), cause: cause.test(result.stdout) }).toEqual({ command, status: 1, refused: true, cause: true });
        expect(readdirSync(cache).sort()).toEqual(ALL);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Where the file system reports no identity for the cache (inode 0, as some volumes that ignore letter case do), a
  // destination that differs from the cache only by letter case may be the cache itself: it cannot be compared, so it is
  // refused like an overlap. On this volume plugins/CACHE is another directory, which is what makes the case testable.
  test.skipIf(foldsCase)('a destination that differs from the cache only by letter case, where the cache has no identity, is refused as not comparable', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const stash = path.join(dir, 'plugins', 'CACHE', 'stash');
        mkdirSync(stash, { recursive: true });
        link(stash, path.join(dir, 'plugins', 'backups'));
        const file = path.join(dir, 'zero-inode-cache.cjs');
        writeFileSync(file, `const fs = require('fs');
for (const name of ['statSync', 'lstatSync']) {
  const real = fs[name];
  fs[name] = function (target, options) {
    const stat = real.call(fs, target, options);
    if (options && options.bigint && /[\\\\/]plugins[\\\\/]cache(?![^\\\\/])/.test(String(target))) stat.ino = 0n;
    return stat;
  };
}
`);
        const result = runCommand(command, dir, { preloads: [file], timeout: 20_000 });
        expect({ command, status: result.status, refused: /Nothing moved: the file system gives no identity to the backup directory \S+ \(really \S+\) or to /.test(result.stdout) }).toEqual({ command, status: 1, refused: true });
        expect(readdirSync(cache).sort()).toEqual(ALL);
        expect(readdirSync(stash)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The tests run as root, which ignores permissions, so the error is injected for the examination of plugins/backups.
  test.each(['EACCES', 'EIO'])('a destination that cannot be examined (%s) is refused like an overlap, nothing moved', (code) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const file = path.join(dir, 'examine-errors.cjs');
        writeFileSync(file, `const fs = require('fs'), path = require('path');
const real = fs.lstatSync;
fs.lstatSync = function (target, ...rest) {
  if (path.resolve(String(target)) === ${JSON.stringify(path.join(dir, 'plugins', 'backups'))}) { const error = new Error('${code}: injected'); error.code = '${code}'; throw error; }
  return real.call(fs, target, ...rest);
};
`);
        const result = runCommand(command, dir, { preloads: [file], timeout: 20_000 });
        expect({ command, status: result.status, refused: /Nothing moved: the backup directory \S+ cannot be resolved \(a link loop, or a part of the path that cannot be examined\)/.test(result.stdout) }).toEqual({ command, status: 1, refused: true });
        expect(readdirSync(cache).sort()).toEqual(ALL);
        expect(result.stdout).not.toMatch(/Moved \d/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A version directory that is itself a link out of the cache (a pin by version alone, no install path, no root variable naming the target)
  // has its tree somewhere else: a destination inside that tree is as unsafe as one inside the cache, since the next same-version install clears it.
  test('a version directory that is a link out of the cache is a tree of its own, and a backup directory inside it is refused', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.9.0']);
      try {
        const outside = path.join(dir, 'elsewhere', 'omc-5.8.0');
        mkdirSync(path.join(outside, 'skill-bodies', 'omc-doctor'), { recursive: true });
        writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ version: '5.8.0' }));
        link(outside, path.join(cache, '5.8.0'));
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
        link(path.join(outside, 'skill-bodies', 'omc-doctor'), path.join(dir, 'plugins', 'backups'));
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, refused: REFUSED.test(result.stdout), cache: readdirSync(cache).sort(), landed: readdirSync(path.join(outside, 'skill-bodies', 'omc-doctor')) })
          .toEqual({ command, status: 1, refused: true, cache: ['5.8.0', '5.9.0'], landed: [] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a link that leads outside every tree still works, and the Moved line names the real directory; no link says nothing of the kind', () => {
    for (const command of commands) {
      for (const via of ['plugins/backups', 'plugins/backups/oh-my-claudecode', 'none'] as const) {
        const { dir, cache } = profile();
        try {
          const vault = path.join(dir, 'vault');
          mkdirSync(vault, { recursive: true });
          if (via != 'none') link(vault, path.join(dir, via));
          const result = runCommand(command, dir, { timeout: 20_000 });
          expect({ command, via, status: result.status }).toEqual({ command, via, status: 0 });
          expect(readdirSync(cache).sort()).toEqual(['5.8.0']);
          const real = via == 'plugins/backups' ? path.join(realpathSync(vault), 'oh-my-claudecode') : via == 'none' ? backupDir(dir) : realpathSync(vault);
          const held = readdirSync(real).map((name) => name.replace(/-\d+$/, '')).sort();
          expect({ command, via, held }).toEqual({ command, via, held: ['5.7.0', '5.9.0'] });
          for (const name of readdirSync(real)) expect(existsSync(path.join(real, name, 'package.json'))).toBe(true);
          const moved = new RegExp(`Moved 2 unprotected version\\(s\\) to ${backupDir(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(really ${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\))?[. \\n]`);
          const line = moved.exec(result.stdout + '\n');
          expect({ command, via, found: line !== null, names: line?.[1] !== undefined }).toEqual({ command, via, found: true, names: via != 'none' });
          if (via == 'none') expect(movedAside(dir)).toBe(2);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // An active root that holds the whole configuration directory (the plugin root variable set to it) already holds the
  // default destination: no link made that, so the cleanup goes on. A link that leads into the pinned version from there
  // is still refused, because the cache tree holds the destination.
  test('a plugin root that holds the configuration directory is no overlap by itself, and a link into the cache under it is still refused', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        for (const linked of [false, true]) {
          const { dir, cache, inside } = profile();
          try {
            if (linked) link(inside, path.join(dir, 'plugins', 'backups'));
            const result = runCommand(command, dir, { preloads: [platformPreload(dir, platform)], env: { CLAUDE_PLUGIN_ROOT: dir }, timeout: 20_000 });
            const tree = REFUSED.exec(result.stdout)?.[1];
            expect({ command, platform, linked, status: result.status, tree, left: readdirSync(cache).sort() }).toEqual(
              linked ? { command, platform, linked, status: 1, tree: 'the plugin cache', left: ALL } : { command, platform, linked, status: 0, tree: undefined, left: ['5.8.0'] },
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });

  // A root that holds the configuration directory (here the configuration lives in <root>/.claude) excuses only the destination that the
  // configuration writes inside it. A link at plugins/backups that leads somewhere else inside the root is a redirect that a link made, and the
  // payload of the root (skill-bodies) is cleared by the next same-version sync, so a copy there is refused. A root reached through a link is
  // no redirect: the destination is where the configuration puts it.
  test.each([['plain', false], ['redirected inside the root', true], ['root given through a link', false]] as const)('a plugin root that holds the configuration directory excuses the written destination only: %s', (mode, redirected) => {
    for (const command of commands) {
      const base = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
      const real = path.join(base, 'root');
      const root = mode == 'root given through a link' ? path.join(base, 'via') : real;
      try {
        if (root != real) symlinkSync(real, root);
        const cache = addCache(path.join(real, '.claude'), ['5.7.0', '5.8.0', '5.9.0']);
        writeRegistry(path.join(real, '.claude'), { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] });
        const bodies = path.join(real, 'skill-bodies', 'omc-doctor');
        mkdirSync(bodies, { recursive: true });
        if (redirected) link(bodies, path.join(real, '.claude', 'plugins', 'backups'));
        const result = runCommand(command, path.join(root, '.claude'), { env: { OMC_PLUGIN_ROOT: root }, timeout: 20_000 });
        expect({ command, mode, status: result.status, tree: REFUSED.exec(result.stdout)?.[1], left: readdirSync(cache).sort(), landed: readdirSync(bodies) }).toEqual(
          redirected ? { command, mode, status: 1, tree: 'the plugin root', left: ALL, landed: [] } : { command, mode, status: 0, tree: undefined, left: ['5.8.0'], landed: [] },
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });

  // The check runs again before each move: a link put in place after the first move (by a session, an update or the user)
  // turns the rest of the run into a failed move with exit code 1, and what is not moved stays in the cache.
  test('a destination that becomes a link into the cache after the first move stops the run: the second version stays', () => {
    const swap = `const fs = require('fs'); const real = fs.renameSync; let calls = 0;
fs.renameSync = function (...args) {
  const result = real.apply(this, args);
  calls += 1;
  if (calls === 1) { real.call(fs, process.env.SWAP_FROM, process.env.SWAP_FROM + '.moved'); fs.symlinkSync(process.env.SWAP_TO, process.env.SWAP_FROM); }
  return result;
};
`;
    for (const command of commands) {
      const { dir, cache, inside } = profile();
      try {
        const preload = path.join(dir, 'swap.cjs');
        writeFileSync(preload, swap);
        const from = path.join(dir, 'plugins', 'backups');
        const result = runCommand(command, dir, { preloads: [preload], env: { SWAP_FROM: from, SWAP_TO: inside }, timeout: 20_000 });
        expect({ command, status: result.status, failed: /Cache move failed \(1 moved before the error\): the backup directory changed or overlaps a cache tree now/.test(result.stdout) }).toEqual({ command, status: 1, failed: true });
        expect(readdirSync(cache).sort()).toHaveLength(2);
        expect(readdirSync(inside)).toEqual([]);
        expect(readdirSync(path.join(from + '.moved', 'oh-my-claudecode'))).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The registry is read again with every recheck: an install path that another process registers after the destination was
  // chosen (here the backup directory itself, for another plugin) stops the run before the next version is moved.
  test('a registry that gains an install path equal to the backup directory after the first move stops the run: the second version stays', () => {
    const change = `const fs = require('fs'); const real = fs.renameSync; let calls = 0;
fs.renameSync = function (...args) {
  const result = real.apply(this, args);
  calls += 1;
  if (calls === 1) fs.writeFileSync(process.env.REGISTRY_FILE, process.env.REGISTRY_NEXT);
  return result;
};
`;
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const preload = path.join(dir, 'change-registry.cjs');
        writeFileSync(preload, change);
        const next = JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }], 'other-plugin@market': [{ scope: 'user', installPath: backupDir(dir) }] } });
        const result = runCommand(command, dir, { preloads: [preload], env: { REGISTRY_FILE: path.join(dir, 'plugins', 'installed_plugins.json'), REGISTRY_NEXT: next }, timeout: 20_000 });
        expect({ command, status: result.status, failed: /Cache move failed \(1 moved before the error\)/.test(result.stdout) }).toEqual({ command, status: 1, failed: true });
        expect(readdirSync(cache).sort()).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('the shell block of the skill gives the same refusal as the script on the same fixture', () => {
    for (const command of commands) {
      const { dir, cache, inside } = profile();
      try {
        link(inside, path.join(dir, 'plugins', 'backups'));
        const result = runBlock(command, dir, { timeout: 30_000 });
        expect({ command, status: result.status, refused: REFUSED.test(result.stdout) }).toEqual({ command, status: 1, refused: true });
        expect(readdirSync(cache).sort()).toEqual(ALL);
        expect(readdirSync(inside)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// The backups of the shell blocks: K of the legacy cleanup (a new sibling name in the configuration directory, made by
// mkdir without -p after a check that nothing is there, not even a link) and the copy of CLAUDE.md that the skill describes.
// The destination of both is a name that did not exist, directly in the configuration directory, so no link can lead it
// anywhere; what can lead somewhere is the source of the list form, a name that is a link to another directory.
describe.skipIf(!posix)('omc-doctor: the shell blocks that move a file aside', { timeout: 120_000 }, () => {
  const legacy = bashBlocks().filter((block) => block.includes('# Never rm -rf here'))[0] ?? '';
  const defs = legacy.split('\n').filter((line) => line && !line.startsWith('#')).join('\n');
  const bash = (dir: string, script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir } });
  // A configuration directory whose commands is a link to a directory inside the pinned cache version.
  const fixture = () => {
    const { dir, cache } = makeCache(['5.8.0']);
    const target = path.join(cache, '5.8.0', 'commands');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'deepsearch.md'), 'shipped');
    writeFileSync(path.join(target, 'custom.md'), 'mine');
    link(target, path.join(dir, 'commands'));
    return { dir, target };
  };
  const copies = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('commands.bak'));

  test('the list form refuses a name that is a link: no file leaves the link target, nothing is created', () => {
    const { dir, target } = fixture();
    try {
      const run = bash(dir, defs + '\nK commands deepsearch.md; echo "status=$?"');
      expect(run.stdout.trim()).toBe('status=1');
      expect(run.stderr).toMatch(/Nothing moved: .*commands is a link/);
      expect(readdirSync(target).sort()).toEqual(['custom.md', 'deepsearch.md']);
      expect(copies(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the whole-root form moves the link itself: the sibling copy is the link, the tree it leads to is untouched', () => {
    const { dir, target } = fixture();
    try {
      const run = bash(dir, defs + '\nK commands; echo "status=$?"');
      expect({ out: run.stdout.trim(), err: run.stderr }).toEqual({ out: 'status=0', err: '' });
      const [copy] = copies(dir);
      expect(copies(dir)).toHaveLength(1);
      expect(lstatSync(path.join(dir, copy)).isSymbolicLink()).toBe(true);
      expect(existsSync(path.join(dir, 'commands'))).toBe(false);
      expect(readdirSync(target).sort()).toEqual(['custom.md', 'deepsearch.md']);
      expect(readFileSync(path.join(target, 'deepsearch.md'), 'utf8')).toBe('shipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a real directory still works in the list form, and the copy is a new directory directly in the configuration directory', () => {
    const { dir } = makeCache(['5.8.0']);
    try {
      mkdirSync(path.join(dir, 'commands'), { recursive: true });
      writeFileSync(path.join(dir, 'commands', 'deepsearch.md'), 'shipped');
      writeFileSync(path.join(dir, 'commands', 'custom.md'), 'mine');
      const run = bash(dir, defs + '\nK commands deepsearch.md; echo "status=$?"');
      expect({ out: run.stdout.trim(), err: run.stderr }).toEqual({ out: 'status=0', err: '' });
      expect(readdirSync(path.join(dir, 'commands'))).toEqual(['custom.md']);
      const [copy] = copies(dir);
      expect(readdirSync(path.join(dir, copy))).toEqual(['deepsearch.md']);
      expect(lstatSync(path.join(dir, copy)).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the rules are written where the model reads them: the skill, the guide, the CLAUDE.md copy and K', () => {
    expect(skillText).toContain('The command resolves that directory through every link on the way before the first move and refuses (exit code 1, nothing moved) when it is, lies inside or contains a cache, marketplace, plugin root, occupancy or registered install tree, or cannot be resolved');
    expect(skillText).toContain('outside `plugins/cache/` and resolved before the first move');
    expect(guideSection('cache-guard')).toContain('The backup directory is settled before the first move.');
    expect(guideSection('cache-guard')).toContain('every `installPath` of the registry');
    expect(guideSection('cache-guard')).toContain('with no link involved (a plugin root that is the configuration directory itself), is no reason to refuse');
    expect(skillText).toContain('The copy is a new regular file in the configuration directory itself, also when CLAUDE.md is a link');
    expect(skillText).toContain('If CLAUDE.md is a link that leads into `plugins/cache` or `plugins/marketplaces` of the configuration directory, write nothing and say where it leads');
    expect(defs).toContain('[ ! -L "$C/$N" ]');
  });
});

// Text is not a path: a tree whose path is only the beginning of the text of another path (`/x/plug` and `/x/plug-config`)
// is another directory. It neither holds the destination nor excuses a link into it, so the comparison of two paths looks
// for the separator that ends a name. And the Moved line names the real directory (really) only when a link at
// plugins/backups or below it leads somewhere else, never for a configuration directory that was given through a link:
// that is where the configuration lives, not a redirect of the backup directory.
describe.skipIf(!posix)('omc-doctor: a path that only starts like a tree is not inside it, and (really) names a redirect of the backup directory only', { timeout: 180_000 }, () => {
  // A directory whose path is the configuration directory's path without its last character, with a `saved` directory in it.
  const lookalike = (dir: string) => {
    const root = dir.slice(0, -1);
    mkdirSync(path.join(root, 'saved'), { recursive: true });
    return root;
  };

  test('a plugin root that starts like the configuration directory is no overlap: the cleanup goes on', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      const root = lookalike(dir);
      try {
        const result = runCommand(command, dir, { env: { OMC_PLUGIN_ROOT: root }, timeout: 20_000 });
        expect({ command, status: result.status, left: readdirSync(cache).sort(), moved: movedAside(dir) }).toEqual({ command, status: 0, left: ['5.8.0'], moved: 2 });
        expect(result.stdout).not.toMatch(REFUSED);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('a link into a plugin root that starts like the configuration directory is still refused, and nothing is moved', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      const root = lookalike(dir);
      try {
        link(path.join(root, 'saved'), path.join(dir, 'plugins', 'backups'));
        const result = runCommand(command, dir, { env: { OMC_PLUGIN_ROOT: root }, timeout: 20_000 });
        expect({ command, status: result.status, tree: REFUSED.exec(result.stdout)?.[1], left: readdirSync(cache).sort(), held: readdirSync(path.join(root, 'saved')) }).toEqual({ command, status: 1, tree: 'the plugin root', left: ALL, held: [] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('a configuration directory given through a link is no redirect: the Moved line has no (really), the versions are in the real directory', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      const via = `${dir}-via`;
      try {
        symlinkSync(dir, via);
        const result = runCommand(command, via, { timeout: 20_000 });
        expect({ command, status: result.status, left: readdirSync(cache).sort(), moved: movedAside(dir) }).toEqual({ command, status: 0, left: ['5.8.0'], moved: 2 });
        expect(result.stdout).toContain(`Moved 2 unprotected version(s) to ${path.join(via, 'plugins', 'backups', 'oh-my-claudecode')}`);
        expect(result.stdout).not.toContain('(really');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(via, { force: true });
      }
    }
  });
});
