# P3 Content Generator + Performance Analyzer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** P3 파이프라인 완성 — 콘텐츠 초안 자동 생성(P3-1) + 성과 분석 및 학습 피드백(P3-2)

**Architecture:** 기존 파이프라인(normalize→researcher→needs→products→positioning) 뒤에 Step 6(content-generator) + Step 7(performance-analyzer) 추가. 순수 함수 TDD + 타입 전중앙화 패턴 유지.

**Tech Stack:** TypeScript strict mode, vitest, tsx runner, Node.js fs

---

## Phase A: Types (비TDD — 동작 변경 없음)

### Task 1: types.ts에 P3 타입 추가

**Files:**
- Modify: `scripts/types.ts` (끝 부분에 추가)

**Step 1: types.ts 끝에 P3 타입 블록 추가**

```typescript
// --- P3: Content Generation ---

export interface ContentDraft {
  product_id: string;
  product_name: string;
  need_id: string;
  format: PositionFormat;
  hook: string;            // 대표 훅 (positions[0].hook)
  bodies: string[];        // 3개 본문 변형
  hooks: string[];         // 5개 훅 변형
  self_comments: string[]; // 2개 자기 댓글
}

export interface ContentDraftOutput {
  date: string;
  drafts: ContentDraft[];
  meta: {
    positioning_version: string;
    drafts_generated: number;
    generated_at: string;
  };
}

// --- P3: Performance Analysis ---

export type TimeSlot = '새벽' | '오전' | '오후' | '밤';

export interface PerformanceMetrics {
  avg_views: number | null;
  avg_likes: number;
  avg_replies: number;
  post_count: number;
}

export interface AnalysisReport {
  date: string;
  format_performance: Record<string, PerformanceMetrics>;
  time_performance: Record<TimeSlot, PerformanceMetrics>;
  top_performing_posts: Array<{
    post_id: string;
    channel_id: string;
    views: number | null;
    likes: number;
    tag: string;
  }>;
  learning_deltas: LearningEntry[];
  meta: {
    posts_analyzed: number;
    date_range: { from: string; to: string };
    generated_at: string;
  };
}
```

**Step 2: tsc 확인**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 3: 커밋**

```bash
git add scripts/types.ts
git commit -m "feat(threads): add P3 types (ContentDraft, AnalysisReport, PerformanceMetrics, TimeSlot)"
```

---

## Phase B: Content Generator (TDD)

### Task 2: generatePostBody — 포맷별 본문 3개 생성

**Files:**
- Create: `scripts/__tests__/content-generator.test.ts`
- Create: `scripts/content-generator.ts` (함수만, main 없이)

**Step 1: 실패하는 테스트 작성**

`scripts/__tests__/content-generator.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { generatePostBody } from '../content-generator.js';
import type { PositionVariant } from '../types.js';

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
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/content-generator.test.ts`
Expected: FAIL — module not found

**Step 3: generatePostBody 구현**

