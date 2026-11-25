import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCache, ageVersions, backupDir, CLAUDE_MD_VERSION, commands, digitVersions, makeCache, movedAside, PLUGIN_ID, runCommand, STEP1, upperBelow, volumeFoldsCase, writeCaseFoldPreload, writeRegistry, writeZeroInodePreload } from './helpers/omc-doctor-cache-fixture.js';

const step1Command = STEP1;
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;

// A preload makes the process report another platform; the volume under it stays the real one.
const reportAs = (dir: string, platform: string) => {
  const file = path.join(dir, `platform-${platform}.cjs`);
  writeFileSync(file, `Object.defineProperty(process, 'platform', { value: '${platform}' });\n`);
  return file;
};
// On Windows `path.relative` ignores letter case, so a root in another letter case is text inside the omc cache there (the runtime and the doctor
// both classify a root by that text). This preload gives a process that reports win32 the same comparison on a host whose `path` tells case apart;
// on a real Windows host it changes nothing.
const foldPathPreload = (dir: string) => {
  const file = path.join(dir, 'fold-path.cjs');
  writeFileSync(file, `const path = require('path');
if (path.relative('a', 'A') !== '') {
  const real = path.relative;
  path.relative = (from, to) => real(String(from).toLowerCase(), String(to).toLowerCase());
}
`);
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
          expect({ platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ platform, status: 1, versions: '5.7.0,5.8.0', moved: 0 });
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

describe('omc-doctor a lower-case record names a directory, not the beginning of a text', { timeout: 120_000 }, () => {
  test('a record that only starts like a version directory protects nothing, under win32 as under another platform', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const dir = mkdtempSync(path.join(tmpdir(), 'Omc-Doctor-Mixed-'));
        try {
          const cache = addCache(dir, ['5.1.0', '5.8.0', '5.9.0']);
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] });
          writeRecord(dir, path.join(cache, '5.9.0x').toLowerCase());
          const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, versions: digitVersions(cache) }).toEqual({ platform, status: 0, versions: '5.8.0' });
        } finally {
          rmSync(dir, { recursive: true, force: true });
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
        // Skipped on purpose on a host that really is Windows, not to hide a failure: the fixtures are real directories, and Node names a real directory on a Windows disk only by a drive letter or a share (C:\..., C:/..., \\server\...), so no POSIX-style path can name it. The commands read such a path as foreign when the process reports linux or darwin and refuse it on purpose, so these combinations mean nothing there. The same rules run on Linux and macOS, and the win32 combinations run on every host.
        if (process.platform === 'win32' && platform !== 'win32') continue;
        for (const source of SOURCES) {
          const { dir, cache } = makeCache(['5.1.0', '5.8.0', LIVE]);
          try {
            const target = source === 'pinned version' ? LIVE.toUpperCase() : upperBelow(dir, path.join(cache, LIVE));
            const env = protect(dir, source, target);
            const result = runCommand(command, dir, { env, preloads: [reportAs(dir, platform), ...volume(dir)] });
            const decided = source === 'occupancy record' && platform === 'win32';
            expect({ source, platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir), reason: result.stdout.includes(STOPPED) })
              .toEqual({ source, platform, status: decided ? 0 : 1, versions: decided ? `5.1.0,${LIVE}` : `5.1.0,5.8.0,${LIVE}`, moved: decided ? 1 : 0, reason: !decided });
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
        // Skipped on purpose on a host that really is Windows, not to hide a failure: the fixtures are real directories, and Node names a real directory on a Windows disk only by a drive letter or a share (C:\..., C:/..., \\server\...), so no POSIX-style path can name it. The commands read such a path as foreign when the process reports linux or darwin and refuse it on purpose, so these combinations mean nothing there. The same rules run on Linux and macOS, and the win32 combinations run on every host.
        if (process.platform === 'win32' && platform !== 'win32') continue;
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
          expect({ platform, status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ platform, status: 1, versions: '5.7.0,5.8.0,5.9.0', moved: 0 });
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

  // Step 1 compares paths: the plugin root variables with each other, with the install a registry entry names and with the
  // plugin cache. Where the file system gives a path no identity, two spellings of one directory cannot be told from two
  // directories by the file system, so each comparison answers yes, no or unknown: the same real path is yes, a path that
  // differs from the other by more than letter case and Unicode form is no, and a pair that differs by those alone is
  // unknown. Unknown is neither a checkout nor a registry install: the channel is unknown, so no label sends the user to
  // the wrong update path (a checkout has none) and the lines a label would hide or show are not printed. The commands judge
  // every path themselves, as above, and refuse in the same place.
  const BLIND = /^unknown \(the file system gives no identity to a plugin root or an install path whose spelling differs from another only in letter case or Unicode form/;
  const unknownChannel = (out: Record<string, string>) => ({ lines: Object.keys(out), blind: BLIND.test(out.Channel ?? '') });
  const UNKNOWN = { lines: ['Channel'], blind: true };
  const installAt = (dir: string, version = '5.8.0') => makeRoot(dir, `plugins/cache/omc/oh-my-claudecode/${version}`, version);
  const entryOf = (install: string, version = '5.8.0') => ({ scope: 'user', version, installPath: install });
  const pinned = (install: string, version = '5.8.0') => ({ [PLUGIN_ID]: [entryOf(install, version)] });
  const withClone = (dir: string) => {
    mkdirSync(path.join(dir, 'plugins', 'marketplaces', 'omc', '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(dir, 'plugins', 'marketplaces', 'omc', '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'omc', plugins: [{ name: 'oh-my-claudecode', version: '5.9.0' }] }));
  };
  // The fixtures are real directories: a host that really is Windows names one only by a drive letter or a share, so no
  // POSIX-style path can name it there. Skipped on purpose on such a host for the platform names it cannot be, not to hide a failure.
  const hostCannot = (platform: string) => process.platform === 'win32' && platform !== 'win32';

  test('Step 1: a root in another letter case than plugins/cache is unknown there, the exact spelling is the registry install', () => {
    for (const platform of PLATFORMS) {
      for (const spelling of ['exact', 'other letter case'] as const) {
        const out = step1(platform, (dir) => {
          const install = installAt(dir);
          return { plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0' }] }, env: { OMC_PLUGIN_ROOT: spelling === 'exact' ? install : upperBelow(dir, install) } };
        }, volume);
        if (spelling === 'exact') expect({ platform, channel: out.Channel }).toEqual({ platform, channel: 'marketplace omc' });
        else expect({ platform, ...unknownChannel(out) }).toEqual({ platform, ...UNKNOWN });
      }
    }
  });

  test('Step 1: the registry install named in another letter case by OMC_PLUGIN_ROOT is neither a checkout nor an install, whatever the entry names', () => {
    for (const platform of PLATFORMS) {
      if (hostCannot(platform)) continue;
      const out = step1(platform, (dir) => {
        withClone(dir);
        return { plugins: pinned(installAt(dir)), env: { OMC_PLUGIN_ROOT: upperBelow(dir, path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0')) } };
      }, volume);
      expect({ platform, ...unknownChannel(out) }).toEqual({ platform, ...UNKNOWN });
      expect(out.Channel).not.toContain('plugin-dir');
    }
  });

  test('Step 1: the same real path is one directory whatever the identity, and a path that differs by more than letter case is another one', () => {
    for (const platform of PLATFORMS) {
      if (hostCannot(platform)) continue;
      for (const spelled of ['exact', 'dot segment and trailing separator'] as const) {
        const out = step1(platform, (dir) => {
          withClone(dir);
          const install = installAt(dir);
          return { plugins: pinned(install), env: { OMC_PLUGIN_ROOT: spelled === 'exact' ? install : `${path.dirname(install)}${path.sep}.${path.sep}5.8.0${path.sep}` } };
        }, volume);
        expect({ platform, spelled, channel: out.Channel, installed: out.Installed, latest: out.Latest, updater: out.Updater })
          .toEqual({ platform, spelled, channel: 'marketplace omc', installed: '5.8.0', latest: '5.9.0 (marketplace clone)', updater: 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode@omc' });
      }
      // Another cache version is another directory: a checkout, as it was before the answer could be unknown.
      const checkout = step1(platform, (dir) => {
        installAt(dir, '5.7.0');
        return { plugins: pinned(installAt(dir)), env: { OMC_PLUGIN_ROOT: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.0') } };
      }, volume);
      expect({ platform, channel: checkout.Channel }).toEqual({ platform, channel: 'plugin-dir' });
      // CLAUDE_PLUGIN_ROOT is how Claude Code names the install it runs; the entry of another scope names another directory,
      // which does not make the match unknown.
      const live = step1(platform, (dir) => {
        installAt(dir, '5.7.0');
        const install = installAt(dir);
        return { plugins: { [PLUGIN_ID]: [entryOf(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.0'), '5.7.0'), entryOf(install)] }, env: { CLAUDE_PLUGIN_ROOT: install } };
      }, volume);
      expect({ platform, channel: live.Channel, installed: live.Installed }).toEqual({ platform, channel: 'marketplace omc', installed: '5.8.0' });
    }
  });

  // Text is not a path: where no identity is reported the comparison folds the text, and the root Claude Code runs whose path only
  // starts like the install path (`.../5.8.0-extra` and `.../5.8.0`) is another directory, not a spelling of it, so the channel
  // is not unknown (it is the registry install, as nothing says the session runs another one).
  test('Step 1: a root whose path only starts like the install path is another directory, also where no identity is reported', () => {
    for (const platform of PLATFORMS) {
      if (hostCannot(platform)) continue;
      const out = step1(platform, (dir) => {
        withClone(dir);
        const install = installAt(dir);
        installAt(dir, '5.8.0-extra');
        return { plugins: pinned(install), env: { CLAUDE_PLUGIN_ROOT: `${install}-extra` } };
      }, volume);
      expect({ platform, channel: out.Channel, installed: out.Installed }).toEqual({ platform, channel: 'marketplace omc', installed: '5.8.0' });
    }
  });

  test('Step 1: the install Claude Code runs (CLAUDE_PLUGIN_ROOT) in another letter case than its registry entry cannot be matched to it', () => {
    for (const platform of PLATFORMS) {
      if (hostCannot(platform)) continue;
      const out = step1(platform, (dir) => ({ plugins: pinned(installAt(dir)), env: { CLAUDE_PLUGIN_ROOT: upperBelow(dir, path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0')) } }), volume);
      expect({ platform, ...unknownChannel(out) }).toEqual({ platform, ...UNKNOWN });
    }
  });

  test('Step 1: the two root variables name one directory in two letter cases (unknown), two other directories (different) or one path (the same)', () => {
    for (const platform of PLATFORMS) {
      if (hostCannot(platform)) continue;
      const roots = (second: (dir: string, install: string) => string) => step1(platform, (dir) => {
        const install = installAt(dir);
        installAt(dir, '5.7.0');
        return { plugins: pinned(install), env: { OMC_PLUGIN_ROOT: install, CLAUDE_PLUGIN_ROOT: second(dir, install) } };
      }, volume);
      const alias = roots((dir, install) => upperBelow(dir, install));
      expect({ platform, ...unknownChannel(alias) }).toEqual({ platform, ...UNKNOWN });
      expect(alias.Channel).not.toContain('different directories');
      expect({ platform, channel: roots((dir) => path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.0')).Channel })
        .toEqual({ platform, channel: 'unknown (OMC_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT name different directories; do not guess an updater)' });
      expect({ platform, channel: roots((dir, install) => install).Channel }).toEqual({ platform, channel: 'marketplace omc' });
    }
  });

  test('Step 1: a registry that cannot be read leaves a root in another letter case under plugins/cache unknown and a checkout elsewhere a checkout', () => {
    for (const platform of PLATFORMS) {
      if (hostCannot(platform)) continue;
      const unreadable = (dir: string) => writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), '{not json');
      const inCache = step1(platform, (dir) => {
        unreadable(dir);
        return { env: { OMC_PLUGIN_ROOT: upperBelow(dir, installAt(dir)) } };
      }, volume);
      expect({ platform, ...unknownChannel(inCache) }).toEqual({ platform, ...UNKNOWN });
      const elsewhere = step1(platform, (dir) => {
        unreadable(dir);
        return { env: { OMC_PLUGIN_ROOT: makeRoot(dir, 'checkout', '9.9.0') } };
      }, volume);
      expect({ platform, channel: elsewhere.Channel, installed: elsewhere.Installed }).toEqual({ platform, channel: 'plugin-dir', installed: '9.9.0' });
    }
  });

  // Step 4 reads the cache of the marketplace whose entry holds the plugin root the session runs. Where that cannot be told
  // (the root is another letter case of the entry's install and the volume gives no identity) it names no cache and skips
  // the check, as Step 1 names no channel. Where `path` tells case apart (every host but Windows) that spelling is no text inside the omc cache, so the
  // root is read through its own package, which names no version here; under win32 it is text inside the cache and the unknown identity alone decides.
  test('Step 4 chooses no cache where the plugin root cannot be matched to an entry, and chooses one for the exact spelling', () => {
    for (const platform of PLATFORMS) {
      if (hostCannot(platform)) continue;
      for (const spelling of ['exact', 'other letter case'] as const) {
        const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-case-'));
        try {
          mkdirSync(path.join(dir, 'plugins'), { recursive: true });
          const install = installAt(dir);
          writeRegistry(dir, pinned(install));
          writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- OMC:VERSION:5.8.0 -->\n');
          const result = runCommand(CLAUDE_MD_VERSION, dir, { env: { CLAUDE_PLUGIN_ROOT: spelling === 'exact' ? install : upperBelow(dir, install) }, preloads: [reportAs(dir, platform), ...(platform === 'win32' ? [foldPathPreload(dir)] : []), ...volume(dir)], timeout: 20_000 });
          expect(result.error).toBeUndefined();
          expect({ platform, spelling, lines: result.stdout.trim().split('\n').slice(2) }).toEqual({
            platform,
            spelling,
            lines: spelling === 'exact'
              ? ['Latest cached plugin version: 5.8.0', 'VERSION MATCH: CLAUDE and plugin cache are aligned']
              : platform === 'win32'
                ? ['Latest cached plugin version: (unknown)', 'VERSION CHECK SKIPPED: which plugin install the session runs is unknown (the file system gives no identity to a plugin root or an install path), so no cache is chosen']
                : ['Latest cached plugin version: (unknown)', 'VERSION CHECK SKIPPED: the plugin root the session runs lies outside the plugin cache and its manifest names no usable version, so no cache is chosen'],
          });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // Among the entries of one plugin ID a certain match decides, but a match that is unknown for another plugin ID leaves open
  // which marketplace the session runs: Step 1 and Step 4 both say so, whichever ID comes first in the registry.
  test('with two plugin IDs, a match that is unknown for one makes Step 1 and Step 4 unknown although the other is certain', () => {
    const OWN = 'oh-my-claudecode@oh-my-claudecode';
    for (const platform of PLATFORMS) {
      if (hostCannot(platform)) continue;
      for (const order of [[PLUGIN_ID, OWN], [OWN, PLUGIN_ID]]) {
        const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-case-'));
        try {
          mkdirSync(path.join(dir, 'plugins'), { recursive: true });
          const install = installAt(dir);
          const entries: Record<string, unknown[]> = { [PLUGIN_ID]: [entryOf(install)], [OWN]: [entryOf(upperBelow(dir, install))] };
          writeRegistry(dir, Object.fromEntries(order.map((id) => [id, entries[id]])));
          writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- OMC:VERSION:5.8.0 -->\n');
          const preloads = [reportAs(dir, platform), ...volume(dir)];
          const env = { CLAUDE_PLUGIN_ROOT: install };
          const channel = runCommand(step1Command, dir, { env, preloads, timeout: 20_000 });
          expect({ platform, order, lines: channel.stdout.trim().split('\n').length, blind: BLIND.test(channel.stdout.trim().replace(/^Channel: /, '')) }).toEqual({ platform, order, lines: 1, blind: true });
          const drift = runCommand(CLAUDE_MD_VERSION, dir, { env, preloads, timeout: 20_000 });
          expect({ platform, order, lines: drift.stdout.trim().split('\n').slice(2) }).toEqual({
            platform,
            order,
            lines: ['Latest cached plugin version: (unknown)', 'VERSION CHECK SKIPPED: which plugin install the session runs is unknown (the file system gives no identity to a plugin root or an install path), so no cache is chosen'],
          });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
});
