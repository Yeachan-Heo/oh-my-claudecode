import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCache, ageVersions, backupDir, commands, digitVersions, makeCache, movedAside, PLUGIN_ID, read, runCommand, upperBelow, volumeFoldsCase, writeCaseFoldPreload, writeRegistry, writeZeroInodePreload } from './helpers/omc-doctor-cache-fixture.js';

const step1Command = read('skills/omc-doctor/SKILL.md').split('\n').find((l) => l.startsWith('node -e ') && l.includes("'Updater: ")) ?? '';
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;

// A preload makes the process report another platform; the volume under it stays the real one.
const reportAs = (dir: string, platform: string) => {
  const file = path.join(dir, `platform-${platform}.cjs`);
  writeFileSync(file, `Object.defineProperty(process, 'platform', { value: '${platform}' });\n`);
  return file;
};
const makeRoot = (dir: string, relative: string, version: string) => {
  const at = path.join(dir, relative);
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, 'package.json'), JSON.stringify({ version }));
  return at;
};

// Runs the Step 1 command on a synthetic configuration directory and returns its `Label: value` lines.
// `extraPreloads` makes the volume behave differently (written into the directory before the run).
function step1(platform: string, setup: (dir: string) => { plugins?: Record<string, unknown>; env: Record<string, string> }, extraPreloads: (dir: string) => string[] = () => []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-case-'));
  try {
    mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    const { plugins, env } = setup(dir);
    if (plugins) writeRegistry(dir, plugins);
    const result = runCommand(step1Command, dir, { env, preloads: [reportAs(dir, platform), ...extraPreloads(dir)], timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return Object.fromEntries(result.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Two existing directories that differ only in letter case are two directories on a volume that tells letter case
// apart (ext4, a case-sensitive APFS volume), whatever platform name the process reports: the commands tell paths
// apart by device and inode and never fold letter case by the name of the platform. A volume that ignores letter
// case cannot hold both directories, so these cases need a case-sensitive test volume; the aliases of a volume that
// ignores case are covered by the identity cases of the other omc-doctor suites.
describe.skipIf(volumeFoldsCase())('omc-doctor on a volume that tells letter case apart, under every platform name', { timeout: 120_000 }, () => {
  test('Step 1: the registry install and the explicit root differ only in letter case, so the root is a checkout of its own', () => {
    for (const exists of [true, false]) {
      for (const platform of PLATFORMS) {
        let checkout = '';
        const out = step1(platform, (dir) => {
          // `cfg/Foo` is the registry install (present or stale); `cfg/foo` is a different directory that exists.
          const installPath = exists ? makeRoot(dir, 'cfg/Foo', '5.8.0') : path.join(dir, 'cfg', 'Foo');
          checkout = makeRoot(dir, 'cfg/foo', '9.9.0');
          return { plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath }] }, env: { OMC_PLUGIN_ROOT: checkout } };
        });
        expect({ exists, platform, channel: out.Channel, installed: out.Installed, root: out['Plugin root'] })
          .toEqual({ exists, platform, channel: 'plugin-dir', installed: '9.9.0', root: checkout });
      }
    }
  });

  test('Step 1: a root in a tree that differs from plugins/cache only in letter case is not a registry install', () => {
    for (const platform of PLATFORMS) {
      let checkout = '';
      const out = step1(platform, (dir) => {
        const installPath = makeRoot(dir, 'plugins/cache/omc/oh-my-claudecode/5.8.0', '5.8.0');
        checkout = makeRoot(dir, 'Plugins/cache/omc/oh-my-claudecode/9.9.0', '9.9.0');
        return { plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath }] }, env: { OMC_PLUGIN_ROOT: checkout } };
      });
      expect({ platform, channel: out.Channel, installed: out.Installed, root: out['Plugin root'] })
        .toEqual({ platform, channel: 'plugin-dir', installed: '9.9.0', root: checkout });
    }
  });

  test('Step 1: the two variables naming directories that differ only in letter case are a conflict', () => {
    for (const platform of PLATFORMS) {
      const out = step1(platform, (dir) => ({ env: { OMC_PLUGIN_ROOT: makeRoot(dir, 'cfg/Foo', '9.9.0'), CLAUDE_PLUGIN_ROOT: makeRoot(dir, 'cfg/foo', '5.1.0') } }));
      expect({ platform, keys: Object.keys(out) }).toEqual({ platform, keys: ['Channel'] });
      expect(out.Channel).toContain('different directories');
    }
  });

  test('Step 1: Installed comes from the entry whose install path is the root, not from an entry that differs in letter case', () => {
    for (const platform of PLATFORMS) {
      const out = step1(platform, (dir) => {
        const upper = makeRoot(dir, 'cfg/Foo', '5.9.0');
        const lower = makeRoot(dir, 'cfg/foo', '5.7.0');
        return {
          plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0', installPath: upper }, { scope: 'project', version: '5.7.0', installPath: lower }] },
          env: { OMC_PLUGIN_ROOT: lower },
        };
      });
      expect({ platform, channel: out.Channel, installed: out.Installed }).toEqual({ platform, channel: 'marketplace omc', installed: '5.7.0' });
    }
  });

  test('cache commands: the two variables naming directories that differ only in letter case are a conflict, so nothing moves', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        // 5.8.0 is pinned (that is what lets the move loop run), 5.7.0 is free.
        const { dir, cache } = makeCache(['5.7.0', '5.8.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const env = { OMC_PLUGIN_ROOT: makeRoot(dir, 'Foo', '1.0.0'), CLAUDE_PLUGIN_ROOT: makeRoot(dir, 'foo', '1.0.0') };
          const result = runCommand(command, dir, { env, preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ platform, status: 0, versions: '5.7.0,5.8.0', moved: 0 });
          expect(result.stdout).toContain('Nothing moved');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('cache commands: a pin names the version directory of exactly that spelling when two differ only in letter case', () => {
    const cases: Array<{ pins: string[]; kept: string }> = [
      { pins: ['5.9.0-beta', '5.9.0-BETA'], kept: '5.9.0-BETA,5.9.0-beta' },
      { pins: ['5.9.0-BETA'], kept: '5.9.0-BETA' },
      { pins: ['5.9.0-beta'], kept: '5.9.0-beta' },
    ];
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        for (const { pins, kept } of cases) {
          const { dir, cache } = makeCache(['5.1.0', '5.9.0-beta', '5.9.0-BETA']);
          try {
            writeRegistry(dir, { [PLUGIN_ID]: pins.map((version) => ({ scope: 'user', version })) });
            const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
            expect({ platform, pins, status: result.status, versions: digitVersions(cache) }).toEqual({ platform, pins, status: 0, versions: kept });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });
});

// An occupancy record as the publisher of SessionStart writes it: the plugin root in the form of `pathIdentity`
// (resolved, in lower case on win32). The record is of this live process, so it is kept while the process lives.
function writeRecord(dir: string, root: string) {
  const record = { version: 1, pid: process.pid, pluginRoot: root, updatedAt: new Date().toISOString() };
  const directory = path.join(dir, '.omc', 'cache-occupancy');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${createHash('sha256').update(JSON.stringify(record)).digest('hex')}.json`), JSON.stringify(record));
}

// The runtime reads the records of win32 in lower case, so the commands also protect by that form on win32 and nowhere else.
// The case-sensitive test volume cannot name the lower-case path of a mixed-case directory, so the identity of the path
// never answers here and only the form of the record can.
describe('omc-doctor occupancy records in the form the win32 publisher writes them', { timeout: 120_000 }, () => {
  test('a record in lower case protects the version it names under win32, and under another platform only where the volume folds case', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        for (const suffix of ['', 'scripts']) {
          // The directory name has upper case letters, so its lower-case spelling differs on a volume that tells the cases apart.
          const dir = mkdtempSync(path.join(tmpdir(), 'Omc-Doctor-Mixed-'));
          try {
            const cache = addCache(dir, ['5.1.0', '5.8.0', '5.9.0']);
            mkdirSync(path.join(cache, '5.9.0', 'scripts'), { recursive: true });
            ageVersions(cache);
            writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
            const root = path.join(cache, '5.9.0', suffix);
            expect(root.toLowerCase()).not.toBe(root);
            writeRecord(dir, root.toLowerCase());
            const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
            expect({ platform, suffix, status: result.status, versions: digitVersions(cache) })
              .toEqual({ platform, suffix, status: 0, versions: platform === 'win32' || volumeFoldsCase() ? '5.8.0,5.9.0' : '5.8.0' });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });
});

describe('omc-doctor occupancy records alone pin nothing, also in the form the win32 publisher writes them', { timeout: 120_000 }, () => {
  test('a lower-case record of a version, with no registry pin, moves nothing under any platform name', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const dir = mkdtempSync(path.join(tmpdir(), 'Omc-Doctor-Mixed-'));
        try {
          const cache = addCache(dir, ['5.1.0', '5.8.0', '5.9.0']);
          writeRecord(dir, path.join(cache, '5.9.0').toLowerCase());
          const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ platform, status: 0, versions: '5.1.0,5.8.0,5.9.0', moved: 0 });
          expect(result.stdout).toContain('Nothing moved');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
});

// A file system that reports inode 0 gives no identity, and the commands then guess nothing from the spelling of a path. A path
// is judged by its exact text only when that text lies inside a cache version (or above the cache directory, where it names no
// version); every other path that protects or may protect a version could be another name of one, so the command prints
// `Nothing moved: identity unavailable` and moves nothing. The one exception is a record under win32, which the commands also
// match in the lower-case form the publisher writes. The case fold preload makes the case-sensitive test volume ignore letter
// case, the zero inode preload takes the identity away; both do no harm on a volume that really behaves so.
describe('omc-doctor on a volume that ignores letter case and reports inode 0 fails closed', { timeout: 120_000 }, () => {
  const volume = (dir: string) => [writeCaseFoldPreload(dir), writeZeroInodePreload(dir)];
  const STOPPED = 'Nothing moved: identity unavailable';
  // The live version has letters in its name, so another spelling of its name exists (a pin names a version by its text).
  const LIVE = '5.9.0-beta';
  const SOURCES = ['installPath of a pin', 'installPath of another plugin', 'OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'occupancy record', 'pinned version'] as const;
  type Source = typeof SOURCES[number];

  // 5.1.0 is pinned, 5.8.0 and the live version are free; the live version is named only through `target`, spelled as given by the caller.
  function protect(dir: string, source: Source, target: string): Record<string, string> {
    const registry: Record<string, unknown> = { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }] };
    if (source === 'installPath of a pin') registry[PLUGIN_ID] = [{ scope: 'user', version: '5.1.0' }, { scope: 'user', installPath: target }];
    if (source === 'installPath of another plugin') registry['other-plugin@market'] = [{ scope: 'user', installPath: target }];
    if (source === 'pinned version') registry[PLUGIN_ID] = [{ scope: 'user', version: '5.1.0' }, { scope: 'user', version: target }];
    if (source === 'occupancy record') writeRecord(dir, target);
    writeRegistry(dir, registry);
    if (source === 'OMC_PLUGIN_ROOT') return { OMC_PLUGIN_ROOT: target };
    if (source === 'CLAUDE_PLUGIN_ROOT') return { CLAUDE_PLUGIN_ROOT: target };
    return {};
  }

  test('a path that names a cached version in another letter case stops the command, whatever protects it, except a record under win32', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        for (const source of SOURCES) {
          const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
          try {
            const target = source === 'pinned version' ? LIVE.toUpperCase() : upperBelow(dir, path.join(cache, LIVE));
            const env = protect(dir, source, target);
            const result = runCommand(command, dir, { env, preloads: [reportAs(dir, platform), ...volume(dir)] });
            const decided = source === 'occupancy record' && platform === 'win32';
            expect({ source, platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) })
              .toEqual({ source, platform, status: 0, versions: decided ? `5.1.0,${LIVE}` : `5.1.0,5.8.0,${LIVE}`, moved: decided ? 1 : 0, reason: !decided });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });

  test('a path that names the cached version by its exact text still protects it, and the free versions still move', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        for (const source of SOURCES) {
          const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
          try {
            const env = protect(dir, source, source === 'pinned version' ? LIVE : path.join(cache, LIVE));
            const result = runCommand(command, dir, { env, preloads: [reportAs(dir, platform), ...volume(dir)] });
            expect({ source, platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) })
              .toEqual({ source, platform, status: 0, versions: `5.1.0,${LIVE}`, moved: 1, reason: false });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });

  test('a path inside the cached version by its exact text protects it, also with a name that does not exist', () => {
    for (const command of commands) {
      for (const inside of ['scripts', path.join('scripts', 'missing')]) {
        const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
        try {
          mkdirSync(path.join(cache, LIVE, 'scripts'), { recursive: true });
          ageVersions(cache);
          const env = protect(dir, 'OMC_PLUGIN_ROOT', path.join(cache, LIVE, inside));
          const result = runCommand(command, dir, { env, preloads: volume(dir) });
          expect({ inside, versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) }).toEqual({ inside, versions: `5.1.0,${LIVE}`, moved: 1, reason: false });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a path inside the cached version in another letter case, also one that does not exist, stops the command', () => {
    for (const command of commands) {
      for (const inside of ['scripts', path.join('scripts', 'missing')]) {
        const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
        try {
          mkdirSync(path.join(cache, LIVE, 'scripts'), { recursive: true });
          ageVersions(cache);
          const env = protect(dir, 'OMC_PLUGIN_ROOT', upperBelow(dir, path.join(cache, LIVE, inside)));
          const result = runCommand(command, dir, { env, preloads: volume(dir) });
          expect({ inside, versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) }).toEqual({ inside, versions: `5.1.0,5.8.0,${LIVE}`, moved: 0, reason: true });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a path outside the cache that exists stops the command, a path that names nothing does not', () => {
    for (const command of commands) {
      for (const outside of ['exists', 'missing'] as const) {
        const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
        try {
          const target = outside === 'exists' ? makeRoot(dir, 'checkout', '9.9.0') : path.join(dir, 'gone', 'plugin');
          const env = protect(dir, 'installPath of another plugin', target);
          const result = runCommand(command, dir, { env, preloads: volume(dir) });
          // A stale install path under the cache directory itself (the version was deleted) names nothing either.
          expect({ outside, versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) })
            .toEqual(outside === 'exists' ? { outside, versions: `5.1.0,5.8.0,${LIVE}`, moved: 0, reason: true } : { outside, versions: '5.1.0', moved: 2, reason: false });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a path that names nothing, with the root of the file system as its only existing part, does not stop the command', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
      try {
        const env = protect(dir, 'installPath of another plugin', path.join(path.parse(dir).root, 'omc-doctor-gone-root-entry', 'plugin'));
        const result = runCommand(command, dir, { env, preloads: volume(dir) });
        expect({ versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) }).toEqual({ versions: '5.1.0', moved: 2, reason: false });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a stale pin of a deleted version in the cache directory stays harmless where the file system reports inode 0', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.1.0', '5.8.0']);
      try {
        const env = protect(dir, 'installPath of a pin', path.join(cache, '5.0.0'));
        const result = runCommand(command, dir, { env, preloads: volume(dir) });
        expect({ versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) }).toEqual({ versions: '5.1.0', moved: 1, reason: false });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Identity is used only where both sides of a comparison have one: cached versions that report none cannot be compared with a
  // path that reports one, so such a path stops the command too (nothing is assumed about which volume it is on).
  test('cached versions without identity and a protecting path outside the cache that has one stop the command', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
      try {
        const cacheOnly = path.join(dir, 'zero-inode-cache-only.cjs');
        writeFileSync(cacheOnly, `const fs = require('fs');
for (const name of ['statSync', 'lstatSync']) {
  const real = fs[name];
  fs[name] = function (target, options) {
    const stat = real.call(fs, target, options);
    if (options && options.bigint && /[\\\\/]plugins[\\\\/]cache[\\\\/]/.test(String(target))) stat.ino = 0n;
    return stat;
  };
}
`);
        const env = protect(dir, 'OMC_PLUGIN_ROOT', makeRoot(dir, 'checkout', '9.9.0'));
        const result = runCommand(command, dir, { env, preloads: [cacheOnly] });
        expect({ versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) }).toEqual({ versions: `5.1.0,5.8.0,${LIVE}`, moved: 0, reason: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The protection is read again just before each move: a record published after the first read, which names a cached version
  // in another letter case where no identity is reported, makes the second read undecided, so every free version is skipped.
  test('a record that appears after the first read and cannot be judged skips the versions instead of moving them', () => {
    const racePreload = `const fs = require('fs'), path = require('path'), crypto = require('crypto');
const realMkdir = fs.mkdirSync;
let fired = false;
fs.mkdirSync = function (target, ...rest) {
  if (!fired && String(target) === process.env.RACE_BACKUP) {
    fired = true;
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, '.omc', 'cache-occupancy');
    realMkdir.call(fs, dir, { recursive: true });
    const record = JSON.stringify({ version: 1, pid: process.pid, pluginRoot: process.env.RACE_ROOT, updatedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, crypto.createHash('sha256').update(record).digest('hex') + '.json'), record);
  }
  return realMkdir.call(fs, target, ...rest);
};
`;
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.1.0' }] });
          const race = path.join(dir, 'race.cjs');
          writeFileSync(race, racePreload);
          const env = { RACE_BACKUP: backupDir(dir), RACE_ROOT: upperBelow(dir, path.join(cache, LIVE)) };
          const result = runCommand(command, dir, { env, preloads: [reportAs(dir, platform), ...volume(dir), race] });
          // Under win32 the record is read in lower case, so it is judged and the one free version moves.
          const decided = platform === 'win32';
          expect({ platform, versions: digitVersions(cache), moved: movedAside(dir) })
            .toEqual({ platform, versions: decided ? `5.1.0,${LIVE}` : `5.1.0,5.8.0,${LIVE}`, moved: decided ? 1 : 0 });
          if (!decided) expect(result.stdout).toMatch(/Skipped 2 version\(s\)/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('the two variables naming one directory by two spellings are a conflict, so nothing moves', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.0', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          const env = { OMC_PLUGIN_ROOT: path.join(cache, '5.9.0'), CLAUDE_PLUGIN_ROOT: upperBelow(dir, path.join(cache, '5.9.0')) };
          const result = runCommand(command, dir, { env, preloads: [reportAs(dir, platform), ...volume(dir)] });
          expect({ platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ platform, status: 0, versions: '5.7.0,5.8.0,5.9.0', moved: 0 });
          expect(result.stdout).toContain('Nothing moved');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // A `stat` that fails for the path gives no identity either: an exact spelling still protects, another spelling stops the command.
  test('a stat that fails for a protecting path gives no identity: another spelling stops the command, the exact spelling protects', () => {
    for (const command of commands) {
      for (const spelling of ['exact', 'other letter case'] as const) {
        const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
        try {
          const failing = path.join(dir, 'stat-fails.cjs');
          writeFileSync(failing, `const fs = require('fs');
const real = fs.lstatSync;
fs.lstatSync = function (target, options) {
  if (options && options.bigint && /5[.]9[.]0-/i.test(String(target))) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
  return real.call(fs, target, options);
};
`);
          const target = spelling === 'exact' ? path.join(cache, LIVE) : upperBelow(dir, path.join(cache, LIVE));
          const env = protect(dir, 'OMC_PLUGIN_ROOT', target);
          const result = runCommand(command, dir, { env, preloads: [writeCaseFoldPreload(dir), failing] });
          expect({ spelling, versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) })
            .toEqual(spelling === 'exact' ? { spelling, versions: `5.1.0,${LIVE}`, moved: 1, reason: false } : { spelling, versions: `5.1.0,5.8.0,${LIVE}`, moved: 0, reason: true });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The two variables are diagnosed only by Step 1 and never decide a move: a registry install that Step 1 cannot tell from a
  // checkout (another letter case of a path under plugins/cache where no inode is reported) reads as plugin-dir, which sends
  // nobody to the cache commands; the commands judge every path themselves, as above.
  test('Step 1: a root in another letter case than plugins/cache is a checkout there, the exact spelling is the registry install', () => {
    for (const platform of PLATFORMS) {
      for (const spelling of ['exact', 'other letter case'] as const) {
        const out = step1(platform, (dir) => {
          const install = makeRoot(dir, 'plugins/cache/omc/oh-my-claudecode/5.8.0', '5.8.0');
          return { plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] }, env: { OMC_PLUGIN_ROOT: spelling === 'exact' ? install : upperBelow(dir, install) } };
        }, volume);
        expect({ platform, spelling, channel: out.Channel }).toEqual({ platform, spelling, channel: spelling === 'exact' ? 'marketplace omc' : 'plugin-dir' });
      }
    }
  });
});
