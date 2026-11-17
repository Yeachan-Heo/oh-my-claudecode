import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureTmuxServerIdentity } from '../tmux-session.js';

const LOCALE_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const;

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function tmuxTestEnv(): NodeJS.ProcessEnv {
  const { TMUX: _, ...env } = process.env;
  return env;
}

describe.skipIf(process.platform === 'win32' || !hasTmux())(
  'tmux server identity under a non-UTF-8 locale',
  () => {
    let directory: string;
    let socketPath: string;
    let savedLocale: Partial<Record<(typeof LOCALE_KEYS)[number], string>>;

    beforeEach(() => {
      savedLocale = {};
      for (const key of LOCALE_KEYS) {
        if (process.env[key] !== undefined) savedLocale[key] = process.env[key];
      }
      delete process.env.LC_ALL;
      delete process.env.LC_CTYPE;
      process.env.LANG = 'C';

      directory = mkdtempSync('/tmp/omc-locale-');
      socketPath = join(directory, 's');
      execFileSync(
        'tmux',
        ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', 'locale', 'sleep 300'],
        { env: tmuxTestEnv(), stdio: 'ignore' },
      );
    });

    afterEach(() => {
      try {
        execFileSync('tmux', ['-S', socketPath, 'kill-server'], {
          env: tmuxTestEnv(),
          stdio: 'ignore',
        });
      } catch {
        // The server may already be gone.
      }
      rmSync(directory, { recursive: true, force: true });
      for (const key of LOCALE_KEYS) {
        const value = savedLocale[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('captures the identity of the server bound to the selected socket', async () => {
      const serverPid = Number(
        execFileSync(
          'tmux',
          ['-S', socketPath, 'display-message', '-p', '#{pid}'],
          { env: tmuxTestEnv(), encoding: 'utf-8' },
        ).trim(),
      );

      const identity = await captureTmuxServerIdentity(socketPath);

      expect(identity).toMatchObject({
        socket_path: socketPath,
        server_pid: serverPid,
      });
    });
  },
);
