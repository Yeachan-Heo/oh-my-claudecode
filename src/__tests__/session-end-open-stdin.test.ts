import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const RUN_CJS = join(REPO_ROOT, 'scripts', 'run.cjs');
const SESSION_END_SCRIPTS = [
  ['session-end', join(REPO_ROOT, 'scripts', 'session-end.mjs')],
  ['wiki-session-end', join(REPO_ROOT, 'scripts', 'wiki-session-end.mjs')],
] as const;
const FALLBACK = JSON.stringify({ continue: true, suppressOutput: true });
const IS_CI = process.env.CI === 'true' || process.env.CI === '1';

// The regression: with an open, empty stdin the SessionEnd hooks still finish
// their own work at their read deadlines (~25ms first byte, ~100ms total), but
// destroying the worker's stdin stream cannot release the worker stdio
// MessagePort, so the worker idled until run.cjs's SessionEnd budget expired
// (~14.75s), the fallback output was discarded, and a bogus timeout diagnostic
// was reported. After the fix the hook exits promptly with its output intact
// and no diagnostic.
// The ceiling leaves ~10x headroom over the fixed path while staying far below
// the 14.75s production SessionEnd budget, so only the fix (never the budget)
// can produce a green run.
const CEILING_MS = IS_CI ? 4_000 : 2_500;

// Blank user-level env that would change what the spawned hooks do.
const HERMETIC_ENV: Record<string, string> = {
  DISABLE_OMC: '',
  OMC_SKIP_HOOKS: '',
  OMC_QUIET: '',
  OMC_DEBUG: '',
  OMC_DEBUG_HOOKS: '',
  OMC_STATE_DIR: '',
  OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: '',
};

interface ExitResult {
  elapsedMs: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

// Runs the hook through run.cjs with a stdin pipe that is never written to and
// never ended: open and empty for the whole lifetime of the hook process.
function runWithOpenEmptyStdin(script: string, cwd: string): Promise<ExitResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [RUN_CJS, script], {
      cwd,
      env: {
        ...process.env,
        ...HERMETIC_ENV,
        HOME: cwd,
        USERPROFILE: cwd,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
        CLAUDE_CONFIG_DIR: join(cwd, '.claude'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CEILING_MS);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        elapsedMs: Date.now() - startedAt,
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      });
    });
    // On purpose: child.stdin is never written to and never ended.
  });
}

describe('SessionEnd run.cjs prompt exit with an open, empty stdin', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
    }
    vi.unstubAllEnvs();
  });

  function createProject(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'omc-session-end-open-stdin-'));
    tempDirs.push(cwd);
    vi.stubEnv('HOME', cwd);
    vi.stubEnv('USERPROFILE', cwd);
    vi.stubEnv('OMC_STATE_DIR', '');
    // State markers so any accidental state write lands in the temp project,
    // never in the tester's real home.
    writeFileSync(join(cwd, '.omc-workspace'), '');
    writeFileSync(join(cwd, 'transcript.jsonl'), '');
    return cwd;
  }

  it.each(SESSION_END_SCRIPTS)('%s exits promptly with output intact when stdin stays open and empty', async (_name, script) => {
    const result = await runWithOpenEmptyStdin(script, createProject());

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThanOrEqual(CEILING_MS);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(FALLBACK);
  });
});
