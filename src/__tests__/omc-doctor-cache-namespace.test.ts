import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCache, backupDir, commands, commandWith, makeCache, movedAside, PLUGIN_ID, runCommand, scriptOf, sharedSections, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1, versionCommand } from './helpers/omc-doctor-step1.js';

// Step 4 prints the highest cached plugin version and compares it with the CLAUDE.md marker; Step 6 counts the cached versions.
const step4 = commandWith('Latest cached plugin version') ?? '';
const step6 = commandWith("' version(s):'") ?? '';
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

// Step 4 is a shell command (a `node -e` in double quotes), so it runs through bash.
function claudeMd(dir: string, marker: string, platform: string = process.platform): string[] {
  writeFileSync(path.join(dir, 'CLAUDE.md'), `<!-- OMC:VERSION:${marker} -->\n`);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '', NODE_OPTIONS: `--require ${reportAs(dir, platform)}` };
  const run = spawnSync('/bin/bash', ['-c', step4], { encoding: 'utf8', timeout: 20_000, env });
  expect(run.error).toBeUndefined();
  return run.stdout.trim().split('\n');
}

const count = (dir: string, plugins?: Record<string, unknown>, platform: string = process.platform) => {
  if (plugins) writeRegistry(dir, plugins);
  const run = runCommand(step6, dir, { timeout: 20_000, preloads: [reportAs(dir, platform)] });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  return run.stdout.trim().split('\n').map((l) => l.replace(/(version\(s\): )(.*)/, (_m, head: string, list: string) => head + list.split(', ').sort().join(', ')));
};

