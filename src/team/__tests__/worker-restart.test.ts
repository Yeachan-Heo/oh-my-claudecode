import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  shouldRestart,
  recordRestart,
  readRestartState,
  clearRestartState,
  synthesizeBridgeConfig,
} from '../worker-restart.js';
import type { McpWorkerMember } from '../types.js';

describe('worker-restart', () => {
  let testDir: string;
  const teamName = 'test-team';
  const workerName = 'worker1';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'worker-restart-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('shouldRestart', () => {
    it('returns base backoff for first restart', () => {
      const delay = shouldRestart(testDir, teamName, workerName);
      expect(delay).toBe(5000); // default base
    });

    it('returns exponential backoff values', () => {
      recordRestart(testDir, teamName, workerName);
      const delay = shouldRestart(testDir, teamName, workerName);
      expect(delay).toBe(10000); // 5000 * 2^1
    });

    it('caps backoff at backoffMaxMs', () => {
      const policy = { maxRestarts: 10, backoffBaseMs: 5000, backoffMaxMs: 15000, backoffMultiplier: 2 };
      recordRestart(testDir, teamName, workerName, policy);
      recordRestart(testDir, teamName, workerName, policy);
      recordRestart(testDir, teamName, workerName, policy); // count=3, would be 5000*2^3=40000
      const delay = shouldRestart(testDir, teamName, workerName, policy);
      expect(delay).toBe(15000); // capped
    });

    it('returns null after max restarts', () => {
      const policy = { maxRestarts: 2, backoffBaseMs: 1000, backoffMaxMs: 60000, backoffMultiplier: 2 };
      recordRestart(testDir, teamName, workerName, policy);
      recordRestart(testDir, teamName, workerName, policy);
      const delay = shouldRestart(testDir, teamName, workerName, policy);
      expect(delay).toBeNull();
    });

    it('uses custom policy', () => {
      const policy = { maxRestarts: 5, backoffBaseMs: 1000, backoffMaxMs: 30000, backoffMultiplier: 3 };
      const delay = shouldRestart(testDir, teamName, workerName, policy);
      expect(delay).toBe(1000); // base
    });
  });

  describe('recordRestart', () => {
    it('creates restart state on first call', () => {
      recordRestart(testDir, teamName, workerName);
      const state = readRestartState(testDir, teamName, workerName);
      expect(state).not.toBeNull();
      expect(state!.restartCount).toBe(1);
      expect(state!.workerName).toBe(workerName);
    });

    it('increments restart count', () => {
      recordRestart(testDir, teamName, workerName);
      recordRestart(testDir, teamName, workerName);
      const state = readRestartState(testDir, teamName, workerName);
      expect(state!.restartCount).toBe(2);
    });

    it('updates lastRestartAt timestamp', () => {
      recordRestart(testDir, teamName, workerName);
      const state1 = readRestartState(testDir, teamName, workerName);
      // Small delay to ensure different timestamp
      recordRestart(testDir, teamName, workerName);
      const state2 = readRestartState(testDir, teamName, workerName);
      expect(state2!.lastRestartAt).not.toBe('');
    });
  });

  describe('clearRestartState', () => {
    it('removes restart state', () => {
      recordRestart(testDir, teamName, workerName);
      expect(readRestartState(testDir, teamName, workerName)).not.toBeNull();
      clearRestartState(testDir, teamName, workerName);
      expect(readRestartState(testDir, teamName, workerName)).toBeNull();
    });

    it('does not throw for non-existent state', () => {
      expect(() => clearRestartState(testDir, teamName, 'nonexistent')).not.toThrow();
    });
  });

  describe('synthesizeBridgeConfig', () => {
    it('creates config from worker member', () => {
      const worker: McpWorkerMember = {
        agentId: 'agent-1',
        name: 'codex-worker',
        agentType: 'mcp-codex',
        model: 'gpt-5.3-codex',
        joinedAt: Date.now(),
        tmuxPaneId: 'omc-team-test-codex-worker',
        cwd: '/home/user/project',
        backendType: 'tmux',
        subscriptions: [],
      };

      const config = synthesizeBridgeConfig(worker, 'my-team');
      expect(config.workerName).toBe('codex-worker');
      expect(config.teamName).toBe('my-team');
      expect(config.workingDirectory).toBe('/home/user/project');
      expect(config.provider).toBe('codex');
      expect(config.model).toBe('gpt-5.3-codex');
      expect(config.pollIntervalMs).toBe(3000);
      expect(config.taskTimeoutMs).toBe(600000);
      expect(config.maxConsecutiveErrors).toBe(3);
    });

    it('handles gemini worker', () => {
      const worker: McpWorkerMember = {
        agentId: 'agent-2',
        name: 'gemini-worker',
        agentType: 'mcp-gemini',
        model: 'gemini-3-pro-preview',
        joinedAt: Date.now(),
        tmuxPaneId: 'omc-team-test-gemini-worker',
        cwd: '/home/user/project',
        backendType: 'tmux',
        subscriptions: [],
      };

      const config = synthesizeBridgeConfig(worker, 'my-team');
      expect(config.provider).toBe('gemini');
      expect(config.model).toBe('gemini-3-pro-preview');
    });
  });
});
