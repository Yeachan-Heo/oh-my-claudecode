/**
 * @file Utils unit tests — timing and ID generation.
 * No external dependencies. Pure function behavior verification.
 */

import { describe, it, expect } from 'vitest';
import { gaussRandom, gaussianDelay } from '../utils/timing.js';
import { generateId } from '../utils/id.js';

// ─── gaussRandom ──────────────────────────────────────────

describe('gaussRandom', () => {
  it('returns a number', () => {
    const result = gaussRandom(0, 100);
    expect(typeof result).toBe('number');
  });

  it('returns integer values', () => {
    for (let i = 0; i < 20; i++) {
      const result = gaussRandom(10, 50);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it('returns value within [min, max] range', () => {
    for (let i = 0; i < 100; i++) {
      const result = gaussRandom(5, 20);
      expect(result).toBeGreaterThanOrEqual(5);
      expect(result).toBeLessThanOrEqual(20);
    }
  });

  it('returns min when min equals max', () => {
    const result = gaussRandom(42, 42);
    expect(result).toBe(42);
  });

  it('produces values centered around mean over many samples', () => {
    const min = 0;
    const max = 100;
    const mean = (min + max) / 2;
    const samples = Array.from({ length: 200 }, () => gaussRandom(min, max));
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    // Mean should be within ±15 of 50 with high probability
    expect(avg).toBeGreaterThan(mean - 15);
    expect(avg).toBeLessThan(mean + 15);
  });
});

// ─── gaussianDelay ───────────────────────────────────────

describe('gaussianDelay', () => {
  it('returns a non-negative number', () => {
    for (let i = 0; i < 50; i++) {
      const result = gaussianDelay(1000, 200);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns an integer', () => {
    const result = gaussianDelay(500, 100);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('clamps negative values to 0 when mean is very low and stddev is high', () => {
    // mean=0, stddev=1000 — some results will be negative, must be clamped to 0
    for (let i = 0; i < 50; i++) {
      const result = gaussianDelay(0, 1000);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── generateId ──────────────────────────────────────────

describe('generateId', () => {
  it('returns a string', () => {
    expect(typeof generateId('test')).toBe('string');
  });

  it('starts with the given prefix followed by hyphen', () => {
    const id = generateId('post');
    expect(id.startsWith('post-')).toBe(true);
  });

  it('contains a UUID segment after the prefix', () => {
    const id = generateId('lc');
    const uuidPart = id.slice('lc-'.length);
    // UUID v4 pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(uuidRegex.test(uuidPart)).toBe(true);
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId('x')));
    expect(ids.size).toBe(50);
  });

  it('preserves the exact prefix string', () => {
    const prefix = 'diag';
    const id = generateId(prefix);
    expect(id.startsWith(`${prefix}-`)).toBe(true);
  });
});
