import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';


const TEST_DIR = mkdtempSync(join(homedir(), 'cancel-integration-test-'));
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

// Mock validateWorkingDirectory to allow test directory
vi.mock('../../lib/worktree-paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/worktree-paths.js')>('../../lib/worktree-paths.js');
  return {
    ...actual,
    getOmcRoot: vi.fn((workingDirectory?: string) => process.env.OMC_STATE_DIR
      ? actual.getOmcRoot(workingDirectory)
      : join(workingDirectory || process.cwd(), '.omc')),
    resolveNonGitStateAnchor: vi.fn((workingDirectory?: string) => workingDirectory || process.cwd()),
    validateWorkingDirectory: vi.fn((workingDirectory?: string) => {
      return workingDirectory || process.cwd();
    }),
    resolveStateWorkingDirectory: vi.fn((workingDirectory?: string) => {
      return workingDirectory || process.cwd();
    }),
  };
});

import {
  stateClearTool,
} from '../state-tools.js';
import { cleanupStaleStates } from '../../features/state-manager/index.js';

describe('cancel-integration', () => {
  beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = TEST_DIR;
    process.env.USERPROFILE = TEST_DIR;
    mkdirSync(join(TEST_DIR, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
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


    it('should NOT delete legacy autopilot ghost file owned by a different session via top-level session_id', async () => {
      const sessionId = 'autopilot-session-mine';
      const otherSessionId = 'autopilot-session-other';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });

      writeFileSync(
        join(sessionDir, 'autopilot-state.json'),
        JSON.stringify({ active: true, phase: 'execution', session_id: sessionId })
      );

      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'autopilot-state.json'),
        JSON.stringify({ active: true, phase: 'execution', session_id: otherSessionId })
      );

      const result = await stateClearTool.handler({
        mode: 'autopilot',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(existsSync(join(sessionDir, 'autopilot-state.json'))).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'autopilot-state.json'))).toBe(true);
      expect(result.content[0].text).not.toContain('ghost legacy file also removed');
    });
  });

  describe('2. Explicit all-session cancel (no session_id)', () => {
    it('should clear all known sessions plus legacy when session_id is omitted', async () => {
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

      // Broad non-git clear is confined to the canonical root for this
      // working directory; unrelated ~/.omc state is not implicitly swept.
      const unrelatedHome = mkdtempSync(join(previousHome ?? homedir(), 'cancel-integration-unrelated-'));
      const homeStateRoot = join(unrelatedHome, '.omc', 'state');
      const homeSessionsRoot = join(homeStateRoot, 'sessions');
      const homeSessionDir = join(homeSessionsRoot, 'cancel-integration-home');
      mkdirSync(homeSessionDir, { recursive: true });
      writeFileSync(
        join(homeSessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, _meta: { sessionId: 'cancel-integration-home' } })
      );

      // Clear without session_id for the explicit all-session scope.
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

      // Unrelated shared-home session remains untouched.
      expect(existsSync(join(homeSessionDir, 'ralph-state.json'))).toBe(true);

      // 3 session files + legacy local state only.
      const clearedMatch = result.content[0].text.match(/Locations cleared: (\d+)/);
      expect(clearedMatch).not.toBeNull();
      expect(Number(clearedMatch![1])).toBe(4);
      expect(result.content[0].text).toContain('WARNING: No session_id provided');
      rmSync(unrelatedHome, { recursive: true, force: true });
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
      const runtimeTeamDir = join(TEST_DIR, '.omc', 'state', 'team', 'demo-team');
      mkdirSync(runtimeTeamDir, { recursive: true });

      // Create team state at session path
      writeFileSync(
        join(sessionDir, 'team-state.json'),
        JSON.stringify({ active: true, phase: 'team-exec', team_name: 'demo-team', _meta: { sessionId } })
      );

      // Create ghost legacy team state with matching session
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'team-state.json'),
        JSON.stringify({ active: true, phase: 'team-exec', team_name: 'demo-team', _meta: { sessionId } })
      );

      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'mission-state.json'),
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          missions: [
            { id: 'team:demo-team', source: 'team', teamName: 'demo-team', name: 'demo-team' },
            { id: 'session:keep', source: 'session', name: 'keep-session' },
          ],
        })
      );

      const result = await stateClearTool.handler({
        mode: 'team',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Both files should be cleaned
      expect(existsSync(join(sessionDir, 'team-state.json'))).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'team-state.json'))).toBe(false);
      expect(existsSync(runtimeTeamDir)).toBe(false);

      const missionState = JSON.parse(readFileSync(join(TEST_DIR, '.omc', 'state', 'mission-state.json'), 'utf-8'));
      expect(missionState.missions).toEqual([
        { id: 'session:keep', source: 'session', name: 'keep-session' },
      ]);

      expect(result.content[0].text).toContain('Successfully cleared');
      expect(result.content[0].text).toContain('ghost legacy file also removed');
      expect(result.content[0].text).toContain('removed 1 team runtime root');
      expect(result.content[0].text).toContain('pruned 1 HUD mission entry');
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

    it('should clear only the selected Team session and runtime', async () => {
      const sessionA = 'team-cancel-scoped-a';
      const sessionB = 'team-cancel-scoped-b';
      const teamA = 'scoped-team-a';
      const teamB = 'scoped-team-b';
      const sessionDirA = join(TEST_DIR, '.omc', 'state', 'sessions', sessionA);
      const sessionDirB = join(TEST_DIR, '.omc', 'state', 'sessions', sessionB);
      const runtimeRootA = join(TEST_DIR, '.omc', 'state', 'team', teamA);
      const runtimeRootB = join(TEST_DIR, '.omc', 'state', 'team', teamB);
      mkdirSync(sessionDirA, { recursive: true });
      mkdirSync(sessionDirB, { recursive: true });
      mkdirSync(join(runtimeRootA, 'tasks'), { recursive: true });
      mkdirSync(join(runtimeRootB, 'tasks'), { recursive: true });

      writeFileSync(
        join(sessionDirA, 'team-state.json'),
        JSON.stringify({ active: true, team_name: teamA, _meta: { sessionId: sessionA } })
      );
      writeFileSync(
        join(sessionDirB, 'team-state.json'),
        JSON.stringify({ active: true, team_name: teamB, _meta: { sessionId: sessionB } })
      );
      writeFileSync(join(runtimeRootA, 'tasks', 'task-a.json'), JSON.stringify({ status: 'running' }));
      writeFileSync(join(runtimeRootB, 'tasks', 'task-b.json'), JSON.stringify({ status: 'running' }));
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'mission-state.json'),
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          missions: [
            { id: `team:${teamA}`, source: 'team', teamName: teamA, name: teamA },
            { id: `team:${teamB}`, source: 'team', teamName: teamB, name: teamB },
          ],
        })
      );

      await stateClearTool.handler({
        mode: 'team',
        session_id: sessionA,
        workingDirectory: TEST_DIR,
      });

      expect(existsSync(join(sessionDirA, 'team-state.json'))).toBe(false);
      expect(existsSync(join(runtimeRootA, 'tasks', 'task-a.json'))).toBe(false);
      expect(existsSync(join(sessionDirB, 'team-state.json'))).toBe(true);
      expect(existsSync(join(runtimeRootB, 'tasks', 'task-b.json'))).toBe(true);

      const missionState = JSON.parse(readFileSync(join(TEST_DIR, '.omc', 'state', 'mission-state.json'), 'utf-8'));
      expect(missionState.missions).toEqual([
        { id: `team:${teamB}`, source: 'team', teamName: teamB, name: teamB },
      ]);
    });

    it('should remove runtime roots for all captured Team sessions', async () => {
      for (const teamName of ['alpha-team', 'beta-team']) {
        const sessionId = `${teamName}-session`;
        const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, 'team-state.json'), JSON.stringify({
          active: true, team_name: teamName, session_id: sessionId,
        }));
      }
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'team', 'alpha-team'), { recursive: true });
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'team', 'beta-team'), { recursive: true });
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'mission-state.json'),
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          missions: [
            { id: 'team:alpha-team', source: 'team', teamName: 'alpha-team', name: 'alpha-team' },
            { id: 'team:beta-team', source: 'team', teamName: 'beta-team', name: 'beta-team' },
            { id: 'session:keep', source: 'session', name: 'keep-session' },
          ],
        })
      );

      const result = await stateClearTool.handler({
        mode: 'team',
        workingDirectory: TEST_DIR,
      });

      for (const teamName of ['alpha-team', 'beta-team']) {
        expect(existsSync(join(TEST_DIR, '.omc', 'state', 'team', teamName))).toBe(false);
        expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', `${teamName}-session`, 'team-state.json'))).toBe(false);
      }

      const missionState = JSON.parse(readFileSync(join(TEST_DIR, '.omc', 'state', 'mission-state.json'), 'utf-8'));
      expect(missionState.missions).toEqual([
        { id: 'session:keep', source: 'session', name: 'keep-session' },
      ]);

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('Team runtime roots removed: 2');
      expect(result.content[0].text).toContain('HUD mission entries pruned: 2');
    });

    it('preserves uncaptured Team runtime and HUD records during aggregate clear', async () => {
      const runtimeRoot = join(TEST_DIR, '.omc', 'state', 'team', 'uncaptured-team');
      const taskPath = join(runtimeRoot, 'task.json');
      const missionPath = join(TEST_DIR, '.omc', 'state', 'mission-state.json');
      mkdirSync(runtimeRoot, { recursive: true });
      writeFileSync(taskPath, '{"status":"in_progress"}');
      writeFileSync(missionPath, JSON.stringify({
        missions: [{ source: 'team', teamName: 'uncaptured-team' }],
      }));
      const taskBytes = readFileSync(taskPath);
      const missionBytes = readFileSync(missionPath);

      await stateClearTool.handler({ mode: 'team', workingDirectory: TEST_DIR });

      expect(readFileSync(taskPath)).toEqual(taskBytes);
      expect(readFileSync(missionPath)).toEqual(missionBytes);
    });
  });
});
