import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateSummary,
  formatSummary,
  formatCompactSummary,
  formatFailureSummary,
  formatFileList
} from '../validation.js';
import {
  initAutopilot,
  updateExecution,
  updateQA,
  transitionPhase,
  readAutopilotState
} from '../state.js';
import type { AutopilotState } from '../types.js';

describe('AutopilotSummary', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'autopilot-summary-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('generateSummary', () => {
    it('should return null when no state exists', () => {
      const summary = generateSummary(testDir);
      expect(summary).toBeNull();
    });

    it('should return summary with all fields populated', () => {
      // Initialize autopilot
      initAutopilot(testDir, 'Build a test feature');

      // Update execution with files
      updateExecution(testDir, {
        files_created: ['src/feature.ts', 'src/feature.test.ts'],
        files_modified: ['src/index.ts']
      });

      // Update QA status
      updateQA(testDir, {
        test_status: 'passing'
      });

      // Transition to complete
      transitionPhase(testDir, 'complete');

      const summary = generateSummary(testDir);

      expect(summary).not.toBeNull();
      expect(summary?.originalIdea).toBe('Build a test feature');
      expect(summary?.filesCreated).toEqual(['src/feature.ts', 'src/feature.test.ts']);
      expect(summary?.filesModified).toEqual(['src/index.ts']);
      expect(summary?.testsStatus).toBe('Passing');
      expect(summary?.duration).toBeGreaterThanOrEqual(0);
      expect(summary?.agentsSpawned).toBe(0);
      expect(summary?.phasesCompleted).toContain('complete');
    });

    it('should track all completed phases', () => {
      initAutopilot(testDir, 'Test phases');

      // Manually update state to simulate completed phases
      updateExecution(testDir, {
        ralph_completed_at: new Date().toISOString()
      });
      updateQA(testDir, {
        qa_completed_at: new Date().toISOString()
      });

      const summary = generateSummary(testDir);

      expect(summary?.phasesCompleted).toContain('execution');
      expect(summary?.phasesCompleted).toContain('qa');
    });

    it('should correctly report test status as Failing', () => {
      initAutopilot(testDir, 'Test failing');
      updateQA(testDir, { test_status: 'failing' });

      const summary = generateSummary(testDir);
      expect(summary?.testsStatus).toBe('Failing');
    });

    it('should correctly report test status as Skipped', () => {
      initAutopilot(testDir, 'Test skipped');
      updateQA(testDir, { test_status: 'skipped' });

      const summary = generateSummary(testDir);
      expect(summary?.testsStatus).toBe('Skipped');
    });

    it('should correctly report test status as Not run', () => {
      initAutopilot(testDir, 'Test not run');
      updateQA(testDir, { test_status: 'pending' });

      const summary = generateSummary(testDir);
      expect(summary?.testsStatus).toBe('Not run');
    });
  });

  describe('formatSummary', () => {
    it('should return formatted box string', () => {
      const summary = {
        originalIdea: 'Build a feature',
        filesCreated: ['a.ts', 'b.ts'],
        filesModified: ['c.ts'],
        testsStatus: 'Passing',
        duration: 120000, // 2 minutes
        agentsSpawned: 5,
        phasesCompleted: ['expansion', 'planning', 'execution', 'qa', 'validation'] as any[]
      };

      const formatted = formatSummary(summary);

      expect(formatted).toContain('AUTOPILOT COMPLETE');
      expect(formatted).toContain('Build a feature');
      expect(formatted).toContain('2 files created');
      expect(formatted).toContain('1 files modified');
      expect(formatted).toContain('Tests: Passing');
      expect(formatted).toContain('Duration: 2m 0s');
      expect(formatted).toContain('Agents spawned: 5');
      expect(formatted).toContain('Phases completed: 5/5');
      expect(formatted).toMatch(/^╭─+╮/m);
      expect(formatted).toMatch(/╰─+╯/m);
    });

    it('should truncate long ideas', () => {
      const summary = {
        originalIdea: 'This is a very long idea that exceeds the maximum display length and should be truncated',
        filesCreated: [],
        filesModified: [],
        testsStatus: 'Not run',
        duration: 1000,
        agentsSpawned: 0,
        phasesCompleted: []
      };

      const formatted = formatSummary(summary);

      // Should contain truncated version with ellipsis
      expect(formatted).toContain('This is a very long idea that exceeds the maxim...');
      // Should not contain the end of the original string
      expect(formatted).not.toContain('truncated');
    });

    it('should format duration in hours and minutes', () => {
      const summary = {
        originalIdea: 'Test',
        filesCreated: [],
        filesModified: [],
        testsStatus: 'Not run',
        duration: 3661000, // 1h 1m 1s
        agentsSpawned: 0,
        phasesCompleted: []
      };

      const formatted = formatSummary(summary);

      expect(formatted).toContain('Duration: 1h 1m');
    });

    it('should format duration in seconds only', () => {
      const summary = {
        originalIdea: 'Test',
        filesCreated: [],
        filesModified: [],
        testsStatus: 'Not run',
        duration: 45000, // 45s
        agentsSpawned: 0,
        phasesCompleted: []
      };

      const formatted = formatSummary(summary);

      expect(formatted).toContain('Duration: 45s');
    });
  });

  describe('formatCompactSummary', () => {
    it('should return correct format for expansion phase', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      const compact = formatCompactSummary(state);

      expect(compact).toBe('[AUTOPILOT] Phase 1/5: EXPANSION | 0 files');
    });

    it('should return correct format for planning phase', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      transitionPhase(testDir, 'planning');
      const updatedState = readAutopilotState(testDir);
      if (!updatedState) {
        throw new Error('Failed to read autopilot state');
      }

      const compact = formatCompactSummary(updatedState);

      expect(compact).toBe('[AUTOPILOT] Phase 2/5: PLANNING | 0 files');
    });

    it('should return correct format for execution phase', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      state.phase = 'execution';
      updateExecution(testDir, {
        files_created: ['a.ts', 'b.ts'],
        files_modified: ['c.ts']
      });
      state.execution.files_created = ['a.ts', 'b.ts'];
      state.execution.files_modified = ['c.ts'];

      const compact = formatCompactSummary(state);

      expect(compact).toBe('[AUTOPILOT] Phase 3/5: EXECUTION | 3 files');
    });

    it('should return correct format for qa phase', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      state.phase = 'qa';

      const compact = formatCompactSummary(state);

      expect(compact).toBe('[AUTOPILOT] Phase 4/5: QA | 0 files');
    });

    it('should return correct format for validation phase', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      state.phase = 'validation';

      const compact = formatCompactSummary(state);

      expect(compact).toBe('[AUTOPILOT] Phase 5/5: VALIDATION | 0 files');
    });

    it('should show checkmark for complete phase', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      updateExecution(testDir, {
        files_created: ['a.ts'],
        files_modified: ['b.ts']
      });
      transitionPhase(testDir, 'complete');

      state.phase = 'complete';
      state.total_agents_spawned = 10;
      state.execution.files_created = ['a.ts'];
      state.execution.files_modified = ['b.ts'];

      const compact = formatCompactSummary(state);

      expect(compact).toBe('[AUTOPILOT ✓] Complete | 2 files | 10 agents');
    });

    it('should show X for failed phase', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      state.phase = 'failed';

      const compact = formatCompactSummary(state);

      expect(compact).toBe('[AUTOPILOT ✗] Failed at failed');
    });
  });

  describe('formatFailureSummary', () => {
    it('should include phase and no error', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      state.phase = 'execution';

      const formatted = formatFailureSummary(state);

      expect(formatted).toContain('AUTOPILOT FAILED');
      expect(formatted).toContain('Failed at phase: EXECUTION');
      expect(formatted).toContain('Progress preserved. Run /autopilot to resume.');
      expect(formatted).toMatch(/^╭─+╮/m);
      expect(formatted).toMatch(/╰─+╯/m);
    });

    it('should include error message', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      state.phase = 'qa';

      const formatted = formatFailureSummary(state, 'Build failed with exit code 1');

      expect(formatted).toContain('AUTOPILOT FAILED');
      expect(formatted).toContain('Failed at phase: QA');
      expect(formatted).toContain('Error:');
      expect(formatted).toContain('Build failed with exit code 1');
    });

    it('should handle long error messages by wrapping', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      state.phase = 'validation';

      const longError = 'This is a very long error message that exceeds the box width and should be wrapped across multiple lines to fit properly';

      const formatted = formatFailureSummary(state, longError);

      expect(formatted).toContain('Error:');
      // Check that the error message appears somewhere in the output
      expect(formatted).toContain('This is a very long error message that exceeds t');
      // Check that it wraps to multiple lines (second line should start with he box)
      expect(formatted).toContain('he box width and should be wrapped across multip');
    });

    it('should limit error to 3 lines', () => {
      const state = initAutopilot(testDir, 'Test');
      if (!state) {
        throw new Error('Failed to initialize autopilot');
      }
      const longError = 'a'.repeat(200); // Very long error

      const formatted = formatFailureSummary(state, longError);

      // Count error lines (lines that start with │ and contain 'a')
      const errorLines = formatted.split('\n').filter(line =>
        line.includes('│  aaaa')
      );

      expect(errorLines.length).toBeLessThanOrEqual(3);
    });
  });

  describe('formatFileList', () => {
    it('should return empty string for no files', () => {
      const result = formatFileList([], 'Created Files');
      expect(result).toBe('');
    });

    it('should format list with title and count', () => {
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
      const result = formatFileList(files, 'Created Files');

      expect(result).toContain('### Created Files (3)');
      expect(result).toContain('- src/a.ts');
      expect(result).toContain('- src/b.ts');
      expect(result).toContain('- src/c.ts');
    });

    it('should limit files shown to maxFiles parameter', () => {
      const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
      const result = formatFileList(files, 'Files', 5);

      expect(result).toContain('### Files (15)');
      expect(result).toContain('- file0.ts');
      expect(result).toContain('- file4.ts');
      expect(result).not.toContain('- file5.ts');
    });

    it('should show "and X more" when files exceed maxFiles', () => {
      const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
      const result = formatFileList(files, 'Files', 10);

      expect(result).toContain('- ... and 5 more');
    });

    it('should default maxFiles to 10', () => {
      const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
      const result = formatFileList(files, 'Files');

      expect(result).toContain('- file9.ts');
      expect(result).not.toContain('- file10.ts');
      expect(result).toContain('- ... and 10 more');
    });

    it('should not show "and X more" when files equal maxFiles', () => {
      const files = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
      const result = formatFileList(files, 'Files', 10);

      expect(result).not.toContain('and');
      expect(result).not.toContain('more');
      expect(result).toContain('- file9.ts');
    });

    it('should not show "and X more" when files less than maxFiles', () => {
      const files = ['a.ts', 'b.ts'];
      const result = formatFileList(files, 'Files', 10);

      expect(result).not.toContain('and');
      expect(result).not.toContain('more');
    });
  });
});