`scripts/content-generator.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * content-generator.ts — P3-1 콘텐츠 초안 생성기
 *
 * positioning.json → 포맷별 본문 3개 + 훅 5개 + 자기댓글 2개 생성.
 * 규칙 기반 템플릿. --prompt 플래그로 LLM 강화 프롬프트도 생성.
 *
 * Usage:
 *   tsx scripts/content-generator.ts
 *   tsx scripts/content-generator.ts --prompt    # LLM 프롬프트도 생성
 */

import type {
  PositionVariant,
  PositionFormat,
  NeedsCategory,
  ContentDraft,
  ContentDraftOutput,
  PositioningOutput,
  ProductMatchOutput,
} from './types.js';

// --- 포맷별 본문 템플릿 ---

// 문제공감형: 공감(1줄) → 발견(1줄) → 소개(1줄)
const BODY_TEMPLATES_문제공감형 = [
  (p: string, prob: string) =>
    `${prob} 나만 그런 줄 알았는데 비슷한 사람 많더라\n그래서 뭔가 찾아봤는데 ${p} 쓰고 나서 좀 달라짐\n광고 아니고 진짜로`,
  (p: string, prob: string) =>
    `${prob} 해결하려고 별짓 다 해봤음\n결국 ${p}로 어느 정도 잡혔는데\n완벽하진 않고 그냥 나한테는 맞았음`,
  (p: string, prob: string) =>
    `솔직히 ${prob} 이제 좀 지쳤었는데\n${p} 써보고 나서 조금 나아짐\n뭔가 대단한 건 아닌데 없을 때랑 차이는 있음`,
];

// 솔직후기형: 사용 맥락 → 장점 → 단점/한계
const BODY_TEMPLATES_솔직후기형 = [
  (p: string) =>
    `${p} 한 달 넘게 써봤는데 솔직하게 말하면\n생각보다 괜찮았음. 특히 처음에 의심했던 부분이 의외로 됨\n단점은 있는데 이 가격이면 감수할 만함`,
  (p: string) =>
    `${p} 쓰다 보니 어느새 익숙해졌음\n처음엔 반신반의했는데 지금은 없으면 좀 허전\n완벽한 건 아닌데 이 정도면 충분히 살 만함`,
  (p: string) =>
    `내 돈 주고 산 ${p} 중간 점검\n좋은 점: 생각보다 쓸 만함\n별로인 점: 사용법이 처음엔 좀 불편한데 익숙해지면 됨`,
];

// 비교형: 결론 먼저 → 비교 맥락 → 선택 이유
const BODY_TEMPLATES_비교형 = [
  (p: string) =>
    `결론: ${p} 남김\n비슷한 거 3개 써봤는데 2개는 돈 버림\n이게 유일하게 가성비 맞았음`,
  (p: string) =>
    `${p} vs 다른 거 다 써봤는데\n비슷해 보여도 실사용에서 차이 남\n이거 하나만 남기고 나머지 다 버렸음`,
  (p: string) =>
    `이 카테고리 찾아보면 ${p} 류가 많은데\n실제로 써보면 다 비슷하지 않음\n내 기준엔 이게 최선이었음`,
];

// 입문추천형: 대상 명시 → 소개 → 진입 이유
const BODY_TEMPLATES_입문추천형 = [
  (p: string, cat: string) =>
    `${cat} 처음 시작하는 사람한테 ${p} 추천함\n어렵게 생각할 거 없고 이거 하나면 일단 시작 가능\n나중에 취향 생기면 바꾸면 됨`,
  (p: string) =>
    `${p} 처음 입문용으로 이거 선택한 게 잘한 것 같음\n너무 싸지도 너무 비싸지도 않은 딱 맞는 포지션\n주변에서 물어볼 때마다 이거 알려줌`,
  (p: string) =>
    `${p} 뭐 살지 모르겠으면 일단 이거부터\n입문자한테 오버스펙 필요 없음\n기본기만 되면 충분한데 이게 그 역할 함`,
];

// 실수방지형: 경고 → 기준 → 추천
const BODY_TEMPLATES_실수방지형 = [
  (p: string) =>
    `${p} 사기 전에 이것만 확인해봐\n나처럼 모르고 샀다가 후회하지 말고\n이 기준으로 고르면 돈 버릴 확률 낮아짐`,
  (p: string) =>
    `${p} 관련 살 때 흔한 실수가 있음\n가격만 보고 사면 나중에 후회함\n이거 체크하고 사면 그나마 낫더라`,
  (p: string) =>
    `이거 먼저 봤으면 ${p} 다른 거 안 샀을 듯\n비슷해 보이는데 실제론 다름\n이 부분만 확인하면 됨`,
];

// 비추천형: 솔직한 평가 → 실망 → 대안
const BODY_TEMPLATES_비추천형 = [
  (p: string) =>
    `${p} 솔직히 별로였음\n기대가 컸나 싶기도 한데 돈 값은 못했음\n그나마 나중에 더 나은 거 찾아서 다행`,
  (p: string) =>
    `이 카테고리 ${p} 써봤는데 아쉬웠음\n나쁜 건 아닌데 내 상황에는 안 맞았음\n대신 [다른 선택지] 쪽이 더 맞을 수 있음`,
  (p: string) =>
    `솔직히 ${p}에 실망했던 경험 공유함\n모두한테 별로란 게 아니라 내 케이스에서 그랬음\n다른 거 찾는 분들한테 참고 되면 좋겠음`,
];

/**
 * 포맷별 본문 3개 생성.
 * @param variant PositionVariant (format, avoid 등 포함)
 * @param productName 제품명
 * @param problem 니즈 문제 설명
 */
export function generatePostBody(
  variant: PositionVariant,
  productName: string,
  problem: string,
): string[] {
  // 제품 단축명 (2어절 이하)
  const pShort = productName.split(' ').slice(0, 2).join(' ');
  // 카테고리 힌트 (problem에서 첫 단어 추출)
  const catHint = problem.split(/\s+/)[0] || '이 분야';

  let bodies: string[];

  switch (variant.format) {
    case '문제공감형':
      bodies = BODY_TEMPLATES_문제공감형.map(fn => fn(pShort, problem));
      break;
    case '솔직후기형':
      bodies = BODY_TEMPLATES_솔직후기형.map(fn => fn(pShort));
      break;
    case '비교형':
      bodies = BODY_TEMPLATES_비교형.map(fn => fn(pShort));
      break;
    case '입문추천형':
      bodies = BODY_TEMPLATES_입문추천형.map(fn => fn(pShort, catHint));
      break;
    case '실수방지형':
      bodies = BODY_TEMPLATES_실수방지형.map(fn => fn(pShort));
      break;
    case '비추천형':
      bodies = BODY_TEMPLATES_비추천형.map(fn => fn(pShort));
      break;
    default: {
      // 알 수 없는 포맷 — 솔직후기형 fallback
      const fmt: never = variant.format;
      console.warn(`Unknown format: ${fmt as string}, falling back to 솔직후기형`);
      bodies = BODY_TEMPLATES_솔직후기형.map(fn => fn(pShort));
    }
  }

  // avoid 단어 포함 여부 체크 (경고만, 치환하지 않음)
  for (const body of bodies) {
    for (const word of variant.avoid) {
      if (body.includes(word)) {
        console.warn(`Body contains avoided word "${word}": ${body.slice(0, 30)}...`);
      }
    }
  }

  return bodies;
}
```

**Step 4: 테스트 통과 확인**

Run: `npx vitest run scripts/__tests__/content-generator.test.ts`
Expected: 9 tests pass

---

### Task 3: generateHookVariants — 5개 훅 변형 생성

**Files:**
- Modify: `scripts/__tests__/content-generator.test.ts` (테스트 추가)
- Modify: `scripts/content-generator.ts` (함수 추가)

**Step 1: 실패하는 테스트 추가**

```typescript
import { generateHookVariants } from '../content-generator.js';

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
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/content-generator.test.ts`
Expected: FAIL — `generateHookVariants` not exported

**Step 3: generateHookVariants 구현**

positioning.ts의 generateHook을 import해서 seed offset 방식으로 5개 생성:

```typescript
import { generateHook } from './positioning.js';

/**
 * 5개 훅 변형 생성 — generateHook을 seed offset으로 5회 호출.
 * 중복 방지를 위해 productName에 suffix를 추가해 해시값을 분산시킴.
 */
export function generateHookVariants(
  format: PositionFormat,
  productName: string,
  needCategory: NeedsCategory,
  problem: string,
): string[] {
  // seed modifier로 제품명 변형 → 다른 해시값 → 다른 템플릿 인덱스
  const seeds = [
    productName,
    productName + '_v2',
    productName + '_v3',
    productName + ' 후기',
    productName + ' 사용',
  ];

  const results: string[] = [];
  const seen = new Set<string>();

  for (const seed of seeds) {
    const hook = generateHook({ format, productName: seed, needCategory, problem });
    // 중복이면 번호 suffix 추가
    const final = seen.has(hook) ? `${hook} (${seen.size})` : hook;
    seen.add(hook);
    results.push(final);
  }

  return results;
}
```

**Step 4: 모든 테스트 통과 확인**

Run: `npx vitest run scripts/__tests__/content-generator.test.ts`
Expected: 13 tests pass

---

### Task 4: generateSelfComments — 자기 댓글 2개 생성

**Files:**
- Modify: `scripts/__tests__/content-generator.test.ts` (테스트 추가)
- Modify: `scripts/content-generator.ts` (함수 추가)

