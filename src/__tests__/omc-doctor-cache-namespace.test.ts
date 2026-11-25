import { describe, test, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCache, backupDir, CACHE_VERSIONS, CLAUDE_MD_VERSION, codeOf, commands, makeCache, movedAside, PLUGIN_ID, runBlock, runCommand, scriptSection, scriptText, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1 } from './helpers/omc-doctor-step1.js';

// Step 4 prints the highest cached plugin version and compares it with the CLAUDE.md marker; Step 6 counts the cached versions.
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;
const OMC = 'oh-my-claudecode@omc';
const OWN = 'oh-my-claudecode@oh-my-claudecode';
const BARE = 'oh-my-claudecode';

// A preload makes the process report another platform; the volume under it stays the real one.
const reportAs = (dir: string, platform: string) => {
  const file = path.join(dir, `platform-${platform}.cjs`);
  writeFileSync(file, `Object.defineProperty(process, 'platform', { value: '${platform}' });\n`);
  return file;
};

const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-namespace-'));
  mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  return dir;
};

// Step 4 is a shell block of the skill (the locator line and the call), so it runs through bash.
function claudeMd(dir: string, marker: string, platform: string = process.platform): string[] {
  writeFileSync(path.join(dir, 'CLAUDE.md'), `<!-- OMC:VERSION:${marker} -->\n`);
  const run = runBlock(CLAUDE_MD_VERSION, dir, { env: { NODE_OPTIONS: `--require ${reportAs(dir, platform)}` }, timeout: 20_000 });
  expect(run.error).toBeUndefined();
  return run.stdout.trim().split('\n');
}

// Step 4 as the script runs it, with the plugin root variables the session would have (the skill's block cannot start the
// script from a root that holds none, so this runs the command itself). Returns the lines after the two that name the marker.
function claudeMdAt(dir: string, marker: string, platform: string, env: Record<string, string>): string[] {
  writeFileSync(path.join(dir, 'CLAUDE.md'), `<!-- OMC:VERSION:${marker} -->\n`);
  const run = runCommand(CLAUDE_MD_VERSION, dir, { env, preloads: [reportAs(dir, platform)], timeout: 20_000 });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  return run.stdout.trim().split('\n').slice(2);
}

const count = (dir: string, plugins?: Record<string, unknown>, platform: string = process.platform) => {
  if (plugins) writeRegistry(dir, plugins);
  const run = runCommand(CACHE_VERSIONS, dir, { timeout: 20_000, preloads: [reportAs(dir, platform)] });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  return run.stdout.trim().split('\n').map((l) => l.replace(/(version\(s\): )(.*)/, (_m, head: string, list: string) => head + list.split(', ').sort().join(', ')));
};

