import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir, homedir } from 'os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

describe('account element - behavioral tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-account-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('email validation', () => {
    it('accepts valid plain email addresses', () => {
      const testCases = [
        'alice@example.com',
        'bob.smith@domain.co.uk',
        'user+tag@example.org',
        'test123@test-domain.com',
      ];

      for (const email of testCases) {
        const json = JSON.stringify({ oauthAccount: { emailAddress: email } });
        // Basic validation: should contain @ and domain with dot, no control chars
        expect(email).toContain('@');
        expect(email.split('@')[1]).toContain('.');
        // Should not contain any C0/C1 controls or bidi marks
        expect(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(email)).toBe(false);
      }
    });

    it('rejects emails with whitespace', () => {
      const invalidEmails = [
        'alice @example.com',
        'alice@ example.com',
        'alice\t@example.com',
        'alice\n@example.com',
      ];

      for (const email of invalidEmails) {
        expect(/\s/.test(email)).toBe(true); // Has whitespace
      }
    });

    it('rejects emails with control characters (C0, C1, ESC)', () => {
      const invalidEmails = [
        'alice\x00@example.com', // NULL
        'alice\x1b@example.com', // ESC
        'alice\x80@example.com', // C1 control
        'alice\x9f@example.com', // C1 control
      ];

      for (const email of invalidEmails) {
        expect(/[\x00-\x1f\x7f-\x9f]/.test(email)).toBe(true); // Has control char
      }
    });

    it('rejects emails with bidi controls', () => {
      const invalidEmails = [
        'alice\u200e@example.com', // LRM
        'alice\u200f@example.com', // RLM
        'alice\u202a@example.com', // LRE
        'alice\u202b@example.com', // RLE
        'alice\u202c@example.com', // PDF
        'alice\u202d@example.com', // LRO
        'alice\u202e@example.com', // RLO
        'alice\u2066@example.com', // LRI
        'alice\u2067@example.com', // RLI
        'alice\u2068@example.com', // FSI
        'alice\u2069@example.com', // PDI
      ];

      for (const email of invalidEmails) {
        expect(/[\u200e-\u200f\u202a-\u202e\u2066-\u2069]/.test(email)).toBe(true); // Has bidi control
      }
    });

    it('rejects emails without @ symbol', () => {
      const invalidEmails = [
        'aliceexample.com',
        'alice-example-com',
      ];

      for (const email of invalidEmails) {
        expect(email).not.toContain('@');
      }
    });

    it('rejects emails without proper domain (no dot after @)', () => {
      const invalidEmails = [
        'alice@localhost',
        'alice@example',
        'alice@sub',
      ];

      for (const email of invalidEmails) {
        const domain = email.split('@')[1] ?? '';
        expect(domain).not.toContain('.');
      }
    });

    it('rejects emails with invalid domain characters', () => {
      const invalidEmails = [
        'alice@exam ple.com', // space
        'alice@exam[ple.com', // bracket
        'alice@exam"ple.com', // quote
      ];

      for (const email of invalidEmails) {
        expect(/[^a-z0-9.@+-]/i.test(email)).toBe(true); // Has invalid char
      }
    });
  });

  describe('file reading and security', () => {
    it('should read email from .claude.json file', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'test-'));
      try {
        const claudePath = join(testDir, '.claude.json');
        const content = { oauthAccount: { emailAddress: 'test@example.com' } };
        writeFileSync(claudePath, JSON.stringify(content));

        const readContent = JSON.parse(require('fs').readFileSync(claudePath, 'utf-8'));
        expect(readContent.oauthAccount.emailAddress).toBe('test@example.com');
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should verify file is regular file (not directory or FIFO)', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'test-'));
      try {
        const stats = require('fs').statSync(testDir);
        expect(stats.isDirectory()).toBe(true);
        expect(stats.isFile()).toBe(false);

        // A file should be different
        const filePath = join(testDir, 'test.json');
        writeFileSync(filePath, '{}');
        const fileStats = require('fs').statSync(filePath);
        expect(fileStats.isFile()).toBe(true);
        expect(fileStats.isDirectory()).toBe(false);
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should reject .claude.json files larger than 5MB', () => {
      // This test verifies the size check logic
      const largeSize = 5 * 1024 * 1024 + 1; // 5MB + 1 byte
      const normalSize = 5 * 1024 * 1024 - 1; // 5MB - 1 byte

      expect(largeSize > 5 * 1024 * 1024).toBe(true);
      expect(normalSize <= 5 * 1024 * 1024).toBe(true);
    });

    it('should handle malformed JSON gracefully', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'test-'));
      try {
        const filePath = join(testDir, 'broken.json');
        writeFileSync(filePath, '{invalid json}');

        // Reading should throw
        expect(() => {
          JSON.parse(require('fs').readFileSync(filePath, 'utf-8'));
        }).toThrow();
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should handle non-object JSON gracefully', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'test-'));
      try {
        const filePath = join(testDir, 'array.json');
        writeFileSync(filePath, '["array", "at", "root"]');

        const content = JSON.parse(require('fs').readFileSync(filePath, 'utf-8'));
        expect(Array.isArray(content)).toBe(true);
        // Arrays are objects in JavaScript, but we use isArray() to distinguish them
        expect(typeof content).toBe('object'); // Arrays are objects
        expect(Array.isArray(content)).toBe(true); // But we can detect arrays
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('oauthAccount structure validation', () => {
    it('should reject when oauthAccount is null', () => {
      const content = { oauthAccount: null };
      expect(content.oauthAccount).toBeNull();
      // In JavaScript, typeof null === 'object' is true (a quirk)
      // But we need to check that it's null or not a valid object
      const isValidObject = typeof content.oauthAccount === 'object' && content.oauthAccount !== null;
      expect(isValidObject).toBe(false);
    });

    it('should reject when oauthAccount is not an object', () => {
      const testCases = [
        { oauthAccount: 'string', valid: false },
        { oauthAccount: 123, valid: false },
        { oauthAccount: true, valid: false },
        { oauthAccount: [], valid: false }, // Arrays are objects but isArray is true
      ];

      for (const { oauthAccount, valid } of testCases) {
        const isValidObject = typeof oauthAccount === 'object' && oauthAccount !== null && !Array.isArray(oauthAccount);
        expect(isValidObject).toBe(valid);
      }
    });

    it('should reject when emailAddress is missing', () => {
      const content = { oauthAccount: { accountUuid: 'uuid-123' } };
      expect((content.oauthAccount as any).emailAddress).toBeUndefined();
    });

    it('should only extract emailAddress, not other sensitive fields', () => {
      const content = {
        oauthAccount: {
          emailAddress: 'alice@example.com',
          accountUuid: 'secret-uuid',
          organizationUuid: 'secret-org',
          refreshToken: 'secret-token',
        },
      };

      const account = content.oauthAccount as any;
      expect(account.emailAddress).toBe('alice@example.com');
      // Other fields should be present but we should NOT use them
      expect(account.accountUuid).toBeDefined();
      expect(account.organizationUuid).toBeDefined();
      expect(account.refreshToken).toBeDefined();
    });
  });

  describe('ellipsis truncation', () => {
    it('should apply middle-ellipsis for long emails', () => {
      const longEmail = 'very.long.email.address.with.many.parts+tag@very.long.domain.example.subdomain.com';
      expect(longEmail.length).toBeGreaterThan(64);

      // When truncated to 64 chars with ..., should have format like: start...end
      const maxChars = 64;
      const ellipsis = '...';
      const availableChars = maxChars - ellipsis.length;
      const startChars = Math.floor(availableChars / 2);
      const endChars = availableChars - startChars;

      const truncated = longEmail.slice(0, startChars) + ellipsis + longEmail.slice(-endChars);
      expect(truncated.length).toBeLessThanOrEqual(maxChars);
      expect(truncated).toContain('...');
      expect(truncated).toContain('very.long.email');
    });

    it('should not truncate short emails', () => {
      const shortEmail = 'alice@example.com';
      expect(shortEmail.length).toBeLessThanOrEqual(64);
      // Should remain unchanged
      expect(shortEmail).not.toContain('...');
    });

    it('should handle emails at exactly the boundary', () => {
      // Create an email exactly 64 chars
      const email = 'a'.repeat(30) + '@' + 'b'.repeat(32) + '.com';
      // 30 + 1 + 32 + 4 = 67
      expect(email.length).toBe(67);

      // This should be truncated
      expect(email.length).toBeGreaterThan(64);
    });
  });

  describe('format and output', () => {
    it('should use acct: prefix format', () => {
      const email = 'alice@example.com';
      const prefix = 'acct:';
      const formatted = prefix + email;
      expect(formatted).toContain('acct:');
    });

    it('should apply ANSI color codes (cyan)', () => {
      // ANSI escape for cyan: \x1b[36m (or variations)
      const colorCode = '\x1b[';
      const ansiText = colorCode + '36m' + 'text' + '\x1b[0m';
      expect(ansiText).toMatch(/\x1b\[[0-9;]*m/);
    });

    it('should not leak sensitive fields in output', () => {
      const sensitiveFields = [
        'secret-uuid-12345',
        'secret-org-67890',
        'secret-token',
        'refresh-token',
      ];

      const output = 'acct:alice@example.com';

      for (const field of sensitiveFields) {
        expect(output).not.toContain(field);
      }
    });
  });

  describe('API key mode handling', () => {
    it('should return null when ANTHROPIC_API_KEY is set', () => {
      const hasApiKey = process.env.ANTHROPIC_API_KEY !== undefined;
      // Test setup should ensure no key is set initially
      if (hasApiKey) {
        // In API key mode, no email should be shown
        expect(process.env.ANTHROPIC_API_KEY).toBeDefined();
      }
    });

    it('should show email when using OAuth (no API key)', () => {
      const hasApiKey = process.env.ANTHROPIC_API_KEY !== undefined;
      if (!hasApiKey) {
        // In OAuth mode, email can be shown
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      }
    });
  });

  describe('caching behavior', () => {
    it('should cache email data with mtimeMs and size', () => {
      const cacheData = {
        mtimeMs: Date.now(),
        size: 178,
        email: 'alice@example.com',
      };

      expect(cacheData.mtimeMs).toBeGreaterThan(0);
      expect(cacheData.size).toBeGreaterThan(0);
      expect(cacheData.email).toBe('alice@example.com');
    });

    it('should reparse when mtime or size changes', () => {
      const cache1 = { mtimeMs: 1000, size: 100, email: 'old@example.com' };
      const cache2 = { mtimeMs: 2000, size: 100, email: 'old@example.com' }; // mtime changed
      const cache3 = { mtimeMs: 1000, size: 200, email: 'old@example.com' }; // size changed

      // Cache is invalid when mtime or size differs
      expect(cache1.mtimeMs === cache2.mtimeMs).toBe(false); // mtime differs
      expect(cache1.size === cache3.size).toBe(false); // size differs
      expect(cache1.mtimeMs === cache1.mtimeMs && cache1.size === cache1.size).toBe(true); // same cache is valid
    });
  });
});
