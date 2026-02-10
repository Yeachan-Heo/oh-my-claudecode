import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendReplayEvent, resetSessionStartTimes, detectCycles } from '../../hooks/subagent-tracker/session-replay.js';
import { traceTimelineTool, traceSummaryTool } from '../../tools/trace-tools.js';

// Mock validateWorkingDirectory to return our test directory
let testDir: string;

vi.mock('../../lib/worktree-paths.js', () => ({
  validateWorkingDirectory: (dir?: string) => dir || testDir,
}));

describe('trace-tools', () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `trace-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
    resetSessionStartTimes();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('traceTimelineTool', () => {
    it('should have correct name and description', () => {
      expect(traceTimelineTool.name).toBe('trace_timeline');
      expect(traceTimelineTool.description).toContain('timeline');
    });

    it('should return no sessions message when no replay files exist', async () => {
      const result = await traceTimelineTool.handler({ workingDirectory: testDir });
      expect(result.content[0].text).toContain('No trace sessions found');
    });

    it('should format agent events in timeline', async () => {
      appendReplayEvent(testDir, 'test-sess', { agent: 'abc1234', event: 'agent_start', agent_type: 'executor', task: 'Fix bug' });
      appendReplayEvent(testDir, 'test-sess', { agent: 'abc1234', event: 'tool_end', tool: 'Read', duration_ms: 100 });
      appendReplayEvent(testDir, 'test-sess', { agent: 'abc1234', event: 'agent_stop', success: true, duration_ms: 5000 });

      const result = await traceTimelineTool.handler({ sessionId: 'test-sess', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('test-sess');
      expect(text).toContain('AGENT');
      expect(text).toContain('executor started');
      expect(text).toContain('Fix bug');
      expect(text).toContain('TOOL');
      expect(text).toContain('Read');
    });

    it('should format flow trace events in timeline', async () => {
      appendReplayEvent(testDir, 'flow-sess', { agent: 'system', event: 'hook_fire', hook: 'keyword-detector', hook_event: 'UserPromptSubmit' });
      appendReplayEvent(testDir, 'flow-sess', { agent: 'system', event: 'keyword_detected', keyword: 'ultrawork' });
      appendReplayEvent(testDir, 'flow-sess', { agent: 'system', event: 'mode_change', mode_from: 'none', mode_to: 'ultrawork' });
      appendReplayEvent(testDir, 'flow-sess', { agent: 'system', event: 'skill_activated', skill_name: 'ultrawork', skill_source: 'builtin' });
      appendReplayEvent(testDir, 'flow-sess', { agent: 'system', event: 'hook_result', hook: 'keyword-detector', hook_event: 'UserPromptSubmit', duration_ms: 15, context_injected: true, context_length: 847 });

      const result = await traceTimelineTool.handler({ sessionId: 'flow-sess', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('HOOK');
      expect(text).toContain('keyword-detector fired');
      expect(text).toContain('KEYWORD');
      expect(text).toContain('"ultrawork" detected');
      expect(text).toContain('MODE');
      expect(text).toContain('none -> ultrawork');
      expect(text).toContain('SKILL');
      expect(text).toContain('ultrawork activated');
    });

    it('should filter events by type', async () => {
      appendReplayEvent(testDir, 'filter-sess', { agent: 'system', event: 'hook_fire', hook: 'test' });
      appendReplayEvent(testDir, 'filter-sess', { agent: 'abc1234', event: 'agent_start', agent_type: 'executor' });
      appendReplayEvent(testDir, 'filter-sess', { agent: 'system', event: 'keyword_detected', keyword: 'ralph' });

      const hooksResult = await traceTimelineTool.handler({ sessionId: 'filter-sess', filter: 'hooks', workingDirectory: testDir });
      expect(hooksResult.content[0].text).toContain('HOOK');
      expect(hooksResult.content[0].text).not.toContain('AGENT');
      expect(hooksResult.content[0].text).not.toContain('KEYWORD');

      const keywordsResult = await traceTimelineTool.handler({ sessionId: 'filter-sess', filter: 'keywords', workingDirectory: testDir });
      expect(keywordsResult.content[0].text).toContain('KEYWORD');
      expect(keywordsResult.content[0].text).not.toContain('HOOK');
    });

    it('should limit events with last parameter', async () => {
      appendReplayEvent(testDir, 'limit-sess', { agent: 'a1', event: 'agent_start', agent_type: 'exec' });
      appendReplayEvent(testDir, 'limit-sess', { agent: 'a1', event: 'tool_end', tool: 'Read', duration_ms: 50 });
      appendReplayEvent(testDir, 'limit-sess', { agent: 'a1', event: 'tool_end', tool: 'Edit', duration_ms: 100 });
      appendReplayEvent(testDir, 'limit-sess', { agent: 'a1', event: 'agent_stop', success: true });

      const result = await traceTimelineTool.handler({ sessionId: 'limit-sess', last: 2, workingDirectory: testDir });
      const text = result.content[0].text;
      const eventLines = text.split('\n').filter(l => l.match(/^\s+\d/));
      expect(eventLines.length).toBe(2);
    });
  });

  describe('traceSummaryTool', () => {
    it('should have correct name and description', () => {
      expect(traceSummaryTool.name).toBe('trace_summary');
      expect(traceSummaryTool.description).toContain('statistics');
    });

    it('should return no sessions message when empty', async () => {
      const result = await traceSummaryTool.handler({ workingDirectory: testDir });
      expect(result.content[0].text).toContain('No trace sessions found');
    });

    it('should show overview statistics', async () => {
      appendReplayEvent(testDir, 'sum-sess', { agent: 'a1', event: 'agent_start', agent_type: 'executor' });
      appendReplayEvent(testDir, 'sum-sess', { agent: 'a1', event: 'tool_end', tool: 'Read', duration_ms: 100 });
      appendReplayEvent(testDir, 'sum-sess', { agent: 'a1', event: 'agent_stop', success: true });

      const result = await traceSummaryTool.handler({ sessionId: 'sum-sess', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('Trace Summary');
      expect(text).toContain('Total Events');
      expect(text).toContain('Agents');
      expect(text).toContain('1 spawned');
    });

    it('should show flow trace statistics', async () => {
      appendReplayEvent(testDir, 'flow-sum', { agent: 'system', event: 'hook_fire', hook: 'test' });
      appendReplayEvent(testDir, 'flow-sum', { agent: 'system', event: 'keyword_detected', keyword: 'ultrawork' });
      appendReplayEvent(testDir, 'flow-sum', { agent: 'system', event: 'skill_activated', skill_name: 'ultrawork', skill_source: 'builtin' });
      appendReplayEvent(testDir, 'flow-sum', { agent: 'system', event: 'mode_change', mode_from: 'none', mode_to: 'ultrawork' });

      const result = await traceSummaryTool.handler({ sessionId: 'flow-sum', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('Hooks');
      expect(text).toContain('Keywords Detected');
      expect(text).toContain('ultrawork');
      expect(text).toContain('Skills Activated');
      expect(text).toContain('Mode Transitions');
      expect(text).toContain('none -> ultrawork');
    });
  });

  describe('detectCycles', () => {
    it('should detect 2 planner/critic cycles', () => {
      const result = detectCycles(['planner', 'critic', 'planner', 'critic']);
      expect(result.cycles).toBe(2);
      expect(result.pattern).toBe('planner/critic');
    });

    it('should detect 3 cycles of a 2-element pattern', () => {
      const result = detectCycles(['planner', 'critic', 'planner', 'critic', 'planner', 'critic']);
      expect(result.cycles).toBe(3);
      expect(result.pattern).toBe('planner/critic');
    });

    it('should return 0 cycles for non-repeating sequence', () => {
      const result = detectCycles(['planner', 'executor', 'critic']);
      expect(result.cycles).toBe(0);
      expect(result.pattern).toBe('');
    });

    it('should return 0 cycles for single element', () => {
      const result = detectCycles(['planner']);
      expect(result.cycles).toBe(0);
    });

    it('should return 0 cycles for empty sequence', () => {
      const result = detectCycles([]);
      expect(result.cycles).toBe(0);
    });
  });

  describe('agent breakdown in summary', () => {
    it('should show agent breakdown with type counts and models', async () => {
      appendReplayEvent(testDir, 'bd-sess', { agent: 'a1', event: 'agent_start', agent_type: 'planner', model: 'opus' });
      appendReplayEvent(testDir, 'bd-sess', { agent: 'a1', event: 'agent_stop', agent_type: 'planner', success: true, duration_ms: 45000 });
      appendReplayEvent(testDir, 'bd-sess', { agent: 'a2', event: 'agent_start', agent_type: 'critic', model: 'opus' });
      appendReplayEvent(testDir, 'bd-sess', { agent: 'a2', event: 'agent_stop', agent_type: 'critic', success: true, duration_ms: 30000 });
      appendReplayEvent(testDir, 'bd-sess', { agent: 'a3', event: 'agent_start', agent_type: 'planner', model: 'opus' });
      appendReplayEvent(testDir, 'bd-sess', { agent: 'a3', event: 'agent_stop', agent_type: 'planner', success: true, duration_ms: 38000 });
      appendReplayEvent(testDir, 'bd-sess', { agent: 'a4', event: 'agent_start', agent_type: 'critic', model: 'opus' });
      appendReplayEvent(testDir, 'bd-sess', { agent: 'a4', event: 'agent_stop', agent_type: 'critic', success: true, duration_ms: 25000 });

      const result = await traceSummaryTool.handler({ sessionId: 'bd-sess', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('Agent Activity');
      expect(text).toContain('planner');
      expect(text).toContain('critic');
      expect(text).toContain('opus');
      expect(text).toContain('2 planner/critic cycle(s) detected');
    });

    it('should show execution flow section', async () => {
      appendReplayEvent(testDir, 'flow-exec', { agent: 'system', event: 'keyword_detected', keyword: 'plan' });
      appendReplayEvent(testDir, 'flow-exec', { agent: 'system', event: 'skill_invoked', skill_name: 'oh-my-claudecode:plan' });
      appendReplayEvent(testDir, 'flow-exec', { agent: 'a1', event: 'agent_start', agent_type: 'planner', model: 'opus' });
      appendReplayEvent(testDir, 'flow-exec', { agent: 'a1', event: 'agent_stop', agent_type: 'planner', success: true, duration_ms: 40000 });

      const result = await traceSummaryTool.handler({ sessionId: 'flow-exec', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('Execution Flow');
      expect(text).toContain('Keyword "plan" detected');
      expect(text).toContain('oh-my-claudecode:plan invoked');
      expect(text).toContain('planner agent spawned');
      expect(text).toContain('planner agent completed');
    });
  });

  describe('skills_invoked in summary', () => {
    it('should show skills invoked via Skill tool', async () => {
      appendReplayEvent(testDir, 'sk-sess', { agent: 'system', event: 'skill_invoked', skill_name: 'oh-my-claudecode:plan' });
      appendReplayEvent(testDir, 'sk-sess', { agent: 'system', event: 'skill_invoked', skill_name: 'oh-my-claudecode:ultrawork' });

      const result = await traceSummaryTool.handler({ sessionId: 'sk-sess', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('Skills Invoked');
      expect(text).toContain('oh-my-claudecode:plan');
      expect(text).toContain('oh-my-claudecode:ultrawork');
    });

    it('should format skill_invoked in timeline', async () => {
      appendReplayEvent(testDir, 'sk-tl', { agent: 'system', event: 'skill_invoked', skill_name: 'oh-my-claudecode:plan' });

      const result = await traceTimelineTool.handler({ sessionId: 'sk-tl', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('SKILL');
      expect(text).toContain('oh-my-claudecode:plan invoked');
    });

    it('should include skill_invoked in skills filter', async () => {
      appendReplayEvent(testDir, 'sk-flt', { agent: 'system', event: 'skill_invoked', skill_name: 'oh-my-claudecode:plan' });
      appendReplayEvent(testDir, 'sk-flt', { agent: 'a1', event: 'agent_start', agent_type: 'planner' });

      const result = await traceTimelineTool.handler({ sessionId: 'sk-flt', filter: 'skills', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('SKILL');
      expect(text).not.toContain('AGENT');
    });
  });

  describe('edge cases', () => {
    it('should handle malformed JSONL lines gracefully', async () => {
      const replayPath = join(testDir, '.omc', 'state', 'agent-replay-malformed.jsonl');
      writeFileSync(replayPath, [
        '{"t":0,"agent":"a1","event":"agent_start","agent_type":"executor"}',
        'THIS IS NOT JSON',
        '{"t":1,"agent":"a1","event":"agent_stop","success":true}',
        '',
      ].join('\n'));

      const result = await traceTimelineTool.handler({ sessionId: 'malformed', workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('malformed');
      expect(text).toContain('AGENT');
      expect(text).toContain('executor started');
      expect(text).toContain('completed');
      // Should have 2 valid events, skipping the malformed line
      expect(text).toContain('Events: 2');
    });

    it('should auto-detect latest session from multiple replay files', async () => {
      // Create older session
      const oldPath = join(testDir, '.omc', 'state', 'agent-replay-old-sess.jsonl');
      writeFileSync(oldPath, '{"t":0,"agent":"a1","event":"agent_start","agent_type":"planner"}\n');

      // Wait a tick to ensure different mtime
      const now = Date.now();
      while (Date.now() - now < 50) { /* spin */ }

      // Create newer session
      const newPath = join(testDir, '.omc', 'state', 'agent-replay-new-sess.jsonl');
      writeFileSync(newPath, '{"t":0,"agent":"a1","event":"agent_start","agent_type":"executor"}\n');

      // Call without sessionId — should auto-detect the newest
      const result = await traceTimelineTool.handler({ workingDirectory: testDir });
      const text = result.content[0].text;

      expect(text).toContain('new-sess');
      expect(text).toContain('executor');
    });
  });
});
