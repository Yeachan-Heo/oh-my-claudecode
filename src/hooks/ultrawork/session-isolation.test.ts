import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  activateUltrawork,
  readUltraworkState,
  shouldReinforceUltrawork,
  deactivateUltrawork,
  incrementReinforcement
} from './index.js';

describe('Ultrawork Session Isolation (Issue #269)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ultrawork-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('activateUltrawork stores session_id correctly', () => {
    it('should store session_id when provided', () => {
      const sessionId = 'session-abc-123';
      const prompt = 'Fix all errors';

      const result = activateUltrawork(prompt, sessionId, tempDir);
      expect(result).toBe(true);

      const state = readUltraworkState(tempDir, sessionId);
      expect(state).not.toBeNull();
      expect(state?.session_id).toBe(sessionId);
      expect(state?.active).toBe(true);
      expect(state?.original_prompt).toBe(prompt);
    });

    it('should set session_id to undefined when not provided', () => {
      const prompt = 'Fix all errors';

      const result = activateUltrawork(prompt, undefined, tempDir);
      expect(result).toBe(true);

      const state = readUltraworkState(tempDir);
      expect(state).not.toBeNull();
      expect(state?.session_id).toBeUndefined();
    });

    it('should initialize reinforcement_count to 0', () => {
      const sessionId = 'session-xyz';
      activateUltrawork('Test task', sessionId, tempDir);

      const state = readUltraworkState(tempDir, sessionId);
      expect(state?.reinforcement_count).toBe(0);
    });

    it('should set started_at and last_checked_at timestamps', () => {
      const beforeTime = Date.now();
      const sessionId = 'session-1';
      activateUltrawork('Test task', sessionId, tempDir);
      const afterTime = Date.now();

      const state = readUltraworkState(tempDir, sessionId);
      expect(state?.started_at).toBeDefined();
      expect(state?.last_checked_at).toBeDefined();

      // Timestamps should be between before and after
      const startedTimestamp = new Date(state?.started_at || '').getTime();
      const checkedTimestamp = new Date(state?.last_checked_at || '').getTime();

      expect(startedTimestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(startedTimestamp).toBeLessThanOrEqual(afterTime);
      expect(checkedTimestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(checkedTimestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('shouldReinforceUltrawork strict session matching', () => {
    it('should return true when session IDs match', () => {
      const sessionId = 'session-match-test';
      activateUltrawork('Test task', sessionId, tempDir);

      const result = shouldReinforceUltrawork(sessionId, tempDir);
      expect(result).toBe(true);
    });

    it('should return false when session IDs do not match', () => {
      const sessionId1 = 'session-original';
      const sessionId2 = 'session-different';

      activateUltrawork('Test task', sessionId1, tempDir);

      const result = shouldReinforceUltrawork(sessionId2, tempDir);
      expect(result).toBe(false);
    });

    it('should return false when state has session_id but caller does not provide one', () => {
      activateUltrawork('Test task', 'session-with-id', tempDir);

      const result = shouldReinforceUltrawork(undefined, tempDir);
      expect(result).toBe(false);
    });

    it('should return false when caller provides session_id but state does not have one', () => {
      activateUltrawork('Test task', undefined, tempDir);

      const result = shouldReinforceUltrawork('session-requesting', tempDir);
      expect(result).toBe(false);
    });

    it('should return false when both state and caller have undefined session_id (Bug #5 fix)', () => {
      activateUltrawork('Test task', undefined, tempDir);

      // Both undefined should NOT match - prevents cross-session contamination
      const result = shouldReinforceUltrawork(undefined, tempDir);
      expect(result).toBe(false);
    });

    it('should return false when ultrawork is not active', () => {
      const sessionId = 'session-inactive';
      activateUltrawork('Test task', sessionId, tempDir);
      deactivateUltrawork(tempDir, sessionId);

      const result = shouldReinforceUltrawork(sessionId, tempDir);
      expect(result).toBe(false);
    });

    it('should return false when no state file exists', () => {
      const result = shouldReinforceUltrawork('any-session', tempDir);
      expect(result).toBe(false);
    });
  });

  describe('Cross-session isolation', () => {
    it('should prevent Session B from reinforcing Session A\'s ultrawork', () => {
      const sessionA = 'session-alice';
      const sessionB = 'session-bob';

      // Session A activates ultrawork
      activateUltrawork('Session A task', sessionA, tempDir);

      let state = readUltraworkState(tempDir, sessionA);
      expect(state?.active).toBe(true);
      expect(state?.session_id).toBe(sessionA);

      // Session B tries to check if it should reinforce
      const shouldReinforceB = shouldReinforceUltrawork(sessionB, tempDir);
      expect(shouldReinforceB).toBe(false);

      // Session A can still reinforce its own ultrawork
      const shouldReinforceA = shouldReinforceUltrawork(sessionA, tempDir);
      expect(shouldReinforceA).toBe(true);
    });

    it('should allow Session A to reinforce its own ultrawork multiple times', () => {
      const sessionA = 'session-alpha';
      activateUltrawork('Task for Alpha', sessionA, tempDir);

      // First reinforcement check
      let shouldReinforce = shouldReinforceUltrawork(sessionA, tempDir);
      expect(shouldReinforce).toBe(true);

      // Increment reinforcement
      let updatedState = incrementReinforcement(tempDir, sessionA);
      expect(updatedState?.reinforcement_count).toBe(1);

      // Second reinforcement check
      shouldReinforce = shouldReinforceUltrawork(sessionA, tempDir);
      expect(shouldReinforce).toBe(true);

      // Increment again
      updatedState = incrementReinforcement(tempDir, sessionA);
      expect(updatedState?.reinforcement_count).toBe(2);
    });

    it('should prevent reinforcement after session ID change', () => {
      const originalSession = 'session-original';
      const newSession = 'session-new';

      activateUltrawork('Original task', originalSession, tempDir);

      // Original session can reinforce
      expect(shouldReinforceUltrawork(originalSession, tempDir)).toBe(true);

      // Different session cannot reinforce
      expect(shouldReinforceUltrawork(newSession, tempDir)).toBe(false);

      // Even after incrementing with original session
      incrementReinforcement(tempDir, originalSession);

      // New session still cannot reinforce
      expect(shouldReinforceUltrawork(newSession, tempDir)).toBe(false);
    });

    it('should allow new session to activate after deactivation', () => {
      const sessionA = 'session-first';
      const sessionB = 'session-second';

      // Session A activates
      activateUltrawork('First task', sessionA, tempDir);
      expect(shouldReinforceUltrawork(sessionA, tempDir)).toBe(true);
      expect(shouldReinforceUltrawork(sessionB, tempDir)).toBe(false);

      // Session A deactivates
      deactivateUltrawork(tempDir, sessionA);
      expect(shouldReinforceUltrawork(sessionA, tempDir)).toBe(false);

      // Session B can now activate its own ultrawork
      activateUltrawork('Second task', sessionB, tempDir);
      expect(shouldReinforceUltrawork(sessionB, tempDir)).toBe(true);
      expect(shouldReinforceUltrawork(sessionA, tempDir)).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should reject empty string and undefined session IDs for isolation safety', () => {
      const emptySession = '';
      activateUltrawork('Task with empty session', emptySession, tempDir);

      // Empty string and undefined should both be rejected to prevent
      // cross-session contamination (Bug #5 fix)
      expect(shouldReinforceUltrawork(emptySession, tempDir)).toBe(false);
      expect(shouldReinforceUltrawork(undefined, tempDir)).toBe(false);
    });

    it('should preserve session_id through reinforcement cycles', () => {
      const sessionId = 'session-persistent';
      activateUltrawork('Persistent task', sessionId, tempDir);

      // Multiple reinforcement cycles
      for (let i = 0; i < 5; i++) {
        expect(shouldReinforceUltrawork(sessionId, tempDir)).toBe(true);
        incrementReinforcement(tempDir, sessionId);
      }

      // Session ID should still be preserved
      const state = readUltraworkState(tempDir, sessionId);
      expect(state?.session_id).toBe(sessionId);
      expect(state?.reinforcement_count).toBe(5);
    });

    it('should handle rapid session switches correctly', () => {
      const sessions = ['session-1', 'session-2', 'session-3'];

      for (const session of sessions) {
        activateUltrawork(`Task for ${session}`, session, tempDir);

        // Only the current session should be able to reinforce
        expect(shouldReinforceUltrawork(session, tempDir)).toBe(true);

        // Previous sessions should not be able to reinforce
        for (const otherSession of sessions) {
          if (otherSession !== session) {
            expect(shouldReinforceUltrawork(otherSession, tempDir)).toBe(false);
          }
        }

        deactivateUltrawork(tempDir, session);
      }
    });
  });

  describe('Integration with linked_to_ralph flag', () => {
    it('should preserve session_id when linked to ralph', () => {
      const sessionId = 'session-ralph-linked';
      activateUltrawork('Ralph-linked task', sessionId, tempDir, true);

      const state = readUltraworkState(tempDir, sessionId);
      expect(state?.session_id).toBe(sessionId);
      expect(state?.linked_to_ralph).toBe(true);

      // Session isolation should still apply
      expect(shouldReinforceUltrawork(sessionId, tempDir)).toBe(true);
      expect(shouldReinforceUltrawork('different-session', tempDir)).toBe(false);
    });

    it('should maintain session isolation regardless of ralph link status', () => {
      const sessionId = 'session-with-ralph';
      activateUltrawork('Task', sessionId, tempDir, true);

      // Different session cannot reinforce even if ralph-linked
      expect(shouldReinforceUltrawork('other-session', tempDir)).toBe(false);
    });
  });

  describe('State file integrity', () => {
    it('should maintain consistent state across multiple reads', () => {
      const sessionId = 'session-consistency';
      activateUltrawork('Consistency test', sessionId, tempDir);

      const state1 = readUltraworkState(tempDir, sessionId);
      const state2 = readUltraworkState(tempDir, sessionId);

      expect(state1).toEqual(state2);
      expect(state1?.session_id).toBe(sessionId);
      expect(state2?.session_id).toBe(sessionId);
    });

    it('should update last_checked_at on reinforcement without changing session_id', async () => {
      const sessionId = 'session-timestamp';
      activateUltrawork('Timestamp test', sessionId, tempDir);

      const initialState = readUltraworkState(tempDir, sessionId);
      const initialTimestamp = initialState?.last_checked_at;

      // Wait a tiny bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      incrementReinforcement(tempDir, sessionId);

      const updatedState = readUltraworkState(tempDir, sessionId);
      expect(updatedState?.session_id).toBe(sessionId);
      // Timestamps are ISO strings, compare as dates
      expect(new Date(updatedState?.last_checked_at || 0).getTime())
        .toBeGreaterThanOrEqual(new Date(initialTimestamp || 0).getTime());
    });
  });

  describe('No legacy fallback with sessionId (Issue #311)', () => {
    // Helper to create legacy state file directly
    function createLegacyState(data: Record<string, unknown>) {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'ultrawork-state.json'), JSON.stringify(data, null, 2));
    }

    it('readUltraworkState with sessionId returns null when only legacy file exists', () => {
      createLegacyState({
        active: true,
        started_at: new Date().toISOString(),
        original_prompt: 'Legacy task',
        session_id: 'session-A',
        reinforcement_count: 0,
        last_checked_at: new Date().toISOString()
      });

      // With sessionId, should NOT fall back to legacy file
      const state = readUltraworkState(tempDir, 'session-A');
      expect(state).toBeNull();

      // Without sessionId, should still read legacy file
      const legacyState = readUltraworkState(tempDir);
      expect(legacyState).not.toBeNull();
      expect(legacyState?.active).toBe(true);
    });

    it('readUltraworkState with sessionId rejects mismatched session_id in session file', () => {
      // Activate as session-A
      activateUltrawork('Task A', 'session-A', tempDir);

      // Session-B should get null (no file for session-B)
      expect(readUltraworkState(tempDir, 'session-B')).toBeNull();
    });
  });

  describe('Ghost legacy cleanup on deactivate (Issue #311)', () => {
    function createLegacyState(data: Record<string, unknown>) {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'ultrawork-state.json'), JSON.stringify(data, null, 2));
    }

    function legacyFileExists(): boolean {
      return existsSync(join(tempDir, '.omc', 'state', 'ultrawork-state.json'));
    }

    function readLegacyState(): Record<string, unknown> | null {
      const path = join(tempDir, '.omc', 'state', 'ultrawork-state.json');
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8'));
    }

    it('should clean up legacy file with matching session_id on deactivate', () => {
      // Create both session-scoped and legacy files for session-A
      activateUltrawork('Task A', 'session-A', tempDir);
      createLegacyState({
        active: true,
        session_id: 'session-A',
        original_prompt: 'Ghost legacy'
      });

      expect(legacyFileExists()).toBe(true);

      deactivateUltrawork(tempDir, 'session-A');

      // Both session-scoped and legacy files should be cleaned
      expect(legacyFileExists()).toBe(false);
    });

    it('should clean up legacy file with no session_id (orphaned)', () => {
      activateUltrawork('Task A', 'session-A', tempDir);
      createLegacyState({
        active: true,
        original_prompt: 'Orphaned legacy'
        // Note: no session_id field
      });

      deactivateUltrawork(tempDir, 'session-A');

      // Orphaned legacy file should be cleaned
      expect(legacyFileExists()).toBe(false);
    });

    it('should NOT clean up legacy file belonging to another session', () => {
      activateUltrawork('Task A', 'session-A', tempDir);
      createLegacyState({
        active: true,
        session_id: 'session-B',
        original_prompt: 'Session B legacy'
      });

      deactivateUltrawork(tempDir, 'session-A');

      // Legacy file belongs to session-B, should NOT be deleted
      expect(legacyFileExists()).toBe(true);
      expect(readLegacyState()?.session_id).toBe('session-B');
    });

    it('should work correctly when no legacy file exists', () => {
      activateUltrawork('Task A', 'session-A', tempDir);

      // No legacy file created
      expect(legacyFileExists()).toBe(false);

      // Deactivate should succeed without error
      const result = deactivateUltrawork(tempDir, 'session-A');
      expect(result).toBe(true);
    });
  });
});
