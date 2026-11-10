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
    ? { iteration_progress: { type: 'score', score: 2, confidence: 0.7 } }
    : { task_complete: { type: 'noul', noul: false, confidence: 0.8 } };
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
      expect(body.state.continuation_excerpt).toBe(TWIN.message);
    }
    expect(bodies.map((b) => Object.values(b.questions)[0].type).sort()).toEqual(['noul', 'score']);

    const lines = await readLogLines();
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as {
      point: string;
      mode: string;
      heuristic: boolean | number | null;
      jev: { type: string } | null;
    });
    // heuristics are extracted by mapHeuristic: 
    // - noul=!shouldBlock (task complete question)
    // - score=null (no reliable progress data, make non-comparable)
    // logs may be written in any order since both are async (non-blocking points)
    const noulEntry = parsed.find((e) => e.jev?.type === 'noul')!;
    const scoreEntry = parsed.find((e) => e.jev?.type === 'score')!;
    expect(noulEntry.point).toBe('loop-continuation');
    expect(noulEntry.mode).toBe('shadow');
    expect(noulEntry.heuristic).toBe(false); // !shouldBlock
    expect(scoreEntry.point).toBe('loop-continuation');
    expect(scoreEntry.mode).toBe('shadow');
    expect(scoreEntry.heuristic).toBeNull(); // No reliable progress data
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
    const parsed = lines.map((line) => JSON.parse(line) as { mode: string; heuristic: boolean | number | null; jev: unknown });
    // heuristics are extracted by mapHeuristic: [!shouldBlock (noul), null (score)]
    // logs may be written in any order since both are async (non-blocking points)
    // but degraded logs will have jev:null, so we can't use jev.type to distinguish
    // Instead, check that we have the right heuristics regardless of order
    expect(parsed).toHaveLength(2);
    expect(new Set(parsed.map((e) => e.heuristic))).toEqual(new Set([false, null]));
    for (const entry of parsed) {
      expect(entry.mode).toBe('degraded');
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

  it('makes task-complete non-comparable when team pipeline fails/cancels (shouldBlock=false but not task complete)', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    const { fetchFn, calls } = stubFetch();
    
    // Team pipeline failure: shouldBlock=false (allow stopping) but task is NOT complete
    const teamFailed: PersistentModeResult = {
      shouldBlock: false,
      message: '[TEAM] Pipeline failed; allowing stop for recovery',
      mode: 'team',
      metadata: { iteration: 3, maxIterations: 10 },
    };
    const result = await applyLoopContinuationShadow({ result: teamFailed, sessionId: 'sess-1', fetchFn });

    expect(result).toEqual(teamFailed);
    expect(calls).toHaveLength(2);

    const lines = await readLogLines();
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as { point: string; jev: { type: string } | null; heuristic: boolean | null });
    
    // When team mode fails/cancels, the noul (task complete) heuristic should be null
    // not !shouldBlock (which would be true), because shouldBlock=false here means
    // "stop for safety" not "task is complete"
    const noulEntry = parsed.find((e) => e.jev?.type === 'noul')!;
    expect(noulEntry.heuristic).toBeNull();
  });

  it('makes task-complete non-comparable when ralplan circuit breaker trips (shouldBlock=false but not task complete)', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    const { fetchFn, calls } = stubFetch();
    
    // Ralplan circuit breaker: shouldBlock=false (allow stopping) but task is NOT complete
    const ralplanTripped: PersistentModeResult = {
      shouldBlock: false,
      message: '[RALPLAN] Circuit breaker tripped; allowing stop for recovery',
      mode: 'ralplan',
      metadata: { iteration: 5, maxIterations: 10, phase: 'execution' },
    };
    const result = await applyLoopContinuationShadow({ result: ralplanTripped, sessionId: 'sess-1', fetchFn });

    expect(result).toEqual(ralplanTripped);

    const lines = await readLogLines();
    const parsed = lines.map((line) => JSON.parse(line) as { jev: { type: string } | null; heuristic: boolean | null });
    const noulEntry = parsed.find((e) => e.jev?.type === 'noul')!;
    // Ralplan safety release should be non-comparable, not "task complete"
    expect(noulEntry.heuristic).toBeNull();
  });

  it('makes task-complete non-comparable when autoresearch fails/cancels (shouldBlock=false but not task complete)', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    const { fetchFn, calls } = stubFetch();
    
    // Autoresearch failure: shouldBlock=false (allow stopping) but task is NOT complete
    const autoresearchFailed: PersistentModeResult = {
      shouldBlock: false,
      message: '[AUTORESEARCH] Mission failed; allowing stop',
      mode: 'autoresearch',
      metadata: { iteration: 2, maxIterations: 5, phase: 'research' },
    };
    const result = await applyLoopContinuationShadow({ result: autoresearchFailed, sessionId: 'sess-1', fetchFn });

    expect(result).toEqual(autoresearchFailed);

    const lines = await readLogLines();
    const parsed = lines.map((line) => JSON.parse(line) as { jev: { type: string } | null; heuristic: boolean | null });
    const noulEntry = parsed.find((e) => e.jev?.type === 'noul')!;
    // Autoresearch safety release should be non-comparable, not "task complete"
    expect(noulEntry.heuristic).toBeNull();
  });

  it.each(['ralph', 'todo-continuation', 'autopilot', 'skill-active'] as const)(
    'never infers task completion from a %s release',
    async (mode) => {
      process.env.TYPESAFE_API_KEY = 'test-key-123';
      process.env.OMC_JEV = 'loop-continuation';
      const { fetchFn } = stubFetch();
      const released: PersistentModeResult = {
        shouldBlock: false,
        message: `[${mode}] diagnostic release`,
        mode,
        metadata: { iteration: 1 },
      };

      await applyLoopContinuationShadow({ result: released, sessionId: 'sess-1', fetchFn });

      const parsed = (await readLogLines()).map((line) => JSON.parse(line) as { jev: { type: string } | null; heuristic: boolean | null });
      expect(parsed.find((e) => e.jev?.type === 'noul')!.heuristic).toBeNull();
    },
  );

  it('logs a blocked stop as an explicit not-complete judgment', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    const { fetchFn } = stubFetch();
    const blocked: PersistentModeResult = {
      shouldBlock: true,
      message: '[AUTOPILOT] keep going',
      mode: 'autopilot',
      metadata: { iteration: 2 },
    };

    await applyLoopContinuationShadow({ result: blocked, sessionId: 'sess-1', fetchFn });

    const parsed = (await readLogLines()).map((line) => JSON.parse(line) as { jev: { type: string } | null; heuristic: boolean | null });
    expect(parsed.find((e) => e.jev?.type === 'noul')!.heuristic).toBe(false);
  });
});

