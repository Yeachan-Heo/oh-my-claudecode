/**
 * OMC_JEV_ROW_TELEMETRY on the script side: the telemetry fields of the
 * shadow-log lines that resolveRequest in scripts/jev-resolve.mjs writes, the
 * helpers behind them, and the unchanged line shape without the variable.
 * The hook-side cases (the cause field of applied.jsonl and of overrides.jsonl)
 * are in jev-applied-log.test.mjs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  isJevRowTelemetryEnabled,
  JEV_ROW_NO_ANSWER,
  questionsVersion,
  resolveRequest,
  sanitizeUsage,
} from '../../scripts/jev-resolve.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'jev-row-telemetry-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let dirCount = 0;
function freshDir() {
  dirCount += 1;
  const dir = join(tmp, 'case-' + dirCount);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readLines(dir) {
  return readFileSync(join(dir, 'shadow.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const QUESTIONS = {
  'model-tier': { type: 'choice', instructions: 'tier', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
  effort: { type: 'score', instructions: 'effort', criteria: { low: 'low', medium: 'medium' } },
};

const ANSWER_BODY = {
  answers: {
    'model-tier': { type: 'choice', choice: 'opus', confidence: 0.8 },
    effort: { type: 'score', score: 3, confidence: 0.6 },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
  model: 'jev-2026.1',
};

const ok = (body) => async () => ({ ok: true, json: async () => body });

/** One model-routing request in active mode, logged to a fresh directory. */
async function judge({ env = {}, state = { task: 'short task' }, questions = QUESTIONS, pointer, fetchFn = ok(ANSWER_BODY) } = {}) {
  const dir = freshDir();
  const result = await resolveRequest(
    { point: 'model-routing', state, questions, heuristic: 'sonnet', ...(pointer ? { pointer } : {}) },
    { OMC_JEV: 'all:active', TYPESAFE_API_KEY: 'test-key', OMC_JEV_LOG_DIR: dir, ...env },
    fetchFn,
  );
  const row = readLines(dir).pop();
  return { result, row };
}

const TELEMETRY_ENV = { OMC_JEV_ROW_TELEMETRY: '1' };
const DEV_LINE_KEYS = ['ts', 'point', 'mode', 'state', 'heuristic', 'jev', 'answers', 'confidence', 'durationMs'];

describe('isJevRowTelemetryEnabled', () => {
  it('is on for 1 and true only', () => {
    expect(isJevRowTelemetryEnabled({ OMC_JEV_ROW_TELEMETRY: '1' })).toBe(true);
    expect(isJevRowTelemetryEnabled({ OMC_JEV_ROW_TELEMETRY: ' TRUE ' })).toBe(true);
    expect(isJevRowTelemetryEnabled({ OMC_JEV_ROW_TELEMETRY: '0' })).toBe(false);
    expect(isJevRowTelemetryEnabled({ OMC_JEV_ROW_TELEMETRY: 'yes' })).toBe(false);
    expect(isJevRowTelemetryEnabled({})).toBe(false);
  });
});

describe('sanitizeUsage', () => {
  it('keeps a valid input/output pair and returns null for anything else', () => {
    expect(sanitizeUsage({ input_tokens: 12, output_tokens: 3 })).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(sanitizeUsage({ input_tokens: -1, output_tokens: 3 })).toBeNull();
    expect(sanitizeUsage({ input_tokens: '5', output_tokens: 3 })).toBeNull();
    expect(sanitizeUsage(null)).toBeNull();
    expect(sanitizeUsage([1, 2])).toBeNull();
  });
});

describe('JEV_ROW_NO_ANSWER and questionsVersion', () => {
  it('lists the telemetry fields, all null', () => {
    expect(Object.keys(JEV_ROW_NO_ANSWER)).toEqual([
      'source_chars',
      'sent_chars',
      'cut_chars',
      'input_complete',
      'pointer_expanded',
      'pointer_unexpanded',
      'questions_version',
      'jev_model',
      'usage_status',
      'cost_usd',
      'cost_basis',
    ]);
    for (const value of Object.values(JEV_ROW_NO_ANSWER)) expect(value).toBeNull();
  });

  it('hashes the questions: the same questions give the same hash, other questions another one', () => {
    const version = questionsVersion(QUESTIONS);
    expect(questionsVersion(QUESTIONS)).toBe(version);
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(questionsVersion({ 'model-tier': QUESTIONS['model-tier'] })).not.toBe(version);
    expect(questionsVersion({ effort: { type: 'score', criteria: { low: 'l', high: 'h' } } })).toBe(
      questionsVersion({ effort: { type: 'score', criteria: ['l', 'h'] } }),
    );
  });
});

