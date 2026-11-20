import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandWith, proseOf, scriptOf, sharedSections } from './helpers/omc-doctor-cache-fixture.js';
import { versionCommand } from './helpers/omc-doctor-step1.js';

// The `npm latest:` line is only for the npm channel. It is a command of its own (Step 1 never consults npm): `npm view`
// gets a time limit, and the answer has to be a semantic version of the grammar the commands share, so an error, a
// timeout or junk on stdout is `npm latest: (unavailable)` and never a bare string a model could take for a version.
const npmCommand = commandWith("'npm latest: '") ?? '';
const posix = process.platform !== 'win32';

// Runs the command with a fake `npm` first on PATH. `preload` is a script run before the command (--require).
const run = (npm: string | null, preload?: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-npm-'));
  try {
    if (npm !== null) {
      writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\n${npm}\n`);
      chmodSync(path.join(dir, 'npm'), 0o755);
    }
    const args = ['-e', scriptOf(npmCommand)];
    if (preload) {
      writeFileSync(path.join(dir, 'preload.cjs'), preload);
      args.unshift('--require', path.join(dir, 'preload.cjs'));
    }
    // PATH holds the fake npm first (a missing npm: an empty directory only); node runs by its absolute path.
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: npm === null ? dir : dir + path.delimiter + '/usr/bin' + path.delimiter + '/bin' } });
    return { error: result.error, status: result.status, stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('omc-doctor npm latest command', { timeout: 120_000 }, () => {
  test('it is one command of Step 1, carries the shared version grammar, and replaces the bare shell line', () => {
    expect(npmCommand).not.toBe('');
    expect(sharedSections(npmCommand).get('version grammar')).toBe(sharedSections(versionCommand ?? '').get('version grammar'));
    expect(proseOf()).not.toMatch(/^latest=\$\(npm view/m);
    expect(proseOf()).toContain('npm latest: for a Channel: npm install only');
    // Both outcomes are labelled by the command itself.
    expect(scriptOf(npmCommand)).toContain("'npm latest: ' + (latest || '(unavailable)')");
  });

  test('npm view has a time limit of 20 seconds and a kill that cannot be ignored', () => {
    expect(scriptOf(npmCommand)).toContain("timeout: 20000, killSignal: 'SIGKILL'");
    expect(scriptOf(npmCommand)).toContain("'view', 'oh-my-claude-sisyphus', 'version'");
  });

  test.skipIf(!posix)('a semantic version is printed bare, with the leading v dropped', () => {
    expect(run('echo 5.9.1')).toEqual({ error: undefined, status: 0, stdout: 'npm latest: 5.9.1\n' });
    expect(run('echo v5.9.1').stdout).toBe('npm latest: 5.9.1\n');
    expect(run('echo 5.9.1-beta.2').stdout).toBe('npm latest: 5.9.1-beta.2\n');
  });

  test.skipIf(!posix)('anything that is not a semantic version is (unavailable), on a successful or a failed npm', () => {
    for (const npm of ['echo junk-not-semver', 'echo 5.9', 'echo 01.2.3', 'echo "5.9.1 extra"', 'echo 5.9.1; echo 5.9.2', 'echo "<html>"', 'exit 0', 'exit 1', 'echo 5.9.1; exit 3']) {
      expect({ npm, ...run(npm) }).toEqual({ npm, error: undefined, status: 0, stdout: 'npm latest: (unavailable)\n' });
    }
  });

  test.skipIf(!posix)('a missing npm is (unavailable)', () => {
    expect(run(null)).toEqual({ error: undefined, status: 0, stdout: 'npm latest: (unavailable)\n' });
  });

  // The preload cuts the limit to 1.5 seconds so the case does not wait 20: it shows that the limit is passed to the child
  // process and that a hanging npm is killed and reported, with the exit code of the command still 0.
  test.skipIf(!posix)('a hanging npm is killed at the limit and reported as (unavailable)', () => {
    const preload = "const cp = require('child_process'); const spawnSync = cp.spawnSync; cp.spawnSync = (command, args, options) => spawnSync(command, args, { ...options, timeout: 1500 });\n";
    const started = Date.now();
    const result = run('exec sleep 30', preload);
    expect(result).toEqual({ error: undefined, status: 0, stdout: 'npm latest: (unavailable)\n' });
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
