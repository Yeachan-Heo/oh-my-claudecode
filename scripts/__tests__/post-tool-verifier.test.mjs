/**
 * Tests for post-tool-verifier detection functions
 * Validates fix for issue #579: WSL PostToolUse false positives
 */
import { describe, it, expect } from 'vitest';
import { detectBashFailure, detectWriteFailure, detectBackgroundOperation } from '../post-tool-verifier.mjs';

// ── detectBashFailure ──────────────────────────────────────────────────────

describe('detectBashFailure', () => {
  describe('true positives (actual failures)', () => {
    it('detects non-zero exit code', () => {
      expect(detectBashFailure('some output\nExit code: 1')).toBe(true);
      expect(detectBashFailure('Exit code: 127')).toBe(true);
      expect(detectBashFailure('exit status 2')).toBe(true);
      expect(detectBashFailure('Process exited with code 1')).toBe(true);
    });

    it('detects command not found', () => {
      expect(detectBashFailure('bash: foobar: command not found')).toBe(true);
      expect(detectBashFailure('zsh: foobar: command not found')).toBe(true);
      expect(detectBashFailure('sh: foobar: command not found')).toBe(true);
      expect(detectBashFailure('  bash: foobar: command not found')).toBe(true);
    });

    it('detects permission denied', () => {
      expect(detectBashFailure('/usr/bin/foo: Permission denied')).toBe(true);
      expect(detectBashFailure('permission denied while accessing file')).toBe(true);
      expect(detectBashFailure('operation not permitted')).toBe(true);
    });

    it('detects no such file or directory', () => {
      expect(detectBashFailure('cat: /tmp/missing.txt: No such file or directory')).toBe(true);
    });

    it('detects fatal errors', () => {
      expect(detectBashFailure('fatal: not a git repository')).toBe(true);
      expect(detectBashFailure('  fatal: repository not found')).toBe(true);
    });

    it('detects panic errors', () => {
      expect(detectBashFailure('panic: runtime error')).toBe(true);
      expect(detectBashFailure('  panic: index out of range')).toBe(true);
    });

    it('detects line-anchored error: prefix', () => {
      expect(detectBashFailure('error: something went wrong')).toBe(true);
      expect(detectBashFailure('Error: ENOENT')).toBe(true);
      expect(detectBashFailure('Error: ENOENT no such file or directory, open /tmp/missing')).toBe(true);
    });
  });

  describe('false positives that should NOT trigger (issue #579)', () => {
    it('does not flag output containing "error" in file content', () => {
      // WSL reproduction: head -5 of a bug report file
      expect(detectBashFailure('# Bug Report\nThis describes an error handling improvement')).toBe(false);
    });

    it('does not flag output containing "failed" in file content', () => {
      expect(detectBashFailure('The test previously failed but now passes')).toBe(false);
    });

    it('does not flag output containing "cannot" in content', () => {
      expect(detectBashFailure('Users cannot access this page without authentication')).toBe(false);
    });

    it('does not flag output containing "abort" in content', () => {
      expect(detectBashFailure('Use AbortController to cancel the request')).toBe(false);
    });

    it('does not flag output with "error" in variable names', () => {
      expect(detectBashFailure('const errorHandler = (err) => console.log(err);')).toBe(false);
    });

    it('does not flag output with "error" in paths', () => {
      expect(detectBashFailure('-rw-r--r-- 1 user user 245 Feb 12 src/error-handler.ts')).toBe(false);
    });

    it('does not flag output with "failed" in JSON values', () => {
      expect(detectBashFailure('{"previous_status": "failed", "current_status": "passed"}')).toBe(false);
    });

    it('does not flag exit code 0', () => {
      expect(detectBashFailure('Exit code: 0')).toBe(false);
      expect(detectBashFailure('exit status 0')).toBe(false);
    });

    it('does not flag successful ls output', () => {
      expect(detectBashFailure('-rw-r--r-- 1 user user 6.0K Feb 12 /tmp/bug-report.md')).toBe(false);
    });

    it('does not flag successful wc output', () => {
      expect(detectBashFailure('208 /tmp/bug-report.md')).toBe(false);
    });

    it('does not flag npm install output with warnings', () => {
      const npmOutput = 'added 150 packages in 3s\n12 packages are looking for funding\n  run `npm fund` for details';
      expect(detectBashFailure(npmOutput)).toBe(false);
    });

    it('does not flag git log output mentioning errors', () => {
      const gitLog = 'abc1234 fix: handle error cases in auth module\ndef5678 refactor: improve error handling';
      expect(detectBashFailure(gitLog)).toBe(false);
    });

    it('does not flag compiler warnings that contain "error" word', () => {
      const compilerOutput = 'warning: unused variable `error_count`\nCompiled successfully.';
      expect(detectBashFailure(compilerOutput)).toBe(false);
    });
  });
});

// ── detectWriteFailure ─────────────────────────────────────────────────────

