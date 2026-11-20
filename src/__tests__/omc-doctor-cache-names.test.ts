import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backupDir, commandWith, commands, digitVersions, makeCache, movedAside, PLUGIN_ID, runCommand, sharedSections, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';
import { step1, versionCommand } from './helpers/omc-doctor-step1.js';
import { compareVersions } from '../utils/semver-compare.js';

// A directory of the plugin cache is a version only when its name is a semantic version of the grammar the registry
// versions already obey (an optional v is no part of a directory name). A name that is none, such as `1e3` or `4.15.7L`
// (a digit first, junk after), is no version: the order ignores it (the runtime reads such a name as 0 or below), Step 6
// does not count it, and the cache commands neither list nor move it. Before, such a name ranked above every real version.
const step4 = commandWith('Latest cached plugin version') ?? '';
const step6 = commandWith("' version(s):'") ?? '';
const NOT_VERSIONS = ['1e3', '4.15.7L', '999x.0.0', '1.2', '1.2.3.4', '01.2.3', 'v5.7.0', '5.9.0 ', '5.9.0.bak', '5.9.0.omc-stale-4242'];

describe('omc-doctor: a cache directory that is no semantic version takes no part', { timeout: 120_000 }, () => {
  test('the version-name test is the grammar plus the relink exclusion, the same text in every command', () => {
    for (const command of [versionCommand ?? '', step4, step6, ...commands]) {
      const grammar = sharedSections(command).get('version grammar') ?? '';
      expect(grammar).toContain('const isVersionDir = (name) => semver(name) == name && !/[.]omc-stale-[0-9]+(?![^])/.test(name);');
    }
  });

  test('Step 1 on the npm channel: the highest real version is Installed, whatever the junk names are', () => {
    for (const [junk, real] of [['1e3', '5.9.0'], ['4.15.7L', '4.15.8'], ['999x.0.0', '5.8.0'], ['v6.0.0', '5.8.0'], ['6.0', '5.8.0']] as const) {
      for (const names of [[junk, real], [real, junk]]) {
        expect({ names, installed: step1({ cache: { omc: names } }).Installed }).toEqual({ names, installed: real });
      }
    }
    expect(step1({ cache: { omc: ['1e3', '4.15.7L'] } })).toEqual({ Channel: 'npm', Installed: '(none)', Updater: 'omc update' });
  });

  test('Step 1 for a registry entry that names only an installPath: the marketplace cache is read the same way', () => {
    const entry = { plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: '/nowhere/else' }] }, clone: { omc: '5.9.0' } };
    expect(step1({ ...entry, cache: { omc: ['1e3', '5.7.0'] } }).Installed).toBe('5.7.0');
    expect(step1({ ...entry, cache: { omc: ['1e3', '4.15.7L'] } }).Installed).toBe('(none)');
  });

  test.skipIf(process.platform === 'win32')('Step 4 names the highest real version, and Step 6 counts only real versions', () => {
    for (const junk of NOT_VERSIONS) {
      const { dir } = makeCache(['5.8.0', '5.9.0']);
      try {
        mkdirSync(path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', junk), { recursive: true });
        writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- OMC:VERSION:5.9.0 -->\n');
        const four = spawnSync('/bin/bash', ['-c', step4], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir, OMC_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' } });
        expect({ junk, line: four.stdout.split('\n').find((l) => l.startsWith('Latest cached plugin version:')) }).toEqual({ junk, line: 'Latest cached plugin version: 5.9.0' });
        expect(four.stdout).toContain('VERSION MATCH');
        const six = runCommand(step6, dir, { timeout: 20_000 });
        expect({ junk, out: six.stdout.trim().replace(/: (.*)$/, (_m, list: string) => ': ' + list.split(', ').sort().join(', ')) }).toEqual({ junk, out: '2 version(s): 5.8.0, 5.9.0' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('both cache commands leave such a directory where it is, and neither list nor count it', () => {
    for (const command of commands) {
      for (const junk of ['1e3', '4.15.7L', 'v5.7.0', '5.9.0.bak']) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.1', '5.9.0', junk]);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
          const result = runCommand(command, dir, { timeout: 20_000 });
          expect({ junk, status: result.status, versions: digitVersions(cache).split(',').filter((n) => n !== junk).join(','), moved: movedAside(dir) }).toEqual({ junk, status: 0, versions: '5.8.1', moved: 2 });
          expect({ junk, stays: existsSync(path.join(cache, junk)) }).toEqual({ junk, stays: true });
          expect(result.stdout).toContain('Moved 2 unprotected version(s)');
          expect(result.stdout).not.toContain(junk);
          expect(readdirSync(backupDir(dir)).some((name) => name.startsWith(junk))).toBe(false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  // The order of the names that are versions is the runtime order (compareVersions in src/utils/semver-compare.ts):
  // the skill carries its own copy of the comparator, so the two are run side by side on a grid.
  test('the order of real versions is the order of the runtime comparator', () => {
    const comparator = new Function(`${sharedSections(versionCommand ?? '').get('version grammar')}\n${sharedSections(versionCommand ?? '').get('version order')}\nreturn compareVersions;`)() as (a: string, b: string) => number;
    const names = ['0.0.1', '1.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0+build', '1.2.3', '1.10.0', '2.0.0', '5.9.0', '5.9.0-beta.2', '5.9.10', '5.10.0', '10.0.0', '1.0.0-0', '1.0.0-1', '1.0.0-a-b'];
    for (const a of names) {
      for (const b of names) {
        if (a === b) continue;
        const runtime = Math.sign(compareVersions(a, b));
        const skill = Math.sign(comparator(a, b));
        // Equal precedence in the runtime (build metadata only) is told apart by text in the skill: only the sign of a real order must agree.
        if (runtime !== 0) expect({ a, b, skill }).toEqual({ a, b, skill: runtime });
      }
    }
  });
});
