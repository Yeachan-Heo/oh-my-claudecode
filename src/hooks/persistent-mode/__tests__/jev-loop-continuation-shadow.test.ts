import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetJevResolverState } from '../../jev/index.js';
import { applyLoopContinuationShadow } from '../jev-shadow.js';
import type { PersistentModeResult } from '../index.js';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_TIMEOUT_MS',
  'OMC_JEV_MAX_REQUESTS',
  'OMC_JEV_EXCERPT_CHARS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
] as const;

const TWIN: PersistentModeResult = {
  shouldBlock: true,
  message: '[RALPH - ITERATION 2/10]\nThe task is NOT complete yet. Continue working.',
  mode: 'ralph',
  metadata: { iteration: 2, maxIterations: 10 },
};

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  logDir = await mkdtemp(join(tmpdir(), 'jev-loop-test-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OMC_JEV_LOG_DIR = logDir;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(logDir, { recursive: true, force: true });
});

function jevResponse(questionName: string): Response {
  const answers: Record<string, unknown> = questionName === 'iteration_progress'
    ? { iteration_progress: { type: 'Score', score: 2, confidence: 0.7 } }
    : { task_complete: { type: 'Noul', noul: false, confidence: 0.8 } };
  return { ok: true, status: 200, json: async () => ({ answers }) } as unknown as Response;
}

function captureFetch(handler: (requestBody: string) => Response): { fetchFn: typeof fetch; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const body = (init as RequestInit | undefined)?.body as string;
    calls.push({ url: url as string, body });
    return handler(body);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function readLogLines(): Promise<string[]> {
  const raw = await readFile(join(logDir, 'shadow.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean);
}

/** Stub transport answering with the single question name from the request. */
function stubFetch(): { fetchFn: typeof fetch; calls: Array<{ url: string; body: string }> } {
  return captureFetch((body) => {
    const { questions } = JSON.parse(body) as { questions: Record<string, unknown> };
    return jevResponse(Object.keys(questions)[0]);
  });
}

describe('applyLoopContinuationShadow', () => {
  it('with a key, one decision records shadow lines containing the twin decision and the Jev Noul/Score', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    const { fetchFn, calls } = stubFetch();
    const result = await applyLoopContinuationShadow({ result: TWIN, sessionId: 'sess-1', fetchFn });

    // Twin decides: the returned result is the twin, untouched.
    expect(result).toBe(TWIN);

    // One request per question (Noul, Score); state is iteration metadata only.
    expect(calls).toHaveLength(2);
    const bodies = calls.map((call) => JSON.parse(call.body) as { state: Record<string, unknown>; questions: Record<string, { type: string }> });
    for (const body of bodies) {
      expect(body.state.mode_name).toBe('ralph');
      expect(body.state.session_id).toBe('sess-1');
      expect(body.state.iteration).toBe(2);
      expect(typeof body.state.continuation_excerpt).toBe('string');
      expect(String(body.state.continuation_excerpt).length).toBeLessThanOrEqual(200);
    }
    expect(bodies.map((b) => Object.values(b.questions)[0].type).sort()).toEqual(['Noul', 'Score']);

    const lines = await readLogLines();
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as {
      point: string;
      mode: string;
      heuristic: PersistentModeResult;
      jev: { type: string } | null;
    });
    for (const entry of parsed) {
      expect(entry.point).toBe('loop-continuation');
      expect(entry.mode).toBe('shadow');
      expect(entry.heuristic).toEqual(TWIN);
    }
    expect(parsed.map((entry) => entry.jev?.type).sort()).toEqual(['Noul', 'Score']);
  });

  it('without a key, zero fetch calls and the twin result is returned unchanged', async () => {
    const { fetchFn, calls } = stubFetch();
    const result = await applyLoopContinuationShadow({ result: TWIN, sessionId: 'sess-1', fetchFn });

    expect(result).toEqual(TWIN);
    expect(calls).toHaveLength(0);
    await expect(readLogLines()).rejects.toThrow();
  });

  it('on Jev timeout the twin decision is returned unchanged (degraded path)', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    process.env.OMC_JEV_TIMEOUT_MS = '20';
    const fetchFn = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const result = await applyLoopContinuationShadow({ result: TWIN, sessionId: 'sess-1', fetchFn });

    expect(result).toEqual(TWIN);
    const lines = await readLogLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const entry = JSON.parse(line) as { mode: string; heuristic: PersistentModeResult; jev: unknown };
      expect(entry.mode).toBe('degraded');
      expect(entry.heuristic).toEqual(TWIN);
      expect(entry.jev).toBeNull();
    }
  });

  it('skips the judgment entirely when no persistent mode is active', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    const { fetchFn, calls } = stubFetch();
    const none: PersistentModeResult = { shouldBlock: false, message: '', mode: 'none' };
    const result = await applyLoopContinuationShadow({ result: none, sessionId: 'sess-1', fetchFn });

    expect(result).toBe(none);
    expect(calls).toHaveLength(0);
    await expect(readLogLines()).rejects.toThrow();
  });
});
