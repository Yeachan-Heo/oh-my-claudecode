import { describe, it, expect, vi } from 'vitest';
import { getContract, buildLaunchArgs, buildWorkerArgv, buildWorkerCommand, getWorkerEnv, parseCliOutput } from '../model-contract.js';

describe('model-contract', () => {
  describe('getContract', () => {
    it('returns contract for claude', () => {
      const c = getContract('claude');
      expect(c.agentType).toBe('claude');
      expect(c.binary).toBe('claude');
    });
    it('returns contract for codex', () => {
      const c = getContract('codex');
      expect(c.agentType).toBe('codex');
      expect(c.binary).toBe('codex');
    });
    it('returns contract for gemini', () => {
      const c = getContract('gemini');
      expect(c.agentType).toBe('gemini');
      expect(c.binary).toBe('gemini');
    });
    it('throws for unknown agent type', () => {
      expect(() => getContract('unknown' as any)).toThrow('Unknown agent type');
    });
  });

  describe('buildLaunchArgs', () => {
    it('claude includes --dangerously-skip-permissions', () => {
      const args = buildLaunchArgs('claude', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--dangerously-skip-permissions');
    });
    it('codex includes --full-auto only (no conflicting bypass flag)', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--full-auto');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });
    it('gemini includes --yolo', () => {
      const args = buildLaunchArgs('gemini', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).toContain('--yolo');
    });
    it('passes model flag when specified', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp', model: 'gpt-4' });
      expect(args).toContain('--model');
      expect(args).toContain('gpt-4');
    });
  });

  describe('getWorkerEnv', () => {
    it('returns correct env vars', () => {
      const env = getWorkerEnv('my-team', 'worker-1', 'codex');
      expect(env.OMC_TEAM_WORKER).toBe('my-team/worker-1');
      expect(env.OMC_TEAM_NAME).toBe('my-team');
      expect(env.OMC_WORKER_AGENT_TYPE).toBe('codex');
    });

    it('rejects invalid team names', () => {
      expect(() => getWorkerEnv('Bad-Team', 'worker-1', 'codex')).toThrow('Invalid team name');
    });
  });

  describe('buildWorkerArgv', () => {
    it('builds binary + args', () => {
      expect(buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' })).toEqual([
        'codex',
        '--full-auto',
      ]);
    });
  });

  describe('parseCliOutput', () => {
    it('claude returns trimmed output', () => {
      expect(parseCliOutput('claude', '  hello  ')).toBe('hello');
    });
    it('codex extracts result from JSONL', () => {
      const jsonl = JSON.stringify({ type: 'result', output: 'the answer' });
      expect(parseCliOutput('codex', jsonl)).toBe('the answer');
    });
    it('codex falls back to raw output if no JSONL', () => {
      expect(parseCliOutput('codex', 'plain text')).toBe('plain text');
    });
  });
});
