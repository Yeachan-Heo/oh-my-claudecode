#!/usr/bin/env tsx
/**
 * product-matcher.ts — P2-1 상품매칭 에이전트
 *
 * needs_map (needs-detector.ts 출력) + 상품사전 → Threads 적합도 기반 매칭 결과 생성.
 * 각 니즈에 대해 후보 상품을 찾고 5개 기준으로 Threads 적합도를 채점.
 *
 * Usage:
 *   tsx scripts/product-matcher.ts
 *   tsx scripts/product-matcher.ts --prompt    # LLM 프롬프트도 생성
 */

import fs from 'fs';
import path from 'path';
import type {
  NeedItem,
  NeedsCategory,
  ProductEntry,
  ProductMatch,
  ProductMatchOutput,
  ThreadsScore,
  AffiliatePlatform,
  LearningEntry,
} from './types.js';

const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');
const PRODUCT_DICT_PATH = path.join(__dirname, '..', 'data', 'product_dict', 'products_v1.json');
const LEARNINGS_PATH = path.join(__dirname, '..', 'data', 'learnings', 'latest.json');

// --- Threads 적합도 채점 ---

/**
 * 상품을 5개 기준으로 채점 (rule-based, 1-5 scale).
 * 가중평균: naturalness:0.25, clarity:0.2, ad_smell:0.25, repeatability:0.15, story_potential:0.15
 */
export function scoreThreadsFitness(
  product: ProductEntry,
  need: NeedItem,
  keywordMatchCount: number,
  learnings: LearningEntry[]
): ThreadsScore {
  // 가격 파싱 (예: "15000-29000", "30000", "under 20000")
  const priceMin = parsePriceMin(product.price_range);

  // Base scores (3 = neutral)
  let naturalness = 3;
  let clarity = 3;
  let ad_smell = 3;
  let repeatability = 3;
  let story_potential = 3;

  // 가격 낮을수록 naturalness +0.5 (진입장벽 낮음)
  if (priceMin !== null && priceMin < 30000) {
    naturalness += 0.5;
  }

  // 외모건강/불편해소 카테고리는 story_potential +0.5 (경험 콘텐츠 풍부)
  if (
    product.needs_categories.includes('외모건강') ||
    product.needs_categories.includes('불편해소')
  ) {
    story_potential += 0.5;
  }

  // L3 이상 신호 강도의 니즈는 clarity +0.5 (문제가 명확함)
  const signalLevel = parseInt((need.signal_strength || 'L0').replace('L', ''));
  if (signalLevel >= 3) {
    clarity += 0.5;
  }

  // 키워드 매칭 많을수록 repeatability 향상
  if (keywordMatchCount >= 3) {
    repeatability += 1;
  } else if (keywordMatchCount >= 1) {
    repeatability += 0.5;
  }

  // 구매 연결성 높으면 clarity/naturalness 보너스
  if (need.purchase_linkage === '상') {
    clarity += 0.5;
    naturalness += 0.3;
  }

  // 자기표현 카테고리는 ad_smell 낮음 (취향 아이템 = 광고처럼 안 보임)
  if (product.needs_categories.includes('자기표현')) {
    ad_smell += 0.5;
  }

  // 불편해소는 공감 콘텐츠로 자연스럽게 소개 가능
  if (product.needs_categories.includes('불편해소')) {
    naturalness += 0.3;
  }

  // 학습 피드백 반영 (learnings에 같은 상품 ID 있으면 조정)
  for (const learning of learnings) {
    if (learning.product_id === product.product_id) {
      naturalness += learning.naturalness_delta || 0;
      clarity += learning.clarity_delta || 0;
      ad_smell += learning.ad_smell_delta || 0;
      repeatability += learning.repeatability_delta || 0;
      story_potential += learning.story_potential_delta || 0;
    }
  }

  // 클리핑 1-5
  naturalness = clamp(naturalness, 1, 5);
  clarity = clamp(clarity, 1, 5);
  ad_smell = clamp(ad_smell, 1, 5);
  repeatability = clamp(repeatability, 1, 5);
  story_potential = clamp(story_potential, 1, 5);

  const total =
    naturalness * 0.25 +
    clarity * 0.2 +
    ad_smell * 0.25 +
    repeatability * 0.15 +
    story_potential * 0.15;

  return {
    naturalness: round1(naturalness),
    clarity: round1(clarity),
    ad_smell: round1(ad_smell),
    repeatability: round1(repeatability),
    story_potential: round1(story_potential),
    total: round1(total),
  };
}

// --- 경쟁도 산정 ---
// 같은 니즈를 타겟하는 상품 수 기반
export function assessCompetition(matchCount: number): '상' | '중' | '하' {
  if (matchCount >= 6) return '상';
  if (matchCount >= 3) return '중';
  return '하';
}

// --- 키워드 매칭 점수 ---
export function countKeywordMatches(product: ProductEntry, expressions: string[]): number {
  const lowerExprs = expressions.map(e => e.toLowerCase());
  let count = 0;
  for (const kw of product.keywords) {
    if (kw.length < 2) continue; // 1글자 키워드 무시
    const kwLower = kw.toLowerCase();
    for (const expr of lowerExprs) {
      if (expr.includes(kwLower)) {
        count++;
        break;
      }
    }
  }
  return count;
}

