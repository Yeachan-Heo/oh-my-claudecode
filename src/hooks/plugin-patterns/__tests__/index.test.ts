/**
 * Plugin Patterns - isValidFilePath Tests
 *
 * Covers:
 * - Unix relative paths (happy path)
 * - Windows relative paths with backslashes
 * - Windows absolute paths (C:\...)
 * - Unix absolute paths
 * - Path traversal attacks
 * - Shell metacharacter injection
 */

import { describe, it, expect } from 'vitest';
import { isValidFilePath } from '../index.js';

describe('isValidFilePath', () => {
  // -------------------------------------------------------------------------
  // Valid paths that must be accepted
  // -------------------------------------------------------------------------

  describe('valid paths', () => {
    it('accepts a simple relative Unix path', () => {
      expect(isValidFilePath('src/file.ts')).toBe(true);
    });

    it('accepts a nested relative Unix path', () => {
      expect(isValidFilePath('src/hooks/plugin-patterns/index.ts')).toBe(true);
    });

    it('accepts a Unix absolute path', () => {
      expect(isValidFilePath('/home/user/project/src/file.ts')).toBe(true);
    });

    it('accepts a Windows relative path with backslashes', () => {
      expect(isValidFilePath('src\\file.ts')).toBe(true);
    });

    it('accepts a Windows nested relative path with backslashes', () => {
      expect(isValidFilePath('src\\hooks\\plugin-patterns\\index.ts')).toBe(true);
    });

    it('accepts a Windows absolute path', () => {
      expect(isValidFilePath('C:\\repo\\src\\file.ts')).toBe(true);
    });

    it('accepts a Windows absolute path with forward slashes', () => {
      expect(isValidFilePath('C:/repo/src/file.ts')).toBe(true);
    });

    it('accepts a path with a dot in the filename', () => {
      expect(isValidFilePath('src/my.component.tsx')).toBe(true);
    });

    it('accepts a path with hyphens and underscores', () => {
      expect(isValidFilePath('src/my-component_v2.ts')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Path traversal — must be rejected
  // -------------------------------------------------------------------------

  describe('path traversal attacks', () => {
    it('rejects Unix path traversal', () => {
      expect(isValidFilePath('../etc/passwd')).toBe(false);
    });

    it('rejects deep Unix path traversal', () => {
      expect(isValidFilePath('../../etc/shadow')).toBe(false);
    });

    it('rejects embedded Unix traversal', () => {
      expect(isValidFilePath('src/../../etc/passwd')).toBe(false);
    });

    it('rejects Windows path traversal with backslashes', () => {
      expect(isValidFilePath('..\\etc\\passwd')).toBe(false);
    });

    it('rejects mixed-separator traversal', () => {
      expect(isValidFilePath('src/..\\..\\etc/passwd')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Shell metacharacter injection — must be rejected
  // -------------------------------------------------------------------------

  describe('shell metacharacter injection', () => {
    it('rejects semicolon injection', () => {
      expect(isValidFilePath('file.ts; rm -rf /')).toBe(false);
    });

    it('rejects pipe injection', () => {
      expect(isValidFilePath('file.ts | cat /etc/passwd')).toBe(false);
    });

    it('rejects ampersand injection', () => {
      expect(isValidFilePath('file.ts & curl evil.com')).toBe(false);
    });

    it('rejects backtick injection', () => {
      expect(isValidFilePath('file.ts`whoami`')).toBe(false);
    });

    it('rejects dollar-sign subshell injection', () => {
      expect(isValidFilePath('file.ts$(whoami)')).toBe(false);
    });

    it('rejects newline injection', () => {
      expect(isValidFilePath('file.ts\nrm -rf /')).toBe(false);
    });

    it('rejects null byte injection', () => {
      expect(isValidFilePath('file.ts\0evil')).toBe(false);
    });

    it('rejects redirect characters', () => {
      expect(isValidFilePath('file.ts > /etc/crontab')).toBe(false);
    });

    it('rejects glob wildcard characters', () => {
      expect(isValidFilePath('src/*.ts')).toBe(false);
    });
  });
});
