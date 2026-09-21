import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processCodeSimplifier } from '../index.js';
import { computeSimplifierTriggerTwin, recordSimplifierTriggerShadow } from '../jev-shadow.js';
import { resetJevResolverState } from '../../jev/index.js';

const TEST_KEY = 'test-key-123';
const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'OMC_JEV',
  'OMC_JEV_TIMEOUT_MS',
  'OMC_JEV_LOG_DIR',
  'OMC_JEV_ENDPOINT',
  'OMC_HOME',
] as const;

let logDir = '';
let homeDir = '';
let repoDir = '';
let stateDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetJevResolverState();
  logDir = mkdtempSync(join(tmpdir(), 'simplifier-jev-log-'));
  homeDir = mkdtempSync(join(tmpdir(), 'simplifier-jev-home-'));
  repoDir = mkdtempSync(join(tmpdir(), 'simplifier-jev-repo-'));
  stateDir = join(homeDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(homeDir, 'config.json'),
    JSON.stringify({ codeSimplifier: { enabled: true } }),
    'utf-8',
  );
  // Fixture git repo with one committed and one modified source file.
  const git = (args: string[], cwd = repoDir) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n', 'utf-8');
  git(['add', 'a.ts']);
  git(['commit', '-q', '-m', 'init']);
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 2; // duplicated speculative layer\n', 'utf-8');

  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OMC_HOME = homeDir;
  process.env.OMC_JEV_LOG_DIR = logDir;
  process.env.OMC_JEV_ENDPOINT = 'http://127.0.0.1:1/v1/systemone';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of [logDir, homeDir, repoDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
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
          simplification_worthy: { type: 'Noul', noul: true, confidence: 0.8 },
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

describe('simplifier-trigger shadow judgment point', () => {
  it('with config, records a shadow line with the fire-once twin and the Jev Noul', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'simplifier-trigger';
    const { fetchFn, calls } = stubFetch();
    const files = ['src/a.ts', 'src/b.ts'];

    const result = await recordSimplifierTriggerShadow({
      cwd: repoDir,
      stateDir,
      files,
      shouldBlock: true,
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
    expect(entry.point).toBe('simplifier-trigger');
    expect(entry.mode).toBe('shadow');
    expect(entry.heuristic).toBe(true);
    expect(entry.jev?.type).toBe('Noul');
    expect(entry.state).toMatchObject({ cwd: repoDir, files, source: 'code-simplifier-stop' });
    expect(calls).toHaveLength(1);
  });

  it('twin mirrors the fire-once heuristic side-effect-free', () => {
    expect(computeSimplifierTriggerTwin(stateDir, [])).toBe(false);
    expect(computeSimplifierTriggerTwin(stateDir, ['src/a.ts'])).toBe(true);

    // Marker present (already triggered) -> false, and no marker is written.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'code-simplifier-triggered.marker'), 'x', 'utf-8');
    expect(computeSimplifierTriggerTwin(stateDir, ['src/a.ts'])).toBe(false);
    expect(existsSync(join(stateDir, 'code-simplifier-triggered.marker'))).toBe(true);
  });

  it('without configuration, zero fetch calls and the twin is unchanged', async () => {
    const { fetchFn, calls } = stubFetch();

    const result = await recordSimplifierTriggerShadow({
      cwd: repoDir,
      stateDir,
      files: ['src/a.ts'],
      shouldBlock: true,
      fetchFn,
    });

    expect(result).toEqual({ answer: true, source: 'twin', mode: 'off' });
    expect(calls).toHaveLength(0);
    expect(existsSync(join(logDir, 'shadow.jsonl'))).toBe(false);
  });

  it('without OMC_JEV opt-in, a key alone triggers zero fetch calls (strict per-point opt-in)', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    const { fetchFn, calls } = stubFetch();

    const result = await recordSimplifierTriggerShadow({
      cwd: repoDir,
      stateDir,
      files: ['src/a.ts'],
      shouldBlock: true,
      fetchFn,
    });

    expect(result.mode).toBe('off');
    expect(calls).toHaveLength(0);
    expect(existsSync(join(logDir, 'shadow.jsonl'))).toBe(false);
  });

  it('host behavior is identical with and without Jev configured (degraded, no block change)', () => {
    const withoutJev = processCodeSimplifier(repoDir, stateDir);

    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'simplifier-trigger';
    process.env.OMC_JEV_TIMEOUT_MS = '20';

    // Clear the fire-once marker written by the first call so the second call
    // takes the same fresh path (the marker write is the only host-side state).
    rmSync(join(stateDir, 'code-simplifier-triggered.marker'), { force: true });
    const withJev = processCodeSimplifier(repoDir, stateDir);

    expect(withJev).toEqual(withoutJev);
    expect(withJev.shouldBlock).toBe(withoutJev.shouldBlock);
    expect(withJev.message).toBe(withoutJev.message);
  });

  it('on never-resolving Jev fetch, the twin is unchanged and a degraded line is logged', async () => {
    process.env.TYPESAFE_API_KEY = TEST_KEY;
    process.env.OMC_JEV = 'simplifier-trigger';
    process.env.OMC_JEV_TIMEOUT_MS = '20';
    const fetchFn = vi.fn(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;

    const result = await recordSimplifierTriggerShadow({
      cwd: repoDir,
      stateDir,
      files: ['src/a.ts'],
      shouldBlock: true,
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
