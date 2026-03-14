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

import fs from 'fs';
import path from 'path';
import type {
  PositionVariant,
  PositionFormat,
  NeedsCategory,
  ContentDraft,
  ContentDraftOutput,
  PositioningOutput,
  PositioningCard,
  ProductMatchOutput,
  ProductMatch,
} from './types.js';
import { generateHook } from './positioning.js';
import { parsePriceMin } from './product-matcher.js';

const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');

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
  product: ProductMatch & { affiliate_link?: string },
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
  const affiliateLink = product.affiliate_link;
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

/**
 * PositioningCard + ProductMatch → ContentDraft 조립.
 * positions[0]을 주 포맷으로 사용.
 */
export function buildContentDraft(
  card: PositioningCard,
  product: ProductMatch & { affiliate_link?: string },
  problem: string,
): ContentDraft {
  // 포지션 없으면 기본 솔직후기형 fallback
  const primaryVariant: PositionVariant = card.positions[0] ?? {
    format: '솔직후기형' as PositionFormat,
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

// --- LLM 프롬프트 생성 ---

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

// --- Main ---

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

  // need_id별로 그룹핑 후 상위 3개 카드 선택
  const needGroups = new Map<string, PositioningCard[]>();
  for (const card of positioningData.positioning_cards) {
    const group = needGroups.get(card.need_id) || [];
    group.push(card);
    needGroups.set(card.need_id, group);
  }

  const drafts: ContentDraft[] = [];
  for (const [, cards] of needGroups) {
    // 니즈별 상위 3개 카드
    for (const card of cards.slice(0, 3)) {
      const product: ProductMatch & { affiliate_link?: string } = productMap.get(card.product_id) ?? {
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
  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
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