// --- 매칭 이유 생성 ---
function buildWhyString(
  product: ProductEntry,
  need: NeedItem,
  keywordMatchCount: number,
  score: ThreadsScore
): string {
  const parts: string[] = [];

  parts.push(`needs_category=${need.category}`);

  if (keywordMatchCount > 0) {
    parts.push(`keyword_match=${keywordMatchCount}개`);
  }

  if (score.total >= 4) {
    parts.push('high_threads_fit');
  } else if (score.total >= 3) {
    parts.push('mid_threads_fit');
  }

  if (need.purchase_linkage === '상') {
    parts.push('strong_purchase_signal');
  }

  const priceMin = parsePriceMin(product.price_range);
  if (priceMin !== null && priceMin < 30000) {
    parts.push('low_price_barrier');
  }

  return parts.join(', ');
}

// --- 니즈별 상품 매칭 ---
function matchProductsForNeed(
  need: NeedItem,
  products: ProductEntry[],
  learnings: LearningEntry[]
): ProductMatch[] {
  // 1. needs_categories가 need.category를 포함하는 상품 필터
  const candidates = products.filter(p =>
    p.needs_categories.includes(need.category)
  );

  if (candidates.length === 0) return [];

  const competition = assessCompetition(candidates.length);

  // 2. 각 상품 채점
  const scored = candidates.map(product => {
    const keywordMatchCount = countKeywordMatches(product, need.representative_expressions);
    const threads_score = scoreThreadsFitness(product, need, keywordMatchCount, learnings);
    const why = buildWhyString(product, need, keywordMatchCount, threads_score);

    return {
      product_id: product.product_id,
      name: product.name,
      affiliate_platform: product.affiliate_platform,
      price_range: product.price_range,
      threads_score,
      competition,
      priority: 0, // filled below
      why,
      _sortKey: threads_score.total + keywordMatchCount * 0.1, // tiebreak on keyword hits
    };
  });

  // 3. 내림차순 정렬 후 priority 부여
  scored.sort((a, b) => b._sortKey - a._sortKey);

  return scored.map((s, idx) => {
    const { _sortKey: _, ...rest } = s;
    return { ...rest, priority: idx + 1 };
  });
}

// --- LLM prompt for deeper product analysis ---
function generateLLMPrompt(
  needs: NeedItem[],
  products: ProductEntry[],
  output: ProductMatchOutput
): string {
  const topNeeds = needs.slice(0, 5).map(n => ({
    id: n.need_id,
    category: n.category,
    problem: n.problem,
    signal: n.signal_strength,
    expressions: n.representative_expressions.slice(0, 2),
    linkage: n.purchase_linkage,
  }));

  const topMatches = output.matches.slice(0, 4).map(m => ({
    need: m.need_id,
    top_products: m.products.slice(0, 3).map(p => ({
      name: p.name,
      score: p.threads_score.total,
      naturalness: p.threads_score.naturalness,
      ad_smell: p.threads_score.ad_smell,
    })),
  }));

  return `당신은 제휴마케팅 콘텐츠 전략가입니다. Threads 채널에 어울리는 상품 매칭 결과를 검증/개선하세요.

## 분석된 니즈 (상위 5개)
${JSON.stringify(topNeeds, null, 0)}

## 상품 사전 (${products.length}개)
${JSON.stringify(
  products.map(p => ({
    id: p.product_id,
    name: p.name,
    cats: p.needs_categories,
    kw: p.keywords.slice(0, 4),
    price: p.price_range,
  })),
  null,
  0
)}

## 규칙 기반 매칭 결과 (검토용)
${JSON.stringify(topMatches, null, 0)}

## Threads 적합도 기준
- naturalness (0.25): Threads에서 자연스럽게 소개 가능한가
- clarity (0.2): "이게 왜 필요해" 한 줄 설명 가능한가
- ad_smell (0.25): 광고처럼 느껴지지 않는가 (높을수록 좋음)
- repeatability (0.15): 여러 각도에서 이야기 가능한가
- story_potential (0.15): 경험 기반 콘텐츠 만들기 쉬운가

## 요구 출력 (JSON)
{
  "improved_matches": [
    {
      "need_id": "니즈ID",
      "recommended_products": [
        {
          "product_id": "ID",
          "adjusted_scores": {
            "naturalness": 1-5,
            "clarity": 1-5,
            "ad_smell": 1-5,
            "repeatability": 1-5,
            "story_potential": 1-5
          },
          "content_angle": "이 상품을 어떤 스토리로 소개할지",
          "why_threads_fit": "Threads에 어울리는 이유"
        }
      ]
    }
  ],
  "overall_strategy": "전체 상품 포트폴리오 전략 한 줄 요약"
}

## 규칙
- 규칙 기반 점수 대비 ±1 이상 조정 시 반드시 이유 명시
- 각 니즈에 최대 3개 상품만 추천
- 광고 냄새(ad_smell)가 3 미만인 상품은 제외 권장
- 최대 800 토큰`;
}

