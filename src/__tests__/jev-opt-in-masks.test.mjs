/* global process */
/**
 * The opt-in masks of the Jev points on the script side: OMC_JEV_COMPACT_PRIVATE_PATHS (the state that is sent and
 * logged, and the cwd of every log line that carries the hook context) and OMC_JEV_MASK_PROSE (the state), through
 * resolveRequest of scripts/jev-resolve.mjs and through a hook process that uses scripts/lib/jev-shadow.mjs. Every
 * path and value is invented.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { jevLogContextOf, resolveRequest } from '../../scripts/jev-resolve.mjs';
import { jevLogContextOf as tsJevLogContextOf } from '../hooks/jev/resolver.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const JEV_SHADOW_URL = pathToFileURL(join(root, 'scripts', 'lib', 'jev-shadow.mjs')).href;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'jev-opt-in-masks-')));
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
const linesOf = (dir, file) => readFileSync(join(dir, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

const M = '[private path]';
const LISTED = '/vol/acme-ledger';
const QUESTIONS = { route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } } };
const STATE = { task: `sum ${LISTED}/may.csv`, note: 'password Abc12345' };
const SWITCHES = { OMC_JEV_COMPACT_PRIVATE_PATHS: LISTED, OMC_JEV_MASK_PROSE: '1' };
const CONTEXT = { session_id: 'session-1', cwd: `${LISTED}/work` };
const request = { point: 'model-routing', state: STATE, questions: QUESTIONS, heuristic: 'sonnet', context: CONTEXT };

function envFor(dir, overrides = {}) {
  return { TYPESAFE_API_KEY: 'test-key', OMC_JEV: 'model-routing:active', OMC_JEV_LOG_DIR: dir, OMC_JEV_LOG_CONTEXT: '1', ...overrides };
}

function recordingFetch() {
  const bodies = [];
  const fn = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ answers: { route: { type: 'choice', choice: 'opus' } } }) };
  };
  return { fn, bodies };
}

describe('resolveRequest with the opt-in masks', () => {
  it('sends and logs the state and the cwd as before without them', async () => {
    const dir = freshDir();
    const { fn, bodies } = recordingFetch();
    await resolveRequest(request, envFor(dir), fn);
    expect(bodies[0].state).toEqual(STATE);
    const [line] = linesOf(dir, 'shadow.jsonl');
    expect(line.state).toEqual(STATE);
    expect(line.cwd).toBe(CONTEXT.cwd);
  });

  it('hides listed paths and prose secrets in what is sent and logged', async () => {
    const dir = freshDir();
    const { fn, bodies } = recordingFetch();
    const result = await resolveRequest(request, envFor(dir, SWITCHES), fn);
    expect(result.mode).toBe('active');
    expect(bodies[0].state).toEqual({ task: `sum ${M}`, note: 'password ***' });
    const [line] = linesOf(dir, 'shadow.jsonl');
    expect(line.state).toEqual({ task: `sum ${M}`, note: 'password ***' });
    expect(line.cwd).toBe(M);
    expect(readFileSync(join(dir, 'shadow.jsonl'), 'utf8')).not.toMatch(/acme-ledger|Abc12345/);
  });

  it('switches each of the two on by its own variable', async () => {
    const dir = freshDir();
    const { fn, bodies } = recordingFetch();
    await resolveRequest(request, envFor(dir, { OMC_JEV_COMPACT_PRIVATE_PATHS: LISTED }), fn);
    await resolveRequest(request, envFor(dir, { OMC_JEV_MASK_PROSE: '1' }), fn);
    expect(bodies.map((body) => body.state)).toEqual([
      { task: `sum ${M}`, note: STATE.note },
      { task: STATE.task, note: 'password ***' },
    ]);
  });

  it('sends nothing when the private paths cannot be applied', async () => {
    const dir = freshDir();
    const { fn, bodies } = recordingFetch();
    const env = envFor(dir, { OMC_JEV_LOG_CONTEXT: '0', OMC_JEV_QUIET: '1' });
    Object.defineProperty(env, 'OMC_JEV_COMPACT_PRIVATE_PATHS', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    const result = await resolveRequest(request, env, fn);
    expect(result.mode).toBe('degraded');
    expect(bodies).toHaveLength(0);
    expect(linesOf(dir, 'shadow.jsonl')[0].state).toBe('[state not sent: mask failed]');
  });

  it.each([['scripts', jevLogContextOf], ['TypeScript', tsJevLogContextOf]])(
    'jevLogContextOf (%s) hides cwd, and only cwd, before the cut',
    (_channel, contextOf) => {
      const source = { cwd: `${'/x'.repeat(496)} ${LISTED}/a`, session_id: LISTED };
      expect(contextOf(source, {}).cwd).toBe(source.cwd.slice(0, 1000));
      const hidden = contextOf(source, SWITCHES);
      expect(hidden.cwd).toBe(`${'/x'.repeat(496)} ${M}`.slice(0, 1000));
      expect(hidden.cwd).not.toContain('acme');
      expect(hidden.session_id).toBe(LISTED);
    },
  );
});

/** A local Jev stub: answers every request, keeps the bodies. */
async function startStub() {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { route: { type: 'choice', choice: 'opus' } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  afterHooks.push(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: 'http://127.0.0.1:' + server.address().port, bodies };
}

/**
 * What a hook script does: setJevHookContext(input), one active recordJevShadow call, one recordJevApplied. With
 * `exit`, the resolver child ends at once with that status, so the hook writes the degraded line itself.
 */
function runHook({ cwd, env, input, exit }) {
  const preload = exit === undefined ? undefined : join(cwd, 'exit.cjs');
  if (preload) writeFileSync(preload, `process.exit(${exit});\n`);
  const script = `
    import { recordJevApplied, recordJevShadow, setJevHookContext } from ${JSON.stringify(JEV_SHADOW_URL)};
    await setJevHookContext(${JSON.stringify(input)});
    ${preload ? `process.env.NODE_OPTIONS = ${JSON.stringify('--require ' + JSON.stringify(preload.replace(/\\/g, '/')))};` : ''}
    recordJevShadow({ point: 'model-routing', state: ${JSON.stringify(STATE)}, questions: ${JSON.stringify(QUESTIONS)}, heuristic: 'sonnet' });
    recordJevApplied('model-routing', { from: 'sonnet', to: 'opus' });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`hook child exited with ${code}: ${stderr}`))));
  });
}

function hookEnv(home, endpoint, overrides) {
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
    OMC_JEV_ENDPOINT: endpoint,
    OMC_JEV_LOG_DIR: join(home, 'log'),
    OMC_JEV_LOG_CONTEXT: '1',
    OMC_JEV_APPLIED_LOG: '1',
    ...overrides,
  };
}

describe('a hook process with the opt-in masks', () => {
  it('writes the same cwd and sends the same state as before without them', async () => {
    const stub = await startStub();
    const dir = freshDir();
    await runHook({ cwd: dir, env: hookEnv(dir, stub.endpoint), input: CONTEXT });
    expect(JSON.parse(stub.bodies[0]).state).toEqual(STATE);
    expect(linesOf(join(dir, 'log'), 'shadow.jsonl')[0].cwd).toBe(CONTEXT.cwd);
    expect(linesOf(join(dir, 'log'), 'applied.jsonl')[0].cwd).toBe(CONTEXT.cwd);
  }, 60_000);

  it('hides the listed paths in the request, the resolver line and the applied line', async () => {
    const stub = await startStub();
    const dir = freshDir();
    await runHook({ cwd: dir, env: hookEnv(dir, stub.endpoint, SWITCHES), input: CONTEXT });
    expect(JSON.parse(stub.bodies[0]).state).toEqual({ task: `sum ${M}`, note: 'password ***' });
    for (const file of ['shadow.jsonl', 'applied.jsonl']) {
      expect(linesOf(join(dir, 'log'), file)[0].cwd, file).toBe(M);
      expect(readFileSync(join(dir, 'log', file), 'utf8'), file).not.toMatch(/acme-ledger|Abc12345/);
    }
  }, 60_000);

  it('hides the process directory that stands in for a missing cwd, also on the line it writes for a failed resolver', async () => {
    const dir = freshDir();
    const work = join(dir, 'secret-project');
    mkdirSync(work);
    const env = hookEnv(dir, 'http://127.0.0.1:1', { OMC_JEV_COMPACT_PRIVATE_PATHS: work });
    await runHook({ cwd: work, env, input: { session_id: 'session-2' }, exit: 7 });
    const [shadow] = linesOf(join(dir, 'log'), 'shadow.jsonl');
    expect(shadow).toMatchObject({ reason: 'resolver-exit', cwd: M });
    expect(linesOf(join(dir, 'log'), 'applied.jsonl')[0].cwd).toBe(M);
  }, 60_000);
});
