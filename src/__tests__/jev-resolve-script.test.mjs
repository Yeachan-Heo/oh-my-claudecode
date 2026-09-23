/* global process */
/**
 * Tests for scripts/jev-resolve.mjs (script-side judgment channel, ticket 15).
 *
 * .mjs so vitest picks it up without tsc typechecking the untyped script.
 * Covers: env-parse tri-state parity with the TS config contract, config
 * gates (zero fetch when off), bounded fetch + validated response, degrade
 * path (HTTP error -> degraded, log jev:null), and the end-to-end channel:
 * a real child process (node scripts/jev-resolve.mjs) fed one JSON request
 * on stdin against a stub endpoint, reading one JSON result on stdout.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { parseJevEnv, resolveRequest, serializeQuestions, validateJevResponse } from '../../scripts/jev-resolve.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const SCRIPT = join(root, 'scripts', 'jev-resolve.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'jev-resolve-test-'));
const afterHooks = [];
function onExit(fn) { afterHooks.push(fn); }
onExit(() => rmSync(tmp, { recursive: true, force: true }));
afterAll(async () => { for (const fn of afterHooks.reverse()) await fn(); });

const QUESTIONS = { route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } } };

function baseEnv(overrides = {}) {
  return {
    TYPESAFE_API_KEY: 'test-key',
    OMC_JEV: 'model-routing',
    OMC_JEV_LOG_DIR: tmp,
    ...overrides,
  };
}

describe('parseJevEnv tri-state parity', () => {
  it('off when the key is absent even with OMC_JEV set', () => {
    expect(parseJevEnv('model-routing', { OMC_JEV: 'model-routing' })).toBe('off');
  });

  it('off when OMC_JEV=off', () => {
    expect(parseJevEnv('model-routing', { TYPESAFE_API_KEY: 'k', OMC_JEV: 'off' })).toBe('off');
  });

  it('shadow for a listed point, off for an unlisted one', () => {
    expect(parseJevEnv('model-routing', baseEnv())).toBe('shadow');
    expect(parseJevEnv('task-size', baseEnv())).toBe('off');
  });

  it('active for point:active, all, and all:active', () => {
    expect(parseJevEnv('model-routing', baseEnv({ OMC_JEV: 'model-routing:active' }))).toBe('active');
    expect(parseJevEnv('task-size', baseEnv({ OMC_JEV: 'all' }))).toBe('shadow');
    expect(parseJevEnv('task-size', baseEnv({ OMC_JEV: 'all:active' }))).toBe('active');
  });
});

describe('wire shape parity with the TS client (#4091)', () => {
  it('serializes score criteria to the ordered list the API requires', () => {
    const wire = serializeQuestions({
      staleness: { type: 'score', criteria: { fresh: 'Fresh', aging: 'Aging', stale: 'Stale' } },
    });
    expect(wire.staleness.criteria).toEqual(['Fresh', 'Aging', 'Stale']);
  });

  it('leaves choice and noul criteria as the named map', () => {
    const wire = serializeQuestions({
      intent: { type: 'noul', criteria: { true: 'yes', false: 'no' } },
    });
    expect(wire.intent.criteria).toEqual({ true: 'yes', false: 'no' });
  });

  it('sends the serialized questions on the wire', async () => {
    let body;
    const fetchFn = async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ answers: { staleness: { type: 'score', score: 2 } } }) };
    };
    await resolveRequest(
      { point: 'context-pruning', state: { p: 'x' }, questions: { staleness: { type: 'score', criteria: { fresh: 'Fresh', stale: 'Stale' } } }, heuristic: 1 },
      baseEnv({ OMC_JEV: 'context-pruning' }),
      fetchFn,
    );
    expect(body.questions.staleness.criteria).toEqual(['Fresh', 'Stale']);
  });
});

describe('validateJevResponse', () => {
  it('accepts a valid answers object and rejects invalid shapes', () => {
    validateJevResponse({ answers: { a: { type: 'choice', choice: 'x' } } });
    expect(() => validateJevResponse(null)).toThrow();
    expect(() => validateJevResponse({ answers: {} })).toThrow();
    expect(() => validateJevResponse({ answers: { a: {} } })).toThrow();
  });
});

describe('resolveRequest', () => {
  it('off: zero fetch, no log', async () => {
    let fetched = false;
    const fetchFn = async () => { fetched = true; };
    const result = await resolveRequest({ point: 'task-size', state: {}, questions: QUESTIONS }, baseEnv(), fetchFn);
    expect(result.mode).toBe('off');
    expect(fetched).toBe(false);
  });

  it('shadow: one fetch, one log line, heuristic preserved', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ answers: { route: { type: 'choice', choice: 'opus' } } }) });
    const result = await resolveRequest({ point: 'model-routing', state: { prompt: 'hi' }, questions: QUESTIONS, heuristic: 'sonnet' }, baseEnv(), fetchFn);
    expect(result.mode).toBe('shadow');
    expect(result.answer).toEqual({ type: 'choice', choice: 'opus' });
    const line = JSON.parse(readFileSync(join(tmp, 'shadow.jsonl'), 'utf8').trim().split('\n').pop());
    expect(line).toMatchObject({ point: 'model-routing', mode: 'shadow', heuristic: 'sonnet', jev: { choice: 'opus' } });
  });

  it('active-by-env: Jev decides (mode active, answer returned)', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ answers: { route: { type: 'choice', choice: 'opus' } } }) });
    const result = await resolveRequest({ point: 'model-routing', state: {}, questions: QUESTIONS }, baseEnv({ OMC_JEV: 'model-routing:active' }), fetchFn);
    expect(result.mode).toBe('active');
    expect(result.answer).toEqual({ type: 'choice', choice: 'opus' });
  });

  it('degrades on HTTP error and logs jev:null', async () => {
    const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await resolveRequest({ point: 'model-routing', state: {}, questions: QUESTIONS }, baseEnv(), fetchFn);
    expect(result.mode).toBe('degraded');
    expect(result.answer).toBeNull();
    const line = JSON.parse(readFileSync(join(tmp, 'shadow.jsonl'), 'utf8').trim().split('\n').pop());
    expect(line.mode).toBe('degraded');
    expect(line.jev).toBeNull();
  });

  it('bounds excerpts before send and log', async () => {
    let body;
    const fetchFn = async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ answers: { route: { type: 'choice', choice: 'x' } } }) }; };
    await resolveRequest({ point: 'model-routing', state: { prompt: 'a'.repeat(500) }, questions: QUESTIONS }, baseEnv({ OMC_JEV_EXCERPT_CHARS: '50' }), fetchFn);
    expect(body.state.prompt).toHaveLength(50);
  });
});

describe('end-to-end child process', () => {
  it('a plain-Node caller feeds stdin JSON to the child and reads the result from stdout', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { route: { type: 'choice', choice: 'opus', confidence: 0.9 } } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    onExit(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;

    const result = await new Promise((resolve, reject) => {
      const child = execFile(NODE, [SCRIPT], {
        env: { ...process.env, TYPESAFE_API_KEY: 'test-key', OMC_JEV: 'model-routing:active', OMC_JEV_ENDPOINT: 'http://127.0.0.1:' + port, OMC_JEV_LOG_DIR: tmp },
      }, (error, stdout) => { if (error) reject(error); else resolve(JSON.parse(stdout)); });
      child.stdin.write(JSON.stringify({ point: 'model-routing', state: { prompt: 'hi' }, questions: QUESTIONS, heuristic: 'sonnet' }));
      child.stdin.end();
    });

    expect(result).toMatchObject({ mode: 'active', answer: { type: 'choice', choice: 'opus' } });
  });
});
