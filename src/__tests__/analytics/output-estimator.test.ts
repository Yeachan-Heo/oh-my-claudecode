import { describe, it, expect } from 'vitest';
import { estimateOutputTokens, extractSessionId } from '../../analytics/output-estimator.js';

describe('OutputEstimator', () => {
  describe('estimateOutputTokens', () => {
    it('should estimate Haiku output tokens (30% ratio)', () => {
      const estimate = estimateOutputTokens(1000, 'claude-haiku-4-5-20251001');
      expect(estimate).toBe(300); // 1000 * 0.30
    });

    it('should estimate Sonnet output tokens (40% ratio)', () => {
      const estimate = estimateOutputTokens(1000, 'claude-sonnet-4-5-20250929');
      expect(estimate).toBe(400); // 1000 * 0.40
    });

    it('should estimate Opus output tokens (50% ratio)', () => {
      const estimate = estimateOutputTokens(1000, 'claude-opus-4-6-20260205');
      expect(estimate).toBe(500); // 1000 * 0.50
    });

    it('should use default ratio for unknown models', () => {
      const estimate = estimateOutputTokens(1000, 'claude-unknown-model');
      expect(estimate).toBe(400); // Default to Sonnet 40%
    });

    it('should handle zero input tokens', () => {
      const estimate = estimateOutputTokens(0, 'claude-sonnet-4-5-20250929');
      expect(estimate).toBe(0);
    });

    it('should round to nearest integer', () => {
      // 1000 * 0.30 = 300 (exact)
      expect(estimateOutputTokens(1000, 'claude-haiku-4-5-20251001')).toBe(300);

      // 1001 * 0.30 = 300.3 -> rounds to 300
      expect(estimateOutputTokens(1001, 'claude-haiku-4-5-20251001')).toBe(300);

      // 1005 * 0.30 = 301.5 -> rounds to 302
      expect(estimateOutputTokens(1005, 'claude-haiku-4-5-20251001')).toBe(302);
    });

    it('should be case-insensitive for model names', () => {
      expect(estimateOutputTokens(1000, 'CLAUDE-HAIKU-4-5-20251001')).toBe(300);
      expect(estimateOutputTokens(1000, 'Claude-Sonnet-4-5-20250929')).toBe(400);
      expect(estimateOutputTokens(1000, 'claude-OPUS-4-6-20260205')).toBe(500);
    });

    it('should handle various model name formats', () => {
      // Different date formats
      expect(estimateOutputTokens(1000, 'claude-haiku-4')).toBe(300);
      expect(estimateOutputTokens(1000, 'claude-sonnet-4.5')).toBe(400);
      expect(estimateOutputTokens(1000, 'claude-opus-4')).toBe(500);
    });

    it('should handle large token counts', () => {
      const estimate = estimateOutputTokens(1_000_000, 'claude-sonnet-4-5-20250929');
      expect(estimate).toBe(400_000); // 1,000,000 * 0.40
    });

    it('should handle fractional results', () => {
      // 333 * 0.40 = 133.2 -> rounds to 133
      const estimate = estimateOutputTokens(333, 'claude-sonnet-4-5-20250929');
      expect(estimate).toBe(133);
    });
  });

  describe('extractSessionId', () => {
    it('should extract session ID from standard path', () => {
      const path = '/home/user/.claude/projects/abcdef123456/transcript.jsonl';
      const sessionId = extractSessionId(path);
      expect(sessionId).toBe('abcdef123456');
    });

    it('should extract longer session IDs', () => {
      const path = '/home/user/.claude/projects/a1b2c3d4e5f6abcd/transcript.jsonl';
      const sessionId = extractSessionId(path);
      expect(sessionId).toBe('a1b2c3d4e5f6abcd');
    });

    it('should handle uppercase session IDs', () => {
      const path = '/home/user/.claude/projects/ABCDEF123456/transcript.jsonl';
      const sessionId = extractSessionId(path);
      expect(sessionId).toBe('ABCDEF123456');
    });

    it('should handle mixed case session IDs', () => {
      const path = '/home/user/.claude/projects/AbCdEf123456/transcript.jsonl';
      const sessionId = extractSessionId(path);
      expect(sessionId).toBe('AbCdEf123456');
    });

    it('should fallback to hash for non-standard paths', () => {
      const path = '/some/random/path/transcript.jsonl';
      const sessionId = extractSessionId(path);

      // Should be 16-char hex hash
      expect(sessionId).toMatch(/^[a-f0-9]{16}$/i);
    });

    it('should be consistent for same non-standard path', () => {
      const path = '/some/random/path/transcript.jsonl';
      const sessionId1 = extractSessionId(path);
      const sessionId2 = extractSessionId(path);

      expect(sessionId1).toBe(sessionId2);
    });

    it('should produce different hashes for different paths', () => {
      const path1 = '/path/one/transcript.jsonl';
      const path2 = '/path/two/transcript.jsonl';

      const hash1 = extractSessionId(path1);
      const hash2 = extractSessionId(path2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle very long paths', () => {
      const longPath = '/very/long/path/with/many/.claude/projects/a1b2c3d4e5f6abcd/and/more/directories/transcript.jsonl';
      const sessionId = extractSessionId(longPath);

      expect(sessionId).toBe('a1b2c3d4e5f6abcd');
    });

    it('should match first projects/ pattern', () => {
      const path = '/home/.claude/projects/a1b2c3d412345678/other/projects/a1b2c3d487654321/transcript.jsonl';
      const sessionId = extractSessionId(path);

      expect(sessionId).toBe('a1b2c3d412345678');
    });

    it('should handle null input gracefully', () => {
      const sessionId = extractSessionId(null as any);

      // Should return a valid 16-char hex hash (not throw)
      expect(sessionId).toMatch(/^[a-f0-9]{16}$/i);
      expect(sessionId).toBe('ad921d6048636625'); // MD5 of 'unknown'
    });

    it('should handle undefined input gracefully', () => {
      const sessionId = extractSessionId(undefined as any);

      // Should return a valid 16-char hex hash (not throw)
      expect(sessionId).toMatch(/^[a-f0-9]{16}$/i);
      expect(sessionId).toBe('ad921d6048636625'); // MD5 of 'unknown'
    });

    it('should handle empty string', () => {
      const sessionId = extractSessionId('');

      // Should return a valid 16-char hex hash (not throw)
      expect(sessionId).toMatch(/^[a-f0-9]{16}$/i);
      expect(sessionId).toBe('ad921d6048636625'); // MD5 of 'unknown'
    });
  });
});
