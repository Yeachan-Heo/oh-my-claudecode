import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initAutopilot,
  transitionPhase,
  readAutopilotState,
  transitionRalphToUltraQA,
  transitionUltraQAToValidation,
  transitionToComplete,
  getTransitionPrompt
} from '../state.js';

describe('Phase Transitions', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'transition-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('transitionRalphToUltraQA', () => {
    it('should fail if not in execution phase', () => {
      initAutopilot(testDir, 'test', 'session-1');
      // Still in expansion phase
      const result = transitionRalphToUltraQA(testDir, 'session-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Not in execution phase');
    });

    it('should transition from execution to qa', () => {
      initAutopilot(testDir, 'test', 'session-1');
      transitionPhase(testDir, 'execution', 'session-1');

      const result = transitionRalphToUltraQA(testDir, 'session-1');
      expect(result.success).toBe(true);

      const state = readAutopilotState(testDir, 'session-1');
      expect(state?.phase).toBe('qa');
    });
  });

  describe('transitionUltraQAToValidation', () => {
    it('should fail if not in qa phase', () => {
      initAutopilot(testDir, 'test');
      const result = transitionUltraQAToValidation(testDir);
      expect(result.success).toBe(false);
    });

    it('should transition from qa to validation', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'qa');

      const result = transitionUltraQAToValidation(testDir);
      expect(result.success).toBe(true);

      const state = readAutopilotState(testDir);
      expect(state?.phase).toBe('validation');
    });
  });

  describe('getTransitionPrompt', () => {
    it('should return prompt for execution to qa', () => {
      const prompt = getTransitionPrompt('execution', 'qa');
      expect(prompt).toContain('Execution → QA');
      expect(prompt).toContain('Ralph');
    });

    it('should return prompt for qa to validation', () => {
      const prompt = getTransitionPrompt('qa', 'validation');
      expect(prompt).toContain('QA → Validation');
    });
  });
});
