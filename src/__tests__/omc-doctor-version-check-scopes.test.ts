import { describe, test, expect } from 'vitest';
import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { step1 } from './helpers/omc-doctor-step1.js';

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
      const mixed = (dir: string) => ({ 'oh-my-claudecode@omc': [{ version: '5.8.0' }, { version: '5.9.0', installPath: base(dir, '5.9.0') }] });
      // An entry with only a version names the cache directory of that version, so the root on that directory is its entry.
      expect(noNewest((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.8.0') }), mixed)).toBe('5.8.0');
      expect(noNewest((dir) => ({ CLAUDE_PLUGIN_ROOT: base(dir, '5.7.0') }), mixed)).toBe('5.9.0');
    });
  });
});