// The commands cannot share code, so each carries its own copy of the version-name test and of the marketplace
// derivation, in shared sections. The copies must stay equal (omc-doctor-shared-sections.test.ts); these tests keep what
// the sections say.
describe('omc-doctor: the cache commands carry one definition of a version name and of the marketplace list', () => {
  const sources: Array<[string, string]> = [['Step 1', versionCommand ?? ''], ['Step 4', step4], ['Step 6', step6], ['outdated plugin command', commands[0] ?? ''], ['stale cache command', commands[1] ?? '']];

  test('every command exists', () => {
    expect(commands).toHaveLength(2);
    for (const [label, line] of sources) expect({ label, found: line !== '' }).toEqual({ label, found: true });
  });

  test('the version-name test is the same text everywhere and excludes a relink recovery directory', () => {
    const definitions = sources.map(([label, command]) => [label, (sharedSections(command).get('version grammar') ?? '').split('\n').find((l) => l.startsWith('const isVersionDir')) ?? ''] as const);
    for (const [label, definition] of definitions) expect({ label, definition }).toEqual({ label, definition: String.raw`const isVersionDir = (name) => /^[0-9]/.test(name) && !/[.]omc-stale-[0-9]+(?![^])/.test(name);` });
  });

  test('no command filters a cache listing by its own copy of the digit test', () => {
    for (const [label, command] of sources) expect({ label, own: /filter\(\(?\w+\)? => \/\^(\\d|\[0-9\])/.test(scriptOf(command)) }).toEqual({ label, own: false });
  });

  test('Steps 4 and 6 derive the marketplace list in the same way and keep the last occurrence of an ID', () => {
    const [four, six] = [sharedSections(step4).get('registry marketplaces') ?? '', sharedSections(step6).get('registry marketplaces') ?? ''];
    expect(four).not.toBe('');
    expect(six).toBe(four);
    expect(four).toContain('lastIndexOf');
  });

  test('Steps 4 and 6 name no fixed marketplace', () => {
    expect(scriptOf(step4)).not.toMatch(/'cache',\s*'omc'/);
    expect(scriptOf(step6)).not.toMatch(/'cache',\s*'omc'/);
  });
});

describe('omc-doctor: a recovery directory of an interrupted cache relink is not a cached version', () => {
  // `<version>.omc-stale-<pid>` is what an interrupted relink leaves beside a missing or unusable original path;
  // purgeStalePluginCacheVersions restores it as the only intact copy, so the commands must not move it to the backups.
  test('the cache commands leave it in place beside a missing version, and still move a free version next to it', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        // 5.7.0 is missing, 5.7.0.omc-stale-4242 is its recovery copy; 5.9.0 is pinned, 5.8.0 is free.
        const { dir, cache } = makeCache(['5.9.0', '5.8.0', '5.7.0.omc-stale-4242']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
          const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, left: readdirSync(cache).sort(), moved: movedAside(dir) })
            .toEqual({ platform, status: 0, left: ['5.7.0.omc-stale-4242', '5.9.0'], moved: 1 });
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
        const { dir, cache } = makeCache(['5.9.0', '5.7.0.omc-stale-4242']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
          const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, left: readdirSync(cache).sort(), moved: movedAside(dir) })
            .toEqual({ platform, status: 0, left: ['5.7.0.omc-stale-4242', '5.9.0'], moved: 0 });
          expect(result.stdout).toContain('Nothing to move');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The relink reconciler recognises exactly `.omc-stale-` and a decimal pid at the end of the name; a name that only
  // looks like it is an ordinary version, so it is judged like one.
  test('only a name that ends in .omc-stale- and a pid is a recovery directory', () => {
    for (const command of commands) {
      for (const platform of PLATFORMS) {
        const { dir, cache } = makeCache(['5.9.0', '5.6.0.omc-stale-abc', '5.5.0.omc-stale-12.bak', '5.4.0.omc-stale-7', '5.3.0.omc-stale-0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
          const result = runCommand(command, dir, { preloads: [reportAs(dir, platform)] });
          expect({ platform, status: result.status, left: readdirSync(cache).sort(), moved: movedAside(dir) })
            .toEqual({ platform, status: 0, left: ['5.3.0.omc-stale-0', '5.4.0.omc-stale-7', '5.9.0'], moved: 2 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('Step 1 does not name it as the newest version', () => {
    for (const platform of PLATFORMS) {
      expect(step1({ platform, cache: { omc: ['5.8.0', '5.9.0.omc-stale-12'] } })).toEqual({ Channel: 'npm', Installed: '5.8.0', Updater: 'omc update' });
      expect(step1({ platform, plugins: { [OMC]: [{ installPath: '/nowhere/current' }] }, cache: { omc: ['5.8.0', '5.9.0.omc-stale-12'] } }).Installed).toBe('5.8.0');
      // An installPath that names the recovery directory gives no version by its name; the version is read from the package.
      const out = step1({
        platform,
        plugins: (dir) => ({ [OMC]: [{ installPath: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.9.0.omc-stale-12') }] }),
        setup: (dir) => writeFileSync(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.9.0.omc-stale-12', 'package.json'), JSON.stringify({ version: '5.9.0' })),
        cache: { omc: ['5.9.0.omc-stale-12'] },
      });
      expect({ platform, installed: out.Installed }).toEqual({ platform, installed: '5.9.0' });
    }
  });

  test.skipIf(process.platform === 'win32')('Step 4 does not name it as the newest version', () => {
    for (const platform of PLATFORMS) {
      const { dir } = makeCache(['5.8.0', '5.9.0.omc-stale-12']);
      try {
        expect({ platform, out: claudeMd(dir, '5.8.0', platform)[2] }).toEqual({ platform, out: 'Latest cached plugin version: 5.8.0' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('Step 6 does not count it', () => {
    for (const platform of PLATFORMS) {
      const { dir } = makeCache(['5.8.0', '5.9.0.omc-stale-12']);
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
          expect({ label, platform, out: claudeMd(dir, '5.8.4', platform) }).toEqual({
            label,
            platform,
            out: ['CLAUDE.md OMC version: 5.8.4', `OMC version source: ${path.join(dir, 'CLAUDE.md')}`, 'Latest cached plugin version: 5.8.4', 'VERSION MATCH: CLAUDE and plugin cache are aligned'],
          });
          expect({ label, platform, drift: claudeMd(dir, '5.7.0', platform).slice(2) }).toEqual({ label, platform, drift: ['Latest cached plugin version: 5.8.4', 'VERSION DRIFT: CLAUDE.md and plugin versions differ'] });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

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
  });

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
        expect({ order, label, latest: claudeMd(dir, '5.8.4')[2] }).toEqual({ order, label, latest: `Latest cached plugin version: ${expected}` });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
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
