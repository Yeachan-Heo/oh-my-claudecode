import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTEXT_WARNING_MESSAGE,
  createPreemptiveCompactionHook,
  clearRapidFireDebounce,
} from '../index.js';
import { recordContextPruningShadow } from '../jev-shadow.js';
import type { PruningCandidate } from '../jev-shadow.js';
import { resetJevResolverState } from '../../jev/index.js';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_TIMEOUT_MS',
  'OMC_JEV_MAX_REQUESTS',
  'OMC_JEV_EXCERPT_CHARS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
] as const;

const CANDIDATES: PruningCandidate[] = [
  { tool: 'read', tokens: 1200, excerpt: 'src/index.ts line one' },
];

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  logDir = await mkdtemp(join(tmpdir(), 'jev-pruning-test-'));
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

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(score: number): { fetchFn: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    calls.push({ url: url as string, init: init as RequestInit });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: { staleness: { type: 'Score', score, confidence: 0.8 } },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Poll for the async shadow-log write (blocking: false logs when Jev settles). */
async function readLogLine(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const raw = await readFile(join(logDir, 'shadow.jsonl'), 'utf8');
      const line = raw.split('\n').filter(Boolean)[0];
      if (line) return line;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('shadow log line never appeared');
}

describe('recordContextPruningShadow', () => {
  it('with key set, records a shadow comparison: heuristic action + Jev Score', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'context-pruning';
    const { fetchFn, calls } = captureFetch(3);
    const result = await recordContextPruningShadow({
      action: 'warn',
      totalTokens: 150_000,
      candidates: CANDIDATES,
      fetchFn,
    });

    // Twin decides, in shadow mode.
    expect(result).toEqual({ answer: 'warn', source: 'twin', mode: 'shadow' });
    expect(calls).toHaveLength(1);

    // State sent: metadata + bounded excerpts only.
    const body = JSON.parse(calls[0].init?.body as string) as {
      state: Record<string, unknown>;
      questions: Record<string, { type: string }>;
    };
    expect(body.state).toMatchObject({
      action: 'warn',
      totalTokens: 150_000,
      candidateCount: 1,
      candidates: [{ tool: 'read', tokens: 1200, excerpt: 'src/index.ts line one' }],
    });
    expect(body.questions.staleness.type).toBe('Score');

    const line = JSON.parse(await readLogLine());
    expect(line).toMatchObject({
      point: 'context-pruning',
      mode: 'shadow',
      heuristic: 'warn',
      jev: { type: 'Score', score: 3 },
      confidence: 0.8,
    });
  });

  it('without key: zero fetch calls, no log', async () => {
    const { fetchFn, calls } = captureFetch(1);
    const result = await recordContextPruningShadow({
      action: 'warn',
      totalTokens: 150_000,
      candidates: CANDIDATES,
      fetchFn,
    });

    expect(result).toEqual({ answer: 'warn', source: 'twin', mode: 'off' });
    expect(calls).toHaveLength(0);
    await expect(readFile(join(logDir, 'shadow.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('with OMC_JEV=off: zero calls even with a key', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'off';
    const { fetchFn, calls } = captureFetch(1);
    const result = await recordContextPruningShadow({
      action: 'compact',
      totalTokens: 190_000,
      candidates: CANDIDATES,
      fetchFn,
    });

    expect(result).toEqual({ answer: 'compact', source: 'twin', mode: 'off' });
    expect(calls).toHaveLength(0);
    await expect(readFile(join(logDir, 'shadow.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('bounds candidate excerpts before sending', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'context-pruning';
    const long = 'a'.repeat(500);
    const { fetchFn, calls } = captureFetch(2);
    await recordContextPruningShadow({
      action: 'warn',
      totalTokens: 150_000,
      candidates: [{ tool: 'bash', tokens: 900, excerpt: long }],
      fetchFn,
    });
    const body = JSON.parse(calls[0].init?.body as string) as {
      state: { candidates: Array<{ excerpt: string }> };
    };
    expect(body.state.candidates[0].excerpt).toHaveLength(200);
  });
});

describe('hook wiring: createPreemptiveCompactionHook + context-pruning shadow', () => {
  function postToolUseOnce(fetchFn: typeof fetch | undefined, sessionId: string): string | null {
    clearRapidFireDebounce(sessionId);
    const hook = createPreemptiveCompactionHook(fetchFn
      ? { jevFetchFn: fetchFn, warningThreshold: 0.1 }
      : { warningThreshold: 0.1 });
    return hook.postToolUse({
      tool_name: 'Read',
      session_id: sessionId,
      tool_input: {},
      // 400k chars -> ~100k tokens -> usageRatio 0.5, above the 0.1 threshold.
      tool_response: 'x'.repeat(400_000),
    });
  }

  it('warning message is byte-identical with and without the key, and the shadow line is logged with the key', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'context-pruning';
    const { fetchFn } = captureFetch(4);

    const withKey = postToolUseOnce(fetchFn, 'jev-wiring-with-key');
    expect(withKey).toBe(CONTEXT_WARNING_MESSAGE);

    delete process.env.TYPESAFE_API_KEY;
    const withoutKey = postToolUseOnce(undefined, 'jev-wiring-without-key');
    expect(withoutKey).toBe(CONTEXT_WARNING_MESSAGE);
    expect(withoutKey).toBe(withKey);

    const line = JSON.parse(await readLogLine());
    expect(line).toMatchObject({
      point: 'context-pruning',
      mode: 'shadow',
      heuristic: 'warn',
    });
    const state = line.state as { candidates: Array<{ tool: string; excerpt: string }>; candidateCount: number };
    expect(state.candidateCount).toBe(1);
    expect(state.candidates[0].tool).toBe('read');
    expect(state.candidates[0].excerpt.length).toBeLessThanOrEqual(200);
  });
});
