import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordSimplifierTriggerShadow } from '../../code-simplifier/jev-shadow.js';
import type { PersistentModeResult } from '../../persistent-mode/index.js';
import { applyLoopContinuationShadow } from '../../persistent-mode/jev-shadow.js';
import { resetJevResolverState } from '../resolver.js';

const ENV_KEYS = ['TYPESAFE_API_KEY', 'OMC_JEV', 'OMC_JEV_LOG_DIR', 'OMC_JEV_STATE_OMIT_IDS', 'OMC_JEV_LOG_CONTEXT', 'OMC_JEV_QUIET', 'OMC_JEV_ENDPOINT'] as const;

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetJevResolverState();
  logDir = mkdtempSync(join(tmpdir(), 'jev-state-omit-ids-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.OMC_JEV = 'loop-continuation:active,simplifier-trigger:active';
  process.env.OMC_JEV_LOG_DIR = logDir;
  process.env.OMC_JEV_QUIET = '1';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(logDir, { recursive: true, force: true });
});

/** A transport that answers every question with noul 0 and keeps the states it was sent. */
function capturingFetch(): { fetchFn: typeof fetch; states: Record<string, unknown>[] } {
  const states: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    states.push(body.state);
    const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: 'noul', noul: false }]));
    return { ok: true, status: 200, json: async () => ({ answers }) };
  }) as unknown as typeof fetch;
  return { fetchFn, states };
}

const RALPH_RESULT = { shouldBlock: true, message: 'Continue working.', mode: 'ralph', metadata: { iteration: 2 } } as unknown as PersistentModeResult;

describe('OMC_JEV_STATE_OMIT_IDS in the TypeScript states', () => {
  it('loop-continuation sends session_id without the variable and leaves it out with it', async () => {
    const before = capturingFetch();
    await applyLoopContinuationShadow({ result: RALPH_RESULT, sessionId: 'session-1', fetchFn: before.fetchFn });
    expect(before.states[0]).toMatchObject({ mode_name: 'ralph', session_id: 'session-1' });

    resetJevResolverState();
    process.env.OMC_JEV_STATE_OMIT_IDS = '1';
    const after = capturingFetch();
    await applyLoopContinuationShadow({ result: RALPH_RESULT, sessionId: 'session-1', fetchFn: after.fetchFn });
    expect(after.states.length).toBeGreaterThan(0);
    for (const state of after.states) {
      expect(state).toMatchObject({ mode_name: 'ralph', iteration: 2 });
      expect(state).not.toHaveProperty('session_id');
    }
  });

  it('simplifier-trigger sends cwd without the variable and leaves it out with it', async () => {
    const args = { cwd: '/work/project', stateDir: logDir, files: ['a.ts'], shouldBlock: true };
    const before = capturingFetch();
    await recordSimplifierTriggerShadow({ ...args, fetchFn: before.fetchFn });
    expect(before.states[0]).toEqual({ cwd: '/work/project', files: ['a.ts'], source: 'code-simplifier-stop' });

    resetJevResolverState();
    process.env.OMC_JEV_STATE_OMIT_IDS = 'true';
    const after = capturingFetch();
    await recordSimplifierTriggerShadow({ ...args, fetchFn: after.fetchFn });
    expect(after.states[0]).toEqual({ files: ['a.ts'], source: 'code-simplifier-stop' });
  });

  it('keeps session_id and cwd in the log line with OMC_JEV_LOG_CONTEXT=1', async () => {
    process.env.OMC_JEV_STATE_OMIT_IDS = '1';
    process.env.OMC_JEV_LOG_CONTEXT = '1';
    await applyLoopContinuationShadow({ result: RALPH_RESULT, sessionId: 'session-1', fetchFn: capturingFetch().fetchFn });
    resetJevResolverState();
    await recordSimplifierTriggerShadow({ cwd: '/work/project', stateDir: logDir, files: ['a.ts'], shouldBlock: true, fetchFn: capturingFetch().fetchFn });
    const lines = readFileSync(join(logDir, 'shadow.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const loop = lines.filter((line) => line.point === 'loop-continuation');
    expect(loop.length).toBeGreaterThan(0);
    for (const line of loop) {
      expect(line.session_id).toBe('session-1');
      expect(line.state).not.toHaveProperty('session_id');
    }
    const simplifier = lines.find((line) => line.point === 'simplifier-trigger');
    expect(simplifier.cwd).toBe('/work/project');
    expect(simplifier.state).not.toHaveProperty('cwd');
  });
});
