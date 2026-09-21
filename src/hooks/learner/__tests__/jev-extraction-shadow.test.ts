import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectExtractableMoment } from '../detector.js';
import { recordLearnerExtractionShadow } from '../jev-shadow.js';
import { resetJevResolverState } from '../../jev/index.js';

const EXTRACTABLE =
  'The bug was caused by a stale cache; I fixed the issue by invalidating the key in the auth module.';
const ROUTINE = 'Ran the test suite and it passed.';

const TEST_KEY = 'test-key-123';
const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_TIMEOUT_MS',
  'OMC_JEV_EXCERPT_CHARS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
] as const;

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetJevResolverState();
  logDir = mkdtempSync(join(tmpdir(), 'learner-jev-test-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OMC_JEV_LOG_DIR = logDir;
  process.env.OMC_JEV_ENDPOINT = 'http://127.0.0.1:1/v1/systemone';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(logDir, { recursive: true, force: true });
});

function stubFetch(noul = false): { fetchFn: typeof fetch; calls: Array<{ body: string }> } {
  const calls: Array<{ body: string }> = [];
  const fetchFn = (async (_url: unknown, init?: unknown) => {
    const body = (init as RequestInit | undefined)?.body as string;
    calls.push({ body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          extractable_moment: { type: 'Noul', noul, confidence: 0.8 },
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Non-blocking shadow logs settle asynchronously after the twin answer. */
async function waitForLogLines(count: number): Promise<string[]> {
  const logPath = join(logDir, 'shadow.jsonl');
  for (let i = 0; i < 100; i++) {
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      if (lines.length >= count) return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${count} shadow log lines, got fewer`);
}

describe('learner-extraction shadow judgment point', () => {
  it('with config, records a shadow line with the twin detection and the Jev Noul', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'learner-extraction';
    const { fetchFn, calls } = stubFetch(true);

    const result = await recordLearnerExtractionShadow(EXTRACTABLE, 'fix the auth bug', fetchFn);

    expect(result).toEqual({
      answer: detectExtractableMoment(EXTRACTABLE, 'fix the auth bug'),
      source: 'twin',
      mode: 'shadow',
    });
    expect(result.answer.detected).toBe(true);

    const lines = await waitForLogLines(1);
    const entry = JSON.parse(lines[0]!) as {
      point: string;
      mode: string;
      heuristic: { detected: boolean };
      jev: { type: string } | null;
      state: Record<string, unknown>;
    };
    expect(entry.point).toBe('learner-extraction');
    expect(entry.mode).toBe('shadow');
    expect(entry.heuristic.detected).toBe(true);
    expect(entry.jev?.type).toBe('Noul');
    expect(entry.state).toMatchObject({
      assistant_message: EXTRACTABLE,
      user_message: 'fix the auth bug',
      source: 'learner-detection',
    });
    expect(calls).toHaveLength(1);
  });

  it('without configuration, zero fetch calls and the detection is unchanged', async () => {
    const { fetchFn, calls } = stubFetch();

    const result = await recordLearnerExtractionShadow(EXTRACTABLE, undefined, fetchFn);

    expect(result).toEqual({
      answer: detectExtractableMoment(EXTRACTABLE),
      source: 'twin',
      mode: 'off',
    });
    expect(result.answer.detected).toBe(true);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(logDir, 'shadow.jsonl'))).toBe(false);
  });

  it('without OMC_JEV opt-in, a key alone triggers zero fetch calls (strict per-point opt-in)', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    const { fetchFn, calls } = stubFetch();

    const result = await recordLearnerExtractionShadow(ROUTINE, undefined, fetchFn);

    expect(result.mode).toBe('off');
    expect(result.answer.detected).toBe(false);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(logDir, 'shadow.jsonl'))).toBe(false);
  });

  it('with OMC_JEV=off, zero fetch calls even with a key', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'off';
    const { fetchFn, calls } = stubFetch();

    const result = await recordLearnerExtractionShadow(ROUTINE, undefined, fetchFn);

    expect(result.mode).toBe('off');
    expect(calls).toHaveLength(0);
  });

  it('bounds the message excerpt in the logged state', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'learner-extraction';
    process.env.OMC_JEV_EXCERPT_CHARS = '40';
    const { fetchFn } = stubFetch();

    await recordLearnerExtractionShadow(EXTRACTABLE, undefined, fetchFn);

    const lines = await waitForLogLines(1);
    const entry = JSON.parse(lines[0]!) as { state: { assistant_message: string } };
    expect(entry.state.assistant_message.length).toBeLessThanOrEqual(40);
    expect(EXTRACTABLE.startsWith(entry.state.assistant_message)).toBe(true);
  });

  it('on never-resolving Jev fetch, the detection is unchanged (degraded, host behavior identical)', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'learner-extraction';
    process.env.OMC_JEV_TIMEOUT_MS = '20';
    const fetchFn = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;

    const result = await recordLearnerExtractionShadow(EXTRACTABLE, undefined, fetchFn);

    expect(result.answer).toEqual(detectExtractableMoment(EXTRACTABLE));
    expect(result.source).toBe('twin');

    const lines = await waitForLogLines(1);
    const entry = JSON.parse(lines[0]!) as { mode: string; heuristic: unknown; jev: unknown };
    expect(entry.mode).toBe('degraded');
    expect(entry.heuristic).toEqual(detectExtractableMoment(EXTRACTABLE));
    expect(entry.jev).toBeNull();
  });
});
