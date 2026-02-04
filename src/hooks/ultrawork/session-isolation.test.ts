import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
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

      const state = readUltraworkState(tempDir);
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

      const state = readUltraworkState(tempDir);
      expect(state?.reinforcement_count).toBe(0);
    });

    it('should set started_at and last_checked_at timestamps', () => {
      const beforeTime = Date.now();
      activateUltrawork('Test task', 'session-1', tempDir);
      const afterTime = Date.now();

      const state = readUltraworkState(tempDir);
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
      deactivateUltrawork(tempDir);

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

      let state = readUltraworkState(tempDir);
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
      let updatedState = incrementReinforcement(tempDir);
      expect(updatedState?.reinforcement_count).toBe(1);

      // Second reinforcement check
      shouldReinforce = shouldReinforceUltrawork(sessionA, tempDir);
      expect(shouldReinforce).toBe(true);

      // Increment again
      updatedState = incrementReinforcement(tempDir);
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
      incrementReinforcement(tempDir);

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
      deactivateUltrawork(tempDir);
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
        incrementReinforcement(tempDir);
      }

      // Session ID should still be preserved
      const state = readUltraworkState(tempDir);
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

        deactivateUltrawork(tempDir);
      }
    });
  });

  describe('Integration with linked_to_ralph flag', () => {
    it('should preserve session_id when linked to ralph', () => {
      const sessionId = 'session-ralph-linked';
      activateUltrawork('Ralph-linked task', sessionId, tempDir, true);

      const state = readUltraworkState(tempDir);
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

      const state1 = readUltraworkState(tempDir);
      const state2 = readUltraworkState(tempDir);

      expect(state1).toEqual(state2);
      expect(state1?.session_id).toBe(sessionId);
      expect(state2?.session_id).toBe(sessionId);
    });

    it('should update last_checked_at on reinforcement without changing session_id', async () => {
      const sessionId = 'session-timestamp';
      activateUltrawork('Timestamp test', sessionId, tempDir);

      const initialState = readUltraworkState(tempDir);
      const initialTimestamp = initialState?.last_checked_at;

      // Wait a tiny bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      incrementReinforcement(tempDir);

      const updatedState = readUltraworkState(tempDir);
      expect(updatedState?.session_id).toBe(sessionId);
      // Timestamps are ISO strings, compare as dates
      expect(new Date(updatedState?.last_checked_at || 0).getTime())
        .toBeGreaterThanOrEqual(new Date(initialTimestamp || 0).getTime());
    });
  });
});
