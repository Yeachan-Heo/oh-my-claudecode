/* global process */
/**
 * Tests for OMC_JEV_LOG_CONTEXT on the script side: jevLogContextOf and the
 * shadow-log line of resolveRequest in scripts/jev-resolve.mjs, the request
 * context and the hook-written degraded lines of scripts/lib/jev-shadow.mjs,
 * and the wiring in the five hook scripts.
 *
 * .mjs so vitest picks it up without tsc typechecking the untyped scripts.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { isJevLogContextEnabled, jevLogContextOf, resolveRequest } from '../../scripts/jev-resolve.mjs';
import { parseJevConfig } from '../hooks/jev/config.ts';
import { jevLogContextOf as tsJevLogContextOf } from '../hooks/jev/resolver.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const JEV_SHADOW_URL = pathToFileURL(join(root, 'scripts', 'lib', 'jev-shadow.mjs')).href;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEV_LINE_KEYS = ['ts', 'point', 'mode', 'state', 'heuristic', 'jev', 'answers', 'confidence', 'durationMs'];

const tmp = mkdtempSync(join(tmpdir(), 'jev-log-context-test-'));
const afterHooks = [];
afterAll(async () => {
  for (const fn of afterHooks.reverse()) await fn();
  rmSync(tmp, { recursive: true, force: true });
});

let dirCount = 0;
function freshDir() {
  dirCount += 1;
  const dir = join(tmp, 'case-' + dirCount);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readLines(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const QUESTIONS = {
  route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
  effort: { type: 'score', criteria: { low: 'low', high: 'high' } },
};
const HOOK_INPUT = {
  tool_use_id: 'toolu_01',
  session_id: 'session-1',
  cwd: '/work/project',
  agent_id: 'agent-7',
  agent_type: 'executor',
  prompt: 'not an id',
};

/** A fetch stub that answers with `answers` and keeps every request body. */
function fetchAnswering(answers) {
  const bodies = [];
  const fn = async (_url, init) => {
    bodies.push(init.body);
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  return { fn, bodies };
}

function envFor(dir, overrides = {}) {
  return { TYPESAFE_API_KEY: 'test-key', OMC_JEV: 'model-routing', OMC_JEV_LOG_DIR: dir, ...overrides };
}

describe('isJevLogContextEnabled parity with the TS config contract', () => {
  it.each([
    [{}, false],
    [{ OMC_JEV_LOG_CONTEXT: '' }, false],
    [{ OMC_JEV_LOG_CONTEXT: '0' }, false],
    [{ OMC_JEV_LOG_CONTEXT: 'yes' }, false],
    [{ OMC_JEV_LOG_CONTEXT: '1' }, true],
    [{ OMC_JEV_LOG_CONTEXT: ' 1 ' }, true],
    [{ OMC_JEV_LOG_CONTEXT: 'true' }, true],
    [{ OMC_JEV_LOG_CONTEXT: 'TRUE' }, true],
  ])('%j -> %s in both channels', (env, expected) => {
    expect(isJevLogContextEnabled(env)).toBe(expected);
    expect(parseJevConfig({ OMC_JEV_LOG_DIR: tmp, ...env }).logContext).toBe(expected);
  });
});

describe('jevLogContextOf', () => {
  it('keeps the ids of a hook input and nothing else', () => {
    expect(jevLogContextOf(HOOK_INPUT)).toEqual({
      tool_use_id: 'toolu_01',
      session_id: 'session-1',
      cwd: '/work/project',
      agent_id: 'agent-7',
      agent_type: 'executor',
    });
  });

  it('reads camel case and directory, drops empty and non-string values, cuts at 1000 characters', () => {
    const context = jevLogContextOf({ toolUseId: 'toolu_02', sessionId: '', session_id: 7, directory: '/d', promptId: 'p'.repeat(1500) });
    expect(context).toEqual({ tool_use_id: 'toolu_02', cwd: '/d', prompt_id: 'p'.repeat(1000) });
  });

  it.each([[undefined], [null], ['text'], [42]])('is empty for %j', (source) => {
    expect(jevLogContextOf(source)).toEqual({});
  });

  it.each([
    [HOOK_INPUT],
    [{ toolUseId: 'a', sessionId: 'b', directory: 'c', agentId: 'd', agentType: 'e', promptId: 'f', request_id: 'g' }],
    [{ session_id: '', sessionId: 'second', cwd: 5, prompt_id: 'x'.repeat(2000) }],
  ])('matches the TS mirror for %j', (source) => {
    expect(jevLogContextOf(source)).toEqual(tsJevLogContextOf(source));
  });
});

describe('resolveRequest shadow-log line', () => {
  const request = {
    point: 'model-routing',
    state: { task: 'fix it' },
    questions: QUESTIONS,
    heuristic: 'sonnet',
    context: { ...jevLogContextOf(HOOK_INPUT), request_id: 'req-1' },
  };

  it('without the variable is written as before: no ids, the fallback answer as jev, no request_id in the result', async () => {
    const dir = freshDir();
    // Jev skipped the first question: dev logs the first answer in server order.
    const { fn } = fetchAnswering({ effort: { type: 'score', score: 3, confidence: 0.4 } });
    const result = await resolveRequest(request, envFor(dir, { OMC_JEV: 'model-routing:active' }), fn);
    const [line] = readLines(join(dir, 'shadow.jsonl'));
    expect(Object.keys(line)).toEqual(DEV_LINE_KEYS);
    expect(line.jev).toEqual({ type: 'score', score: 3, confidence: 0.4 });
    expect(line.confidence).toBe(0.4);
    expect(result).not.toHaveProperty('request_id');
    expect(Object.keys(result)).toEqual(['mode', 'answer', 'answers', 'confidence', 'durationMs']);
  });

  it('with the variable carries the ids right after point and echoes request_id', async () => {
    const dir = freshDir();
    const { fn } = fetchAnswering({ route: { type: 'choice', choice: 'opus', confidence: 0.9 } });
    const result = await resolveRequest(request, envFor(dir, { OMC_JEV: 'model-routing:active', OMC_JEV_LOG_CONTEXT: '1' }), fn);
    const [line] = readLines(join(dir, 'shadow.jsonl'));
    expect(Object.keys(line)).toEqual([
      'ts', 'point', 'tool_use_id', 'session_id', 'cwd', 'agent_id', 'agent_type', 'request_id',
      'mode', 'state', 'heuristic', 'jev', 'answers', 'confidence', 'durationMs',
    ]);
    expect(line).toMatchObject({ session_id: 'session-1', request_id: 'req-1', jev: { choice: 'opus' }, confidence: 0.9 });
    expect(result).toMatchObject({ mode: 'active', answer: { choice: 'opus' }, request_id: 'req-1' });
  });

  it('with the variable logs jev and confidence of the first question only, null when Jev skipped it', async () => {
    const dir = freshDir();
    const { fn } = fetchAnswering({ effort: { type: 'score', score: 3, confidence: 0.4 } });
    const result = await resolveRequest(request, envFor(dir, { OMC_JEV: 'model-routing:active', OMC_JEV_LOG_CONTEXT: '1' }), fn);
    const [line] = readLines(join(dir, 'shadow.jsonl'));
    expect(line.jev).toBeNull();
    expect(line).not.toHaveProperty('confidence');
    expect(line.answers).toEqual({ effort: { type: 'score', score: 3, confidence: 0.4 } });
    // The result the hook acts on keeps the fallback, as without the variable.
    expect(result).toMatchObject({ answer: { score: 3 }, confidence: 0.4 });
  });

  it('never sends the ids to Jev', async () => {
    const dir = freshDir();
    const { fn, bodies } = fetchAnswering({ route: { type: 'choice', choice: 'opus' } });
    await resolveRequest(request, envFor(dir, { OMC_JEV_LOG_CONTEXT: '1' }), fn);
    expect(bodies).toHaveLength(1);
    expect(Object.keys(JSON.parse(bodies[0]))).toEqual(['state', 'questions', 'model']);
    for (const id of ['toolu_01', 'session-1', '/work/project', 'agent-7', 'req-1']) expect(bodies[0]).not.toContain(id);
  });

  it('logs a degraded request with its ids', async () => {
    const dir = freshDir();
    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await resolveRequest(request, envFor(dir, { OMC_JEV_LOG_CONTEXT: 'true' }), failing);
    const [line] = readLines(join(dir, 'shadow.jsonl'));
    expect(line).toMatchObject({ mode: 'degraded', session_id: 'session-1', request_id: 'req-1', jev: null, answers: null });
  });

  it('ignores a context that is not an object and values that are not strings', async () => {
    const dir = freshDir();
    const { fn } = fetchAnswering({ route: { type: 'choice', choice: 'opus' } });
    await resolveRequest({ ...request, context: { session_id: { nested: true }, cwd: 3 } }, envFor(dir, { OMC_JEV_LOG_CONTEXT: '1' }), fn);
    await resolveRequest({ ...request, context: 'session-1' }, envFor(dir, { OMC_JEV_LOG_CONTEXT: '1' }), fn);
    for (const line of readLines(join(dir, 'shadow.jsonl'))) {
      expect(Object.keys(line)).toEqual(DEV_LINE_KEYS.filter((key) => key !== 'confidence'));
    }
  });
});

/** A local Jev stub: answers every request with `answers`, keeps the bodies. */
async function startStub(answers) {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  afterHooks.push(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: 'http://127.0.0.1:' + server.address().port, bodies };
}

function baseEnv(home, overrides = {}) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    TYPESAFE_API_KEY: 'test-key',
    OMC_JEV: 'model-routing:active',
    ...overrides,
  };
}

