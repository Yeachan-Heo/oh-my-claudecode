#!/usr/bin/env tsx
/**
 * positioning.ts — P2-2 포지셔닝 에이전트
 *
 * matched products → 판매 앵글, 톤, 훅 설계.
 * 각 니즈별 상위 3개 제품 × 3개 포맷 = PositioningOutput 생성.
 *
 * Usage:
 *   tsx scripts/positioning.ts
 *   tsx scripts/positioning.ts --prompt    # LLM 프롬프트도 생성
 */

import fs from 'fs';
import path from 'path';
import type {
  NeedsCategory,
  PositionFormat,
  PositionVariant,
  PositioningCard,
  PositioningOutput,
  ProductMatchOutput,
  ProductMatch,
} from './types.js';

const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');

// --- 포맷 라이브러리 ---

interface FormatDef {
  desc: string;
  angle_template: string;
  tone_desc: string;
  cta_style: string;
}

const FORMAT_DEFS: Record<PositionFormat, FormatDef> = {
  '문제공감형': {
    desc: '문제 먼저 → 해결책',
    angle_template: '이 문제 나만 겪는 줄 알았는데',
    tone_desc: '공감 → 발견 → 자연스런 소개',
    cta_style: '프로필 링크 유도',
  },
  '솔직후기형': {
    desc: '개인 경험 중심 솔직한 후기',
    angle_template: '{product} 써봤는데 솔직하게 말하면',
    tone_desc: '비격식 1인칭, 구어체, 장단점 모두',
    cta_style: '댓글에서 자연스럽게',
  },
  '비교형': {
    desc: '여러 개 써봤는데 하나만 남김',
    angle_template: '{product} 포함 3개 써봤는데 1개만 남김',
    tone_desc: '구체적 비교, 결론 먼저, 이유 나중',
    cta_style: '프로필 링크 유도',
  },
  '입문추천형': {
    desc: '처음 시작하는 사람 대상',
    angle_template: '{category} 처음이면 이거부터',
    tone_desc: '친절하고 명확, 진입장벽 낮춤',
    cta_style: '댓글에서 자연스럽게',
  },
  '실수방지형': {
    desc: '살 뻔했다가 확인하고 결정',
    angle_template: '{product} 사기 전에 이것만 확인해',
    tone_desc: '경고 → 기준 제시 → 추천',
    cta_style: 'DM 유도',
  },
  '비추천형': {
    desc: '솔직하게 별로였던 것 → 대안',
    angle_template: '이 카테고리 3개 써봤는데 {product}만 남김',
    tone_desc: '냉정하고 솔직, 대안 제시로 마무리',
    cta_style: '댓글에서 자연스럽게',
  },
};

// --- 카테고리별 포맷 우선순위 ---

export const CATEGORY_FORMATS: Record<NeedsCategory, PositionFormat[]> = {
  '불편해소': ['문제공감형', '솔직후기형', '실수방지형'],
  '시간절약': ['솔직후기형', '비교형', '입문추천형'],
  '돈절약':   ['비교형', '실수방지형', '솔직후기형'],
  '성과향상': ['입문추천형', '비교형', '솔직후기형'],
  '외모건강': ['문제공감형', '솔직후기형', '비추천형'],
  '자기표현': ['솔직후기형', '입문추천형', '문제공감형'],
};

// --- 훅 생성 ---

interface HookContext {
  format: PositionFormat;
  productName: string;
  needCategory: NeedsCategory;
  problem: string;
}

