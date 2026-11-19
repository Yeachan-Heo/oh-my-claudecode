import { describe, test, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commands, digitVersions, makeCache, movedAside, read, runCommand, scriptOf, upperBelow, writeCaseFoldPreload, writeRegistry, writeRegistryFile } from './helpers/omc-doctor-cache-fixture.js';

const text = read('skills/omc-doctor/SKILL.md');
const versionCommand = text.split('\n').find((l) => l.startsWith('node -e ') && l.includes("'Updater: "));

type Profile = {
  plugins?: Record<string, unknown> | ((dir: string) => Record<string, unknown>);
  platform?: string;
  casefold?: boolean;
  raw?: string;
  cache?: Record<string, string[]>;
  clone?: Record<string, string>;
  env?: (dir: string) => Record<string, string>;
  setup?: (dir: string) => void;
};

// Runs the Step 1 command against a synthetic config directory. `cache` maps a marketplace name to the
// version directories under plugins/cache/<marketplace>/oh-my-claudecode, `clone` maps a marketplace name
// to the plugin version its clone advertises, `env` sets variables (it may create the directories they name)
// and `setup` runs last. The command always runs with a timeout: a read that blocks must show up as an error.
function step1(profile: Profile) {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-version-'));
  try {
    mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    for (const [market, versions] of Object.entries(profile.cache ?? {})) {
      for (const v of versions) mkdirSync(path.join(dir, 'plugins', 'cache', market, 'oh-my-claudecode', v), { recursive: true });
    }
    for (const [market, version] of Object.entries(profile.clone ?? {})) {
      const manifestDir = path.join(dir, 'plugins', 'marketplaces', market, '.claude-plugin');
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(path.join(manifestDir, 'marketplace.json'), JSON.stringify({ name: market, plugins: [{ name: 'oh-my-claudecode', version }] }));
    }
    if (profile.raw !== undefined) writeRegistryFile(dir, profile.raw);
    else if (profile.plugins) writeRegistry(dir, typeof profile.plugins == 'function' ? profile.plugins(dir) : profile.plugins);
    const preload = path.join(dir, 'platform.cjs');
    if (profile.platform) writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: '${profile.platform}' });\n`);
    profile.setup?.(dir);
    // `casefold` gives the process a volume that ignores letter case while it reports linux (WSL2 on a Windows drive).
    const preloads = [...(profile.platform ? [preload] : []), ...(profile.casefold ? [writeCaseFoldPreload(dir)] : [])];
    const result = runCommand(versionCommand ?? '', dir, { preloads, env: profile.env?.(dir), timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return Object.fromEntries(result.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('omc-doctor Step 1 derives the plugin ID, channel and latest version from the active install', () => {
  test('the command exists once and does not consult npm or a fixed plugin ID', () => {
    expect(versionCommand).toBeDefined();
    expect(text.split('\n').filter((l) => l.startsWith('node -e ') && l.includes("'Updater: "))).toHaveLength(1);
    expect(versionCommand).not.toMatch(/npm view|registry\.npmjs|child_process/);
    // The npm line has its own label, so an offline run never prints a second `Latest:` next to a marketplace one.
    const block = text.slice(text.indexOf('### Step 1'), text.indexOf('**Diagnosis**'));
    expect(block).toContain('echo "npm latest: (unavailable)"');
    expect(block).toContain('echo "npm latest: $latest"');
    expect(block.split('\n').filter((l) => !l.startsWith('node -e ') && l.includes('Latest:') && !l.startsWith('#'))).toEqual([]);
  });

  // The line is pasted into a double-quoted shell string, so nothing in it may be changed by one (a backslash
  // before a letter stays as written), and bash must produce what node produces on the same configuration directory.
  test('the command line contains nothing that a double-quoted shell string would change, and bash gives the output node gives', () => {
    expect(versionCommand?.startsWith('node -e "') && versionCommand.endsWith('"')).toBe(true);
    expect(scriptOf(versionCommand ?? '')).not.toMatch(/["`$]|\\[\\"`$\n]/);
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-version-'));
    try {
      mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      writeRegistry(dir, { 'oh-my-claudecode@oh-my-claudecode': [{ version: '5.8.0' }] });
      const viaNode = runCommand(versionCommand ?? '', dir);
      const viaBash = spawnSync('/bin/bash', ['-c', versionCommand ?? ''], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' } });
      expect(viaNode.stdout).toContain('Channel: marketplace oh-my-claudecode');
      expect(viaBash.stdout).toBe(viaNode.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('npm profile: no registry entry means the npm channel, installed from the cache, updated with omc update', () => {
    expect(step1({ cache: { omc: ['5.8.0', '5.9.0'] } })).toEqual({ Channel: 'npm', Installed: '5.9.0', Updater: 'omc update' });
    expect(step1({ plugins: { 'some-other-plugin@market': [{ version: '1.0.0' }] } })).toEqual({ Channel: 'npm', Installed: '(none)', Updater: 'omc update' });
  });

  test('marketplace profile from the oh-my-claudecode marketplace: its own plugin ID, clone and updater', () => {
    const out = step1({
      plugins: { 'oh-my-claudecode@oh-my-claudecode': [{ scope: 'user', version: '5.9.0' }] },
      clone: { 'oh-my-claudecode': '5.9.0' },
    });
    expect(out).toEqual({
      Plugin: 'oh-my-claudecode@oh-my-claudecode',
      Channel: 'marketplace oh-my-claudecode',
      Installed: '5.9.0',
      Latest: '5.9.0 (marketplace clone)',
      Updater: 'claude plugin marketplace update oh-my-claudecode && claude plugin update oh-my-claudecode@oh-my-claudecode',
    });
    expect(out.Updater).not.toMatch(/\bomc\b|@omc/);
  });

  test('marketplace profile behind npm: the installed version equals the channel latest, so there is nothing to warn about', () => {
    // npm may already have a newer release; the command never reads it, only the clone the channel updates from.
    const out = step1({
      plugins: { 'oh-my-claudecode@oh-my-claudecode': [{ version: '5.8.1' }] },
      clone: { 'oh-my-claudecode': '5.8.1' },
    });
    expect(out.Installed).toBe('5.8.1');
    expect(out.Latest).toBe('5.8.1 (marketplace clone)');
  });

  test('marketplace profile with a newer clone shows the difference, and the legacy omc marketplace gets its own updater', () => {
    const out = step1({
      plugins: { 'oh-my-claudecode@omc': [{ version: '5.8.0' }, { version: '5.8.1' }] },
      clone: { omc: '5.9.0', 'oh-my-claudecode': '9.9.9' },
    });
    expect(out).toMatchObject({
      Plugin: 'oh-my-claudecode@omc',
      Channel: 'marketplace omc',
      Installed: '5.8.1',
      Latest: '5.9.0 (marketplace clone)',
      Updater: 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode@omc',
    });
  });

  test('an entry without a version falls back to the cache of its own marketplace; a missing clone is reported, not guessed', () => {
    const out = step1({
      plugins: { 'oh-my-claudecode@oh-my-claudecode': [{ installPath: '/nowhere' }] },
      cache: { 'oh-my-claudecode': ['5.7.0', '5.10.0'], omc: ['6.0.0'] },
    });
    expect(out).toMatchObject({ Installed: '5.10.0', Latest: '(unavailable) (marketplace clone)' });
  });

  // Grid: spelling of the registry key x where the installed version comes from x platform. The marketplace
  // name, the clone it is looked up in and the updater follow the normalized official ID, as the installer
  // reads the registry; the plugin ID in the updater stays as recorded.
  test('the registry key in any letter case, with the version from version, installPath or the cache, on every platform', () => {
    const keys: Array<[string, string]> = [
      ['oh-my-claudecode@omc', 'omc'],
      ['OH-MY-CLAUDECODE@OMC', 'omc'],
      ['Oh-My-ClaudeCode@Oh-My-ClaudeCode', 'oh-my-claudecode'],
      ['OH-MY-CLAUDECODE', 'omc'],
    ];
    const sources: Array<[string, (dir: string, market: string) => unknown, string]> = [
      ['version', () => ({ version: '5.8.0' }), '5.8.0'],
      // Only the registered path names the running version; a newer stale directory must not win.
      ['installPath named for its version', (dir, market) => ({ installPath: path.join(dir, 'plugins', 'cache', market, 'oh-my-claudecode', '5.8.0') + path.sep }), '5.8.0'],
      ['installPath with a padded Windows spelling', () => ({ installPath: ' X:\\cfg\\plugins\\cache\\omc\\oh-my-claudecode\\5.8.0\\ ' }), '5.8.0'],
      ['installPath of an alias directory, version in its package.json', (dir) => {
        mkdirSync(path.join(dir, 'alias'), { recursive: true });
        writeFileSync(path.join(dir, 'alias', 'package.json'), JSON.stringify({ version: '5.8.0' }));
        return { installPath: path.join(dir, 'alias') };
      }, '5.8.0'],
      ['an installPath that names no version and has no metadata: the cache of the marketplace', () => ({ installPath: '/nowhere/current' }), '5.9.0'],
    ];
    for (const [key, market] of keys) {
      for (const [label, entry, installed] of sources) {
        for (const platform of ['linux', 'darwin', 'win32']) {
          const out = step1({
            platform,
            plugins: (dir) => ({ [key]: [entry(dir, market)] }),
            cache: { [market]: ['5.8.0', '5.9.0'] },
            clone: { [market]: '6.0.0', [market == 'omc' ? 'oh-my-claudecode' : 'omc']: '9.9.9' },
          });
          expect({ key, label, platform, out }).toEqual({
            key, label, platform,
            out: {
              Plugin: key,
              Channel: 'marketplace ' + market,
              Installed: installed,
              Latest: '6.0.0 (marketplace clone)',
              Updater: `claude plugin marketplace update ${market} && claude plugin update ${key}`,
            },
          });
        }
      }
    }
  });

  test('an installPath that names no version and has no metadata falls back to the cache of the marketplace', () => {
    const out = step1({ plugins: { 'oh-my-claudecode@omc': [{ installPath: '/nowhere/current' }] }, cache: { omc: ['5.7.0', '5.8.0'] } });
    expect(out.Installed).toBe('5.8.0');
  });

  // Versions are ordered as semantic versions, never as text. A text order (localeCompare with numeric collation) puts
  // `5.9.0-beta` above `5.9.0`, because the stable name is a prefix of the prerelease name, so a registry that lists both
  // (two installation scopes) printed the prerelease as installed while the clone and the other entry were stable.
  // The chain ascends by precedence. Pairs such as `5.9.0-beta.2` < `5.9.0-beta.10` and `5.9.0` < `5.10.0` also hold in the
  // text order (numeric collation), so they guard the numeric parts; the stable-versus-prerelease pairs fail on a text order.
  // The highest element of every prefix of the chain is that prefix's last element, whatever order the versions are listed in.
  const chain = ['5.8.9', '5.9.0-2', '5.9.0-10', '5.9.0-alpha', '5.9.0-alpha.1', '5.9.0-alpha.beta', '5.9.0-beta', '5.9.0-beta.2', '5.9.0-beta.10', '5.9.0-rc.1', '5.9.0', '5.9.1-alpha', '5.9.10', '5.10.0-beta', '5.10.0'];
  const prefixes = chain.slice(1).map((top, i) => ({ top, versions: chain.slice(0, i + 2) }));
  const orders = ({ versions }: { versions: string[] }) => [[...versions].reverse(), versions];

  test('a stable version is newer than its own prerelease in either order, for the entries of two installation scopes', () => {
    for (const order of [['5.9.0', '5.9.0-beta'], ['5.9.0-beta', '5.9.0']]) {
      const out = step1({
        plugins: { 'oh-my-claudecode@omc': order.map((version, i) => ({ scope: i ? 'project' : 'user', version })) },
        clone: { omc: '5.9.0' },
      });
      expect({ order, installed: out.Installed, latest: out.Latest }).toEqual({ order, installed: '5.9.0', latest: '5.9.0 (marketplace clone)' });
    }
  });

  // Pairs for the cases that are not a prefix of the chain: a stable release against its own prerelease, numbered
  // prereleases, a longer numeric part, a core with fewer parts (`5.9` is `5.9.0`), and build metadata, which does not count
  // (`5.9.0+build.7` is below `5.9.1`). The last two pairs are the same version in semver order; the text of the names
  // then decides, so the answer does not depend on the order the directory listing or the registry gives.
  const pairs = [['5.9.0-beta', '5.9.0'], ['5.9.0-beta.2', '5.9.0-beta.10'], ['5.9.0', '5.10.0'], ['5.9.0-rc.1', '5.9.0'], ['5.9.0+build.7', '5.9.1'], ['5.9', '5.9.1'], ['5.9', '5.9.0'], ['5.9.0', '5.9.0+build.7']];

  test('the installed version is the highest registry entry by semantic version, whatever the order of the entries', () => {
    for (const prefix of prefixes) {
      for (const versions of orders(prefix)) {
        const out = step1({ plugins: { 'oh-my-claudecode@omc': versions.map((version) => ({ scope: 'user', version })) }, clone: { omc: '9.9.9' } });
        expect({ top: prefix.top, installed: out.Installed }).toEqual({ top: prefix.top, installed: prefix.top });
      }
    }
    for (const [low, high] of pairs) {
      for (const versions of [[low, high], [high, low]]) {
        const out = step1({ plugins: { 'oh-my-claudecode@omc': versions.map((version) => ({ scope: 'user', version })) }, clone: { omc: '9.9.9' } });
        expect({ versions, installed: out.Installed }).toEqual({ versions, installed: high });
      }
    }
  }, 60_000);

  test('the highest cached version is chosen by semantic version, for the npm channel and for an entry that names no version', () => {
    for (const prefix of prefixes) {
      expect({ top: prefix.top, installed: step1({ cache: { omc: prefix.versions } }).Installed }).toEqual({ top: prefix.top, installed: prefix.top });
    }
    for (const [low, high] of pairs) {
      for (const versions of [[low, high], [high, low]]) {
        const out = step1({ plugins: { 'oh-my-claudecode@omc': [{ installPath: '/nowhere/current' }] }, cache: { omc: versions } });
        expect({ versions, installed: out.Installed }).toEqual({ versions, installed: high });
      }
    }
  }, 60_000);

  // Step 4 names the highest cached plugin version as well, with the same comparator. Its line is written for a shell
  // (the doubled backslashes are the shell's), so it runs through bash.
  const claudeMdCommand = text.split('\n').find((l) => l.startsWith('node -e ') && l.includes('Latest cached plugin version'));
  test.skipIf(process.platform === 'win32')('Step 4 names the highest cached plugin version by semantic version, with the comparator of Step 1', () => {
    expect(claudeMdCommand).toBeDefined();
    const comparator = (versionCommand ?? '').slice((versionCommand ?? '').indexOf('cv=') + 3, (versionCommand ?? '').indexOf(',rd=x=>'));
    expect(comparator).toMatch(/^\(a,c\)=>\{.*\}$/);
    expect(claudeMdCommand).toContain(`.sort(${comparator});pluginV=`);
    for (const prefix of prefixes) {
      const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-version-'));
      try {
        for (const version of prefix.versions) mkdirSync(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', version), { recursive: true });
        writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- OMC:VERSION:5.9.0 -->\n');
        const run = spawnSync('/bin/bash', ['-c', claudeMdCommand ?? ''], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir } });
        expect(run.error).toBeUndefined();
        expect({ top: prefix.top, line: run.stdout.split('\n').find((l) => l.startsWith('Latest cached plugin version:')) }).toEqual({ top: prefix.top, line: `Latest cached plugin version: ${prefix.top}` });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test('no version in the skill is ordered as text', () => {
    expect(text).not.toContain('localeCompare');
    // Step 1 sorts versions in exactly two places, and both use the comparator.
    expect((versionCommand ?? '').match(/\.sort\(/g)).toHaveLength(2);
    expect((versionCommand ?? '').match(/\.sort\(cv\)/g)).toHaveLength(2);
  });

  // The npm line runs in the shell, so the case runs it with a fake npm first on PATH.
  test.skipIf(process.platform === 'win32')('the npm line is labelled on success and on failure, never a bare version', () => {
    const line = text.split('\n').find((l) => l.startsWith('latest=$(npm view '));
    expect(line).toBeDefined();
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-npm-'));
    try {
      const run = (npm: string) => {
        writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\n${npm}\n`);
        chmodSync(path.join(dir, 'npm'), 0o755);
        const result = spawnSync('bash', ['-c', line ?? ''], { encoding: 'utf8', env: { ...process.env, PATH: dir + path.delimiter + (process.env.PATH ?? '') } });
        return { status: result.status, stdout: result.stdout };
      };
      expect(run('echo 5.9.1')).toEqual({ status: 0, stdout: 'npm latest: 5.9.1\n' });
      expect(run('exit 1')).toEqual({ status: 0, stdout: 'npm latest: (unavailable)\n' });
      expect(run('exit 0')).toEqual({ status: 0, stdout: 'npm latest: (unavailable)\n' });
      expect(run('echo 5.9.1; exit 3')).toEqual({ status: 0, stdout: 'npm latest: (unavailable)\n' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bare plugin ID keeps the legacy omc marketplace', () => {
    expect(step1({ plugins: { 'oh-my-claudecode': [{ version: '5.8.0' }] }, clone: { omc: '5.8.0' } })).toMatchObject({
      Plugin: 'oh-my-claudecode',
      Channel: 'marketplace omc',
      Updater: 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode',
    });
  });

  test('an unreadable registry names no updater', () => {
    for (const raw of ['{not json', '[]', 'null']) {
      const out = step1({ raw, cache: { omc: ['5.9.0'] } });
      expect(Object.keys(out)).toEqual(['Channel']);
      expect(out.Channel).toContain('unknown');
    }
  });

  // Both cache commands refuse to act on a registry they cannot read completely; Step 1 reads it by the same
  // rules (the installer's resolver treats these shapes as ambiguous too), so a corrupted registry is reported
  // as an unknown channel instead of a healthy install that falls back to the highest cached directory.
  test('a supported key whose entry list is malformed gives an unknown channel and no updater, in every spelling', () => {
    const malformed: Array<[string, unknown]> = [
      ['null', null],
      ['an object', { version: '5.8.0' }],
      ['an empty array', []],
      ['a null entry', [null]],
      ['a string entry', ['5.8.0']],
      ['a numeric version', [{ version: 5 }]],
      ['a blank installPath', [{ installPath: '' }]],
      ['an entry with neither version nor installPath', [{ scope: 'user' }]],
      ['one good and one blank entry', [{ version: '5.8.0' }, { version: '   ' }]],
    ];
    for (const key of ['oh-my-claudecode@omc', 'OH-MY-CLAUDECODE', 'Oh-My-ClaudeCode@Oh-My-ClaudeCode']) {
      for (const [label, entries] of malformed) {
        const out = step1({ plugins: { [key]: entries }, cache: { omc: ['5.9.0'], 'oh-my-claudecode': ['5.9.0'] }, clone: { omc: '6.0.0', 'oh-my-claudecode': '6.0.0' } });
        expect({ key, label, keys: Object.keys(out) }).toEqual({ key, label, keys: ['Channel'] });
        expect(out.Channel).toContain('unknown');
      }
    }
  });

  // Without a supported ID there is no entry to say which install is active; the installer's resolver calls such a
  // registry ambiguous and so does Step 1, instead of taking the absence of an entry for the npm channel.
  test('a registry the installer would call ambiguous, with no supported ID, gives an unknown channel and not npm', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['a null list under an unrelated key', { 'some-other-plugin@market': null }],
      ['an empty list under an unrelated key', { 'some-other-plugin@market': [] }],
      ['an object under an unrelated key', { 'some-other-plugin@market': { version: '1.0.0' } }],
      ['a look-alike key that is not a supported ID', { 'oh-my-claudecode-fork@market': [{ version: '1.0.0' }] }],
      ['a null plugins value', { plugins: null }],
    ];
    for (const [label, plugins] of cases) {
      const out = step1({ raw: JSON.stringify(plugins), cache: { omc: ['5.9.0'] } });
      expect({ label, keys: Object.keys(out) }).toEqual({ label, keys: ['Channel'] });
      expect(out.Channel).toContain('unknown');
    }
  });

  // The entry rule of the cache commands applies under every key: an unrelated plugin's entry that is null, not an object,
  // a nested array or has neither field is malformed, and the cache commands move nothing for a registry that holds one.
  // Step 1 treats it like the other defects of an unrelated key (an empty or non-array list, a look-alike key): without a
  // supported ID the registry is ambiguous and the channel is unknown, with one the good OMC entry still names its channel.
  test('a malformed entry under an unrelated key gives an unknown channel without a supported ID and does not hide a good one, before or after it', () => {
    const malformed: Array<[string, unknown[]]> = [
      ['a null entry', [null]],
      ['a string entry', ['junk']],
      ['a nested array', [[{ version: '5.9.0' }]]],
      ['an entry with neither version nor installPath', [{ scope: 'user' }]],
      ['a blank installPath', [{ installPath: '' }]],
      ['a version that is not a string', [{ version: 5 }]],
      ['a valid entry and then a null entry', [{ version: '1.0.0' }, null]],
    ];
    for (const [label, entries] of malformed) {
      for (const supported of [false, true]) {
        for (const position of ['before', 'after'] as const) {
          const pin = supported ? { 'oh-my-claudecode@omc': [{ version: '5.8.0' }] } : {};
          const other = { 'some-other-plugin@market': entries };
          const out = step1({ plugins: position === 'before' ? { ...other, ...pin } : { ...pin, ...other }, cache: { omc: ['5.9.0'] }, clone: { omc: '6.0.0' } });
          if (supported) {
            expect({ label, position, out }).toMatchObject({ label, position, out: { Plugin: 'oh-my-claudecode@omc', Channel: 'marketplace omc', Installed: '5.8.0' } });
          } else {
            expect({ label, position, keys: Object.keys(out) }).toEqual({ label, position, keys: ['Channel'] });
            expect(out.Channel).toContain('unknown');
          }
        }
      }
    }
  });

  test('well-formed entries under an unrelated key keep the channel, and an explicit plugin root still answers first', () => {
    const fine = { 'some-other-plugin@market': [{ version: '1.0.0' }, { installPath: '/nowhere' }, { version: null, installPath: '/nowhere' }] };
    expect(step1({ plugins: { 'oh-my-claudecode@omc': [{ version: '5.8.0' }], ...fine }, clone: { omc: '5.8.0' } })).toMatchObject({ Channel: 'marketplace omc', Installed: '5.8.0' });
    expect(step1({ plugins: fine, cache: { omc: ['5.9.0'] } })).toEqual({ Channel: 'npm', Installed: '5.9.0', Updater: 'omc update' });
    const env = (dir: string) => {
      const root = path.join(dir, 'checkout');
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '5.9.0' }));
      return { OMC_PLUGIN_ROOT: root };
    };
    expect(step1({ plugins: { 'some-other-plugin@market': [null] }, env }).Channel).toBe('plugin-dir');
    expect(step1({ plugins: { 'some-other-plugin@market': [{ scope: 'user' }] }, env: (dir) => ({ CLAUDE_PLUGIN_ROOT: env(dir).OMC_PLUGIN_ROOT }) }).Channel).toBe('plugin-dir');
  });

  test('a good supported entry still names its channel when another key of the registry is ambiguous', () => {
    for (const other of [{ 'some-other-plugin@market': [] }, { 'some-other-plugin@market': null }, { 'oh-my-claudecode-fork@market': [{ version: '1.0.0' }] }]) {
      expect(step1({ plugins: { 'oh-my-claudecode@omc': [{ version: '5.8.0' }], ...other }, clone: { omc: '5.8.0' } })).toMatchObject({
        Plugin: 'oh-my-claudecode@omc',
        Channel: 'marketplace omc',
        Installed: '5.8.0',
      });
    }
  });

  // --plugin-dir: the explicit root, not the absence of a registry entry, names the active plugin.
  describe('an explicit plugin root (--plugin-dir)', () => {
    const makeRoot = (dir: string, name: string, files: Record<string, unknown>) => {
      const root = path.join(dir, name);
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), JSON.stringify(body));
      }
      return root;
    };
    const updater = 'none (update and rebuild that checkout, then run omc setup --plugin-dir-mode)';

    test('OMC_PLUGIN_ROOT with no registry entry is a plugin-dir install, not npm', () => {
      let root = '';
      const out = step1({
        cache: { omc: ['5.1.0'] },
        env: (dir) => ({ OMC_PLUGIN_ROOT: (root = makeRoot(dir, 'checkout', { 'package.json': { version: '5.9.0' } })) }),
      });
      expect(out).toEqual({
        'Plugin root': root,
        Channel: 'plugin-dir',
        Installed: '5.9.0',
        Latest: '(unavailable) (a --plugin-dir checkout has no update channel)',
        Updater: updater,
      });
    });

    test('the root of CLAUDE_PLUGIN_ROOT alone counts, the version may come from the plugin manifest, and a root without a version is (none)', () => {
      for (const [files, installed] of [
        [{ '.claude-plugin/plugin.json': { name: 'oh-my-claudecode', version: '5.8.4' } }, '5.8.4'],
        [{ 'package.json': { version: '5.9.0' }, '.claude-plugin/plugin.json': { version: '5.8.4' } }, '5.9.0'],
        [{ 'package.json': { name: 'x' } }, '(none)'],
      ] as const) {
        const out = step1({ env: (dir) => ({ CLAUDE_PLUGIN_ROOT: makeRoot(dir, 'checkout', files) }) });
        expect(out.Channel).toBe('plugin-dir');
        expect(out.Installed).toBe(installed);
        expect(Object.keys(out)).toEqual(['Plugin root', 'Channel', 'Installed', 'Latest', 'Updater']);
      }
    });

    test('the same directory through a link, or one root set in two variables, is one root; two different directories are unknown', () => {
      const both = (second: (dir: string, root: string) => string) => step1({
        env: (dir) => {
          const root = makeRoot(dir, 'checkout', { 'package.json': { version: '5.9.0' } });
          return { OMC_PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: second(dir, root) };
        },
      });
      expect(both((_dir, root) => root).Channel).toBe('plugin-dir');
      expect(both((_dir, root) => root + path.sep).Channel).toBe('plugin-dir');
      expect(both((dir, root) => {
        const alias = path.join(dir, 'alias');
        symlinkSync(root, alias, 'junction');
        return alias;
      }).Channel).toBe('plugin-dir');
      const other = both((dir) => makeRoot(dir, 'other', { 'package.json': { version: '5.1.0' } }));
      expect(Object.keys(other)).toEqual(['Channel']);
      expect(other.Channel).toContain('unknown');
    });

    // CLAUDE_PLUGIN_ROOT is only a locator (Claude Code sets it for the plugin a hook belongs to, marketplace installs included),
    // so it names the active checkout only where the registry holds no supported ID; OMC_PLUGIN_ROOT is the explicit override (below).
    test('a supported registry entry keeps the marketplace channel for CLAUDE_PLUGIN_ROOT alone, an unrelated plugin or a broken registry does not hide the root', () => {
      const env = (dir: string) => ({ CLAUDE_PLUGIN_ROOT: makeRoot(dir, 'checkout', { 'package.json': { version: '5.9.0' } }) });
      const market = step1({ plugins: { 'oh-my-claudecode@omc': [{ version: '5.8.0' }] }, clone: { omc: '5.8.0' }, env });
      expect(market).toMatchObject({ Plugin: 'oh-my-claudecode@omc', Channel: 'marketplace omc', Installed: '5.8.0' });
      expect(step1({ plugins: { 'some-other-plugin@market': [{ version: '1.0.0' }] }, env }).Channel).toBe('plugin-dir');
      // The installer prefers the explicit root over a registry it cannot read as well.
      expect(step1({ plugins: { 'some-other-plugin@market': null as unknown as unknown[] }, env }).Channel).toBe('plugin-dir');
      // An unreadable registry file stays unknown: whether a supported entry exists cannot be told.
      expect(step1({ raw: '{not json', env }).Channel).toContain('unknown');
    });

    test('two different roots are unknown whatever the registry holds, as for the cache commands', () => {
      const env = (dir: string) => ({
        OMC_PLUGIN_ROOT: makeRoot(dir, 'checkout', { 'package.json': { version: '5.9.0' } }),
        CLAUDE_PLUGIN_ROOT: makeRoot(dir, 'other', { 'package.json': { version: '5.1.0' } }),
      });
      for (const plugins of [{ 'oh-my-claudecode@omc': [{ version: '5.8.0' }] }, { 'some-other-plugin@market': [{ version: '1.0.0' }] }, undefined]) {
        const out = step1({ plugins, env, clone: { omc: '5.8.0' } });
        expect(Object.keys(out)).toEqual(['Channel']);
        expect(out.Channel).toContain('different directories');
      }
    });

    // OMC_PLUGIN_ROOT is the explicit override (`omc --plugin-dir`, highest priority in the runtime resolution), so it names the
    // loaded checkout whatever the registry holds, unless it names the install a supported entry pins: its installPath or the
    // cache directory its version names. That one is the registry's own install and its channel decides. Where a directory
    // lies excuses nothing else: another cache version is a checkout of its own.
    // A root that does not exist is not a loaded checkout (the runtime skips it) and never overrides anything.
    describe('OMC_PLUGIN_ROOT against the registry', () => {
      type Layout = { name: string; key: string; ns: string };
      const layouts: Layout[] = [
        { name: 'cache of the omc namespace', key: 'oh-my-claudecode@omc', ns: 'omc' },
        { name: 'cache of the marketplace namespace', key: 'oh-my-claudecode@oh-my-claudecode', ns: 'oh-my-claudecode' },
      ];
      const registries = ['missing', 'valid', 'invalid JSON', 'top-level array', 'null'] as const;
      const roots = ['unset', 'the cache install', 'a checkout elsewhere', 'a path that does not exist'] as const;

      test('grid: registry x OMC_PLUGIN_ROOT x cache layout', () => {
        for (const layout of layouts) {
          for (const registry of registries) {
            for (const root of roots) {
              let checkout = '';
              const out = step1({
                cache: { [layout.ns]: ['5.8.0'] },
                clone: { [layout.ns]: '5.8.0' },
                ...(registry === 'valid'
                  ? { plugins: (dir: string) => ({ [layout.key]: [{ scope: 'user', version: '5.8.0', installPath: path.join(dir, 'plugins', 'cache', layout.ns, 'oh-my-claudecode', '5.8.0') }] }) }
                  : registry === 'missing' ? {} : { raw: { 'invalid JSON': '{not json', 'top-level array': '[]', null: 'null' }[registry] }),
                env: (dir) => ({
                  OMC_PLUGIN_ROOT: root === 'unset' ? ''
                    : root === 'the cache install' ? path.join(dir, 'plugins', 'cache', layout.ns, 'oh-my-claudecode', '5.8.0')
                      : root === 'a path that does not exist' ? path.join(dir, 'gone')
                        : (checkout = makeRoot(dir, 'checkout', { 'package.json': { version: '9.9.0' } })),
                }),
              });
              const unreadable = registry !== 'missing' && registry !== 'valid';
              const expected: Record<string, string> =
                root === 'a checkout elsewhere' ? { Channel: 'plugin-dir', Installed: '9.9.0', 'Plugin root': checkout }
                  : unreadable ? { Channel: 'unknown' }
                    : registry === 'valid' ? { Channel: `marketplace ${layout.ns}`, Installed: '5.8.0', Plugin: layout.key }
                      // A root that does not exist is not a loaded checkout (the runtime skips it), so it never overrides a registry entry
                      // and, with no registry at all, it is no plugin-dir install either: the managed cache answers, as with no root.
                      : root === 'unset' || root === 'a path that does not exist' ? { Channel: 'npm', Installed: layout.ns === 'omc' ? '5.8.0' : '(none)' } // the npm channel reads the omc cache only
                        : { Channel: 'plugin-dir', Installed: '(none)' };
              const got = Object.fromEntries(Object.keys(expected).map((k) => [k, k === 'Channel' && expected.Channel === 'unknown' ? (out.Channel ?? '').split(' ')[0] : out[k]]));
              expect({ layout: layout.name, registry, root, got }).toEqual({ layout: layout.name, registry, root, got: expected });
              if (expected.Channel === 'unknown') expect(Object.keys(out)).toEqual(['Channel']);
              if (expected.Channel === 'plugin-dir') expect(out.Updater).toBe(updater);
            }
          }
        }
      });

      // A file system that reports inode 0 gives no identity; the root is then judged by its path, as the commands do.
      test('where the file system reports inode 0, the pinned cache version stays a registry install by its path and another cache version is a checkout', () => {
        const zeroInode = "const fs = require('fs'); const real = fs.statSync; fs.statSync = function (target, options) { const stat = real.call(fs, target, options); if (options && options.bigint) stat.ino = 0n; return stat; };\n";
        for (const [version, channel] of [['5.8.0', 'marketplace omc'], ['5.7.0', 'plugin-dir']] as const) {
          const out = step1({
            plugins: { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0' }] },
            cache: { omc: ['5.7.0', '5.8.0'] },
            clone: { omc: '5.8.0' },
            setup: (dir) => writeFileSync(path.join(dir, 'zero-inode.cjs'), zeroInode),
            env: (dir) => ({ OMC_PLUGIN_ROOT: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', version), NODE_OPTIONS: `--require ${path.join(dir, 'zero-inode.cjs')}` }),
          });
          expect({ version, channel: out.Channel }).toEqual({ version, channel });
        }
      });

      test('a 9.9.0 checkout named by OMC_PLUGIN_ROOT is not reported as the 5.8.0 marketplace install of a stale registry entry', () => {
        let root = '';
        const out = step1({
          plugins: { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0' }] },
          clone: { omc: '6.0.0' },
          cache: { omc: ['5.8.0'] },
          env: (dir) => ({ OMC_PLUGIN_ROOT: (root = makeRoot(dir, 'checkout', { 'package.json': { version: '9.9.0' } })) }),
        });
        expect(out).toEqual({ 'Plugin root': root, Channel: 'plugin-dir', Installed: '9.9.0', Latest: '(unavailable) (a --plugin-dir checkout has no update channel)', Updater: updater });
        expect(JSON.stringify(out)).not.toContain('claude plugin update');
      });

      test('the install of the registry entry stays a marketplace install: its installPath anywhere or reached through a link, or the cache directory its version names', () => {
        for (const spelled of ['plain', 'link'] as const) {
          const out = step1({
            plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0', installPath: path.join(dir, 'custom', 'install') }] }),
            clone: { omc: '5.8.0' },
            env: (dir) => {
              const install = makeRoot(dir, path.join('custom', 'install'), { 'package.json': { version: '5.8.0' } });
              if (spelled === 'plain') return { OMC_PLUGIN_ROOT: install };
              symlinkSync(install, path.join(dir, 'alias'), 'junction');
              return { OMC_PLUGIN_ROOT: path.join(dir, 'alias') };
            },
          });
          expect({ spelled, channel: out.Channel, installed: out.Installed }).toEqual({ spelled, channel: 'marketplace omc', installed: '5.8.0' });
        }
        // The cache directory the pinned version names is the registry's install even when the entry has no installPath, in
        // the cache of the marketplace its key names (any letter case; the bare key and the legacy key use the omc one).
        for (const [key, market] of [['oh-my-claudecode@omc', 'omc'], ['oh-my-claudecode@oh-my-claudecode', 'oh-my-claudecode'], ['OH-MY-CLAUDECODE@OH-MY-CLAUDECODE', 'oh-my-claudecode'], ['oh-my-claudecode', 'omc']] as const) {
          const pinned = step1({
            plugins: { [key]: [{ scope: 'user', version: '5.8.0' }] },
            cache: { [market]: ['5.7.0', '5.8.0'] },
            env: (dir) => ({ OMC_PLUGIN_ROOT: path.join(dir, 'plugins', 'cache', market, 'oh-my-claudecode', '5.8.0') }),
          });
          expect({ key, channel: pinned.Channel }).toEqual({ key, channel: `marketplace ${market}` });
        }
      });

      // An explicit root is explicit wherever it lies. A cache version the registry does not pin, a directory in the cache of
      // another plugin and a path below the pinned version are checkouts of their own (the session loads exactly that
      // directory), and the cache commands still protect the directory the variable points into.
      test('a root inside plugins/cache that the registry does not pin is the loaded checkout, not the registry install', () => {
        const cacheDir = (dir: string, ...parts: string[]) => path.join(dir, 'plugins', 'cache', ...parts);
        const layouts: Array<[string, (dir: string) => string, string]> = [
          ['an older cache version', (dir) => makeRoot(dir, path.join('plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.0'), { 'package.json': { version: '5.7.0' } }), '5.7.0'],
          ['a directory in the cache of another plugin', (dir) => makeRoot(dir, path.join('plugins', 'cache', 'other-market', 'other-plugin', '1.0.0'), { 'package.json': { version: '1.0.0' } }), '1.0.0'],
          ['a path below the pinned version', (dir) => makeRoot(dir, path.join('plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0', 'checkout'), { 'package.json': { version: '5.8.1' } }), '5.8.1'],
        ];
        for (const [label, make, installed] of layouts) {
          for (const withInstallPath of [true, false]) {
            let root = '';
            const out = step1({
              plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0', ...(withInstallPath ? { installPath: cacheDir(dir, 'omc', 'oh-my-claudecode', '5.8.0') } : {}) }] }),
              cache: { omc: ['5.7.0', '5.8.0'] },
              clone: { omc: '6.0.0' },
              env: (dir) => ({ OMC_PLUGIN_ROOT: (root = make(dir)) }),
            });
            expect({ label, withInstallPath, out }).toEqual({
              label, withInstallPath,
              out: { 'Plugin root': root, Channel: 'plugin-dir', Installed: installed, Latest: '(unavailable) (a --plugin-dir checkout has no update channel)', Updater: updater },
            });
          }
        }
      });

      // The registry cannot be read, so the cache directory cannot be told from the pinned install: the channel is unknown, not
      // a guess. Without any registry file there is nothing to tell it from, and the explicit root is the checkout.
      test('a root inside plugins/cache with a registry that cannot be read is unknown, with no registry at all it is the checkout', () => {
        const inCache = (dir: string) => path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.7.0');
        for (const raw of ['{not json', '[]', 'null']) {
          const out = step1({ raw, cache: { omc: ['5.7.0', '5.8.0'] }, env: (dir) => ({ OMC_PLUGIN_ROOT: inCache(dir) }) });
          expect({ raw, keys: Object.keys(out), channel: (out.Channel ?? '').split(' ')[0] }).toEqual({ raw, keys: ['Channel'], channel: 'unknown' });
        }
        const none = step1({ cache: { omc: ['5.7.0', '5.8.0'] }, env: (dir) => ({ OMC_PLUGIN_ROOT: inCache(dir) }) });
        expect(none.Channel).toBe('plugin-dir');
      });

      test('the cache commands keep the cache version that OMC_PLUGIN_ROOT names while they move the free one', () => {
        for (const command of commands) {
          const { dir, cache } = makeCache(['5.6.0', '5.7.0', '5.8.0']);
          try {
            writeRegistry(dir, { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] });
            const result = runCommand(command, dir, { env: { OMC_PLUGIN_ROOT: path.join(cache, '5.7.0') } });
            expect({ status: result.status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.7.0,5.8.0', moved: 1 });
            expect(result.stdout).toContain('Kept protected cache versions');
            expect(result.stdout).toContain('5.7.0');
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      });

      // Where a volume ignores letter case while the platform says linux (WSL2 on a Windows drive), two spellings of a
      // directory are one directory: the commands compare by filesystem identity, not by the name of the platform.
      test('a letter-case alias of the install, or of the checkout named by both variables, is the same directory', () => {
        const aliasOfInstall = (casefold: boolean) => step1({
          casefold,
          plugins: { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.0' }] },
          cache: { omc: ['5.8.0'] },
          env: (dir) => ({ OMC_PLUGIN_ROOT: upperBelow(dir, path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.8.0')) }),
        });
        expect(aliasOfInstall(true).Channel).toBe('marketplace omc');
        // Control: on a volume that does tell the names apart the alias names no directory, which overrides nothing.
        expect(aliasOfInstall(false).Channel).toBe('marketplace omc');
        const twoSpellings = (casefold: boolean, other: 'alias' | 'different') => step1({
          casefold,
          env: (dir) => {
            const root = makeRoot(dir, 'checkout', { 'package.json': { version: '9.9.0' } });
            return { OMC_PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: upperBelow(dir, other === 'alias' ? root : makeRoot(dir, 'other', { 'package.json': { version: '5.1.0' } })) };
          },
        });
        expect(twoSpellings(true, 'alias').Channel).toBe('plugin-dir');
        expect(twoSpellings(true, 'different').Channel).toContain('different directories');
        const folded = twoSpellings(false, 'alias').Channel;
        // On a volume that tells the names apart the alias names no directory and is ignored, so the one checkout still answers.
        expect(folded).toBe('plugin-dir');
      });
    });
  });

  // A FIFO, or a link to one, in place of a file that Step 1 reads would block the read for ever. Every read
  // goes through one regular-file check (`stat` follows links), and the command runs with a timeout here.
  describe.skipIf(process.platform === 'win32')('a FIFO in place of a file Step 1 reads does not hang the diagnosis', () => {
    const mkfifo = (file: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      expect(spawnSync('mkfifo', [file]).status).toBe(0);
    };
    const registryPath = (dir: string) => path.join(dir, 'plugins', 'installed_plugins.json');

    test('the registry is a FIFO or a link to one: unknown channel, no updater', () => {
      for (const setup of [
        (dir: string) => mkfifo(registryPath(dir)),
        (dir: string) => {
          mkfifo(path.join(dir, 'fifo'));
          symlinkSync(path.join(dir, 'fifo'), registryPath(dir));
        },
      ]) {
        const out = step1({ setup, cache: { omc: ['5.9.0'] } });
        expect(Object.keys(out)).toEqual(['Channel']);
        expect(out.Channel).toContain('unknown');
      }
    });

    test('the package.json under an installPath, the marketplace clone manifest and the root manifests are skipped like a missing file', () => {
      const alias = step1({
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ installPath: path.join(dir, 'alias') }] }),
        cache: { omc: ['5.7.0'] },
        setup: (dir) => mkfifo(path.join(dir, 'alias', 'package.json')),
      });
      expect(alias).toMatchObject({ Channel: 'marketplace omc', Installed: '5.7.0' });
      const clone = step1({
        plugins: { 'oh-my-claudecode@omc': [{ version: '5.8.0' }] },
        setup: (dir) => mkfifo(path.join(dir, 'plugins', 'marketplaces', 'omc', '.claude-plugin', 'marketplace.json')),
      });
      expect(clone).toMatchObject({ Installed: '5.8.0', Latest: '(unavailable) (marketplace clone)' });
      const root = step1({
        env: (dir) => ({ OMC_PLUGIN_ROOT: path.join(dir, 'checkout') }),
        setup: (dir) => {
          mkfifo(path.join(dir, 'checkout', 'package.json'));
          mkfifo(path.join(dir, 'checkout', '.claude-plugin', 'plugin.json'));
        },
      });
      expect(root).toMatchObject({ Channel: 'plugin-dir', Installed: '(none)' });
    });
  });

  // A root variable that names nothing is not a loaded checkout (the runtime wrapper looks for the HUD of the root and otherwise
  // falls through to the managed cache), so it never makes a plugin-dir install, a conflict or a channel on its own.
  describe('a plugin root variable that does not name an existing directory is ignored', () => {
    const makeRoot = (dir: string, name: string) => {
      const root = path.join(dir, name);
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '5.9.0' }));
      return root;
    };
    const npm = { Channel: 'npm', Installed: '5.8.0', Updater: 'omc update' };

    test('a stale OMC_PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT leaves the npm install on the npm channel, with or without an unrelated registry entry', () => {
      for (const variable of ['OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
        for (const plugins of [undefined, { 'some-other-plugin@market': [{ version: '1.0.0' }] }]) {
          expect({ variable, out: step1({ plugins, cache: { omc: ['5.7.0', '5.8.0'] }, env: (dir) => ({ [variable]: path.join(dir, 'gone') }) }) }).toEqual({ variable, out: npm });
        }
      }
    });

    test('a root that is a file, or two stale roots that differ, are ignored as well', () => {
      expect(step1({ cache: { omc: ['5.8.0'] }, env: (dir) => ({ OMC_PLUGIN_ROOT: (writeFileSync(path.join(dir, 'a-file'), '{}'), path.join(dir, 'a-file')) }) })).toEqual(npm);
      expect(step1({ cache: { omc: ['5.8.0'] }, env: (dir) => ({ OMC_PLUGIN_ROOT: path.join(dir, 'gone-a'), CLAUDE_PLUGIN_ROOT: path.join(dir, 'gone-b') }) })).toEqual(npm);
    });

    test('a stale root next to an existing one is no conflict: the existing checkout is the plugin root, in either order', () => {
      for (const [stale, live] of [['OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'], ['CLAUDE_PLUGIN_ROOT', 'OMC_PLUGIN_ROOT']]) {
        let root = '';
        const out = step1({ cache: { omc: ['5.8.0'] }, env: (dir) => ({ [stale]: path.join(dir, 'gone'), [live]: (root = makeRoot(dir, 'checkout')) }) });
        expect({ stale, out }).toEqual({ stale, out: { 'Plugin root': root, Channel: 'plugin-dir', Installed: '5.9.0', Latest: '(unavailable) (a --plugin-dir checkout has no update channel)', Updater: 'none (update and rebuild that checkout, then run omc setup --plugin-dir-mode)' } });
      }
    });
  });

  // With several scopes one plugin ID has several entries; the session runs the one whose installPath is the active root,
  // not the highest version in the list.
  describe('the entry of the active root decides Installed when a plugin ID has entries for several scopes', () => {
    const entries = (dir: string, extra: Record<string, unknown> = {}) => {
      const base = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
      return { 'oh-my-claudecode@omc': [{ scope: 'project', version: '5.8.0', installPath: path.join(base, '5.8.0'), ...extra }, { scope: 'user', version: '5.9.0', installPath: path.join(base, '5.9.0') }] };
    };
    const base = (dir: string, v: string) => path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', v);
    const run = (env: ((dir: string) => Record<string, string>) | undefined, plugins: (dir: string) => Record<string, unknown> = entries) =>
      step1({ plugins, cache: { omc: ['5.8.0', '5.9.0'] }, clone: { omc: '5.9.0' }, env });

    test('a root on the older entry reports that entry, a root on the newer entry or none reports the highest', () => {
      for (const variable of ['OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
        expect({ variable, got: run((dir) => ({ [variable]: base(dir, '5.8.0') })).Installed }).toEqual({ variable, got: '5.8.0' });
        expect({ variable, got: run((dir) => ({ [variable]: base(dir, '5.9.0') })).Installed }).toEqual({ variable, got: '5.9.0' });
      }
      expect(run(undefined).Installed).toBe('5.9.0');
      expect(run((dir) => ({ CLAUDE_PLUGIN_ROOT: dir })).Installed).toBe('5.9.0');
      expect(run((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') + path.sep })).Installed).toBe('5.8.0');
    });

    test('a root that is a link to the install, or lies inside it, or is set in both variables in two spellings, is the active entry', () => {
      expect(run((dir) => {
        symlinkSync(base(dir, '5.8.0'), path.join(dir, 'lnk'), 'junction');
        return { CLAUDE_PLUGIN_ROOT: path.join(dir, 'lnk') };
      }).Installed).toBe('5.8.0');
      expect(run((dir) => {
        mkdirSync(path.join(base(dir, '5.8.0'), 'scripts'), { recursive: true });
        return { CLAUDE_PLUGIN_ROOT: path.join(base(dir, '5.8.0'), 'scripts') };
      }).Installed).toBe('5.8.0');
      expect(run((dir) => ({ OMC_PLUGIN_ROOT: base(dir, '5.8.0'), CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') + path.sep })).Installed).toBe('5.8.0');
      // The parent of the versions is inside no entry's installPath.
      expect(run((dir) => ({ CLAUDE_PLUGIN_ROOT: path.dirname(base(dir, '5.8.0')) })).Installed).toBe('5.9.0');
    });

    test('each plugin ID follows the active root on its own, and a stale variable next to the active root of a supported entry changes nothing', () => {
      // The output keeps the last plugin ID's lines, so the order of the registry decides which ID is read back.
      const other = { 'oh-my-claudecode@oh-my-claudecode': [{ version: '6.0.0' }] };
      const env = (dir: string) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') });
      const cache = { omc: ['5.8.0', '5.9.0'] };
      expect(step1({ plugins: (dir) => ({ ...other, ...entries(dir) }), cache, env })).toMatchObject({ Plugin: 'oh-my-claudecode@omc', Installed: '5.8.0' });
      expect(step1({ plugins: (dir) => ({ ...entries(dir), ...other }), cache, env })).toMatchObject({ Plugin: 'oh-my-claudecode@oh-my-claudecode', Installed: '6.0.0' });
      expect(run((dir) => ({ OMC_PLUGIN_ROOT: path.join(dir, 'gone'), CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') })).Installed).toBe('5.8.0');
    });

    test('the channel and the latest do not change, so the older active entry is outdated against its clone', () => {
      expect(run((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') }))).toMatchObject({ Channel: 'marketplace omc', Installed: '5.8.0', Latest: '5.9.0 (marketplace clone)' });
    });

    test('the active entry may name its version only through its installPath, and one that names none is (none), not the highest cached version', () => {
      expect(run((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') }), (dir) => ({ 'oh-my-claudecode@omc': [{ installPath: base(dir, '5.8.0') }, { version: '5.9.0' }] })).Installed).toBe('5.8.0');
      const out = step1({
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ installPath: path.join(dir, 'current') }, { version: '5.9.0' }] }),
        cache: { omc: ['5.9.0'] },
        env: (dir) => {
          mkdirSync(path.join(dir, 'current'), { recursive: true });
          return { CLAUDE_PLUGIN_ROOT: path.join(dir, 'current') };
        },
      });
      expect(out).toMatchObject({ Channel: 'marketplace omc', Installed: '(none)' });
    });

    test('a root that matches no entry, or a stale one, leaves the highest entry as Installed', () => {
      // The cache holds only 5.8.0 here, so the highest entry cannot come from the cache listing.
      const noNewest = (env: (dir: string) => Record<string, string>, plugins: (dir: string) => Record<string, unknown> = entries) =>
        step1({ plugins, cache: { omc: ['5.8.0'] }, clone: { omc: '5.9.0' }, env }).Installed;
      expect(noNewest((dir) => ({ CLAUDE_PLUGIN_ROOT: path.join(dir, 'gone') }))).toBe('5.9.0');
      expect(noNewest((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') }), (dir) => ({ 'oh-my-claudecode@omc': [{ version: '5.8.0' }, { version: '5.9.0', installPath: base(dir, '5.9.0') }] }))).toBe('5.9.0');
    });
  });

  test('the skill routes the update and the diagnosis through the derived lines, with no fixed updater recipe left', () => {
    expect(text).not.toMatch(/marketplace update omc/);
    expect(text).not.toMatch(/claude plugin update oh-my-claudecode@omc/);
    expect(text).not.toMatch(/\/omc-setup\b.*\bnpm install\b/);
    const diagnosis = text.slice(text.indexOf('### Step 1'), text.indexOf('### Step 2'));
    expect(diagnosis).toContain('LATEST comes from the install channel the registry records');
    expect(diagnosis).toContain('`npm view` (the `npm latest:` line) is consulted only for `Channel: npm`, so ignore that line for a marketplace install');
    expect(diagnosis).toContain('never compared with an npm-only release');
    expect(diagnosis).toContain('If INSTALLED equals the channel\'s latest, there is no WARN');
    expect(diagnosis).toContain('Order versions as semantic versions, never as text');
    expect(diagnosis).toContain('If INSTALLED is older than LATEST on the channel\'s own latest (same order): WARN - outdated plugin');
    expect(diagnosis).toContain('there is none when it is newer than that latest either');
    expect(diagnosis).toContain('If `Channel: unknown`: CRITICAL');
    expect(diagnosis).toContain('A variable whose path is not an existing directory names no checkout');
    expect(diagnosis).toContain('`Installed:` comes from those entries alone, because the session runs that install and not a newer entry of another scope');
    expect(diagnosis).toContain('If `Channel: plugin-dir`');
    expect(diagnosis).not.toMatch(/or `Channel: unknown`: report that the latest version could not be checked/);
    const outdated = text.slice(text.indexOf('### Fix: Outdated Plugin'), text.indexOf('### Fix: Stale Cache'));
    expect(outdated).toContain('run the `Updater:` line that Step 1 printed for the active plugin ID');
    expect(outdated).toContain('do not substitute a fixed marketplace or plugin ID');
    expect(outdated).toContain('`omc update`');
  });
});
