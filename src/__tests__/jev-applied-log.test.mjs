/**
 * OMC_JEV_APPLIED_LOG: the hook scripts that act on an active Jev answer write
 * what the answer changed to applied.jsonl, next to shadow.jsonl, and nothing
 * without the variable.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJevAppliedLogEnabled } from '../../scripts/lib/jev-shadow.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;
const JEV_SHADOW_URL = pathToFileURL(join(ROOT, 'scripts', 'lib', 'jev-shadow.mjs')).href;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEANUPS = [];
let endpoint = '';
let server;
// The stub's answers for the next requests: question name -> answer.
let stubAnswers = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const answers = {};
      for (const name of Object.keys(JSON.parse(body).questions ?? {})) {
        if (stubAnswers[name]) answers[name] = stubAnswers[name];
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: Object.keys(answers).length > 0 ? answers : { unknown: { type: 'noul', noul: 0 } } }));
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
  const root = mkdtempSync(join(tmpdir(), 'jev-applied-log-'));
  CLEANUPS.push(root);
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const logDir = join(root, 'jev-log');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home, logDir };
}

function hookEnv(context, point, overrides = {}) {
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
    OMC_JEV_APPLIED_LOG: '1',
    NODE_ENV: 'test',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

/** A hook prints one JSON object, pretty-printed by some hooks; anything before it is ignored. */
function parseHookOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.slice(text.indexOf('\n{') + 1));
  }
}

