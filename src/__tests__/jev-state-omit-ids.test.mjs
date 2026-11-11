/**
 * OMC_JEV_STATE_OMIT_IDS: the loop-continuation state goes to Jev without
 * session_id and the simplifier-trigger state without cwd; with
 * OMC_JEV_LOG_CONTEXT=1 both stay in the local log line.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJevStateOmitIdsEnabled } from '../../scripts/jev-resolve.mjs';
import { isJevStateOmitIdsEnabled as tsIsJevStateOmitIdsEnabled } from '../hooks/jev/config.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;
const CLEANUPS = [];
let endpoint = '';
let server;
const bodies = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      const answers = {};
      for (const name of Object.keys(JSON.parse(body).questions ?? {})) answers[name] = { type: 'noul', noul: 0.1 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = 'http://127.0.0.1:' + server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const path of CLEANUPS.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A temp directory still held by the OS is left for the OS.
    }
  }
});

function makeContext() {
  const root = mkdtempSync(join(tmpdir(), 'jev-state-omit-ids-'));
  CLEANUPS.push(root);
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const logDir = join(root, 'jev-log');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  return { root, cwd, home, logDir };
}

function runHook(context, script, input, point, overrides = {}) {
  const env = {
    ...process.env,
    HOME: context.home,
    USERPROFILE: context.home,
    CLAUDE_CONFIG_DIR: join(context.home, '.claude'),
    CLAUDE_PLUGIN_ROOT: '',
    DISABLE_OMC: '',
    OMC_SKIP_HOOKS: '',
    OMC_STATE_DIR: '',
    TYPESAFE_API_KEY: 'test-key',
    OMC_JEV: point + ':active',
    OMC_JEV_LOG_DIR: context.logDir,
    OMC_JEV_ENDPOINT: endpoint,
    OMC_JEV_TIMEOUT_MS: '10000',
    NODE_ENV: 'test',
    ...overrides,
  };
  return new Promise((resolve, reject) => {
    const child = execFile(NODE, [join(ROOT, 'scripts', script)], { cwd: context.cwd, encoding: 'utf8', timeout: 30_000, env },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
}

function shadowLine(context, point) {
  const path = join(context.logDir, 'shadow.jsonl');
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.point === point);
}

/** The state of the last request the stub received for a point's question. */
function sentState(question) {
  return [...bodies].reverse().find((body) => Object.hasOwn(body.questions ?? {}, question))?.state;
}

function ralphStop(context) {
  const stateDir = join(context.cwd, '.omc', 'state', 'sessions', 'jev-session');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({
    active: true,
    session_id: 'jev-session',
    project_path: context.cwd,
    iteration: 1,
    max_iterations: 5,
    started_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    prompt: 'Complete the bounded task and verify the result.',
  }));
  return { cwd: context.cwd, session_id: 'jev-session', last_assistant_message: 'The task is not complete yet.' };
}

function simplifierStop(context) {
  execFileSync('git', ['config', 'user.email', 'jev-test@example.invalid'], { cwd: context.cwd });
  execFileSync('git', ['config', 'user.name', 'Jev Test'], { cwd: context.cwd });
  mkdirSync(join(context.cwd, 'src'), { recursive: true });
  writeFileSync(join(context.cwd, 'src', 'sample.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'src/sample.ts'], { cwd: context.cwd });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: context.cwd, stdio: 'ignore' });
  writeFileSync(join(context.cwd, 'src', 'sample.ts'), 'export const value = 2;\n');
  mkdirSync(join(context.home, '.omc'), { recursive: true });
  writeFileSync(join(context.home, '.omc', 'config.json'), JSON.stringify({ codeSimplifier: { enabled: true } }));
  return { cwd: context.cwd, session_id: 'jev-session' };
}

describe('isJevStateOmitIdsEnabled parity with the TS config contract', () => {
  it.each([
    [{}, false],
    [{ OMC_JEV_STATE_OMIT_IDS: '0' }, false],
    [{ OMC_JEV_STATE_OMIT_IDS: 'yes' }, false],
    [{ OMC_JEV_STATE_OMIT_IDS: '1' }, true],
    [{ OMC_JEV_STATE_OMIT_IDS: 'True' }, true],
  ])('%j -> %s in both channels', (env, expected) => {
    expect(isJevStateOmitIdsEnabled(env)).toBe(expected);
    expect(tsIsJevStateOmitIdsEnabled(env)).toBe(expected);
  });
});

describe('loop-continuation state (persistent-mode.mjs)', () => {
  it('sends session_id without the variable, as before', async () => {
    const context = makeContext();
    await runHook(context, 'persistent-mode.mjs', ralphStop(context), 'loop-continuation');
    expect(sentState('task_complete')).toMatchObject({ mode_name: 'ralph', session_id: 'jev-session' });
    expect(shadowLine(context, 'loop-continuation').state).toHaveProperty('session_id', 'jev-session');
  }, 60_000);

  it('leaves session_id out of the state with the variable, and keeps it in the log line with OMC_JEV_LOG_CONTEXT=1', async () => {
    const context = makeContext();
    await runHook(context, 'persistent-mode.mjs', ralphStop(context), 'loop-continuation', { OMC_JEV_STATE_OMIT_IDS: '1', OMC_JEV_LOG_CONTEXT: '1' });
    const state = sentState('task_complete');
    expect(state).toMatchObject({ mode_name: 'ralph', should_block: true });
    expect(state).not.toHaveProperty('session_id');
    const line = shadowLine(context, 'loop-continuation');
    expect(line.state).not.toHaveProperty('session_id');
    expect(line.session_id).toBe('jev-session');
  }, 60_000);
});

describe('simplifier-trigger state (code-simplifier.mjs)', () => {
  it('sends cwd without the variable, as before', async () => {
    const context = makeContext();
    await runHook(context, 'code-simplifier.mjs', simplifierStop(context), 'simplifier-trigger');
    expect(sentState('simplification_worthy')).toHaveProperty('cwd', context.cwd);
  }, 60_000);

  it('leaves cwd out of the state with the variable, and keeps it in the log line with OMC_JEV_LOG_CONTEXT=1', async () => {
    const context = makeContext();
    await runHook(context, 'code-simplifier.mjs', simplifierStop(context), 'simplifier-trigger', { OMC_JEV_STATE_OMIT_IDS: 'true', OMC_JEV_LOG_CONTEXT: '1' });
    const line = shadowLine(context, 'simplifier-trigger');
    expect(line.state).toMatchObject({ source: 'code-simplifier-stop', files: ['src/sample.ts'] });
    expect(line.state).not.toHaveProperty('cwd');
    expect(line.cwd).toBe(context.cwd);
    expect(JSON.stringify(bodies)).not.toContain(JSON.stringify(context.cwd).slice(1, -1));
  }, 60_000);
});
