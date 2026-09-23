/**
 * Tests for the Jev "model-routing" shadow wiring (issue-3669, judgment point ④).
 *
 * External behavior only: given a stubbed HTTP transport, the shadow wiring
 * records the pinned tier beside Jev's Choice when the key is set, and makes
 * zero HTTP calls with no key or with OMC_JEV=off. The enforcement result is
 * byte-identical either way — Jev never overrides the enforcer in shadow.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordModelRoutingShadow } from '../jev-model-routing.js';
import { processPreToolUse, type AgentInput, type EnforcementResult } from '../delegation-enforcer.js';
import { resetJevResolverState } from '../../hooks/jev/index.js';

const TEST_KEY = 'test-key-123';
const JEV_ENV_KEYS = ['TYPESAFE_API_KEY', 'OMC_JEV', 'OMC_JEV_LOG_DIR', 'OMC_JEV_ENDPOINT'] as const;
// Provider-detection env vars that forceInherit keys off (issue #1201) —
// cleared so the enforcement-identity test runs in a standard Claude
// environment regardless of the host shell (mirrors delegation-enforcer.test.ts).
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_MODEL',
  'ANTHROPIC_MODEL',
  'OMC_ROUTING_FORCE_INHERIT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

function makePinned(model = 'sonnet'): EnforcementResult {
  const originalInput: AgentInput = {
    description: 'Test task',
    prompt: 'Fix the flaky auth test in src/auth',
    subagent_type: 'oh-my-claudecode:executor',
  };
  return {
    originalInput,
    modifiedInput: { ...originalInput, model },
    injected: true,
    model,
  };
}

/** Stub transport returning a valid TypeSafe Jev response for the Choice question. */
function makeJevFetchStub(choice = 'opus') {
  const fetchFn = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        answers: { 'model-tier': { type: 'choice', choice, confidence: 0.9 } },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  return fetchFn;
}

/**
 * The shadow log line settles asynchronously after the twin answer returns.
 * `appendFile` creates the file before the line lands, so existence alone is
 * not the signal: wait for a newline-terminated record.
 */
async function waitForShadowLog(logDir: string, timeoutMs = 1000): Promise<string | null> {
  const logPath = join(logDir, 'shadow.jsonl');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const contents = readFileSync(logPath, 'utf-8');
      if (contents.includes('\n')) return contents;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

describe('jev-model-routing shadow wiring', () => {
  let logDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetJevResolverState();
    logDir = mkdtempSync(join(tmpdir(), 'jev-model-routing-'));
    for (const key of JEV_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    for (const key of PROVIDER_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OMC_JEV_LOG_DIR = logDir;
    // Unroutable endpoint so any accidental real network attempt fails fast
    // and degrades instead of reaching an external host from tests.
    process.env.OMC_JEV_ENDPOINT = 'http://127.0.0.1:1/v1/systemone';
  });

  afterEach(() => {
    for (const key of [...JEV_ENV_KEYS, ...PROVIDER_ENV_KEYS]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(logDir, { recursive: true, force: true });
  });

  it('records a shadow line with the pinned tier and Jev Choice when the key is set', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'model-routing';
    const fetchFn = makeJevFetchStub('opus');
    const pinned = makePinned('sonnet');

    const result = await recordModelRoutingShadow('Task', pinned, fetchFn as unknown as typeof fetch);

    // Shadow: the twin (pinned tier) decided, Jev's Choice recorded only.
    expect(result.mode).toBe('shadow');
    expect(result.source).toBe('twin');
    expect(result.answer).toBe(pinned);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const body = JSON.parse(String(vi.mocked(fetchFn).mock.calls[0][1]?.body)) as {
      state: Record<string, unknown>;
    };
    expect(body.state.tool_name).toBe('Task');
    expect(body.state.subagent_type).toBe('oh-my-claudecode:executor');
    expect(body.state.task).toBe('Fix the flaky auth test in src/auth');

    const log = await waitForShadowLog(logDir);
    expect(log).not.toBeNull();
    const entry = JSON.parse(log!.trim().split('\n')[0]) as {
      point: string;
      mode: string;
      heuristic: EnforcementResult;
      jev: { choice?: string } | null;
    };
    expect(entry.point).toBe('model-routing');
    expect(entry.mode).toBe('shadow');
    expect(entry.heuristic.model).toBe('sonnet');
    expect(entry.jev?.choice).toBe('opus');
  });

  it('bounds the task excerpt sent to Jev to OMC_JEV_EXCERPT_CHARS', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'model-routing';
    process.env.OMC_JEV_EXCERPT_CHARS = '50';
    const fetchFn = makeJevFetchStub();
    const pinned = makePinned();
    pinned.originalInput.prompt = 'x'.repeat(500);

    await recordModelRoutingShadow('Task', pinned, fetchFn as unknown as typeof fetch);

    const body = JSON.parse(String(vi.mocked(fetchFn).mock.calls[0][1]?.body)) as {
      state: { task: string };
    };
    expect(body.state.task.length).toBeLessThanOrEqual(50);
  });

  it('makes zero fetch calls and no log line when no key is set', async () => {
    delete process.env.TYPESAFE_API_KEY;
    process.env.OMC_JEV = 'model-routing';
    const fetchFn = makeJevFetchStub();
    const pinned = makePinned();

    const result = await recordModelRoutingShadow('Task', pinned, fetchFn as unknown as typeof fetch);

    expect(result.mode).toBe('off');
    expect(result.answer).toBe(pinned);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await waitForShadowLog(logDir, 100)).toBeNull();
  });

  it('makes zero fetch calls when OMC_JEV=off even with a key', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'off';
    const fetchFn = makeJevFetchStub();

    const result = await recordModelRoutingShadow('Task', makePinned(), fetchFn as unknown as typeof fetch);

    expect(result.mode).toBe('off');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await waitForShadowLog(logDir, 100)).toBeNull();
  });

  it('leaves the enforcement result byte-identical with and without Jev enabled', async () => {
    const toolInput: AgentInput = {
      description: 'Test task',
      prompt: 'Do something',
      subagent_type: 'oh-my-claudecode:executor',
      model: 'haiku',
    };

    // Jev disabled (no key).
    const withoutJev = processPreToolUse('Task', toolInput);

    // Jev enabled: key + grayscale for this point. The fire-and-forget shadow
    // call inside processPreToolUse degrades fast against the unroutable
    // endpoint and must not change the enforcement output.
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'model-routing';
    const withJev = processPreToolUse('Task', toolInput);

    expect(withJev).toEqual(withoutJev);
    expect((withJev.modifiedInput as AgentInput).model).toBe('haiku');
  });
});