export function generateHook(ctx: HookContext): string {
  const { format, productName, needCategory, problem } = ctx;

  // 짧은 카테고리 라벨 (제품의 핵심 카테고리 키워드)
  const catLabel = needCategory;
  // 제품명에서 핵심 키워드 추출 (첫 2-3 어절)
  const productShort = productName.split(' ').slice(0, 2).join(' ');

  // deterministic: use product_id hash instead of Math.random for reproducibility
  const hash = productName.charCodeAt(0) + productName.length;
  const pick = hash % 2 === 0;

  switch (format) {
    case '문제공감형':
      return pick
        ? `${problem} 나만 그런 줄 알았는데`
        : `이거 때문에 스트레스받다가 하나 찾았음`;

    case '솔직후기형':
      return pick
        ? `${productShort} 한 달 써보고 솔직하게 말함`
        : `광고 아니고 내 돈 주고 산 ${productShort} 후기`;

    case '비교형':
      return pick
        ? `${productShort} 류 3개 다 써봤는데 1개만 남김`
        : `${productShort} vs 비슷한 거 결론부터 말하면`;

    case '입문추천형':
      return pick
        ? `${catLabel} 쪽 처음이면 이거 하나만 사봐`
        : `주변에서 ${productShort} 추천 요청 올 때마다 이거 알려줌`;

    case '실수방지형':
      return pick
        ? `${productShort} 사기 전에 이것만은 확인해`
        : `이거 모르고 샀다가 돈 버릴 뻔했음`;

    case '비추천형':
      return pick
        ? `솔직히 ${productShort} 종류 별로였던 것도 있음`
        : `이 카테고리 3개 써봤는데 2개는 돈 버렸음`;
  }
}

// --- 기본 avoid 리스트 ---

export const BASE_AVOID = ['최고의 제품', '꼭 사세요', '놓치면 후회', '협찬', '광고'];

// --- 포지셔닝 변형 생성 ---

export function buildVariant(
  format: PositionFormat,
  product: ProductMatch,
  needCategory: NeedsCategory,
  problem: string,
): PositionVariant {
  const def = FORMAT_DEFS[format];

  const angle = def.angle_template
    .replace('{product}', product.name)
    .replace('{category}', needCategory);

  const hook = generateHook({
    format,
    productName: product.name,
    needCategory,
    problem,
  });

  // 포맷별 추가 avoid
  const extraAvoid: Partial<Record<PositionFormat, string[]>> = {
    '비추천형': ['비추합니다', '구매 금지'],
    '솔직후기형': ['완벽한', '강력 추천'],
  };
  const avoid = [...BASE_AVOID, ...(extraAvoid[format] || [])];

  return {
    format,
    angle,
    tone: def.tone_desc,
    hook,
    avoid,
    cta_style: def.cta_style,
  };
}

// --- 제품별 포지셔닝 카드 생성 ---

function buildPositioningCard(
  product: ProductMatch,
  needId: string,
  needCategory: NeedsCategory,
  problem: string,
): PositioningCard {
  let formats = CATEGORY_FORMATS[needCategory];
  if (!formats) {
    console.warn(`Unknown needCategory: ${needCategory}, using 문제공감형 default`);
    formats = ['문제공감형', '솔직후기형', '비교형'];
  }

  const positions: PositionVariant[] = formats.map(fmt =>
    buildVariant(fmt, product, needCategory, problem)
  );

  return {
    product_id: product.product_id,
    product_name: product.name,
    need_id: needId,
    positions,
  };
}

// --- LLM 프롬프트 생성 ---

