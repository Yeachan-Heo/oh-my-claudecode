import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetJevResolverState, resolveJudgment } from '../resolver.js';
import type { JevAnswer, JevQuestions } from '../types.js';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_TIMEOUT_MS',
  'OMC_JEV_MAX_REQUESTS',
  'OMC_JEV_EXCERPT_CHARS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
] as const;

const QUESTIONS: JevQuestions = {
  route: { type: 'Choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
};

const TWIN = { tier: 'sonnet' };

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  logDir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Strict opt-in (owner review of #4058): a key alone enables nothing;
  // tests that need a point opt in explicitly. Default here = all five.
  process.env.OMC_JEV = 'intent,skill-trigger,loop-continuation,model-routing,context-pruning';
  process.env.OMC_JEV_LOG_DIR = logDir;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(logDir, { recursive: true, force: true });
});

function jevOk(answer: Partial<JevAnswer>): Response {
  return { ok: true, status: 200, json: async () => ({ answers: { route: { type: 'Choice', ...answer } } }) } as unknown as Response;
}

function httpErrorResponse(): Response {
  return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(handler: () => Response): { fetchFn: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    calls.push({ url: url as string, init: init as RequestInit });
    return handler();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function readLog(): Promise<string> {
  return readFile(join(logDir, 'shadow.jsonl'), 'utf8');
}

function call(args: { point: string; state?: unknown; mode?: 'shadow' | 'active'; blocking?: boolean; fetchFn?: typeof fetch; twin?: () => unknown; mapAnswer?: (a: JevAnswer) => unknown }) {
  return resolveJudgment({
    point: args.point,
    state: args.state ?? { prompt: 'hi' },
    questions: QUESTIONS,
    twin: args.twin ?? ((): typeof TWIN => TWIN),
    mapAnswer: args.mapAnswer,
    mode: args.mode,
    blocking: args.blocking,
    fetchFn: args.fetchFn,
  });
}

describe('resolveJudgment', () => {
  it('returns the twin with zero HTTP calls when TYPESAFE_API_KEY is absent', async () => {
    const { fetchFn, calls } = captureFetch(() => jevOk({ choice: 'opus' }));
    const result = await call({ point: 'model-routing', fetchFn });
    expect(result).toEqual({ answer: TWIN, source: 'twin', mode: 'off' });
    expect(calls).toHaveLength(0);
  });

  it('in shadow mode the twin decides and one comparison line is logged', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    const { fetchFn, calls } = captureFetch(() => jevOk({ choice: 'opus', confidence: 0.9 }));
    const result = await call({ point: 'model-routing', fetchFn });
    expect(result).toEqual({ answer: TWIN, source: 'twin', mode: 'shadow' });
    expect(calls).toHaveLength(1);
    const line = JSON.parse(await readLog());
    expect(line).toMatchObject({
      point: 'model-routing',
      mode: 'shadow',
      heuristic: TWIN,
      jev: { type: 'Choice', choice: 'opus', confidence: 0.9 },
      confidence: 0.9,
    });
    expect(typeof line.ts).toBe('string');
    expect(Number.isFinite(new Date(line.ts).getTime())).toBe(true);
    expect(typeof line.durationMs).toBe('number');
  });

  it('in active mode Jev decides, mapAnswer maps the answer, and the twin is preserved in the log', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    const { fetchFn } = captureFetch(() => jevOk({ choice: 'opus', confidence: 0.95 }));
    const result = await call({
      point: 'model-routing',
      mode: 'active',
      fetchFn,
      mapAnswer: (a) => ({ tier: a.choice ?? '' }),
    });
    expect(result).toEqual({ answer: { tier: 'opus' }, source: 'jev', mode: 'active' });
    const line = JSON.parse(await readLog());
    expect(line.mode).toBe('active');
    expect(line.heuristic).toEqual(TWIN);
  });

  it('OMC_JEV=off disables even with a key, and beats a forced mode override', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.OMC_JEV = 'off';
    const { fetchFn, calls } = captureFetch(() => jevOk({ choice: 'x' }));
    const result = await call({ point: 'model-routing', mode: 'active', fetchFn });
    expect(result).toEqual({ answer: TWIN, source: 'twin', mode: 'off' });
    expect(calls).toHaveLength(0);
    await expect(readLog()).rejects.toThrow();
  });

  it('strict opt-in: a key with OMC_JEV unset sends nothing anywhere', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    // OMC_JEV deliberately unset (beforeEach default removed).
    delete process.env.OMC_JEV;
    const { fetchFn, calls } = captureFetch(() => jevOk({ choice: 'x' }));
    const result = await call({ point: 'model-routing', fetchFn });
    expect(result).toEqual({ answer: TWIN, source: 'twin', mode: 'off' });
    expect(calls).toHaveLength(0);
    await expect(readLog()).rejects.toThrow();
  });

  it('OMC_JEV=<points> opt-in enables only listed points', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.OMC_JEV = 'intent';
    const { fetchFn, calls } = captureFetch(() => jevOk({ choice: 'x' }));
    const enabled = await call({ point: 'intent', fetchFn });
    expect(enabled.mode).toBe('shadow');
    const disabled = await call({ point: 'loop-continuation', fetchFn });
    expect(disabled.mode).toBe('off');
    expect(calls).toHaveLength(1);
  });

  it('degrades to the twin on timeout and logs a degraded comparison', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.OMC_JEV_TIMEOUT_MS = '20';
    const fetchFn = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const result = await call({ point: 'model-routing', fetchFn });
    expect(result).toEqual({ answer: TWIN, source: 'twin', mode: 'degraded' });
    const line = JSON.parse(await readLog());
    expect(line.mode).toBe('degraded');
    expect(line.jev).toBeNull();
    expect(line.heuristic).toEqual(TWIN);
  });

  it('degrades to the twin on HTTP error and logs a degraded comparison', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    const { fetchFn, calls } = captureFetch(httpErrorResponse);
    const result = await call({ point: 'model-routing', fetchFn });
    expect(result).toEqual({ answer: TWIN, source: 'twin', mode: 'degraded' });
    expect(calls).toHaveLength(1);
    const line = JSON.parse(await readLog());
    expect(line.mode).toBe('degraded');
    expect(line.jev).toBeNull();
  });

  it('degrades to the twin on an invalid Jev response', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    const { fetchFn } = captureFetch(() => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    const result = await call({ point: 'model-routing', fetchFn });
    expect(result.mode).toBe('degraded');
  });

  it('OMC_JEV_MAX_REQUESTS caps requests for the process', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.OMC_JEV_MAX_REQUESTS = '1';
    const { fetchFn, calls } = captureFetch(() => jevOk({ choice: 'x' }));
    const first = await call({ point: 'model-routing', fetchFn });
    expect(first.mode).toBe('shadow');
    const second = await call({ point: 'model-routing', fetchFn });
    expect(second).toEqual({ answer: TWIN, source: 'twin', mode: 'cap' });
    expect(calls).toHaveLength(1);
    const log = await readLog();
    expect(log.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('opens the circuit after 3 consecutive failures for the rest of the process', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    const { fetchFn, calls } = captureFetch(httpErrorResponse);
    for (let i = 0; i < 3; i++) {
      const result = await call({ point: 'model-routing', fetchFn });
      expect(result.mode).toBe('degraded');
    }
    const fourth = await call({ point: 'model-routing', fetchFn });
    expect(fourth.mode).toBe('circuit-open');
    expect(calls).toHaveLength(3);
  });

  it('a success resets the failure streak before the breaker opens', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    let failing = true;
    const { fetchFn, calls } = captureFetch(() => (failing ? httpErrorResponse() : jevOk({ choice: 'x' })));
    for (let i = 0; i < 2; i++) {
      await call({ point: 'model-routing', fetchFn });
    }
    failing = false;
    const ok = await call({ point: 'model-routing', fetchFn });
    expect(ok.mode).toBe('shadow');
    failing = true;
    const next = await call({ point: 'model-routing', fetchFn });
    expect(next.mode).toBe('degraded');
    expect(calls).toHaveLength(4);
  });

  it('bounds state excerpts to OMC_JEV_EXCERPT_CHARS before sending and logging', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.OMC_JEV_EXCERPT_CHARS = '50';
    const long = 'a'.repeat(500);
    const { fetchFn, calls } = captureFetch(() => jevOk({ choice: 'x' }));
    await call({ point: 'intent', state: { prompt: long, nested: { deep: long }, list: [long] }, fetchFn });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.state.prompt).toHaveLength(50);
    expect(body.state.nested.deep).toHaveLength(50);
    expect(body.state.list[0]).toHaveLength(50);
    const line = JSON.parse(await readLog());
    expect(line.state.prompt).toHaveLength(50);
    expect(line.state.nested.deep).toHaveLength(50);
  });

  it('propagates twin errors instead of masking them', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    const { fetchFn } = captureFetch(() => jevOk({ choice: 'opus' }));
    await expect(
      resolveJudgment({
        point: 'model-routing',
        state: {},
        questions: QUESTIONS,
        twin: () => { throw new Error('twin bug'); },
        fetchFn,
      }),
    ).rejects.toThrow('twin bug');
  });

  it('non-blocking shadow returns the twin immediately and logs when Jev settles', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = (async () => {
      await gate;
      return jevOk({ choice: 'opus' });
    }) as unknown as typeof fetch;
    const pending = call({ point: 'model-routing', blocking: false, fetchFn });
    const result = await pending;
    expect(result).toEqual({ answer: TWIN, source: 'twin', mode: 'shadow' });
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const line = JSON.parse(await readLog());
    expect(line.mode).toBe('shadow');
    expect(line.jev).toEqual({ type: 'Choice', choice: 'opus' });
  });
});
