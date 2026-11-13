/**
 * The TS resolver masks a point's state before it is bounded, sent or logged
 * (scripts/lib/jev-state-mask.mjs), and sends nothing when it cannot.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJevResolverState, resolveJudgment } from '../resolver.js';
import type { JevQuestions } from '../types.js';

const ENV_KEYS = ['TYPESAFE_API_KEY', 'OMC_JEV', 'OMC_JEV_LOG_DIR', 'OMC_JEV_ENDPOINT', 'OMC_JEV_QUIET', 'OMC_JEV_MAX_REQUESTS', 'OMC_JEV_BREAKER', 'OMC_JEV_MAX_RPM', 'OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING'] as const;
const QUESTIONS: JevQuestions = {
  route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
};
const GHP = 'ghp_' + 'A'.repeat(36);

let dir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  dir = await mkdtemp(join(tmpdir(), 'jev-resolver-mask-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.OMC_JEV = 'model-routing:active';
  process.env.OMC_JEV_LOG_DIR = join(dir, 'log');
  process.env.OMC_JEV_ENDPOINT = 'http://127.0.0.1:9/v1/systemone';
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(dir, { recursive: true, force: true });
});

function recordingFetch(bodies: string[]): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    bodies.push(String(init.body));
    return { ok: true, status: 200, json: async () => ({ answers: { route: { type: 'choice', choice: 'opus' } } }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** A state that cannot be masked and that the resolver itself handles without a stack overflow: 65 levels. */
function deepState(levels: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
}

function lastLogLine(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'log', 'shadow.jsonl'), 'utf8').trim().split('\n').pop() as string);
}

