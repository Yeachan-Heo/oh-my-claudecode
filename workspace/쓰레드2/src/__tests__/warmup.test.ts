/**
 * @file Warmup unit tests — generateWarmupContent pure function.
 * No DB calls. Tests template-based content generation behavior only.
 */

import { describe, it, expect } from 'vitest';
import { generateWarmupContent } from '../publisher/warmup.js';

describe('generateWarmupContent', () => {
  it('returns a non-empty string', () => {
    const content = generateWarmupContent();
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
  });

  it('does not contain affiliate link patterns', () => {
    // Warmup content must not include affiliate-related URLs or keywords
    for (let i = 0; i < 30; i++) {
      const content = generateWarmupContent();
      expect(content).not.toMatch(/https?:\/\//);
      expect(content).not.toMatch(/쿠팡|네이버|제휴|affiliate/i);
    }
  });

  it('produces varied content across multiple calls', () => {
    const results = new Set(Array.from({ length: 20 }, () => generateWarmupContent()));
    // With 15 templates * 6 prefixes * 5 suffixes = 450 combinations,
    // 20 samples should produce at least 2 distinct results
    expect(results.size).toBeGreaterThan(1);
  });

  it('content is reasonable length (between 10 and 500 characters)', () => {
    for (let i = 0; i < 20; i++) {
      const content = generateWarmupContent();
      expect(content.length).toBeGreaterThanOrEqual(10);
      expect(content.length).toBeLessThanOrEqual(500);
    }
  });
});
