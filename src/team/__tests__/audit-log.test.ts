import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logAuditEvent, readAuditLog, rotateAuditLog } from '../audit-log.js';
import type { AuditEvent } from '../audit-log.js';

describe('audit-log', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'audit-log-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('logAuditEvent', () => {
    it('creates log file with 0o600 permissions', () => {
      const event: AuditEvent = {
        timestamp: new Date().toISOString(),
        eventType: 'bridge_start',
        teamName: 'team1',
        workerName: 'worker1',
      };

      logAuditEvent(testDir, event);

      const logPath = join(testDir, '.omc', 'logs', 'team-bridge-team1.jsonl');
      const stat = statSync(logPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('appends events to existing log', () => {
      const event1: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'bridge_start',
        teamName: 'team1',
        workerName: 'worker1',
      };
      const event2: AuditEvent = {
        timestamp: '2026-01-01T00:01:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
      };

      logAuditEvent(testDir, event1);
      logAuditEvent(testDir, event2);

      const logPath = join(testDir, '.omc', 'logs', 'team-bridge-team1.jsonl');
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(event1);
      expect(JSON.parse(lines[1])).toEqual(event2);
    });

    it('includes optional fields', () => {
      const event: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'cli_spawned',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
        details: { command: 'codex', model: 'gpt-5.3-codex' },
      };

      logAuditEvent(testDir, event);

      const events = readAuditLog(testDir, 'team1');
      expect(events).toHaveLength(1);
      expect(events[0].details).toEqual({ command: 'codex', model: 'gpt-5.3-codex' });
    });

    it('rejects path traversal attempts', () => {
      // Use a traversal that escapes the base directory entirely
      const event: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'bridge_start',
        teamName: '../../../../../../../../tmp/evil',
        workerName: 'worker1',
      };

      expect(() => logAuditEvent(testDir, event)).toThrow(/Path traversal detected/);
    });
  });

  describe('readAuditLog', () => {
    it('returns empty array for missing log', () => {
      const events = readAuditLog(testDir, 'nonexistent');
      expect(events).toEqual([]);
    });

    it('reads all events without filter', () => {
      const event1: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'bridge_start',
        teamName: 'team1',
        workerName: 'worker1',
      };
      const event2: AuditEvent = {
        timestamp: '2026-01-01T00:01:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker2',
        taskId: 'task1',
      };

      logAuditEvent(testDir, event1);
      logAuditEvent(testDir, event2);

      const events = readAuditLog(testDir, 'team1');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(event1);
      expect(events[1]).toEqual(event2);
    });

    it('filters by eventType', () => {
      const event1: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'bridge_start',
        teamName: 'team1',
        workerName: 'worker1',
      };
      const event2: AuditEvent = {
        timestamp: '2026-01-01T00:01:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
      };
      const event3: AuditEvent = {
        timestamp: '2026-01-01T00:02:00Z',
        eventType: 'task_completed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
      };

      logAuditEvent(testDir, event1);
      logAuditEvent(testDir, event2);
      logAuditEvent(testDir, event3);

      const events = readAuditLog(testDir, 'team1', { eventType: 'task_claimed' });
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('task_claimed');
    });

    it('filters by workerName', () => {
      const event1: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
      };
      const event2: AuditEvent = {
        timestamp: '2026-01-01T00:01:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker2',
        taskId: 'task2',
      };

      logAuditEvent(testDir, event1);
      logAuditEvent(testDir, event2);

      const events = readAuditLog(testDir, 'team1', { workerName: 'worker1' });
      expect(events).toHaveLength(1);
      expect(events[0].workerName).toBe('worker1');
    });

    it('filters by since timestamp', () => {
      const event1: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
      };
      const event2: AuditEvent = {
        timestamp: '2026-01-01T01:00:00Z',
        eventType: 'task_completed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
      };
      const event3: AuditEvent = {
        timestamp: '2026-01-01T02:00:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task2',
      };

      logAuditEvent(testDir, event1);
      logAuditEvent(testDir, event2);
      logAuditEvent(testDir, event3);

      const events = readAuditLog(testDir, 'team1', { since: '2026-01-01T01:00:00Z' });
      expect(events).toHaveLength(2);
      expect(events[0].timestamp).toBe('2026-01-01T01:00:00Z');
      expect(events[1].timestamp).toBe('2026-01-01T02:00:00Z');
    });

    it('combines multiple filters', () => {
      const event1: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
      };
      const event2: AuditEvent = {
        timestamp: '2026-01-01T01:00:00Z',
        eventType: 'task_completed',
        teamName: 'team1',
        workerName: 'worker1',
        taskId: 'task1',
      };
      const event3: AuditEvent = {
        timestamp: '2026-01-01T02:00:00Z',
        eventType: 'task_claimed',
        teamName: 'team1',
        workerName: 'worker2',
        taskId: 'task2',
      };

      logAuditEvent(testDir, event1);
      logAuditEvent(testDir, event2);
      logAuditEvent(testDir, event3);

      const events = readAuditLog(testDir, 'team1', {
        eventType: 'task_claimed',
        workerName: 'worker1',
        since: '2026-01-01T00:00:00Z',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event1);
    });

    it('skips malformed JSONL lines', () => {
      const event: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'bridge_start',
        teamName: 'team1',
        workerName: 'worker1',
      };

      logAuditEvent(testDir, event);

      // Manually append malformed line (append only the bad line, not re-writing existing content)
      const logPath = join(testDir, '.omc', 'logs', 'team-bridge-team1.jsonl');
      writeFileSync(logPath, '{invalid json\n', { flag: 'a' });

      const events = readAuditLog(testDir, 'team1');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });
  });

  describe('rotateAuditLog', () => {
    it('does nothing if log does not exist', () => {
      rotateAuditLog(testDir, 'team1');
      // Should not throw
    });

    it('does nothing if log is under size threshold', () => {
      const event: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'bridge_start',
        teamName: 'team1',
        workerName: 'worker1',
      };

      logAuditEvent(testDir, event);

      const logPath = join(testDir, '.omc', 'logs', 'team-bridge-team1.jsonl');
      const sizeBefore = statSync(logPath).size;

      rotateAuditLog(testDir, 'team1', 5 * 1024 * 1024); // 5MB threshold

      const sizeAfter = statSync(logPath).size;
      expect(sizeAfter).toBe(sizeBefore);
    });

    it('keeps most recent half of entries when rotating', () => {
      for (let i = 0; i < 10; i++) {
        const event: AuditEvent = {
          timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
          eventType: 'task_claimed',
          teamName: 'team1',
          workerName: 'worker1',
          taskId: `task${i}`,
        };
        logAuditEvent(testDir, event);
      }

      const logPath = join(testDir, '.omc', 'logs', 'team-bridge-team1.jsonl');

      // Force rotation by setting low threshold
      rotateAuditLog(testDir, 'team1', 100);

      const events = readAuditLog(testDir, 'team1');
      expect(events).toHaveLength(5); // Half of 10
      expect(events[0].taskId).toBe('task5'); // Should keep task5-task9
      expect(events[4].taskId).toBe('task9');
    });

    it('maintains 0o600 permissions after rotation', () => {
      for (let i = 0; i < 10; i++) {
        const event: AuditEvent = {
          timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
          eventType: 'task_claimed',
          teamName: 'team1',
          workerName: 'worker1',
          taskId: `task${i}`,
        };
        logAuditEvent(testDir, event);
      }

      rotateAuditLog(testDir, 'team1', 100);

      const logPath = join(testDir, '.omc', 'logs', 'team-bridge-team1.jsonl');
      const stat = statSync(logPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('handles custom size threshold', () => {
      const event: AuditEvent = {
        timestamp: '2026-01-01T00:00:00Z',
        eventType: 'bridge_start',
        teamName: 'team1',
        workerName: 'worker1',
      };

      logAuditEvent(testDir, event);

      const logPath = join(testDir, '.omc', 'logs', 'team-bridge-team1.jsonl');
      const size = statSync(logPath).size;

      // Set threshold just below current size
      rotateAuditLog(testDir, 'team1', size - 1);

      // Should have rotated
      const events = readAuditLog(testDir, 'team1');
      expect(events).toHaveLength(1); // With 1 event, keeps 0 (floor of 1/2)
    });
  });
});