function generateLLMPrompt(matchOutput: ProductMatchOutput, cards: PositioningCard[]): string {
  const sampleCards = cards.slice(0, 5).map(c => ({
    product: c.product_name,
    need: c.need_id,
    formats: c.positions.map(p => p.format),
    sample_hook: c.positions[0]?.hook,
  }));

  return `당신은 Threads 콘텐츠 포지셔닝 전문가입니다. 아래 제품들에 대해 Threads에 어울리는 판매 앵글과 훅을 설계하세요.

## 분석 대상 제품 (${matchOutput.matches.length}개 니즈)
${matchOutput.matches.map(m => `
### ${m.need_category} — ${m.need_problem}
상위 제품: ${m.products.slice(0, 3).map(p => `${p.name}(${p.threads_score.total.toFixed(1)}점)`).join(', ')}
`).join('')}

## 규칙 기반 사전 분석 결과 (샘플)
${JSON.stringify(sampleCards, null, 2)}

## Threads 톤 가이드라인
- 짧은 문장 (1-3줄)
- 날것의 느낌 (연마된 광고 카피 금지)
- 1인칭 경험 ("내가 써봤는데")
- 공감 먼저, 추천 나중
- 소프트 CTA ("궁금하면 프로필 링크")

## 포맷 (택3)
문제공감형 | 솔직후기형 | 비교형 | 입문추천형 | 실수방지형 | 비추천형

## 요구 출력 (JSON)
{
  "positioning_cards": [
    {
      "product_id": "...",
      "product_name": "...",
      "need_id": "...",
      "positions": [
        {
          "format": "문제공감형",
          "angle": "접근 앵글 설명",
          "tone": "어조 설명",
          "hook": "스크롤 멈추는 첫 문장",
          "avoid": ["피해야 할 표현"],
          "cta_style": "프로필 링크 유도 | 댓글에서 자연스럽게 | DM 유도"
        }
      ]
    }
  ]
}

## 규칙
- hook은 20자 이내 한국어, 자연스럽게
- avoid에 "협찬", "광고", "최고의 제품" 항상 포함
- 광고 냄새 없이 실제 경험담처럼
- 최대 800 토큰`;
}

// --- Main ---

function main(): void {
  const args = process.argv.slice(2);
  const generatePrompt = args.includes('--prompt');

  const today = new Date().toISOString().slice(0, 10);

  // Load product match output
  const productsPath = path.join(BRIEFS_DIR, `${today}_products.json`);
  let matchOutput: ProductMatchOutput;
  try {
    matchOutput = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
  } catch {
    console.error(`Products file not found: ${productsPath}`);
    console.error(`Run product-matcher.ts first.`);
    process.exit(1);
  }

  console.log(`Generating positioning for ${matchOutput.matches.length} needs...`);

  const cards: PositioningCard[] = [];

  for (const match of matchOutput.matches) {
    // 니즈별 상위 3개 제품 (threads_score.total 내림차순)
    const top3 = [...match.products]
      .sort((a, b) => b.threads_score.total - a.threads_score.total)
      .slice(0, 3);

    for (const product of top3) {
      const card = buildPositioningCard(
        product,
        match.need_id,
        match.need_category,
        match.need_problem,
      );
      cards.push(card);
    }
  }

  const output: PositioningOutput = {
    date: today,
    positioning_cards: cards,
    meta: {
      products_input: matchOutput.matches.reduce((sum, m) => sum + m.products.length, 0),
      cards_generated: cards.length,
      generated_at: new Date().toISOString(),
    },
  };

  // Atomic write
  const outPath = path.join(BRIEFS_DIR, `${today}_positioning.json`);
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(tmpPath, outPath);

  // Generate LLM prompt
  if (generatePrompt) {
    const prompt = generateLLMPrompt(matchOutput, cards);
    const promptPath = path.join(BRIEFS_DIR, `${today}_positioning_prompt.txt`);
    fs.writeFileSync(promptPath, prompt, 'utf8');
    console.log(`  LLM prompt: ${promptPath}`);
  }

  // Print summary
  console.log(`\nPositioning output: ${outPath}`);
  console.log(`\n--- 포지셔닝 결과 ---`);

  for (const match of matchOutput.matches) {
    console.log(`\n[${match.need_category}] ${match.need_problem}`);
    const matchCards = cards.filter(c => c.need_id === match.need_id);
    for (const card of matchCards) {
      console.log(`  제품: ${card.product_name}`);
      for (const pos of card.positions) {
        console.log(`    [${pos.format}] ${pos.hook}`);
      }
    }
  }

  console.log(`\n총 ${cards.length}개 카드 생성 (니즈 ${matchOutput.matches.length}개 × 상위 3제품 × 3포맷)`);
}

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('positioning.ts') ||
  process.argv[1].endsWith('positioning.js')
);
if (isMainModule) main();
