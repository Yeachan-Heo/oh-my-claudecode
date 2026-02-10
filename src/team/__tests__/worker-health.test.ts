import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getWorkerHealthReports, checkWorkerHealth } from '../worker-health.js';
import { writeHeartbeat } from '../heartbeat.js';
import { registerMcpWorker } from '../team-registration.js';
import { logAuditEvent } from '../audit-log.js';
import type { HeartbeatData } from '../types.js';

// Mock tmux-session to avoid needing actual tmux
vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    isSessionAlive: vi.fn(() => false),
  };
});

describe('worker-health', () => {
  let testDir: string;
  const teamName = 'test-team';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'worker-health-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function registerWorker(name: string) {
    registerMcpWorker(
      teamName,
      name,
      'codex',
      'gpt-5.3-codex',
      'tmux-session',
      testDir,
      testDir
    );
  }

  function writeWorkerHeartbeat(name: string, status: HeartbeatData['status'], consecutiveErrors = 0, currentTaskId?: string) {
    writeHeartbeat(testDir, {
      workerName: name,
      teamName,
      provider: 'codex',
      pid: process.pid,
      lastPollAt: new Date().toISOString(),
      status,
      consecutiveErrors,
      currentTaskId,
    });
  }

  describe('getWorkerHealthReports', () => {
    it('returns empty array when no workers registered', () => {
      const reports = getWorkerHealthReports(teamName, testDir);
      expect(reports).toEqual([]);
    });

    it('reports alive worker with fresh heartbeat', () => {
      registerWorker('worker1');
      writeWorkerHeartbeat('worker1', 'polling');

      const reports = getWorkerHealthReports(teamName, testDir);
      expect(reports).toHaveLength(1);
      expect(reports[0].workerName).toBe('worker1');
      expect(reports[0].isAlive).toBe(true);
      expect(reports[0].status).toBe('polling');
      expect(reports[0].consecutiveErrors).toBe(0);
    });

    it('reports dead worker with stale heartbeat', () => {
      registerWorker('worker1');
      // Write heartbeat with old timestamp
      writeHeartbeat(testDir, {
        workerName: 'worker1',
        teamName,
        provider: 'codex',
        pid: process.pid,
        lastPollAt: new Date(Date.now() - 60000).toISOString(), // 60s ago
        status: 'polling',
        consecutiveErrors: 0,
      });

      const reports = getWorkerHealthReports(teamName, testDir, 30000);
      expect(reports).toHaveLength(1);
      expect(reports[0].isAlive).toBe(false);
      expect(reports[0].status).toBe('dead');
    });

    it('counts task completions and failures from audit log', () => {
      registerWorker('worker1');
      writeWorkerHeartbeat('worker1', 'polling');

      // Log some audit events
      logAuditEvent(testDir, { timestamp: new Date().toISOString(), eventType: 'task_completed', teamName, workerName: 'worker1', taskId: 't1' });
      logAuditEvent(testDir, { timestamp: new Date().toISOString(), eventType: 'task_completed', teamName, workerName: 'worker1', taskId: 't2' });
      logAuditEvent(testDir, { timestamp: new Date().toISOString(), eventType: 'task_permanently_failed', teamName, workerName: 'worker1', taskId: 't3' });

      const reports = getWorkerHealthReports(teamName, testDir);
      expect(reports[0].totalTasksCompleted).toBe(2);
      expect(reports[0].totalTasksFailed).toBe(1);
    });

    it('reports quarantined worker', () => {
      registerWorker('worker1');
      writeWorkerHeartbeat('worker1', 'quarantined', 3);

      const reports = getWorkerHealthReports(teamName, testDir);
      expect(reports[0].status).toBe('quarantined');
      expect(reports[0].consecutiveErrors).toBe(3);
    });
  });

  describe('checkWorkerHealth', () => {
    it('returns null for healthy worker', () => {
      registerWorker('worker1');
      writeWorkerHeartbeat('worker1', 'polling');

      const result = checkWorkerHealth(teamName, 'worker1', testDir);
      expect(result).toBeNull();
    });

    it('detects dead worker', () => {
      writeHeartbeat(testDir, {
        workerName: 'worker1',
        teamName,
        provider: 'codex',
        pid: process.pid,
        lastPollAt: new Date(Date.now() - 60000).toISOString(),
        status: 'polling',
        consecutiveErrors: 0,
      });

      const result = checkWorkerHealth(teamName, 'worker1', testDir, 30000);
      expect(result).toContain('dead');
    });

    it('detects quarantined worker', () => {
      writeWorkerHeartbeat('worker1', 'quarantined', 3);

      const result = checkWorkerHealth(teamName, 'worker1', testDir);
      expect(result).toContain('quarantined');
    });

    it('warns about high error count', () => {
      writeWorkerHeartbeat('worker1', 'polling', 2);

      const result = checkWorkerHealth(teamName, 'worker1', testDir);
      expect(result).toContain('consecutive errors');
    });

    it('returns null when no heartbeat exists', () => {
      const result = checkWorkerHealth(teamName, 'nonexistent', testDir);
      expect(result).toContain('dead');
    });
  });
});
