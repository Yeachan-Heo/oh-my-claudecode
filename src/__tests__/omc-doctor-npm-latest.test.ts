import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NPM_LATEST, SCRIPT, scriptSection, skillAndGuide, skillText } from './helpers/omc-doctor-cache-fixture.js';

// The `npm latest:` line is only for the npm channel. It is a command of its own (Step 1 never consults npm): `npm view`
// gets a time limit, and the answer has to be a semantic version of the grammar the script defines once, so an error, a
// timeout or junk on stdout is `npm latest: (unavailable)` and never a bare string a model could take for a version.
const npmFunction = scriptSection('Step 1: npm latest');
const posix = process.platform !== 'win32';

// Runs the command with a fake `npm` first on PATH. `preload` is a script run before the command (--require).
const run = (npm: string | null, preload?: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-npm-'));
  try {
    if (npm !== null) {
      writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\n${npm}\n`);
      chmodSync(path.join(dir, 'npm'), 0o755);
    }
    const args = [SCRIPT, NPM_LATEST];
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
  test('it is one command of Step 1, answers with the version grammar of the script, and replaces the bare shell line', () => {
    expect(npmFunction).toContain('const latest = run.status === 0 ? semver(run.stdout) : \'\';');
    expect(skillAndGuide).not.toMatch(/^latest=\$\(npm view/m);
    expect(skillText).toContain('npm latest: for a Channel: npm install only');
    expect(skillText).toContain('node "$S" npm-latest');
    // Both outcomes are labelled by the command itself.
    expect(npmFunction).toContain("'npm latest: ' + (latest || '(unavailable)')");
  });

  test('npm view has a time limit of 20 seconds and a kill that cannot be ignored', () => {
    expect(npmFunction).toContain("timeout: 20000, killSignal: 'SIGKILL'");
    expect(npmFunction).toContain("'view', 'oh-my-claude-sisyphus', 'version'");
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

  // npm starts a process of its own (here a long sleep that holds the pipe of its output open) and hangs. The limit ends
  // npm, and the group kill ends the sleep with it; before, the sleep outlived the command. On Windows the limit ends the
  // shell only (see the comment of the command), so the case is POSIX only.
  test.skipIf(!posix)('a hanging npm is killed together with the process it started', () => {
    const preload = "const cp = require('child_process'); const spawnSync = cp.spawnSync; cp.spawnSync = (command, args, options) => spawnSync(command, args, { ...options, timeout: 1500 });\n";
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-npm-tree-'));
    let pid = 0;
    try {
      writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\nsleep 120 &\necho $! > "$(dirname "$0")/pid"\nwait\n');
      chmodSync(path.join(dir, 'npm'), 0o755);
      writeFileSync(path.join(dir, 'preload.cjs'), preload);
      const result = spawnSync(process.execPath, ['--require', path.join(dir, 'preload.cjs'), SCRIPT, NPM_LATEST], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PATH: dir + path.delimiter + '/usr/bin' + path.delimiter + '/bin' },
      });
      expect({ error: result.error, status: result.status, stdout: result.stdout }).toEqual({ error: undefined, status: 0, stdout: 'npm latest: (unavailable)\n' });
      pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8').trim());
      expect(Number.isInteger(pid) && pid > 1).toBe(true);
      // The process is gone when it does not exist or only waits for its parent to collect it (a zombie).
      const state = () => {
        const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
        expect(ps.error).toBeUndefined();
        return ps.stdout.trim();
      };
      for (let i = 0; i < 30 && state() !== '' && !state().startsWith('Z'); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      expect(state() === '' || state().startsWith('Z')).toBe(true);
    } finally {
      // A process of this test that is still there (the case failed) is ended by its pid.
      if (pid > 1) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The process is gone, which is what the case expects.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
