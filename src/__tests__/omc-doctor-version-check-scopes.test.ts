import { describe, test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
