import { describe, test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand, STEP1, writeRegistry, writeRegistryFile } from './helpers/omc-doctor-cache-fixture.js';
import { step1, step1Blocks } from './helpers/omc-doctor-step1.js';

describe('omc-doctor Step 1 derives the plugin ID, channel and latest version from the active install', () => {
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

    // Entries that carry only a version name the cache directory of that version, so they follow the active root as well.
    test('entries with a version and no installPath follow the active root by the cache directory of their version', () => {
      const pins = (dir: string) => ({ 'oh-my-claudecode@omc': [{ scope: 'project', version: '5.8.0' }, { scope: 'user', version: '5.9.0' }] });
      const versionOnly = (env: ((dir: string) => Record<string, string>) | undefined) => run(env, pins);
      for (const variable of ['OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
        expect({ variable, got: versionOnly((dir) => ({ [variable]: base(dir, '5.8.0') })).Installed }).toEqual({ variable, got: '5.8.0' });
        expect({ variable, got: versionOnly((dir) => ({ [variable]: base(dir, '5.9.0') })).Installed }).toEqual({ variable, got: '5.9.0' });
      }
      expect(versionOnly(undefined).Installed).toBe('5.9.0');
      expect(versionOnly((dir) => ({ CLAUDE_PLUGIN_ROOT: dir })).Installed).toBe('5.9.0');
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
      // Two plugin IDs print two blocks, in the order of the registry: both are read back, not only the last one.
      const other = { 'oh-my-claudecode@oh-my-claudecode': [{ version: '6.0.0' }] };
      const env = (dir: string) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') });
      const cache = { omc: ['5.8.0', '5.9.0'] };
      const read = (plugins: (dir: string) => Record<string, unknown>) => step1Blocks({ plugins, cache, env }).map((block) => [block.Plugin, block.Installed]);
      expect(read((dir) => ({ ...other, ...entries(dir) }))).toEqual([['oh-my-claudecode@oh-my-claudecode', '6.0.0'], ['oh-my-claudecode@omc', '5.8.0']]);
      expect(read((dir) => ({ ...entries(dir), ...other }))).toEqual([['oh-my-claudecode@omc', '5.8.0'], ['oh-my-claudecode@oh-my-claudecode', '6.0.0']]);
      expect(run((dir) => ({ OMC_PLUGIN_ROOT: path.join(dir, 'gone'), CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') })).Installed).toBe('5.8.0');
    });

    test('the channel and the latest do not change, so the older active entry is outdated against its clone', () => {
      expect(run((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') }))).toMatchObject({ Channel: 'marketplace omc', Installed: '5.8.0', Latest: '5.9.0 (marketplace clone)' });
    });

    test('the active entry may name its version only through its installPath, and one that names none is unknown, not the highest cached version', () => {
      expect(run((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') }), (dir) => ({ 'oh-my-claudecode@omc': [{ installPath: base(dir, '5.8.0') }, { version: '5.9.0' }] })).Installed).toBe('5.8.0');
      const out = step1({
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ installPath: path.join(dir, 'current') }, { version: '5.9.0' }] }),
        cache: { omc: ['5.9.0'] },
        env: (dir) => {
          mkdirSync(path.join(dir, 'current'), { recursive: true });
          return { CLAUDE_PLUGIN_ROOT: path.join(dir, 'current') };
        },
      });
      expect(out).toMatchObject({ Channel: 'marketplace omc', Installed: '(unknown)', Note: expect.stringContaining('the registry records no version for this install') });
    });

    test('a root that matches no entry, or a stale one, leaves the highest entry as Installed', () => {
      // The cache holds only 5.8.0 here, so the highest entry cannot come from the cache listing.
      const noNewest = (env: (dir: string) => Record<string, string>, plugins: (dir: string) => Record<string, unknown> = entries) =>
        step1({ plugins, cache: { omc: ['5.8.0'] }, clone: { omc: '5.9.0' }, env }).Installed;
      expect(noNewest((dir) => ({ CLAUDE_PLUGIN_ROOT: path.join(dir, 'gone') }))).toBe('5.9.0');
      const mixed = (dir: string) => ({ 'oh-my-claudecode@omc': [{ version: '5.8.0' }, { version: '5.9.0', installPath: base(dir, '5.9.0') }] });
      // An entry with only a version names the cache directory of that version, so the root on that directory is its entry.
      expect(noNewest((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') }), mixed)).toBe('5.8.0');
      expect(noNewest((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.7.0') }), mixed)).toBe('5.9.0');
    });
  });
});

// The registry is read like the runtime reads it: two spellings of one plugin ID are one plugin (the installer and the
// updater compare plugin IDs in lower case), and two different IDs are two plugins that print a block each. These cases
// read the whole output of the command, so a block that is dropped or doubled shows.
describe('omc-doctor Step 1 prints one block per plugin ID, with the ID the runtime compares', () => {
  const printed = (registry: (dir: string) => unknown): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-ids-'));
    try {
      mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      const content = registry(dir);
      if (typeof content === 'string') writeRegistryFile(dir, content);
      else writeRegistry(dir, content as Record<string, unknown>);
      const result = runCommand(STEP1, dir, { timeout: 20_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      return result.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const block = (id: string, market: string, installed: string) =>
    [
      `Plugin: ${id}`,
      `Channel: marketplace ${market}`,
      `Installed: ${installed}`,
      'Latest: (unavailable) (marketplace clone)',
      `Updater: claude plugin marketplace update ${market} && claude plugin update ${id}`,
      '',
    ].join('\n');

  test('two spellings of one plugin ID are one block with the highest version of both, in either order of the keys', () => {
    const spellings: Array<[string, string, string, string]> = [
      ['oh-my-claudecode@omc', 'OH-MY-CLAUDECODE@OMC', 'oh-my-claudecode@omc', 'omc'],
      ['OH-MY-CLAUDECODE', 'oh-my-claudecode', 'oh-my-claudecode', 'omc'],
      ['oh-my-claudecode@oh-my-claudecode', 'Oh-My-ClaudeCode@Oh-My-ClaudeCode', 'oh-my-claudecode@oh-my-claudecode', 'oh-my-claudecode'],
    ];
    for (const [first, second, id, market] of spellings) {
      const low = [{ scope: 'user', version: '5.8.1' }];
      const high = [{ scope: 'project', version: '5.9.0' }];
      expect({ first, second, order: 'low first', out: printed(() => ({ [first]: low, [second]: high })) }).toEqual({ first, second, order: 'low first', out: block(id, market, '5.9.0') });
      expect({ first, second, order: 'high first', out: printed(() => ({ [first]: high, [second]: low })) }).toEqual({ first, second, order: 'high first', out: block(id, market, '5.9.0') });
    }
  });

  test('a spelling with an unusable list keeps the registry unusable, and the other spelling does not hide it', () => {
    const out = printed(() => ({ 'oh-my-claudecode@omc': [{ version: '5.8.1' }], 'OH-MY-CLAUDECODE@OMC': [] }));
    expect(out).toContain('Channel: unknown');
    expect(out).not.toContain('Installed:');
  });

  test('the ID bare, the omc ID and the oh-my-claudecode ID are three plugins: oh-my-claudecode@omc and oh-my-claudecode@oh-my-claudecode print two blocks', () => {
    const out = printed(() => ({ 'oh-my-claudecode@omc': [{ version: '5.8.0' }], 'oh-my-claudecode@oh-my-claudecode': [{ version: '6.0.0' }] }));
    expect(out).toBe(block('oh-my-claudecode@omc', 'omc', '5.8.0') + block('oh-my-claudecode@oh-my-claudecode', 'oh-my-claudecode', '6.0.0'));
    const reversed = printed(() => ({ 'oh-my-claudecode@oh-my-claudecode': [{ version: '6.0.0' }], 'oh-my-claudecode@omc': [{ version: '5.8.0' }] }));
    expect(reversed).toBe(block('oh-my-claudecode@oh-my-claudecode', 'oh-my-claudecode', '6.0.0') + block('oh-my-claudecode@omc', 'omc', '5.8.0'));
  });

  test('the helper of the tests refuses several blocks instead of keeping the last one', () => {
    const plugins = { 'oh-my-claudecode@omc': [{ version: '5.8.0' }], 'oh-my-claudecode@oh-my-claudecode': [{ version: '6.0.0' }] };
    expect(step1Blocks({ plugins }).map((one) => one.Installed)).toEqual(['5.8.0', '6.0.0']);
    expect(() => step1({ plugins })).toThrow('expects one block');
  });

  test('the updater passes the normalized ID in both of its halves, whatever the spelling of the key', () => {
    expect(step1({ plugins: { 'OH-MY-CLAUDECODE@OMC': [{ version: '5.8.0' }] } })).toMatchObject({
      Plugin: 'oh-my-claudecode@omc',
      Channel: 'marketplace omc',
      Updater: 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode@omc',
    });
  });

  // The legacy layout has the plugin IDs at the top level of the file, with no `plugins` object around them.
  test('a registry with the plugin IDs at its top level is read like one with a plugins object', () => {
    const entries = { 'oh-my-claudecode@omc': [{ scope: 'user', version: '5.8.1' }] };
    const clone = { omc: '5.9.0' };
    const expected = { Plugin: 'oh-my-claudecode@omc', Channel: 'marketplace omc', Installed: '5.8.1', Latest: '5.9.0 (marketplace clone)' };
    expect(step1({ raw: JSON.stringify(entries), clone })).toMatchObject(expected);
    expect(step1({ raw: JSON.stringify({ version: 2, plugins: entries }), clone })).toMatchObject(expected);
    // Only the plugins object is read when there is one: a top-level key beside it is not a plugin.
    expect(step1({ raw: JSON.stringify({ 'oh-my-claudecode@omc': [{ version: '9.9.9' }], plugins: entries }), clone })).toMatchObject(expected);
  });
});

// The registry says which version was recorded for an install; the manifest of the plugin root the session runs says
// which code that is. A partial update or a damaged registry makes the two differ, and Step 1 must not report the
// recorded version as installed then: that would hide an outdated plugin behind a registry that says "current".
describe('omc-doctor Step 1 takes the installed version from the manifest of the active plugin root', () => {
  const UPDATER = 'claude plugin marketplace update omc && claude plugin update oh-my-claudecode@omc';
  const cache = (dir: string, v: string) => path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', v);
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const manifest = (version: unknown) => JSON.stringify({ name: 'oh-my-claudecode', version });

  // One marketplace entry with `entry` as its fields, the session running `root`, whose files `files` writes.
  // The marketplace clone advertises 5.9.0.
  const run = (options: {
    entry: (dir: string) => Record<string, unknown>;
    root: (dir: string) => string;
    files: (dir: string) => Record<string, string>;
    variable?: string;
  }) =>
    step1({
      plugins: (dir) => ({ 'oh-my-claudecode@omc': [options.entry(dir)] }),
      clone: { omc: '5.9.0' },
      env: (dir) => ({ [options.variable ?? 'CLAUDE_PLUGIN_ROOT']: options.root(dir) }),
      setup: (dir) => {
        for (const [file, text] of Object.entries(options.files(dir))) write(file, text);
      },
    });

  const registered = (dir: string) => ({ version: '5.9.0', installPath: cache(dir, '5.9.0') });
  const at = (v: string, file = 'package.json') => (dir: string) => ({ [path.join(cache(dir, v), file)]: manifest('5.8.0') });

  describe('a recorded version that the code of the active root does not hold', () => {
    // The case a reviewer reproduced: the entry declares 5.9.0, the cache root it points at holds 5.8.0, and the
    // marketplace advertises 5.9.0. Step 1 printed Installed 5.9.0 and Latest 5.9.0 and so hid the outdated plugin.
    test.each(['CLAUDE_PLUGIN_ROOT', 'OMC_PLUGIN_ROOT'])('%s: Installed is the loaded 5.8.0, the registry is named, Latest stays 5.9.0', (variable) => {
      const block = run({ entry: registered, root: (dir) => cache(dir, '5.9.0'), files: at('5.9.0'), variable });
      expect(Object.keys(block)).toEqual(['Plugin', 'Channel', 'Installed', 'Registry mismatch', 'Latest', 'Updater']);
      expect(block).toMatchObject({ Plugin: 'oh-my-claudecode@omc', Channel: 'marketplace omc', Installed: '5.8.0', Latest: '5.9.0 (marketplace clone)', Updater: UPDATER });
      expect(block['Registry mismatch']).toContain('records 5.9.0');
      expect(block['Registry mismatch']).toContain('holds 5.8.0');
      expect(block['Registry mismatch']).toContain('Updater line');
      // The installed version is older than the latest one: the outdated warning is not suppressed.
      expect(block.Installed).not.toBe(block.Latest.split(' ')[0]);
    });

    test('an entry with only an installPath whose directory is named 5.9.0 is judged by the manifest as well', () => {
      const block = run({ entry: (dir) => ({ installPath: cache(dir, '5.9.0') }), root: (dir) => cache(dir, '5.9.0'), files: at('5.9.0') });
      expect(block.Installed).toBe('5.8.0');
      expect(block['Registry mismatch']).toContain('records 5.9.0');
    });

    test('an entry that names the cache directory only by its version is matched to the root and judged by the manifest', () => {
      const block = run({ entry: () => ({ version: '5.9.0' }), root: (dir) => cache(dir, '5.9.0'), files: at('5.9.0') });
      expect(block.Installed).toBe('5.8.0');
      expect(block['Registry mismatch']).toContain('records 5.9.0');
    });

    test('plugin.json decides when package.json is missing', () => {
      const block = run({ entry: registered, root: (dir) => cache(dir, '5.9.0'), files: at('5.9.0', path.join('.claude-plugin', 'plugin.json')) });
      expect(block.Installed).toBe('5.8.0');
      expect(block['Registry mismatch']).toContain('records 5.9.0');
    });

    test('a newer manifest than the registry records is reported the same way', () => {
      const block = run({ entry: (dir) => ({ version: '5.7.0', installPath: cache(dir, '5.7.0') }), root: (dir) => cache(dir, '5.7.0'), files: (dir) => ({ [path.join(cache(dir, '5.7.0'), 'package.json')]: manifest('5.9.1') }) });
      expect(block.Installed).toBe('5.9.1');
      expect(block['Registry mismatch']).toContain('records 5.7.0');
    });

    test('only the entries that disagree are named, and the other scope is not', () => {
      const block = step1({
        plugins: (dir) => ({
          'oh-my-claudecode@omc': [
            { scope: 'project', version: '5.9.0', installPath: cache(dir, '5.9.0') },
            { scope: 'user', version: '5.8.0', installPath: cache(dir, '5.9.0') },
            { scope: 'local', version: '5.9.5', installPath: cache(dir, '5.9.5') },
          ],
        }),
        clone: { omc: '5.9.0' },
        env: (dir) => ({ CLAUDE_PLUGIN_ROOT: cache(dir, '5.9.0') }),
        setup: (dir) => write(path.join(cache(dir, '5.9.0'), 'package.json'), manifest('5.8.0')),
      });
      expect(block.Installed).toBe('5.8.0');
      expect(block['Registry mismatch']).toContain('records 5.9.0 for the install');
      expect(block['Registry mismatch']).not.toContain('5.9.5');
    });

    test('both plugin IDs of one install are judged: each block names the mismatch', () => {
      const blocks = step1Blocks({
        plugins: (dir) => ({
          'oh-my-claudecode@omc': [{ version: '5.9.0', installPath: cache(dir, '5.9.0') }],
          'oh-my-claudecode@oh-my-claudecode': [{ version: '5.9.0', installPath: cache(dir, '5.9.0') }],
        }),
        env: (dir) => ({ CLAUDE_PLUGIN_ROOT: cache(dir, '5.9.0') }),
        setup: (dir) => write(path.join(cache(dir, '5.9.0'), 'package.json'), manifest('5.8.0')),
      });
      expect(blocks.map((block) => [block.Plugin, block.Installed])).toEqual([['oh-my-claudecode@omc', '5.8.0'], ['oh-my-claudecode@oh-my-claudecode', '5.8.0']]);
      for (const block of blocks) expect(block['Registry mismatch']).toContain('records 5.9.0');
    });

    test('with entries for several scopes the root decides which one is judged', () => {
      const entries = (dir: string) => [
        { scope: 'user', version: '5.8.0', installPath: cache(dir, '5.8.0') },
        { scope: 'project', version: '5.9.0', installPath: cache(dir, '5.9.0') },
      ];
      const files = (dir: string) => ({ [path.join(cache(dir, '5.8.0'), 'package.json')]: manifest('5.8.0'), [path.join(cache(dir, '5.9.0'), 'package.json')]: manifest('5.8.0') });
      const judge = (v: string) =>
        step1({ plugins: (dir) => ({ 'oh-my-claudecode@omc': entries(dir) }), clone: { omc: '5.9.0' }, env: (dir) => ({ CLAUDE_PLUGIN_ROOT: cache(dir, v) }), setup: (dir) => { for (const [file, text] of Object.entries(files(dir))) write(file, text); } });
      // The root on the consistent 5.8.0 install: nothing to report, whatever the other scope records.
      const consistent = judge('5.8.0');
      expect(consistent.Installed).toBe('5.8.0');
      expect('Registry mismatch' in consistent).toBe(false);
      // The root on the partly updated one: the entry records 5.9.0, the code is 5.8.0.
      const partial = judge('5.9.0');
      expect(partial.Installed).toBe('5.8.0');
      expect(partial['Registry mismatch']).toContain('records 5.9.0');
    });
  });

  describe('a recorded version that the manifest confirms is printed as before', () => {
    test.each([
      ['the same version', '5.9.0', '5.9.0'],
      ['a recorded v prefix', 'v5.9.0', '5.9.0'],
      ['a prerelease on both', '5.9.0-beta.2', '5.9.0-beta.2'],
      // Build metadata does not make another version: the manifest's text is shown, and nothing is reported.
      ['build metadata only', '5.9.0+a', '5.9.0+b'],
      ['build metadata on one side', '5.9.0', '5.9.0+build.7'],
    ])('%s', (_name, recorded, held) => {
      const block = run({
        entry: (dir) => ({ version: recorded, installPath: cache(dir, '5.9.0') }),
        root: (dir) => cache(dir, '5.9.0'),
        files: (dir) => ({ [path.join(cache(dir, '5.9.0'), 'package.json')]: manifest(held) }),
      });
      expect(Object.keys(block)).toEqual(['Plugin', 'Channel', 'Installed', 'Latest', 'Updater']);
      expect(block.Installed).toBe(held);
    });
  });

  describe('a manifest that names no usable version leaves the answer to the registry, with one note', () => {
    test.each([
      ['metadata that cannot be parsed', '{ not json'],
      ['a manifest without a version', JSON.stringify({ name: 'oh-my-claudecode' })],
      ['a blank version', manifest('  ')],
      ['a version that is not a string', manifest(5)],
      ['a version outside the grammar', manifest('999x.0.0')],
    ])('%s', (_name, text) => {
      const block = run({ entry: registered, root: (dir) => cache(dir, '5.9.0'), files: (dir) => ({ [path.join(cache(dir, '5.9.0'), 'package.json')]: text }) });
      expect(Object.keys(block)).toEqual(['Plugin', 'Channel', 'Installed', 'Note', 'Latest', 'Updater']);
      expect(block.Installed).toBe('5.9.0');
      expect(block.Note).toContain('holds no usable version');
      expect('Registry mismatch' in block).toBe(false);
    });

    test('an unusable package.json does not hide the version of plugin.json', () => {
      const block = run({
        entry: registered,
        root: (dir) => cache(dir, '5.9.0'),
        files: (dir) => ({ [path.join(cache(dir, '5.9.0'), 'package.json')]: '{ not json', [path.join(cache(dir, '5.9.0'), '.claude-plugin', 'plugin.json')]: manifest('5.8.0') }),
      });
      expect(block.Installed).toBe('5.8.0');
      expect(block['Registry mismatch']).toContain('records 5.9.0');
    });

    test('a root with no manifest at all has nothing to compare: the registry answers and nothing is added', () => {
      const block = run({ entry: registered, root: (dir) => cache(dir, '5.9.0'), files: (dir) => ({ [path.join(cache(dir, '5.9.0'), 'README.md')]: 'no manifest' }) });
      expect(Object.keys(block)).toEqual(['Plugin', 'Channel', 'Installed', 'Latest', 'Updater']);
      expect(block.Installed).toBe('5.9.0');
    });
  });

  describe('only the root the session runs is judged', () => {
    test('a root that is no install of the registry leaves the registry as the answer, whatever another install holds', () => {
      const block = run({
        entry: registered,
        root: (dir) => path.join(dir, 'elsewhere'),
        files: (dir) => ({ [path.join(dir, 'elsewhere', 'package.json')]: manifest('1.0.0'), [path.join(cache(dir, '5.9.0'), 'package.json')]: manifest('5.8.0') }),
      });
      expect(Object.keys(block)).toEqual(['Plugin', 'Channel', 'Installed', 'Latest', 'Updater']);
      expect(block.Installed).toBe('5.9.0');
    });

    test('no root variable: the registry answers, nothing is read from the install', () => {
      const block = step1({
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [registered(dir)] }),
        clone: { omc: '5.9.0' },
        setup: (dir) => write(path.join(cache(dir, '5.9.0'), 'package.json'), manifest('5.8.0')),
      });
      expect(Object.keys(block)).toEqual(['Plugin', 'Channel', 'Installed', 'Latest', 'Updater']);
      expect(block.Installed).toBe('5.9.0');
    });

    test('a root deeper below the install, without a manifest of its own, leaves the registry as the answer', () => {
      const block = run({
        entry: registered,
        root: (dir) => path.join(cache(dir, '5.9.0'), 'nested'),
        files: (dir) => ({ [path.join(cache(dir, '5.9.0'), 'nested', 'README.md')]: 'nested', [path.join(cache(dir, '5.9.0'), 'package.json')]: manifest('5.8.0') }),
      });
      expect(Object.keys(block)).toEqual(['Plugin', 'Channel', 'Installed', 'Latest', 'Updater']);
      expect(block.Installed).toBe('5.9.0');
    });

    test('a root deeper below the install that has a manifest of its own is the code that runs, so its manifest decides', () => {
      const block = run({
        entry: registered,
        root: (dir) => path.join(cache(dir, '5.9.0'), 'nested'),
        files: (dir) => ({ [path.join(cache(dir, '5.9.0'), 'nested', 'package.json')]: manifest('5.8.0') }),
      });
      expect(block.Installed).toBe('5.8.0');
      expect(block['Registry mismatch']).toContain('records 5.9.0');
    });
  });

  // With no usable manifest the registry used to answer with the version of the entry, and the version its installPath names
  // was ignored: an entry that records 5.9.0 for a directory named 5.8.0 printed Installed 5.9.0 and Latest 5.9.0, with no
  // line about the mismatch. The version of an entry and the version its installPath names (the last component when it is a
  // version name, else the manifest under it) have to agree; where they do not and no manifest of the active root settles
  // it, neither is the code, so the installed version is unknown. The same rule serves every entry the session may run.
  describe('an entry whose version and installPath name different versions has no known installed version without a manifest', () => {
    const KEYS = ['Plugin', 'Channel', 'Installed', 'Registry mismatch', 'Latest', 'Updater'];
    const torn = (dir: string) => ({ version: '5.9.0', installPath: cache(dir, '5.8.0') });
    const readme = (dir: string) => ({ [path.join(cache(dir, '5.8.0'), 'README.md')]: 'no manifest' });

    test.each(['CLAUDE_PLUGIN_ROOT', 'OMC_PLUGIN_ROOT'])('%s: the example of the review, 5.9.0 recorded, the directory named 5.8.0, no manifest', (variable) => {
      const block = run({ entry: torn, root: (dir) => cache(dir, '5.8.0'), files: readme, variable });
      expect(Object.keys(block)).toEqual(KEYS);
      expect(block).toMatchObject({ Plugin: 'oh-my-claudecode@omc', Channel: 'marketplace omc', Installed: '(unknown)', Latest: '5.9.0 (marketplace clone)', Updater: UPDATER });
      expect(block['Registry mismatch']).toContain('names 5.8.0, 5.9.0 for one install');
      expect(block['Registry mismatch']).toContain('no manifest settles which is installed');
      expect(block['Registry mismatch']).toContain('Updater line');
    });

    test.each([
      ['metadata that cannot be parsed', '{ not json'],
      ['a manifest without a version', JSON.stringify({ name: 'oh-my-claudecode' })],
      ['a blank version', manifest('  ')],
      ['a version that is not a string', manifest(5)],
      ['a version outside the grammar', manifest('999x.0.0')],
    ])('a manifest of the active root that names no usable version settles nothing: %s', (_name, text) => {
      const block = run({ entry: torn, root: (dir) => cache(dir, '5.8.0'), files: (dir) => ({ [path.join(cache(dir, '5.8.0'), 'package.json')]: text }) });
      expect(Object.keys(block)).toEqual(KEYS);
      expect(block.Installed).toBe('(unknown)');
      expect('Note' in block).toBe(false);
    });

    // The cache directory a version names stands in for a missing installPath only: an entry that has an installPath says where
    // its install is, so a root on the directory its version would name is not that install (it is a checkout).
    test('OMC_PLUGIN_ROOT on the directory the version names, beside an installPath that names another version, is a checkout, not the registry install', () => {
      const block = run({ entry: torn, root: (dir) => cache(dir, '5.9.0'), files: (dir) => ({ [path.join(cache(dir, '5.9.0'), 'package.json')]: manifest('5.9.0'), [path.join(cache(dir, '5.8.0'), 'README.md')]: 'x' }), variable: 'OMC_PLUGIN_ROOT' });
      expect(block.Channel).toBe('plugin-dir');
      expect(block.Installed).toBe('5.9.0');
      expect(block.Updater).toMatch(/^none/);
    });

    test('CLAUDE_PLUGIN_ROOT on that directory matches no entry, so the contradiction of the entry stays visible instead of being settled by the root', () => {
      const block = run({ entry: torn, root: (dir) => cache(dir, '5.9.0'), files: (dir) => ({ [path.join(cache(dir, '5.9.0'), 'package.json')]: manifest('5.9.0'), [path.join(cache(dir, '5.8.0'), 'README.md')]: 'x' }) });
      expect(Object.keys(block)).toEqual(KEYS);
      expect(block.Installed).toBe('(unknown)');
      expect(block['Registry mismatch']).toContain('names 5.8.0, 5.9.0 for one install');
    });

    // A component that does not exist cannot be folded away by the ..: the file system answers ENOENT for <cache>/missing/../5.8.0, so
    // that spelling names nothing, and a root on the real 5.8.0 is not the install it records.
    test.skipIf(process.platform === 'win32')('an installPath with a missing component before .. names nothing, so the explicit root is a checkout', () => {
      const block = step1({
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ installPath: path.join(cache(dir, '5.9.0'), '..', 'missing') + path.sep + '..' + path.sep + '5.8.0' }] }),
        clone: { omc: '5.9.0' },
        cache: { omc: ['5.8.0', '5.9.0'] },
        env: (dir) => ({ OMC_PLUGIN_ROOT: cache(dir, '5.8.0') }),
      });
      expect(block.Channel).toBe('plugin-dir');
    });

    // A link loop on the way makes the path unresolvable: it names nothing, and its folded text must not equal a real directory.
    test.skipIf(process.platform === 'win32')('an installPath through a link loop before .. is not the explicit root: the answer is unknown, not the marketplace', () => {
      const block = step1({
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ installPath: path.join(cache(dir, '5.9.0'), '..', 'loop') + path.sep + '..' + path.sep + '5.8.0' }] }),
        clone: { omc: '5.9.0' },
        cache: { omc: ['5.8.0', '5.9.0'] },
        env: (dir) => ({ OMC_PLUGIN_ROOT: cache(dir, '5.8.0') }),
        setup: (dir) => symlinkSync('loop', path.join(path.dirname(cache(dir, '5.9.0')), 'loop')),
      });
      expect(block.Channel).toMatch(/^unknown/);
    });

    test('with no root variable the entry contradicts itself all the same, in either direction', () => {
      for (const [version, leaf] of [['5.9.0', '5.8.0'], ['5.8.0', '5.9.0']]) {
        const block = step1({ plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ version, installPath: cache(dir, leaf) }] }), clone: { omc: '5.9.0' }, setup: (dir) => write(path.join(cache(dir, leaf), 'README.md'), 'x') });
        expect({ version, leaf, keys: Object.keys(block), installed: block.Installed }).toEqual({ version, leaf, keys: KEYS, installed: '(unknown)' });
        expect(block['Registry mismatch']).toContain('names 5.8.0, 5.9.0 for one install');
      }
    });

    test('an installPath that names no version but holds a manifest of another one is the same contradiction', () => {
      const block = step1({
        plugins: (dir) => ({ 'oh-my-claudecode@omc': [{ version: '5.9.0', installPath: path.join(dir, 'custom') }] }),
        clone: { omc: '5.9.0' },
        setup: (dir) => write(path.join(dir, 'custom', 'package.json'), manifest('5.8.0')),
      });
      expect({ keys: Object.keys(block), installed: block.Installed }).toEqual({ keys: KEYS, installed: '(unknown)' });
    });

    test('a usable manifest of the active root settles it: Installed is its version, the registry is named, nothing is unknown', () => {
      const block = run({ entry: torn, root: (dir) => cache(dir, '5.8.0'), files: (dir) => ({ [path.join(cache(dir, '5.8.0'), 'package.json')]: manifest('5.8.0') }) });
      expect(Object.keys(block)).toEqual(KEYS);
      expect(block.Installed).toBe('5.8.0');
      expect(block['Registry mismatch']).toContain('records 5.9.0');
      expect(block['Registry mismatch']).toContain('holds 5.8.0');
    });

    test('the entry of another scope that contradicts itself makes an unknown answer only where it is among the entries judged', () => {
      const entries = (dir: string) => ({ 'oh-my-claudecode@omc': [{ version: '5.8.0', installPath: cache(dir, '5.8.0') }, { version: '5.9.0', installPath: cache(dir, '5.7.0') }] });
      const files = (dir: string) => ({ [path.join(cache(dir, '5.8.0'), 'README.md')]: 'x', [path.join(cache(dir, '5.7.0'), 'README.md')]: 'x' });
      const none = step1({ plugins: entries, clone: { omc: '5.9.0' }, setup: (dir) => Object.entries(files(dir)).forEach(([file, text]) => write(file, text)) });
      expect({ keys: Object.keys(none), installed: none.Installed }).toEqual({ keys: KEYS, installed: '(unknown)' });
      expect(none['Registry mismatch']).toContain('names 5.7.0, 5.9.0 for one install');
      const active = step1({ plugins: entries, clone: { omc: '5.9.0' }, env: (dir) => ({ CLAUDE_PLUGIN_ROOT: cache(dir, '5.8.0') }), setup: (dir) => Object.entries(files(dir)).forEach(([file, text]) => write(file, text)) });
      expect({ keys: Object.keys(active), installed: active.Installed }).toEqual({ keys: ['Plugin', 'Channel', 'Installed', 'Latest', 'Updater'], installed: '5.8.0' });
    });

    test('an entry whose two versions agree is printed as before: the same text, a leading v, build metadata only', () => {
      for (const [recorded, leaf, installed] of [['5.9.0', '5.9.0', '5.9.0'], ['v5.9.0', '5.9.0', '5.9.0'], ['5.9.0+a', '5.9.0', '5.9.0+a']]) {
        const block = run({ entry: (dir) => ({ version: recorded, installPath: cache(dir, leaf) }), root: (dir) => cache(dir, leaf), files: (dir) => ({ [path.join(cache(dir, leaf), 'README.md')]: 'x' }) });
        expect({ recorded, leaf, keys: Object.keys(block), installed: block.Installed }).toEqual({ recorded, leaf, keys: ['Plugin', 'Channel', 'Installed', 'Latest', 'Updater'], installed });
      }
    });
  });
});
