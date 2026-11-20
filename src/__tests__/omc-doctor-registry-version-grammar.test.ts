import { describe, test, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { codeOf, commands, digitVersions, makeCache, movedAside, PLUGIN_ID, runCommand, scriptSection, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1 } from './helpers/omc-doctor-step1.js';

// A `version` that a registry entry of OMC claims, and the version read from the `package.json` or `plugin.json` an entry
// points to, is a semantic version in the grammar of the runtime's `parseSemver` (the `sv` of Step 1, with the optional
// leading `v`) before it is ordered: the order ranks a core that is not numeric above numeric ones, so `999x.0.0` beside
// `5.9.0` printed `Installed: 999x.0.0` and a diagnosis that nothing is outdated. An entry with such a version is a damaged
// registry like any other damaged entry: Step 1 says `Channel: unknown` and names no updater, and the cache commands move
// nothing. A cache directory name claims nothing and is not checked this way (the runtime lists any name that starts with a
// digit); the version of an entry under another plugin's key is not an OMC version and stays a non-blank string.
describe('omc-doctor: the version fields of the registry entries of OMC are validated before they are ordered', { timeout: 120_000 }, () => {
  const bad = ['999x.0.0', '1.2', '1.2.3.4', '01.2.3', '1.2.3-', 'vv1.2.3', 'v', '5.9.0 x', ' 999x.0.0 '];
  // Not a string, blank after trimming, or null (a missing field): damaged under the earlier rule already.
  const malformed = [5, '   ', '', null, ['5.9.0'], { v: '5.9.0' }, true];

  describe('one definition', () => {
    // The commands share the one script, so there is one grammar: the registry entries, the version order and the cache
    // listings of Step 1 and of both cache commands go through the same `semver` function.
    test('the grammar is one text in the script, and the entry check, the order and the cache listing use it', () => {
      expect(commands).toHaveLength(2);
      expect(codeOf().split('const grammar = ')).toHaveLength(2);
      expect(scriptSection('version grammar')).toContain('const grammar = ');
      expect(scriptSection('version grammar')).toContain('const isVersionDir = (name) => semver(name) == name');
      // The entry checks of Step 1 and of the cache commands, and the cache listings of every command.
      for (const section of ['Step 1: helpers', 'repair registry']) expect({ section, uses: scriptSection(section).includes('semver(') }).toEqual({ section, uses: true });
      expect(codeOf().split('.filter(isVersionDir)').length - 1).toBe(3);
    });
  });

  describe('Step 1', () => {
    const valid = { scope: 'user', version: '5.9.0' };
    const registryWith = (version: unknown, order: 'first' | 'last') => ({
      'oh-my-claudecode@omc': order === 'first' ? [{ scope: 'project', version }, valid] : [valid, { scope: 'project', version }],
    });
    const lines = (out: Record<string, string>) => Object.keys(out).sort().join(',');

    test('a version that is not a semantic version beside 5.9.0, in either order, makes the channel unknown with no updater and no version', () => {
      for (const version of bad) {
        for (const order of ['first', 'last'] as const) {
          const out = step1({ plugins: registryWith(version, order), cache: { omc: ['5.9.0'] }, clone: { omc: '5.9.0' } });
          expect({ version, order, keys: lines(out), channel: out.Channel.startsWith('unknown') }).toEqual({ version, order, keys: 'Channel', channel: true });
        }
      }
    });

    test('with a root on the pinned version (a locator or an explicit root inside the cache) the registry is still damaged, so the channel is unknown', () => {
      // An existing OMC_PLUGIN_ROOT outside the cache is an explicit checkout whatever the registry holds (not this rule); a root on the
      // cache directory of the entry cannot be told from the registry's own install once the registry is damaged.
      for (const variable of ['OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
        for (const order of ['first', 'last'] as const) {
          const out = step1({
            plugins: registryWith('999x.0.0', order),
            cache: { omc: ['5.9.0'] },
            clone: { omc: '5.9.0' },
            env: (dir) => ({ [variable]: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '5.9.0') }),
          });
          expect({ variable, order, keys: lines(out) }).toEqual({ variable, order, keys: 'Channel' });
          expect(out.Channel).toMatch(/^unknown/);
        }
      }
    });

    test('a value that is not a string or is blank is damaged as before, and the grammar adds no other case', () => {
      for (const version of malformed) {
        const out = step1({ plugins: registryWith(version, 'last'), cache: { omc: ['5.9.0'] }, clone: { omc: '5.9.0' } });
        expect({ version, channel: out.Channel.startsWith('unknown') }).toEqual({ version, channel: true });
      }
    });

    test('valid forms are still read: the leading v, surrounding blanks, prerelease and build metadata', () => {
      for (const version of ['v5.9.0', ' 5.9.0 ', '5.9.0-beta.1', '5.9.0+build.7', '5.9.0-rc.1+build.7']) {
        const out = step1({ plugins: { 'oh-my-claudecode@omc': [{ version }] }, clone: { omc: '5.9.0' } });
        expect({ version, channel: out.Channel }).toEqual({ version, channel: 'marketplace omc' });
      }
    });

    test('an entry with only an installPath stays valid, and its version comes from the directory name or its package.json when that is a version', () => {
      const entry = (dir: string, leaf: string) => ({ 'oh-my-claudecode@omc': [{ installPath: path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', leaf) }] });
      const withMeta = (leaf: string, version?: unknown) => (dir: string) => {
        const root = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', leaf);
        mkdirSync(root, { recursive: true });
        if (version !== undefined) writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
      };
      const out = (leaf: string, version?: unknown) => step1({ plugins: (dir) => entry(dir, leaf), clone: { omc: '5.9.0' }, setup: withMeta(leaf, version) });
      expect(out('5.9.0')).toMatchObject({ Channel: 'marketplace omc', Installed: '5.9.0' });
      // A name that is not a version names none: the package.json is read instead.
      expect(out('999x.0.0', '5.9.0')).toMatchObject({ Channel: 'marketplace omc', Installed: '5.9.0' });
      expect(out('current', '5.9.0')).toMatchObject({ Channel: 'marketplace omc', Installed: '5.9.0' });
      // Present but not a version: damaged, like the same text in the registry.
      for (const version of ['999x.0.0', '1.2', '1.2.3.4']) {
        expect(out('current', version)).toEqual({ Channel: expect.stringMatching(/^unknown/) });
      }
      // No metadata at all names no version and is not damaged.
      expect(out('current').Channel).toBe('marketplace omc');
    });

    test('the version of a checkout is shown only when it is a semantic version', () => {
      const checkout = (version: unknown) => step1({
        env: (dir) => {
          mkdirSync(path.join(dir, 'checkout'), { recursive: true });
          writeFileSync(path.join(dir, 'checkout', 'package.json'), JSON.stringify({ version }));
          return { OMC_PLUGIN_ROOT: path.join(dir, 'checkout') };
        },
      });
      expect(checkout('5.9.0')).toMatchObject({ Channel: 'plugin-dir', Installed: '5.9.0' });
      expect(checkout('v5.9.0')).toMatchObject({ Channel: 'plugin-dir', Installed: '5.9.0' });
      for (const version of ['999x.0.0', '1.2', '1.2.3.4', '5']) expect(checkout(version)).toMatchObject({ Channel: 'plugin-dir', Installed: '(none)' });
    });

    test('the version of an entry under another plugin key is not an OMC version: any non-blank string leaves Step 1 as it was', () => {
      for (const version of ['abc1234', 'unknown', '1.2', '999x.0.0']) {
        const out = step1({
          plugins: { 'oh-my-claudecode@omc': [{ version: '5.9.0' }], 'other@market': [{ version, installPath: '/elsewhere' }] },
          clone: { omc: '5.9.0' },
        });
        expect({ version, channel: out.Channel, installed: out.Installed }).toEqual({ version, channel: 'marketplace omc', installed: '5.9.0' });
        // The same entry with no entry of OMC beside it: the registry names no OMC install, so the cache decides.
        const alone = step1({ plugins: { 'other@market': [{ version, installPath: '/elsewhere' }] }, cache: { omc: ['5.7.0'] } });
        expect({ version, channel: alone.Channel, installed: alone.Installed }).toEqual({ version, channel: 'npm', installed: '5.7.0' });
      }
    });

    test('a cache directory name that is no semantic version takes no part: the real version beside it is Installed', () => {
      expect(step1({ cache: { omc: ['5.9', '5.7.0'] } })).toMatchObject({ Channel: 'npm', Installed: '5.7.0' });
    });
  });

  describe('the cache commands', () => {
    // status: 1 for a registry the command refuses to read, 0 otherwise.
    const snapshot = (versions: string[], plugins: Record<string, unknown>, command: string, status = 0) => {
      const { dir, cache } = makeCache(versions);
      try {
        writeRegistry(dir, plugins);
        const result = runCommand(command, dir, { timeout: 60_000 });
        expect(result.status).toBe(status);
        return { stdout: result.stdout, left: digitVersions(cache), moved: movedAside(dir) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    test('a version that is not a semantic version beside 5.9.0, in either order, moves nothing', () => {
      for (const command of commands) {
        for (const version of bad) {
          for (const entries of [[{ scope: 'project', version }, { scope: 'user', version: '5.9.0' }], [{ scope: 'user', version: '5.9.0' }, { scope: 'project', version }]]) {
            const out = snapshot(['5.7.0', '5.8.0', '5.9.0'], { [PLUGIN_ID]: entries }, command, 1);
            expect({ version, left: out.left, moved: out.moved }).toEqual({ version, left: '5.7.0,5.8.0,5.9.0', moved: 0 });
            expect(out.stdout).toMatch(/Nothing moved: installed_plugins\.json/);
          }
        }
      }
    });

    test('a value that is not a string or is blank moves nothing, as before', () => {
      for (const command of commands) {
        for (const version of malformed) {
          const out = snapshot(['5.8.0', '5.9.0'], { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }, { scope: 'project', version }] }, command, 1);
          expect({ version, left: out.left, moved: out.moved }).toEqual({ version, left: '5.8.0,5.9.0', moved: 0 });
        }
      }
    });

    test('valid forms still pin, an entry with only an installPath is still valid, and a free version still moves', () => {
      for (const command of commands) {
        for (const version of ['v5.9.0', ' 5.9.0 ', '5.9.0']) {
          const out = snapshot(['5.8.0', '5.9.0'], { [PLUGIN_ID]: [{ scope: 'user', version }] }, command);
          expect({ version, left: out.left, moved: out.moved }).toEqual({ version, left: '5.9.0', moved: 1 });
        }
        const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', installPath: path.join(cache, '5.9.0') }] });
          expect(runCommand(command, dir, { timeout: 60_000 }).status).toBe(0);
          expect({ left: digitVersions(cache), moved: movedAside(dir) }).toEqual({ left: '5.9.0', moved: 1 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test('the version of an entry under another plugin key is not checked against the grammar: it does not stop the cleanup', () => {
      for (const command of commands) {
        for (const version of ['abc1234', 'unknown', '1.2']) {
          const out = snapshot(['5.8.0', '5.9.0'], { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }], 'other@market': [{ version, installPath: '/elsewhere' }] }, command);
          expect({ version, left: out.left, moved: out.moved }).toEqual({ version, left: '5.9.0', moved: 1 });
        }
      }
    });
  });
});
