import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';

const CJS_SCRIPT = resolve(__dirname, '../../../../scripts/persistent-mode.cjs');

function makeRalphSession(tempDir: string, sessionId: string): string {
  const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    join(stateDir, 'ralph-state.json'),
    JSON.stringify(
      {
        active: true,
        iteration: 10,
        max_iterations: 10,
        started_at: new Date().toISOString(),
        prompt: 'Finish all work',
        session_id: sessionId,
        project_path: tempDir,
        linked_ultrawork: true
      },
      null,
      2
    )
  );

  return stateDir;
}

describe('persistent-mode cancel race guard (issue #921)', () => {
  it.each([
    '/oh-my-claudecode:cancel',
    '/oh-my-claudecode:cancel --force'
  ])('should not re-enforce while explicit cancel prompt is "%s"', async (cancelPrompt: string) => {
    const sessionId = `session-921-${cancelPrompt.includes('force') ? 'force' : 'normal'}`;
    const tempDir = mkdtempSync(join(tmpdir(), 'persistent-cancel-race-'));

    try {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      const stateDir = makeRalphSession(tempDir, sessionId);

      const result = await checkPersistentModes(sessionId, tempDir, {
        prompt: cancelPrompt
      });

      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe('none');

      const ralphState = JSON.parse(
        readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8')
      ) as { iteration: number; max_iterations: number };
      expect(ralphState.iteration).toBe(10);
      expect(ralphState.max_iterations).toBe(10);
      expect(existsSync(join(stateDir, 'ultrawork-state.json'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should not trigger ralph max-iteration extension or ultrawork self-heal when cancel signal exists', async () => {
    const sessionId = 'session-921-cancel-signal';
    const tempDir = mkdtempSync(join(tmpdir(), 'persistent-cancel-signal-'));

    try {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      const stateDir = makeRalphSession(tempDir, sessionId);

      writeFileSync(
        join(stateDir, 'cancel-signal-state.json'),
        JSON.stringify(
          {
            active: true,
            requested_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 30_000).toISOString(),
            source: 'test'
          },
          null,
          2
        )
      );

      const result = await checkPersistentModes(sessionId, tempDir, {
        stop_reason: 'end_turn'
      });

      expect(result.shouldBlock).toBe(false);
      expect(result.mode).toBe('none');

      const ralphState = JSON.parse(
        readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8')
      ) as { iteration: number; max_iterations: number };
      expect(ralphState.iteration).toBe(10);
      expect(ralphState.max_iterations).toBe(10);

      expect(existsSync(join(stateDir, 'ultrawork-state.json'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('persistent-mode.cjs cancel-signal check (issue #1058)', () => {
  function runCjsHook(input: Record<string, unknown>): Record<string, unknown> {
    const stdout = execFileSync(process.execPath, [CJS_SCRIPT], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 5000,
    });
    // Parse the last JSON line (the script may emit multiple lines)
    const lines = stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  }

  it('should return continue:true when cancel-signal-state.json is active (ultrawork)', () => {
    const sessionId = 'session-1058-cjs-ultrawork';
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-cancel-signal-uw-'));

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      // Write active ultrawork state
      writeFileSync(
        join(stateDir, 'ultrawork-state.json'),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: 'test task',
          session_id: sessionId,
          project_path: tempDir,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      // Write active cancel signal
      writeFileSync(
        join(stateDir, 'cancel-signal-state.json'),
        JSON.stringify({
          requested_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 30_000).toISOString(),
          source: 'test',
        })
      );

      const result = runCjsHook({
        cwd: tempDir,
        sessionId,
        stop_reason: 'end_turn',
      });

      expect(result.continue).toBe(true);

      // Ultrawork state should NOT have been incremented
      const uwState = JSON.parse(readFileSync(join(stateDir, 'ultrawork-state.json'), 'utf-8'));
      expect(uwState.reinforcement_count).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return continue:true when cancel-signal-state.json is active (ralph)', () => {
    const sessionId = 'session-1058-cjs-ralph';
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-cancel-signal-ralph-'));

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      // Write active ralph state at max iteration
      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          iteration: 10,
          max_iterations: 10,
          started_at: new Date().toISOString(),
          prompt: 'Finish all work',
          session_id: sessionId,
          project_path: tempDir,
          linked_ultrawork: true,
        })
      );

      // Write active cancel signal
      writeFileSync(
        join(stateDir, 'cancel-signal-state.json'),
        JSON.stringify({
          requested_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 30_000).toISOString(),
          source: 'test',
        })
      );

      const result = runCjsHook({
        cwd: tempDir,
        sessionId,
        stop_reason: 'end_turn',
      });

      expect(result.continue).toBe(true);

      // Ralph state should NOT have been modified
      const ralphState = JSON.parse(readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8'));
      expect(ralphState.iteration).toBe(10);
      expect(ralphState.max_iterations).toBe(10);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should block when ultrawork is active but NO cancel signal exists', () => {
    const sessionId = 'session-1058-cjs-no-cancel';
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-no-cancel-signal-'));

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      // Write active ultrawork state (no cancel signal)
      writeFileSync(
        join(stateDir, 'ultrawork-state.json'),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: 'test task',
          session_id: sessionId,
          project_path: tempDir,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      const result = runCjsHook({
        cwd: tempDir,
        sessionId,
        stop_reason: 'end_turn',
      });

      // Should block (decision: "block") because ultrawork is active and no cancel signal
      expect(result.decision).toBe('block');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return continue:true when cancel signal has only requested_at (no expires_at)', () => {
    const sessionId = 'session-1058-cjs-fallback-ttl';
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-cancel-fallback-'));

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      // Write active ultrawork state
      writeFileSync(
        join(stateDir, 'ultrawork-state.json'),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: 'test task',
          session_id: sessionId,
          project_path: tempDir,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      // Write cancel signal with ONLY requested_at (no expires_at) — should use 30s TTL fallback
      writeFileSync(
        join(stateDir, 'cancel-signal-state.json'),
        JSON.stringify({
          requested_at: new Date().toISOString(),
          source: 'test',
        })
      );

      const result = runCjsHook({
        cwd: tempDir,
        sessionId,
        stop_reason: 'end_turn',
      });

      expect(result.continue).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should NOT honor expired cancel signals', () => {
    const sessionId = 'session-1058-cjs-expired';
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-expired-cancel-'));

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      // Write active ultrawork state
      writeFileSync(
        join(stateDir, 'ultrawork-state.json'),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: 'test task',
          session_id: sessionId,
          project_path: tempDir,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      // Write EXPIRED cancel signal (expired 10 seconds ago)
      writeFileSync(
        join(stateDir, 'cancel-signal-state.json'),
        JSON.stringify({
          requested_at: new Date(Date.now() - 40_000).toISOString(),
          expires_at: new Date(Date.now() - 10_000).toISOString(),
          source: 'test',
        })
      );

      const result = runCjsHook({
        cwd: tempDir,
        sessionId,
        stop_reason: 'end_turn',
      });

      // Should block because cancel signal is expired — ultrawork still active
      expect(result.decision).toBe('block');

      // Expired signal file should have been cleaned up
      expect(existsSync(join(stateDir, 'cancel-signal-state.json'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('persistent-mode.cjs isExplicitCancelCommand guard (issue #1058)', () => {
  function runCjsHook(input: Record<string, unknown>): Record<string, unknown> {
    const stdout = execFileSync(process.execPath, [CJS_SCRIPT], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 5000,
    });
    const lines = stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  }

  function makeUltraworkSession(tempDir: string, sessionId: string): string {
    const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        started_at: new Date().toISOString(),
        original_prompt: 'test task',
        session_id: sessionId,
        project_path: tempDir,
        reinforcement_count: 0,
        last_checked_at: new Date().toISOString(),
      })
    );
    return stateDir;
  }

  it.each([
    '/oh-my-claudecode:cancel',
    '/oh-my-claudecode:cancel --force',
    '/cancel',
    'cancelomc',
    'stopomc',
  ])('should bypass ultrawork when prompt is "%s"', (prompt: string) => {
    const sessionId = `session-1058-cancel-cmd-${prompt.replace(/[^a-zA-Z0-9]/g, '')}`;
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-cancel-cmd-'));

    try {
      makeUltraworkSession(tempDir, sessionId);
      const result = runCjsHook({ cwd: tempDir, sessionId, prompt });
      expect(result.continue).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    'cancel',
    'cancelled',
    'user_cancel',
    'cancel_force',
  ])('should bypass ultrawork when stop_reason is "%s"', (stop_reason: string) => {
    const sessionId = `session-1058-cancel-reason-${stop_reason}`;
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-cancel-reason-'));

    try {
      makeUltraworkSession(tempDir, sessionId);
      const result = runCjsHook({ cwd: tempDir, sessionId, stop_reason });
      expect(result.continue).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should bypass ultrawork when Skill tool invokes cancel skill', () => {
    const sessionId = 'session-1058-skill-cancel';
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-skill-cancel-'));

    try {
      makeUltraworkSession(tempDir, sessionId);
      const result = runCjsHook({
        cwd: tempDir,
        sessionId,
        tool_name: 'Skill',
        tool_input: { skill: 'oh-my-claudecode:cancel' },
      });
      expect(result.continue).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('persistent-mode.cjs isRateLimitStop guard (issue #777)', () => {
  function runCjsHook(input: Record<string, unknown>): Record<string, unknown> {
    const stdout = execFileSync(process.execPath, [CJS_SCRIPT], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 5000,
    });
    const lines = stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  }

  it.each([
    'rate_limit',
    'rate_limited',
    'too_many_requests',
    '429',
    'quota_exceeded',
    'overloaded',
  ])('should bypass ultrawork when stop_reason is "%s"', (stop_reason: string) => {
    const sessionId = `session-777-ratelimit-${stop_reason.replace(/[^a-zA-Z0-9]/g, '')}`;
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-ratelimit-'));

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ultrawork-state.json'),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: 'test task',
          session_id: sessionId,
          project_path: tempDir,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      const result = runCjsHook({ cwd: tempDir, sessionId, stop_reason });
      expect(result.continue).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should bypass ultrawork when end_turn_reason indicates rate limiting', () => {
    const sessionId = 'session-777-endturn-ratelimit';
    const tempDir = mkdtempSync(join(tmpdir(), 'cjs-endturn-ratelimit-'));

    try {
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ultrawork-state.json'),
        JSON.stringify({
          active: true,
          started_at: new Date().toISOString(),
          original_prompt: 'test task',
          session_id: sessionId,
          project_path: tempDir,
          reinforcement_count: 0,
          last_checked_at: new Date().toISOString(),
        })
      );

      const result = runCjsHook({
        cwd: tempDir,
        sessionId,
        stop_reason: 'end_turn',
        end_turn_reason: 'quota_exhausted',
      });
      expect(result.continue).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
