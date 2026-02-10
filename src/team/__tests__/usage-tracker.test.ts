import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  recordTaskUsage,
  measureCharCounts,
  generateUsageReport,
} from '../usage-tracker.js';
import type { TaskUsageRecord } from '../usage-tracker.js';

describe('usage-tracker', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'usage-tracker-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeRecord(workerName: string, taskId: string, wallClockMs: number = 5000): TaskUsageRecord {
    return {
      taskId,
      workerName,
      provider: 'codex',
      model: 'gpt-5.3-codex',
      startedAt: '2026-01-01T10:00:00Z',
      completedAt: '2026-01-01T10:05:00Z',
      wallClockMs,
      promptChars: 1000,
      responseChars: 2000,
    };
  }

  describe('recordTaskUsage', () => {
    it('appends record to JSONL log', () => {
      const record = makeRecord('worker1', 'task1');
      recordTaskUsage(testDir, 'test-team', record);

      const logPath = join(testDir, '.omc', 'logs', 'team-usage-test-team.jsonl');
      expect(existsSync(logPath)).toBe(true);

      const content = readFileSync(logPath, 'utf-8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.taskId).toBe('task1');
      expect(parsed.workerName).toBe('worker1');
    });

    it('appends multiple records', () => {
      recordTaskUsage(testDir, 'test-team', makeRecord('worker1', 'task1'));
      recordTaskUsage(testDir, 'test-team', makeRecord('worker1', 'task2'));

      const logPath = join(testDir, '.omc', 'logs', 'team-usage-test-team.jsonl');
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
    });

    it('creates log with correct permissions', () => {
      recordTaskUsage(testDir, 'test-team', makeRecord('worker1', 'task1'));

      const logPath = join(testDir, '.omc', 'logs', 'team-usage-test-team.jsonl');
      const stat = statSync(logPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('measureCharCounts', () => {
    it('reads file sizes correctly', () => {
      const promptPath = join(testDir, 'prompt.md');
      const outputPath = join(testDir, 'output.md');
      writeFileSync(promptPath, 'Hello World'); // 11 chars
      writeFileSync(outputPath, 'Response text here'); // 18 chars

      const result = measureCharCounts(promptPath, outputPath);
      expect(result.promptChars).toBe(11);
      expect(result.responseChars).toBe(18);
    });

    it('returns 0 for missing files', () => {
      const result = measureCharCounts('/nonexistent/prompt', '/nonexistent/output');
      expect(result.promptChars).toBe(0);
      expect(result.responseChars).toBe(0);
    });

    it('handles one file missing', () => {
      const promptPath = join(testDir, 'prompt.md');
      writeFileSync(promptPath, 'Prompt content');

      const result = measureCharCounts(promptPath, '/nonexistent/output');
      expect(result.promptChars).toBeGreaterThan(0);
      expect(result.responseChars).toBe(0);
    });
  });

  describe('generateUsageReport', () => {
    it('returns empty report for no records', () => {
      const report = generateUsageReport(testDir, 'test-team');
      expect(report.taskCount).toBe(0);
      expect(report.totalWallClockMs).toBe(0);
      expect(report.workers).toEqual([]);
    });

    it('aggregates across workers', () => {
      recordTaskUsage(testDir, 'test-team', makeRecord('worker1', 'task1', 5000));
      recordTaskUsage(testDir, 'test-team', makeRecord('worker1', 'task2', 3000));
      recordTaskUsage(testDir, 'test-team', makeRecord('worker2', 'task3', 7000));

      const report = generateUsageReport(testDir, 'test-team');
      expect(report.taskCount).toBe(3);
      expect(report.totalWallClockMs).toBe(15000);
      expect(report.workers).toHaveLength(2);

      const w1 = report.workers.find(w => w.workerName === 'worker1');
      expect(w1!.taskCount).toBe(2);
      expect(w1!.totalWallClockMs).toBe(8000);
      expect(w1!.totalPromptChars).toBe(2000);
      expect(w1!.totalResponseChars).toBe(4000);
    });

    it('handles single worker', () => {
      recordTaskUsage(testDir, 'test-team', makeRecord('worker1', 'task1'));

      const report = generateUsageReport(testDir, 'test-team');
      expect(report.taskCount).toBe(1);
      expect(report.workers).toHaveLength(1);
    });
  });
});
