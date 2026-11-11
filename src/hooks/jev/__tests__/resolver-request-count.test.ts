/**
 * OMC_JEV_MAX_REQUESTS (the per-process cap) next to the opt-in shared request
 * limit OMC_JEV_MAX_RPM, for calls that run at the same time: a call is
 * counted by the cap only when the shared limit admitted it, and a call the cap
 * rejects reserves nothing of the shared limit.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { breakerSettings, reserveRequest } from '../../../../scripts/lib/jev-breaker.mjs';
import { resetJevResolverState, resolveJudgment } from '../resolver.js';
import type { JevQuestions } from '../types.js';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_MAX_REQUESTS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
  'OMC_JEV_BREAKER',
  'OMC_JEV_MAX_RPM',
  'OMC_JEV_BREAKER_DIR',
] as const;

const ENDPOINT = 'http://127.0.0.1:9/v1/systemone';
const ROUTE: JevQuestions = {
  route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
};
const SLOP: JevQuestions = {
  slop_advisory: { type: 'noul', criteria: { yes: 'advisory', no: 'plain' } },
};

let dir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  dir = await mkdtemp(join(tmpdir(), 'jev-request-count-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.OMC_JEV = 'model-routing,slop-warning';
  process.env.OMC_JEV_LOG_DIR = join(dir, 'log');
  process.env.OMC_JEV_BREAKER_DIR = join(dir, 'breaker');
  process.env.OMC_JEV_ENDPOINT = ENDPOINT;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(dir, { recursive: true, force: true });
});

/** Per-minute counts must not straddle a UTC minute: start in the first part of one. */
async function startOfMinute(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5000) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

function counting(): { fetchFn: typeof fetch; count: () => number } {
  let n = 0;
  const fetchFn = (async (_url: unknown, init: { body?: string } | undefined) => {
    n += 1;
    const asked = JSON.parse(init?.body ?? '{}') as { questions?: Record<string, unknown> };
    const answer = asked.questions && 'route' in asked.questions
      ? { route: { type: 'choice', choice: 'opus' } }
      : { slop_advisory: { type: 'noul', noul: false, confidence: 0.9 } };
    return { ok: true, status: 200, json: async () => ({ answers: answer }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, count: () => n };
}

function route(fetchFn: typeof fetch) {
  return resolveJudgment({ point: 'model-routing', state: { task: 'x' }, questions: ROUTE, twin: () => 'sonnet', fetchFn });
}

function slop(fetchFn: typeof fetch) {
  return resolveJudgment({ point: 'slop-warning', state: { tool: 'Bash' }, questions: SLOP, twin: () => false, fetchFn });
}

function sharedSettings() {
  const settings = breakerSettings(process.env, ENDPOINT, 'test-key');
  if (!settings) throw new Error('shared settings expected');
  return settings;
}

describe('OMC_JEV_MAX_REQUESTS with the shared request limit, for calls that run at the same time', () => {
  it('a call the process cap rejects reserves no slot of the shared per-minute limit', async () => {
    await startOfMinute();
    process.env.OMC_JEV_MAX_REQUESTS = '1';
    process.env.OMC_JEV_MAX_RPM = '3';
    const { fetchFn, count } = counting();
    const results = await Promise.all([route(fetchFn), route(fetchFn), route(fetchFn)]);
    expect(count()).toBe(1);
    expect(results.map((result) => result.mode).sort()).toEqual(['cap', 'cap', 'shadow']);
    // One slot went to the request that was sent; two of the three remain for other callers on the machine.
    const settings = sharedSettings();
    expect(reserveRequest(settings, 'model-routing').ok).toBe(true);
    expect(reserveRequest(settings, 'model-routing').ok).toBe(true);
    expect(reserveRequest(settings, 'model-routing').ok).toBe(false);
  });

  it.each(['low first', 'high first'])('a low-priority call the shared limit holds back does not use the process cap of a call that runs with it (%s)', async (order) => {
    await startOfMinute();
    process.env.OMC_JEV_MAX_REQUESTS = '1';
    process.env.OMC_JEV_MAX_RPM = '10';
    const settings = sharedSettings();
    // Six reservations of the minute: the threshold of a low-priority point (6) is reached, the limit of 10 is not.
    for (let i = 0; i < 6; i += 1) expect(reserveRequest(settings, 'model-routing').ok).toBe(true);
    const { fetchFn, count } = counting();
    const lowFirst = order === 'low first';
    const started = lowFirst ? [slop(fetchFn), route(fetchFn)] : [route(fetchFn), slop(fetchFn)];
    const [first, second] = await Promise.all(started);
    const [low, high] = lowFirst ? [first, second] : [second, first];
    expect(low.mode).toBe('cap');
    expect(high.mode).toBe('shadow');
    expect(count()).toBe(1);
  });
});
