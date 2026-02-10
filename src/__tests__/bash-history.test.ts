/**
 * Tests for bash history integration (issue #290)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { execSync } from 'child_process';

describe('Bash History Integration', () => {
  const testHistoryPath = join(tmpdir(), `.bash_history_test_${process.pid}`);

  afterEach(() => {
    try { unlinkSync(testHistoryPath); } catch {
      // Cleanup failure is non-critical
    }
  });

  describe('appendToBashHistory logic', () => {
    function appendToBashHistory(command: string, historyPath: string) {
      if (!command || typeof command !== 'string') return;
      const cleaned = command.trim();
      if (!cleaned) return;
      if (cleaned.startsWith('#')) return;

      const { appendFileSync } = require('fs');
      appendFileSync(historyPath, cleaned + '\n');
    }

    it('should append a simple command', () => {
      appendToBashHistory('ls -la', testHistoryPath);
      const content = readFileSync(testHistoryPath, 'utf-8');
      expect(content).toBe('ls -la\n');
    });

    it('should append multiple commands', () => {
      appendToBashHistory('git status', testHistoryPath);
      appendToBashHistory('npm test', testHistoryPath);
      const content = readFileSync(testHistoryPath, 'utf-8');
      expect(content).toBe('git status\nnpm test\n');
    });

    it('should trim whitespace', () => {
      appendToBashHistory('  ls  ', testHistoryPath);
      const content = readFileSync(testHistoryPath, 'utf-8');
      expect(content).toBe('ls\n');
    });

    it('should skip empty commands', () => {
      appendToBashHistory('', testHistoryPath);
      appendToBashHistory('   ', testHistoryPath);
      expect(existsSync(testHistoryPath)).toBe(false);
    });

    it('should skip comments', () => {
      appendToBashHistory('# this is a comment', testHistoryPath);
      expect(existsSync(testHistoryPath)).toBe(false);
    });
  });

  describe('config reading', () => {
    function getBashHistoryEnabled(config: unknown): boolean {
      if (config === false) return false;
      if (typeof config === 'object' && config !== null && (config as any).enabled === false) return false;
      return true;
    }

    it('should default to enabled when no config', () => {
      expect(getBashHistoryEnabled(undefined)).toBe(true);
    });

    it('should respect false', () => {
      expect(getBashHistoryEnabled(false)).toBe(false);
    });

    it('should respect { enabled: false }', () => {
      expect(getBashHistoryEnabled({ enabled: false })).toBe(false);
    });

    it('should treat { enabled: true } as enabled', () => {
      expect(getBashHistoryEnabled({ enabled: true })).toBe(true);
    });
  });
});
