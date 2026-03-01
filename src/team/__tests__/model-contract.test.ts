import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvedEnv: vi.fn<() => NodeJS.ProcessEnv>(() => ({ PATH: '/mock/path' })),
}));

vi.mock('../shell-path.js', () => ({
  resolvedEnv: mocks.resolvedEnv,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

import { spawnSync } from 'child_process';
import { getContract, buildLaunchArgs, buildWorkerArgv, buildWorkerCommand, getWorkerEnv, parseCliOutput, isPromptModeAgent, getPromptModeArgs, isCliAvailable, clearResolvedPathCache } from '../model-contract.js';

describe('model-contract', () => {
  beforeEach(() => {
    clearResolvedPathCache();
    mocks.resolvedEnv.mockReset();
    mocks.resolvedEnv.mockReturnValue({ PATH: '/mock/path' });
  });

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
    it('codex includes --dangerously-bypass-approvals-and-sandbox', () => {
      const args = buildLaunchArgs('codex', { teamName: 't', workerName: 'w', cwd: '/tmp' });
      expect(args).not.toContain('--full-auto');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
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

    it('includes resolved PATH in worker env for spawn parity with CLI preflight', () => {
      mocks.resolvedEnv.mockReturnValue({ PATH: '/resolved/path' });
      const env = getWorkerEnv('my-team', 'worker-1', 'codex');
      expect(env.PATH).toBe('/resolved/path');
    });

    it('preserves path key casing when resolved env uses Path', () => {
      mocks.resolvedEnv.mockReturnValue({ Path: 'C:\\Tools\\bin' } as Record<string, string>);
      const env = getWorkerEnv('my-team', 'worker-1', 'codex');
      expect(env.Path).toBe('C:\\Tools\\bin');
      expect(env.PATH).toBeUndefined();
    });
  });

  describe('buildWorkerArgv', () => {
    it('resolves binary to absolute path before building argv', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({
        status: 0,
        stdout: '/usr/local/bin/codex\n',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      } as any);

      expect(buildWorkerArgv('codex', { teamName: 'my-team', workerName: 'worker-1', cwd: '/tmp' })).toEqual([
        '/usr/local/bin/codex',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
      mockSpawnSync.mockRestore();
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

  describe('isCliAvailable', () => {
    it('uses resolved absolute path without shell: true', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      // First call: which codex -> /usr/local/bin/codex
      mockSpawnSync.mockReturnValueOnce({
        status: 0, stdout: '/usr/local/bin/codex\n', stderr: '',
        pid: 0, output: [], signal: null,
      } as any);
      // Second call: /usr/local/bin/codex --version -> success
      mockSpawnSync.mockReturnValueOnce({
        status: 0, stdout: 'codex 1.0.0', stderr: '',
        pid: 0, output: [], signal: null,
      } as any);

      const result = isCliAvailable('codex');
      expect(result).toBe(true);

      // First call resolves binary path via which
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'which', ['codex'],
        expect.objectContaining({ timeout: 5000 }),
      );
      // Second call checks version with resolved path (no shell: true)
      expect(mockSpawnSync).toHaveBeenCalledWith(
        '/usr/local/bin/codex', ['--version'], { timeout: 5000 },
      );
      mockSpawnSync.mockRestore();
    });

    it('returns false when binary resolves to untrusted path', () => {
      const mockSpawnSync = vi.mocked(spawnSync);
      mockSpawnSync.mockReturnValueOnce({
        status: 0, stdout: '/tmp/evil/codex\n', stderr: '',
        pid: 0, output: [], signal: null,
      } as any);

      expect(isCliAvailable('codex')).toBe(false);
      mockSpawnSync.mockRestore();
    });
  });

  describe('prompt mode (headless TUI bypass)', () => {
    it('gemini supports prompt mode', () => {
      expect(isPromptModeAgent('gemini')).toBe(true);
      const c = getContract('gemini');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBe('-p');
    });

    it('claude does not support prompt mode', () => {
      expect(isPromptModeAgent('claude')).toBe(false);
    });

    it('codex supports prompt mode (positional argument, no flag)', () => {
      expect(isPromptModeAgent('codex')).toBe(true);
      const c = getContract('codex');
      expect(c.supportsPromptMode).toBe(true);
      expect(c.promptModeFlag).toBeUndefined();
    });

    it('getPromptModeArgs returns flag + instruction for gemini', () => {
      const args = getPromptModeArgs('gemini', 'Read inbox');
      expect(args).toEqual(['-p', 'Read inbox']);
    });

    it('getPromptModeArgs returns instruction only (positional) for codex', () => {
      const args = getPromptModeArgs('codex', 'Read inbox');
      expect(args).toEqual(['Read inbox']);
    });

    it('getPromptModeArgs returns empty array for non-prompt-mode agents', () => {
      expect(getPromptModeArgs('claude', 'Read inbox')).toEqual([]);
    });
  });
});
