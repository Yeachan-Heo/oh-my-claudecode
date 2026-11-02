import { describe, it, expect } from 'vitest';
import { sanitizeName, sessionName } from '../tmux-session.js';

describe('tmux-session edge cases', () => {
  describe('sanitizeName with empty string', () => {
    it('throws for empty string', () => {
      expect(() => sanitizeName('')).toThrow('no valid characters');
    });
  });

  describe('sanitizeName with unicode characters', () => {
    it('strips all unicode and keeps only ASCII alphanumeric/hyphen', () => {
      expect(() => sanitizeName('\u4F60\u597D\u{1F600}')).toThrow('no valid characters');
    });

    it('keeps ASCII portion of mixed unicode/ASCII', () => {
      expect(sanitizeName('\u4F60hello\u597D')).toBe('hello');
    });
  });

  describe('sanitizeName with only hyphens', () => {
    it('accepts hyphens-only name', () => {
      expect(sanitizeName('---')).toBe('---');
    });
  });

  describe('sanitizeName with whitespace', () => {
    it('strips spaces and tabs', () => {
      expect(sanitizeName('  hello  world  ')).toBe('helloworld');
    });
  });

  describe('sanitizeName with path traversal characters', () => {
    it('strips dots, slashes, and backslashes', () => {
      expect(sanitizeName('../../../etc/passwd')).toBe('etcpasswd');
    });
  });

  describe('sanitizeName with newlines and control characters', () => {
    it('strips all control characters', () => {
      expect(sanitizeName('hello\nworld\t!')).toBe('helloworld');
    });
  });

  describe('sessionName total length', () => {
    it('each part is truncated to 50 chars independently', () => {
      const longName = 'a'.repeat(100);
      const result = sessionName(longName, longName);
      // 'omc-team-' + 50 chars + '-' + 50 chars = 110 total
      expect(result.length).toBe(110);
      expect(result).toBe(`omc-team-${'a'.repeat(50)}-${'a'.repeat(50)}`);
    });
  });

  describe('sanitizeName preserves case', () => {
    it('does not lowercase the name', () => {
      expect(sanitizeName('MyWorker-ABC')).toBe('MyWorker-ABC');
    });
  });
});
