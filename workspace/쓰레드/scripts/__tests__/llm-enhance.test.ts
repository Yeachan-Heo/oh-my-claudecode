import { describe, test, expect } from 'vitest';
import { validateLLMProductOutput, validateLLMPositioningOutput } from '../llm-enhance.js';

describe('validateLLMProductOutput', () => {
  test('accepts valid LLM product output', () => {
    const valid = {
      improved_matches: [{
        need_id: 'test',
        recommended_products: [{
          product_id: 'x',
          adjusted_scores: { naturalness: 4, clarity: 4, ad_smell: 4, repeatability: 3, story_potential: 4 },
          content_angle: 'test angle',
          why_threads_fit: 'test reason',
        }],
      }],
      overall_strategy: 'test strategy',
    };
    expect(() => validateLLMProductOutput(valid)).not.toThrow();
  });

  test('throws for missing improved_matches', () => {
    expect(() => validateLLMProductOutput({})).toThrow(/improved_matches/);
  });

  test('clamps scores to 1-5', () => {
    const data = {
      improved_matches: [{
        need_id: 'test',
        recommended_products: [{
          product_id: 'x',
          adjusted_scores: { naturalness: 10, clarity: 0, ad_smell: 3, repeatability: 3, story_potential: 3 },
          content_angle: 'a', why_threads_fit: 'b',
        }],
      }],
      overall_strategy: 's',
    };
    const result = validateLLMProductOutput(data);
    expect(result.improved_matches[0].recommended_products[0].adjusted_scores.naturalness).toBe(5);
    expect(result.improved_matches[0].recommended_products[0].adjusted_scores.clarity).toBe(1);
  });
});

describe('validateLLMPositioningOutput', () => {
  test('accepts valid LLM positioning output', () => {
    const valid = {
      positioning_cards: [{
        product_id: 'x',
        product_name: 'y',
        need_id: 'z',
        positions: [{ format: '문제공감형', angle: 'a', tone: 't', hook: 'h', avoid: ['x'], cta_style: 'c' }],
      }],
    };
    expect(() => validateLLMPositioningOutput(valid)).not.toThrow();
  });

  test('throws for missing positioning_cards', () => {
    expect(() => validateLLMPositioningOutput({})).toThrow(/positioning_cards/);
  });
});