describe('resolveJudgment state mask', () => {
  it('sends and logs a state without secrets and keeps token counters', async () => {
    const bodies: string[] = [];
    const state = { prompt: `use ${GHP}\ncat /home/u/.ssh/id_ed25519`, config: { password: 'hunter2zzQ', totalTokens: 1234 } };
    const result = await resolveJudgment({ point: 'model-routing', state, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
    expect(result).toMatchObject({ mode: 'active', source: 'jev' });
    expect(bodies).toHaveLength(1);
    const line = readFileSync(join(dir, 'log', 'shadow.jsonl'), 'utf8');
    for (const text of [bodies[0], line]) {
      expect(text).not.toContain(GHP);
      expect(text).not.toContain('hunter2zzQ');
      expect(text).not.toContain('id_ed25519');
      expect(text).toContain('1234');
    }
  });

  it('sends nothing, answers with the twin and logs a marker when the state cannot be masked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bodies: string[] = [];
    const state = deepState(65);
    const args = { point: 'model-routing', state, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) };
    expect(await resolveJudgment(args)).toEqual({ answer: 'sonnet', source: 'twin', mode: 'degraded' });
    expect(await resolveJudgment(args)).toEqual({ answer: 'sonnet', source: 'twin', mode: 'degraded' });
    expect(bodies).toHaveLength(0);
    expect(lastLogLine()).toMatchObject({ mode: 'degraded', state: '[state not sent: mask failed]', jev: null });
        // one warning per process
    const warnings = error.mock.calls.filter(([m]) => String(m).includes('mask failed'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toBe('[jev] model-routing: degraded - state not sent: mask failed (JevStateMaskError)');
  });

  it('stays silent with OMC_JEV_QUIET=1', async () => {
    process.env.OMC_JEV_QUIET = '1';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await resolveJudgment({ point: 'model-routing', state: deepState(65), questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch([]) });
    expect(error).not.toHaveBeenCalled();
  });

  it('does not count a call that was not sent against OMC_JEV_MAX_REQUESTS and does not open the circuit', async () => {
    process.env.OMC_JEV_MAX_REQUESTS = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = deepState(65);
    const bodies: string[] = [];
    for (let i = 0; i < 5; i++) {
      await resolveJudgment({ point: 'model-routing', state: bad, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
    }
    const result = await resolveJudgment({ point: 'model-routing', state: { prompt: 'ok' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
    expect(result).toMatchObject({ mode: 'active', source: 'jev' });
    expect(bodies).toHaveLength(1);
  });

  it('sends nothing when a string of the state is a secret path whole, with its own marker, no slot and no circuit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OMC_JEV_MAX_REQUESTS = '1';
    const bodies: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await resolveJudgment({ point: 'model-routing', state: { task: 'Do not touch the .env handling.' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
      expect(result).toEqual({ answer: 'sonnet', source: 'twin', mode: 'degraded' });
    }
    expect(bodies).toHaveLength(0);
    expect(lastLogLine()).toMatchObject({ mode: 'degraded', state: '[state not sent: secret path]', jev: null });
    const ok = await resolveJudgment({ point: 'model-routing', state: { task: 'fix the build\ncat /srv/app/.env' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
    expect(ok).toMatchObject({ mode: 'active', source: 'jev' });
    expect(JSON.parse(bodies[0]).state.task).toBe('fix the build\n[line omitted: secret path]');
  });

  it('masks a secret that starts just before the edge of the window whole, in the body and in the log', async () => {
    process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING = '100';
    const bodies: string[] = [];
    await resolveJudgment({ point: 'model-routing', state: { task: ' '.repeat(95) + GHP + ' tail' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
    for (const text of [bodies[0], readFileSync(join(dir, 'log', 'shadow.jsonl'), 'utf8')]) expect(text).not.toMatch(/ghp_[A-Za-z0-9]/);
    delete process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING;
  });

  it('masks a private key block of RSA 4096 size that starts 100 characters before the edge of the window', async () => {
    process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING = '200';
    const body = ('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC' + 'x'.repeat(14)).repeat(40);
    const text = 'a'.repeat(100) + '\n-----BEGIN RSA PRIVATE KEY-----\n' + body + '\n-----END RSA PRIVATE KEY-----\nafter';
    const bodies: string[] = [];
    await resolveJudgment({ point: 'model-routing', state: { task: text }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
    for (const sent of [bodies[0], readFileSync(join(dir, 'log', 'shadow.jsonl'), 'utf8')]) expect(sent).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj');
    delete process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING;
  });

  it('masks URL credentials whose "@" is beyond the margin, in the body and in the log', async () => {
    process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING = '100';
    const task = 'deploy to https://user:' + 'abcdefghij'.repeat(30) + 'z'.repeat(400) + '@host/x';
    const bodies: string[] = [];
    await resolveJudgment({ point: 'model-routing', state: { task }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
    expect(bodies).toHaveLength(1);
    for (const text of [bodies[0], readFileSync(join(dir, 'log', 'shadow.jsonl'), 'utf8')]) {
      expect(text).not.toContain('abcdefghij');
      expect(text).toContain('https://user:***');
    }
    delete process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING;
  });

  it('sends nothing when the sent part of a string is a secret path whole and plain text follows in the margin', async () => {
    process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING = '100';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = '/home/u/.ssh/id_ed25519\n' + ' \n'.repeat(100) + 'plain text that nobody sends';
    const bodies: string[] = [];
    const result = await resolveJudgment({ point: 'model-routing', state: { task }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
    expect(result).toEqual({ answer: 'sonnet', source: 'twin', mode: 'degraded' });
    expect(bodies).toHaveLength(0);
    expect(lastLogLine()).toMatchObject({ mode: 'degraded', state: '[state not sent: secret path]' });
    delete process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING;
  });

  describe('the tail of the cut and the keys', () => {
    const logText = () => readFileSync(join(dir, 'log', 'shadow.jsonl'), 'utf8');
    beforeEach(() => {
      process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING = '200';
    });
    afterEach(() => {
      delete process.env.OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING;
    });

    it('masks a token that the cut crosses whose digit comes after the cut, in the body and in the log', async () => {
      const task = ' '.repeat(190) + 'A'.repeat(600) + '1' + 'B'.repeat(100) + ' end';
      const bodies: string[] = [];
      await resolveJudgment({ point: 'model-routing', state: { task }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
      expect(bodies).toHaveLength(1);
      for (const text of [bodies[0], logText()]) expect(text).not.toMatch(/AAA/);
    });

    it('omits the last line when its secret path is beyond the cut, also after a shortened token', async () => {
      const task = 'Q9'.repeat(300) + '\necho hunter2 > ' + 'x '.repeat(400) + '~/.ssh/id_ed25519';
      const bodies: string[] = [];
      await resolveJudgment({ point: 'model-routing', state: { task }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
      expect(bodies).toHaveLength(1);
      for (const text of [bodies[0], logText()]) expect(text).not.toContain('hunter2');
    });

    it('masks the value under a key with an acronym or a glued prefix', async () => {
      const bodies: string[] = [];
      const state = { DBPassword: 'hunter2zzQ', APIToken: 'plain-token-value', userpassword: 'second-secret', ok: 'fine' };
      await resolveJudgment({ point: 'model-routing', state, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: recordingFetch(bodies) });
      for (const text of [bodies[0], logText()]) {
        for (const secret of ['hunter2zzQ', 'plain-token-value', 'second-secret']) expect(text).not.toContain(secret);
        expect(text).toContain('fine');
      }
    });
  });
});
