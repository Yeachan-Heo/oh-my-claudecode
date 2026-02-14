/**
 * Tests for tmux-detector.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  analyzePaneContent,
  isTmuxAvailable,
  listTmuxPanes,
  capturePaneContent,
  scanForBlockedPanes,
  formatBlockedPanesSummary,
} from '../../features/rate-limit-wait/tmux-detector.js';
import type { BlockedPane } from '../../features/rate-limit-wait/types.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execSync, spawnSync } from 'child_process';

describe('tmux-detector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('analyzePaneContent', () => {
    it('should detect rate limit messages with Claude Code context', () => {
      const content = `
        Claude Code v1.2.3
        You've reached your rate limit. Please wait for the limit to reset.
        [1] Continue when ready
        [2] Exit
      `;

      const result = analyzePaneContent(content);

      expect(result.hasClaudeCode).toBe(true);
      expect(result.hasRateLimitMessage).toBe(true);
      expect(result.isBlocked).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should detect 5-hour rate limit', () => {
      const content = `
        Claude Code assistant
        5-hour usage limit reached
        [1] Wait for reset
      `;

      const result = analyzePaneContent(content);

      expect(result.hasRateLimitMessage).toBe(true);
      expect(result.rateLimitType).toBe('five_hour');
    });

    it('should detect weekly rate limit', () => {
      const content = `
        Claude Code
        Weekly usage quota exceeded
        Please try again later
      `;

      const result = analyzePaneContent(content);

      expect(result.hasRateLimitMessage).toBe(true);
      expect(result.rateLimitType).toBe('weekly');
    });

    it('should not flag content without Claude Code indicators', () => {
      const content = `
        vim test.js
        Hello World
      `;

      const result = analyzePaneContent(content);

      expect(result.hasClaudeCode).toBe(false);
      expect(result.isBlocked).toBe(false);
    });

    it('should not flag rate limit messages in non-Claude contexts', () => {
      const content = `
        curl api.example.com
        Error: rate limit exceeded
      `;

      const result = analyzePaneContent(content);

      expect(result.hasClaudeCode).toBe(false);
      expect(result.hasRateLimitMessage).toBe(true);
      expect(result.isBlocked).toBe(false); // No Claude context
    });

    it('should handle empty content', () => {
      const result = analyzePaneContent('');

      expect(result.hasClaudeCode).toBe(false);
      expect(result.hasRateLimitMessage).toBe(false);
      expect(result.isBlocked).toBe(false);
      expect(result.confidence).toBe(0);
    });

    it('should detect waiting patterns', () => {
      const content = `
        Claude assistant
        Rate limit reached
        [1] Continue
        [2] Cancel
      `;

      const result = analyzePaneContent(content);

      expect(result.confidence).toBeGreaterThan(0.6);
    });

    it('should detect Claude limit screen phrasing: hit your limit + numeric menu', () => {
      const content = `
        Claude Code
        You've hit your limit · resets Feb 17 at 2pm (Asia/Seoul)
        What do you want to do?

        ❯ 1. Stop and wait for limit to reset
          2. Request more

        Enter to confirm · Esc to cancel
      `;

      const result = analyzePaneContent(content);

      expect(result.hasClaudeCode).toBe(true);
      expect(result.hasRateLimitMessage).toBe(true);
      expect(result.isBlocked).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe('isTmuxAvailable', () => {
    it('should return true when tmux is installed', () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '/usr/bin/tmux\n',
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      });

      expect(isTmuxAvailable()).toBe(true);
    });

    it('should return false when tmux is not installed', () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: '',
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      });

      expect(isTmuxAvailable()).toBe(false);
    });

    it('should return false when spawnSync throws', () => {
      vi.mocked(spawnSync).mockImplementation(() => {
        throw new Error('Command not found');
      });

      expect(isTmuxAvailable()).toBe(false);
    });
  });

  describe('listTmuxPanes', () => {
    it('should parse tmux pane list correctly', () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '/usr/bin/tmux',
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      });

      vi.mocked(execSync).mockReturnValue(
        'main:0.0 %0 1 dev Claude\nmain:0.1 %1 0 dev Other\n'
      );

      const panes = listTmuxPanes();

      expect(panes).toHaveLength(2);
      expect(panes[0]).toEqual({
        id: '%0',
        session: 'main',
        windowIndex: 0,
        windowName: 'dev',
        paneIndex: 0,
        title: 'Claude',
        isActive: true,
      });
      expect(panes[1]).toEqual({
        id: '%1',
        session: 'main',
        windowIndex: 0,
        windowName: 'dev',
        paneIndex: 1,
        title: 'Other',
        isActive: false,
      });
    });

    it('should return empty array when tmux not available', () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: '',
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      });

      const panes = listTmuxPanes();

      expect(panes).toEqual([]);
    });
  });

  describe('capturePaneContent', () => {
    it('should capture pane content', () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '/usr/bin/tmux',
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      });

      vi.mocked(execSync).mockReturnValue('Line 1\nLine 2\nLine 3\n');

      const content = capturePaneContent('%0', 3);

      expect(content).toBe('Line 1\nLine 2\nLine 3\n');
      expect(execSync).toHaveBeenCalledWith(
        "tmux capture-pane -t '%0' -p -S -3",
        expect.any(Object)
      );
    });

    it('should return empty string when tmux not available', () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: '',
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      });

      const content = capturePaneContent('%0');

      expect(content).toBe('');
    });
  });

  describe('security: input validation', () => {
    it('should reject invalid pane IDs in capturePaneContent', () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '/usr/bin/tmux',
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      });

      // Valid pane ID should work
      vi.mocked(execSync).mockReturnValue('content');
      const validResult = capturePaneContent('%0');
      expect(validResult).toBe('content');

      // Invalid pane IDs should return empty string (not execute command)
      const invalidIds = [
        '; rm -rf /',
        '%0; echo hacked',
        '$(whoami)',
        '%0`id`',
        '../etc/passwd',
        '',
        'abc',
      ];

      for (const invalidId of invalidIds) {
        vi.mocked(execSync).mockClear();
        const result = capturePaneContent(invalidId);
        expect(result).toBe('');
      }
    });

    it('should validate lines parameter bounds', () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '/usr/bin/tmux',
        stderr: '',
        signal: null,
        pid: 1234,
        output: [],
      });

      vi.mocked(execSync).mockReturnValue('content');

      // Should clamp negative to 1
      capturePaneContent('%0', -5);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('-S -1'),
        expect.any(Object)
      );

      // Should clamp excessive values to 100
      vi.mocked(execSync).mockClear();
      capturePaneContent('%0', 1000);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('-S -100'),
        expect.any(Object)
      );
    });
  });

  describe('formatBlockedPanesSummary', () => {
    it('should format empty list', () => {
      const result = formatBlockedPanesSummary([]);
      expect(result).toBe('No blocked Claude Code sessions detected.');
    });

    it('should format blocked panes', () => {
      const panes: BlockedPane[] = [
        {
          id: '%0',
          session: 'main',
          windowIndex: 0,
          windowName: 'dev',
          paneIndex: 0,
          isActive: true,
          analysis: {
            hasClaudeCode: true,
            hasRateLimitMessage: true,
            isBlocked: true,
            rateLimitType: 'five_hour',
            confidence: 0.9,
          },
          firstDetectedAt: new Date(),
          resumeAttempted: false,
        },
      ];

      const result = formatBlockedPanesSummary(panes);

      expect(result).toContain('Found 1 blocked');
      expect(result).toContain('%0');
      expect(result).toContain('five_hour');
      expect(result).toContain('90%');
    });

    it('should show resume status', () => {
      const panes: BlockedPane[] = [
        {
          id: '%0',
          session: 'main',
          windowIndex: 0,
          windowName: 'dev',
          paneIndex: 0,
          isActive: true,
          analysis: {
            hasClaudeCode: true,
            hasRateLimitMessage: true,
            isBlocked: true,
            confidence: 0.8,
          },
          firstDetectedAt: new Date(),
          resumeAttempted: true,
          resumeSuccessful: true,
        },
      ];

      const result = formatBlockedPanesSummary(panes);

      expect(result).toContain('[RESUMED]');
    });
  });
});