/**
 * Run setJevHookContext(input) and one active-mode recordJevShadow call in a
 * child process, the way a hook script does. `resolverPreload` is a CommonJS
 * file the resolver child loads first (to make it exit or hang).
 * `hookPreload` loads before the hook imports, to inject resolver spawn failures.
 */
function runRecord({ cwd, env, input = HOOK_INPUT, resolverPreload, hookPreload }) {
  const script = `
    import { recordJevShadow, setJevHookContext } from ${JSON.stringify(JEV_SHADOW_URL)};
    await setJevHookContext(${JSON.stringify(input)});
    ${resolverPreload ? `process.env.NODE_OPTIONS = ${JSON.stringify('--require ' + JSON.stringify(resolverPreload.replace(/\\/g, '/')))};` : ''}
    const result = recordJevShadow({ point: 'model-routing', state: { task: 'fix it' }, questions: ${JSON.stringify(QUESTIONS)}, heuristic: 'sonnet' });
    console.log(JSON.stringify({ result: result ?? null }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [...(hookPreload ? ['--require', hookPreload] : []), '--input-type=module', '-e', script], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`recordJevShadow child exited with ${signal ?? code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()).result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function preload(name, source) {
  const path = join(tmp, name);
  writeFileSync(path, source);
  return path;
}

describe('recordJevShadow with OMC_JEV_LOG_CONTEXT', () => {
  it('passes the hook ids to the resolver line and never to Jev', async () => {
    const stub = await startStub({ route: { type: 'choice', choice: 'opus' } });
    const dir = freshDir();
    const result = await runRecord({ cwd: dir, env: baseEnv(dir, { OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_LOG_DIR: join(dir, 'log'), OMC_JEV_LOG_CONTEXT: '1' }) });
    expect(result).toMatchObject({ mode: 'active', answer: { choice: 'opus' }, request_id: expect.stringMatching(UUID) });
    const [line] = readLines(join(dir, 'log', 'shadow.jsonl'));
    expect(line).toMatchObject({
      point: 'model-routing',
      tool_use_id: 'toolu_01',
      session_id: 'session-1',
      cwd: '/work/project',
      agent_id: 'agent-7',
      agent_type: 'executor',
      request_id: result.request_id,
    });
    expect(stub.bodies).toHaveLength(1);
    for (const id of ['toolu_01', 'session-1', '/work/project', result.request_id]) expect(stub.bodies[0]).not.toContain(id);
  }, 60_000);

  it('uses the working directory as cwd when the hook input has none', async () => {
    const stub = await startStub({ route: { type: 'choice', choice: 'opus' } });
    const dir = freshDir();
    await runRecord({ cwd: dir, input: { session_id: 'session-2' }, env: baseEnv(dir, { OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_LOG_DIR: join(dir, 'log'), OMC_JEV_LOG_CONTEXT: '1' }) });
    const [line] = readLines(join(dir, 'log', 'shadow.jsonl'));
    expect(line.session_id).toBe('session-2');
    expect(realpathSync(line.cwd)).toBe(realpathSync(dir));
  }, 60_000);

  it('without the variable sends and logs exactly what dev does', async () => {
    const stub = await startStub({ route: { type: 'choice', choice: 'opus', confidence: 0.8 } });
    const dir = freshDir();
    const result = await runRecord({ cwd: dir, env: baseEnv(dir, { OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_LOG_DIR: join(dir, 'log') }) });
    expect(Object.keys(result)).toEqual(['mode', 'answer', 'answers', 'confidence', 'durationMs']);
    const [line] = readLines(join(dir, 'log', 'shadow.jsonl'));
    expect(Object.keys(line)).toEqual(DEV_LINE_KEYS);
  }, 60_000);

  it('writes a degraded line and cleans up its temp directory when the resolver cannot be spawned', async () => {
    const dir = freshDir();
    const observedPath = join(dir, 'spawn-observed.json');
    const failSpawn = preload('spawn-error.cjs', `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const { dirname } = require('node:path');
      const real = cp.spawnSync;
      cp.spawnSync = function (file, args, options) {
        if (Array.isArray(args) && args.some((arg) => String(arg).endsWith('jev-resolve.mjs'))) {
          const requestFile = args[args.indexOf('--request-file') + 1];
          const tempDir = dirname(requestFile);
          fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({
            tempDir,
            directoryExisted: fs.statSync(tempDir).isDirectory(),
            request: JSON.parse(fs.readFileSync(requestFile, 'utf8')),
          }));
          return { error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), status: null, signal: null, stdout: '', stderr: '', pid: 0, output: null };
        }
        return real.apply(this, arguments);
      };
    `);
    const result = await runRecord({ cwd: dir, hookPreload: failSpawn, env: baseEnv(dir, { OMC_JEV_ENDPOINT: 'http://127.0.0.1:1', OMC_JEV_LOG_DIR: join(dir, 'log'), OMC_JEV_LOG_CONTEXT: '1' }) });
    expect(result).toBeNull();
    const observed = JSON.parse(readFileSync(observedPath, 'utf8'));
    expect(observed.directoryExisted).toBe(true);
    expect(observed.request).toMatchObject({ point: 'model-routing', state: { task: 'fix it' } });
    expect(existsSync(observed.tempDir)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.startsWith('omc-jev-'))).toEqual([]);
    const lines = readLines(join(dir, 'log', 'shadow.jsonl'));
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'point', 'tool_use_id', 'session_id', 'cwd', 'agent_id', 'agent_type', 'request_id', 'mode', 'reason', 'durationMs']);
    expect(lines[0]).toMatchObject({ point: 'model-routing', session_id: 'session-1', request_id: expect.stringMatching(UUID), mode: 'degraded', reason: 'resolver-spawn' });
    expect(lines[0].request_id).toBe(observed.request.context.request_id);
  }, 60_000);

  it('rotates shadow.jsonl before its own line with OMC_JEV_LOG_MAX_MB', async () => {
    const dir = freshDir();
    mkdirSync(join(dir, 'log'), { recursive: true });
    const before = (JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', point: 'intent', mode: 'shadow', pad: 'x'.repeat(80) }) + '\n').repeat(12_000);
    writeFileSync(join(dir, 'log', 'shadow.jsonl'), before);
    const exit = preload('exit-6.cjs', 'process.exit(6);\n');
    await runRecord({ cwd: dir, resolverPreload: exit, env: baseEnv(dir, { OMC_JEV_ENDPOINT: 'http://127.0.0.1:1', OMC_JEV_LOG_DIR: join(dir, 'log'), OMC_JEV_LOG_CONTEXT: '1', OMC_JEV_LOG_MAX_MB: '1' }) });
    const rotated = readdirSync(join(dir, 'log')).filter((name) => /^shadow-\d{8}-\d{6}-\d+\.jsonl$/.test(name));
    expect(rotated).toHaveLength(1);
    expect(readFileSync(join(dir, 'log', rotated[0]), 'utf8')).toBe(before);
    expect(readLines(join(dir, 'log', 'shadow.jsonl'))).toEqual([expect.objectContaining({ reason: 'resolver-exit', status: 6 })]);
  }, 60_000);

  it('writes a degraded line when the hook kills the resolver at its time limit', async () => {
    const dir = freshDir();
    const hang = preload('hang.cjs', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);\n');
    const result = await runRecord({ cwd: dir, resolverPreload: hang, env: baseEnv(dir, { OMC_JEV_ENDPOINT: 'http://127.0.0.1:1', OMC_JEV_TIMEOUT_MS: '100', OMC_JEV_LOG_DIR: join(dir, 'log'), OMC_JEV_LOG_CONTEXT: '1' }) });
    expect(result).toBeNull();
    const [line] = readLines(join(dir, 'log', 'shadow.jsonl'));
    expect(line).toMatchObject({ mode: 'degraded', reason: 'resolver-timeout', signal: expect.any(String) });
    expect(line.durationMs).toBeGreaterThanOrEqual(500);
  }, 60_000);

  it('puts the degraded line in the default log directory when OMC_JEV_LOG_DIR is unset', async () => {
    const dir = freshDir();
    const stateDir = join(dir, 'state-root');
    const exit = preload('exit-4.cjs', 'process.exit(4);\n');
    await runRecord({ cwd: dir, resolverPreload: exit, env: baseEnv(dir, { OMC_JEV_ENDPOINT: 'http://127.0.0.1:1', OMC_STATE_DIR: stateDir, OMC_JEV_LOG_CONTEXT: '1' }) });
    // A directory outside git: the state root is OMC_STATE_DIR/non-git.
    const [line] = readLines(join(stateDir, 'non-git', 'state', 'jev', 'shadow.jsonl'));
    expect(line).toMatchObject({ mode: 'degraded', reason: 'resolver-exit' });
  }, 60_000);

  it('writes no line of its own without the variable', async () => {
    const dir = freshDir();
    const exit = preload('exit-5.cjs', 'process.exit(5);\n');
    const result = await runRecord({ cwd: dir, resolverPreload: exit, env: baseEnv(dir, { OMC_JEV_ENDPOINT: 'http://127.0.0.1:1', OMC_JEV_LOG_DIR: join(dir, 'log') }) });
    expect(result).toBeNull();
    expect(existsSync(join(dir, 'log', 'shadow.jsonl'))).toBe(false);
  }, 60_000);
});
