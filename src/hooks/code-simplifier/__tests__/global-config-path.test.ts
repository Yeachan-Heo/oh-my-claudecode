/**
 * The shipped Stop hook scripts must find the global OMC config where
 * src/hooks/code-simplifier (getGlobalOmcConfigCandidates) and
 * docs/REFERENCE.md say it lives: OMC_HOME when set, otherwise
 * ${XDG_CONFIG_HOME:-~/.config}/omc/config.json on Linux/Unix, with the
 * legacy ~/.omc/config.json as a fallback.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = [
  ['plugin hook', join(process.cwd(), 'scripts', 'code-simplifier.mjs')],
  ['standalone template', join(process.cwd(), 'templates', 'hooks', 'code-simplifier.mjs')],
] as const;

const posixOnly = process.platform === 'win32' || process.platform === 'darwin' ? it.skip : it;

let root = '';
let homeDir = '';
let repoDir = '';

function writeConfig(dir: string, enabled: boolean): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ codeSimplifier: { enabled } }), 'utf-8');
}

function runStop(script: string, env: Record<string, string> = {}): Record<string, unknown> {
  const baseEnv = { ...process.env };
  for (const key of ['OMC_HOME', 'OMC_STATE_DIR', 'XDG_CONFIG_HOME', 'CLAUDE_PLUGIN_ROOT', 'OMC_JEV', 'GIT_DIR', 'GIT_WORK_TREE']) {
    delete baseEnv[key];
  }
  const stdout = execFileSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: 'cfg-path-test', cwd: repoDir, hook_event_name: 'Stop' }),
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...baseEnv, HOME: homeDir, USERPROFILE: homeDir, NODE_ENV: 'test', ...env },
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'simplifier-config-path-'));
  homeDir = join(root, 'home');
  repoDir = join(root, 'repo');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n', 'utf-8');
  git(['add', 'a.ts']);
  git(['commit', '-q', '-m', 'init']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2;\n', 'utf-8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.each(SCRIPTS)('code-simplifier %s global config lookup', (_label, script) => {
  posixOnly('reads ${XDG_CONFIG_HOME}/omc/config.json', () => {
    const xdg = join(root, 'xdg');
    writeConfig(join(xdg, 'omc'), true);
    const out = runStop(script, { XDG_CONFIG_HOME: xdg });
    expect(out.decision).toBe('block');
    expect(String(out.reason)).toContain('a.ts');
  });

  posixOnly('reads ~/.config/omc/config.json when XDG_CONFIG_HOME is unset', () => {
    writeConfig(join(homeDir, '.config', 'omc'), true);
    expect(runStop(script).decision).toBe('block');
  });

  posixOnly('prefers the XDG config over the legacy ~/.omc/config.json', () => {
    writeConfig(join(homeDir, '.config', 'omc'), false);
    writeConfig(join(homeDir, '.omc'), true);
    expect(runStop(script)).toEqual({ continue: true });
  });

  it('still reads the legacy ~/.omc/config.json fallback', () => {
    writeConfig(join(homeDir, '.omc'), true);
    expect(runStop(script).decision).toBe('block');
  });

  it('reads only $OMC_HOME/config.json when OMC_HOME is set', () => {
    const omcHome = join(root, 'omc-home');
    writeConfig(omcHome, true);
    expect(runStop(script, { OMC_HOME: omcHome }).decision).toBe('block');

    writeConfig(omcHome, false);
    writeConfig(join(homeDir, '.omc'), true);
    expect(runStop(script, { OMC_HOME: omcHome })).toEqual({ continue: true });
  });

  it('stays disabled when no config exists', () => {
    expect(runStop(script)).toEqual({ continue: true });
  });
});
