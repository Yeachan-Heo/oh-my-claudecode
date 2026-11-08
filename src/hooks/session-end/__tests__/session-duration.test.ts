import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionStartTime, recordSessionMetrics, type SessionEndInput } from '../index.js';

/**
 * Tests for issue #573: session duration was overreported because
 * getSessionStartTime returned the first started_at from any state file,
 * ignoring session_id. Stale state files from previous sessions caused
 * durations to span across sessions.
 */

let tmpDir: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

function stateDir(): string {
  return path.join(tmpDir, '.omc', 'state');
}

function writeState(filename: string, state: Record<string, unknown>): void {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(state), 'utf-8');
}

function makeInput(overrides?: Partial<SessionEndInput>): SessionEndInput {
  return {
    session_id: 'current-session',
    transcript_path: '/tmp/transcript',
    cwd: tmpDir,
    permission_mode: 'default',
    hook_event_name: 'SessionEnd',
    reason: 'clear',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-duration-test-'));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
});

describe('getSessionStartTime', () => {
  it('returns undefined when state dir does not exist', () => {
    expect(getSessionStartTime(tmpDir, 'any-session')).toBeUndefined();
  });

  it('returns undefined when no state files have started_at', () => {
    writeState('ultrawork-state.json', { active: true, session_id: 'current-session' });
    expect(getSessionStartTime(tmpDir, 'current-session')).toBeUndefined();
  });

  it('returns started_at from matching session_id', () => {
    writeState('autopilot-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T10:00:00.000Z',
    });
    expect(getSessionStartTime(tmpDir, 'current-session')).toBe('2026-02-11T10:00:00.000Z');
  });

  it('skips stale state files from other sessions (issue #573)', () => {
    // Stale state from a session 3 days ago
    writeState('autopilot-state.json', {
      active: true,
      session_id: 'old-session-from-3-days-ago',
      started_at: '2026-02-08T08:00:00.000Z',
    });

    // Current session state
    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T10:00:00.000Z',
    });

    const result = getSessionStartTime(tmpDir, 'current-session');
    // Must pick current session, NOT the stale one from 3 days ago
    expect(result).toBe('2026-02-11T10:00:00.000Z');
  });

  it('returns earliest started_at when multiple files match the session', () => {
    // Autopilot started first
    writeState('autopilot-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T09:00:00.000Z',
    });

    // Ultrawork started later in the same session
    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T10:30:00.000Z',
    });

    const result = getSessionStartTime(tmpDir, 'current-session');
    // Should pick the earliest to reflect the full session span
    expect(result).toBe('2026-02-11T09:00:00.000Z');
  });

  it('falls back to legacy state files (no session_id) when no match', () => {
    // Legacy state without session_id
    writeState('ralph-state.json', {
      active: true,
      started_at: '2026-02-11T12:00:00.000Z',
    });

    const result = getSessionStartTime(tmpDir, 'current-session');
    expect(result).toBe('2026-02-11T12:00:00.000Z');
  });

  it('prefers session-matched over legacy state', () => {
    // Legacy state (no session_id) with earlier timestamp
    writeState('ralph-state.json', {
      active: true,
      started_at: '2026-02-11T06:00:00.000Z',
    });

    // Current session state with later timestamp
    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T10:00:00.000Z',
    });

    const result = getSessionStartTime(tmpDir, 'current-session');
    // Should prefer the session-matched one, not the earlier legacy one
    expect(result).toBe('2026-02-11T10:00:00.000Z');
  });

  it('ignores non-JSON files', () => {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'swarm-active.marker'), 'active', 'utf-8');

    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T10:00:00.000Z',
    });

    expect(getSessionStartTime(tmpDir, 'current-session')).toBe('2026-02-11T10:00:00.000Z');
  });

  it('skips files with invalid JSON gracefully', () => {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken-state.json'), '{invalid json', 'utf-8');

    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T10:00:00.000Z',
    });

    expect(getSessionStartTime(tmpDir, 'current-session')).toBe('2026-02-11T10:00:00.000Z');
  });

  it('works without sessionId parameter (legacy call pattern)', () => {
    writeState('autopilot-state.json', {
      active: true,
      started_at: '2026-02-11T10:00:00.000Z',
    });

    // No sessionId passed — should still find legacy states
    expect(getSessionStartTime(tmpDir)).toBe('2026-02-11T10:00:00.000Z');
  });

  it('skips malformed timestamps and still returns valid ones', () => {
    // Malformed timestamp
    writeState('autopilot-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: 'not-a-date',
    });

    // Valid timestamp
    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T10:00:00.000Z',
    });

    const result = getSessionStartTime(tmpDir, 'current-session');
    expect(result).toBe('2026-02-11T10:00:00.000Z');
  });

  it('returns undefined when all timestamps are malformed', () => {
    writeState('autopilot-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: 'garbage',
    });

    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '',
    });

    const result = getSessionStartTime(tmpDir, 'current-session');
    expect(result).toBeUndefined();
  });

  it('skips malformed legacy timestamps gracefully', () => {
    // Malformed legacy timestamp
    writeState('ralph-state.json', {
      active: true,
      started_at: 'invalid-date-string',
    });

    // Valid legacy timestamp
    writeState('ralph-state-valid.json', {
      active: true,
      started_at: '2026-02-11T14:00:00.000Z',
    });

    const result = getSessionStartTime(tmpDir, 'current-session');
    expect(result).toBe('2026-02-11T14:00:00.000Z');
  });

  it('returns undefined when only stale states exist and no legacy fallback', () => {
    writeState('autopilot-state.json', {
      active: true,
      session_id: 'completely-different-session',
      started_at: '2026-02-08T08:00:00.000Z',
    });

    const result = getSessionStartTime(tmpDir, 'current-session');
    expect(result).toBeUndefined();
  });
});

describe('recordSessionMetrics - duration accuracy (issue #573)', () => {
  it('computes correct duration when matching session state exists', () => {
    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: '2026-02-11T10:00:00.000Z',
    });

    const metrics = recordSessionMetrics(tmpDir, makeInput());

    expect(metrics.started_at).toBe('2026-02-11T10:00:00.000Z');
    expect(metrics.duration_ms).toBeDefined();
    // Duration should be reasonable (not negative, not days)
    expect(metrics.duration_ms!).toBeGreaterThan(0);
  });

  it('does not overreport duration from stale session state', () => {
    // Stale state from 3 days ago
    writeState('autopilot-state.json', {
      active: true,
      session_id: 'old-session',
      started_at: '2026-02-08T08:00:00.000Z',
    });

    // Current session started 5 minutes ago
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeState('ultrawork-state.json', {
      active: true,
      session_id: 'current-session',
      started_at: fiveMinAgo,
    });

    const metrics = recordSessionMetrics(tmpDir, makeInput());

    // Duration should be ~5 minutes, not ~3 days
    expect(metrics.duration_ms).toBeDefined();
    expect(metrics.duration_ms!).toBeLessThan(10 * 60 * 1000); // less than 10 minutes
    expect(metrics.duration_ms!).toBeGreaterThan(0);
  });

  it('returns undefined duration when no state files exist', () => {
    const metrics = recordSessionMetrics(tmpDir, makeInput());

    expect(metrics.started_at).toBeUndefined();
    expect(metrics.duration_ms).toBeUndefined();
  });
});
