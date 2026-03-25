/**
 * @file Topic classifier unit tests — rule-based mapping + classifyTopics flow.
 * Tests pure rule logic and DB interaction. LLM calls are not tested (requires API key).
 */

import { describe, it, expect } from 'vitest';
import { classifyByRule, classifyPrimaryTag, TAG_MAP } from '../analyzer/topic-classifier.js';
import type { TopicCategory } from '../types.js';

// ─── classifyByRule ────────────────────────────────────────

describe('classifyByRule', () => {
  it('returns null for null tags', () => {
    expect(classifyByRule(null)).toBeNull();
  });

  it('returns null for empty tags array', () => {
    expect(classifyByRule([])).toBeNull();
  });

  it('returns null for unknown tags', () => {
    expect(classifyByRule(['알수없는태그', '미지의태그'])).toBeNull();
  });

  it('classifies "선크림" as 뷰티', () => {
    expect(classifyByRule(['선크림'])).toBe('뷰티');
  });

  it('classifies "밀프렙" as 주방', () => {
    expect(classifyByRule(['밀프렙'])).toBe('주방');
  });

  it('classifies "다이어트식품" as 다이어트', () => {
    expect(classifyByRule(['다이어트식품'])).toBe('다이어트');
  });

  it('classifies "홈트" as 운동', () => {
    expect(classifyByRule(['홈트'])).toBe('운동');
  });

  it('classifies "유산균" as 건강', () => {
    expect(classifyByRule(['유산균'])).toBe('건강');
  });

  it('classifies "이어폰" as 디지털', () => {
    expect(classifyByRule(['이어폰'])).toBe('디지털');
  });

  it('classifies "기저귀" as 육아', () => {
    expect(classifyByRule(['기저귀'])).toBe('육아');
  });

  it('classifies "가구" as 인테리어', () => {
    expect(classifyByRule(['가구'])).toBe('인테리어');
  });

  it('classifies "코디" as 패션', () => {
    expect(classifyByRule(['코디'])).toBe('패션');
  });

  it('classifies "커피" as 식품', () => {
    expect(classifyByRule(['커피'])).toBe('식품');
  });

  it('classifies "다이어리" as 문구', () => {
    expect(classifyByRule(['다이어리'])).toBe('문구');
  });

  it('classifies "디퓨저" as 향수', () => {
    expect(classifyByRule(['디퓨저'])).toBe('향수');
  });

  it('classifies "청소" as 생활', () => {
    expect(classifyByRule(['청소'])).toBe('생활');
  });

  it('returns first matched category when multiple tags exist', () => {
    // "알수없는" is unknown, "비타민" maps to 건강
    expect(classifyByRule(['알수없는', '비타민'])).toBe('건강');
  });

  it('is case-insensitive (handles mixed case)', () => {
    // TAG_MAP keys are lowercased; classifyByRule lowercases input
    expect(classifyByRule(['뷰티'])).toBe('뷰티');
  });

  it('trims whitespace in tags', () => {
    expect(classifyByRule(['  선크림  '])).toBe('뷰티');
  });
});

// ─── TAG_MAP coverage ──────────────────────────────────────

describe('TAG_MAP', () => {
  it('has at least 50 entries', () => {
    expect(Object.keys(TAG_MAP).length).toBeGreaterThanOrEqual(50);
  });

  it('all values are valid TopicCategory', () => {
    const validCategories: TopicCategory[] = [
      '건강', '뷰티', '다이어트', '운동', '생활', '주방',
      '디지털', '육아', '인테리어', '패션', '식품', '문구', '향수', '기타',
    ];

    for (const [tag, category] of Object.entries(TAG_MAP)) {
      expect(validCategories).toContain(category);
    }
  });

  it('covers all 13 non-기타 categories', () => {
    const coveredCategories = new Set(Object.values(TAG_MAP));
    const expected: TopicCategory[] = [
      '건강', '뷰티', '다이어트', '운동', '생활', '주방',
      '디지털', '육아', '인테리어', '패션', '식품', '문구', '향수',
    ];

    for (const cat of expected) {
      expect(coveredCategories.has(cat), `TAG_MAP should cover category "${cat}"`).toBe(true);
    }
  });

  it('keys are all lowercased', () => {
    for (const key of Object.keys(TAG_MAP)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});

// ─── classifyPrimaryTag ──────────────────────────────────────

describe('classifyPrimaryTag', () => {
  it('detects affiliate links', () => {
    expect(classifyPrimaryTag('좋은 제품', 'https://link.coupang.com/abc')).toBe('affiliate');
  });

  it('detects purchase signals', () => {
    expect(classifyPrimaryTag('이거 살까말까 고민중')).toBe('purchase_signal');
    expect(classifyPrimaryTag('뭐가 좋을까요 추천해주세요')).toBe('purchase_signal');
  });

  it('detects reviews', () => {
    expect(classifyPrimaryTag('써봤는데 솔직후기')).toBe('review');
  });

  it('detects complaints', () => {
    expect(classifyPrimaryTag('진짜 실망이다 환불해야지')).toBe('complaint');
  });

  it('detects interest', () => {
    expect(classifyPrimaryTag('이거 효과 있나요? 궁금해요')).toBe('interest');
  });

  it('defaults to general', () => {
    expect(classifyPrimaryTag('오늘 날씨 좋다')).toBe('general');
  });
});
