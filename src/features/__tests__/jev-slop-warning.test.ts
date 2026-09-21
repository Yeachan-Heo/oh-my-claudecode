import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordSlopWarningShadow } from '../jev-slop-warning.js';
import { resetJevResolverState } from '../../hooks/jev/index.js';

const TEST_KEY = 'test-key-123';
const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_TIMEOUT_MS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
] as const;

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetJevResolverState();
  logDir = mkdtempSync(join(tmpdir(), 'slop-jev-test-'));
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

function stubFetch(): { fetchFn: typeof fetch; calls: Array<{ body: string }> } {
  const calls: Array<{ body: string }> = [];
  const fetchFn = (async (_url: unknown, init?: unknown) => {
    const body = (init as RequestInit | undefined)?.body as string;
    calls.push({ body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          slop_advisory: { type: 'Noul', noul: true, confidence: 0.8 },
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

describe('slop-warning shadow judgment point (recorder only — no runtime wiring)', () => {
  it('with config, records a shadow line with the twin decision and the Jev Noul', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'slop-warning';
    const { fetchFn, calls } = stubFetch();
    const toolInput = { command: 'as a workaround, patch the shim' };

    const result = await recordSlopWarningShadow({
      warned: true,
      toolName: 'Bash',
      toolInput,
      fetchFn,
    });

    expect(result).toEqual({ answer: true, source: 'twin', mode: 'shadow' });

    const lines = await waitForLogLines(1);
    const entry = JSON.parse(lines[0]!) as {
      point: string;
      mode: string;
      heuristic: boolean;
      jev: { type: string } | null;
      state: Record<string, unknown>;
    };
    expect(entry.point).toBe('slop-warning');
    expect(entry.mode).toBe('shadow');
    expect(entry.heuristic).toBe(true);
    expect(entry.jev?.type).toBe('Noul');
    expect(entry.state).toMatchObject({
      tool_name: 'Bash',
      tool_input: toolInput,
      source: 'pre-tool-enforcer',
    });
    expect(calls).toHaveLength(1);
  });

  it('without configuration, zero fetch calls and the twin decision is unchanged', async () => {
    const { fetchFn, calls } = stubFetch();

    const result = await recordSlopWarningShadow({
      warned: false,
      toolName: 'Write',
      toolInput: { content: 'plain code' },
      fetchFn,
    });

    expect(result).toEqual({ answer: false, source: 'twin', mode: 'off' });
    expect(calls).toHaveLength(0);
    expect(existsSync(join(logDir, 'shadow.jsonl'))).toBe(false);
  });

  it('without OMC_JEV opt-in, a key alone triggers zero fetch calls (strict per-point opt-in)', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    const { fetchFn, calls } = stubFetch();

    const result = await recordSlopWarningShadow({
      warned: true,
      toolName: 'Bash',
      toolInput: {},
      fetchFn,
    });

    expect(result.mode).toBe('off');
    expect(result.answer).toBe(true);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(logDir, 'shadow.jsonl'))).toBe(false);
  });

  it('with OMC_JEV=off, zero fetch calls even with a key', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'off';
    const { fetchFn, calls } = stubFetch();

    const result = await recordSlopWarningShadow({
      warned: true,
      toolName: 'Bash',
      toolInput: {},
      fetchFn,
    });

    expect(result.mode).toBe('off');
    expect(calls).toHaveLength(0);
  });

  it('on never-resolving Jev fetch, the twin decision is unchanged (degraded line recorded)', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'slop-warning';
    process.env.OMC_JEV_TIMEOUT_MS = '20';
    const fetchFn = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;

    const result = await recordSlopWarningShadow({
      warned: true,
      toolName: 'Bash',
      toolInput: {},
      fetchFn,
    });

    expect(result).toEqual({ answer: true, source: 'twin', mode: 'shadow' });

    const lines = await waitForLogLines(1);
    const entry = JSON.parse(lines[0]!) as { mode: string; heuristic: unknown; jev: unknown };
    expect(entry.mode).toBe('degraded');
    expect(entry.heuristic).toBe(true);
    expect(entry.jev).toBeNull();
  });
});