// The commands share the code of the script: one version-name test and one marketplace derivation, each defined once.
// These tests keep what the definitions say and that every command uses them.
describe('omc-doctor: the script holds one definition of a version name and of the marketplace list', () => {
  test('every command exists', () => {
    expect(commands).toHaveLength(2);
    const dispatch = scriptSection('dispatch');
    for (const command of ['step1', 'npm-latest', 'claude-md-optout', 'claude-md-version', 'cache-versions', ...commands]) expect({ command, found: dispatch.includes(command) }).toEqual({ command, found: true });
  });

  test('the version-name test is defined once and excludes a relink recovery directory', () => {
    const definitions = scriptText.split('\n').filter((line) => line.startsWith('const isVersionDir'));
    expect(definitions).toEqual([String.raw`const isVersionDir = (name) => semver(name) == name && !/[.]omc-stale-[0-9]+(?![^])/.test(name);`]);
    // Step 1 (highestCached, which the npm channel and Step 4 use), Step 6 and the function both cache commands share
    // list version directories through versionDirs, the one place that applies it (and requires a directory), and nothing else lists them.
    expect(scriptText.split('.filter(isVersionDir)').length - 1).toBe(1);
    expect(scriptText.split('versionDirs(').length - 1).toBe(3);
  });

  test('no command filters a cache listing by its own copy of the digit test', () => {
    expect(/filter\(\(?\w+\)? => \/\^(\\d|\[0-9\])/.test(codeOf())).toBe(false);
  });

  test('Steps 4 and 6 derive the marketplace list in the same way and keep the last occurrence of an ID', () => {
    expect(scriptText.split('const registryMarketplaces = ')).toHaveLength(2);
    expect(scriptSection('marketplaces of the registry')).toContain('lastIndexOf');
    expect(scriptSection('Step 4')).toContain('registryMarketplaces()');
    expect(scriptSection('Step 6')).toContain('registryMarketplaces()');
  });

  test('Steps 4 and 6 name no fixed marketplace', () => {
    expect(scriptSection('Step 4')).not.toMatch(/'cache',\s*'omc'/);
    expect(scriptSection('Step 6')).not.toMatch(/'cache',\s*'omc'/);
  });
});

describe('omc-doctor: a recovery directory of an interrupted cache relink is not a cached version', () => {
  // `<version>.omc-stale-<pid>` is what an interrupted relink leaves beside a missing or unusable original path;
  // purgeStalePluginCacheVersions restores it as the only intact copy, so the commands must not move it to the backups.
  test('the cache commands leave it in place beside a missing version, and still move a free version next to it', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        // 5.7.0 is missing, 5.7.0.omc-stale-4242 is its recovery copy and 5.7.0-beta.1.omc-stale-4242 the recovery copy of
        // a prerelease (a semantic version by its name, so only the exclusion keeps it out); 5.9.0 is pinned, 5.8.0 is free.
        const { dir, cache } = makeCache(['5.9.0', '5.8.0', '5.7.0.omc-stale-4242', '5.7.0-beta.1.omc-stale-4242']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
          const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, left: readdirSync(cache).sort(), moved: movedAside(dir) })
            .toEqual({ platform, status: 0, left: ['5.7.0-beta.1.omc-stale-4242', '5.7.0.omc-stale-4242', '5.9.0'], moved: 1 });
          expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.8\.0-/);
          expect(result.stdout).not.toContain('omc-stale');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('nothing is moved when the recovery directory is the only other entry', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const { dir, cache } = makeCache(['5.9.0', '5.7.0.omc-stale-4242', '5.7.0-beta.1.omc-stale-4242']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
          const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, left: readdirSync(cache).sort(), moved: movedAside(dir) })
            .toEqual({ platform, status: 0, left: ['5.7.0-beta.1.omc-stale-4242', '5.7.0.omc-stale-4242', '5.9.0'], moved: 0 });
          expect(result.stdout).toContain('Nothing to move');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The relink reconciler recognises exactly `.omc-stale-` and a decimal pid at the end of the name; a name that only
  // looks like it (and is a semantic version, a prerelease here) is an ordinary version, so it is judged like one.
  // The recovery directory of a prerelease is a semantic version by its name, so only the exclusion keeps it out; the
  // recovery directory of a release is no version by the grammar alone. Both forms are used throughout this file.
  test('only a name that ends in .omc-stale- and a pid is a recovery directory', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const { dir, cache } = makeCache([
          '5.9.0',
          '5.6.0-omc-stale-abc', '5.5.0-omc-stale-12.bak', '5.4.0.omc-stale-7', '5.3.0.omc-stale-0',
          '5.6.0-beta.1.omc-stale-abc', '5.5.0-beta.1.omc-stale-12.bak', '5.4.0-beta.1.omc-stale-7', '5.3.0-beta.1.omc-stale-0',
        ]);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
          const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, left: readdirSync(cache).sort(), moved: movedAside(dir) })
            .toEqual({ platform, status: 0, left: ['5.3.0-beta.1.omc-stale-0', '5.3.0.omc-stale-0', '5.4.0-beta.1.omc-stale-7', '5.4.0.omc-stale-7', '5.9.0'], moved: 4 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('Step 1 does not name it as the newest version', () => {
    for (const platform of PLATFORMS) {
      expect(step1({ platform, cache: { omc: ['5.8.0', '5.9.0.omc-stale-12', '5.9.0-beta.1.omc-stale-12'] } })).toEqual({ Channel: 'npm', Installed: '5.8.0', Updater: 'omc update' });
      expect(step1({ platform, plugins: { [OMC]: [{ installPath: '/nowhere/current' }] }, cache: { omc: ['5.8.0', '5.9.0.omc-stale-12', '5.9.0-beta.1.omc-stale-12'] } }).Installed).toBe('5.8.0');
      // An installPath that names the recovery directory gives no version by its name; the version is read from the package.
      for (const recovery of ['5.9.0.omc-stale-12', '5.9.0-beta.1.omc-stale-12']) {
        const out = step1({
          platform,
          plugins: (dir) => ({ [OMC]: [{ installPath: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', recovery) }] }),
          setup: (dir) => writeFileSync(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', recovery, 'package.json'), JSON.stringify({ version: '5.9.0' })),
          cache: { omc: [recovery] },
        });
        expect({ platform, recovery, installed: out.Installed }).toEqual({ platform, recovery, installed: '5.9.0' });
      }
    }
  });

  test.skipIf(process.platform === 'win32')('Step 4 does not name it as the newest version', () => {
    for (const platform of PLATFORMS) {
      const { dir, cache } = makeCache(['5.8.0', '5.9.0.omc-stale-12', '5.9.0-beta.1.omc-stale-12']);
      try {
        // A recovery copy keeps the package.json of the version it was made from, so it never names its own directory (the runtime counts
        // a directory only when it does).
        writeFileSync(path.join(cache, '5.9.0-beta.1.omc-stale-12', 'package.json'), JSON.stringify({ version: '5.9.0-beta.1' }));
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '0.0.1' }] });
        expect({ platform, out: claudeMd(dir, '5.8.0', platform)[2] }).toEqual({ platform, out: 'Latest cached plugin version: 5.8.0' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('Step 6 does not count it', () => {
    for (const platform of PLATFORMS) {
      const { dir } = makeCache(['5.8.0', '5.9.0.omc-stale-12', '5.9.0-beta.1.omc-stale-12']);
      try {
        expect({ platform, out: count(dir, undefined, platform) }).toEqual({ platform, out: ['1 version(s): 5.8.0'] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// Steps 4 and 6 read the cache of the marketplace that Step 1 names, not a fixed `omc`.
describe('omc-doctor: Steps 4 and 6 follow the marketplace of the supported registry ID', () => {
  const profiles: Array<[string, Record<string, unknown> | undefined, string]> = [
    ['the own marketplace', { [OWN]: [{ scope: 'user', version: '5.8.4' }] }, 'oh-my-claudecode'],
    ['the legacy marketplace', { [OMC]: [{ scope: 'user', version: '5.8.4' }] }, 'omc'],
    ['the bare ID', { [BARE]: [{ scope: 'user', version: '5.8.4' }] }, 'omc'],
    ['a supported ID in upper case', { 'Oh-My-ClaudeCode@Oh-My-ClaudeCode': [{ scope: 'user', version: '5.8.4' }] }, 'oh-my-claudecode'],
    ['no registry', undefined, 'omc'],
    ['an unrelated plugin only', { 'other@market': [{ scope: 'user', version: '1.0.0' }] }, 'omc'],
  ];

  test.skipIf(process.platform === 'win32')('Step 4 names the newest cached version of that marketplace and runs the freshness check', () => {
    for (const [label, plugins, market] of profiles) {
      for (const platform of PLATFORMS) {
        const dir = fresh();
        try {
          addCache(dir, ['5.7.0', '5.8.4'], market);
          if (plugins) writeRegistry(dir, plugins);
          // No supported ID: the session root is the plugin-dir checkout of Step 1 and no cache is a reference for it.
          if (!plugins || !Object.keys(plugins).some((key) => key.toLowerCase().includes('oh-my-claudecode'))) {
            expect({ label, platform, out: claudeMd(dir, '5.8.4', platform).slice(2) }).toEqual({ label, platform, out: ['Latest cached plugin version: (unknown)', expect.stringMatching(/^VERSION CHECK SKIPPED: .*plugin-dir/)] });
            continue;
          }
          // No root that an entry holds (the session sets none): the marketplace of the registry names the cache. A root in the omc cache would be read as the runtime reads it, through the omc cache.
          const noRoot = { CLAUDE_PLUGIN_ROOT: '' };
          expect({ label, platform, out: claudeMdAt(dir, '5.8.4', platform, noRoot) }).toEqual({
            label,
            platform,
            out: ['Latest cached plugin version: 5.8.4', 'VERSION MATCH: CLAUDE and plugin cache are aligned'],
          });
          expect({ label, platform, drift: claudeMdAt(dir, '5.7.0', platform, noRoot) }).toEqual({ label, platform, drift: ['Latest cached plugin version: 5.8.4', 'VERSION DRIFT: CLAUDE.md and plugin versions differ'] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);

  test('Step 6 counts the versions of that marketplace and sees a stale cache', () => {
    for (const [label, plugins, market] of profiles) {
      for (const platform of PLATFORMS) {
        const dir = fresh();
        try {
          addCache(dir, ['5.7.0', '5.8.4'], market);
          expect({ label, platform, out: count(dir, plugins, platform) }).toEqual({ label, platform, out: ['2 version(s): 5.7.0, 5.8.4'] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);

  test('a cache under another marketplace than the registry names is not counted', () => {
    const dir = fresh();
    try {
      addCache(dir, ['5.7.0', '5.8.4'], 'omc');
      expect(count(dir, { [OWN]: [{ scope: 'user', version: '5.8.4' }] })).toEqual(['0 versions']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Step 1 judges every supported ID by itself and the last one is the last line of its output; Step 4 has one line,
  // so the last supported ID whose cache holds a version names it (a marketplace that two IDs share counts at the
  // position of the last of them), and Step 6 prints a line for each marketplace in that order.
  test.skipIf(process.platform === 'win32')('with several supported IDs Step 4 takes the last one that has a cache', () => {
    const registry = (order: string[]) => Object.fromEntries(order.map((id) => [id, [{ scope: 'user', version: '5.8.4' }]]));
    const cases: Array<[string[], string, string]> = [
      [[OMC, OWN], 'both caches', '5.8.4'],
      [[OWN, OMC], 'both caches', '5.7.0'],
      // The bare ID is the legacy marketplace again, and it is the last key.
      [[OMC, OWN, BARE], 'both caches', '5.7.0'],
      [[OWN, BARE, OMC], 'both caches', '5.7.0'],
      [[BARE, OMC, OWN], 'both caches', '5.8.4'],
      [[OMC, OWN], 'the first cache only', '5.7.0'],
    ];
    for (const [order, label, expected] of cases) {
      const dir = fresh();
      try {
        addCache(dir, ['5.7.0'], 'omc');
        if (label == 'both caches') addCache(dir, ['5.8.4'], 'oh-my-claudecode');
        writeRegistry(dir, registry(order));
        // No root that an entry holds (the session sets none), so the last supported ID whose cache holds a version names it.
        expect({ order, label, latest: claudeMdAt(dir, '5.8.4', process.platform, { CLAUDE_PLUGIN_ROOT: '' })[0] }).toEqual({ order, label, latest: `Latest cached plugin version: ${expected}` });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The runtime takes the plugin version from the root the session runs (getPluginVersion in scripts/session-start.mjs reads
  // CLAUDE_PLUGIN_ROOT), and no registry has an order there. Step 4 does the same: the marketplace whose registry entry holds
  // a plugin root is the one it reads, whichever key comes last; only where no entry holds a root (none set, a checkout outside
  // the registry) the last supported ID whose cache holds a version names it, as above. Both variables name a root here, as in
  // Step 1 (the runtime reads CLAUDE_PLUGIN_ROOT alone); with two different roots no version is named and the check is skipped, as Step 1 says Channel: unknown.
  describe('with several supported IDs the marketplace of the active root names the cache, not the order of the registry', () => {
    const OLD = '5.8.0';
    const NEW = '5.9.0';
    const MATCH = 'VERSION MATCH: CLAUDE and plugin cache are aligned';
    const DRIFT = 'VERSION DRIFT: CLAUDE.md and plugin versions differ';
    // omc holds 5.8.0 and the marketplace of the plugin's own name 5.9.0, each pinned by an entry that names its install.
    const setup = (order: string[]) => {
      const dir = fresh();
      const caches = { [OMC]: path.join(addCache(dir, [OLD], 'omc'), OLD), [OWN]: path.join(addCache(dir, [NEW], 'oh-my-claudecode'), NEW) };
      const versions = { [OMC]: OLD, [OWN]: NEW };
      writeRegistry(dir, Object.fromEntries(order.map((id) => [id, [{ scope: 'user', version: versions[id as keyof typeof versions], installPath: caches[id as keyof typeof caches] }]])));
      return { dir, caches };
    };
    const ORDERS = [[OMC, OWN], [OWN, OMC]];
    // Skipped on purpose on a host that really is Windows for the platform names it cannot be, not to hide a failure: the fixtures are real directories.
    const hostCannot = (platform: string) => process.platform === 'win32' && platform !== 'win32';

    test('the example of the review: an active omc 5.8.0 beside an inactive 5.9.0 cache, in both key orders', () => {
      for (const platform of PLATFORMS) {
        if (hostCannot(platform)) continue;
        for (const order of ORDERS) {
          const { dir, caches } = setup(order);
          try {
            const env = { CLAUDE_PLUGIN_ROOT: caches[OMC] };
            expect({ platform, order, marker: OLD, out: claudeMdAt(dir, OLD, platform, env) }).toEqual({ platform, order, marker: OLD, out: [`Latest cached plugin version: ${OLD}`, MATCH] });
            expect({ platform, order, marker: NEW, out: claudeMdAt(dir, NEW, platform, env) }).toEqual({ platform, order, marker: NEW, out: [`Latest cached plugin version: ${OLD}`, DRIFT] });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });

    test('the other marketplace is the active one when its root is the session root, and OMC_PLUGIN_ROOT counts as a root too', () => {
      for (const platform of PLATFORMS) {
        if (hostCannot(platform)) continue;
        for (const order of ORDERS) {
          for (const variable of ['CLAUDE_PLUGIN_ROOT', 'OMC_PLUGIN_ROOT']) {
            const { dir, caches } = setup(order);
            try {
              expect({ platform, order, variable, out: claudeMdAt(dir, NEW, platform, { [variable]: caches[OWN] }) }).toEqual({ platform, order, variable, out: [`Latest cached plugin version: ${NEW}`, MATCH] });
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        }
      }
    });

    test('a root inside the install counts as that install, and two different roots skip the check', () => {
      for (const platform of PLATFORMS) {
        if (hostCannot(platform)) continue;
        for (const order of ORDERS) {
          const { dir, caches } = setup(order);
          try {
            const deeper = path.join(caches[OMC], 'scripts');
            mkdirSync(deeper);
            expect({ platform, order, out: claudeMdAt(dir, OLD, platform, { CLAUDE_PLUGIN_ROOT: deeper }) }).toEqual({ platform, order, out: [`Latest cached plugin version: ${OLD}`, MATCH] });
            // Two different roots are no answer, as in Step 1 (Channel: unknown): the runtime reads CLAUDE_PLUGIN_ROOT alone, so
            // the highest cache of the two would name a version the session may not run.
            const out = claudeMdAt(dir, NEW, platform, { OMC_PLUGIN_ROOT: caches[OMC], CLAUDE_PLUGIN_ROOT: caches[OWN] });
            expect({ platform, order, out }).toEqual({ platform, order, out: ['Latest cached plugin version: (unknown)', expect.stringMatching(/^VERSION CHECK SKIPPED: OMC_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT name different directories/)] });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });

    test('roots on two versions of one marketplace skip the check, whichever variable holds the older one, instead of a false drift against the highest cache', () => {
      for (const [omcRoot, claudeRoot] of [[NEW, OLD], [OLD, NEW]]) {
        const dir = fresh();
        try {
          const cache = addCache(dir, [OLD, NEW], 'omc');
          writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD, installPath: path.join(cache, OLD) }, { scope: 'user', version: NEW, installPath: path.join(cache, NEW) }] });
          const out = claudeMdAt(dir, claudeRoot, 'linux', { OMC_PLUGIN_ROOT: path.join(cache, omcRoot), CLAUDE_PLUGIN_ROOT: path.join(cache, claudeRoot) });
          expect({ omcRoot, claudeRoot, out }).toEqual({ omcRoot, claudeRoot, out: ['Latest cached plugin version: (unknown)', expect.stringMatching(/^VERSION CHECK SKIPPED: OMC_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT name different directories/)] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // Two roots whose identity cannot be compared (a file system that reports inode 0) and whose spellings differ only in letter
    // case are not known to be one directory: Step 1 says Channel: unknown, and Step 4 must not pick a cache either.
    test.skipIf(process.platform === 'win32')('two roots that cannot be told apart from one directory skip the check, as Step 1 reports Channel: unknown', () => {
      const zeroInode = "const fs = require('fs'); const real = fs.statSync; fs.statSync = function (target, options) { const stat = real.call(fs, target, options); if (options && options.bigint) stat.ino = 0n; return stat; };\n";
      const dir = fresh();
      try {
        const upper = path.join(dir, 'roots', 'Foo');
        const lower = path.join(dir, 'roots', 'foo');
        mkdirSync(upper, { recursive: true });
        mkdirSync(lower, { recursive: true });
        if (existsSync(path.join(dir, 'roots', 'FOO'))) return;
        addCache(dir, [NEW], 'omc');
        writeRegistry(dir, { [OMC]: [{ scope: 'user', version: NEW, installPath: upper }] });
        writeFileSync(path.join(dir, 'zero-inode.cjs'), zeroInode);
        const out = claudeMdAt(dir, OLD, 'linux', { OMC_PLUGIN_ROOT: upper, CLAUDE_PLUGIN_ROOT: lower, NODE_OPTIONS: `--require ${path.join(dir, 'zero-inode.cjs')}` });
        expect(out[0]).toBe('Latest cached plugin version: (unknown)');
        expect(out[1]).toMatch(/^VERSION CHECK SKIPPED/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('one root that the entries of two marketplaces both record is ambiguous: the check is skipped instead of taking the highest cache', () => {
      for (const order of ORDERS) {
        const dir = fresh();
        try {
          const root = path.join(dir, 'shared-root');
          mkdirSync(root);
          addCache(dir, [OLD], 'omc');
          addCache(dir, [NEW], 'oh-my-claudecode');
          const entries = { [OMC]: [{ scope: 'user', version: OLD, installPath: root }], [OWN]: [{ scope: 'user', version: NEW, installPath: root }] };
          writeRegistry(dir, Object.fromEntries(order.map((id) => [id, entries[id as keyof typeof entries]])));
          const out = claudeMdAt(dir, OLD, 'linux', { CLAUDE_PLUGIN_ROOT: root });
          expect({ order, out }).toEqual({ order, out: ['Latest cached plugin version: (unknown)', expect.stringMatching(/^VERSION CHECK SKIPPED: .*more than one marketplace/)] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // OMC_PLUGIN_ROOT on a checkout outside the registry is the install the session runs (Step 1: Channel: plugin-dir) and the
    // runtime reads that checkout, so a stale cache beside it says nothing about the marker.
    // A CLAUDE_PLUGIN_ROOT alone, with no supported ID in the registry, is the plugin-dir checkout of Step 1 (a claude --plugin-dir session).
    // The runtime tells a managed root by its text, not through a link: an install path outside the cache that is a link to a cache
    // version is an external root there, and its own package (5.8.0) is the version loaded, not the highest sibling.
    test.skipIf(process.platform === 'win32')('a registered install path that is a link into the cache is judged by its own package, as at runtime', () => {
      const dir = fresh();
      try {
        const cache = addCache(dir, [OLD, NEW], 'omc');
        writeFileSync(path.join(cache, OLD, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version: OLD }));
        const alias = path.join(dir, 'alias');
        symlinkSync(path.join(cache, OLD), alias);
        writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD, installPath: alias }] });
        expect(claudeMdAt(dir, OLD, 'linux', { CLAUDE_PLUGIN_ROOT: alias })).toEqual([`Latest cached plugin version: ${OLD}`, MATCH]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // The runtime classifies and reads CLAUDE_PLUGIN_ROOT alone: an OMC_PLUGIN_ROOT alias outside the cache does not make the install external.
    test.skipIf(process.platform === 'win32')('the managed or external decision follows CLAUDE_PLUGIN_ROOT, not an OMC_PLUGIN_ROOT alias of it', () => {
      const dir = fresh();
      try {
        const cache = addCache(dir, [OLD, NEW], 'omc');
        writeFileSync(path.join(cache, OLD, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version: OLD }));
        const alias = path.join(dir, 'alias');
        symlinkSync(path.join(cache, OLD), alias);
        writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD, installPath: path.join(cache, OLD) }] });
        expect(claudeMdAt(dir, OLD, 'linux', { OMC_PLUGIN_ROOT: alias, CLAUDE_PLUGIN_ROOT: path.join(cache, OLD) })).toEqual([`Latest cached plugin version: ${NEW}`, DRIFT]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // The runtime counts a cached version only when package.json names exactly that version (getLatestPluginCacheVersion).
    test.skipIf(process.platform === 'win32')('a half-written cache directory is no cached version', () => {
      for (const damage of ['no package.json', 'another version', 'not JSON']) {
        const dir = fresh();
        try {
          const cache = addCache(dir, [OLD, NEW], 'omc');
          const file = path.join(cache, NEW, 'package.json');
          if (damage == 'no package.json') rmSync(file);
          else writeFileSync(file, damage == 'another version' ? JSON.stringify({ version: '5.9.1' }) : '{');
          writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD }] });
          expect({ damage, out: claudeMdAt(dir, OLD, 'linux', {}) }).toEqual({ damage, out: [`Latest cached plugin version: ${OLD}`, MATCH] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // getPluginVersion (scripts/session-start.mjs) keeps the package version of the managed root the session loaded unless a complete
    // cached version is newer: a root refreshed in place (directory 5.8.0, package 5.9.0) is not a cached version by its name, but its
    // package still counts.
    test.skipIf(process.platform === 'win32')('the managed root the session loaded keeps its package version beside the complete cached versions', () => {
      const cases: Array<{ label: string; siblings: string[]; rootPackage: string | null; marker: string; latest: string; verdict: string }> = [
        { label: 'a refreshed root beside an older sibling', siblings: ['5.7.0'], rootPackage: NEW, marker: '5.7.0', latest: NEW, verdict: DRIFT },
        { label: 'the same, marker at the package version', siblings: ['5.7.0'], rootPackage: NEW, marker: NEW, latest: NEW, verdict: MATCH },
        { label: 'a newer complete sibling wins', siblings: ['6.0.0'], rootPackage: NEW, marker: '6.0.0', latest: '6.0.0', verdict: MATCH },
        { label: 'no complete sibling at all', siblings: [], rootPackage: NEW, marker: NEW, latest: NEW, verdict: MATCH },
        { label: 'a root without a package keeps the cache', siblings: ['5.7.0'], rootPackage: null, marker: '5.7.0', latest: '5.7.0', verdict: MATCH },
      ];
      for (const { label, siblings, rootPackage, marker, latest, verdict } of cases) {
        const dir = fresh();
        try {
          const root = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', OLD);
          mkdirSync(root, { recursive: true });
          addCache(dir, siblings, 'omc');
          if (rootPackage) writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version: rootPackage }));
          writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD, installPath: root }] });
          expect({ label, out: claudeMdAt(dir, marker, 'linux', { CLAUDE_PLUGIN_ROOT: root }) }).toEqual({ label, out: [`Latest cached plugin version: ${latest}`, verdict] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // The runtime reads the marker only as `<!-- OMC:VERSION:<digits...> -->` in exactly that case and spacing.
    test.skipIf(process.platform === 'win32')('a marker the runtime cannot read is drift whatever its version', () => {
      for (const marker of ['<!--OMC:VERSION:5.9.0-->', '<!-- omc:version:5.9.0 -->', '<!--  OMC:VERSION:5.9.0  -->', '<!-- OMC:VERSION:v5.9.0 -->', '<!-- OMC:VERSION:5.9.0 -->']) {
        const dir = fresh();
        try {
          addCache(dir, [NEW], 'omc');
          writeRegistry(dir, { [OMC]: [{ scope: 'user', version: NEW }] });
          writeFileSync(path.join(dir, 'CLAUDE.md'), marker + '\n');
          const run = runCommand(CLAUDE_MD_VERSION, dir, { timeout: 20_000 });
          expect({ marker, verdict: run.stdout.trim().split('\n').slice(-1)[0] }).toEqual({ marker, verdict: marker == '<!-- OMC:VERSION:5.9.0 -->' ? MATCH : DRIFT });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // getLatestPluginCacheVersion (scripts/session-start.mjs) counts a cache directory only when its name is digits.digits.digits with an
    // optional -prerelease (no build metadata) and its package.json names exactly that name; Step 4 names the same newest version.
    test.skipIf(process.platform === 'win32')('Step 4 takes the newest cached version by the cache name rule of the runtime', () => {
      const cases: Array<{ label: string; siblings: string[]; marker: string; latest: string; verdict: string }> = [
        { label: 'build metadata is no cached version', siblings: ['5.9.0+build'], marker: OLD, latest: OLD, verdict: MATCH },
        { label: 'build metadata beside a real older version', siblings: ['5.9.0+build', '5.8.5'], marker: '5.8.5', latest: '5.8.5', verdict: MATCH },
        { label: 'a prerelease is a cached version', siblings: ['5.9.0-beta.1'], marker: '5.9.0-beta.1', latest: '5.9.0-beta.1', verdict: MATCH },
      ];
      for (const { label, siblings, marker, latest, verdict } of cases) {
        const dir = fresh();
        try {
          const cache = addCache(dir, [OLD, ...siblings], 'omc');
          const root = path.join(cache, OLD);
          writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD, installPath: root }] });
          expect({ label, out: claudeMdAt(dir, marker, 'linux', { CLAUDE_PLUGIN_ROOT: root }) }).toEqual({ label, out: [`Latest cached plugin version: ${latest}`, verdict] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // getPluginVersion returns pkg?.version whatever its type; the marker is compared with it strictly, so a version that is no string
    // (a damaged package.json) is never the marker and is reported as drift, not replaced by an older cached version.
    test.skipIf(process.platform === 'win32')('a loaded package whose version is no string is drift against any marker, for a managed and for an external root', () => {
      for (const raw of [580, { major: 5 }, true]) {
        for (const kind of ['managed', 'external']) {
          const dir = fresh();
          try {
            const cache = addCache(dir, ['5.7.0'], 'omc');
            const root = kind == 'managed' ? path.join(cache, OLD) : path.join(dir, 'external');
            mkdirSync(root, { recursive: true });
            writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version: raw }));
            writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD, installPath: root }] });
            for (const marker of ['5.7.0', OLD]) {
              expect({ raw, kind, marker, out: claudeMdAt(dir, marker, 'linux', { CLAUDE_PLUGIN_ROOT: root }) }).toEqual({ raw, kind, marker, out: [`Latest cached plugin version: ${JSON.stringify(raw)}`, DRIFT] });
            }
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });

    // getLatestPluginCacheVersion always scans the omc cache, and a root spelled inside it is managed whichever registry key records it.
    test.skipIf(process.platform === 'win32')('a managed root recorded under another marketplace key is compared with the omc cache', () => {
      for (const key of [OWN, BARE]) {
        const dir = fresh();
        try {
          const cache = addCache(dir, [OLD, NEW], 'omc');
          addCache(dir, ['6.0.0'], 'oh-my-claudecode');
          const root = path.join(cache, OLD);
          writeRegistry(dir, { [key]: [{ scope: 'user', version: OLD, installPath: root }] });
          expect({ key, out: claudeMdAt(dir, NEW, 'linux', { CLAUDE_PLUGIN_ROOT: root }) }).toEqual({ key, out: [`Latest cached plugin version: ${NEW}`, MATCH] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // A falsy version in the loaded package (empty, null, false, 0) is no version at runtime (pkg?.version || null), so the cached versions
    // decide, as for a package without a version.
    test.skipIf(process.platform === 'win32')('a falsy version in the loaded package leaves the decision to the cached versions', () => {
      for (const raw of ['', null, false, 0]) {
        const dir = fresh();
        try {
          const cache = addCache(dir, ['5.7.0'], 'omc');
          const root = path.join(cache, OLD);
          mkdirSync(root, { recursive: true });
          writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version: raw }));
          writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD, installPath: root }] });
          expect({ raw, out: claudeMdAt(dir, '5.7.0', 'linux', { CLAUDE_PLUGIN_ROOT: root }) }).toEqual({ raw, out: ['Latest cached plugin version: 5.7.0', MATCH] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // extractOmcVersion takes the first marker in the exact form wherever a variant spelling stands; the version shown and its exactness
    // belong to one match, so a variant that equals the cache cannot hide that the marker the runtime reads is another one.
    test.skipIf(process.platform === 'win32')('with several markers in one file the exact one decides, as in the runtime, wherever a variant stands', () => {
      const variant = (version: string) => `<!--OMC:VERSION:${version}-->`;
      const exact = (version: string) => `<!-- OMC:VERSION:${version} -->`;
      const cases: Array<[string, string[], string, string]> = [
        ['a variant before the exact one', [variant(NEW), exact(OLD)], OLD, DRIFT],
        ['the exact one before a variant', [exact(NEW), variant(OLD)], NEW, MATCH],
        ['a variant after the exact one that differs', [exact(OLD), variant(NEW)], OLD, DRIFT],
        ['the variant alone', [variant(NEW)], NEW, DRIFT],
      ];
      for (const [label, lines, shown, verdict] of cases) {
        const dir = fresh();
        try {
          addCache(dir, [OLD, NEW], 'omc');
          writeRegistry(dir, { [OMC]: [{ scope: 'user', version: NEW }] });
          writeFileSync(path.join(dir, 'CLAUDE.md'), lines.join('\n') + '\n');
          const run = runCommand(CLAUDE_MD_VERSION, dir, { timeout: 20_000 });
          const out = run.stdout.trim().split('\n');
          expect({ label, shown: out[0], verdict: out[out.length - 1] }).toEqual({ label, shown: `CLAUDE.md OMC version: ${shown}`, verdict });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    // The runtime compares the raw package version of an external root with the marker, so a v in that package is drift.
    test.skipIf(process.platform === 'win32')('an external root whose package version has a v is drift against the marker without one', () => {
      for (const [pkg, marker, verdict] of [['v5.9.0', '5.9.0', DRIFT], ['5.9.0', '5.9.0', MATCH], ['v5.9.0', 'v5.9.0', DRIFT]] as const) {
        const dir = fresh();
        try {
          addCache(dir, [OLD], 'omc');
          const root = path.join(dir, 'external');
          mkdirSync(root);
          writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version: pkg }));
          writeRegistry(dir, { [OMC]: [{ scope: 'user', version: '5.9.0', installPath: root }] });
          expect({ pkg, marker, out: claudeMdAt(dir, marker, 'linux', { CLAUDE_PLUGIN_ROOT: root }) }).toEqual({ pkg, marker, out: [`Latest cached plugin version: ${pkg}`, verdict] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test.skipIf(process.platform === 'win32')('a plugin root variable alone beside an old cache is a checkout: the comparison is skipped', () => {
      const dir = fresh();
      try {
        addCache(dir, [OLD], 'omc');
        const checkout = path.join(dir, 'checkout');
        mkdirSync(checkout);
        const out = claudeMdAt(dir, NEW, 'linux', { CLAUDE_PLUGIN_ROOT: checkout });
        expect(out).toEqual(['Latest cached plugin version: (unknown)', expect.stringMatching(/^VERSION CHECK SKIPPED: .*plugin-dir/)]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // A supported entry whose installPath lies outside plugins/cache and is the active root: its own package names the version.
    test.skipIf(process.platform === 'win32')('a registered install outside the cache is judged by its own manifest, not by the cache beside it', () => {
      const dir = fresh();
      try {
        addCache(dir, [OLD], 'omc');
        const root = path.join(dir, 'external');
        mkdirSync(root);
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claudecode', version: NEW }));
        writeRegistry(dir, { [OMC]: [{ scope: 'user', version: NEW, installPath: root }] });
        expect(claudeMdAt(dir, NEW, 'linux', { CLAUDE_PLUGIN_ROOT: root })).toEqual([`Latest cached plugin version: ${NEW}`, MATCH]);
        expect(claudeMdAt(dir, OLD, 'linux', { CLAUDE_PLUGIN_ROOT: root })).toEqual([`Latest cached plugin version: ${NEW}`, DRIFT]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('an explicit checkout outside the registry skips the comparison with the cache beside it', () => {
      for (const marker of [OLD, NEW]) {
        const { dir } = setup([OMC, OWN]);
        try {
          const checkout = path.join(dir, 'checkout');
          mkdirSync(checkout);
          const out = claudeMdAt(dir, marker, 'linux', { OMC_PLUGIN_ROOT: checkout });
          expect({ marker, out }).toEqual({ marker, out: ['Latest cached plugin version: (unknown)', expect.stringMatching(/^VERSION CHECK SKIPPED: .*plugin-dir/)] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test('with no root that an entry holds the last supported ID whose cache has a version names it: no root, a root that does not exist', () => {
      for (const platform of PLATFORMS) {
        if (hostCannot(platform)) continue;
        for (const [label, root] of [['no root', () => ''], ['a path that does not exist', (dir: string) => path.join(dir, 'nowhere')]] as const) {
          for (const [order, expected] of [[[OMC, OWN], NEW], [[OWN, OMC], OLD]] as const) {
            const { dir } = setup([...order]);
            try {
              expect({ platform, label, order, out: claudeMdAt(dir, expected, platform, { CLAUDE_PLUGIN_ROOT: root(dir) }) }).toEqual({ platform, label, order, out: [`Latest cached plugin version: ${expected}`, MATCH] });
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        }
      }
    });

    // The runtime reads the package of an existing root that is not in the omc cache, whatever the registry holds (a raw --plugin-dir session beside a
    // valid registration), so the doctor does too: the cache of a marketplace is no answer for it, with or without a manifest in the checkout.
    test('an existing root outside every cache is read through its own package, not through a cache of the registry', () => {
      for (const platform of PLATFORMS) {
        if (hostCannot(platform)) continue;
        for (const [order, expected] of [[[OMC, OWN], NEW], [[OWN, OMC], OLD]] as const) {
          const { dir } = setup([...order]);
          try {
            const root = path.join(dir, 'checkout');
            mkdirSync(root);
            const noManifest = claudeMdAt(dir, expected, platform, { CLAUDE_PLUGIN_ROOT: root });
            expect({ platform, order, noManifest: noManifest[0] }).toEqual({ platform, order, noManifest: 'Latest cached plugin version: (unknown)' });
            writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: expected }));
            expect({ platform, order, out: claudeMdAt(dir, expected, platform, { CLAUDE_PLUGIN_ROOT: root }) }).toEqual({ platform, order, out: [`Latest cached plugin version: ${expected}`, MATCH] });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });

    test('the active marketplace decides even where its cache holds no version: nothing is taken from the other one', () => {
      for (const platform of PLATFORMS) {
        if (hostCannot(platform)) continue;
        for (const order of ORDERS) {
          const { dir } = setup(order);
          try {
            // An install kept outside the plugin cache: the omc cache directory is empty, the other marketplace has a version.
            rmSync(path.join(dir, 'plugins', 'cache', 'omc'), { recursive: true });
            const custom = path.join(dir, 'custom', 'install');
            mkdirSync(custom, { recursive: true });
            writeRegistry(dir, { [OMC]: [{ scope: 'user', version: OLD, installPath: custom }], [OWN]: [{ scope: 'user', version: NEW }] });
            expect({ platform, order, out: claudeMdAt(dir, NEW, platform, { CLAUDE_PLUGIN_ROOT: custom }) })
              .toEqual({ platform, order, out: ['Latest cached plugin version: (unknown)', expect.stringMatching(/^VERSION CHECK SKIPPED: .*outside the plugin cache/)] });
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    });
  });

  test('with several supported IDs Step 6 prints one line per marketplace, led by its name, in the order of the last occurrences', () => {
    const dir = fresh();
    try {
      addCache(dir, ['5.7.0', '5.7.1'], 'omc');
      addCache(dir, ['5.8.4'], 'oh-my-claudecode');
      const entry = [{ scope: 'user', version: '5.8.4' }];
      expect(count(dir, { [OMC]: entry, [OWN]: entry })).toEqual(['omc: 2 version(s): 5.7.0, 5.7.1', 'oh-my-claudecode: 1 version(s): 5.8.4']);
      expect(count(dir, { [OMC]: entry, [OWN]: entry, [BARE]: entry })).toEqual(['oh-my-claudecode: 1 version(s): 5.8.4', 'omc: 2 version(s): 5.7.0, 5.7.1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unreadable or non-regular registry falls back to the legacy marketplace without blocking', () => {
    for (const raw of ['{not json', '[]', 'null']) {
      const dir = fresh();
      try {
        addCache(dir, ['5.7.0'], 'omc');
        writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), raw);
        expect({ raw, out: count(dir) }).toEqual({ raw, out: ['1 version(s): 5.7.0'] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // A directory where the registry should be is not opened as a file and does not stop the command.
    const dir = fresh();
    try {
      mkdirSync(path.join(dir, 'plugins', 'installed_plugins.json'), { recursive: true });
      addCache(dir, ['5.7.0'], 'omc');
      expect(count(dir)).toEqual(['1 version(s): 5.7.0']);
      expect(existsSync(path.join(dir, 'plugins', 'installed_plugins.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