**Step 1: 실패하는 테스트 추가**

```typescript
import { generateSelfComments } from '../content-generator.js';
import type { ProductMatch } from '../types.js';

function makeProductMatch(overrides: Partial<ProductMatch> = {}): ProductMatch {
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
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/content-generator.test.ts`
Expected: FAIL — `generateSelfComments` not exported

**Step 3: generateSelfComments 구현**

```typescript
import type { ProductMatch } from './types.js';
import { parsePriceMin } from './product-matcher.js';

// CTA 스타일별 댓글 1 템플릿
const CTA_COMMENTS: Record<string, string[]> = {
  '프로필 링크 유도': [
    '궁금한 거 있으면 프로필 링크에서 확인해봐',
    '더 자세한 건 프로필 링크 참고',
    '링크는 프로필에 있음',
  ],
  '댓글에서 자연스럽게': [
    '궁금한 거 있으면 댓글로 남겨줘',
    '더 궁금한 거 있으면 댓글로',
    '써본 거 더 궁금하면 물어봐',
  ],
  'DM 유도': [
    '구체적으로 궁금하면 DM 줘',
    '디엠으로 물어봐도 됨',
    '자세한 건 DM으로',
  ],
};

/**
 * 자기 댓글 2개 생성.
 * Comment 1: CTA (cta_style 기반, affiliate_link 있으면 URL 포함)
 * Comment 2: 추가 컨텍스트/소셜 프루프
 */
export function generateSelfComments(
  product: ProductMatch,
  variant: PositionVariant,
): string[] {
  // Comment 1 — CTA
  const ctaTemplates = CTA_COMMENTS[variant.cta_style] || CTA_COMMENTS['댓글에서 자연스럽게'];

  // 제품명 해시로 템플릿 선택
  let hash = 0;
  for (let i = 0; i < product.name.length; i++) {
    hash = ((hash << 5) - hash + product.name.charCodeAt(i)) | 0;
  }
  const ctaBase = ctaTemplates[Math.abs(hash) % ctaTemplates.length];

  // affiliate_link 있으면 URL 추가
  const affiliateLink = (product as ProductMatch & { affiliate_link?: string }).affiliate_link;
  const comment1 = affiliateLink
    ? `${ctaBase}\n${affiliateLink}`
    : ctaBase;

  // Comment 2 — 가격/컨텍스트 기반 소셜 프루프
  const priceMin = parsePriceMin(product.price_range);
  let comment2: string;

  if (priceMin !== null && priceMin < 20000) {
    comment2 = `${product.price_range}원대라 부담 없이 시작하기 좋음. 주변에도 써봤는데 반응 괜찮았음`;
  } else if (priceMin !== null && priceMin < 50000) {
    comment2 = `가격이 좀 있긴 한데 오래 쓰는 거라 투자한 셈. 몇 달째 쓰고 있음`;
  } else {
    comment2 = `처음엔 망설였는데 한번 쓰고 나서는 없을 때 생각남. 경험상 이게 낫더라`;
  }

  return [comment1, comment2];
}
```

**Step 4: 모든 테스트 통과 확인**

Run: `npx vitest run scripts/__tests__/content-generator.test.ts`
Expected: 19 tests pass

---

### Task 5: buildContentDraft — ContentDraft 조립

**Files:**
- Modify: `scripts/__tests__/content-generator.test.ts` (테스트 추가)
- Modify: `scripts/content-generator.ts` (함수 추가)

**Step 1: 실패하는 테스트 추가**

```typescript
import { buildContentDraft } from '../content-generator.js';
import type { PositioningCard } from '../types.js';

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
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/content-generator.test.ts`
Expected: FAIL — `buildContentDraft` not exported

**Step 3: buildContentDraft 구현**

```typescript
import type { ContentDraft, PositioningCard } from './types.js';

/**
 * PositioningCard + ProductMatch → ContentDraft 조립.
 * positions[0]을 주 포맷으로 사용.
 */
export function buildContentDraft(
  card: PositioningCard,
  product: ProductMatch,
  problem: string,
): ContentDraft {
  // 포지션 없으면 기본 솔직후기형 fallback
  const primaryVariant: PositionVariant = card.positions[0] ?? {
    format: '솔직후기형',
    angle: '개인 경험',
    tone: '구어체',
    hook: `${card.product_name} 써봤는데`,
    avoid: ['최고의 제품', '광고'],
    cta_style: '댓글에서 자연스럽게',
  };

  const bodies = generatePostBody(primaryVariant, card.product_name, problem);
  const hooks = generateHookVariants(
    primaryVariant.format,
    card.product_name,
    // need_id에서 카테고리 추출 불가 → 기본값 사용
    '불편해소',
    problem,
  );
  const self_comments = generateSelfComments(product, primaryVariant);

  return {
    product_id: card.product_id,
    product_name: card.product_name,
    need_id: card.need_id,
    format: primaryVariant.format,
    hook: primaryVariant.hook,
    bodies,
    hooks,
    self_comments,
  };
}
```

**Step 4: 모든 테스트 통과 확인**

Run: `npx vitest run scripts/__tests__/content-generator.test.ts`
Expected: 22 tests pass

---

### Task 6: content-generator.ts main + --prompt flag

**Files:**
- Modify: `scripts/content-generator.ts` (main 함수 추가)

**Step 1: main 함수 + isMainModule 가드 추가**

```typescript
import fs from 'fs';
import path from 'path';
import type { ContentDraftOutput } from './types.js';

const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');

// LLM 프롬프트 생성
function generateLLMPrompt(drafts: ContentDraftOutput): string {
  const sample = drafts.drafts.slice(0, 3).map(d => ({
    product: d.product_name,
    format: d.format,
    bodies: d.bodies,
    hooks: d.hooks.slice(0, 3),
  }));

  return `당신은 Threads 콘텐츠 작가입니다. 아래 규칙 기반 초안을 자연스럽게 개선하세요.

## 규칙
- 각 body는 1-3줄, 한국어 구어체
- 광고 냄새 없이 실제 경험담처럼
- hook은 20자 이내
- 결과는 동일한 JSON 구조로 반환

