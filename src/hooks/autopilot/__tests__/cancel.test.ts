import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  cancelAutopilot,
  clearAutopilot,
  canResumeAutopilot,
  resumeAutopilot,
  formatCancelMessage,
  type CancelResult
} from '../cancel.js';
import {
  initAutopilot,
  transitionPhase,
  readAutopilotState,
  updateExecution
} from '../state.js';

// Mock the ralph and ultraqa modules
vi.mock('../../ralph/index.js', () => ({
  clearRalphState: vi.fn(() => true),
  clearLinkedUltraworkState: vi.fn(() => true),
  readRalphState: vi.fn(() => null)
}));

vi.mock('../../ultraqa/index.js', () => ({
  clearUltraQAState: vi.fn(() => true),
  readUltraQAState: vi.fn(() => null)
}));

// Import mocked functions after vi.mock
import * as ralphLoop from '../../ralph/index.js';
import * as ultraqaLoop from '../../ultraqa/index.js';

describe('AutopilotCancel', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'autopilot-cancel-test-'));
    const fs = require('fs');
    fs.mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('cancelAutopilot', () => {
    it('should return failure when no state exists', () => {
      const result = cancelAutopilot(testDir);

      expect(result.success).toBe(false);
      expect(result.message).toBe('No active autopilot session found');
      expect(result.preservedState).toBeUndefined();
    });

    it('should return failure when state exists but is not active', () => {
      const state = initAutopilot(testDir, 'test idea');
      if (state) {
        state.active = false;
        const stateFile = join(testDir, '.omc', 'state', 'autopilot-state.json');
        const fs = require('fs');
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      }

      const result = cancelAutopilot(testDir);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Autopilot is not currently active');
      expect(result.preservedState).toBeUndefined();
    });

    it('should successfully cancel active autopilot and preserve state', () => {
      initAutopilot(testDir, 'test idea');

      const result = cancelAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Autopilot cancelled at phase: expansion');
      expect(result.message).toContain('Progress preserved for resume');
      expect(result.preservedState).toBeDefined();
      expect(result.preservedState?.active).toBe(false);
      expect(result.preservedState?.originalIdea).toBe('test idea');
    });

    it('should preserve state at different phases', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'planning');

      const result = cancelAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Autopilot cancelled at phase: planning');
      expect(result.preservedState?.phase).toBe('planning');
    });

    it('should clean up ralph state when active', () => {
      initAutopilot(testDir, 'test idea');

      // Mock active ralph state
      vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
        active: true,
        linked_ultrawork: false
      } as any);

      const result = cancelAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Cleaned up: ralph');
      expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
    });

    it('should clean up ralph and ultrawork when linked', () => {
      initAutopilot(testDir, 'test idea');

      // Mock active ralph state with linked ultrawork
      vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
        active: true,
        linked_ultrawork: true
      } as any);

      const result = cancelAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Cleaned up: ultrawork, ralph');
      expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledWith(testDir);
      expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
    });

    it('should clean up ultraqa state when active', () => {
      initAutopilot(testDir, 'test idea');

      // Mock active ultraqa state
      vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce({
        active: true
      } as any);

      const result = cancelAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Cleaned up: ultraqa');
      expect(ultraqaLoop.clearUltraQAState).toHaveBeenCalledWith(testDir);
    });

    it('should clean up all states when all are active', () => {
      initAutopilot(testDir, 'test idea');

      // Mock all states active
      vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
        active: true,
        linked_ultrawork: true
      } as any);
      vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce({
        active: true
      } as any);

      const result = cancelAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Cleaned up: ultrawork, ralph, ultraqa');
      expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledWith(testDir);
      expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
      expect(ultraqaLoop.clearUltraQAState).toHaveBeenCalledWith(testDir);
    });

    it('should mark autopilot as inactive but keep state on disk', () => {
      initAutopilot(testDir, 'test idea');

      cancelAutopilot(testDir);

      const state = readAutopilotState(testDir);
      expect(state).not.toBeNull();
      expect(state?.active).toBe(false);
      expect(state?.originalIdea).toBe('test idea');
    });
  });

  describe('clearAutopilot', () => {
    it('should return success when no state exists', () => {
      const result = clearAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toBe('No autopilot state to clear');
    });

    it('should clear all autopilot state completely', () => {
      initAutopilot(testDir, 'test idea');

      const result = clearAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Autopilot state cleared completely');

      const state = readAutopilotState(testDir);
      expect(state).toBeNull();
    });

    it('should clear ralph state when present', () => {
      initAutopilot(testDir, 'test idea');

      // Mock ralph state exists
      vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
        active: true,
        linked_ultrawork: false
      } as any);

      clearAutopilot(testDir);

      expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
    });

    it('should clear ralph and linked ultrawork state when present', () => {
      initAutopilot(testDir, 'test idea');

      // Mock ralph state with linked ultrawork
      vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
        active: false,
        linked_ultrawork: true
      } as any);

      clearAutopilot(testDir);

      expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledWith(testDir);
      expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
    });

    it('should clear ultraqa state when present', () => {
      initAutopilot(testDir, 'test idea');

      // Mock ultraqa state exists
      vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce({
        active: false
      } as any);

      clearAutopilot(testDir);

      expect(ultraqaLoop.clearUltraQAState).toHaveBeenCalledWith(testDir);
    });

    it('should clear all states when all are present', () => {
      initAutopilot(testDir, 'test idea');

      // Mock all states exist
      vi.mocked(ralphLoop.readRalphState).mockReturnValueOnce({
        active: true,
        linked_ultrawork: true
      } as any);
      vi.mocked(ultraqaLoop.readUltraQAState).mockReturnValueOnce({
        active: true
      } as any);

      clearAutopilot(testDir);

      expect(ralphLoop.clearLinkedUltraworkState).toHaveBeenCalledWith(testDir);
      expect(ralphLoop.clearRalphState).toHaveBeenCalledWith(testDir);
      expect(ultraqaLoop.clearUltraQAState).toHaveBeenCalledWith(testDir);

      const state = readAutopilotState(testDir);
      expect(state).toBeNull();
    });
  });

  describe('canResumeAutopilot', () => {
    it('should return false when no state exists', () => {
      const result = canResumeAutopilot(testDir);

      expect(result.canResume).toBe(false);
      expect(result.state).toBeUndefined();
      expect(result.resumePhase).toBeUndefined();
    });

    it('should return true for incomplete phase (expansion)', () => {
      initAutopilot(testDir, 'test idea');

      const result = canResumeAutopilot(testDir);

      expect(result.canResume).toBe(true);
      expect(result.state).toBeDefined();
      expect(result.resumePhase).toBe('expansion');
    });

    it('should return true for incomplete phase (planning)', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'planning');

      const result = canResumeAutopilot(testDir);

      expect(result.canResume).toBe(true);
      expect(result.resumePhase).toBe('planning');
    });

    it('should return true for incomplete phase (execution)', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'execution');

      const result = canResumeAutopilot(testDir);

      expect(result.canResume).toBe(true);
      expect(result.resumePhase).toBe('execution');
    });

    it('should return true for incomplete phase (qa)', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'qa');

      const result = canResumeAutopilot(testDir);

      expect(result.canResume).toBe(true);
      expect(result.resumePhase).toBe('qa');
    });

    it('should return true for incomplete phase (validation)', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'validation');

      const result = canResumeAutopilot(testDir);

      expect(result.canResume).toBe(true);
      expect(result.resumePhase).toBe('validation');
    });

    it('should return false for complete phase', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'complete');

      const result = canResumeAutopilot(testDir);

      expect(result.canResume).toBe(false);
      expect(result.state).toBeDefined();
      expect(result.state?.phase).toBe('complete');
    });

    it('should return false for failed phase', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'failed');

      const result = canResumeAutopilot(testDir);

      expect(result.canResume).toBe(false);
      expect(result.state).toBeDefined();
      expect(result.state?.phase).toBe('failed');
    });
  });

  describe('resumeAutopilot', () => {
    it('should return failure when no state exists', () => {
      const result = resumeAutopilot(testDir);

      expect(result.success).toBe(false);
      expect(result.message).toBe('No autopilot session available to resume');
      expect(result.state).toBeUndefined();
    });

    it('should return failure when state is complete', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'complete');

      const result = resumeAutopilot(testDir);

      expect(result.success).toBe(false);
      expect(result.message).toBe('No autopilot session available to resume');
    });

    it('should return failure when state is failed', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'failed');

      const result = resumeAutopilot(testDir);

      expect(result.success).toBe(false);
      expect(result.message).toBe('No autopilot session available to resume');
    });

    it('should successfully resume from expansion phase', () => {
      initAutopilot(testDir, 'test idea');
      cancelAutopilot(testDir); // Cancel to make it inactive

      const result = resumeAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Resuming autopilot at phase: expansion');
      expect(result.state).toBeDefined();
      expect(result.state?.active).toBe(true);
      expect(result.state?.iteration).toBe(2);
    });

    it('should successfully resume from planning phase', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'planning');
      cancelAutopilot(testDir);

      const result = resumeAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Resuming autopilot at phase: planning');
      expect(result.state?.phase).toBe('planning');
      expect(result.state?.active).toBe(true);
    });

    it('should increment iteration on resume', () => {
      initAutopilot(testDir, 'test idea');

      let state = readAutopilotState(testDir);
      const initialIteration = state?.iteration ?? 0;

      cancelAutopilot(testDir);
      resumeAutopilot(testDir);

      state = readAutopilotState(testDir);
      expect(state?.iteration).toBe(initialIteration + 1);
    });

    it('should re-activate state on resume', () => {
      initAutopilot(testDir, 'test idea');
      cancelAutopilot(testDir);

      let state = readAutopilotState(testDir);
      expect(state?.active).toBe(false);

      resumeAutopilot(testDir);

      state = readAutopilotState(testDir);
      expect(state?.active).toBe(true);
    });

    it('should preserve all state data on resume', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'execution');
      updateExecution(testDir, {
        files_created: ['file1.ts', 'file2.ts'],
        files_modified: ['file3.ts'],
        tasks_completed: 5,
        tasks_total: 10
      });

      cancelAutopilot(testDir);
      const result = resumeAutopilot(testDir);

      expect(result.success).toBe(true);
      expect(result.state?.execution.files_created).toEqual(['file1.ts', 'file2.ts']);
      expect(result.state?.execution.files_modified).toEqual(['file3.ts']);
      expect(result.state?.execution.tasks_completed).toBe(5);
      expect(result.state?.execution.tasks_total).toBe(10);
    });
  });

  describe('formatCancelMessage', () => {
    it('should format failure message', () => {
      const result: CancelResult = {
        success: false,
        message: 'No active autopilot session found'
      };

      const formatted = formatCancelMessage(result);

      expect(formatted).toBe('[AUTOPILOT] No active autopilot session found');
    });

    it('should format success message without preserved state', () => {
      const result: CancelResult = {
        success: true,
        message: 'Autopilot state cleared completely'
      };

      const formatted = formatCancelMessage(result);

      expect(formatted).toContain('[AUTOPILOT CANCELLED]');
      expect(formatted).toContain('Autopilot state cleared completely');
      expect(formatted).not.toContain('Progress Summary');
    });

    it('should format success message with preserved state and progress summary', () => {
      const state = initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'execution');
      updateExecution(testDir, {
        files_created: ['file1.ts', 'file2.ts', 'file3.ts'],
        files_modified: ['file4.ts', 'file5.ts']
      });

      const updatedState = readAutopilotState(testDir);
      if (updatedState) {
        updatedState.total_agents_spawned = 7;
      }

      const result: CancelResult = {
        success: true,
        message: 'Autopilot cancelled at phase: execution. Progress preserved for resume.',
        preservedState: updatedState!
      };

      const formatted = formatCancelMessage(result);

      expect(formatted).toContain('[AUTOPILOT CANCELLED]');
      expect(formatted).toContain('Autopilot cancelled at phase: execution');
      expect(formatted).toContain('Progress Summary:');
      expect(formatted).toContain('- Phase reached: execution');
      expect(formatted).toContain('- Files created: 3');
      expect(formatted).toContain('- Files modified: 2');
      expect(formatted).toContain('- Agents used: 7');
      expect(formatted).toContain('Run /autopilot to resume from where you left off.');
    });

    it('should handle zero progress in summary', () => {
      const state = initAutopilot(testDir, 'test idea');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }

      const result: CancelResult = {
        success: true,
        message: 'Autopilot cancelled at phase: expansion. Progress preserved for resume.',
        preservedState: state
      };

      const formatted = formatCancelMessage(result);

      expect(formatted).toContain('- Files created: 0');
      expect(formatted).toContain('- Files modified: 0');
      expect(formatted).toContain('- Agents used: 0');
    });

    it('should handle cleanup message in preserved state format', () => {
      const state = initAutopilot(testDir, 'test idea');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      state.active = false;

      const result: CancelResult = {
        success: true,
        message: 'Autopilot cancelled at phase: expansion. Cleaned up: ralph, ultrawork. Progress preserved for resume.',
        preservedState: state
      };

      const formatted = formatCancelMessage(result);

      expect(formatted).toContain('[AUTOPILOT CANCELLED]');
      expect(formatted).toContain('Cleaned up: ralph, ultrawork');
      expect(formatted).toContain('Progress Summary:');
    });
  });
});
