import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTaskSize } from '../index.js';
import { recordTaskSizeShadow } from '../jev-shadow.js';
import { resetJevResolverState } from '../../jev/index.js';
import type { JevAnswer, JevResponse } from '../../jev/index.js';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_TIMEOUT_MS',
  'OMC_JEV_MAX_REQUESTS',
  'OMC_JEV_EXCERPT_CHARS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
] as const;

const PROMPT =
  'refactor the entire codebase authentication layer across all files and redesign the session storage from scratch';

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  logDir = await mkdtemp(join(tmpdir(), 'task-size-jev-test-'));
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

function stubFetch(answer: Partial<JevAnswer>): { fetchFn: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const body = JSON.stringify({
    answers: {
      answer: { type: answer.choice !== undefined ? 'Choice' : 'Noul', ...answer },
    },
  } satisfies JevResponse);
  const fetchFn = (async (_url: unknown, init?: unknown) => {
    calls.push(init);
    return { ok: true, status: 200, json: async () => JSON.parse(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Non-blocking shadow logs when the Jev promise settles; poll for them. */
async function waitForLogLines(count: number): Promise<string[]> {
  const logPath = join(logDir, 'shadow.jsonl');
  for (let i = 0; i < 100; i++) {
    try {
      const lines = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
      if (lines.length >= count) return lines;
    } catch {
      // log not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${count} shadow log lines, got fewer`);
}

describe('task-size-detector shadow judgment point', () => {
  it('with config, records a shadow log line with the twin classification and Jev Choice', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'task-size';
    const { fetchFn, calls } = stubFetch({ choice: 'medium', confidence: 0.6 });

    const result = await recordTaskSizeShadow(PROMPT, fetchFn);

    expect(result).toEqual({ answer: classifyTaskSize(PROMPT), source: 'twin', mode: 'shadow' });
    expect(result.answer.size).toBe('large');

    const lines = await waitForLogLines(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      point: 'task-size',
      mode: 'shadow',
      state: { prompt: PROMPT, source: 'user-prompt-submit' },
      heuristic: classifyTaskSize(PROMPT),
      jev: { type: 'Choice', choice: 'medium', confidence: 0.6 },
    });
    expect(calls).toHaveLength(1);
  });

  it('without a key, zero fetch calls and the classification is unchanged', async () => {
    delete process.env.TYPESAFE_API_KEY;
    process.env.OMC_JEV = 'task-size';
    const { fetchFn, calls } = stubFetch({ choice: 'small' });

    const result = await recordTaskSizeShadow(PROMPT, fetchFn);

    expect(result).toEqual({
      answer: classifyTaskSize(PROMPT),
      source: 'twin',
      mode: 'off',
    });
    expect(result.answer.size).toBe('large');
    expect(calls).toHaveLength(0);
    await expect(readFile(join(logDir, 'shadow.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('with OMC_JEV=off, zero fetch calls even with a key', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'off';
    const { fetchFn, calls } = stubFetch({ choice: 'small' });

    const result = await recordTaskSizeShadow(PROMPT, fetchFn);

    expect(result.mode).toBe('off');
    expect(calls).toHaveLength(0);
  });

  it('bounds the prompt excerpt in the logged state', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'task-size';
    process.env.OMC_JEV_EXCERPT_CHARS = '40';
    const { fetchFn } = stubFetch({ choice: 'medium' });

    await recordTaskSizeShadow(PROMPT, fetchFn);

    const lines = await waitForLogLines(1);
    const entry = JSON.parse(lines[0]!) as { state: { prompt: string } };
    expect(entry.state.prompt.length).toBeLessThanOrEqual(40);
    expect(PROMPT.startsWith(entry.state.prompt)).toBe(true);
  });
});
