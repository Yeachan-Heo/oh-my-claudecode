import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateTeamReport, saveTeamReport } from '../summary-report.js';
import { logAuditEvent } from '../audit-log.js';
import { recordTaskUsage } from '../usage-tracker.js';

describe('summary-report', () => {
  let testDir: string;
  const teamName = 'test-report';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'summary-report-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('generateTeamReport', () => {
    it('generates valid markdown for empty team', () => {
      const report = generateTeamReport(testDir, teamName);
      expect(report).toContain(`# Team Report: ${teamName}`);
      expect(report).toContain('## Summary');
      expect(report).toContain('Workers: 0');
    });

    it('includes all sections', () => {
      // Add some audit events
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:00:00Z',
        eventType: 'bridge_start',
        teamName,
        workerName: 'worker1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:05:00Z',
        eventType: 'task_completed',
        teamName,
        workerName: 'worker1',
        taskId: 'task1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:10:00Z',
        eventType: 'bridge_shutdown',
        teamName,
        workerName: 'worker1',
      });

      // Add usage data
      recordTaskUsage(testDir, teamName, {
        taskId: 'task1',
        workerName: 'worker1',
        provider: 'codex',
        model: 'gpt-5.3-codex',
        startedAt: '2026-01-01T10:01:00Z',
        completedAt: '2026-01-01T10:05:00Z',
        wallClockMs: 240000,
        promptChars: 5000,
        responseChars: 10000,
      });

      const report = generateTeamReport(testDir, teamName);
      expect(report).toContain('## Summary');
      expect(report).toContain('## Task Results');
      expect(report).toContain('## Worker Performance');
      expect(report).toContain('## Activity Timeline');
      expect(report).toContain('## Usage Totals');
      expect(report).toContain('1 completed');
      expect(report).toContain('worker1');
    });

    it('handles multiple workers', () => {
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:00:00Z',
        eventType: 'task_completed',
        teamName,
        workerName: 'worker1',
        taskId: 'task1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:01:00Z',
        eventType: 'task_completed',
        teamName,
        workerName: 'worker2',
        taskId: 'task2',
      });

      const report = generateTeamReport(testDir, teamName);
      expect(report).toContain('Workers: 2');
      expect(report).toContain('2 completed');
    });

    it('distinguishes completed vs failed tasks', () => {
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:00:00Z',
        eventType: 'task_completed',
        teamName,
        workerName: 'worker1',
        taskId: 'task1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:01:00Z',
        eventType: 'task_permanently_failed',
        teamName,
        workerName: 'worker2',
        taskId: 'task2',
      });

      const report = generateTeamReport(testDir, teamName);
      expect(report).toContain('1 completed, 1 failed');
      expect(report).toMatch(/task1.*Completed/);
      expect(report).toMatch(/task2.*Failed/);
    });

    it('calculates duration from bridge start to shutdown', () => {
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:00:00Z',
        eventType: 'bridge_start',
        teamName,
        workerName: 'worker1',
      });
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:15:00Z',
        eventType: 'bridge_shutdown',
        teamName,
        workerName: 'worker1',
      });

      const report = generateTeamReport(testDir, teamName);
      expect(report).toContain('Duration: 15 minutes');
    });

    it('shows worker performance metrics', () => {
      recordTaskUsage(testDir, teamName, {
        taskId: 'task1',
        workerName: 'worker1',
        provider: 'codex',
        model: 'gpt-5.3-codex',
        startedAt: '2026-01-01T10:00:00Z',
        completedAt: '2026-01-01T10:02:00Z',
        wallClockMs: 120000,
        promptChars: 1000,
        responseChars: 2000,
      });

      const report = generateTeamReport(testDir, teamName);
      expect(report).toContain('## Worker Performance');
      expect(report).toContain('worker1');
      expect(report).toContain('120s');
      expect(report).toContain('1,000');
      expect(report).toContain('2,000');
    });

    it('limits activity timeline to last 50 entries', () => {
      // Add 100 events
      for (let i = 0; i < 100; i++) {
        logAuditEvent(testDir, {
          timestamp: `2026-01-01T10:${String(i).padStart(2, '0')}:00Z`,
          eventType: 'worker_idle',
          teamName,
          workerName: 'worker1',
        });
      }

      const report = generateTeamReport(testDir, teamName);
      const timelineMatch = report.match(/## Activity Timeline\n([\s\S]*?)\n\n/);
      expect(timelineMatch).toBeTruthy();
      const timeline = timelineMatch![1];
      const lineCount = timeline.split('\n').filter(l => l.trim()).length;
      expect(lineCount).toBeLessThanOrEqual(50);
    });

    it('includes timestamp in footer', () => {
      const report = generateTeamReport(testDir, teamName);
      expect(report).toMatch(/\*Generated at \d{4}-\d{2}-\d{2}T.*Z\*/);
    });
  });

  describe('saveTeamReport', () => {
    it('saves report to disk with correct permissions', () => {
      logAuditEvent(testDir, {
        timestamp: '2026-01-01T10:00:00Z',
        eventType: 'bridge_start',
        teamName,
        workerName: 'worker1',
      });

      const filePath = saveTeamReport(testDir, teamName);
      expect(existsSync(filePath)).toBe(true);
      expect(filePath).toContain('.omc/reports/');
      expect(filePath).toContain(teamName);

      const stat = statSync(filePath);
      expect(stat.mode & 0o777).toBe(0o600);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Team Report');
    });

    it('creates unique filenames with timestamps', async () => {
      const path1 = saveTeamReport(testDir, teamName);
      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 5));
      const path2 = saveTeamReport(testDir, teamName);
      expect(path1).not.toBe(path2);
      expect(existsSync(path1)).toBe(true);
      expect(existsSync(path2)).toBe(true);
    });

    it('validates path is within working directory', () => {
      // This should not throw - valid path
      expect(() => saveTeamReport(testDir, teamName)).not.toThrow();
    });
  });
});