describe('resolveRequest shadow line', () => {
  it('without OMC_JEV_ROW_TELEMETRY the line and the result keep their shape', async () => {
    const { result, row } = await judge();
    expect(Object.keys(row).sort()).toEqual([...DEV_LINE_KEYS].sort());
    expect(row).not.toHaveProperty('usage');
    expect(row).not.toHaveProperty('model');
    expect(Object.keys(JEV_ROW_NO_ANSWER).every((key) => !(key in row))).toBe(true);
    expect(result).not.toHaveProperty('jevModel');
  });

  it('an answered line carries the telemetry of the classifier input and the answer', async () => {
    const { result, row } = await judge({ env: TELEMETRY_ENV });
    expect(result.mode).toBe('active');
    expect(result.jevModel).toBe('jev-2026.1');
    expect(row.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(row.model).toBe('jev-2026.1');
    expect(row.source_chars).toBe(JSON.stringify({ task: 'short task' }).length);
    expect(row.sent_chars).toBe(row.source_chars);
    expect(row.cut_chars).toBe(0);
    expect(row.input_complete).toBe(true);
    expect(row.pointer_expanded).toBe(false);
    expect(row.pointer_unexpanded).toBeNull();
    expect(row.questions_version).toBe(questionsVersion(QUESTIONS));
    expect(row.jev_model).toBe('jev-2026.1');
    expect(row.usage_status).toBe('reported');
    expect(row.cost_usd).toBeNull();
    expect(row.cost_basis).toBe('unknown');
  });

  it('a cut state reports the removed characters and an incomplete input', async () => {
    const { row } = await judge({ env: { ...TELEMETRY_ENV, OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING: '50' }, state: { task: 'z'.repeat(400) } });
    expect(row.sent_chars).toBe(JSON.stringify({ task: 'z'.repeat(50) }).length);
    expect(row.cut_chars).toBe(row.source_chars - row.sent_chars);
    expect(row.cut_chars).toBeGreaterThan(0);
    expect(row.input_complete).toBe(false);
  });

  it('the pointer telemetry of the request is copied; invalid values give false and null', async () => {
    const valid = await judge({ env: TELEMETRY_ENV, pointer: { expanded: true, unexpanded: 'missing-file' } });
    expect(valid.row.pointer_expanded).toBe(true);
    expect(valid.row.pointer_unexpanded).toBe('missing-file');
    const invalid = await judge({ env: TELEMETRY_ENV, pointer: { expanded: 'yes', unexpanded: 7 } });
    expect(invalid.row.pointer_expanded).toBe(false);
    expect(invalid.row.pointer_unexpanded).toBeNull();
  });

  it('usage that is not an input/output pair is partial, and absent usage is unavailable', async () => {
    const partial = await judge({ env: TELEMETRY_ENV, fetchFn: ok({ ...ANSWER_BODY, usage: { prompt_tokens: 5, completion_tokens: 3 } }) });
    expect(partial.row.usage_status).toBe('partial');
    expect(partial.row.usage).toBeNull();
    const absent = await judge({ env: TELEMETRY_ENV, fetchFn: ok({ answers: ANSWER_BODY.answers }) });
    expect(absent.row.usage_status).toBe('unavailable');
    expect(absent.row.usage).toBeNull();
    expect(absent.row.jev_model).toBeNull();
    expect(absent.row.cost_basis).toBe('unknown');
  });

  it('the questions version differs between points and is the hash of the questions of that point', async () => {
    const other = { q: { type: 'choice', instructions: 'i', criteria: { a: 'a' } } };
    const { row: first } = await judge({ env: TELEMETRY_ENV });
    const dir = freshDir();
    await resolveRequest(
      { point: 'task-size', state: { task: 'short task' }, questions: other, heuristic: 'sonnet' },
      { OMC_JEV: 'all:active', TYPESAFE_API_KEY: 'test-key', OMC_JEV_LOG_DIR: dir, ...TELEMETRY_ENV },
      ok(ANSWER_BODY),
    );
    const second = readLines(dir).pop();
    expect(first.questions_version).not.toBe(second.questions_version);
    expect(second.questions_version).toBe(questionsVersion(other));
  });

  it('a degraded line (HTTP 500) carries the telemetry fields empty, never zero', async () => {
    const { row } = await judge({
      env: TELEMETRY_ENV,
      fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    expect(row.mode).toBe('degraded');
    for (const key of Object.keys(JEV_ROW_NO_ANSWER)) expect(row[key]).toBeNull();
    expect(row.usage).toBeNull();
    expect(row.model).toBeNull();
  });

  it('a line of a request held back by the request limit carries the telemetry fields empty', async () => {
    const dir = freshDir();
    const env = { OMC_JEV: 'all:active', TYPESAFE_API_KEY: 'test-key', OMC_JEV_LOG_DIR: dir, OMC_JEV_MAX_RPM: '1', ...TELEMETRY_ENV };
    const request = { point: 'model-routing', state: { task: 'x' }, questions: QUESTIONS, heuristic: 'sonnet' };
    await resolveRequest(request, env, ok(ANSWER_BODY));
    const held = await resolveRequest(request, env, ok(ANSWER_BODY));
    expect(held.mode).not.toBe('active');
    const row = readLines(dir).pop();
    expect(row.mode).toBe(held.mode);
    for (const key of Object.keys(JEV_ROW_NO_ANSWER)) expect(row[key]).toBeNull();
  });
});
