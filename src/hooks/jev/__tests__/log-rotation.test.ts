import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Lets one test make every rename fail, as a locked file or a lost race does.
const fsControl = vi.hoisted(() => ({ failRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      if (fsControl.failRename) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return actual.renameSync(...args);
    }) as typeof actual.renameSync,
  };
});

import { parseJevConfig } from '../config.js';
import { resetJevResolverState, resolveJudgment, rotateJevLog } from '../resolver.js';
import type { JevQuestions } from '../types.js';

const ENV_KEYS = ['TYPESAFE_API_KEY', 'OMC_JEV', 'OMC_JEV_LOG_DIR', 'OMC_JEV_LOG_MAX_MB', 'OMC_JEV_ENDPOINT', 'OMC_JEV_QUIET'] as const;
const QUESTIONS: JevQuestions = {
  route: { type: 'choice', criteria: { haiku: 'simple', sonnet: 'standard', opus: 'complex' } },
};
const MIB = 1024 * 1024;
const ROTATED = /^shadow-\d{8}-\d{6}-\d+\.jsonl$/;

let logDir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  resetJevResolverState();
  logDir = await mkdtemp(join(tmpdir(), 'jev-rotation-test-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.OMC_JEV = 'model-routing';
  process.env.OMC_JEV_LOG_DIR = logDir;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(logDir, { recursive: true, force: true });
});

const okFetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => ({ answers: { route: { type: 'choice', choice: 'opus' } } }),
})) as unknown as typeof fetch;

function filler(bytes: number): string {
  const line = JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', point: 'intent', mode: 'shadow', pad: 'x'.repeat(40) }) + '\n';
  return line.repeat(Math.ceil(bytes / line.length));
}

async function judge(): Promise<void> {
  await resolveJudgment({ point: 'model-routing', state: { prompt: 'hi' }, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: okFetch });
}

describe('Jev log rotation (TypeScript resolver)', () => {
  it('parses OMC_JEV_LOG_MAX_MB into a byte limit, 0 when unset or invalid', () => {
    expect(parseJevConfig({ OMC_JEV_LOG_DIR: logDir }).logMaxBytes).toBe(0);
    expect(parseJevConfig({ OMC_JEV_LOG_DIR: logDir, OMC_JEV_LOG_MAX_MB: '50' }).logMaxBytes).toBe(50 * MIB);
    expect(parseJevConfig({ OMC_JEV_LOG_DIR: logDir, OMC_JEV_LOG_MAX_MB: '0' }).logMaxBytes).toBe(0);
    expect(parseJevConfig({ OMC_JEV_LOG_DIR: logDir, OMC_JEV_LOG_MAX_MB: '1.5' }).logMaxBytes).toBe(0);
  });

  it('without OMC_JEV_LOG_MAX_MB a shadow.jsonl above 1 MiB keeps growing exactly as before', async () => {
    const before = filler(MIB + 1);
    await writeFile(join(logDir, 'shadow.jsonl'), before);
    await judge();
    expect(await readdir(logDir)).toEqual(['shadow.jsonl']);
    const after = await readFile(join(logDir, 'shadow.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(JSON.parse(after.slice(before.length))).toMatchObject({ point: 'model-routing', mode: 'shadow' });
  });

  it('with OMC_JEV_LOG_MAX_MB=1 a file above 1 MiB is renamed and the new line starts a new shadow.jsonl', async () => {
    process.env.OMC_JEV_LOG_MAX_MB = '1';
    const before = filler(MIB + 1);
    await writeFile(join(logDir, 'shadow.jsonl'), before);
    await judge();
    const rotated = (await readdir(logDir)).filter((name) => ROTATED.test(name));
    expect(rotated).toHaveLength(1);
    expect(await readFile(join(logDir, rotated[0]), 'utf8')).toBe(before);
    const lines = (await readFile(join(logDir, 'shadow.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ point: 'model-routing', mode: 'shadow' });
  });

  it('with OMC_JEV_LOG_MAX_MB=1 a file below the limit is appended in place', async () => {
    process.env.OMC_JEV_LOG_MAX_MB = '1';
    const before = filler(1000);
    await writeFile(join(logDir, 'shadow.jsonl'), before);
    await judge();
    expect(await readdir(logDir)).toEqual(['shadow.jsonl']);
    expect((await readFile(join(logDir, 'shadow.jsonl'), 'utf8')).startsWith(before)).toBe(true);
  });

  it('rotates degraded lines too', async () => {
    process.env.OMC_JEV_LOG_MAX_MB = '1';
    await writeFile(join(logDir, 'shadow.jsonl'), filler(MIB + 1));
    const failing = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const result = await resolveJudgment({ point: 'model-routing', state: {}, questions: QUESTIONS, twin: () => 'sonnet', fetchFn: failing });
    expect(result.mode).toBe('degraded');
    expect((await readdir(logDir)).filter((name) => ROTATED.test(name))).toHaveLength(1);
    expect(JSON.parse((await readFile(join(logDir, 'shadow.jsonl'), 'utf8')).trim())).toMatchObject({ mode: 'degraded', jev: null });
  });

  it('rotates on the non-blocking shadow path', async () => {
    process.env.OMC_JEV_LOG_MAX_MB = '1';
    await writeFile(join(logDir, 'shadow.jsonl'), filler(MIB + 1));
    const result = await resolveJudgment({ point: 'model-routing', state: {}, questions: QUESTIONS, twin: () => 'sonnet', blocking: false, fetchFn: okFetch });
    expect(result).toMatchObject({ source: 'twin', mode: 'shadow' });
    await vi.waitFor(async () => {
      expect((await readdir(logDir)).filter((name) => ROTATED.test(name))).toHaveLength(1);
      expect((await readFile(join(logDir, 'shadow.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    }, { timeout: 5000, interval: 25 });
  });

  it('a failed rename is ignored and the line is still appended', async () => {
    process.env.OMC_JEV_LOG_MAX_MB = '1';
    const before = filler(MIB + 1);
    await writeFile(join(logDir, 'shadow.jsonl'), before);
    fsControl.failRename = true;
    try {
      await judge();
    } finally {
      fsControl.failRename = false;
    }
    expect(await readdir(logDir)).toEqual(['shadow.jsonl']);
    const after = await readFile(join(logDir, 'shadow.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(JSON.parse(after.slice(before.length))).toMatchObject({ point: 'model-routing', mode: 'shadow' });
  });

  it('rotateJevLog names the target with the UTC time and the process ID and never overwrites it', async () => {
    const path = join(logDir, 'shadow.jsonl');
    const now = new Date('2026-11-09T14:30:05.123Z');
    const target = `shadow-20261109-143005-${process.pid}.jsonl`;
    await writeFile(path, 'x'.repeat(2048));
    rotateJevLog(path, 1024, now);
    expect(await readdir(logDir)).toEqual([target]);
    await writeFile(path, 'y'.repeat(2048));
    rotateJevLog(path, 1024, now);
    expect((await readdir(logDir)).sort()).toEqual(['shadow.jsonl', target].sort());
    expect(await readFile(join(logDir, target), 'utf8')).toBe('x'.repeat(2048));
    expect(() => rotateJevLog(join(logDir, 'missing.jsonl'), 1024, now)).not.toThrow();
    expect(() => rotateJevLog(path, 0, now)).not.toThrow();
    expect(await readFile(path, 'utf8')).toBe('y'.repeat(2048));
  });
});
