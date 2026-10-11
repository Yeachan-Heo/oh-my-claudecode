/**
 * The shipped Stop hooks (scripts/persistent-mode.mjs for the plugin,
 * templates/hooks/persistent-mode.mjs for standalone installs) must enforce
 * the same ralph hard max as src/lib/security-config.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = join(__dirname, '../../../..');
const SCRIPT_HOOK_PATH = join(REPO_ROOT, 'scripts', 'persistent-mode.mjs');
const SESSION_ID = 'session-hard-max-script';

let workRoot: string;
let templateHookPath: string;

// Stage the template the way the standalone installer does: template hook and
// lib, with config-dir and state-lock taken from scripts/lib.
function stageInstalledTemplateHook(root: string): string {
  const hooksDir = join(root, 'installed-hooks');
  const libDir = join(hooksDir, 'lib');
  mkdirSync(libDir, { recursive: true });
  copyFileSync(join(REPO_ROOT, 'templates', 'hooks', 'persistent-mode.mjs'), join(hooksDir, 'persistent-mode.mjs'));
  for (const file of readdirSync(join(REPO_ROOT, 'templates', 'hooks', 'lib'))) {
    copyFileSync(join(REPO_ROOT, 'templates', 'hooks', 'lib', file), join(libDir, file));
  }
  for (const file of ['config-dir.mjs', 'state-lock.mjs']) {
    copyFileSync(join(REPO_ROOT, 'scripts', 'lib', file), join(libDir, file));
  }
  return join(hooksDir, 'persistent-mode.mjs');
}

interface Scenario {
  iteration: number;
  maxIterations: number;
  strict?: boolean;
  userConfig?: string;
}

function runStopHook(hookPath: string, scenario: Scenario) {
  const caseDir = mkdtempSync(join(workRoot, 'case-'));
  const home = join(caseDir, 'home');
  const xdg = join(caseDir, 'xdg');
  const repo = join(caseDir, 'repo');
  const stateDir = join(repo, '.omc', 'state', 'sessions', SESSION_ID);
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);

  if (scenario.userConfig !== undefined) {
    mkdirSync(join(xdg, 'claude-omc'), { recursive: true });
    writeFileSync(join(xdg, 'claude-omc', 'config.jsonc'), scenario.userConfig);
  }

  const now = new Date().toISOString();
  const statePath = join(stateDir, 'ralph-state.json');
  writeFileSync(statePath, JSON.stringify({
    active: true,
    iteration: scenario.iteration,
    max_iterations: scenario.maxIterations,
    started_at: now,
    last_checked_at: now,
    prompt: 'Test task',
    session_id: SESSION_ID,
    project_path: repo,
  }));

  // The hooks read the user config from XDG_CONFIG_HOME, or APPDATA on Windows.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, APPDATA: xdg };
  for (const key of [
    'OMC_SECURITY', 'TMUX', 'DISABLE_OMC', 'OMC_SKIP_HOOKS', 'OMC_STATE_DIR',
    'CLAUDE_CONFIG_DIR', 'OMC_STALE_RUN_HOURS',
  ]) {
    delete env[key];
  }
  if (scenario.strict) env.OMC_SECURITY = 'strict';

  const result = spawnSync('node', [hookPath], {
    cwd: repo,
    env,
    input: JSON.stringify({ session_id: SESSION_ID, cwd: repo, hook_event_name: 'Stop' }),
    encoding: 'utf-8',
    timeout: 10_000,
  });

  return {
    output: JSON.parse(result.stdout.trim()) as { decision?: string; reason?: string },
    state: JSON.parse(readFileSync(statePath, 'utf-8')) as { active: boolean; max_iterations: number },
  };
}

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'ralph-hard-max-script-'));
  templateHookPath = stageInstalledTemplateHook(workRoot);
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe.each([
  ['scripts/persistent-mode.mjs', () => SCRIPT_HOOK_PATH],
  ['templates/hooks/persistent-mode.mjs (installed layout)', () => templateHookPath],
])('ralph hard max in %s', (_name, hookPath) => {
  it('stops at the strict hard max even when max_iterations is higher', () => {
    const { output, state } = runStopHook(hookPath(), { iteration: 200, maxIterations: 1000, strict: true });
    expect(output.reason).toContain('HARD LIMIT');
    expect(output.reason).toContain('(200)');
    expect(state.active).toBe(false);
  });

  it('does not let config relax the strict hard max', () => {
    for (const value of [0, 1000]) {
      const { output, state } = runStopHook(hookPath(), {
        iteration: 200,
        maxIterations: 300,
        strict: true,
        userConfig: JSON.stringify({ security: { hardMaxIterations: value } }),
      });
      expect(output.reason).toContain('HARD LIMIT');
      expect(output.reason).toContain('(200)');
      expect(state.active).toBe(false);
    }
  });

  it('applies the default hard max of 500 outside strict mode', () => {
    const { output, state } = runStopHook(hookPath(), { iteration: 500, maxIterations: 500 });
    expect(output.reason).toContain('HARD LIMIT');
    expect(output.reason).toContain('(500)');
    expect(state.active).toBe(false);
  });

  it('reads the security section from a JSONC user config containing URLs and comments', () => {
    const { output, state } = runStopHook(hookPath(), {
      iteration: 50,
      maxIterations: 60,
      userConfig: [
        '{',
        '  // notifications',
        '  "notifications": { "discord": { "webhookUrl": "https://discord.com/api/webhooks/x" } },',
        '  "security": { "hardMaxIterations": 50 },',
        '}',
      ].join('\n'),
    });
    expect(output.reason).toContain('HARD LIMIT');
    expect(output.reason).toContain('(50)');
    expect(state.active).toBe(false);
  });

  it('does not let a block comment join adjacent numeric tokens in config', () => {
    const { output, state } = runStopHook(hookPath(), {
      iteration: 500,
      maxIterations: 1000,
      userConfig: '{"security":{"hardMaxIterations":2/*comment*/000}}',
    });
    expect(output.reason).toContain('HARD LIMIT');
    expect(output.reason).toContain('(500)');
    expect(state.active).toBe(false);
  });

  it('ignores config ending with an unterminated block comment', () => {
    const { output, state } = runStopHook(hookPath(), {
      iteration: 50,
      maxIterations: 50,
      userConfig: '{"security":{"hardMaxIterations":50}}/*unterminated',
    });
    expect(output.reason).toContain('EXTENDED');
    expect(state.active).toBe(true);
    expect(state.max_iterations).toBe(60);
  });

  it('still extends max_iterations below the hard max', () => {
    const { output, state } = runStopHook(hookPath(), { iteration: 100, maxIterations: 100 });
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('EXTENDED');
    expect(state.active).toBe(true);
    expect(state.max_iterations).toBe(110);
  });
});
