import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getActivityLog, formatActivityTimeline } from '../activity-log.js';
import { logAuditEvent } from '../audit-log.js';

describe('activity-log', () => {
  let testDir: string;
  const teamName = 'test-activity';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'activity-log-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('getActivityLog', () => {
    it('returns empty array for no events', () => {
      const log = getActivityLog(testDir, teamName);
      expect(log).toEqual([]);
    });

    it('transforms audit events to activity entries', () => {
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:00:00Z',
        eventType: 'bridge_start',
        teamName,
        workerName: 'worker1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:01:00Z',
        eventType: 'task_completed',
        teamName,
        workerName: 'worker1',
        taskId: 'task1',
      });

      const log = getActivityLog(testDir, teamName);
      expect(log).toHaveLength(2);
      expect(log[0].category).toBe('lifecycle');
      expect(log[0].action).toContain('Started bridge');
      expect(log[1].category).toBe('task');
      expect(log[1].action).toContain('Completed');
      expect(log[1].target).toBe('task1');
    });

    it('filters by category', () => {
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:00:00Z',
        eventType: 'bridge_start',
        teamName,
        workerName: 'worker1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:01:00Z',
        eventType: 'task_failed',
        teamName,
        workerName: 'worker1',
        taskId: 'task1',
      });

      const errors = getActivityLog(testDir, teamName, { category: 'error' });
      expect(errors).toHaveLength(1);
      expect(errors[0].action).toContain('failed');
    });

    it('filters by actor', () => {
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:00:00Z',
        eventType: 'task_completed',
        teamName,
        workerName: 'worker1',
        taskId: 't1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:01:00Z',
        eventType: 'task_completed',
        teamName,
        workerName: 'worker2',
        taskId: 't2',
      });

      const log = getActivityLog(testDir, teamName, { actor: 'worker1' });
      expect(log).toHaveLength(1);
      expect(log[0].actor).toBe('worker1');
    });

    it('applies limit', () => {
      for (let i = 0; i < 5; i++) {
        logAuditEvent(testDir, {
          timestamp: `2026-01-01T10:0${i}:00Z`,
          eventType: 'task_completed',
          teamName,
          workerName: 'worker1',
          taskId: `t${i}`,
        });
      }

      const log = getActivityLog(testDir, teamName, { limit: 3 });
      expect(log).toHaveLength(3);
      // Should be the last 3 entries
      expect(log[0].target).toBe('t2');
    });

    it('filters by since timestamp', () => {
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T09:00:00Z',
        eventType: 'bridge_start',
        teamName,
        workerName: 'worker1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T11:00:00Z',
        eventType: 'task_completed',
        teamName,
        workerName: 'worker1',
        taskId: 't1',
      });

      const log = getActivityLog(testDir, teamName, { since: '2026-01-01T10:00:00Z' });
      expect(log).toHaveLength(1);
      expect(log[0].action).toContain('Completed');
    });
  });

  describe('formatActivityTimeline', () => {
    it('returns placeholder for empty activities', () => {
      const result = formatActivityTimeline([]);
      expect(result).toBe('(no activity recorded)');
    });

    it('formats activities as timeline', () => {
      const activities = [
        {
          timestamp: '2026-01-01T10:00:00Z',
          actor: 'worker1',
          action: 'Started bridge daemon',
          category: 'lifecycle' as const,
        },
        {
          timestamp: '2026-01-01T10:05:00Z',
          actor: 'worker1',
          action: 'Completed task t1',
          target: 't1',
          category: 'task' as const,
        },
      ];

      const result = formatActivityTimeline(activities);
      expect(result).toContain('[2026-01-01 10:00] worker1: Started bridge daemon');
      expect(result).toContain('[2026-01-01 10:05] worker1: Completed task t1 [t1]');
    });
  });
});
