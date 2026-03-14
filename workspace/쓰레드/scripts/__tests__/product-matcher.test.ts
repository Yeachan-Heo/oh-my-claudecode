import { describe, test, expect } from 'vitest';
import {
  clamp,
  round1,
  parsePriceMin,
  assessCompetition,
  countKeywordMatches,
  scoreThreadsFitness,
} from '../product-matcher.js';
import type { NeedItem, ProductEntry } from '../types.js';

// --- clamp ---
describe('clamp', () => {
  test('returns value when within range', () => {
    expect(clamp(3, 1, 5)).toBe(3);
  });

  test('clamps to min when below', () => {
    expect(clamp(0, 1, 5)).toBe(1);
    expect(clamp(-10, 1, 5)).toBe(1);
  });

  test('clamps to max when above', () => {
    expect(clamp(6, 1, 5)).toBe(5);
    expect(clamp(100, 1, 5)).toBe(5);
  });

  test('handles boundary values', () => {
    expect(clamp(1, 1, 5)).toBe(1);
    expect(clamp(5, 1, 5)).toBe(5);
  });
});

// --- round1 ---
describe('round1', () => {
  test('rounds to 1 decimal place', () => {
    expect(round1(3.14159)).toBe(3.1);
    expect(round1(3.15)).toBe(3.2);
    expect(round1(3.0)).toBe(3.0);
  });

  test('handles negative numbers', () => {
    expect(round1(-2.76)).toBe(-2.8);
  });

  test('handles zero', () => {
    expect(round1(0)).toBe(0);
  });
});

// --- parsePriceMin ---
describe('parsePriceMin', () => {
  test('parses range format "15000~28000"', () => {
    expect(parsePriceMin('15000~28000')).toBe(15000);
  });

  test('parses single number', () => {
    expect(parsePriceMin('30000')).toBe(30000);
  });

  test('parses range with hyphen "15000-29000"', () => {
    expect(parsePriceMin('15000-29000')).toBe(15000);
  });

  test('returns null for empty string', () => {
    expect(parsePriceMin('')).toBeNull();
  });

  test('returns null for non-numeric string', () => {
    expect(parsePriceMin('free')).toBeNull();
  });

  test('returns null for undefined-like input', () => {
    expect(parsePriceMin(undefined as unknown as string)).toBeNull();
  });
});

// --- assessCompetition ---
describe('assessCompetition', () => {
  test('returns 하 for 0-2 candidates', () => {
    expect(assessCompetition(0)).toBe('하');
    expect(assessCompetition(1)).toBe('하');
    expect(assessCompetition(2)).toBe('하');
  });

  test('returns 중 for 3-5 candidates', () => {
    expect(assessCompetition(3)).toBe('중');
    expect(assessCompetition(5)).toBe('중');
  });

  test('returns 상 for 6+ candidates', () => {
    expect(assessCompetition(6)).toBe('상');
    expect(assessCompetition(100)).toBe('상');
  });
});

// --- countKeywordMatches ---
describe('countKeywordMatches', () => {
  const makeProduct = (keywords: string[]): ProductEntry => ({
    product_id: 'test',
    name: 'test',
    category: 'test',
    needs_categories: ['불편해소'],
    keywords,
    affiliate_platform: 'coupang_partners',
    price_range: '10000~20000',
    description: 'test',
  });

  test('returns 0 for no matches', () => {
    const product = makeProduct(['수면', '영양제']);
    const expressions = ['운동 효과가 좋다', '다이어트 성공'];
    expect(countKeywordMatches(product, expressions)).toBe(0);
  });

  test('counts matching keywords', () => {
    const product = makeProduct(['수면', '잠', '불면']);
    const expressions = ['잠이 잘 안 와서 힘들다', '수면 질이 떨어졌다'];
    expect(countKeywordMatches(product, expressions)).toBeGreaterThan(0);
  });

  test('returns 0 for empty keywords', () => {
    const product = makeProduct([]);
    const expressions = ['아무거나'];
    expect(countKeywordMatches(product, expressions)).toBe(0);
  });

  test('returns 0 for empty expressions', () => {
    const product = makeProduct(['수면']);
    expect(countKeywordMatches(product, [])).toBe(0);
  });

  test('does not false-positive on short expr prefix', () => {
    const product = makeProduct(['영양']);
    const expressions = ['수면이 안 와서 힘들다'];
    expect(countKeywordMatches(product, expressions)).toBe(0);
  });

  test('matches keyword contained in expression', () => {
    const product = makeProduct(['수면']);
    const expressions = ['수면이 안 와서 힘들다'];
    expect(countKeywordMatches(product, expressions)).toBe(1);
  });
});

