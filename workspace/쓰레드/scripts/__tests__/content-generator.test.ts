import { describe, test, expect } from 'vitest';
import { generatePostBody, generateHookVariants, generateSelfComments, buildContentDraft } from '../content-generator.js';
import type { PositioningCard } from '../types.js';
import type { PositionVariant, ProductMatch } from '../types.js';

function makeProductMatch(overrides: Partial<ProductMatch & { affiliate_link?: string }> = {}): ProductMatch & { affiliate_link?: string } {
  return {
    product_id: 'test_001',
    name: '테스트 제품',
    affiliate_platform: 'coupang_partners',
    price_range: '15000-29000',
    threads_score: {
      naturalness: 3.5,
      clarity: 3.5,
      ad_smell: 3.5,
      repeatability: 3.0,
      story_potential: 3.5,
      total: 3.4,
    },
    competition: '중',
    priority: 1,
    why: 'test reason',
    ...overrides,
  };
}

// 테스트용 PositionVariant 헬퍼
function makeVariant(format: PositionVariant['format'], overrides: Partial<PositionVariant> = {}): PositionVariant {
  return {
    format,
    angle: '이 문제 나만 겪는 줄 알았는데',
    tone: '공감 → 발견 → 자연스런 소개',
    hook: '수면 문제 나만 그런 줄 알았는데',
    avoid: ['최고의 제품', '꼭 사세요', '광고'],
    cta_style: '프로필 링크 유도',
    ...overrides,
  };
}

describe('generatePostBody', () => {
  test('returns exactly 3 body variations', () => {
    const variant = makeVariant('솔직후기형');
    const bodies = generatePostBody(variant, '무드등 LED 수면 조명', '수면이 잘 안 옴');
    expect(bodies).toHaveLength(3);
  });

  test('all bodies are non-empty strings', () => {
    const variant = makeVariant('문제공감형');
    const bodies = generatePostBody(variant, '마그네슘 영양제', '만성 피로');
    for (const body of bodies) {
      expect(typeof body).toBe('string');
      expect(body.trim().length).toBeGreaterThan(0);
    }
  });

  test('문제공감형 body contains empathy → discovery structure', () => {
    const variant = makeVariant('문제공감형');
    const bodies = generatePostBody(variant, '수면 마스크', '수면이 안 옴');
    // 첫 번째 본문은 공감 → 발견 패턴
    expect(bodies[0]).toMatch(/나만|그랬는데|알고 보니|찾았는데|비슷|같더라/);
  });

  test('솔직후기형 body uses 1인칭 구어체', () => {
    const variant = makeVariant('솔직후기형');
    const bodies = generatePostBody(variant, '폼롤러', '허리 통증');
    expect(bodies[0]).toMatch(/써봤|써보니|써봤는데|썼는데|했는데|쓰다 보니/);
  });

  test('비교형 body puts conclusion first', () => {
    const variant = makeVariant('비교형');
    const bodies = generatePostBody(variant, '블루투스 이어폰', '이어폰 고민');
    // 결론 먼저 구조: 짧은 결론 문장으로 시작
    expect(bodies[0].split('\n')[0].length).toBeLessThan(40);
  });

  test('입문추천형 body addresses beginners', () => {
    const variant = makeVariant('입문추천형');
    const bodies = generatePostBody(variant, '요가 매트', '운동 시작');
    expect(bodies[0]).toMatch(/처음|입문|시작|모르면/);
  });

  test('실수방지형 body starts with warning pattern', () => {
    const variant = makeVariant('실수방지형');
    const bodies = generatePostBody(variant, '프로틴 파우더', '단백질 보충');
    expect(bodies[0]).toMatch(/사기 전|확인|실수|몰랐|이것만|주의/);
  });

  test('비추천형 body is honest and suggests alternative', () => {
    const variant = makeVariant('비추천형');
    const bodies = generatePostBody(variant, '저가 안마기', '근육 피로');
    expect(bodies[0]).toMatch(/별로|아쉬웠|실망|그나마|대신|다른/);
  });

  test('bodies do not contain avoid words', () => {
    const variant = makeVariant('솔직후기형', {
      avoid: ['최고의 제품', '꼭 사세요', '강력 추천'],
    });
    const bodies = generatePostBody(variant, '테스트 제품', '테스트 문제');
    for (const body of bodies) {
      expect(body).not.toContain('최고의 제품');
      expect(body).not.toContain('꼭 사세요');
      expect(body).not.toContain('강력 추천');
    }
  });
});

