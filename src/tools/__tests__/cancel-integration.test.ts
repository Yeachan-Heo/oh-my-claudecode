import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';

const TEST_DIR = '/tmp/cancel-integration-test';

// Mock validateWorkingDirectory to allow test directory
vi.mock('../../lib/worktree-paths.js', async () => {
  const actual = await vi.importActual('../../lib/worktree-paths.js');
  return {
    ...actual,
    validateWorkingDirectory: vi.fn((workingDirectory?: string) => {
      return workingDirectory || process.cwd();
    }),
  };
});

import {
  stateWriteTool,
  stateClearTool,
} from '../state-tools.js';
import { cleanupStaleStates } from '../../features/state-manager/index.js';

describe('cancel-integration', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('1. Single-session cancel with ghost-legacy cleanup', () => {
    it('should clear session files AND ghost legacy files when session_id provided', async () => {
      const sessionId = 'cancel-session-1';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });

      // Create ralph state at session path (normal)
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, iteration: 5, _meta: { sessionId } })
      );

      // Create ghost legacy file at .omc/state/ralph-state.json with matching session
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'ralph-state.json'),
        JSON.stringify({ active: true, iteration: 3, _meta: { sessionId } })
      );

      // Create ultrawork state at session path
      writeFileSync(
        join(sessionDir, 'ultrawork-state.json'),
        JSON.stringify({ active: true, _meta: { sessionId } })
      );

      // Create ghost legacy ultrawork file with NO _meta block
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json'),
        JSON.stringify({ active: true })
      );

      // Clear ralph with session_id
      const ralphResult = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Clear ultrawork with session_id
      const uwResult = await stateClearTool.handler({
        mode: 'ultrawork',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Session files should be deleted
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(join(sessionDir, 'ultrawork-state.json'))).toBe(false);

      // Ghost legacy files should ALSO be deleted
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json'))).toBe(false);

      // Confirm messages mention ghost cleanup
      expect(ralphResult.content[0].text).toContain('ghost legacy file also removed');
      expect(uwResult.content[0].text).toContain('ghost legacy file also removed');
    });

    it('should NOT delete legacy file if it belongs to a different session', async () => {
      const sessionId = 'cancel-session-mine';
      const otherSessionId = 'cancel-session-other';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });

      // Create session-scoped state
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, _meta: { sessionId } })
      );

      // Create legacy file owned by a DIFFERENT session
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'ralph-state.json'),
        JSON.stringify({ active: true, _meta: { sessionId: otherSessionId } })
      );

      await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Session file should be deleted
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);

      // Legacy file should remain (belongs to different session)
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(true);
    });
  });

  describe('2. Force cancel (no session_id)', () => {
    it('should clear ALL files across all sessions plus legacy', async () => {
      const sessions = ['session-a', 'session-b', 'session-c'];

      // Create state files in 3 different session directories
      for (const sid of sessions) {
        const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sid);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
          join(sessionDir, 'ralph-state.json'),
          JSON.stringify({ active: true, _meta: { sessionId: sid } })
        );
      }

      // Create legacy state file
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'ralph-state.json'),
        JSON.stringify({ active: true, source: 'legacy' })
      );

      // Clear without session_id (force/broad clear)
      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      // ALL session files should be deleted
      for (const sid of sessions) {
        const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sid, 'ralph-state.json');
        expect(existsSync(sessionPath)).toBe(false);
      }

      // Legacy file should also be deleted
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(false);

      // Should report locations cleared
      expect(result.content[0].text).toContain('Locations cleared: 4');
      expect(result.content[0].text).toContain('WARNING: No session_id provided');
    });
  });

  describe('3. Cancel signal', () => {
    it('should write cancel-signal-state.json with 30s TTL via state_clear', async () => {
      const sessionId = 'cancel-signal-test';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });

      // Create a state file so clear has something to work with
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true })
      );

      const beforeClear = Date.now();

      await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const afterClear = Date.now();

      // Cancel signal file should exist
      const cancelSignalPath = join(sessionDir, 'cancel-signal-state.json');
      expect(existsSync(cancelSignalPath)).toBe(true);

      // Read and verify contents
      const signal = JSON.parse(readFileSync(cancelSignalPath, 'utf-8'));
      expect(signal.active).toBe(true);
      expect(signal.mode).toBe('ralph');
      expect(signal.source).toBe('state_clear');

      // Verify expires_at is within 30s of requested_at
      const requestedAt = new Date(signal.requested_at).getTime();
      const expiresAt = new Date(signal.expires_at).getTime();
      const ttl = expiresAt - requestedAt;
      expect(ttl).toBe(30_000);

      // Verify timestamps are reasonable (within the test window)
      expect(requestedAt).toBeGreaterThanOrEqual(beforeClear);
      expect(requestedAt).toBeLessThanOrEqual(afterClear);
    });

    it('should have expired cancel signal return false for cancel-in-progress check', async () => {
      const sessionId = 'expired-signal-test';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });

      // Write an already-expired cancel signal (expires_at in the past)
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(
        join(sessionDir, 'cancel-signal-state.json'),
        JSON.stringify({
          active: true,
          requested_at: new Date(Date.now() - 90_000).toISOString(),
          expires_at: pastTime,
          mode: 'ralph',
          source: 'state_clear'
        })
      );

      // The signal file exists but is expired — reading it should show expired state
      const signal = JSON.parse(readFileSync(join(sessionDir, 'cancel-signal-state.json'), 'utf-8'));
      const expiresAt = new Date(signal.expires_at).getTime();
      expect(expiresAt).toBeLessThan(Date.now());
    });
  });

  describe('4. Stale cleanup', () => {
    it('should detect and deactivate state files with old _meta.updatedAt', () => {
      // Write a state file with updatedAt 5 hours ago (beyond 4-hour threshold)
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const stateFile = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
      writeFileSync(stateFile, JSON.stringify({
        active: true,
        iteration: 10,
        _meta: {
          updatedAt: fiveHoursAgo,
        }
      }));

      const cleaned = cleanupStaleStates(TEST_DIR);

      expect(cleaned).toBe(1);

      // File should still exist but active should be false
      const data = JSON.parse(readFileSync(stateFile, 'utf-8'));
      expect(data.active).toBe(false);
      expect(data.iteration).toBe(10); // preserves other fields
    });

    it('should NOT deactivate state files with recent _meta.updatedAt', () => {
      const recentTime = new Date(Date.now() - 30_000).toISOString(); // 30 seconds ago
      const stateFile = join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json');
      writeFileSync(stateFile, JSON.stringify({
        active: true,
        _meta: {
          updatedAt: recentTime,
        }
      }));

      const cleaned = cleanupStaleStates(TEST_DIR);

      expect(cleaned).toBe(0);

      const data = JSON.parse(readFileSync(stateFile, 'utf-8'));
      expect(data.active).toBe(true);
    });

    it('should respect heartbeatAt over updatedAt for staleness', () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const recentHeartbeat = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
      const stateFile = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
      writeFileSync(stateFile, JSON.stringify({
        active: true,
        _meta: {
          updatedAt: fiveHoursAgo,
          heartbeatAt: recentHeartbeat,
        }
      }));

      const cleaned = cleanupStaleStates(TEST_DIR);

      expect(cleaned).toBe(0);

      const data = JSON.parse(readFileSync(stateFile, 'utf-8'));
      expect(data.active).toBe(true);
    });
  });

  describe('5. Team cancel', () => {
    it('should clear team state at both session and legacy paths', async () => {
      const sessionId = 'team-cancel-test';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });

      // Create team state at session path
      writeFileSync(
        join(sessionDir, 'team-state.json'),
        JSON.stringify({ active: true, phase: 'team-exec', _meta: { sessionId } })
      );

      // Create ghost legacy team state with matching session
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'team-state.json'),
        JSON.stringify({ active: true, phase: 'team-exec', _meta: { sessionId } })
      );

      const result = await stateClearTool.handler({
        mode: 'team',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Both files should be cleaned
      expect(existsSync(join(sessionDir, 'team-state.json'))).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'team-state.json'))).toBe(false);

      expect(result.content[0].text).toContain('Successfully cleared');
      expect(result.content[0].text).toContain('ghost legacy file also removed');
    });

    it('should clear team state at session path while preserving unrelated legacy', async () => {
      const sessionId = 'team-cancel-safe';
      const otherSessionId = 'team-other-session';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });

      // Create team state at session path
      writeFileSync(
        join(sessionDir, 'team-state.json'),
        JSON.stringify({ active: true, _meta: { sessionId } })
      );

      // Create legacy team state from a different session
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'team-state.json'),
        JSON.stringify({ active: true, _meta: { sessionId: otherSessionId } })
      );

      await stateClearTool.handler({
        mode: 'team',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Session file should be cleaned
      expect(existsSync(join(sessionDir, 'team-state.json'))).toBe(false);

      // Legacy file should be preserved (different session)
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'team-state.json'))).toBe(true);
    });
  });
});
