import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  stateReadTool,
  stateWriteTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
} from '../state-tools.js';
import { emergencyMutateStateFileIf } from '../../lib/mode-state-io.js';

const TEST_DIR = '/tmp/state-tools-test';

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

function liveLockOwner() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  return JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() });
}

describe('state-tools', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64;
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
  });

  describe('state_read', () => {
    it('should return state when file exists at session-scoped path', async () => {
      const sessionId = 'session-read-test';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, iteration: 3 })
      );

      const result = await stateReadTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('active');
      expect(result.content[0].text).toContain('iteration');
    });

    it('should indicate when no state exists', async () => {
      const result = await stateReadTool.handler({
        mode: 'ultrawork',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('No state found');
    });
  });

  describe('state_write', () => {
    it('should write state to legacy path when no session_id provided', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true, iteration: 1 },
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
      const legacyPath = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
      expect(existsSync(legacyPath)).toBe(true);
    });

    it('should add _meta field to written state', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { someField: 'value' },
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
      expect(result.content[0].text).toContain('_meta');
    });

    it('should include session ID in _meta when provided', async () => {
      const sessionId = 'session-meta-test';
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain(`"sessionId": "${sessionId}"`);
    });
    it('does not let a lock-held Stop be overwritten by state_write cancellation', async () => {
      const sessionId = 'stop-cancel-race';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ active: true, trackingRevision: 0 }));
      const before = readFileSync(statePath);
      const lockPath = `${statePath}.mutation.lock`;
      writeFileSync(lockPath, liveLockOwner());

      const blocked = await stateWriteTool.handler({ mode: 'autopilot', active: false, session_id: sessionId, workingDirectory: TEST_DIR });
      expect(blocked.isError).toBe(true);
      expect(readFileSync(statePath)).toEqual(before);

      unlinkSync(lockPath);
      const retried = await stateWriteTool.handler({ mode: 'autopilot', active: false, session_id: sessionId, workingDirectory: TEST_DIR });
      expect(retried.isError).not.toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).active).toBe(false);
    });

    it('does not clear activation state while its mutation lock is held', async () => {
      const sessionId = 'activation-cleanup-race';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      await stateWriteTool.handler({ mode: 'autopilot', active: true, session_id: sessionId, workingDirectory: TEST_DIR });
      const lockPath = `${statePath}.mutation.lock`;
      writeFileSync(lockPath, liveLockOwner());

      const blocked = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(blocked.content[0].text).toMatch(/Warning|No active|Successfully/);
      expect(existsSync(statePath)).toBe(true);

      unlinkSync(lockPath);
      const retried = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(retried.isError).not.toBe(true);
      expect(existsSync(statePath)).toBe(false);
    });

    it('preserves session and legacy replacements created after cleanup discovery', async () => {
      const sessionId = 'stale-cleanup-owner';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      await stateWriteTool.handler({ mode: 'autopilot', active: true, session_id: sessionId, workingDirectory: TEST_DIR });
      const replacement = { active: true, session_id: sessionId, workflowRunId: 'replacement-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);

      const legacyPath = join(TEST_DIR, '.omc', 'state', 'autopilot-state.json');
      writeFileSync(legacyPath, JSON.stringify({ active: true, session_id: sessionId, workflowRunId: 'old-run' }));
      const legacyReplacement = { active: true, session_id: sessionId, workflowRunId: 'new-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = legacyPath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(legacyReplacement)).toString('base64');

      await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toEqual(legacyReplacement);
    });
  });

    it('pauses named autopilot exactly without flock', async () => {
      const sessionId = 'named-write-no-flock';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      const state = { active: true, session_id: sessionId, workflowRunId: '11111111-1111-4111-8111-111111111111', workflow: { profileHash: 'a'.repeat(64) } };
      writeFileSync(statePath, JSON.stringify(state));
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

      const result = await stateWriteTool.handler({ mode: 'autopilot', active: false, session_id: sessionId, state: { workflowRunId: state.workflowRunId }, workingDirectory: TEST_DIR });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ active: false, workflowRunId: state.workflowRunId });
    });

  describe('state_clear', () => {
    it('clears session and broad named autopilot exactly without flock and without signals', async () => {
      const sessionId = 'named-clear-no-flock';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ active: true, session_id: sessionId, workflowRunId: '11111111-1111-4111-8111-111111111111', workflow: { profileHash: 'a'.repeat(64) } }));
      const before = readFileSync(statePath);
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

      const sessionResult = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(sessionResult.isError).toBeUndefined();
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'cancel-signal-state.json'))).toBe(false);

      writeFileSync(statePath, before);
      const broadResult = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
      expect(broadResult.isError).toBeUndefined();
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'cancel-signal-state.json'))).toBe(false);
    });

    it('exact-clears every recovered named primary before session cleanup', async () => {
      const sessionId = 'multi-named-owner';
      const canonical = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const stranded = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-dir', 'autopilot-state.json');
      const state = { active: true, session_id: sessionId, workflowRunId: '11111111-1111-4111-8111-111111111111', workflow: { profileHash: 'a'.repeat(64) } };
      mkdirSync(dirname(canonical), { recursive: true });
      mkdirSync(dirname(stranded), { recursive: true });
      writeFileSync(canonical, JSON.stringify(state));
      writeFileSync(stranded, JSON.stringify({ ...state, workflowRunId: '22222222-2222-4222-8222-222222222222' }));
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';

      const result = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(result.isError).toBeUndefined();
      expect(existsSync(canonical)).toBe(false);
      expect(existsSync(stranded)).toBe(false);
    });

    it('recovers an interrupted named pause before clear candidate discovery', async () => {
      const sessionId = 'interrupted-pause-clear';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      const state = { active: true, session_id: sessionId, workflowRunId: '11111111-1111-4111-8111-111111111111', workflow: { profileHash: 'a'.repeat(64) } };
      writeFileSync(statePath, JSON.stringify(state));
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
      expect((await stateWriteTool.handler({ mode: 'autopilot', active: false, session_id: sessionId, state: { workflowRunId: state.workflowRunId }, workingDirectory: TEST_DIR })).isError).toBe(true);
      delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(true);

      const result = await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      expect(result.isError).toBeUndefined();
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(`${statePath}.emergency-journal.json`)).toBe(false);
    });

    it('recovers interrupted canonical and legacy named pauses before broad clear', async () => {
      const canonical = join(TEST_DIR, '.omc', 'state', 'sessions', 'broad-journal-owner', 'autopilot-state.json');
      const legacy = join(TEST_DIR, '.omc', 'state', 'autopilot-state.json');
      for (const [path, run] of [[canonical, '22222222-2222-4222-8222-222222222222'], [legacy, '33333333-3333-4333-8333-333333333333']] as const) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ active: true, session_id: 'broad-journal-owner', workflowRunId: run, workflow: { profileHash: 'b'.repeat(64) } }));
        process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
        expect(emergencyMutateStateFileIf(path, (state) => state.workflowRunId === run, (state) => ({ ...state, active: false }))).toBe(false);
        delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
        expect(existsSync(`${path}.emergency-journal.json`)).toBe(true);
      }

      const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
      expect(result.isError).toBeUndefined();
      for (const path of [canonical, legacy]) {
        expect(existsSync(path)).toBe(false);
        expect(existsSync(`${path}.emergency-journal.json`)).toBe(false);
      }
    });
    it('should remove legacy state file when no session_id provided', async () => {
      await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true },
        workingDirectory: TEST_DIR,
      });

      const legacyPath = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
      expect(existsSync(legacyPath)).toBe(true);

      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toMatch(/cleared|Successfully/i);
      expect(existsSync(legacyPath)).toBe(false);
    });

    it('should clear ralplan state with explicit session_id', async () => {
      const sessionId = 'test-session-ralplan';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralplan-state.json'),
        JSON.stringify({ active: true })
      );

      const result = await stateClearTool.handler({
        mode: 'ralplan',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('cleared');
      expect(existsSync(join(sessionDir, 'ralplan-state.json'))).toBe(false);
    });

    it('should also remove non-session legacy state files during session clear', async () => {
      const sessionId = 'legacy-cleanup-session';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: sessionId }),
      );

      const legacyRootPath = join(TEST_DIR, '.omc', 'ralph-state.json');
      writeFileSync(
        legacyRootPath,
        JSON.stringify({ active: true, session_id: sessionId }),
      );

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('ghost legacy file also removed');
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(legacyRootPath)).toBe(false);
    });

    it('should clear only the requested session for every execution mode', async () => {
      const modes = ['autopilot', 'autoresearch', 'ralph', 'ultrawork', 'ultraqa', 'team'] as const;
      const sessionA = 'session-a';
      const sessionB = 'session-b';

      for (const mode of modes) {
        await stateWriteTool.handler({
          mode,
          state: { active: true, owner: 'A' },
          session_id: sessionA,
          workingDirectory: TEST_DIR,
        });
        await stateWriteTool.handler({
          mode,
          state: { active: true, owner: 'B' },
          session_id: sessionB,
          workingDirectory: TEST_DIR,
        });

        const clearResult = await stateClearTool.handler({
          mode,
          session_id: sessionA,
          workingDirectory: TEST_DIR,
        });

        expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);

        const sessionAPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionA, `${mode}-state.json`);
        const sessionBPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionB, `${mode}-state.json`);

        expect(existsSync(sessionAPath)).toBe(false);
        expect(existsSync(sessionBPath)).toBe(true);
      }
    });

    it('should clear legacy and all sessions when session_id is omitted and show warning', async () => {
      const sessionId = 'aggregate-clear';
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true, source: 'legacy' },
        workingDirectory: TEST_DIR,
      });
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true, source: 'session' },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateClearTool.handler({
        mode: 'ultrawork',
        workingDirectory: TEST_DIR,
      });

      const legacyPath = join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json');
      const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');

      expect(result.content[0].text).toContain('WARNING: No session_id provided');
      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(sessionPath)).toBe(false);
    });

    it('lists and clears active legacy global ralph state without touching unrelated state', async () => {
      const homeRoot = mkdtempSync(join(tmpdir(), 'state-tools-home-'));
      vi.stubEnv('HOME', homeRoot);
      vi.stubEnv('USERPROFILE', homeRoot);
      try {
        const legacyGlobalStateDir = join(homeRoot, '.omc', 'state');
        mkdirSync(legacyGlobalStateDir, { recursive: true });
        const ralphPath = join(legacyGlobalStateDir, 'ralph-state.json');
        const unrelatedPath = join(legacyGlobalStateDir, 'ultrawork-state.json');
        writeFileSync(ralphPath, JSON.stringify({ active: true, legacy: true }));
        writeFileSync(unrelatedPath, JSON.stringify({ active: true, unrelated: true }));

        const listResult = await stateListActiveTool.handler({
          all: true,
          workingDirectory: TEST_DIR,
        });
        expect(listResult.content[0].text).toContain('ralph');

        const clearResult = await stateClearTool.handler({
          mode: 'ralph',
          workingDirectory: TEST_DIR,
        });
        expect(clearResult.content[0].text).toMatch(/Cleared|Successfully/i);
        expect(existsSync(ralphPath)).toBe(false);
        expect(existsSync(unrelatedPath)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        rmSync(homeRoot, { recursive: true, force: true });
      }
    });

    it('lists and clears worktree-local session ralph state with session cwd context only', async () => {
      const centralizedRoot = mkdtempSync(join(tmpdir(), 'state-tools-central-'));
      vi.stubEnv('OMC_STATE_DIR', centralizedRoot);
      try {
        const sessionId = 'local-ralph-session';
        const unrelatedSessionId = 'unrelated-session';
        const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
        const unrelatedSessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', unrelatedSessionId);
        mkdirSync(sessionDir, { recursive: true });
        mkdirSync(unrelatedSessionDir, { recursive: true });
        const localRalphPath = join(sessionDir, 'ralph-state.json');
        const unrelatedRalphPath = join(unrelatedSessionDir, 'ralph-state.json');
        writeFileSync(localRalphPath, JSON.stringify({ active: true, session_id: sessionId }));
        writeFileSync(unrelatedRalphPath, JSON.stringify({ active: true, session_id: unrelatedSessionId }));

        const listResult = await stateListActiveTool.handler({
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });
        expect(listResult.content[0].text).toContain('ralph');

        const clearResult = await stateClearTool.handler({
          mode: 'ralph',
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });
        expect(clearResult.content[0].text).toContain('cleared');
        expect(existsSync(localRalphPath)).toBe(false);
        expect(existsSync(unrelatedRalphPath)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        rmSync(centralizedRoot, { recursive: true, force: true });
      }
    });

    it('should not report false errors for sessions with no state file during broad clear', async () => {
      // Create a session directory but no state file for ralph mode
      const sessionId = 'empty-session';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      // Note: no state file created - simulating a session with no ralph state

      // Create state for a different mode in the same session
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Now clear ralph mode (which has no state in this session)
      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      // Should report "No state found" not errors
      expect(result.content[0].text).toContain('No state found');
      expect(result.content[0].text).not.toContain('Errors:');
    });

    it('should only count actual deletions in broad clear count', async () => {
      // Create state in only one session out of multiple
      const sessionWithState = 'has-state';
      const sessionWithoutState = 'no-state';

      // Create session directories
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', sessionWithState), { recursive: true });
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', sessionWithoutState), { recursive: true });

      // Only create state for one session
      await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true },
        session_id: sessionWithState,
        workingDirectory: TEST_DIR,
      });

      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      // Should report exactly 1 location cleared (the session with state)
      expect(result.content[0].text).toContain('Locations cleared: 1');
      expect(result.content[0].text).not.toContain('Errors:');
    });

    it('does not count a broad-clear replacement run as deleted', async () => {
      await stateWriteTool.handler({ mode: 'autopilot', active: true, state: { workflowRunId: 'old-run' }, workingDirectory: TEST_DIR });
      const statePath = join(TEST_DIR, '.omc', 'state', 'autopilot-state.json');
      const replacement = { active: true, workflowRunId: 'replacement-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);
      expect(result.content[0].text).not.toContain('Locations cleared: 1');
      expect(result.content[0].text).toContain('skipped');
      expect(result.isError).toBe(true);
    });

    it('clears a stranded recovered workflow by its captured path in broad mode', async () => {
      const strandedPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-dir', 'autopilot-state.json');
      mkdirSync(dirname(strandedPath), { recursive: true });
      writeFileSync(strandedPath, JSON.stringify({ active: true, session_id: 'owner-session', workflowRunId: '44444444-4444-4444-8444-444444444444' }));

      const result = await stateClearTool.handler({ mode: 'autopilot', workingDirectory: TEST_DIR });
      expect(existsSync(strandedPath)).toBe(false);
      expect(result.content[0].text).toContain('Locations cleared: 1');
      expect(result.isError).not.toBe(true);
      const signalPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'owner-session', 'cancel-signal-state.json');
      expect(JSON.parse(readFileSync(signalPath, 'utf8')).target_workflow_run_id).toBe('44444444-4444-4444-8444-444444444444');
    });

    it('reports a broad converged-path replacement as incomplete', async () => {
      const sessionId = 'converged-replacement';
      await stateWriteTool.handler({ mode: 'ralph', active: true, session_id: sessionId, workingDirectory: TEST_DIR });
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
      const replacement = { active: true, session_id: sessionId, workflowRunId: 'replacement-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      const result = await stateClearTool.handler({ mode: 'ralph', workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);
      expect(result.content[0].text).not.toContain('Locations cleared: 1');
      expect(result.content[0].text).toContain('survived');
      expect(result.isError).toBe(true);
    });

    it('should clear skill-active state with session_id (fix for #2118)', async () => {
      const sessionId = 'test-skill-active-clear';

      await stateWriteTool.handler({
        mode: 'skill-active',
        active: true,
        state: { skill_name: 'sciomc', reinforcement_count: 2 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      // Verify skill-active appears in the active list before clearing
      const listBefore = await stateListActiveTool.handler({
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });
      expect(listBefore.content[0].text).toContain('skill-active');

      const clearResult = await stateClearTool.handler({
        mode: 'skill-active',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(clearResult.content[0].text).toContain('cleared');

      const readResult = await stateReadTool.handler({
        mode: 'skill-active',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });
      // stateReadTool returning "No state found" is authoritative proof the file is gone
      expect(readResult.content[0].text).toContain('No state found');
    });

    it('clears completed-session orphan state when cancel runs from a fresh session id', async () => {
      const freshSessionId = 'fresh-cancel-session';
      const liveSessionId = 'live-sibling-session';
      const orphanSessionIds = ['ended-session-one', 'ended-session-two'];
      const modes = ['ralph', 'ultrawork', 'team'] as const;

      mkdirSync(join(TEST_DIR, '.omc', 'sessions'), { recursive: true });

      for (const orphanSessionId of orphanSessionIds) {
        mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId), { recursive: true });
        writeFileSync(
          join(TEST_DIR, '.omc', 'sessions', `${orphanSessionId}.json`),
          JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }),
        );
      }
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId), { recursive: true });

      for (const mode of modes) {
        for (const orphanSessionId of orphanSessionIds) {
          writeFileSync(
            join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, `${mode}-state.json`),
            JSON.stringify({
              active: true,
              session_id: orphanSessionId,
              ...(mode === 'team' ? { team_name: `team-${orphanSessionId}` } : {}),
            }),
          );
        }
        writeFileSync(
          join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId, `${mode}-state.json`),
          JSON.stringify({ active: true, session_id: liveSessionId }),
        );

        const result = await stateClearTool.handler({
          mode,
          session_id: freshSessionId,
          workingDirectory: TEST_DIR,
        });

        expect(result.content[0].text).toContain('completed-session orphan');
        for (const orphanSessionId of orphanSessionIds) {
          expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, `${mode}-state.json`))).toBe(false);
        }
        expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', liveSessionId, `${mode}-state.json`))).toBe(true);
      }
    });

    it('preserves a replacement run at a completed-session candidate path', async () => {
      const requester = 'fresh-cancel';
      const endedSession = 'ended-replaced-session';
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', endedSession, 'ultrawork-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      mkdirSync(join(TEST_DIR, '.omc', 'sessions'), { recursive: true });
      writeFileSync(join(TEST_DIR, '.omc', 'sessions', `${endedSession}.json`), JSON.stringify({ session_id: endedSession, ended_at: '2026-05-04T00:00:00.000Z' }));
      writeFileSync(statePath, JSON.stringify({ active: true, session_id: endedSession, workflowRunId: 'old-run' }));
      const replacement = { active: true, session_id: endedSession, workflowRunId: 'replacement-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = statePath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      await stateClearTool.handler({ mode: 'ultrawork', session_id: requester, workingDirectory: TEST_DIR });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(replacement);
    });

    it('reports completed-session orphan state on session-scoped read misses', async () => {
      const freshSessionId = 'fresh-read-session';
      const orphanSessionId = 'ended-read-session';
      mkdirSync(join(TEST_DIR, '.omc', 'sessions'), { recursive: true });
      mkdirSync(join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId), { recursive: true });
      writeFileSync(
        join(TEST_DIR, '.omc', 'sessions', `${orphanSessionId}.json`),
        JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }),
      );
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'sessions', orphanSessionId, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: orphanSessionId }),
      );

      const result = await stateReadTool.handler({
        mode: 'ralph',
        session_id: freshSessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('completed-session orphan');
      expect(result.content[0].text).toContain(orphanSessionId);
    });

    it('clears completed-session orphan state through a symlinked .omc directory', async () => {
      const symlinkTestDir = mkdtempSync(join(tmpdir(), 'state-tools-symlink-'));
      const realOmcDir = mkdtempSync(join(tmpdir(), 'state-tools-real-omc-'));
      try {
        rmSync(join(symlinkTestDir, '.omc'), { recursive: true, force: true });
        symlinkSync(realOmcDir, join(symlinkTestDir, '.omc'), 'dir');
        const orphanSessionId = 'ended-symlink-session';
        const freshSessionId = 'fresh-symlink-session';
        mkdirSync(join(realOmcDir, 'sessions'), { recursive: true });
        mkdirSync(join(realOmcDir, 'state', 'sessions', orphanSessionId), { recursive: true });
        writeFileSync(
          join(realOmcDir, 'sessions', `${orphanSessionId}.json`),
          JSON.stringify({ session_id: orphanSessionId, ended_at: '2026-05-04T00:00:00.000Z' }),
        );
        writeFileSync(
          join(realOmcDir, 'state', 'sessions', orphanSessionId, 'ultrawork-state.json'),
          JSON.stringify({ active: true, session_id: orphanSessionId }),
        );

        const result = await stateClearTool.handler({
          mode: 'ultrawork',
          session_id: freshSessionId,
          workingDirectory: symlinkTestDir,
        });

        expect(result.content[0].text).toContain('completed-session orphan');
        expect(existsSync(join(realOmcDir, 'state', 'sessions', orphanSessionId, 'ultrawork-state.json'))).toBe(false);
      } finally {
        rmSync(symlinkTestDir, { recursive: true, force: true });
        rmSync(realOmcDir, { recursive: true, force: true });
      }
    });

    it('should list skill-active as active when state file is present', async () => {
      const sessionId = 'skill-active-list-test';

      await stateWriteTool.handler({
        mode: 'skill-active',
        active: true,
        state: { skill_name: 'learner' },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('skill-active');
    });
  });

  describe('state_list_active', () => {
    it('should list active modes in current session when session_id provided', async () => {
      const sessionId = 'active-session-test';
      await stateWriteTool.handler({
        mode: 'ralph',
        active: true,
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('ralph');
    });

    it('should list active modes across sessions when session_id omitted', async () => {
      const sessionId = 'aggregate-session';
      await stateWriteTool.handler({
        mode: 'ultrawork',
        active: true,
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('ultrawork');
      expect(result.content[0].text).toContain(sessionId);
    });

    it('should include team mode when team state is active', async () => {
      await stateWriteTool.handler({
        mode: 'team',
        active: true,
        state: { phase: 'team-exec' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('team');
    });

    it('should include autoresearch mode when autoresearch state is active', async () => {
      await stateWriteTool.handler({
        mode: 'autoresearch',
        active: true,
        state: { phase: 'running' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('autoresearch');
    });

    it('should include deep-interview mode when deep-interview state is active', async () => {
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { phase: 'questioning' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('deep-interview');
    });

    it('should include self-improve mode when self-improve state is active', async () => {
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 1 },
        workingDirectory: TEST_DIR,
      });

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('self-improve');
    });

    it('should include team in status output when team state is active', async () => {
      await stateWriteTool.handler({
        mode: 'team',
        active: true,
        state: { phase: 'team-verify' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateGetStatusTool.handler({
        mode: 'team',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Status: team');
      expect(result.content[0].text).toContain('**Active:** Yes');
    });

    it('deep-interview and self-improve appear in all-mode status listing', async () => {
      const result = await stateGetStatusTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('deep-interview');
      expect(result.content[0].text).toContain('self-improve');
    });
  });

  // -----------------------------------------------------------------------
  // Registry parity: deep-interview and self-improve as first-class modes
  // -----------------------------------------------------------------------
  describe('deep-interview and self-improve registry parity (T1)', () => {
    it('writes deep-interview state to session-scoped path via MODE_CONFIGS routing', async () => {
      const sessionId = 'di-registry-write';
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'questioning', round: 3 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'deep-interview-state.json');
      expect(existsSync(statePath)).toBe(true);
    });

    it('writes self-improve state to session-scoped path via MODE_CONFIGS routing', async () => {
      const sessionId = 'si-registry-write';
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 1, best_score: 0.85 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'self-improve-state.json');
      expect(existsSync(statePath)).toBe(true);
    });

    it('reads deep-interview state back from session-scoped path', async () => {
      const sessionId = 'di-registry-read';
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'questioning', ambiguity_score: 0.34 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateReadTool.handler({
        mode: 'deep-interview',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('current_phase');
      expect(result.content[0].text).toContain('ambiguity_score');
    });

    it('reads self-improve state back from session-scoped path', async () => {
      const sessionId = 'si-registry-read';
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 2, generation: 5 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const result = await stateReadTool.handler({
        mode: 'self-improve',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('tournament_round');
      expect(result.content[0].text).toContain('generation');
    });

    it('clears deep-interview state file for given session', async () => {
      const sessionId = 'di-registry-clear';
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'analysis' },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const clearResult = await stateClearTool.handler({
        mode: 'deep-interview',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'deep-interview-state.json');
      expect(existsSync(statePath)).toBe(false);
    });

    it('clears self-improve state file for given session', async () => {
      const sessionId = 'si-registry-clear';
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 3 },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      const clearResult = await stateClearTool.handler({
        mode: 'self-improve',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(clearResult.content[0].text).toMatch(/cleared|Successfully/i);
      const statePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'self-improve-state.json');
      expect(existsSync(statePath)).toBe(false);
    });

    it('state_get_status reports self-improve as active when state file is present', async () => {
      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 2 },
        workingDirectory: TEST_DIR,
      });

      const result = await stateGetStatusTool.handler({
        mode: 'self-improve',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Status: self-improve');
      expect(result.content[0].text).toContain('**Active:** Yes');
    });

    it('state_get_status reports deep-interview as active when state file is present', async () => {
      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'contrarian' },
        workingDirectory: TEST_DIR,
      });

      const result = await stateGetStatusTool.handler({
        mode: 'deep-interview',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Status: deep-interview');
      expect(result.content[0].text).toContain('**Active:** Yes');
    });

    it('deep-interview session isolation: write to session A does not appear under session B', async () => {
      const sessionA = 'di-iso-a';
      const sessionB = 'di-iso-b';

      await stateWriteTool.handler({
        mode: 'deep-interview',
        active: true,
        state: { current_phase: 'questioning' },
        session_id: sessionA,
        workingDirectory: TEST_DIR,
      });

      const resultB = await stateReadTool.handler({
        mode: 'deep-interview',
        session_id: sessionB,
        workingDirectory: TEST_DIR,
      });

      expect(resultB.content[0].text).toContain('No state found');
    });

    it('self-improve session isolation: write to session A does not appear under session B', async () => {
      const sessionA = 'si-iso-a';
      const sessionB = 'si-iso-b';

      await stateWriteTool.handler({
        mode: 'self-improve',
        active: true,
        state: { tournament_round: 1 },
        session_id: sessionA,
        workingDirectory: TEST_DIR,
      });

      const resultB = await stateReadTool.handler({
        mode: 'self-improve',
        session_id: sessionB,
        workingDirectory: TEST_DIR,
      });

      expect(resultB.content[0].text).toContain('No state found');
    });
  });

  describe('state_get_status', () => {
    it('should return status for specific mode', async () => {
      const result = await stateGetStatusTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Status: ralph');
      expect(result.content[0].text).toContain('Active:');
    });

    it('should return all mode statuses when no mode specified', async () => {
      const result = await stateGetStatusTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('All Mode Statuses');
      expect(
        result.content[0].text.includes('[ACTIVE]') || result.content[0].text.includes('[INACTIVE]')
      ).toBe(true);
    });
  });

  describe('session_id parameter', () => {
    it('should write state with explicit session_id to session-scoped path', async () => {
      const sessionId = 'test-session-123';
      const result = await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true },
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
      const sessionPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json');
      expect(existsSync(sessionPath)).toBe(true);
    });

    it('should read state with explicit session_id from session-scoped path', async () => {
      const sessionId = 'test-session-read';
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: sessionId })
      );

      const result = await stateReadTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('active');
    });

    it('should clear session-specific state without affecting legacy owned by another session', async () => {
      const sessionId = 'test-session-clear';
      const otherSessionId = 'other-session-owner';

      // Create legacy state owned by a different session
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'ralph-state.json'),
        JSON.stringify({ active: true, source: 'legacy', _meta: { sessionId: otherSessionId } })
      );
      const sessionDir = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, source: 'session' })
      );

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('cleared');
      // Session-scoped file should be gone
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
      // Legacy file should remain (belongs to different session)
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(true);
    });

    it('should clear recovered session-owned state stranded under another session directory', async () => {
      const sessionId = 'continued-session';
      const strandedDir = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-session-dir');
      mkdirSync(strandedDir, { recursive: true });
      writeFileSync(
        join(strandedDir, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: sessionId, source: 'recovered-session-state' })
      );

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('recovered session file');
      expect(existsSync(join(strandedDir, 'ralph-state.json'))).toBe(false);
    });

    it('should clear ralph stop-hook runtime artifacts with session-scoped cancel cleanup', async () => {
      const sessionId = 'ralph-stop-artifact-session';
      const stateDir = join(TEST_DIR, '.omc', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'ralph-state.json'),
        JSON.stringify({ active: true, session_id: sessionId }),
      );
      writeFileSync(join(sessionDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 3 }));
      writeFileSync(join(stateDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 3 }));
      writeFileSync(join(stateDir, 'ralph-last-steer-at'), new Date().toISOString());
      writeFileSync(join(stateDir, 'ralph-continue-steer.lock'), `${process.pid}`);

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('runtime artifact');
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(join(sessionDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-last-steer-at'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-continue-steer.lock'))).toBe(false);
    });

    it('targets a recovered named workflow candidate in the cancel signal', async () => {
      const sessionId = 'recovered-workflow-owner';
      const strandedPath = join(TEST_DIR, '.omc', 'state', 'sessions', 'stale-workflow-dir', 'autopilot-state.json');
      mkdirSync(dirname(strandedPath), { recursive: true });
      writeFileSync(strandedPath, JSON.stringify({ active: true, session_id: sessionId, workflowRunId: '33333333-3333-4333-8333-333333333333' }));

      await stateClearTool.handler({ mode: 'autopilot', session_id: sessionId, workingDirectory: TEST_DIR });
      const signalPath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'cancel-signal-state.json');
      expect(JSON.parse(readFileSync(signalPath, 'utf8')).target_workflow_run_id).toBe('33333333-3333-4333-8333-333333333333');
      expect(existsSync(strandedPath)).toBe(false);
    });

    it('does not clear a singleton live autopilot owned by another active session', async () => {
      const currentSessionId = 'fresh-autopilot-cancel-session';
      const ownerSessionId = 'live-autopilot-owner-session';
      const ownerDir = join(TEST_DIR, '.omc', 'state', 'sessions', ownerSessionId);
      mkdirSync(ownerDir, { recursive: true });
      writeFileSync(
        join(ownerDir, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          session_id: ownerSessionId,
          phase: 'execution',
          current_phase: 'execution',
        }),
      );

      const result = await stateClearTool.handler({
        mode: 'autopilot',
        session_id: currentSessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('No state found to clear for mode: autopilot');
      expect(result.content[0].text).toContain('Checked paths');
      expect(existsSync(join(ownerDir, 'autopilot-state.json'))).toBe(true);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', currentSessionId, 'cancel-signal-state.json'))).toBe(true);
      expect(existsSync(join(ownerDir, 'cancel-signal-state.json'))).toBe(false);
    });

    it('should clear the owning session when the current session resumed ralph from a different conversation', async () => {
      const currentSessionId = 'resume-session-b';
      const ownerSessionId = 'resume-session-a';
      const ownerDir = join(TEST_DIR, '.omc', 'state', 'sessions', ownerSessionId);
      mkdirSync(ownerDir, { recursive: true });
      writeFileSync(
        join(ownerDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          session_id: ownerSessionId,
          iteration: 4,
          linked_ultrawork: true,
        }),
      );

      const result = await stateClearTool.handler({
        mode: 'ralph',
        session_id: currentSessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain(`cleared owning session: ${ownerSessionId}`);
      expect(existsSync(join(ownerDir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'sessions', currentSessionId, 'cancel-signal-state.json'))).toBe(true);
      expect(existsSync(join(ownerDir, 'cancel-signal-state.json'))).toBe(true);
    });

    it('should clear ralph runtime artifacts during broad cancel cleanup', async () => {
      const sessionId = 'ralph-broad-runtime-cleanup';
      const stateDir = join(TEST_DIR, '.omc', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 1 }));
      writeFileSync(join(stateDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 1 }));
      writeFileSync(join(stateDir, 'ralph-last-steer-at'), new Date().toISOString());

      const result = await stateClearTool.handler({
        mode: 'ralph',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Locations cleared: 3');
      expect(existsSync(join(sessionDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-last-steer-at'))).toBe(false);
    });

    it('reports no-op with checked paths when session clear finds no actual state file', async () => {
      const sessionId = 'missing-autopilot-state-session';
      const result = await stateClearTool.handler({
        mode: 'autopilot',
        session_id: sessionId,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('No state found to clear for mode: autopilot in session: missing-autopilot-state-session');
      expect(result.content[0].text).toContain('Checked paths');
      expect(result.content[0].text).toContain(join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json'));
    });

    it('clears autopilot state from the centralized OMC_STATE_DIR root used by stop hooks', async () => {
      const previous = process.env.OMC_STATE_DIR;
      const sessionId = 'centralized-autopilot-clear-session';
      const centralRoot = join(TEST_DIR, 'central-state-root');
      process.env.OMC_STATE_DIR = centralRoot;
      try {
        const { getOmcRoot } = await import('../../lib/worktree-paths.js');
        const autopilotPath = join(getOmcRoot(TEST_DIR), 'state', 'sessions', sessionId, 'autopilot-state.json');
        mkdirSync(join(autopilotPath, '..'), { recursive: true });
        writeFileSync(
          autopilotPath,
          JSON.stringify({
            active: true,
            session_id: sessionId,
            current_phase: 'execution',
          }),
        );

        const result = await stateClearTool.handler({
          mode: 'autopilot',
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });

        expect(result.content[0].text).toContain('Successfully cleared state for mode: autopilot in session: centralized-autopilot-clear-session');
        expect(existsSync(autopilotPath)).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.OMC_STATE_DIR;
        } else {
          process.env.OMC_STATE_DIR = previous;
        }
      }
    });

    it('clears workingDirectory-local ralph state when centralized OMC_STATE_DIR lookup misses', async () => {
      const previous = process.env.OMC_STATE_DIR;
      const sessionId = 'worktree-local-ralph-clear-session';
      const centralRoot = join(TEST_DIR, 'central-state-root');
      const localStatePath = join(TEST_DIR, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json');
      process.env.OMC_STATE_DIR = centralRoot;
      try {
        mkdirSync(dirname(localStatePath), { recursive: true });
        writeFileSync(
          localStatePath,
          JSON.stringify({
            active: true,
            session_id: sessionId,
            iteration: 2,
          }),
        );

        const result = await stateClearTool.handler({
          mode: 'ralph',
          session_id: sessionId,
          workingDirectory: TEST_DIR,
        });

        expect(result.content[0].text).toContain('Successfully cleared state for mode: ralph');
        expect(result.content[0].text).toContain('workingDirectory-local state file');
        expect(existsSync(localStatePath)).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.OMC_STATE_DIR;
        } else {
          process.env.OMC_STATE_DIR = previous;
        }
      }
    });

    it('should discover and clear session-scoped autopilot state when no session_id is provided', async () => {
      const sessionId = 'missing-env-autopilot-session';
      const stateDir = join(TEST_DIR, '.omc', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const autopilotPath = join(sessionDir, 'autopilot-state.json');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        autopilotPath,
        JSON.stringify({
          active: true,
          session_id: sessionId,
          phase: 'expansion',
        }),
      );

      const result = await stateClearTool.handler({
        mode: 'autopilot',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Cleared state for mode: autopilot');
      expect(existsSync(autopilotPath)).toBe(false);
      expect(existsSync(join(sessionDir, 'cancel-signal-state.json'))).toBe(true);
    });
  });

  describe('session-scoped behavior', () => {
    it('should prevent cross-process state bleeding when session_id provided', async () => {
      // Simulate two processes writing to the same mode
      const processASessionId = 'pid-11111-1000000';
      const processBSessionId = 'pid-22222-2000000';

      // Process A writes
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true, task: 'Process A task' },
        session_id: processASessionId,
        workingDirectory: TEST_DIR,
      });

      // Process B writes
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true, task: 'Process B task' },
        session_id: processBSessionId,
        workingDirectory: TEST_DIR,
      });

      // Process A reads its own state
      const resultA = await stateReadTool.handler({
        mode: 'ultrawork',
        session_id: processASessionId,
        workingDirectory: TEST_DIR,
      });
      expect(resultA.content[0].text).toContain('Process A task');
      expect(resultA.content[0].text).not.toContain('Process B task');

      // Process B reads its own state
      const resultB = await stateReadTool.handler({
        mode: 'ultrawork',
        session_id: processBSessionId,
        workingDirectory: TEST_DIR,
      });
      expect(resultB.content[0].text).toContain('Process B task');
      expect(resultB.content[0].text).not.toContain('Process A task');
    });

    it('should write state to legacy path when session_id omitted', async () => {
      await stateWriteTool.handler({
        mode: 'ultrawork',
        state: { active: true },
        workingDirectory: TEST_DIR,
      });

      const legacyPath = join(TEST_DIR, '.omc', 'state', 'ultrawork-state.json');
      expect(existsSync(legacyPath)).toBe(true);
    });
  });

  describe('payload size validation', () => {
    it('should reject oversized custom state payloads', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { huge: 'x'.repeat(2_000_000) },
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('payload rejected');
      expect(result.content[0].text).toContain('exceeds maximum');
    });

    it('should reject deeply nested custom state payloads', async () => {
      let obj: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 15; i++) {
        obj = { nested: obj };
      }

      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: obj,
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('nesting depth');
    });

    it('should reject state with too many top-level keys', async () => {
      const state: Record<string, string> = {};
      for (let i = 0; i < 150; i++) {
        state[`key_${i}`] = 'value';
      }

      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state,
        workingDirectory: TEST_DIR,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('top-level keys');
    });

    it('should still allow normal-sized state writes', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true, task: 'normal task', items: [1, 2, 3] },
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
    });

    it('should not validate when no custom state is provided', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        active: true,
        iteration: 1,
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
    });
  });
});