// --- Utility ---

export function parsePriceMin(priceRange: string): number | null {
  if (!priceRange) return null;
  // 형식: "15000-29000", "30000", "under 20000", "20,000원"
  const cleaned = priceRange.replace(/[,원]/g, '').replace(/under\s*/i, '');
  const nums = cleaned.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  return parseInt(nums[0]);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// --- Validation ---

export function validateProductDict(data: unknown): asserts data is { products: ProductEntry[] } {
  if (!data || typeof data !== 'object') throw new Error('Product dict: expected object');
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.products)) throw new Error('Product dict: missing or invalid "products" array');
}

// --- Learnings loader ---

export function loadLearnings(filePath: string): LearningEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const learnings = data.learnings || data || [];
    if (Array.isArray(learnings)) return learnings;
    console.warn(`Learnings: expected array, got ${typeof learnings}`);
    return [];
  } catch {
    console.warn(`Learnings not loaded from ${filePath} (optional)`);
    return [];
  }
}

// --- Main ---

function main(): void {
  const args = process.argv.slice(2);
  const generatePrompt = args.includes('--prompt');

  const today = new Date().toISOString().slice(0, 10);

  // Load needs map
  const needsPath = path.join(BRIEFS_DIR, `${today}_needs.json`);
  let needsData: { needs_map: NeedItem[]; priority_ranking: string[] };
  try {
    needsData = JSON.parse(fs.readFileSync(needsPath, 'utf8'));
  } catch {
    console.error(`Needs map not found: ${needsPath}`);
    console.error(`Run needs-detector.ts first.`);
    process.exit(1);
  }

  // Load product dictionary
  let productDict: { version?: string; products: ProductEntry[] };
  try {
    const rawDict = JSON.parse(fs.readFileSync(PRODUCT_DICT_PATH, 'utf8'));
    validateProductDict(rawDict);
    productDict = rawDict;
  } catch (err) {
    console.error(`Product dictionary error: ${(err as Error).message}`);
    console.error(`Create data/product_dict/products_v1.json first.`);
    process.exit(1);
  }

  // Load optional learnings
  const learnings = loadLearnings(LEARNINGS_PATH);
  if (learnings.length > 0) {
    console.log(`Learnings loaded: ${learnings.length} entries`);
  }

  const products: ProductEntry[] = productDict.products || [];
  const needs: NeedItem[] = needsData.needs_map || [];

  console.log(`Matching ${needs.length} needs against ${products.length} products...`);

  // Sort needs by priority_ranking order
  const priorityIndex: Record<string, number> = {};
  for (const [i, needId] of (needsData.priority_ranking || []).entries()) {
    priorityIndex[needId] = i;
  }
  const sortedNeeds = [...needs].sort((a, b) => {
    const ai = priorityIndex[a.need_id] ?? 999;
    const bi = priorityIndex[b.need_id] ?? 999;
    return ai - bi;
  });

  // Match products for each need
  let totalMatched = 0;
  const matches: ProductMatchOutput['matches'] = [];

  for (const need of sortedNeeds) {
    const productMatches = matchProductsForNeed(need, products, learnings);
    totalMatched += productMatches.length;

    matches.push({
      need_id: need.need_id,
      need_category: need.category,
      need_problem: need.problem,
      products: productMatches,
    });
  }

  const output: ProductMatchOutput = {
    date: today,
    matches,
    meta: {
      product_dict_version: productDict.version || '1.0',
      needs_input_count: needs.length,
      products_matched: totalMatched,
      generated_at: new Date().toISOString(),
    },
  };

  // Write output (atomic)
  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const outPath = path.join(BRIEFS_DIR, `${today}_products.json`);
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(tmpPath, outPath);

  // Generate LLM prompt
  if (generatePrompt) {
    const prompt = generateLLMPrompt(sortedNeeds, products, output);
    const promptPath = path.join(BRIEFS_DIR, `${today}_products_prompt.txt`);
    fs.writeFileSync(promptPath, prompt, 'utf8');
    console.log(`  LLM prompt: ${promptPath}`);
  }

  // Print summary
  console.log(`\nProduct matches: ${outPath}`);
  console.log(`\n--- 상품 매칭 결과 ---`);
  for (const m of matches) {
    const topProduct = m.products[0];
    if (topProduct) {
      console.log(
        `  [${m.need_category}] ${m.need_id} — 매칭:${m.products.length}개, ` +
        `최고: "${topProduct.name}" (score:${topProduct.threads_score.total}, 경쟁:${topProduct.competition})`
      );
    } else {
      console.log(`  [${m.need_category}] ${m.need_id} — 매칭 없음`);
    }
  }
  console.log(`\n총 매칭: ${totalMatched}건 (${needs.length}개 니즈)`);
}

// Only run when executed directly (not imported)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('product-matcher.ts') ||
  process.argv[1].endsWith('product-matcher.js')
);
if (isMainModule) main();
