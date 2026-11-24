import { describe, test, expect } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ageVersions, CLAUDE_MD_VERSION, commands, digitVersions, makeCache, movedAside, PLUGIN_ID, runBlock, runCommand, scriptSection, scriptText, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1 } from './helpers/omc-doctor-step1.js';

// The runtime reads a version with an optional leading `v` as the same version (`parseSemver` in scripts/session-start.mjs,
// `parseVersion` in src/utils/semver-compare.ts), shows the bare form, and names the cache directory by the bare version.
// The script drops the `v` in one place (`dropV`, in the version grammar section) wherever it compares, validates or
// names a version.
describe('omc-doctor: a leading v is ignored wherever a version is compared or named', { timeout: 120_000 }, () => {
  const cacheOf = (dir: string, version: string) => path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', version);
  const two = (first: string, second: string, extra: (dir: string) => Record<string, unknown> = () => ({})) => (dir: string) => ({
    'oh-my-claudecode@omc': [{ scope: 'project', version: first, ...extra(dir) }, { scope: 'user', version: second }],
  });

  describe('Step 1', () => {
    test('with v5.8.0 and 5.9.0 in different scopes and no active root, the higher version is Installed in either order of the entries', () => {
      for (const [first, second] of [['v5.8.0', '5.9.0'], ['5.9.0', 'v5.8.0'], ['5.8.0', 'v5.9.0'], ['v5.9.0', '5.8.0']]) {
        const out = step1({ plugins: two(first, second), cache: { omc: ['5.8.0', '5.9.0'] }, clone: { omc: '5.9.0' } });
        expect({ first, second, installed: out.Installed, latest: out.Latest }).toEqual({ first, second, installed: '5.9.0', latest: '5.9.0 (marketplace clone)' });
      }
    });

    test('the prefix does not change the order of numbers or of a prerelease, and the same version with and without it is one version', () => {
      const installed = (...versions: string[]) => step1({ plugins: { 'oh-my-claudecode@omc': versions.map((version) => ({ version })) } }).Installed;
      expect(installed('v5.10.0', '5.9.0')).toBe('5.10.0');
      expect(installed('5.9.0', 'v5.10.0')).toBe('5.10.0');
      expect(installed('v5.9.0-beta.2', '5.9.0-beta.10')).toBe('5.9.0-beta.10');
      expect(installed('v5.9.0-beta', '5.9.0')).toBe('5.9.0');
      expect(installed('v5.9.0', '5.9.0')).toBe('5.9.0');
      expect(installed('5.9.0', 'v5.9.0')).toBe('5.9.0');
    });

    test('a version recorded with v names the cache directory of the bare version, so the root on that directory is its entry', () => {
      for (const order of [['v5.8.0', '5.9.0'], ['5.9.0', 'v5.8.0']]) {
        const out = step1({ plugins: two(order[0], order[1]), cache: { omc: ['5.8.0', '5.9.0'] }, clone: { omc: '5.9.0' }, env: (dir) => ({ CLAUDE_PLUGIN_ROOT: cacheOf(dir, '5.8.0') }) });
        expect({ order, installed: out.Installed, channel: out.Channel }).toEqual({ order, installed: '5.8.0', channel: 'marketplace omc' });
      }
      // An explicit root on that very directory is the registry's own install, not a checkout.
      const own = step1({ plugins: { 'oh-my-claudecode@omc': [{ version: 'v5.8.0' }] }, cache: { omc: ['5.8.0'] }, env: (dir) => ({ OMC_PLUGIN_ROOT: cacheOf(dir, '5.8.0') }) });
      expect(own).toMatchObject({ Channel: 'marketplace omc', Installed: '5.8.0' });
    });

    test('a cache directory is a version directory only when its name starts with a digit, as in the runtime', () => {
      expect(step1({ cache: { omc: ['v5.9.0', '5.7.0'] } })).toMatchObject({ Channel: 'npm', Installed: '5.7.0' });
    });

    test('the version of a checkout is shown without the prefix', () => {
      const out = step1({
        env: (dir) => {
          mkdirSync(path.join(dir, 'checkout'), { recursive: true });
          writeFileSync(path.join(dir, 'checkout', 'package.json'), JSON.stringify({ version: 'v5.9.0' }));
          return { OMC_PLUGIN_ROOT: path.join(dir, 'checkout') };
        },
      });
      expect(out).toMatchObject({ Channel: 'plugin-dir', Installed: '5.9.0' });
    });
  });

  describe('Step 4 compares the CLAUDE.md marker with the cached version without the prefix', () => {
    // Step 4 is a shell block of the skill (the locator line and the call), so it runs through bash.
    const verdict = (marker: string) => {
      const { dir } = makeCache(['5.9.0']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '0.0.1' }] }); // a supported ID, so the session root is no plugin-dir checkout
        writeFileSync(path.join(dir, 'CLAUDE.md'), `<!-- OMC:VERSION:${marker} -->\n`);
        const run = runBlock(CLAUDE_MD_VERSION, dir, { timeout: 20_000 });
        expect(run.error).toBeUndefined();
        return run.stdout.trim().split('\n').slice(-1)[0];
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    // The runtime reads a marker only when a digit follows the colon (extractOmcVersion in scripts/session-start.mjs) and reports
    // instruction drift for any other, so a marker written with a v is drift here too; the prefix is dropped only from versions
    // that are compared (the cache side).
    test.skipIf(process.platform === 'win32')('a marker with a v is drift as at runtime, 5.9.0 is aligned, another version is drift', () => {
      expect(verdict('v5.9.0')).toBe('VERSION DRIFT: CLAUDE.md and plugin versions differ');
      expect(verdict('5.9.0')).toBe('VERSION MATCH: CLAUDE and plugin cache are aligned');
      expect(verdict('v5.8.0')).toBe('VERSION DRIFT: CLAUDE.md and plugin versions differ');
    });
  });

  describe('the cache commands', () => {
    test('a pin recorded as v5.8.0 protects the directory 5.8.0 in both commands', () => {
      for (const command of commands) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.0', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: 'v5.8.0' }] });
          const result = runCommand(command, dir, { timeout: 20_000 });
          expect(result.status).toBe(0);
          expect({ left: digitVersions(cache), moved: movedAside(dir) }).toEqual({ left: '5.8.0', moved: 2 });
          expect(result.stdout).toMatch(/Kept protected cache versions.*5\.8\.0/);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test('a directory named with the prefix is no version directory and is never moved', () => {
      for (const command of commands) {
        const { dir, cache } = makeCache(['5.8.0', '5.9.0']);
        try {
          mkdirSync(path.join(cache, 'v5.7.0'));
          // Dated an hour back: a fresh directory is left alone whatever its name says, so only an old one proves the name.
          ageVersions(cache);
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] });
          const result = runCommand(command, dir, { timeout: 20_000 });
          expect(result.status).toBe(0);
          expect({ left: digitVersions(cache), moved: movedAside(dir) }).toEqual({ left: '5.9.0', moved: 1 });
          expect(existsSync(path.join(cache, 'v5.7.0'))).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  });

  describe('the script holds one definition of the prefix and of the comparison', () => {
    const grammar = scriptSection('version grammar');

    test('the prefix is dropped by one function, which Step 1, Step 4 and both cache commands use', () => {
      expect(grammar).toContain("const dropV = (text) => text.replace(/^v(?=[0-9])/, '');");
      expect(scriptText.split('const dropV = ')).toHaveLength(2);
      // Step 4 compares the marker and the cached version without the prefix; the registry commands drop it from a pin.
      expect(scriptSection('Step 4')).toContain('dropV(claudeVersion) === dropV(pluginVersion)');
      expect(scriptSection('protection')).toContain('dropV(version)');
    });

    test('Step 4 orders versions with the comparator of Step 1', () => {
      expect(scriptSection('version order')).toContain('dropV(name)');
      expect(scriptText.split('const compareVersions = ')).toHaveLength(2);
      expect(scriptSection('Step 4')).toContain('.sort(compareVersions)');
      expect(scriptSection('Step 1: helpers')).toContain('.sort(compareVersions)');
    });

    test('the version of a marketplace clone is read with the same function', () => {
      expect(scriptSection('Step 1: the install channel')).toContain('semver(found.version)');
      expect(grammar).toContain('return grammar.test(trimmed) ? dropV(trimmed) : \'\';');
    });
  });
});