describe('applyLoopContinuationShadow active mode reads Noul as a probability', () => {
  function noulFetch(noul: number | boolean): typeof fetch {
    return captureFetch((body) => {
      const { questions } = JSON.parse(body) as { questions: Record<string, unknown> };
      const name = Object.keys(questions)[0];
      const answers = name === 'iteration_progress'
        ? { iteration_progress: { type: 'score', score: 2, confidence: 0.7 } }
        : { task_complete: { type: 'noul', noul, confidence: 0.8 } };
      return { ok: true, status: 200, json: async () => ({ answers }) } as unknown as Response;
    }).fetchFn;
  }

  async function activeResult(noul: number | boolean) {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation:active';
    return applyLoopContinuationShadow({ result: TWIN, sessionId: 'sess-1', fetchFn: noulFetch(noul) });
  }

  it.each([0.5, 0.9, 1, true])('releases the stop when the answer is %s', async (noul) => {
    const result = await activeResult(noul);
    expect(result.shouldBlock).toBe(false);
    expect(result.message).toContain('[jev-completion]');
  });

  it.each([0, 0.49, 0.1, false])('keeps the twin decision when the answer is %s', async (noul) => {
    const result = await activeResult(noul);
    expect(result).toEqual(TWIN);
  });

  it('keeps the twin decision in shadow mode whatever the answer is', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    const result = await applyLoopContinuationShadow({ result: TWIN, sessionId: 'sess-1', fetchFn: noulFetch(0.99) });
    expect(result).toBe(TWIN);
  });
});

describe('applyLoopContinuationShadow excerpt limit', () => {
  it('sends up to 2000 characters of the continuation message by default, whatever OMC_JEV_EXCERPT_CHARS is', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'loop-continuation';
    process.env.OMC_JEV_EXCERPT_CHARS = '50';
    const { fetchFn, calls } = stubFetch();
    await applyLoopContinuationShadow({ result: { ...TWIN, message: 'm'.repeat(2500) }, sessionId: 'sess-1', fetchFn });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const body = JSON.parse(call.body) as { state: Record<string, unknown> };
      expect(body.state.continuation_excerpt).toBe('m'.repeat(2000));
    }
  });
});