## 개선할 초안 (${drafts.drafts.length}개 중 샘플 3개)
${JSON.stringify(sample, null, 2)}

## 출력 형식 (JSON)
{
  "drafts": [
    {
      "product_id": "...",
      "bodies": ["개선된 본문1", "개선된 본문2", "개선된 본문3"],
      "hooks": ["개선된 훅1", ..., "개선된 훅5"]
    }
  ]
}

최대 800 토큰`;
}

function main(): void {
  const args = process.argv.slice(2);
  const generatePrompt = args.includes('--prompt');

  const today = new Date().toISOString().slice(0, 10);

  // positioning.json 로드
  const positioningPath = path.join(BRIEFS_DIR, `${today}_positioning.json`);
  let positioningData: PositioningOutput;
  try {
    positioningData = JSON.parse(fs.readFileSync(positioningPath, 'utf8'));
  } catch {
    console.error(`Positioning file not found: ${positioningPath}`);
    console.error(`Run positioning.ts first.`);
    process.exit(1);
  }

  // products.json 로드 (affiliate_link 등 추가 정보용, 없어도 동작)
  const productsPath = path.join(BRIEFS_DIR, `${today}_products.json`);
  let productsData: ProductMatchOutput | null = null;
  try {
    productsData = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
  } catch {
    console.warn(`Products data not available: ${productsPath} (affiliate_link 미포함)`);
  }

  // product_id → ProductMatch 맵 구성
  const productMap = new Map<string, ProductMatch>();
  if (productsData) {
    for (const match of productsData.matches) {
      for (const product of match.products) {
        productMap.set(product.product_id, product);
      }
    }
  }

  // 니즈별 상위 3개 제품의 포지셔닝 카드만 처리
  // need_id별로 그룹핑 후 상위 3개 카드 선택
  const needGroups = new Map<string, typeof positioningData.positioning_cards>();
  for (const card of positioningData.positioning_cards) {
    const group = needGroups.get(card.need_id) || [];
    group.push(card);
    needGroups.set(card.need_id, group);
  }

  const drafts = [];
  for (const [, cards] of needGroups) {
    // 니즈별 상위 3개 카드
    for (const card of cards.slice(0, 3)) {
      const product = productMap.get(card.product_id) ?? {
        product_id: card.product_id,
        name: card.product_name,
        affiliate_platform: 'coupang_partners' as const,
        price_range: '미정',
        threads_score: { naturalness: 3, clarity: 3, ad_smell: 3, repeatability: 3, story_potential: 3, total: 3 },
        competition: '중' as const,
        priority: 1,
        why: '',
      };
      // problem은 need_id에서 추정 (실제로는 needs.json에서 가져와야 하지만 여기선 단순화)
      const draft = buildContentDraft(card, product, card.need_id.replace(/_/g, ' '));
      drafts.push(draft);
    }
  }

  const output: ContentDraftOutput = {
    date: today,
    drafts,
    meta: {
      positioning_version: positioningData.date,
      drafts_generated: drafts.length,
      generated_at: new Date().toISOString(),
    },
  };

  // Atomic write
  const outPath = path.join(BRIEFS_DIR, `${today}_content_drafts.json`);
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(tmpPath, outPath);

  // LLM 프롬프트 생성
  if (generatePrompt) {
    const prompt = generateLLMPrompt(output);
    const promptPath = path.join(BRIEFS_DIR, `${today}_content_prompt.txt`);
    fs.writeFileSync(promptPath, prompt, 'utf8');
    console.log(`  LLM prompt: ${promptPath}`);
  }

  // 요약 출력
  console.log(`\nContent drafts: ${outPath}`);
  console.log(`총 ${drafts.length}개 초안 생성`);
  for (const draft of drafts.slice(0, 3)) {
    console.log(`\n[${draft.product_name}] ${draft.format}`);
    console.log(`  훅: "${draft.hook}"`);
    console.log(`  초안: "${draft.bodies[0].split('\n')[0]}..."`);
  }
}

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('content-generator.ts') ||
  process.argv[1].endsWith('content-generator.js')
);
if (isMainModule) main();
```

**Step 2: tsc 확인 + 전체 테스트**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors, 22+ tests pass

**Step 3: 커밋**

```bash
git add scripts/content-generator.ts scripts/__tests__/content-generator.test.ts
git commit -m "feat(threads): implement P3-1 content generator (body/hooks/comments + main)"
```

---

## Phase C: Performance Analyzer (TDD)

### Task 7: calcEngagementStats — 포맷별 참여도 평균 계산

**Files:**
- Create: `scripts/__tests__/performance-analyzer.test.ts`
- Create: `scripts/performance-analyzer.ts` (함수만, main 없이)

**Step 1: 실패하는 테스트 작성**

