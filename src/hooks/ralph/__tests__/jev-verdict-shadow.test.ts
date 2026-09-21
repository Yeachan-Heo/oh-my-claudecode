import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetJevResolverState } from '../../jev/index.js';
import { applyRalphVerdictShadow } from '../jev-shadow.js';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_TIMEOUT_MS',
  'OMC_JEV_MAX_REQUESTS',
  'OMC_JEV_EXCERPT_CHARS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
] as const;

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  logDir = await mkdtemp(join(tmpdir(), 'jev-verdict-test-'));
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

function stubFetch(): { fetchFn: typeof fetch; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const body = (init as RequestInit | undefined)?.body as string;
    calls.push({ url: url as string, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: { completion_criteria_met: { type: 'Noul', noul: true, confidence: 0.9 } } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function readLogLines(): Promise<string[]> {
  const raw = await readFile(join(logDir, 'shadow.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean);
}

describe('applyRalphVerdictShadow', () => {
  it('with TYPESAFE_API_KEY + OMC_JEV=ralph-verdict, records a shadow line with the twin verdict and the Jev Noul', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'ralph-verdict';
    const { fetchFn, calls } = stubFetch();

    const approved = await applyRalphVerdictShadow({
      verdict: true,
      prdContext: 'US-1: the hook exits 0',
      claim: 'all stories complete',
      criticMode: 'architect',
      fetchFn,
    });
    expect(approved).toBe(true);

    const rejected = await applyRalphVerdictShadow({
      verdict: false,
      prdContext: 'US-1: the hook exits 0',
      claim: 'all stories complete',
      fetchFn,
    });
    expect(rejected).toBe(false);

    // One request per verdict; state carries the verdict, the bounded
    // criteria excerpt, and claim metadata only.
    expect(calls).toHaveLength(2);
    const states = calls.map((call) => (JSON.parse(call.body) as { state: Record<string, unknown> }).state);
    expect(states[0]).toEqual({
      verdict: true,
      prd_criteria: 'US-1: the hook exits 0',
      claim: 'all stories complete',
      critic_mode: 'architect',
    });
    expect(states[1]).toEqual({
      verdict: false,
      prd_criteria: 'US-1: the hook exits 0',
      claim: 'all stories complete',
      critic_mode: null,
    });

    const lines = await readLogLines();
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as {
      point: string;
      mode: string;
      heuristic: boolean;
      jev: { type: string } | null;
    });
    for (const entry of parsed) {
      expect(entry.point).toBe('ralph-verdict');
      expect(entry.mode).toBe('shadow');
      expect(entry.jev?.type).toBe('Noul');
    }
    expect(parsed.map((entry) => entry.heuristic)).toEqual([true, false]);
  });

  it('without configuration, zero fetch calls and the verdict is unchanged', async () => {
    const { fetchFn, calls } = stubFetch();
    const result = await applyRalphVerdictShadow({
      verdict: true,
      prdContext: 'US-1: the hook exits 0',
      claim: 'all stories complete',
      fetchFn,
    });

    expect(result).toBe(true);
    expect(calls).toHaveLength(0);
    await expect(readLogLines()).rejects.toThrow();
  });

  it('without OMC_JEV opt-in, a key alone triggers zero fetch calls (strict per-point opt-in)', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    const { fetchFn, calls } = stubFetch();
    const result = await applyRalphVerdictShadow({
      verdict: false,
      prdContext: 'US-1: the hook exits 0',
      claim: 'all stories complete',
      fetchFn,
    });

    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
    await expect(readLogLines()).rejects.toThrow();
  });

  it('on Jev timeout the verdict is unchanged and a degraded line is logged', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-123';
    process.env.OMC_JEV = 'ralph-verdict';
    process.env.OMC_JEV_TIMEOUT_MS = '20';
    const fetchFn = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const result = await applyRalphVerdictShadow({
      verdict: true,
      prdContext: 'US-1: the hook exits 0',
      claim: 'all stories complete',
      fetchFn,
    });

    expect(result).toBe(true);
    const lines = await readLogLines();
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as { mode: string; heuristic: boolean; jev: unknown };
    expect(entry.mode).toBe('degraded');
    expect(entry.heuristic).toBe(true);
    expect(entry.jev).toBeNull();
  });
});
