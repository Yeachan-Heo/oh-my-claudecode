import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAllKeywords } from '../index.js';
import { recordIntentShadow, recordSkillTriggerShadow } from '../jev-shadow.js';
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

const PROMPT = 'ralph fix the auth bug in src/auth/login.ts';
const INTENT_PROMPT = '/intent users report the export button does nothing on Safari';

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  logDir = await mkdtemp(join(tmpdir(), 'jev-shadow-test-'));
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
    answers: { answer: { type: answer.noul !== undefined ? 'Noul' : 'Choice', ...answer } },
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

describe('keyword-detector shadow judgment points', () => {
  it('with a key set, a fixture prompt produces two shadow log lines with both twin and jev answers', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'skill-trigger,intent';
    const trigger = stubFetch({ choice: 'autopilot', confidence: 0.8 });
    const intent = stubFetch({ noul: false, confidence: 0.7 });

    const triggerResult = await recordSkillTriggerShadow(PROMPT, trigger.fetchFn);
    const intentResult = await recordIntentShadow(INTENT_PROMPT, intent.fetchFn);

    expect(triggerResult).toEqual({ answer: ['ralph'], source: 'twin', mode: 'shadow' });
    expect(intentResult).toEqual({ answer: true, source: 'twin', mode: 'shadow' });

    const lines = await waitForLogLines(2);
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const byPoint = new Map(entries.map((entry) => [entry.point, entry]));

    expect(byPoint.get('skill-trigger')).toMatchObject({
      mode: 'shadow',
      state: { prompt: PROMPT, source: 'user-prompt-submit' },
      heuristic: ['ralph'],
      jev: { type: 'Choice', choice: 'autopilot', confidence: 0.8 },
    });
    expect(byPoint.get('intent')).toMatchObject({
      mode: 'shadow',
      state: { prompt: INTENT_PROMPT, mode_name: 'intent' },
      heuristic: true,
      jev: { type: 'Noul', noul: false, confidence: 0.7 },
    });
  });

  it('without a key, zero fetch calls and the twin answer is unchanged', async () => {
    delete process.env.TYPESAFE_API_KEY;
    process.env.OMC_JEV = 'skill-trigger,intent';
    const trigger = stubFetch({ choice: 'cancel' });
    const intent = stubFetch({ noul: true });

    const triggerResult = await recordSkillTriggerShadow(PROMPT, trigger.fetchFn);
    const intentResult = await recordIntentShadow(PROMPT, intent.fetchFn);

    expect(triggerResult).toEqual({ answer: getAllKeywords(PROMPT), source: 'twin', mode: 'off' });
    expect(intentResult).toEqual({ answer: false, source: 'twin', mode: 'off' });
    expect(trigger.calls).toHaveLength(0);
    expect(intent.calls).toHaveLength(0);
    await expect(readFile(join(logDir, 'shadow.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('with OMC_JEV=off, zero fetch calls even with a key', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'off';
    const trigger = stubFetch({ choice: 'cancel' });
    const intent = stubFetch({ noul: true });

    const triggerResult = await recordSkillTriggerShadow(PROMPT, trigger.fetchFn);
    const intentResult = await recordIntentShadow(PROMPT, intent.fetchFn);

    expect(triggerResult.mode).toBe('off');
    expect(intentResult.mode).toBe('off');
    expect(trigger.calls).toHaveLength(0);
    expect(intent.calls).toHaveLength(0);
  });

  it('shadow answers never change the detector emissions regardless of what Jev answers', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'skill-trigger,intent';
    // Stub answers deliberately contradict the twin for these prompts.
    const trigger = stubFetch({ choice: 'none' });
    const intent = stubFetch({ noul: true });

    const triggerResult = await recordSkillTriggerShadow(PROMPT, trigger.fetchFn);
    const intentResult = await recordIntentShadow(INTENT_PROMPT, intent.fetchFn);

    expect(triggerResult.answer).toEqual(getAllKeywords(PROMPT));
    expect(triggerResult.source).toBe('twin');
    expect(intentResult.answer).toBe(true);
    expect(intentResult.source).toBe('twin');
  });
});