`scripts/__tests__/performance-analyzer.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { calcEngagementStats } from '../performance-analyzer.js';
import type { CanonicalPost } from '../types.js';

// 테스트용 포스트 헬퍼
function makePost(overrides: Partial<CanonicalPost> = {}): CanonicalPost {
  return {
    post_id: `post_${Math.random().toString(36).slice(2)}`,
    channel_id: 'test_channel',
    text: '테스트 포스트',
    timestamp: '2026-03-14T10:00:00.000Z',
    metrics: { view_count: 100, like_count: 5, reply_count: 1, repost_count: 0 },
    tags: { primary: 'affiliate', secondary: [] },
    ...overrides,
  };
}

describe('calcEngagementStats', () => {
  test('groups posts by primary tag', () => {
    const posts = [
      makePost({ tags: { primary: 'affiliate', secondary: [] } }),
      makePost({ tags: { primary: 'affiliate', secondary: [] } }),
      makePost({ tags: { primary: 'general', secondary: [] } }),
    ];
    const stats = calcEngagementStats(posts);
    expect(stats['affiliate'].post_count).toBe(2);
    expect(stats['general'].post_count).toBe(1);
  });

  test('calculates correct avg_likes', () => {
    const posts = [
      makePost({ metrics: { view_count: 100, like_count: 10, reply_count: 0, repost_count: 0 } }),
      makePost({ metrics: { view_count: 200, like_count: 20, reply_count: 0, repost_count: 0 } }),
    ];
    const stats = calcEngagementStats(posts);
    expect(stats['affiliate'].avg_likes).toBe(15);
  });

  test('calculates correct avg_views excluding null', () => {
    const posts = [
      makePost({ metrics: { view_count: 100, like_count: 5, reply_count: 0, repost_count: 0 } }),
      makePost({ metrics: { view_count: null, like_count: 5, reply_count: 0, repost_count: 0 } }),
      makePost({ metrics: { view_count: 300, like_count: 5, reply_count: 0, repost_count: 0 } }),
    ];
    const stats = calcEngagementStats(posts);
    // null 제외: (100 + 300) / 2 = 200
    expect(stats['affiliate'].avg_views).toBe(200);
  });

  test('returns null avg_views when all views are null', () => {
    const posts = [
      makePost({ metrics: { view_count: null, like_count: 5, reply_count: 0, repost_count: 0 } }),
    ];
    const stats = calcEngagementStats(posts);
    expect(stats['affiliate'].avg_views).toBeNull();
  });

  test('handles empty posts array', () => {
    const stats = calcEngagementStats([]);
    expect(Object.keys(stats)).toHaveLength(0);
  });

  test('includes avg_replies in stats', () => {
    const posts = [
      makePost({ metrics: { view_count: 100, like_count: 5, reply_count: 2, repost_count: 0 } }),
      makePost({ metrics: { view_count: 100, like_count: 5, reply_count: 4, repost_count: 0 } }),
    ];
    const stats = calcEngagementStats(posts);
    expect(stats['affiliate'].avg_replies).toBe(3);
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/performance-analyzer.test.ts`
Expected: FAIL — module not found

**Step 3: calcEngagementStats 구현**

`scripts/performance-analyzer.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * performance-analyzer.ts — P3-2 성과 분석기
 *
 * canonical/posts.json → 포맷별 참여도 분석 + 시간대별 패턴 + 학습 피드백 계산.
 *
 * Usage:
 *   tsx scripts/performance-analyzer.ts
 */

import type {
  CanonicalPost,
  PerformanceMetrics,
  TimeSlot,
  AnalysisReport,
  LearningEntry,
} from './types.js';
import { clamp, round1 } from './product-matcher.js';

/**
 * 포스트 배열 → primary tag별 참여도 평균 계산.
 * null view_count는 평균에서 제외 (like/reply는 포함).
 */
export function calcEngagementStats(
  posts: CanonicalPost[],
): Record<string, PerformanceMetrics> {
  // tag별 그룹핑
  const groups = new Map<string, CanonicalPost[]>();
  for (const post of posts) {
    const tag = post.tags?.primary ?? 'general';
    const group = groups.get(tag) || [];
    group.push(post);
    groups.set(tag, group);
  }

  const result: Record<string, PerformanceMetrics> = {};

  for (const [tag, group] of groups) {
    const likesSum = group.reduce((sum, p) => sum + (p.metrics?.like_count ?? 0), 0);
    const repliesSum = group.reduce((sum, p) => sum + (p.metrics?.reply_count ?? 0), 0);

    // null 제외 views 집계
    const validViews = group
      .map(p => p.metrics?.view_count)
      .filter((v): v is number => v !== null && v !== undefined);

    const avg_views = validViews.length > 0
      ? round1(validViews.reduce((a, b) => a + b, 0) / validViews.length)
      : null;

    result[tag] = {
      avg_views,
      avg_likes: round1(likesSum / group.length),
      avg_replies: round1(repliesSum / group.length),
      post_count: group.length,
    };
  }

  return result;
}
```

**Step 4: 테스트 통과 확인**

Run: `npx vitest run scripts/__tests__/performance-analyzer.test.ts`
Expected: 6 tests pass

---

### Task 8: analyzeTimePatterns — 시간대별 성과 버킷

**Files:**
- Modify: `scripts/__tests__/performance-analyzer.test.ts` (테스트 추가)
- Modify: `scripts/performance-analyzer.ts` (함수 추가)

**Step 1: 실패하는 테스트 추가**

```typescript
import { analyzeTimePatterns } from '../performance-analyzer.js';

describe('analyzeTimePatterns', () => {
  test('buckets posts into 4 time slots', () => {
    const posts = [
      makePost({ timestamp: '2026-03-14T01:00:00.000Z' }), // UTC 1시 = KST 10시 → 오전
      makePost({ timestamp: '2026-03-14T06:00:00.000Z' }), // UTC 6시 = KST 15시 → 오후
      makePost({ timestamp: '2026-03-14T14:00:00.000Z' }), // UTC 14시 = KST 23시 → 밤
      makePost({ timestamp: '2026-03-13T17:00:00.000Z' }), // UTC 17시 = KST 2시 → 새벽
    ];
    const patterns = analyzeTimePatterns(posts);
    expect(patterns['오전'].post_count).toBeGreaterThanOrEqual(1);
    expect(patterns['오후'].post_count).toBeGreaterThanOrEqual(1);
    expect(patterns['밤'].post_count).toBeGreaterThanOrEqual(1);
    expect(patterns['새벽'].post_count).toBeGreaterThanOrEqual(1);
  });

  test('all 4 slots exist in result', () => {
    const posts = [makePost()];
    const patterns = analyzeTimePatterns(posts);
    expect(Object.keys(patterns)).toContain('새벽');
    expect(Object.keys(patterns)).toContain('오전');
    expect(Object.keys(patterns)).toContain('오후');
    expect(Object.keys(patterns)).toContain('밤');
  });

  test('calculates correct avg_likes per slot', () => {
    // UTC 1시 = KST 10시 = 오전
    const posts = [
      makePost({
        timestamp: '2026-03-14T01:00:00.000Z',
        metrics: { view_count: 100, like_count: 10, reply_count: 0, repost_count: 0 },
      }),
      makePost({
        timestamp: '2026-03-14T02:00:00.000Z',
        metrics: { view_count: 200, like_count: 20, reply_count: 0, repost_count: 0 },
      }),
    ];
    const patterns = analyzeTimePatterns(posts);
    expect(patterns['오전'].avg_likes).toBe(15);
  });

  test('slot with no posts has post_count 0', () => {
    // 새벽 포스트만 있음 (UTC 15시 = KST 0시 = 새벽)
    const posts = [makePost({ timestamp: '2026-03-14T15:00:00.000Z' })];
    const patterns = analyzeTimePatterns(posts);
    expect(patterns['새벽'].post_count).toBe(1);
    expect(patterns['오전'].post_count).toBe(0);
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/performance-analyzer.test.ts`
Expected: FAIL — `analyzeTimePatterns` not exported

