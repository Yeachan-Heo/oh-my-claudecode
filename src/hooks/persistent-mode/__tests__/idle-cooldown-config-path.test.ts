/**
 * The Stop hook scripts (scripts/persistent-mode.mjs and .cjs) must read the
 * session-idle cooldown from the global OMC config where
 * getIdleNotificationCooldownSeconds() looks for it: OMC_HOME when set,
 * otherwise ${XDG_CONFIG_HOME:-~/.config}/omc/config.json on Linux/Unix,
 * with the legacy ~/.omc/config.json as a fallback.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = [
  ['persistent-mode.mjs', join(process.cwd(), 'scripts', 'persistent-mode.mjs')],
  ['persistent-mode.cjs', join(process.cwd(), 'scripts', 'persistent-mode.cjs')],
] as const;
const posixOnly = process.platform === 'win32' || process.platform === 'darwin' ? it.skip : it;

let root = '';
let homeDir = '';
let markerPath = '';

function writeCooldown(dir: string, seconds: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ notificationCooldown: { sessionIdleSeconds: seconds } }),
    'utf-8',
  );
}

function runStop(script: string, env: Record<string, string> = {}): void {
  const baseEnv = { ...process.env };
  for (const key of ['OMC_HOME', 'XDG_CONFIG_HOME', 'OMC_NOTIFY', 'OMC_JEV']) {
    delete baseEnv[key];
  }
  execFileSync(process.execPath, [script], {
    input: JSON.stringify({ cwd: join(root, 'project'), session_id: 'idle-config-path' }),
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...baseEnv,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_PLUGIN_ROOT: join(root, 'plugin'),
      OMC_STATE_DIR: join(root, 'state'),
      IDLE_MARKER_PATH: markerPath,
      ...env,
    },
  });
}

async function notificationsAfterTwoStops(script: string, env: Record<string, string> = {}): Promise<number> {
  const count = () => (existsSync(markerPath) ? readFileSync(markerPath, 'utf-8').split('\n').filter(Boolean).length : 0);
  const waitFor = async (n: number) => {
    const deadline = Date.now() + 2000;
    while (count() < n && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  runStop(script, env);
  await waitFor(1);
  runStop(script, env);
  await waitFor(2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return count();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'idle-cooldown-config-path-'));
  homeDir = join(root, 'home');
  markerPath = join(root, 'idle-marker');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(root, 'project'), { recursive: true });
  mkdirSync(join(root, 'plugin', 'dist', 'notifications'), { recursive: true });
  writeFileSync(
    join(root, 'plugin', 'dist', 'notifications', 'index.js'),
    `export async function notify(event) {\n` +
      `  const { appendFileSync } = await import('node:fs');\n` +
      `  appendFileSync(process.env.IDLE_MARKER_PATH, event + '\\n');\n` +
      `}\n`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.each(SCRIPTS)('%s session-idle cooldown config lookup', (_label, script) => {
  it('keeps the 60s default cooldown when no config exists', async () => {
    expect(await notificationsAfterTwoStops(script)).toBe(1);
  });

  it('still reads the legacy ~/.omc/config.json fallback', async () => {
    writeCooldown(join(homeDir, '.omc'), 0);
    expect(await notificationsAfterTwoStops(script)).toBe(2);
  });

  posixOnly('reads ~/.config/omc/config.json when XDG_CONFIG_HOME is unset', async () => {
    writeCooldown(join(homeDir, '.config', 'omc'), 0);
    expect(await notificationsAfterTwoStops(script)).toBe(2);
  });

  posixOnly('prefers the XDG config over the legacy ~/.omc/config.json', async () => {
    writeCooldown(join(homeDir, '.config', 'omc'), 60);
    writeCooldown(join(homeDir, '.omc'), 0);
    expect(await notificationsAfterTwoStops(script)).toBe(1);
  });

  it('reads only $OMC_HOME/config.json when OMC_HOME is set', async () => {
    const omcHome = join(root, 'omc-home');
    writeCooldown(omcHome, 0);
    writeCooldown(join(homeDir, '.omc'), 60);
    expect(await notificationsAfterTwoStops(script, { OMC_HOME: omcHome })).toBe(2);
  });
});
