import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetJevResolverState, resolveJudgment } from '../resolver.js';
import type { JevQuestions } from '../types.js';

const ENV_KEYS = ['TYPESAFE_API_KEY', 'OMC_JEV', 'OMC_JEV_LOG_DIR', 'OMC_JEV_LOG_CONTEXT', 'OMC_JEV_ENDPOINT', 'OMC_JEV_QUIET', 'OMC_JEV_MAX_RPM', 'OMC_JEV_BREAKER_DIR'] as const;
const QUESTIONS: JevQuestions = {
  route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
  effort: { type: 'score', criteria: { low: 'low', high: 'high' } },
};
const HOOK_INPUT = { session_id: 'session-1', tool_use_id: 'toolu_01', cwd: '/work/project', prompt: 'not an id' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  logDir = await mkdtemp(join(tmpdir(), 'jev-log-context-test-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.OMC_JEV = 'model-routing';
  process.env.OMC_JEV_LOG_DIR = logDir;
  process.env.OMC_JEV_QUIET = '1';
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(logDir, { recursive: true, force: true });
});

function fetchAnswering(answers: Record<string, unknown>): { fn: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fn = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body));
    return { ok: true, status: 200, json: async () => ({ answers }) };
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

async function readLines(): Promise<Record<string, unknown>[]> {
  return (await readFile(join(logDir, 'shadow.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

describe('resolver shadow-log line with OMC_JEV_LOG_CONTEXT', () => {
  it('without the variable logs no ids and the fallback answer as jev, as before', async () => {
    const { fn } = fetchAnswering({ effort: { type: 'score', score: 3, confidence: 0.4 } });
    await resolveJudgment({ point: 'model-routing', state: { task: 'x' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: fn, logContext: HOOK_INPUT });
    const [line] = await readLines();
    expect(Object.keys(line)).toEqual(['ts', 'point', 'mode', 'state', 'heuristic', 'jev', 'answers', 'confidence', 'durationMs']);
    expect(line.jev).toEqual({ type: 'score', score: 3, confidence: 0.4 });
  });

  it('with the variable logs the ids after point and a request_id, never sends them', async () => {
    process.env.OMC_JEV_LOG_CONTEXT = '1';
    const { fn, bodies } = fetchAnswering({ route: { type: 'choice', choice: 'opus', confidence: 0.9 } });
    await resolveJudgment({ point: 'model-routing', state: { task: 'x' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: fn, logContext: HOOK_INPUT });
    const [line] = await readLines();
    expect(Object.keys(line).slice(0, 6)).toEqual(['ts', 'point', 'tool_use_id', 'session_id', 'cwd', 'request_id']);
    expect(line).toMatchObject({ session_id: 'session-1', tool_use_id: 'toolu_01', cwd: '/work/project', request_id: expect.stringMatching(UUID), jev: { choice: 'opus' }, confidence: 0.9 });
    for (const id of ['session-1', 'toolu_01', '/work/project', String(line.request_id)]) expect(bodies[0]).not.toContain(id);
  });

  it('with the variable logs jev null when Jev skipped the first question, and the twin still decides in shadow', async () => {
    process.env.OMC_JEV_LOG_CONTEXT = 'true';
    const { fn } = fetchAnswering({ effort: { type: 'score', score: 3, confidence: 0.4 } });
    const result = await resolveJudgment({ point: 'model-routing', state: { task: 'x' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: fn });
    const [line] = await readLines();
    expect(line.jev).toBeNull();
    expect(line).not.toHaveProperty('confidence');
    expect(line.request_id).toMatch(UUID);
    expect(result).toEqual({ answer: 'sonnet', source: 'twin', mode: 'shadow' });
  });

  it('with the variable logs a degraded line with the ids', async () => {
    process.env.OMC_JEV_LOG_CONTEXT = '1';
    const failing = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await resolveJudgment({ point: 'model-routing', state: { task: 'x' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: failing, logContext: { sessionId: 'session-2' } });
    const [line] = await readLines();
    expect(line).toMatchObject({ mode: 'degraded', session_id: 'session-2', request_id: expect.stringMatching(UUID), jev: null });
  });

  it('logs a call held back by the shared request limit with its ids', async () => {
    const left = 60_000 - (Date.now() % 60_000);
    if (left < 3000) await new Promise((resolve) => setTimeout(resolve, left + 50));
    process.env.OMC_JEV_LOG_CONTEXT = '1';
    process.env.OMC_JEV_MAX_RPM = '1';
    process.env.OMC_JEV_BREAKER_DIR = join(logDir, 'breaker');
    const { fn } = fetchAnswering({ route: { type: 'choice', choice: 'opus' } });
    const judge = () => resolveJudgment({ point: 'model-routing', state: { task: 'x' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: fn, logContext: HOOK_INPUT });
    expect((await judge()).mode).toBe('shadow');
    expect((await judge()).mode).toBe('cap');
    const line = (await readLines()).pop();
    expect(line).toMatchObject({ mode: 'cap', tool_use_id: 'toolu_01', session_id: 'session-1', request_id: expect.stringMatching(UUID), jev: null });
  });
});