**Step 3: analyzeTimePatterns 구현**

```typescript
/** ISO timestamp → KST hour 추출 */
function toKSTHour(timestamp: string): number {
  const date = new Date(timestamp);
  const utcHour = date.getUTCHours();
  return (utcHour + 9) % 24; // KST = UTC+9
}

/** KST hour → TimeSlot 분류 */
function classifyTimeSlot(kstHour: number): TimeSlot {
  if (kstHour < 6) return '새벽';
  if (kstHour < 12) return '오전';
  if (kstHour < 18) return '오후';
  return '밤';
}

/**
 * 포스트 배열 → 시간대별 참여도 패턴.
 * 4개 슬롯(새벽/오전/오후/밤) 모두 반환 (포스트 없는 슬롯은 0으로 채움).
 */
export function analyzeTimePatterns(
  posts: CanonicalPost[],
): Record<TimeSlot, PerformanceMetrics> {
  // 4개 슬롯 초기화
  const slots: TimeSlot[] = ['새벽', '오전', '오후', '밤'];
  const groups: Record<TimeSlot, CanonicalPost[]> = {
    '새벽': [], '오전': [], '오후': [], '밤': [],
  };

  for (const post of posts) {
    if (!post.timestamp) continue;
    const kstHour = toKSTHour(post.timestamp);
    const slot = classifyTimeSlot(kstHour);
    groups[slot].push(post);
  }

  const result = {} as Record<TimeSlot, PerformanceMetrics>;

  for (const slot of slots) {
    const group = groups[slot];
    if (group.length === 0) {
      result[slot] = { avg_views: null, avg_likes: 0, avg_replies: 0, post_count: 0 };
      continue;
    }

    const likesSum = group.reduce((sum, p) => sum + (p.metrics?.like_count ?? 0), 0);
    const repliesSum = group.reduce((sum, p) => sum + (p.metrics?.reply_count ?? 0), 0);
    const validViews = group
      .map(p => p.metrics?.view_count)
      .filter((v): v is number => v !== null && v !== undefined);

    result[slot] = {
      avg_views: validViews.length > 0
        ? round1(validViews.reduce((a, b) => a + b, 0) / validViews.length)
        : null,
      avg_likes: round1(likesSum / group.length),
      avg_replies: round1(repliesSum / group.length),
      post_count: group.length,
    };
  }

  return result;
}
```

**Step 4: 모든 테스트 통과 확인**

Run: `npx vitest run scripts/__tests__/performance-analyzer.test.ts`
Expected: 10 tests pass

---

### Task 9: calcLearningDeltas — 성과 기반 학습 피드백 계산

**Files:**
- Modify: `scripts/__tests__/performance-analyzer.test.ts` (테스트 추가)
- Modify: `scripts/performance-analyzer.ts` (함수 추가)

**Step 1: 실패하는 테스트 추가**

```typescript
import { calcLearningDeltas } from '../performance-analyzer.js';

describe('calcLearningDeltas', () => {
  test('returns positive deltas for above-average engagement posts', () => {
    const overallAvgLikes = 5;
    // 10 > 5 → positive delta
    const deltas = calcLearningDeltas('prod_001', 10, overallAvgLikes);
    expect(deltas.naturalness_delta).toBeGreaterThan(0);
    expect(deltas.story_potential_delta).toBeGreaterThan(0);
  });

  test('returns negative deltas for below-average engagement posts', () => {
    const overallAvgLikes = 10;
    // 2 < 10 → negative delta
    const deltas = calcLearningDeltas('prod_001', 2, overallAvgLikes);
    expect(deltas.naturalness_delta).toBeLessThan(0);
    expect(deltas.story_potential_delta).toBeLessThan(0);
  });

  test('returns zero deltas for average engagement', () => {
    const deltas = calcLearningDeltas('prod_001', 5, 5);
    expect(deltas.naturalness_delta ?? 0).toBe(0);
    expect(deltas.story_potential_delta ?? 0).toBe(0);
  });

  test('clamps delta to [-2, 2]', () => {
    // 100배 차이가 나도 clamp
    const posDeltas = calcLearningDeltas('prod_001', 1000, 5);
    const negDeltas = calcLearningDeltas('prod_002', 1, 500);

    expect(posDeltas.naturalness_delta).toBeLessThanOrEqual(2);
    expect(negDeltas.naturalness_delta).toBeGreaterThanOrEqual(-2);
  });

  test('sets product_id correctly', () => {
    const deltas = calcLearningDeltas('my_product_id', 10, 5);
    expect(deltas.product_id).toBe('my_product_id');
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/performance-analyzer.test.ts`
Expected: FAIL — `calcLearningDeltas` not exported

**Step 3: calcLearningDeltas 구현**

```typescript
/**
 * 특정 제품의 평균 좋아요 vs 전체 평균 비교 → LearningEntry 델타 계산.
 * 전체 평균보다 2배 이상 높으면 +1, 1.5배 이상이면 +0.5
 * 전체 평균의 절반 이하면 -1, 70% 이하면 -0.5
 */
export function calcLearningDeltas(
  productId: string,
  productAvgLikes: number,
  overallAvgLikes: number,
): LearningEntry {
  if (overallAvgLikes === 0) {
    return { product_id: productId };
  }

  const ratio = productAvgLikes / overallAvgLikes;

  let delta = 0;
  if (ratio >= 2.0) delta = 1;
  else if (ratio >= 1.5) delta = 0.5;
  else if (ratio <= 0.5) delta = -1;
  else if (ratio <= 0.7) delta = -0.5;

  if (delta === 0) return { product_id: productId };

  // delta 클리핑 [-2, 2]
  const clampedDelta = clamp(delta, -2, 2);

  return {
    product_id: productId,
    naturalness_delta: clampedDelta || undefined,
    story_potential_delta: clampedDelta || undefined,
  };
}
```