// --- scoreThreadsFitness ---
describe('scoreThreadsFitness', () => {
  const makeNeed = (overrides: Partial<NeedItem> = {}): NeedItem => ({
    need_id: 'test',
    category: '불편해소',
    problem: 'test problem',
    representative_expressions: [],
    signal_strength: 'L3',
    post_count: 5,
    purchase_linkage: '상',
    why_linkage: 'test',
    product_categories: [],
    threads_fit: 4,
    threads_fit_reason: 'test',
    ...overrides,
  });

  const makeProduct = (overrides: Partial<ProductEntry> = {}): ProductEntry => ({
    product_id: 'test',
    name: 'test product',
    category: 'test',
    needs_categories: ['불편해소'],
    keywords: [],
    affiliate_platform: 'coupang_partners',
    price_range: '15000~25000',
    description: 'test',
    ...overrides,
  });

  test('returns score with all 5 dimensions', () => {
    const score = scoreThreadsFitness(makeProduct(), makeNeed(), 0, []);
    expect(score).toHaveProperty('naturalness');
    expect(score).toHaveProperty('clarity');
    expect(score).toHaveProperty('ad_smell');
    expect(score).toHaveProperty('repeatability');
    expect(score).toHaveProperty('story_potential');
    expect(score).toHaveProperty('total');
  });

  test('all scores are between 1 and 5', () => {
    const score = scoreThreadsFitness(makeProduct(), makeNeed(), 0, []);
    expect(score.naturalness).toBeGreaterThanOrEqual(1);
    expect(score.naturalness).toBeLessThanOrEqual(5);
    expect(score.clarity).toBeGreaterThanOrEqual(1);
    expect(score.clarity).toBeLessThanOrEqual(5);
    expect(score.total).toBeGreaterThanOrEqual(1);
    expect(score.total).toBeLessThanOrEqual(5);
  });

  test('low price (<30000) increases naturalness', () => {
    const cheap = scoreThreadsFitness(makeProduct({ price_range: '10000~20000' }), makeNeed(), 0, []);
    const expensive = scoreThreadsFitness(makeProduct({ price_range: '50000~80000' }), makeNeed(), 0, []);
    expect(cheap.naturalness).toBeGreaterThan(expensive.naturalness);
  });

  test('strong signal (L3+) increases clarity', () => {
    const strong = scoreThreadsFitness(makeProduct(), makeNeed({ signal_strength: 'L4' }), 0, []);
    const weak = scoreThreadsFitness(makeProduct(), makeNeed({ signal_strength: 'L1' }), 0, []);
    expect(strong.clarity).toBeGreaterThan(weak.clarity);
  });

  test('product with 외모건강/불편해소 needs_categories gets higher story_potential', () => {
    const healthProduct = makeProduct({ needs_categories: ['외모건강'] });
    const otherProduct = makeProduct({ needs_categories: ['돈절약'] });
    const need = makeNeed();
    const health = scoreThreadsFitness(healthProduct, need, 0, []);
    const other = scoreThreadsFitness(otherProduct, need, 0, []);
    expect(health.story_potential).toBeGreaterThan(other.story_potential);
  });

  test('keyword matches increase repeatability', () => {
    const withMatch = scoreThreadsFitness(
      makeProduct({ keywords: ['수면', '잠'] }),
      makeNeed({ representative_expressions: ['잠이 안 와'] }),
      2, // keywordMatches
      []
    );
    const noMatch = scoreThreadsFitness(makeProduct(), makeNeed(), 0, []);
    expect(withMatch.repeatability).toBeGreaterThan(noMatch.repeatability);
  });

  test('total is weighted average within bounds', () => {
    const score = scoreThreadsFitness(makeProduct(), makeNeed(), 0, []);
    // weights: naturalness:0.25, clarity:0.2, ad_smell:0.25, repeatability:0.15, story_potential:0.15
    const expectedTotal = round1(
      score.naturalness * 0.25 +
      score.clarity * 0.2 +
      score.ad_smell * 0.25 +
      score.repeatability * 0.15 +
      score.story_potential * 0.15
    );
    expect(score.total).toBe(expectedTotal);
  });

  test('null signal_strength does not crash', () => {
    expect(() =>
      scoreThreadsFitness(makeProduct(), makeNeed({ signal_strength: null }), 0, [])
    ).not.toThrow();
  });
});
