import { describe, test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bashBlocks, CLAUDE_MD_VERSION, codeOf, guideText, PLUGIN_ID, read, runBlock, runCommand, scriptSection, scriptText, upperBelow, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1, versionCommand } from './helpers/omc-doctor-step1.js';

const text = read('skills/omc-doctor/SKILL.md');

describe('omc-doctor Step 1 derives the plugin ID, channel and latest version from the active install', () => {
  test('the command exists once and does not consult npm or a fixed plugin ID', () => {
    expect(scriptText.match(/^const step1 = /gm)).toHaveLength(1);
    expect(text.match(/^node "\$S" step1$/gm)).toHaveLength(1);
    // Step 1 reads files only: the npm query is a command of its own, in its own function.
    const channel = [scriptSection('Step 1: helpers'), scriptSection('Step 1: the registry'), scriptSection('Step 1: the install channel')].join('\n');
    expect(channel).not.toMatch(/npm view|registry\.npmjs|child_process|spawnSync/);
    // The npm line has its own label, so an offline run never prints a second `Latest:` next to a marketplace one.
    const block = bashBlocks().find((b) => b.includes('node "$S" step1')) ?? '';
    const npmFunction = scriptSection('Step 1: npm latest');
    expect(npmFunction).toContain("console.log('npm latest: ' + (latest || '(unavailable)'))");
    expect(npmFunction).not.toContain('Latest:');
    expect(block.split('\n').filter((l) => l.includes('Latest:') && !l.startsWith('#'))).toEqual([]);
  });

  // The block of the skill runs the script through bash: it must produce what node produces on the same configuration
  // directory.
  test('the shell block gives the output the script gives', () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-version-'));
    try {
      mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      writeRegistry(dir, { 'oh-my-claudecode@oh-my-claudecode': [{ version: '5.8.0' }] });
      const viaNode = runCommand(versionCommand ?? '', dir);
      // The block runs the Step 1 command and then the npm line (a Channel: npm install only, which this one is not),
      // so its output is the Step 1 output followed by the npm line, here from an npm that fails.
      const bin = path.join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const viaBash = runBlock('step1', dir, { env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } });
      expect(viaNode.stdout).toContain('Channel: marketplace oh-my-claudecode');
      expect(viaBash.stdout).toBe(`${viaNode.stdout}npm latest: (unavailable)\n`);
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
  // name, the clone it is looked up in, the Plugin line and both halves of the updater follow the normalized
  // (lower case) ID, as the installer and the updater of the runtime compare plugin IDs; the key in the registry
  // keeps its spelling.
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
              Plugin: key.toLowerCase(),
              Channel: 'marketplace ' + market,
              Installed: installed,
              Latest: '6.0.0 (marketplace clone)',
              Updater: `claude plugin marketplace update ${market} && claude plugin update ${key.toLowerCase()}`,
            },
          });
        }
      }
    }
  }, 120_000);

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
    // A `version` of a registry entry is a semantic version of three parts (see omc-doctor-registry-version-grammar.test.ts), so
    // the pairs with the two-part `5.9` are ordered only as cache directory names, below.
    for (const [low, high] of pairs.filter((pair) => !pair.includes('5.9'))) {
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

  // Step 4 names the highest cached plugin version as well, with the same comparator: the script defines the version
  // order once, and Step 4 sorts its cache listing with it. Step 4 is a shell block of the skill, so it runs through bash.
  test.skipIf(process.platform === 'win32')('Step 4 names the highest cached plugin version by semantic version, with the comparator of Step 1', () => {
    const comparator = scriptSection('version order');
    expect(comparator).toContain('const compareVersions = ');
    expect(scriptText.split('const compareVersions = ')).toHaveLength(2);
    // Step 4 reads the highest cached version of a marketplace through the function Step 1 uses for the npm channel.
    expect(scriptSection('Step 1: helpers')).toContain('.filter(isVersionDir).sort(compareVersions);');
    expect(scriptSection('Step 4')).toContain('highestCached(cacheDirOf(');
    for (const prefix of prefixes) {
      const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-version-'));
      try {
        for (const version of prefix.versions) mkdirSync(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', version), { recursive: true });
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '0.0.1' }] }); // a supported ID, so the session root is no plugin-dir checkout
        writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- OMC:VERSION:5.9.0 -->\n');
        const run = runBlock(CLAUDE_MD_VERSION, dir, { timeout: 20_000 });
        expect(run.error).toBeUndefined();
        expect({ top: prefix.top, line: run.stdout.split('\n').find((l) => l.startsWith('Latest cached plugin version:')) }).toEqual({ top: prefix.top, line: `Latest cached plugin version: ${prefix.top}` });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test('no version in the skill is ordered as text', () => {
    expect(text + guideText).not.toContain('localeCompare');
    // Step 1 sorts versions in exactly three places (the highest cached version, the versions the registry records, the
    // versions an entry names twice), and all use the comparator.
    const code = codeOf([scriptSection('Step 1: helpers'), scriptSection('Step 1: the install channel')].join('\n'));
    expect(code.match(/\.sort\(/g)).toHaveLength(3);
    expect(code.match(/\.sort\(compareVersions\)/g)).toHaveLength(3);
    // Across the script two more sorts have no comparator, and none of them orders versions: the CLAUDE-*.md file names of
    // Step 4 and the marketplace names the cache commands go through (by name, not by the order of the registry).
    expect(codeOf().match(/\.sort\(\)/g)).toHaveLength(2);
    expect(scriptSection('Step 4')).toContain('.sort()');
  });

  // The npm line is a command of its own: omc-doctor-npm-latest.test.ts runs it with a fake npm on success, on failure and on a hang.

  test('a bare plugin ID keeps the legacy omc marketplace', () => {
    expect(step1({ plugins: { 'oh-my-claudecode': [{ version: '5.8.0' }] }, clone: { omc: '5.8.0' } })).toMatchObject({
      Plugin: 'oh-my-claudecode',
      Channel: 'marketplace omc',
      Updater: 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode',
    });
  });

  test('an unreadable registry names no updater', () => {
    // The last one is valid JSON behind a byte order mark, which the installer's reader rejects too.
    for (const raw of ['{not json', '[]', 'null', `\uFEFF${JSON.stringify({ plugins: { 'oh-my-claudecode@omc': [{ version: '5.9.0' }] } })}`]) {
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
  }, 120_000);

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
  }, 120_000);

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
      }, 120_000);

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

  // A clone version is the target of an update, so it must be accepted exactly where the runtime accepts it
  // (`parseSemver` in scripts/session-start.mjs, which treats any other value as unavailable marketplace metadata).
  describe('the latest version of a marketplace clone is a semantic version of the runtime grammar', () => {
    const pinned = { 'oh-my-claudecode@omc': [{ version: '5.8.0' }] };
    const latest = (version: string) => step1({ plugins: pinned, clone: { omc: version } });

    test('a malformed clone version is unavailable and no update is offered towards it', () => {
      for (const version of ['999x.0.0', '1.2', '1', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', 'v', 'vv1.2.3', 'latest', '5.9.0 beta', '5.9.0-', '5.9.0+', '5.9.0-beta..1', '5.9.0-be ta', '5.9.0_1', '1.2.3-é', '', '   ']) {
        const out = latest(version);
        expect({ version, installed: out.Installed, latest: out.Latest }).toEqual({ version, installed: '5.8.0', latest: '(unavailable) (marketplace clone)' });
        const shown = version.trim();
        if (shown) expect({ version, out: JSON.stringify(out) }).toEqual({ version, out: expect.not.stringContaining(`"${shown}`) });
      }
    });

    test('a valid clone version is the latest, with a leading v dropped and whitespace trimmed', () => {
      const accepted: Array<[string, string]> = [['5.9.0', '5.9.0'], ['0.0.0', '0.0.0'], ['5.10.0', '5.10.0'], ['5.9.0-beta.2', '5.9.0-beta.2'], ['5.9.0+build.7', '5.9.0+build.7'], ['5.9.0-rc.1+build.7', '5.9.0-rc.1+build.7'], ['5.9.0-0', '5.9.0-0'], ['5.9.0-x-y.1', '5.9.0-x-y.1'], ['v5.9.0', '5.9.0'], [' 5.9.0 ', '5.9.0'], ['v5.9.0-beta.1', '5.9.0-beta.1']];
      for (const [version, shown] of accepted) expect({ version, latest: latest(version).Latest }).toEqual({ version, latest: `${shown} (marketplace clone)` });
    });

    test('the value of a clone manifest that is not a string is unavailable', () => {
      for (const version of [5, null, ['5.9.0'], { v: '5.9.0' }, true]) {
        const out = step1({ plugins: pinned, setup: (dir) => writeFileSync(path.join(dir, 'plugins', 'marketplaces', 'omc', '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'oh-my-claudecode', version }] })), clone: { omc: '5.9.0' } });
        expect({ version, latest: out.Latest }).toEqual({ version, latest: '(unavailable) (marketplace clone)' });
      }
    });

    // The script carries its own copy of the grammar, so it is run side by side with the runtime function on a grid.
    test('the grammar of the command accepts exactly the strings the runtime parseSemver accepts', () => {
      const runtime = read('scripts/session-start.mjs');
      const source = runtime.slice(runtime.indexOf('function parseSemver('), runtime.indexOf('function semverCompare('));
      expect(source).not.toBe('');
      const parseSemver = new Function(`${source}; return parseSemver;`)() as (v: unknown) => unknown;
      // The grammar is a section of the script (the optional `v` is dropped by its `dropV`), so it is run as written.
      const section = scriptSection('version grammar');
      expect(section).toContain('const semver = ');
      const sv = new Function(`${section}; return semver;`)() as (v: string) => string;
      const grid = ['5.9.0', '0.0.0', '1.2', '1', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', 'v1.2.3', 'V1.2.3', 'vv1.2.3', '999x.0.0', '1.2.3-', '1.2.3+', '1.2.3-a', '1.2.3-a.b', '1.2.3-a..b', '1.2.3-01', '1.2.3-a+b', '1.2.3+b.c', '1.2.3+b..c', '1.2.3+-', '1.2.3-+b', '1.2.3-a_b', ' 1.2.3 ', '1.2.3\n', '\n1.2.3', '1.2.3\n4', '1.2.3 4', '١.٢.٣', '1.2.3-é', '', ' ', '-1.2.3', '1.-2.3', '1.2.3-0.0', '10.20.30-rc.1+meta-1', '1.2.3-alpha.1.2.3.4.5.6.7.8.9'];
      for (const value of grid) expect({ value, accepted: sv(value) !== '' }).toEqual({ value, accepted: parseSemver(value) !== null });
    });
  });

  test('the skill routes the update and the diagnosis through the derived lines, with no fixed updater recipe left', () => {
    expect(text + guideText).not.toMatch(/marketplace update omc/);
    expect(text + guideText).not.toMatch(/claude plugin update oh-my-claudecode@omc/);
    expect(text + guideText).not.toMatch(/\/omc-setup\b.*\bnpm install\b/);
    // The rules of Step 1 and the details they leave to the guide (the sections of Step 1 and the ordering of versions).
    const diagnosis = text.slice(text.indexOf('### Step 1'), text.indexOf('### Step 2')) + '\n' + guideText;
    expect(diagnosis).toContain('LATEST comes from the install channel the registry records');
    expect(diagnosis).toContain('`npm view` (the `npm latest:` line, printed by a command of its own that gives npm 20 seconds) is consulted only for `Channel: npm`, so ignore that line for a marketplace install');
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