**Step 4: 모든 테스트 통과 확인**

Run: `npx vitest run scripts/__tests__/performance-analyzer.test.ts`
Expected: 15 tests pass

---

### Task 10: performance-analyzer.ts main

**Files:**
- Modify: `scripts/performance-analyzer.ts` (main 함수 추가)

**Step 1: main 함수 + isMainModule 가드 추가**

```typescript
import fs from 'fs';
import path from 'path';
import type { CanonicalOutput, AnalysisReport } from './types.js';
import { validateLearnings } from './product-matcher.js';

const CANONICAL_PATH = path.join(__dirname, '..', 'data', 'canonical', 'posts.json');
const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');
const LEARNINGS_PATH = path.join(__dirname, '..', 'data', 'learnings', 'latest.json');

function main(): void {
  const today = new Date().toISOString().slice(0, 10);

  // canonical/posts.json 로드
  let canonicalData: CanonicalOutput;
  try {
    canonicalData = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf8'));
  } catch {
    console.error(`Canonical posts not found: ${CANONICAL_PATH}`);
    console.error(`Run normalize-posts.ts first.`);
    process.exit(1);
  }

  const posts = canonicalData.posts;
  console.log(`Analyzing ${posts.length} posts...`);

  // 포맷별 참여도
  const formatPerf = calcEngagementStats(posts);

  // 시간대별 패턴
  const timePerf = analyzeTimePatterns(posts);

  // 상위 성과 포스트 (like_count 기준 top 10)
  const topPosts = [...posts]
    .filter(p => p.metrics)
    .sort((a, b) => (b.metrics?.like_count ?? 0) - (a.metrics?.like_count ?? 0))
    .slice(0, 10)
    .map(p => ({
      post_id: p.post_id,
      channel_id: p.channel_id,
      views: p.metrics?.view_count ?? null,
      likes: p.metrics?.like_count ?? 0,
      tag: p.tags?.primary ?? 'general',
    }));

  // 전체 평균 좋아요
  const allLikes = posts
    .filter(p => p.metrics)
    .map(p => p.metrics!.like_count);
  const overallAvgLikes = allLikes.length > 0
    ? allLikes.reduce((a, b) => a + b, 0) / allLikes.length
    : 0;

  // 채널별 학습 델타 계산 (product_id 역추적 불가 → channel 기반)
  const channelGroups = new Map<string, typeof posts>();
  for (const post of posts) {
    const ch = post.channel_id;
    const group = channelGroups.get(ch) || [];
    group.push(post);
    channelGroups.set(ch, group);
  }

  const learningDeltas: LearningEntry[] = [];
  for (const [channelId, chPosts] of channelGroups) {
    const avgLikes = chPosts.reduce((sum, p) => sum + (p.metrics?.like_count ?? 0), 0) / chPosts.length;
    const delta = calcLearningDeltas(channelId, avgLikes, overallAvgLikes);
    if (delta.naturalness_delta !== undefined || delta.story_potential_delta !== undefined) {
      learningDeltas.push(delta);
    }
  }

  // 날짜 범위 계산
  const timestamps = posts.map(p => p.timestamp).filter(Boolean).sort();
  const dateRange = {
    from: timestamps[0]?.slice(0, 10) ?? today,
    to: timestamps[timestamps.length - 1]?.slice(0, 10) ?? today,
  };

  const report: AnalysisReport = {
    date: today,
    format_performance: formatPerf,
    time_performance: timePerf,
    top_performing_posts: topPosts,
    learning_deltas: learningDeltas,
    meta: {
      posts_analyzed: posts.length,
      date_range: dateRange,
      generated_at: new Date().toISOString(),
    },
  };

  // analysis_report.json atomic write
  const reportPath = path.join(BRIEFS_DIR, `${today}_analysis_report.json`);
  const tmpReport = reportPath + '.tmp';
  fs.writeFileSync(tmpReport, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(tmpReport, reportPath);

  // learnings/latest.json 병합
  let existingLearnings: LearningEntry[] = [];
  try {
    const existing = JSON.parse(fs.readFileSync(LEARNINGS_PATH, 'utf8'));
    existingLearnings = validateLearnings(existing.learnings || existing);
  } catch {
    console.warn(`Existing learnings not found, creating new: ${LEARNINGS_PATH}`);
  }

  // 병합: 같은 product_id면 delta 누적 (clamp)
  const learningsMap = new Map<string, LearningEntry>();
  for (const entry of existingLearnings) {
    learningsMap.set(entry.product_id, entry);
  }
  for (const delta of learningDeltas) {
    const existing = learningsMap.get(delta.product_id);
    if (existing) {
      // delta 누적 + clamp
      const merged: LearningEntry = {
        product_id: delta.product_id,
        naturalness_delta: clamp(
          (existing.naturalness_delta ?? 0) + (delta.naturalness_delta ?? 0), -2, 2
        ) || undefined,
        story_potential_delta: clamp(
          (existing.story_potential_delta ?? 0) + (delta.story_potential_delta ?? 0), -2, 2
        ) || undefined,
      };
      learningsMap.set(delta.product_id, merged);
    } else {
      learningsMap.set(delta.product_id, delta);
    }
  }

  const updatedLearnings = {
    version: '1.0',
    updated_at: today,
    learnings: Array.from(learningsMap.values()),
  };

  fs.mkdirSync(path.dirname(LEARNINGS_PATH), { recursive: true });
  const tmpLearnings = LEARNINGS_PATH + '.tmp';
  fs.writeFileSync(tmpLearnings, JSON.stringify(updatedLearnings, null, 2), 'utf8');
  fs.renameSync(tmpLearnings, LEARNINGS_PATH);

  // 요약 출력
  console.log(`\nAnalysis report: ${reportPath}`);
  console.log(`Learnings updated: ${LEARNINGS_PATH}`);
  console.log(`\n--- 성과 분석 요약 ---`);
  for (const [tag, metrics] of Object.entries(formatPerf)) {
    console.log(`  [${tag}] 평균 좋아요: ${metrics.avg_likes}, 포스트: ${metrics.post_count}개`);
  }
  console.log(`\n--- 시간대별 ---`);
  for (const [slot, metrics] of Object.entries(timePerf)) {
    console.log(`  [${slot}] 평균 좋아요: ${metrics.avg_likes}, 포스트: ${metrics.post_count}개`);
  }
  console.log(`\n학습 델타: ${learningDeltas.length}개`);
}

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('performance-analyzer.ts') ||
  process.argv[1].endsWith('performance-analyzer.js')
);
if (isMainModule) main();
```

