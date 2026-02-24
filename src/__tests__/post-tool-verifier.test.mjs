/**
 * Tests for post-tool-verifier.mjs failure detection
 * Covers issue #696: false positive "permission denied" from Claude Code temp CWD errors on macOS
 */

import { describe, it, expect } from 'vitest';
import { detectBashFailure, detectWriteFailure, isNonZeroExitWithOutput } from '../../scripts/post-tool-verifier.mjs';

describe('detectBashFailure', () => {
  describe('Claude Code temp CWD false positives (issue #696)', () => {
    it('should not flag macOS temp CWD permission error as a failure', () => {
      const output = 'zsh:1: permission denied: /var/folders/xx/yyyyyyy/T/claude-abc123def-cwd';
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should not flag temp CWD error with different session id', () => {
      const output = 'zsh:1: permission denied: /var/folders/ab/cdefgh/T/claude-xyz789-cwd';
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should not flag temp CWD error with different zsh line numbers', () => {
      const output = 'zsh:42: permission denied: /var/folders/ab/cdefgh/T/claude-abc000-cwd';
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should not flag output that contains only a temp CWD error line', () => {
      const output = [
        'some normal output',
        'zsh:1: permission denied: /var/folders/xx/yyyyy/T/claude-abc123-cwd',
        'more normal output',
      ].join('\n');
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should still flag real permission denied errors not matching the temp CWD pattern', () => {
      const output = 'bash: /etc/shadow: permission denied';
      expect(detectBashFailure(output)).toBe(true);
    });

    it('should flag real permission denied even when temp CWD noise is also present', () => {
      const output = [
        'zsh:1: permission denied: /var/folders/xx/yyyyy/T/claude-abc123-cwd',
        'rm: /protected/file: permission denied',
      ].join('\n');
      expect(detectBashFailure(output)).toBe(true);
    });
  });

  describe('real error detection', () => {
    it('should detect "error:" pattern', () => {
      expect(detectBashFailure('error: file not found')).toBe(true);
    });

    it('should detect "failed" pattern', () => {
      expect(detectBashFailure('Build failed')).toBe(true);
    });

    it('should detect "command not found"', () => {
      expect(detectBashFailure('zsh: command not found: foo')).toBe(true);
    });

    it('should detect exit code failures', () => {
      expect(detectBashFailure('exit code: 1')).toBe(true);
    });

    it('should detect "fatal:" pattern', () => {
      expect(detectBashFailure('fatal: not a git repository')).toBe(true);
    });

    it('should return false for clean output', () => {
      expect(detectBashFailure('All tests passed')).toBe(false);
    });

    it('should return false for empty output', () => {
      expect(detectBashFailure('')).toBe(false);
    });
  });
});

describe('isNonZeroExitWithOutput (issue #960)', () => {
  describe('should return true for non-zero exit with valid stdout', () => {
    it('gh pr checks with pending checks (exit code 8)', () => {
      const output = [
        'Error: Exit code 8',
        'Lint & Type Check  pass  47s  https://example.com/1',
        'Test               pending 0  https://example.com/2',
      ].join('\n');
      expect(isNonZeroExitWithOutput(output)).toBe(true);
    });

    it('generic non-zero exit with clean output', () => {
      const output = 'Error: Exit code 2\nSome valid output here';
      expect(isNonZeroExitWithOutput(output)).toBe(true);
    });

    it('exit code with multi-line valid output', () => {
      const output = [
        'Error: Exit code 1',
        'line 1: something',
        'line 2: something else',
        'line 3: all good',
      ].join('\n');
      expect(isNonZeroExitWithOutput(output)).toBe(true);
    });
  });

  describe('should return false for real failures', () => {
    it('exit code with error content in stdout', () => {
      const output = [
        'Error: Exit code 1',
        'FAIL src/test.js',
        'Test failed: expected 1 to equal 2',
      ].join('\n');
      expect(isNonZeroExitWithOutput(output)).toBe(false);
    });

    it('exit code with fatal error in stdout', () => {
      const output = 'Error: Exit code 128\nfatal: not a git repository';
      expect(isNonZeroExitWithOutput(output)).toBe(false);
    });

    it('exit code with permission denied in stdout', () => {
      const output = 'Error: Exit code 1\npermission denied: /etc/shadow';
      expect(isNonZeroExitWithOutput(output)).toBe(false);
    });

    it('exit code with "cannot" in stdout', () => {
      const output = 'Error: Exit code 1\ncannot find module "foo"';
      expect(isNonZeroExitWithOutput(output)).toBe(false);
    });
  });

  describe('should return false for non-matching cases', () => {
    it('exit code only, no stdout content', () => {
      expect(isNonZeroExitWithOutput('Error: Exit code 1')).toBe(false);
    });

    it('exit code with only whitespace after', () => {
      expect(isNonZeroExitWithOutput('Error: Exit code 1\n   \n  ')).toBe(false);
    });

    it('no exit code prefix at all', () => {
      expect(isNonZeroExitWithOutput('some normal output')).toBe(false);
    });

    it('empty string', () => {
      expect(isNonZeroExitWithOutput('')).toBe(false);
    });

    it('null/undefined', () => {
      expect(isNonZeroExitWithOutput(null)).toBe(false);
      expect(isNonZeroExitWithOutput(undefined)).toBe(false);
    });
  });
});

describe('detectWriteFailure', () => {
  describe('Claude Code temp CWD false positives (issue #696)', () => {
    it('should not flag macOS temp CWD permission error as a write failure', () => {
      const output = 'zsh:1: permission denied: /var/folders/xx/yyyyyyy/T/claude-abc123def-cwd';
      expect(detectWriteFailure(output)).toBe(false);
    });

    it('should not flag temp CWD error alongside successful write output', () => {
      const output = [
        'zsh:1: permission denied: /var/folders/xx/yyyyy/T/claude-abc123-cwd',
        'File written successfully.',
      ].join('\n');
      expect(detectWriteFailure(output)).toBe(false);
    });

    it('should still flag real permission denied on write operations', () => {
      const output = 'Write failed: permission denied on /etc/hosts';
      expect(detectWriteFailure(output)).toBe(true);
    });
  });

  describe('real write failure detection', () => {
    it('should detect "error" in output', () => {
      expect(detectWriteFailure('Write error occurred')).toBe(true);
    });

    it('should detect "failed" in output', () => {
      expect(detectWriteFailure('Operation failed')).toBe(true);
    });

    it('should detect "read-only" in output', () => {
      expect(detectWriteFailure('filesystem is read-only')).toBe(true);
    });

    it('should detect "not found" in output', () => {
      expect(detectWriteFailure('Directory not found')).toBe(true);
    });

    it('should return false for clean output', () => {
      expect(detectWriteFailure('File written successfully')).toBe(false);
    });
  });
});
