import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getReplayFilePath,
  appendReplayEvent,
  recordAgentStart,
  recordAgentStop,
  recordToolEvent,
  recordFileTouch,
  recordIntervention,
  readReplayEvents,
  getReplaySummary,
  cleanupReplayFiles,
  resetSessionStartTimes,
} from '../session-replay.js';

describe('session-replay', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `replay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
    resetSessionStartTimes();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('getReplayFilePath', () => {
    it('should return correct path for session', () => {
      const path = getReplayFilePath(testDir, 'test-session');
      expect(path).toContain(join('.omc', 'state', 'agent-replay-test-session.jsonl'));
    });

    it('should sanitize session ID', () => {
      const path = getReplayFilePath(testDir, 'test/../session');
      expect(path).not.toContain('..');
    });
  });

  describe('appendReplayEvent', () => {
    it('should create file and append event', () => {
      appendReplayEvent(testDir, 'sess1', {
        agent: 'abc1234',
        event: 'agent_start',
        agent_type: 'executor',
      });

      const filePath = getReplayFilePath(testDir, 'sess1');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      const event = JSON.parse(content.trim());
      expect(event.agent).toBe('abc1234');
      expect(event.event).toBe('agent_start');
      expect(typeof event.t).toBe('number');
    });

    it('should append multiple events', () => {
      appendReplayEvent(testDir, 'sess2', { agent: 'a1', event: 'agent_start' });
      appendReplayEvent(testDir, 'sess2', { agent: 'a1', event: 'tool_start', tool: 'Read' });
      appendReplayEvent(testDir, 'sess2', { agent: 'a1', event: 'tool_end', tool: 'Read', duration_ms: 100 });

      const events = readReplayEvents(testDir, 'sess2');
      expect(events).toHaveLength(3);
      expect(events[0].event).toBe('agent_start');
      expect(events[2].duration_ms).toBe(100);
    });
  });

  describe('event helpers', () => {
    it('recordAgentStart should record start event', () => {
      recordAgentStart(testDir, 'sess3', 'agent-123', 'oh-my-claudecode:executor', 'Fix the bug', 'ultrawork', 'sonnet');

      const events = readReplayEvents(testDir, 'sess3');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('agent_start');
      expect(events[0].agent_type).toBe('executor');
      expect(events[0].task).toBe('Fix the bug');
      expect(events[0].parent_mode).toBe('ultrawork');
    });

    it('recordAgentStop should record stop event', () => {
      recordAgentStop(testDir, 'sess4', 'agent-456', 'oh-my-claudecode:architect', true, 5000);

      const events = readReplayEvents(testDir, 'sess4');
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('agent_stop');
      expect(events[0].success).toBe(true);
      expect(events[0].duration_ms).toBe(5000);
    });

    it('recordToolEvent should record tool events', () => {
      recordToolEvent(testDir, 'sess5', 'agent-789', 'Edit', 'tool_end', 250, true);

      const events = readReplayEvents(testDir, 'sess5');
      expect(events[0].tool).toBe('Edit');
      expect(events[0].duration_ms).toBe(250);
      expect(events[0].success).toBe(true);
    });

    it('recordFileTouch should record file touch', () => {
      recordFileTouch(testDir, 'sess6', 'agent-abc', 'src/hooks/bridge.ts');

      const events = readReplayEvents(testDir, 'sess6');
      expect(events[0].event).toBe('file_touch');
      expect(events[0].file).toBe('src/hooks/bridge.ts');
    });

    it('recordIntervention should record intervention', () => {
      recordIntervention(testDir, 'sess7', 'agent-def', 'Agent stale for 6 minutes');

      const events = readReplayEvents(testDir, 'sess7');
      expect(events[0].event).toBe('intervention');
      expect(events[0].reason).toBe('Agent stale for 6 minutes');
    });
  });

  describe('getReplaySummary', () => {
    it('should generate summary with tool statistics', () => {
      // Simulate a session with multiple events
      appendReplayEvent(testDir, 'summary-test', { agent: 'a1', event: 'agent_start', agent_type: 'executor' });
      appendReplayEvent(testDir, 'summary-test', { agent: 'a1', event: 'tool_end', tool: 'Read', duration_ms: 100 });
      appendReplayEvent(testDir, 'summary-test', { agent: 'a1', event: 'tool_end', tool: 'Read', duration_ms: 200 });
      appendReplayEvent(testDir, 'summary-test', { agent: 'a1', event: 'tool_end', tool: 'Edit', duration_ms: 500 });
      appendReplayEvent(testDir, 'summary-test', { agent: 'a1', event: 'file_touch', file: 'src/test.ts' });
      appendReplayEvent(testDir, 'summary-test', { agent: 'a1', event: 'agent_stop', success: true });

      const summary = getReplaySummary(testDir, 'summary-test');

      expect(summary.total_events).toBe(6);
      expect(summary.agents_spawned).toBe(1);
      expect(summary.agents_completed).toBe(1);
      expect(summary.agents_failed).toBe(0);
      expect(summary.tool_summary['Read'].count).toBe(2);
      expect(summary.tool_summary['Read'].avg_ms).toBe(150);
      expect(summary.tool_summary['Edit'].count).toBe(1);
      expect(summary.files_touched).toContain('src/test.ts');
    });

    it('should detect bottlenecks', () => {
      // Create events with slow tool
      appendReplayEvent(testDir, 'bottleneck-test', { agent: 'a1', event: 'tool_end', tool: 'Bash', duration_ms: 5000 });
      appendReplayEvent(testDir, 'bottleneck-test', { agent: 'a1', event: 'tool_end', tool: 'Bash', duration_ms: 6000 });
      appendReplayEvent(testDir, 'bottleneck-test', { agent: 'a1', event: 'tool_end', tool: 'Read', duration_ms: 100 });

      const summary = getReplaySummary(testDir, 'bottleneck-test');

      expect(summary.bottlenecks.length).toBeGreaterThan(0);
      expect(summary.bottlenecks[0].tool).toBe('Bash');
      expect(summary.bottlenecks[0].avg_ms).toBe(5500);
    });

    it('should return empty summary for non-existent session', () => {
      const summary = getReplaySummary(testDir, 'nonexistent');
      expect(summary.total_events).toBe(0);
      expect(summary.agents_spawned).toBe(0);
    });
  });

  describe('readReplayEvents', () => {
    it('should return empty array for non-existent file', () => {
      const events = readReplayEvents(testDir, 'nonexistent');
      expect(events).toEqual([]);
    });

    it('should skip malformed JSON lines', () => {
      const filePath = getReplayFilePath(testDir, 'malformed');
      mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
      const { writeFileSync } = require('fs');
      writeFileSync(filePath, '{"valid": true}\nnot json\n{"also": "valid"}\n');

      const events = readReplayEvents(testDir, 'malformed');
      expect(events).toHaveLength(2);
    });
  });
});