**Step 2: tsc + 전체 테스트**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors, 15+ tests pass

**Step 3: 커밋**

```bash
git add scripts/performance-analyzer.ts scripts/__tests__/performance-analyzer.test.ts
git commit -m "feat(threads): implement P3-2 performance analyzer (engagement/time/learning)"
```

---

## Phase D: Pipeline Integration (비TDD)

### Task 11: run-pipeline.ts에 Step 6 + Step 7 추가

**Files:**
- Modify: `scripts/run-pipeline.ts`
- Modify: `package.json` (npm scripts 추가)

**Step 1: run-pipeline.ts 수정**

`main()` 함수에 Step 6, 7 추가:

```typescript
// -- 기존 args 파싱에 추가 --
const contentOnly = args.includes('--content-only');

// -- Step 5 (positioning) 이후에 추가 --

// Step 6: Content Generator (P3)
const ok6 = run(
  `npx tsx ${path.join(SCRIPTS_DIR, 'content-generator.ts')}${promptFlag}`,
  'Step 6: content-generator (positioning → content drafts)'
);
if (!ok6) { process.exit(1); }

if (contentOnly) {
  console.log('\n--content-only: stopping after content generator.');
  if (withBrief) generateBrief(today);
  process.exit(0);
}

// Step 7: Performance Analyzer (P3)
const ok7 = run(
  `npx tsx ${path.join(SCRIPTS_DIR, 'performance-analyzer.ts')}`,
  'Step 7: performance-analyzer (posts → analysis + learning)'
);
if (!ok7) { process.exit(1); }
```

`generateBrief()` 함수에 콘텐츠 초안 미리보기 섹션 추가:

```typescript
// 기존 포지셔닝 미리보기 블록 이후에 추가
const contentDraftsPath = path.join(BRIEFS_DIR, `${today}_content_drafts.json`);
let contentDrafts: ContentDraftOutput | null = null;
try { contentDrafts = JSON.parse(fs.readFileSync(contentDraftsPath, 'utf8')); }
catch { console.warn(`Content drafts not available: ${contentDraftsPath}`); }

if (contentDrafts && contentDrafts.drafts.length > 0) {
  lines.push('\n■ 콘텐츠 초안 미리보기');
  lines.push('─'.repeat(40));
  for (const draft of contentDrafts.drafts.slice(0, 3)) {
    lines.push(`[${draft.product_name}] ${draft.format}`);
    lines.push(`  훅: "${draft.hook}"`);
    lines.push(`  초안: "${draft.bodies[0].split('\n')[0]}..."`);
  }
}
```

`import` 블록에 `ContentDraftOutput` 추가:
```typescript
import type {
  ResearchBrief, NeedsMap, ProductMatchOutput, PositioningOutput, ContentDraftOutput
} from './types.js';
```

`console.log` outputs에 새 파일 경로 추가:
```typescript
console.log(`  Content:   data/briefs/${today}_content_drafts.json`);
console.log(`  Analysis:  data/briefs/${today}_analysis_report.json`);
```

**Step 2: package.json scripts 추가**

`package.json`의 `"scripts"` 섹션에 추가:

```json
"content": "tsx scripts/content-generator.ts",
"analyze": "tsx scripts/performance-analyzer.ts"
```

**Step 3: tsc + 전체 테스트**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors, all tests pass

**Step 4: 커밋**

```bash
git add scripts/run-pipeline.ts package.json
git commit -m "feat(threads): integrate P3 pipeline steps (content + performance) + npm scripts"
```

---

## Phase E: Final Verification

### Task 12: 전체 파이프라인 검증

**Step 1: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: 전체 테스트**

Run: `npx vitest run`
Expected: 85+ tests pass

출력 예시:
```
Test Files  5 passed (5)
Tests      85 passed (85)
```

**Step 3: pipeline 실행 (positioning까지만 — Step 5)**

Run: `npm run pipeline -- --needs-only --brief`
Expected: 정상 완료, brief 출력

**Step 4: content-generator 단독 실행**

Run: `npm run content`
Expected:
```
Content drafts: data/briefs/2026-03-14_content_drafts.json
총 N개 초안 생성
[제품명] 포맷
  훅: "..."
  초안: "..."
```

**Step 5: performance-analyzer 단독 실행**

Run: `npm run analyze`
Expected:
```
Analyzing 227 posts...
Analysis report: data/briefs/2026-03-14_analysis_report.json
Learnings updated: data/learnings/latest.json
--- 성과 분석 요약 ---
  [affiliate] 평균 좋아요: ..., 포스트: 224개
...
```

**Step 6: 최종 커밋 (필요 시)**

```bash
git add -p  # 변경사항 확인 후 스테이징
git commit -m "chore(threads): P3 implementation complete — content generator + performance analyzer"
```

---

## 요약

| Phase | Tasks | TDD | 예상 테스트 추가 |
|-------|-------|-----|-----------------|
| A: Types | 1 | No | 0 |
| B: Content Generator | 2-6 | Yes | +22 |
| C: Performance Analyzer | 7-10 | Yes | +15 |
| D: Pipeline Integration | 11 | No | 0 |
| E: Final Verification | 12 | — | — |
| **Total** | **12** | | **+37 (→85+)** |

**출력 파일 요약:**

| 파일 | 생성 시점 | 설명 |
|------|----------|------|
| `data/briefs/{today}_content_drafts.json` | Step 6 | 포맷별 본문 3개 + 훅 5개 + 댓글 2개 |
| `data/briefs/{today}_content_prompt.txt` | Step 6 `--prompt` | Claude Code LLM 강화용 |
| `data/briefs/{today}_analysis_report.json` | Step 7 | 포맷/시간대별 참여도 분석 |
| `data/learnings/latest.json` | Step 7 | 학습 피드백 (기존 파일에 병합) |
