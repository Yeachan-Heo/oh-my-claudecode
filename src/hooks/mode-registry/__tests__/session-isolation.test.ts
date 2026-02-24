import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Import functions to test
import {
  getStateFilePath,
  isModeActive,
  getActiveModes,
  clearModeState,
  hasModeState,
  isModeActiveInAnySession,
  getActiveSessionsForMode,
  clearStaleSessionDirs,
  canStartMode,
} from '../index.js';

import {
  validateSessionId,
  resolveSessionStatePath,
  getSessionStateDir,
  listSessionIds,
  ensureSessionStateDir,
} from '../../../lib/worktree-paths.js';

describe('Session-Scoped State Isolation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-isolation-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper to create state file at session-scoped path
  function createSessionState(sessionId: string, mode: string, data: Record<string, unknown>) {
    const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `${mode}-state.json`), JSON.stringify(data, null, 2));
  }

  // Helper to create legacy state file
  function createLegacyState(mode: string, data: Record<string, unknown>) {
    const stateDir = join(tempDir, '.omc', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${mode}-state.json`), JSON.stringify(data, null, 2));
  }

  describe('validateSessionId', () => {
    it('should accept valid session IDs', () => {
      expect(() => validateSessionId('abc123')).not.toThrow();
      expect(() => validateSessionId('session-with-hyphens')).not.toThrow();
      expect(() => validateSessionId('session_with_underscores')).not.toThrow();
      expect(() => validateSessionId('A1b2C3')).not.toThrow();
    });

    it('should reject empty session ID', () => {
      expect(() => validateSessionId('')).toThrow('cannot be empty');
    });

    it('should reject path traversal', () => {
      expect(() => validateSessionId('../etc/passwd')).toThrow('path traversal');
      expect(() => validateSessionId('session/../../root')).toThrow('path traversal');
    });

    it('should reject invalid characters', () => {
      expect(() => validateSessionId('session with spaces')).toThrow();
      expect(() => validateSessionId('session@special')).toThrow();
    });
  });

  describe('resolveSessionStatePath', () => {
    it('should return session-scoped path', () => {
      const path = resolveSessionStatePath('ultrawork', 'session-123', tempDir);
      expect(path).toContain('.omc/state/sessions/session-123/ultrawork-state.json');
    });

    it('should normalize state name', () => {
      const path1 = resolveSessionStatePath('ultrawork', 'sid', tempDir);
      const path2 = resolveSessionStatePath('ultrawork-state', 'sid', tempDir);
      expect(path1).toBe(path2);
    });

    it('should reject swarm mode', () => {
      expect(() => resolveSessionStatePath('swarm', 'sid', tempDir)).toThrow('SQLite');
    });
  });

  describe('listSessionIds', () => {
    it('should return empty array when no sessions exist', () => {
      expect(listSessionIds(tempDir)).toEqual([]);
    });

    it('should list session directories', () => {
      createSessionState('session-A', 'ultrawork', { active: true });
      createSessionState('session-B', 'ralph', { active: true });
      const ids = listSessionIds(tempDir);
      expect(ids).toContain('session-A');
      expect(ids).toContain('session-B');
      expect(ids.length).toBe(2);
    });
  });

  describe('Session-scoped path resolution', () => {
    it('should return session-scoped path when sessionId provided', () => {
      const path = getStateFilePath(tempDir, 'ultrawork', 'session-123');
      expect(path).toContain('sessions/session-123');
    });

    it('should return legacy path when no sessionId', () => {
      const path = getStateFilePath(tempDir, 'ultrawork');
      expect(path).not.toContain('sessions');
      expect(path).toContain('ultrawork-state.json');
    });
  });

  describe('Two sessions writing independent state', () => {
    it('should isolate state between sessions', () => {
      createSessionState('session-A', 'ultrawork', { active: true, prompt: 'Task A' });
      createSessionState('session-B', 'ultrawork', { active: true, prompt: 'Task B' });

      // Each session's state should be independent
      const pathA = join(tempDir, '.omc', 'state', 'sessions', 'session-A', 'ultrawork-state.json');
      const pathB = join(tempDir, '.omc', 'state', 'sessions', 'session-B', 'ultrawork-state.json');

      const stateA = JSON.parse(readFileSync(pathA, 'utf-8'));
      const stateB = JSON.parse(readFileSync(pathB, 'utf-8'));

      expect(stateA.prompt).toBe('Task A');
      expect(stateB.prompt).toBe('Task B');
    });
  });

  describe('Cross-session mode discovery (isModeActiveInAnySession)', () => {
    it('should find mode active in any session', () => {
      createSessionState('session-A', 'ultrawork', { active: true });
      expect(isModeActiveInAnySession('ultrawork', tempDir)).toBe(true);
    });

    it('should return false when mode not active in any session', () => {
      expect(isModeActiveInAnySession('ultrawork', tempDir)).toBe(false);
    });

    it('should find mode even if only in legacy path', () => {
      createLegacyState('ultrawork', { active: true });
      expect(isModeActiveInAnySession('ultrawork', tempDir)).toBe(true);
    });
  });

  describe('getActiveSessionsForMode', () => {
    it('should return sessions running a specific mode', () => {
      createSessionState('session-A', 'ultrawork', { active: true });
      createSessionState('session-B', 'ultrawork', { active: true });
      createSessionState('session-C', 'ralph', { active: true });

      const sessions = getActiveSessionsForMode('ultrawork', tempDir);
      expect(sessions).toContain('session-A');
      expect(sessions).toContain('session-B');
      expect(sessions).not.toContain('session-C');
    });
  });

  describe('clearModeState with sessionId', () => {
    it('should clear session-specific state', () => {
      createSessionState('session-A', 'ultrawork', { active: true });
      createSessionState('session-B', 'ultrawork', { active: true });

      clearModeState('ultrawork', tempDir, 'session-A');

      // Session A state should be gone
      const pathA = join(tempDir, '.omc', 'state', 'sessions', 'session-A', 'ultrawork-state.json');
      expect(existsSync(pathA)).toBe(false);

      // Session B state should remain
      const pathB = join(tempDir, '.omc', 'state', 'sessions', 'session-B', 'ultrawork-state.json');
      expect(existsSync(pathB)).toBe(true);
    });

    it('should clear session-scoped marker artifacts (ralph verification) for the target session only', () => {
      const sessionA = 'session-A';
      const sessionB = 'session-B';
      createSessionState(sessionA, 'ralph', { active: true, session_id: sessionA });
      createSessionState(sessionB, 'ralph', { active: true, session_id: sessionB });

      const sessionADir = join(tempDir, '.omc', 'state', 'sessions', sessionA);
      const sessionBDir = join(tempDir, '.omc', 'state', 'sessions', sessionB);
      const markerA = join(sessionADir, 'ralph-verification-state.json');
      const markerB = join(sessionBDir, 'ralph-verification-state.json');
      const legacyMarker = join(tempDir, '.omc', 'state', 'ralph-verification.json');
      writeFileSync(markerA, JSON.stringify({ pending: true }, null, 2));
      writeFileSync(markerB, JSON.stringify({ pending: true }, null, 2));
      mkdirSync(join(tempDir, '.omc', 'state'), { recursive: true });
      writeFileSync(legacyMarker, JSON.stringify({ pending: true }, null, 2));
      expect(existsSync(legacyMarker)).toBe(true);

      clearModeState('ralph', tempDir, sessionA);

      expect(existsSync(join(sessionADir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(markerA)).toBe(false);
      expect(existsSync(join(sessionBDir, 'ralph-state.json'))).toBe(true);
      expect(existsSync(markerB)).toBe(true);
      expect(existsSync(legacyMarker)).toBe(false);
    });

    it('should NOT delete legacy marker file owned by a different session', () => {
      // Regression test for issue #927:
      // clearModeState with sessionId used to unconditionally delete the legacy
      // marker file, bypassing the ownership check.
      const sessionA = 'session-A';
      const sessionB = 'session-B';

      createSessionState(sessionA, 'ralph', { active: true, session_id: sessionA });

      // Legacy marker is owned by session B (a different session)
      const legacyMarkerDir = join(tempDir, '.omc', 'state');
      mkdirSync(legacyMarkerDir, { recursive: true });
      const legacyMarker = join(legacyMarkerDir, 'ralph-verification.json');
      writeFileSync(legacyMarker, JSON.stringify({ pending: true, session_id: sessionB }));

      // Clear session A's state — must NOT touch session B's marker
      clearModeState('ralph', tempDir, sessionA);

      expect(existsSync(legacyMarker)).toBe(true);
      const remaining = JSON.parse(readFileSync(legacyMarker, 'utf-8'));
      expect(remaining.session_id).toBe(sessionB);
    });
  });

  describe('Stale session cleanup', () => {
    it('should remove empty session directories', () => {
      const emptyDir = join(tempDir, '.omc', 'state', 'sessions', 'empty-session');
      mkdirSync(emptyDir, { recursive: true });

      const removed = clearStaleSessionDirs(tempDir, 0);
      expect(removed).toContain('empty-session');
      expect(existsSync(emptyDir)).toBe(false);
    });
  });

  describe('Backward compat with legacy state files', () => {
    it('should detect mode in legacy path', () => {
      createLegacyState('ultrawork', { active: true });
      expect(isModeActive('ultrawork', tempDir)).toBe(true);
    });

    it('should prefer session-scoped state when sessionId provided', () => {
      createLegacyState('ultrawork', { active: true, prompt: 'legacy' });
      createSessionState('session-A', 'ultrawork', { active: false, prompt: 'session' });

      // With sessionId, should see session state (active: false)
      expect(isModeActive('ultrawork', tempDir, 'session-A')).toBe(false);

      // Without sessionId, should see legacy state (active: true)
      expect(isModeActive('ultrawork', tempDir)).toBe(true);
    });
  });

  describe('Session isolation: no legacy fallback with sessionId (Issue #311)', () => {
    it('isJsonModeActive with sessionId should ignore legacy file entirely', () => {
      // Only legacy file exists, no session-scoped file
      createLegacyState('ultrawork', { active: true, session_id: 'session-A' });

      // Session B should NOT see session A's legacy state
      expect(isModeActive('ultrawork', tempDir, 'session-B')).toBe(false);

      // Session A should also NOT see its own legacy state (must use session-scoped file)
      expect(isModeActive('ultrawork', tempDir, 'session-A')).toBe(false);

      // Without sessionId, legacy state is still visible (backward compat)
      expect(isModeActive('ultrawork', tempDir)).toBe(true);
    });

    it('should reject state with mismatched session_id even in session-scoped file', () => {
      // Create session-scoped file with wrong session_id (shouldn't happen, but defensive)
      createSessionState('session-A', 'ultrawork', { active: true, session_id: 'session-OTHER' });

      expect(isModeActive('ultrawork', tempDir, 'session-A')).toBe(false);
    });

    it('hasModeState with sessionId should check session path only', () => {
      createLegacyState('ultrawork', { active: true });

      // Without sessionId, legacy file is found
      expect(hasModeState(tempDir, 'ultrawork')).toBe(true);

      // With sessionId, only session-scoped path is checked (doesn't exist)
      expect(hasModeState(tempDir, 'ultrawork', 'session-X')).toBe(false);

      // Create session-scoped file, now it should be found
      createSessionState('session-X', 'ultrawork', { active: true });
      expect(hasModeState(tempDir, 'ultrawork', 'session-X')).toBe(true);
    });

    it('cross-session: Session A active, Session B check returns false', () => {
      createSessionState('session-A', 'ralph', { active: true, session_id: 'session-A' });

      // Session A sees its own state
      expect(isModeActive('ralph', tempDir, 'session-A')).toBe(true);

      // Session B does NOT see Session A's state
      expect(isModeActive('ralph', tempDir, 'session-B')).toBe(false);
    });
  });

  describe('Team mode state isolation', () => {
    it('should detect team mode active in session-scoped path', () => {
      createSessionState('session-team', 'team', { active: true, session_id: 'session-team' });

      expect(isModeActive('team', tempDir, 'session-team')).toBe(true);
    });

    it('should return correct state file path for team mode', () => {
      const path = getStateFilePath(tempDir, 'team', 'session-team-123');
      expect(path).toContain('sessions/session-team-123');
      expect(path).toContain('team-state.json');
    });

    it('should isolate team state between sessions', () => {
      createSessionState('session-A', 'team', { active: true, session_id: 'session-A', stage: 'team-exec' });
      createSessionState('session-B', 'team', { active: true, session_id: 'session-B', stage: 'team-plan' });

      // Each session sees its own state
      expect(isModeActive('team', tempDir, 'session-A')).toBe(true);
      expect(isModeActive('team', tempDir, 'session-B')).toBe(true);

      // Verify paths are different
      const pathA = getStateFilePath(tempDir, 'team', 'session-A');
      const pathB = getStateFilePath(tempDir, 'team', 'session-B');
      expect(pathA).not.toBe(pathB);
    });

    it('should clear team mode state for specific session only', () => {
      createSessionState('session-A', 'team', { active: true, session_id: 'session-A' });
      createSessionState('session-B', 'team', { active: true, session_id: 'session-B' });

      clearModeState('team', tempDir, 'session-A');

      // Session A state should be gone
      expect(isModeActive('team', tempDir, 'session-A')).toBe(false);

      // Session B state should remain
      expect(isModeActive('team', tempDir, 'session-B')).toBe(true);
    });

    it('should list team in active modes when active', () => {
      createSessionState('session-team', 'team', { active: true, session_id: 'session-team' });

      const activeModes = getActiveModes(tempDir, 'session-team');
      expect(activeModes).toContain('team');
    });

    it('should return active sessions for team mode', () => {
      createSessionState('session-A', 'team', { active: true, session_id: 'session-A' });
      createSessionState('session-B', 'team', { active: true, session_id: 'session-B' });

      const activeSessions = getActiveSessionsForMode('team', tempDir);
      expect(activeSessions).toContain('session-A');
      expect(activeSessions).toContain('session-B');
    });
  });
});
