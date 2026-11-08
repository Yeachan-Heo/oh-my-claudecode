import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveOmcStateRoot } from '../../scripts/lib/state-root.mjs';

const root = process.cwd();
const script = join(root, 'scripts', 'stale-run-reporter.mjs');
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// The state resolver falls back to the home .omc root when the directory is
// not inside a git repo — fixtures must be git repos so the hook scans the
// fixture's state root, not the developer's real one.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-stale-run-'));
  fixtures.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

async function writeModeState(
  dir: string,
  mode: string,
  state: Record<string, unknown>,
  sessionId?: string,
  ageHours?: number,
  mtimeAt?: Date,
): Promise<string> {
  const omcRoot = await resolveOmcStateRoot(dir);
  const statePath = sessionId
    ? join(omcRoot, 'state', 'sessions', sessionId, `${mode}-state.json`)
    : join(omcRoot, 'state', `${mode}-state.json`);
  mkdirSync(join(statePath, '..'), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (ageHours !== undefined) {
    const past = mtimeAt ?? new Date(Date.now() - ageHours * 3600_000);
    utimesSync(statePath, past, past);
  }
  return statePath;
}

interface RunResult {
  stdout: string;
  parsed: {
    continue?: boolean;
    suppressOutput?: boolean;
    hookSpecificOutput?: { additionalContext?: string };
  };
}

function runReporter(
  payload: Record<string, unknown>,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: (payload.cwd as string) ?? root,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, parsed: JSON.parse(stdout) }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('stale-run reporter hook', () => {
  it('reports a stale legacy active state as advisory context', async () => {
    const dir = fixture();
    const statePath = await writeModeState(
      dir,
      'ralph',
      { active: true, iteration: 3 },
      undefined,
      9,
    );
    const before = readFileSync(statePath, 'utf8');
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('ralph');
    expect(ctx).toContain('~9h');
    expect(ctx).toContain('Re-kicking is a human decision');
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('reports a stale state waiting for confirmation without claiming it died', async () => {
    const dir = fixture();
    // A parked run's marker shares the mtime of the write that set it, even
    // when that write is nine hours old.
    const staleAt = new Date(Date.now() - 9 * 3600_000);
    const setAt = staleAt.toISOString();
    await writeModeState(
      dir,
      'ralph',
      {
        active: true,
        awaiting_confirmation: true,
        awaiting_confirmation_set_at: setAt,
      },
      undefined,
      9,
      staleAt,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[AWAITING CONFIRMATION]');
    expect(ctx).toContain(
      `waiting for your confirmation since ${setAt}, no activity for ~9h`,
    );
    expect(ctx).not.toContain('died');
    expect(ctx).not.toContain('[STALE RUN]');
    expect(ctx).not.toContain('To reclaim');
  });

  it('reports a session-scoped run waiting for confirmation with its session id', async () => {
    const dir = fixture();
    const staleAt = new Date(Date.now() - 9 * 3600_000);
    const setAt = staleAt.toISOString();
    await writeModeState(
      dir,
      'ralph',
      { active: true, awaiting_confirmation: true, awaiting_confirmation_set_at: setAt },
      'sess-waiting-1',
      9,
      staleAt,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[AWAITING CONFIRMATION]');
    expect(ctx).toContain('ralph (session sess-waiting-1)');
    expect(ctx).toContain(`since ${setAt}`);
    expect(ctx).not.toContain('died');
    expect(ctx).not.toContain('[STALE RUN]');
  });

  it('treats a marker superseded by a later write as a crashed run', async () => {
    const dir = fixture();
    // The marker is an hour older than the file's last mtime: the run wrote
    // again after the prompt, so the stale flag is a leftover, not proof of a
    // parked prompt.
    const setAt = new Date(Date.now() - 10 * 3600_000).toISOString();
    await writeModeState(
      dir,
      'ralph',
      {
        active: true,
        awaiting_confirmation: true,
        awaiting_confirmation_set_at: setAt,
      },
      undefined,
      9,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('died');
    expect(ctx).not.toContain('[AWAITING CONFIRMATION]');
  });

  it('treats a malformed confirmation timestamp as a crashed run', async () => {
    const dir = fixture();
    await writeModeState(
      dir,
      'ralph',
      {
        active: true,
        awaiting_confirmation: true,
        awaiting_confirmation_set_at: 'not-a-date',
      },
      undefined,
      9,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(result.parsed.continue).toBe(true);
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('ralph');
    expect(ctx).not.toContain('[AWAITING CONFIRMATION]');
  });

  it('treats a future confirmation timestamp as a crashed run', async () => {
    const dir = fixture();
    const setAt = new Date(Date.now() + 9 * 3600_000).toISOString();
    await writeModeState(
      dir,
      'ralph',
      {
        active: true,
        awaiting_confirmation: true,
        awaiting_confirmation_set_at: setAt,
      },
      undefined,
      9,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(result.parsed.continue).toBe(true);
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('ralph');
    expect(ctx).not.toContain('[AWAITING CONFIRMATION]');
  });

  it('treats a null confirmation timestamp as a crashed run', async () => {
    const dir = fixture();
    await writeModeState(
      dir,
      'ralph',
      {
        active: true,
        awaiting_confirmation: true,
        awaiting_confirmation_set_at: null,
      },
      undefined,
      9,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(result.parsed.continue).toBe(true);
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('ralph');
    expect(ctx).not.toContain('[AWAITING CONFIRMATION]');
  });

  it('treats a numeric confirmation timestamp as a crashed run', async () => {
    const dir = fixture();
    await writeModeState(
      dir,
      'ralph',
      {
        active: true,
        awaiting_confirmation: true,
        awaiting_confirmation_set_at: 12345,
      },
      undefined,
      9,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(result.parsed.continue).toBe(true);
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('ralph');
    expect(ctx).not.toContain('[AWAITING CONFIRMATION]');
  });

  it('treats an absent confirmation timestamp as a crashed run', async () => {
    const dir = fixture();
    await writeModeState(
      dir,
      'ralph',
      {
        active: true,
        awaiting_confirmation: true,
      },
      undefined,
      9,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(result.parsed.continue).toBe(true);
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('ralph');
    expect(ctx).not.toContain('[AWAITING CONFIRMATION]');
  });

  it('reports crashed and waiting runs side by side without mixing groups', async () => {
    const dir = fixture();
    const waitingAt = new Date(Date.now() - 3 * 3600_000);
    const waitingSetAt = waitingAt.toISOString();
    await writeModeState(
      dir,
      'team',
      {
        active: true,
        awaiting_confirmation: true,
        awaiting_confirmation_set_at: waitingSetAt,
      },
      undefined,
      3,
      waitingAt,
    );
    await writeModeState(dir, 'ralph', { active: true }, undefined, 5);

    const result = await runReporter(
      { cwd: dir },
      { OMC_STALE_RUN_HOURS: '1' },
    );
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(result.parsed.continue).toBe(true);
    expect(ctx).toContain('[STALE RUN] 1 ');
    expect(ctx).toContain('[AWAITING CONFIRMATION] 1 ');

    // Each entry belongs to exactly one group: ralph crashed, team waiting.
    const staleStart = ctx.indexOf('[STALE RUN]');
    const awaitingStart = ctx.indexOf('[AWAITING CONFIRMATION]');
    expect(staleStart).toBeGreaterThanOrEqual(0);
    expect(awaitingStart).toBeGreaterThan(staleStart);
    const staleBlock = ctx.slice(staleStart, awaitingStart);
    const awaitingBlock = ctx.slice(awaitingStart);
    expect(staleBlock).toContain('ralph');
    expect(staleBlock).not.toContain('team');
    expect(awaitingBlock).toContain('team');
    expect(awaitingBlock).not.toContain('ralph');
    expect(awaitingBlock).toContain(waitingSetAt);
    // A parked run must not inherit the crashed group's death or reclaim wording.
    expect(awaitingBlock).not.toContain('died');
    expect(awaitingBlock).not.toContain('To reclaim');
  });

  it('still reports a stale active state without the confirmation flag', async () => {
    const dir = fixture();
    await writeModeState(
      dir,
      'ralph',
      { active: true, awaiting_confirmation: false },
      undefined,
      9,
    );
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('[STALE RUN]');
    expect(ctx).toContain('ralph');
  });

  it('reports a stale session-scoped state with its session id', async () => {
    const dir = fixture();
    await writeModeState(dir, 'autopilot', { active: true }, 'sess-dead-1', 5);
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('autopilot (session sess-dead-1)');
  });

  it('stays silent when every active state is fresh', async () => {
    const dir = fixture();
    await writeModeState(dir, 'ralph', { active: true }, undefined, 0.1);
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
    expect(result.parsed.hookSpecificOutput).toBeUndefined();
  });

  it('ignores inactive state files', async () => {
    const dir = fixture();
    await writeModeState(dir, 'ralph', { active: false }, undefined, 99);
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('ignores malformed state files instead of failing', async () => {
    const dir = fixture();
    const statePath = join(
      await resolveOmcStateRoot(dir),
      'state',
      'team-state.json',
    );
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, '{ not json');
    const result = await runReporter({ cwd: dir });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('excludes the current session own state from the report', async () => {
    const dir = fixture();
    await writeModeState(dir, 'autopilot', { active: true }, 'sess-current', 9);
    const result = await runReporter({ cwd: dir, session_id: 'sess-current' });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('excludes a legacy state owned by the current session', async () => {
    const dir = fixture();
    await writeModeState(
      dir,
      'ralph',
      { active: true, session_id: 'sess-current' },
      undefined,
      9,
    );
    const result = await runReporter({ cwd: dir, session_id: 'sess-current' });
    expect(result.parsed.suppressOutput).toBe(true);
  });

  it('sorts entries most-stale first', async () => {
    const dir = fixture();
    await writeModeState(dir, 'ralph', { active: true }, undefined, 4);
    await writeModeState(dir, 'team', { active: true }, undefined, 30);
    const result = await runReporter({ cwd: dir });
    const ctx = result.parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx.indexOf('team')).toBeLessThan(ctx.indexOf('ralph'));
  });
});
