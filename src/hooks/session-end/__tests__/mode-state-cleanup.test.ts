import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../callbacks.js', () => ({
  triggerStopCallbacks: vi.fn(async () => undefined),
}));

vi.mock('../../../notifications/index.js', () => ({
  notify: vi.fn(async () => undefined),
}));

vi.mock('../../../tools/python-repl/bridge-manager.js', () => ({
  cleanupBridgeSessions: vi.fn(async () => ({
    requestedSessions: 0,
    foundSessions: 0,
    terminatedSessions: 0,
    errors: [],
  })),
}));

vi.mock('../../../lib/worktree-paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/worktree-paths.js')>(
    '../../../lib/worktree-paths.js',
  );
  return {
    ...actual,
    resolveToWorktreeRoot: vi.fn((dir?: string) => dir ?? process.cwd()),
  };
});

import { processSessionEnd } from '../index.js';

describe('processSessionEnd mode state cleanup (issue #1427)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-mode-state-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('removes active session-scoped mode state for the ending session', async () => {
    const sessionId = 'pid-1427-current';
    const sessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionStatePath = path.join(sessionDir, 'ultrawork-state.json');
    fs.writeFileSync(
      sessionStatePath,
      JSON.stringify({ active: true, started_at: new Date().toISOString() }),
      'utf-8',
    );

    await processSessionEnd({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    expect(fs.existsSync(sessionStatePath)).toBe(false);
  });

  it('removes the SessionStart marker for a normally ending session', async () => {
    const sessionId = 'pid-2816-ended';
    const sessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const markerPath = path.join(sessionDir, 'session-started.json');
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        session_id: sessionId,
        started_at: '2026-04-20T00:00:00.000Z',
        ppid: process.pid,
      }),
      'utf-8',
    );

    await processSessionEnd({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('does not remove another session\'s session-scoped state', async () => {
    const endingSessionId = 'pid-1427-ending';
    const otherSessionId = 'pid-1427-other';
    const otherSessionDir = path.join(tmpDir, '.omc', 'state', 'sessions', otherSessionId);
    fs.mkdirSync(otherSessionDir, { recursive: true });

    const otherSessionStatePath = path.join(otherSessionDir, 'ultrawork-state.json');
    fs.writeFileSync(
      otherSessionStatePath,
      JSON.stringify({ active: true, started_at: new Date().toISOString() }),
      'utf-8',
    );

    await processSessionEnd({
      session_id: endingSessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    expect(fs.existsSync(otherSessionStatePath)).toBe(true);
  });


  it('removes active team state for the ending session and preserves other sessions', async () => {
    const endingSessionId = 'pid-1427-team-ending';
    const otherSessionId = 'pid-1427-team-other';
    const stateDir = path.join(tmpDir, '.omc', 'state');
    const endingSessionDir = path.join(stateDir, 'sessions', endingSessionId);
    const otherSessionDir = path.join(stateDir, 'sessions', otherSessionId);
    fs.mkdirSync(endingSessionDir, { recursive: true });
    fs.mkdirSync(otherSessionDir, { recursive: true });

    const endingSessionStatePath = path.join(endingSessionDir, 'team-state.json');
    const otherSessionStatePath = path.join(otherSessionDir, 'team-state.json');
    const legacyStatePath = path.join(stateDir, 'team-state.json');

    fs.writeFileSync(
      endingSessionStatePath,
      JSON.stringify({ active: true, current_phase: 'team-exec', started_at: new Date().toISOString() }),
      'utf-8',
    );
    fs.writeFileSync(
      otherSessionStatePath,
      JSON.stringify({ active: true, current_phase: 'team-verify', started_at: new Date().toISOString() }),
      'utf-8',
    );
    fs.writeFileSync(
      legacyStatePath,
      JSON.stringify({ active: true, session_id: endingSessionId, current_phase: 'team-exec' }),
      'utf-8',
    );

    await processSessionEnd({
      session_id: endingSessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    expect(fs.existsSync(endingSessionStatePath)).toBe(false);
    expect(fs.existsSync(legacyStatePath)).toBe(false);
    expect(fs.existsSync(otherSessionStatePath)).toBe(true);
  });
  it('removes both session-scoped and matching legacy state for the ending session', async () => {
    const sessionId = 'pid-1427-legacy';
    const stateDir = path.join(tmpDir, '.omc', 'state');
    const sessionDir = path.join(stateDir, 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionStatePath = path.join(sessionDir, 'autopilot-state.json');
    const legacyStatePath = path.join(stateDir, 'autopilot-state.json');

    fs.writeFileSync(
      sessionStatePath,
      JSON.stringify({ active: true, started_at: new Date().toISOString() }),
      'utf-8',
    );
    fs.writeFileSync(
      legacyStatePath,
      JSON.stringify({ active: true, session_id: sessionId, started_at: new Date().toISOString() }),
      'utf-8',
    );

    await processSessionEnd({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    expect(fs.existsSync(sessionStatePath)).toBe(false);
    expect(fs.existsSync(legacyStatePath)).toBe(false);
  });

  it('cleans up mission-state.json entries for the ending session', async () => {
    const endingSessionId = 'pid-mission-ending';
    const otherSessionId = 'pid-mission-other';
    const stateDir = path.join(tmpDir, '.omc', 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const missionStatePath = path.join(stateDir, 'mission-state.json');
    fs.writeFileSync(
      missionStatePath,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        missions: [
          { id: `ultrawork-${endingSessionId}`, source: 'session', label: 'ending session mission' },
          { id: `ultrawork-${otherSessionId}`, source: 'session', label: 'other session mission' },
          { id: 'team-pipeline-abc', source: 'team', label: 'team mission' },
        ],
      }),
      'utf-8',
    );

    await processSessionEnd({
      session_id: endingSessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    const updated = JSON.parse(fs.readFileSync(missionStatePath, 'utf-8'));
    expect(updated.missions).toHaveLength(2);
    expect(updated.missions.some((m: Record<string, unknown>) => m.id === `ultrawork-${otherSessionId}`)).toBe(true);
    expect(updated.missions.some((m: Record<string, unknown>) => m.source === 'team')).toBe(true);
    expect(updated.missions.some((m: Record<string, unknown>) => (m.id as string).includes(endingSessionId))).toBe(false);
  });
});
