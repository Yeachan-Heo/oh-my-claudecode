import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  stateReadTool,
  stateWriteTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
} from '../state-tools.js';

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

describe('state-tools', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('state_read', () => {
    it('should return state when file exists', async () => {
      const statePath = join(TEST_DIR, '.omc', 'state', 'ralph-state.json');
      writeFileSync(statePath, JSON.stringify({ active: true, iteration: 3 }));

      const result = await stateReadTool.handler({
        mode: 'ralph',
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
    it('should write state with metadata', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ralph',
        state: { active: true, iteration: 1 },
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
      expect(existsSync(join(TEST_DIR, '.omc', 'state', 'ralph-state.json'))).toBe(true);
    });

    it('should add _meta field to written state', async () => {
      const result = await stateWriteTool.handler({
        mode: 'ecomode',
        state: { someField: 'value' },
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully wrote');
      expect(result.content[0].text).toContain('_meta');
    });
  });

  describe('state_clear', () => {
    it('should remove state file', async () => {
      const statePath = join(TEST_DIR, '.omc', 'state', 'ralplan-state.json');
      writeFileSync(statePath, JSON.stringify({ active: true }));

      const result = await stateClearTool.handler({
        mode: 'ralplan',
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Successfully cleared');
      expect(existsSync(statePath)).toBe(false);
    });
  });

  describe('state_list_active', () => {
    it('should list active modes including ralplan', async () => {
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'ralph-state.json'),
        JSON.stringify({ active: true })
      );
      writeFileSync(
        join(TEST_DIR, '.omc', 'state', 'ralplan-state.json'),
        JSON.stringify({ active: true })
      );

      const result = await stateListActiveTool.handler({
        workingDirectory: TEST_DIR,
      });

      expect(result.content[0].text).toContain('Active Modes');
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
});
