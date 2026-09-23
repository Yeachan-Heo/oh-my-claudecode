/**
 * Ticket 16: slop-warning judgment-point wiring in pre-tool-enforcer.
 *
 * Drives the real hook script end to end at the existing hook-script seam.
 * The channel's degraded path is acceptable wiring evidence: an unreachable
 * endpoint still lands a shadow-log line with the heuristic preserved.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/pre-tool-enforcer.mjs', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'jev-slop-wiring-'));

function makeGitTemp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: directory, stdio: 'pipe' });
  return directory;
}
afterEach(() => {
  try { rmSync(join(tmp, 'shadow.jsonl')); } catch { /* absent is fine */ }
});

function runEnforcer(input: Record<string, unknown>, env: Record<string, string>): Record<string, unknown> {
  const cwd = (input.cwd as string) || makeGitTemp('jev-slop-wiring-cwd-');
  const homeDir = join(cwd, '.test-home');
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
      NODE_ENV: 'test',
      DISABLE_OMC: '',
      OMC_SKIP_HOOKS: '',
      OMC_STATE_DIR: '',
      ...env,
    },
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

const SLOP_INPUT = {
  cwd: '',
  tool_name: 'Task',
  toolInput: {
    subagent_type: 'oh-my-claudecode:executor',
    description: 'Implement a fallback',
    prompt: 'Add a workaround if the normal architecture is hard.',
  },
};

let cwd = '';

beforeEach(() => {
  cwd = makeGitTemp('jev-slop-wiring-cwd-');
  SLOP_INPUT.cwd = cwd;
});

describe('pre-tool-enforcer slop-warning judgment wiring (ticket 16)', () => {
  it('lands a slop-warning shadow-log line with the heuristic preserved when opted in', () => {
    const output = runEnforcer(SLOP_INPUT, {
      TYPESAFE_API_KEY: 'test-key',
      OMC_JEV: 'slop-warning',
      OMC_JEV_LOG_DIR: tmp,
      OMC_JEV_ENDPOINT: 'http://127.0.0.1:9', // unreachable: degraded path is the evidence
    });
    // Advisory output unchanged (warns, non-blocking).
    const text = JSON.stringify(output);
    expect(text).toContain('SLOP WARNING');

    // Wait briefly for the detached child to write its log line.
    const logPath = join(tmp, 'shadow.jsonl');
    let line = '';
    for (let i = 0; i < 120 && !line; i++) {
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, 'utf8').trim();
        if (content) line = content.split('\n').pop() ?? '';
      }
      if (!line) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    expect(line).not.toBe('');
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({ point: 'slop-warning', mode: 'degraded', heuristic: true });
  });

  it('spawns nothing and logs nothing when env is absent', () => {
    const output = runEnforcer(SLOP_INPUT, {});
    expect(JSON.stringify(output)).toContain('SLOP WARNING');
    expect(existsSync(join(tmp, 'shadow.jsonl'))).toBe(false);
  });

  it('spawns nothing when the point is not opted in (other point named)', () => {
    runEnforcer(SLOP_INPUT, {
      TYPESAFE_API_KEY: 'test-key',
      OMC_JEV: 'task-size',
      OMC_JEV_LOG_DIR: tmp,
    });
    expect(existsSync(join(tmp, 'shadow.jsonl'))).toBe(false);
  });

  it('the all wildcard opts the point in', () => {
    runEnforcer(SLOP_INPUT, {
      TYPESAFE_API_KEY: 'test-key',
      OMC_JEV: 'all',
      OMC_JEV_LOG_DIR: tmp,
      OMC_JEV_ENDPOINT: 'http://127.0.0.1:9',
    });
    const logPath = join(tmp, 'shadow.jsonl');
    let line = '';
    for (let i = 0; i < 120 && !line; i++) {
      if (existsSync(logPath)) {
        const content = readFileSync(logPath, 'utf8').trim();
        if (content) line = content.split('\n').pop() ?? '';
      }
      if (!line) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    expect(line).not.toBe('');
    // The request reaches the child through the temp file, not argv: the state
    // it logs must still carry the tool input the enforcer inspected.
    expect(JSON.parse(line)).toMatchObject({
      point: 'slop-warning',
      state: { toolName: 'Task', toolInput: { subagent_type: 'oh-my-claudecode:executor' } },
    });
  });
});
