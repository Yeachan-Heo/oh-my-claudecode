import { describe, test, expect } from 'vitest';
import {
  generateHook,
  buildVariant,
  BASE_AVOID,
  CATEGORY_FORMATS,
} from '../positioning.js';
import type { PositionFormat, NeedsCategory, ProductMatch } from '../types.js';

// --- generateHook ---
describe('generateHook', () => {
  const baseCtx = {
    productName: '마그네슘 글리시네이트 고함량',
    needCategory: '불편해소' as NeedsCategory,
    problem: '현재 겪는 고통 제거',
  };

  test('generates non-empty hook for all 6 formats', () => {
    const formats: PositionFormat[] = ['문제공감형', '솔직후기형', '비교형', '입문추천형', '실수방지형', '비추천형'];
    for (const format of formats) {
      const hook = generateHook({ ...baseCtx, format });
      expect(hook).toBeTruthy();
      expect(hook.length).toBeGreaterThan(5);
    }
  });

  test('is deterministic (same input → same output)', () => {
    const hook1 = generateHook({ ...baseCtx, format: '문제공감형' });
    const hook2 = generateHook({ ...baseCtx, format: '문제공감형' });
    expect(hook1).toBe(hook2);
  });

  test('문제공감형 includes problem context', () => {
    const hook = generateHook({ ...baseCtx, format: '문제공감형' });
    // Should reference the problem or be empathy-based
    expect(hook).toMatch(/나만|스트레스|찾았음/);
  });

  test('솔직후기형 includes product reference', () => {
    const hook = generateHook({ ...baseCtx, format: '솔직후기형' });
    // Should reference product name (short form) or "써본"/"후기"
    expect(hook).toMatch(/후기|써보고|돈 주고/);
  });

  test('비교형 includes comparison language', () => {
    const hook = generateHook({ ...baseCtx, format: '비교형' });
    expect(hook).toMatch(/써봤는데|vs|남김|결론/);
  });

  test('handles short product name gracefully', () => {
    const hook = generateHook({
      format: '솔직후기형',
      productName: '수면앱',
      needCategory: '불편해소',
      problem: 'test',
    });
    expect(hook).toBeTruthy();
    expect(hook.length).toBeGreaterThan(5);
  });
});

// --- buildVariant ---
describe('buildVariant', () => {
  const makeProduct = (): ProductMatch => ({
    product_id: 'test_001',
    name: '장건강 유산균 프로바이오틱스',
    affiliate_platform: 'coupang_partners',
    price_range: '18000~35000',
    threads_score: {
      naturalness: 4, clarity: 4, ad_smell: 3, repeatability: 3, story_potential: 4, total: 3.6,
    },
    competition: '중',
    priority: 1,
    why: 'test',
  });

  test('returns valid PositionVariant shape', () => {
    const variant = buildVariant('문제공감형', makeProduct(), '외모건강', '건강 관리');
    expect(variant).toHaveProperty('format', '문제공감형');
    expect(variant).toHaveProperty('angle');
    expect(variant).toHaveProperty('tone');
    expect(variant).toHaveProperty('hook');
    expect(variant).toHaveProperty('avoid');
    expect(variant).toHaveProperty('cta_style');
  });

  test('avoid always includes BASE_AVOID items', () => {
    const formats: PositionFormat[] = ['문제공감형', '솔직후기형', '비교형', '입문추천형', '실수방지형', '비추천형'];
    for (const fmt of formats) {
      const variant = buildVariant(fmt, makeProduct(), '불편해소', 'test');
      for (const item of BASE_AVOID) {
        expect(variant.avoid).toContain(item);
      }
    }
  });

  test('비추천형 adds extra avoid items', () => {
    const variant = buildVariant('비추천형', makeProduct(), '외모건강', 'test');
    expect(variant.avoid.length).toBeGreaterThan(BASE_AVOID.length);
  });

  test('솔직후기형 adds extra avoid items', () => {
    const variant = buildVariant('솔직후기형', makeProduct(), '외모건강', 'test');
    expect(variant.avoid).toContain('완벽한');
    expect(variant.avoid).toContain('강력 추천');
  });

  test('hook is non-empty string', () => {
    const variant = buildVariant('입문추천형', makeProduct(), '성과향상', 'test');
    expect(typeof variant.hook).toBe('string');
    expect(variant.hook.length).toBeGreaterThan(0);
  });
});

// --- CATEGORY_FORMATS ---
describe('CATEGORY_FORMATS', () => {
  test('every NeedsCategory has exactly 3 formats', () => {
    const categories: NeedsCategory[] = ['불편해소', '시간절약', '돈절약', '성과향상', '외모건강', '자기표현'];
    for (const cat of categories) {
      expect(CATEGORY_FORMATS[cat]).toHaveLength(3);
    }
  });

  test('all format values are valid PositionFormat', () => {
    const validFormats = new Set(['문제공감형', '솔직후기형', '비교형', '입문추천형', '실수방지형', '비추천형']);
    for (const formats of Object.values(CATEGORY_FORMATS)) {
      for (const fmt of formats) {
        expect(validFormats.has(fmt)).toBe(true);
      }
    }
  });
});

// --- BASE_AVOID ---
describe('BASE_AVOID', () => {
  test('contains required ad-smell terms', () => {
    expect(BASE_AVOID).toContain('협찬');
    expect(BASE_AVOID).toContain('광고');
    expect(BASE_AVOID).toContain('꼭 사세요');
  });
});
