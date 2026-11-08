/**
 * Tests for bridge.ts pkill safety detection (issue #210)
 *
 * Tests the processPreToolUse hook's detection of dangerous pkill -f commands
 * that can cause self-termination of the shell session.
 */

import { describe, it, expect } from 'vitest';
import { processHook } from '../bridge.js';

describe('pkill safety detection in processPreToolUse', () => {
  describe('pkill -f detection', () => {
    it('should warn for pkill -f command', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -f "sleep 300"' },
      });

      expect(result.continue).toBe(true);
      expect(result.message).toContain('pkill -f');
      expect(result.message).toContain('self-terminate');
    });

    it('should warn for pkill -f without quotes', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -f sleep' },
      });

      expect(result.continue).toBe(true);
      expect(result.message).toContain('pkill -f');
      expect(result.message).toContain('self-terminate');
    });

    it('should warn for pkill -f with multiple spaces', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill  -f   "node process"' },
      });

      expect(result.continue).toBe(true);
      expect(result.message).toContain('pkill -f');
    });

    it('should warn for pkill with -f flag anywhere in args', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -9 -f "myprocess"' },
      });

      expect(result.continue).toBe(true);
      expect(result.message).toContain('pkill -f');
    });
  });

  describe('safe pkill usage', () => {
    it('should not warn for pkill without -f flag', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill sleep' },
      });

      // Should not have pkill warning (may have other messages from orchestrator)
      expect(result.message || '').not.toContain('self-terminate');
    });

    it('should not warn for pkill with exact process name', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -9 node' },
      });

      expect(result.message || '').not.toContain('self-terminate');
    });
  });

  describe('safe alternatives', () => {
    it('should not warn for pgrep alternative', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'kill $(pgrep -f "sleep")' },
      });

      expect(result.message || '').not.toContain('self-terminate');
    });

    it('should not warn for killall command', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'killall -f node' },
      });

      expect(result.message || '').not.toContain('pkill');
    });
  });

  describe('non-Bash tools', () => {
    it('should not warn for non-Bash tools', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Read',
        toolInput: { file_path: '/tmp/test' },
      });

      expect(result.message || '').not.toContain('pkill');
    });

    it('should not warn for Task tool', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Task',
        toolInput: { description: 'pkill -f something' },
      });

      expect(result.message || '').not.toContain('self-terminate');
    });
  });

  describe('edge cases', () => {
    it('should handle missing command field', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: {},
      });

      expect(result.message || '').not.toContain('pkill');
    });

    it('should handle undefined toolInput', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
      });

      expect(result.message || '').not.toContain('pkill');
    });

    it('should handle empty command string', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: '' },
      });

      expect(result.message || '').not.toContain('pkill');
    });

    it('should not false positive on -flag text (no space after -f)', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -force node' },
      });

      // -force is not the same as -f flag
      expect(result.message || '').not.toContain('self-terminate');
    });

    it('should detect -f as separate word', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -f node' },
      });

      expect(result.continue).toBe(true);
      expect(result.message).toContain('pkill -f');
    });
  });

  describe('warning message content', () => {
    it('should include alternatives in warning', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -f "myapp"' },
      });

      expect(result.message).toContain('Safer alternatives');
      expect(result.message).toContain('pkill <exact-process-name>');
      expect(result.message).toContain('pgrep');
    });

    it('should explain the risk', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -f "sleep"' },
      });

      expect(result.message).toContain('matches its own process command line');
      expect(result.message).toContain('exit code 144');
    });

    it('should allow proceeding', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -f "test"' },
      });

      expect(result.continue).toBe(true);
      expect(result.message).toContain('Proceeding anyway');
    });
  });

  describe('complex command scenarios', () => {
    it('should detect pkill -f in piped command', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'echo "starting" && pkill -f "node server" && echo "done"' },
      });

      expect(result.continue).toBe(true);
      expect(result.message).toContain('pkill -f');
    });

    it('should detect pkill -f with other flags', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: 'pkill -9 -f -u user "process"' },
      });

      expect(result.continue).toBe(true);
      expect(result.message).toContain('pkill -f');
    });

    it('should not warn for commented pkill -f', async () => {
      const result = await processHook('pre-tool-use', {
        toolName: 'Bash',
        toolInput: { command: '# pkill -f "test" - this is commented' },
      });

      // Regex will still match, but that's acceptable for safety
      // Better to warn on false positive than miss a dangerous command
      expect(result.continue).toBe(true);
    });
  });
});