describe('generateHookVariants', () => {
  test('returns exactly 5 hooks', () => {
    const hooks = generateHookVariants('솔직후기형', '무드등 LED', '불편해소', '수면 문제');
    expect(hooks).toHaveLength(5);
  });

  test('all hooks are non-empty strings', () => {
    const hooks = generateHookVariants('문제공감형', '마그네슘', '외모건강', '피로');
    for (const hook of hooks) {
      expect(typeof hook).toBe('string');
      expect(hook.trim().length).toBeGreaterThan(0);
    }
  });

  test('produces multiple unique hooks (at least 3 distinct)', () => {
    const hooks = generateHookVariants('비교형', '블루투스 이어폰', '시간절약', '이어폰 고민');
    const unique = new Set(hooks);
    expect(unique.size).toBeGreaterThanOrEqual(3);
  });

  test('hooks are reasonable length (under 50 chars each)', () => {
    const hooks = generateHookVariants('입문추천형', '요가 매트', '성과향상', '운동 입문');
    for (const hook of hooks) {
      expect(hook.length).toBeLessThan(50);
    }
  });
});

describe('generateSelfComments', () => {
  test('returns exactly 2 comments', () => {
    const product = makeProductMatch();
    const variant = makeVariant('솔직후기형');
    const comments = generateSelfComments(product, variant);
    expect(comments).toHaveLength(2);
  });

  test('프로필 링크 유도 cta_style includes profile link hint', () => {
    const product = makeProductMatch();
    const variant = makeVariant('문제공감형', { cta_style: '프로필 링크 유도' });
    const comments = generateSelfComments(product, variant);
    expect(comments[0]).toMatch(/프로필|링크/);
  });

  test('댓글에서 자연스럽게 cta_style uses comment-based CTA', () => {
    const product = makeProductMatch();
    const variant = makeVariant('솔직후기형', { cta_style: '댓글에서 자연스럽게' });
    const comments = generateSelfComments(product, variant);
    expect(comments[0]).toMatch(/댓글|궁금|물어봐/);
  });

  test('DM 유도 cta_style mentions DM', () => {
    const product = makeProductMatch();
    const variant = makeVariant('실수방지형', { cta_style: 'DM 유도' });
    const comments = generateSelfComments(product, variant);
    expect(comments[0]).toMatch(/DM|디엠/);
  });

  test('includes affiliate_link in comment when present', () => {
    const product = makeProductMatch({ affiliate_link: 'https://link.coupang.com/test123' });
    const variant = makeVariant('솔직후기형', { cta_style: '프로필 링크 유도' });
    const comments = generateSelfComments(product, variant);
    const allText = comments.join('\n');
    expect(allText).toContain('https://link.coupang.com/test123');
  });

  test('comment 2 includes social proof or context', () => {
    const product = makeProductMatch({ price_range: '15000-20000' });
    const variant = makeVariant('입문추천형');
    const comments = generateSelfComments(product, variant);
    expect(comments[1].trim().length).toBeGreaterThan(0);
  });
});

describe('buildContentDraft', () => {
  test('returns ContentDraft with correct shape', () => {
    const card: PositioningCard = {
      product_id: 'test_001',
      product_name: '테스트 제품',
      need_id: 'need_001',
      positions: [makeVariant('솔직후기형')],
    };
    const product = makeProductMatch();
    const draft = buildContentDraft(card, product, '테스트 문제');

    expect(draft.product_id).toBe('test_001');
    expect(draft.product_name).toBe('테스트 제품');
    expect(draft.need_id).toBe('need_001');
    expect(draft.format).toBe('솔직후기형');
    expect(typeof draft.hook).toBe('string');
    expect(draft.bodies).toHaveLength(3);
    expect(draft.hooks).toHaveLength(5);
    expect(draft.self_comments).toHaveLength(2);
  });

  test('uses first position as primary format', () => {
    const card: PositioningCard = {
      product_id: 'test_002',
      product_name: '제품2',
      need_id: 'need_002',
      positions: [makeVariant('문제공감형'), makeVariant('솔직후기형')],
    };
    const draft = buildContentDraft(card, makeProductMatch(), '문제');
    expect(draft.format).toBe('문제공감형');
    expect(draft.hook).toBe(card.positions[0].hook);
  });

  test('handles card with no positions gracefully', () => {
    const card: PositioningCard = {
      product_id: 'test_003',
      product_name: '빈 카드',
      need_id: 'need_003',
      positions: [],
    };
    // 포지션 없으면 기본값 사용
    expect(() => buildContentDraft(card, makeProductMatch(), '문제')).not.toThrow();
  });
});
