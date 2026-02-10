import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { routeTasks } from '../task-router.js';
import type { TaskFile } from '../types.js';
import { writeHeartbeat } from '../heartbeat.js';
import { registerMcpWorker } from '../team-registration.js';

describe('task-router', () => {
  let testDir: string;
  const teamName = 'test-router';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'task-router-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function registerWorker(name: string, provider: 'codex' | 'gemini' = 'codex', status: 'polling' | 'executing' | 'quarantined' = 'polling') {
    registerMcpWorker(teamName, name, provider, provider === 'codex' ? 'gpt-5.3-codex' : 'gemini-3-pro', `${teamName}-${name}`, testDir, testDir);
    writeHeartbeat(testDir, {
      workerName: name,
      teamName,
      provider,
      pid: process.pid,
      lastPollAt: new Date().toISOString(),
      status,
      consecutiveErrors: status === 'quarantined' ? 3 : 0,
    });
  }

  function makeTask(id: string, subject: string): TaskFile {
    return {
      id,
      subject,
      description: `Task ${id} description`,
      status: 'pending',
      owner: '',
      blocks: [],
      blockedBy: [],
    };
  }

  describe('routeTasks', () => {
    it('returns empty array for no tasks', () => {
      const decisions = routeTasks(teamName, testDir, []);
      expect(decisions).toEqual([]);
    });

    it('returns empty array when no workers available', () => {
      const tasks = [makeTask('t1', 'Review code')];
      const decisions = routeTasks(teamName, testDir, tasks);
      expect(decisions).toEqual([]);
    });

    it('routes to codex worker for code review capabilities', () => {
      registerWorker('codex-1', 'codex');
      registerWorker('gemini-1', 'gemini');

      const tasks = [makeTask('t1', 'Review code')];
      const decisions = routeTasks(teamName, testDir, tasks, {
        t1: ['code-review', 'security-review'],
      });

      expect(decisions).toHaveLength(1);
      expect(decisions[0].assignedTo).toBe('codex-1');
      expect(decisions[0].backend).toBe('mcp-codex');
    });

    it('routes to gemini worker for UI tasks', () => {
      registerWorker('codex-1', 'codex');
      registerWorker('gemini-1', 'gemini');

      const tasks = [makeTask('t1', 'Design UI')];
      const decisions = routeTasks(teamName, testDir, tasks, {
        t1: ['ui-design', 'documentation'],
      });

      expect(decisions).toHaveLength(1);
      expect(decisions[0].assignedTo).toBe('gemini-1');
      expect(decisions[0].backend).toBe('mcp-gemini');
    });

    it('excludes quarantined workers', () => {
      registerWorker('codex-1', 'codex', 'quarantined');
      registerWorker('codex-2', 'codex');

      const tasks = [makeTask('t1', 'Review code')];
      const decisions = routeTasks(teamName, testDir, tasks, {
        t1: ['code-review'],
      });

      expect(decisions).toHaveLength(1);
      expect(decisions[0].assignedTo).toBe('codex-2');
    });

    it('balances load across workers', () => {
      registerWorker('codex-1', 'codex');
      registerWorker('codex-2', 'codex');

      const tasks = [
        makeTask('t1', 'Review code 1'),
        makeTask('t2', 'Review code 2'),
      ];
      const decisions = routeTasks(teamName, testDir, tasks, {
        t1: ['code-review'],
        t2: ['code-review'],
      });

      expect(decisions).toHaveLength(2);
      // Should assign to different workers for load balance
      const assignees = new Set(decisions.map(d => d.assignedTo));
      expect(assignees.size).toBe(2);
    });

    it('uses general capability as fallback', () => {
      registerWorker('codex-1', 'codex');

      const tasks = [makeTask('t1', 'Do something')];
      // No specific capabilities = defaults to ['general']
      const decisions = routeTasks(teamName, testDir, tasks);

      // Codex doesn't have 'general' capability, so no match
      expect(decisions).toHaveLength(0);
    });

    it('includes routing reason and confidence', () => {
      registerWorker('codex-1', 'codex');

      const tasks = [makeTask('t1', 'Review')];
      const decisions = routeTasks(teamName, testDir, tasks, {
        t1: ['code-review'],
      });

      expect(decisions[0].reason).toBeTruthy();
      expect(decisions[0].confidence).toBeGreaterThan(0);
      expect(decisions[0].confidence).toBeLessThanOrEqual(1);
    });
  });
});