function runHook(context, script, input, point, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(NODE, [join(ROOT, 'scripts', script)], {
      cwd: context.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: hookEnv(context, point, overrides),
    }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(parseHookOutput(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function readLog(context, file) {
  const path = join(context.logDir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const TASK_CALL = (cwd, toolInput = {}) => ({
  cwd,
  session_id: 'session-1',
  tool_use_id: 'toolu_1',
  tool_name: 'Task',
  tool_input: { subagent_type: 'oh-my-claudecode:executor', description: 'Fix', prompt: 'Fix the regression and add a test.', model: 'sonnet', ...toolInput },
});

describe('isJevAppliedLogEnabled', () => {
  it.each([
    [{}, false],
    [{ OMC_JEV_APPLIED_LOG: '0' }, false],
    [{ OMC_JEV_APPLIED_LOG: 'on' }, false],
    [{ OMC_JEV_APPLIED_LOG: '1' }, true],
    [{ OMC_JEV_APPLIED_LOG: ' TRUE ' }, true],
  ])('%j -> %s', (env, expected) => {
    expect(isJevAppliedLogEnabled(env)).toBe(expected);
  });
});

describe('recordJevApplied', () => {
  function runApplied(context, env) {
    const script = `
      import { recordJevApplied, setJevHookContext } from ${JSON.stringify(JEV_SHADOW_URL)};
      await setJevHookContext({ session_id: 'session-9', cwd: '/work' });
      recordJevApplied('context-pruning', { action: { from: 'warn', to: 'none' } });
    `;
    execFileSync(NODE, ['--input-type=module', '-e', script], { cwd: context.cwd, env, timeout: 30_000 });
  }

  it('writes {ts, point, applied} without OMC_JEV_LOG_CONTEXT', () => {
    const context = makeContext();
    runApplied(context, hookEnv(context, 'context-pruning'));
    const lines = readLog(context, 'applied.jsonl');
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'point', 'applied']);
    expect(lines[0]).toMatchObject({ point: 'context-pruning', applied: { action: { from: 'warn', to: 'none' } } });
  });

  it('adds the hook call ids with OMC_JEV_LOG_CONTEXT=1', () => {
    const context = makeContext();
    runApplied(context, hookEnv(context, 'context-pruning', { OMC_JEV_LOG_CONTEXT: '1' }));
    const [line] = readLog(context, 'applied.jsonl');
    expect(Object.keys(line)).toEqual(['ts', 'point', 'session_id', 'cwd', 'applied']);
    expect(line).toMatchObject({ session_id: 'session-9', cwd: '/work' });
  });

  it('writes nothing without the variable', () => {
    const context = makeContext();
    runApplied(context, hookEnv(context, 'context-pruning', { OMC_JEV_APPLIED_LOG: undefined }));
    expect(existsSync(join(context.logDir, 'applied.jsonl'))).toBe(false);
  });
});

describe('hook scripts with OMC_JEV_APPLIED_LOG=1', () => {
  it('model-routing: one line once the output carries Jev\'s model and effort', async () => {
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'opus' }, effort: { type: 'score', score: 3 } };
    const context = makeContext();
    const output = await runHook(context, 'pre-tool-enforcer.mjs', TASK_CALL(context.cwd), 'model-routing');
    expect(output.hookSpecificOutput.updatedInput).toMatchObject({ model: 'opus', effort: 'xhigh' });
    const lines = readLog(context, 'applied.jsonl');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      ts: expect.any(String),
      point: 'model-routing',
      applied: { subagent_type: 'oh-my-claudecode:executor', model: { from: 'sonnet', to: 'opus' }, effort: { from: null, to: 'xhigh', score: 3 } },
    });
  }, 60_000);

  it('model-routing: the line and the shadow line share one request_id with OMC_JEV_LOG_CONTEXT=1', async () => {
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'haiku' } };
    const context = makeContext();
    await runHook(context, 'pre-tool-enforcer.mjs', TASK_CALL(context.cwd), 'model-routing', { OMC_JEV_LOG_CONTEXT: '1' });
    const [shadow] = readLog(context, 'shadow.jsonl');
    const [applied] = readLog(context, 'applied.jsonl');
    expect(shadow.request_id).toMatch(UUID);
    expect(applied).toMatchObject({
      point: 'model-routing',
      session_id: 'session-1',
      tool_use_id: 'toolu_1',
      request_id: shadow.request_id,
      applied: { model: { from: 'sonnet', to: 'haiku' } },
    });
    expect(applied.applied).not.toHaveProperty('effort');
  }, 60_000);

  it('model-routing: no line when the answer changes nothing, in shadow mode, or without the variable', async () => {
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'sonnet' } };
    const same = makeContext();
    await runHook(same, 'pre-tool-enforcer.mjs', TASK_CALL(same.cwd), 'model-routing');
    expect(readLog(same, 'applied.jsonl')).toEqual([]);

    stubAnswers = { 'model-tier': { type: 'choice', choice: 'opus' } };
    const shadow = makeContext();
    await runHook(shadow, 'pre-tool-enforcer.mjs', TASK_CALL(shadow.cwd), 'model-routing', { OMC_JEV: 'model-routing' });
    expect(readLog(shadow, 'applied.jsonl')).toEqual([]);

    const off = makeContext();
    await runHook(off, 'pre-tool-enforcer.mjs', TASK_CALL(off.cwd), 'model-routing', { OMC_JEV_APPLIED_LOG: undefined });
    expect(readLog(off, 'shadow.jsonl')).toHaveLength(1);
    expect(existsSync(join(off.logDir, 'applied.jsonl'))).toBe(false);
  }, 90_000);

  it('context-pruning: the action Jev changed', async () => {
    stubAnswers = { staleness: { type: 'score', score: 0 } };
    const context = makeContext();
    await runHook(context, 'post-tool-verifier.mjs', {
      cwd: context.cwd,
      session_id: 'session-1',
      tool_name: 'Read',
      tool_response: 'A retained tool result with useful context.\nMore content.',
      context_window: { used_percentage: 80 },
    }, 'context-pruning');
    const [line] = readLog(context, 'applied.jsonl');
    expect(line).toMatchObject({ point: 'context-pruning', applied: { action: { from: 'warn', to: 'none' }, staleness: 'fresh' } });
  }, 60_000);

  it('skill-trigger: the keywords Jev changed', async () => {
    stubAnswers = { 'skill-trigger': { type: 'choice', choice: 'none' } };
    const context = makeContext();
    await runHook(context, 'keyword-detector.mjs', { cwd: context.cwd, session_id: 'session-1', prompt: '/oh-my-claudecode:ralph fix the regression' }, 'skill-trigger');
    const [line] = readLog(context, 'applied.jsonl');
    expect(line).toMatchObject({ point: 'skill-trigger', applied: { keywords: { from: ['ralph'], to: [] }, choice: 'none' } });
  }, 60_000);

  it('task-size: the heavy modes a small answer suppressed', async () => {
    stubAnswers = { 'task-size': { type: 'choice', choice: 'small', confidence: 0.95 } };
    const context = makeContext();
    await runHook(context, 'keyword-detector.mjs', { cwd: context.cwd, session_id: 'session-1', prompt: 'quick: ralph fix the typo in the readme' }, 'task-size');
    const [line] = readLog(context, 'applied.jsonl');
    expect(line).toMatchObject({ point: 'task-size', applied: { size: 'small', confidence: 0.95, suppressed: ['ralph'] } });
  }, 60_000);

  it('loop-continuation: the mode Jev\'s "task complete" ended', async () => {
    stubAnswers = { task_complete: { type: 'noul', noul: 0.9 } };
    const context = makeContext();
    execFileSync('git', ['init'], { cwd: context.cwd, stdio: 'ignore' });
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
    await runHook(context, 'persistent-mode.mjs', { cwd: context.cwd, session_id: 'jev-session', last_assistant_message: 'The task is complete.' }, 'loop-continuation');
    const [line] = readLog(context, 'applied.jsonl');
    expect(line).toMatchObject({ point: 'loop-continuation', applied: { mode: 'ralph', completed: { from: false, to: true } } });
    expect(JSON.parse(readFileSync(join(stateDir, 'ralph-state.json'), 'utf8')).active).toBe(false);
  }, 60_000);
});