describe('detectWriteFailure', () => {
  describe('true positives (actual failures)', () => {
    it('detects ENOENT errors', () => {
      expect(detectWriteFailure('ENOENT: no such file or directory')).toBe(true);
    });

    it('detects EACCES errors', () => {
      expect(detectWriteFailure('EACCES: permission denied')).toBe(true);
    });

    it('detects EPERM errors', () => {
      expect(detectWriteFailure('EPERM: operation not permitted')).toBe(true);
    });

    it('detects EISDIR errors', () => {
      expect(detectWriteFailure('EISDIR: illegal operation on a directory')).toBe(true);
    });

    it('detects EROFS errors', () => {
      expect(detectWriteFailure('EROFS: read-only file system')).toBe(true);
    });

    it('detects read-only file system', () => {
      expect(detectWriteFailure('read-only file system')).toBe(true);
    });

    it('detects Permission denied at end of line', () => {
      expect(detectWriteFailure('/path/to/file: Permission denied')).toBe(true);
    });

    it('detects line-anchored Error:', () => {
      expect(detectWriteFailure('Error: File not found')).toBe(true);
      expect(detectWriteFailure('\n  Error: failed to write file')).toBe(true);
    });

    it('detects errno token patterns', () => {
      expect(detectWriteFailure('write failed with ENOENT')).toBe(true);
      expect(detectWriteFailure('open failed: EACCES')).toBe(true);
    });

    it('detects old_string not found (Edit tool)', () => {
      expect(detectWriteFailure('old_string was not found in the file')).toBe(true);
    });

    it('detects could not find match', () => {
      expect(detectWriteFailure('Could not find the specified text')).toBe(true);
    });

    it('detects no match found', () => {
      expect(detectWriteFailure('No match found for the given string')).toBe(true);
    });
  });

  describe('false positives that should NOT trigger (issue #579)', () => {
    it('does not flag content containing "error" as a word', () => {
      expect(detectWriteFailure('This file describes error handling patterns')).toBe(false);
    });

    it('does not flag content containing "failed" as a word', () => {
      expect(detectWriteFailure('The previously failed test now passes')).toBe(false);
    });

    it('does not flag content containing "not found" in prose', () => {
      expect(detectWriteFailure('The page was not found by the user')).toBe(false);
    });

    it('does not flag successful write response', () => {
      expect(detectWriteFailure('Successfully wrote 208 lines to /tmp/bug-report.md')).toBe(false);
    });

    it('does not flag file content with error-related variable names', () => {
      expect(detectWriteFailure('const handleError = (e) => { throw e; }')).toBe(false);
    });

    it('does not flag file content with "Error" in class names', () => {
      expect(detectWriteFailure('class CustomError extends Error {}')).toBe(false);
    });

    it('does not flag code with error imports', () => {
      expect(detectWriteFailure("import { NotFoundError } from './errors';")).toBe(false);
    });

    it('does not flag markdown with "error" in headings', () => {
      expect(detectWriteFailure('## Error Handling\nThe system handles errors gracefully.')).toBe(false);
    });

    it('does not flag JSON with "error" keys', () => {
      expect(detectWriteFailure('{"error_count": 0, "status": "ok"}')).toBe(false);
    });

    it('does not flag HTML with "error" in CSS classes', () => {
      expect(detectWriteFailure('<div class="error-message hidden">No errors</div>')).toBe(false);
    });
  });
});

// ── detectBackgroundOperation ──────────────────────────────────────────────

describe('detectBackgroundOperation', () => {
  describe('true positives', () => {
    it('detects task_id in output', () => {
      expect(detectBackgroundOperation('{"task_id": "abc-123"}')).toBe(true);
      expect(detectBackgroundOperation('\n  task_id: abc-123')).toBe(true);
    });

    it('detects background launch/resume/start markers', () => {
      expect(detectBackgroundOperation('Background task launched successfully')).toBe(true);
      expect(detectBackgroundOperation('\n background resumed by worker')).toBe(true);
      expect(detectBackgroundOperation('\n   background task started for job')).toBe(true);
    });

    it('detects run_in_background and spawned markers', () => {
      expect(detectBackgroundOperation('run_in_background: true')).toBe(true);
      expect(detectBackgroundOperation('\nspawned worker process')).toBe(true);
    });
  });

  describe('false positives that should NOT trigger', () => {
    it('does not flag content with "started" as a word', () => {
      expect(detectBackgroundOperation('The server started successfully on port 3000')).toBe(false);
    });

    it('does not flag content with "running" as a word', () => {
      expect(detectBackgroundOperation('Tests are running: 5 passed, 0 failed')).toBe(false);
    });

    it('does not flag content with "async" in code', () => {
      expect(detectBackgroundOperation('async function fetchData() { return await api.get(); }')).toBe(false);
    });

    it('does not flag content with "background" in CSS', () => {
      expect(detectBackgroundOperation('background-color: #fff; background-image: none;')).toBe(false);
    });
  });
});
