import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readReplayEvents, resetSessionStartTimes } from '../session-replay.js';
import {
  recordHookFire,
  recordHookResult,
  recordKeywordDetected,
  recordSkillActivated,
  recordSkillInvoked,
  recordModeChange,
} from '../flow-tracer.js';

describe('flow-tracer', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `flow-tracer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
    resetSessionStartTimes();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('recordHookFire', () => {
    it('should record hook_fire event with hook name and event', () => {
      recordHookFire(testDir, 'sess1', 'keyword-detector', 'UserPromptSubmit');

      const events = readReplayEvents(testDir, 'sess1');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('hook_fire');
      expect(events[0].agent).toBe('system');
      expect(events[0].hook).toBe('keyword-detector');
      expect(events[0].hook_event).toBe('UserPromptSubmit');
    });
  });

  describe('recordHookResult', () => {
    it('should record hook_result event with timing and context info', () => {
      recordHookResult(testDir, 'sess2', 'keyword-detector', 'UserPromptSubmit', 15, true, 847);

      const events = readReplayEvents(testDir, 'sess2');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('hook_result');
      expect(events[0].agent).toBe('system');
      expect(events[0].hook).toBe('keyword-detector');
      expect(events[0].duration_ms).toBe(15);
      expect(events[0].context_injected).toBe(true);
      expect(events[0].context_length).toBe(847);
    });

    it('should handle missing context length', () => {
      recordHookResult(testDir, 'sess3', 'stop-continuation', 'Stop', 5, false);

      const events = readReplayEvents(testDir, 'sess3');
      expect(events).toHaveLength(1);
      expect(events[0].context_injected).toBe(false);
      expect(events[0].context_length).toBeUndefined();
    });
  });

  describe('recordKeywordDetected', () => {
    it('should record keyword_detected event', () => {
      recordKeywordDetected(testDir, 'sess4', 'ultrawork');

      const events = readReplayEvents(testDir, 'sess4');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('keyword_detected');
      expect(events[0].agent).toBe('system');
      expect(events[0].keyword).toBe('ultrawork');
    });
  });

  describe('recordSkillActivated', () => {
    it('should record skill_activated event with source', () => {
      recordSkillActivated(testDir, 'sess5', 'autopilot', 'builtin');

      const events = readReplayEvents(testDir, 'sess5');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('skill_activated');
      expect(events[0].agent).toBe('system');
      expect(events[0].skill_name).toBe('autopilot');
      expect(events[0].skill_source).toBe('builtin');
    });
  });

  describe('recordSkillInvoked', () => {
    it('should record skill_invoked event with skill name', () => {
      recordSkillInvoked(testDir, 'sess-inv1', 'oh-my-claudecode:plan');

      const events = readReplayEvents(testDir, 'sess-inv1');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('skill_invoked');
      expect(events[0].agent).toBe('system');
      expect(events[0].skill_name).toBe('oh-my-claudecode:plan');
    });
  });

  describe('recordModeChange', () => {
    it('should record mode_change event with from and to', () => {
      recordModeChange(testDir, 'sess6', 'none', 'ultrawork');

      const events = readReplayEvents(testDir, 'sess6');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('mode_change');
      expect(events[0].agent).toBe('system');
      expect(events[0].mode_from).toBe('none');
      expect(events[0].mode_to).toBe('ultrawork');
    });
  });

  describe('integration', () => {
    it('should record multiple event types in sequence', () => {
      recordHookFire(testDir, 'sess7', 'keyword-detector', 'UserPromptSubmit');
      recordKeywordDetected(testDir, 'sess7', 'ralph');
      recordModeChange(testDir, 'sess7', 'none', 'ralph');
      recordHookResult(testDir, 'sess7', 'keyword-detector', 'UserPromptSubmit', 25, true, 1200);
      recordSkillActivated(testDir, 'sess7', 'ralph', 'builtin');

      const events = readReplayEvents(testDir, 'sess7');
      expect(events).toHaveLength(5);
      expect(events[0].event).toBe('hook_fire');
      expect(events[1].event).toBe('keyword_detected');
      expect(events[2].event).toBe('mode_change');
      expect(events[3].event).toBe('hook_result');
      expect(events[4].event).toBe('skill_activated');
    });
  });
});
