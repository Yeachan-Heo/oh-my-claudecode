import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'scripts', 'budget-guard.mjs');
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// Fixture: a git repo whose .omc/state holds a ralph state file (active or
// not), plus a session transcript carrying assistant usage lines.
interface Fixture {
  dir: string;
  transcript: string;
}

function makeFixture(options: {
  active: boolean;
  usage: Array<Record<string, number>>;
  messageIds?: Array<string | undefined>;
  requestIds?: Array<string | undefined>;
  recordTypes?: Array<string | undefined>;
}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'omc-budget-guard-'));
  fixtures.push(dir);
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  const statePath = join(dir, '.omc', 'state', 'ralph-state.json');
  mkdirSync(join(statePath, '..'), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ active: options.active, session_id: 'budget-test' }, null, 2));
  const transcript = join(dir, 'transcript.jsonl');
  const lines = options.usage.map((usage, i) =>
    JSON.stringify({
      type: options.recordTypes?.[i] ?? 'assistant',
      message: { role: 'assistant', id: options.messageIds?.[i], usage },
      requestId: options.requestIds?.[i],
      seq: i,
    }),
  );
  writeFileSync(transcript, `${lines.join('\n')}\n`);
  return { dir, transcript };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(payload: Record<string, unknown>, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function payload(fixture: Fixture, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { cwd: fixture.dir, transcript_path: fixture.transcript, ...extra };
}

function shadowLog(fixture: Fixture): Array<{ outcome: string; mode: string; detail: string }> {
  const logPath = join(fixture.dir, '.omc', 'state', 'enforcement', 'shadow.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('budget-guard hook', () => {
  it('blocks at 100% in active mode with the budget-report contract', async () => {
    const fx = makeFixture({ active: true, usage: [{ input_tokens: 700, output_tokens: 350 }] });
    const result = await runHook(payload(fx), { OMC_RUN_BUDGET_TOKENS: '1000', OMC_BUDGET_ENFORCE: 'active' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Run budget exhausted');
    expect(result.stderr).toContain('105%');
    expect(result.stderr).toContain('budget report');
    expect(result.stderr).toContain('resumable');
    const log = shadowLog(fx);
    expect(log.at(-1)?.outcome).toBe('block');
    expect(log.at(-1)?.mode).toBe('ralph');
  });

  it('warns at 90-99% in active mode without blocking', async () => {
    const fx = makeFixture({ active: true, usage: [{ input_tokens: 920, output_tokens: 0 }] });
    const result = await runHook(payload(fx), { OMC_RUN_BUDGET_TOKENS: '1000', OMC_BUDGET_ENFORCE: 'active' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[BUDGET]');
    expect(result.stdout).toContain('92%');
  });

  it('counts cache tokens alongside input/output', async () => {
    const fx = makeFixture({
      active: true,
      usage: [{ input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 100 }],
    });
    const result = await runHook(payload(fx), { OMC_RUN_BUDGET_TOKENS: '1000', OMC_BUDGET_ENFORCE: 'active' });
    expect(result.code).toBe(2);
  });

  it('counts repeated assistant message IDs once and ignores non-assistant records', async () => {
    const fx = makeFixture({
      active: true,
      usage: [
        { input_tokens: 500, output_tokens: 0 },
        { input_tokens: 500, output_tokens: 0 },
        { input_tokens: 5000, output_tokens: 0 },
      ],
      messageIds: ['message-1', 'message-1', 'message-2'],
      recordTypes: ['assistant', 'assistant', 'user'],
    });
    const result = await runHook(payload(fx), { OMC_RUN_BUDGET_TOKENS: '1000', OMC_BUDGET_ENFORCE: 'active' });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(shadowLog(fx).at(-1)?.detail).toContain('~500/1000');
  });

  it('uses the latest usage snapshot for a repeated assistant message', async () => {
    const fx = makeFixture({
      active: true,
      usage: [
        { input_tokens: 100, output_tokens: 100 },
        { input_tokens: 100, output_tokens: 900 },
      ],
      messageIds: ['message-2', 'message-2'],
    });
    const result = await runHook(payload(fx), { OMC_RUN_BUDGET_TOKENS: '1000', OMC_BUDGET_ENFORCE: 'active' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('~1000 of 1000 tokens');
    expect(shadowLog(fx).at(-1)?.detail).toContain('~1000/1000');
  });

  it('falls back to request IDs and keeps unidentified records separate', async () => {
    const duplicateRequest = makeFixture({
      active: true,
      usage: [{ input_tokens: 400, output_tokens: 0 }, { input_tokens: 400, output_tokens: 0 }],
      requestIds: ['request-1', 'request-1'],
    });
    const requestResult = await runHook(payload(duplicateRequest), {
      OMC_RUN_BUDGET_TOKENS: '1000',
      OMC_BUDGET_ENFORCE: 'active',
    });
    expect(requestResult.code).toBe(0);
    expect(shadowLog(duplicateRequest).at(-1)?.detail).toContain('~400/1000');

    const unidentified = makeFixture({
      active: true,
      usage: [{ input_tokens: 500, output_tokens: 0 }, { input_tokens: 500, output_tokens: 0 }],
    });
    const unidentifiedResult = await runHook(payload(unidentified), {
      OMC_RUN_BUDGET_TOKENS: '1000',
      OMC_BUDGET_ENFORCE: 'active',
    });
    expect(unidentifiedResult.code).toBe(2);
    expect(unidentifiedResult.stderr).toContain('~1000 of 1000 tokens');
  });

  it.each(['stop_hook_active', 'stopHookActive'])('passes on Stop re-entry via %s', async (flag) => {
    const fx = makeFixture({ active: true, usage: [{ input_tokens: 700, output_tokens: 500 }] });
    const result = await runHook(payload(fx, { [flag]: true }), {
      OMC_RUN_BUDGET_TOKENS: '1000',
      OMC_BUDGET_ENFORCE: 'active',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(shadowLog(fx).at(-1)?.outcome).toBe('pass');
    expect(shadowLog(fx).at(-1)?.detail).toContain('re-entry');
  });

  it('stays silent in shadow mode while logging the judgment', async () => {
    const fx = makeFixture({ active: true, usage: [{ input_tokens: 900, output_tokens: 200 }] });
    const result = await runHook(payload(fx), { OMC_RUN_BUDGET_TOKENS: '1000' });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
    const log = shadowLog(fx);
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe('warn');
    expect(log[0].mode).toBe('ralph');
  });

  it('does nothing without OMC_RUN_BUDGET_TOKENS', async () => {
    const fx = makeFixture({ active: true, usage: [{ input_tokens: 99999, output_tokens: 99999 }] });
    const result = await runHook(payload(fx), {});
    expect(result.code).toBe(0);
    expect(shadowLog(fx)).toEqual([]);
  });

  it('does nothing when OMC_BUDGET_ENFORCE=off', async () => {
    const fx = makeFixture({ active: true, usage: [{ input_tokens: 5000, output_tokens: 0 }] });
    const result = await runHook(payload(fx), { OMC_RUN_BUDGET_TOKENS: '1000', OMC_BUDGET_ENFORCE: 'off' });
    expect(result.code).toBe(0);
    expect(shadowLog(fx)).toEqual([]);
  });

  it('ignores inactive mode state', async () => {
    const fx = makeFixture({ active: false, usage: [{ input_tokens: 5000, output_tokens: 0 }] });
    const result = await runHook(payload(fx), { OMC_RUN_BUDGET_TOKENS: '1000', OMC_BUDGET_ENFORCE: 'active' });
    expect(result.code).toBe(0);
    expect(shadowLog(fx)).toEqual([]);
  });

  it('degrades to a logged pass when the transcript is missing', async () => {
    const fx = makeFixture({ active: true, usage: [{ input_tokens: 10, output_tokens: 10 }] });
    const result = await runHook({ cwd: fx.dir, transcript_path: join(fx.dir, 'missing.jsonl') }, { OMC_RUN_BUDGET_TOKENS: '1000', OMC_BUDGET_ENFORCE: 'active' });
    expect(result.code).toBe(0);
    const log = shadowLog(fx);
    expect(log.at(-1)?.outcome).toBe('degraded');
  });
});
