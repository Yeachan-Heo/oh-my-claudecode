#!/usr/bin/env tsx
/**
 * analyze-categories.ts — 상품 DB 카테고리 분석 + 소비자 키워드 설계
 *
 * Phase 1: products_v1.json 카테고리별 분류 + 통계
 * Phase 2: 카테고리별 소비자 니즈 키워드 설계
 *
 * Usage:
 *   npx tsx scripts/analyze-categories.ts
 */

import fs from 'fs';
import path from 'path';

// ─── Config ──────────────────────────────────────────────

const PRODUCTS_PATH = path.join(__dirname, '..', 'data', 'product_dict', 'products_v1.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const KEYWORDS_OUTPUT_PATH = path.join(OUTPUT_DIR, 'consumer_keywords.json');

// ─── Types ───────────────────────────────────────────────

interface ProductEntry {
  product_id: string;
  name: string;
  category: string;
  needs_categories: string[];
  keywords: string[];
  affiliate_platform: string;
  price_range: string;
  description: string;
}

interface CategoryStats {
  category: string;
  product_count: number;
  products: Array<{ product_id: string; name: string; price_range: string }>;
  needs_distribution: Record<string, number>;
  price_ranges: string[];
  all_keywords: string[];
}

interface ConsumerKeyword {
  keyword: string;
  category: string;
  target_need: string;
  expected_post_type: string;
}

interface ConsumerKeywordPlan {
  category: string;
  keywords: ConsumerKeyword[];
}

// ─── Utility ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Phase 1: Category Analysis ─────────────────────────

function analyzeCategories(products: ProductEntry[]): CategoryStats[] {
  const categoryMap = new Map<string, ProductEntry[]>();

  for (const product of products) {
    const existing = categoryMap.get(product.category) || [];
    existing.push(product);
    categoryMap.set(product.category, existing);
  }

  const stats: CategoryStats[] = [];

  for (const [category, prods] of categoryMap) {
    const needsDist: Record<string, number> = {};
    const allKeywords: string[] = [];

    for (const p of prods) {
      for (const need of p.needs_categories) {
        needsDist[need] = (needsDist[need] || 0) + 1;
      }
      allKeywords.push(...p.keywords);
    }

    stats.push({
      category,
      product_count: prods.length,
      products: prods.map(p => ({
        product_id: p.product_id,
        name: p.name,
        price_range: p.price_range,
      })),
      needs_distribution: needsDist,
      price_ranges: prods.map(p => p.price_range),
      all_keywords: [...new Set(allKeywords)],
    });
  }

  // Sort by product count descending
  stats.sort((a, b) => b.product_count - a.product_count);
  return stats;
}

// ─── Phase 2: Consumer Keyword Design ───────────────────

function designConsumerKeywords(stats: CategoryStats[]): ConsumerKeywordPlan[] {
  /**
   * 핵심 원칙:
   * - 마케터 키워드(쿠팡파트너스, 제휴마케팅 등) 금지
   * - 소비자가 실제로 쓰는 질문/고민/추천요청 형태
   * - 카테고리별 3~5개 키워드
   */
  const keywordMap: Record<string, ConsumerKeyword[]> = {
    '건강식품': [
      { keyword: '영양제 추천', category: '건강식품', target_need: '불편해소', expected_post_type: '추천요청' },
      { keyword: '비타민 뭐먹어', category: '건강식품', target_need: '외모건강', expected_post_type: '질문' },
      { keyword: '피로 회복', category: '건강식품', target_need: '불편해소', expected_post_type: '고민공유' },
      { keyword: '유산균 효과', category: '건강식품', target_need: '불편해소', expected_post_type: '후기/질문' },
    ],
    '뷰티': [
      { keyword: '피부 트러블', category: '뷰티', target_need: '외모건강', expected_post_type: '고민공유' },
      { keyword: '선크림 추천', category: '뷰티', target_need: '외모건강', expected_post_type: '추천요청' },
      { keyword: '화장품 추천해줘', category: '뷰티', target_need: '외모건강', expected_post_type: '추천요청' },
      { keyword: '치아미백 후기', category: '뷰티', target_need: '외모건강', expected_post_type: '후기탐색' },
    ],
    '다이어트': [
      { keyword: '다이어트 식품', category: '다이어트', target_need: '외모건강', expected_post_type: '정보탐색' },
      { keyword: '살빠지는 간식', category: '다이어트', target_need: '외모건강', expected_post_type: '추천요청' },
      { keyword: '다이어트 고민', category: '다이어트', target_need: '불편해소', expected_post_type: '고민공유' },
    ],
    '운동': [
      { keyword: '홈트 추천', category: '운동', target_need: '성과향상', expected_post_type: '추천요청' },
      { keyword: '운동 후 회복', category: '운동', target_need: '불편해소', expected_post_type: '정보탐색' },
      { keyword: '헬스 초보', category: '운동', target_need: '성과향상', expected_post_type: '질문' },
    ],
    '생활용품': [
      { keyword: '로봇청소기 추천', category: '생활용품', target_need: '시간절약', expected_post_type: '추천요청' },
      { keyword: '공기청정기 추천', category: '생활용품', target_need: '불편해소', expected_post_type: '추천요청' },
      { keyword: '자취 필수템', category: '생활용품', target_need: '돈절약', expected_post_type: '정보공유' },
    ],
    '주방용품': [
      { keyword: '에어프라이어 추천', category: '주방용품', target_need: '시간절약', expected_post_type: '추천요청' },
      { keyword: '자취 요리템', category: '주방용품', target_need: '시간절약', expected_post_type: '정보탐색' },
      { keyword: '밀프렙 용기', category: '주방용품', target_need: '돈절약', expected_post_type: '추천요청' },
    ],
    '디지털': [
      { keyword: '무선이어폰 추천', category: '디지털', target_need: '성과향상', expected_post_type: '추천요청' },
      { keyword: '보조배터리 추천', category: '디지털', target_need: '불편해소', expected_post_type: '추천요청' },
      { keyword: '거북목 방지', category: '디지털', target_need: '불편해소', expected_post_type: '고민공유' },
    ],
    '인테리어': [
      { keyword: '방 꾸미기', category: '인테리어', target_need: '자기표현', expected_post_type: '영감탐색' },
      { keyword: '무드등 추천', category: '인테리어', target_need: '자기표현', expected_post_type: '추천요청' },
      { keyword: '향 디퓨저 추천', category: '인테리어', target_need: '자기표현', expected_post_type: '추천요청' },
    ],
    '유아': [
      { keyword: '이유식 추천', category: '유아', target_need: '불편해소', expected_post_type: '추천요청' },
      { keyword: '육아템 추천', category: '유아', target_need: '시간절약', expected_post_type: '추천요청' },
    ],
    '식품': [
      { keyword: '집에서 카페맛', category: '식품', target_need: '돈절약', expected_post_type: '정보공유' },
      { keyword: '단백질바 추천', category: '식품', target_need: '성과향상', expected_post_type: '추천요청' },
    ],
    '문구': [
      { keyword: '플래너 추천', category: '문구', target_need: '성과향상', expected_post_type: '추천요청' },
      { keyword: '만년필 입문', category: '문구', target_need: '자기표현', expected_post_type: '질문' },
    ],
    '향수/향': [
      { keyword: '향수 추천', category: '향수/향', target_need: '자기표현', expected_post_type: '추천요청' },
      { keyword: '좋은 향수', category: '향수/향', target_need: '자기표현', expected_post_type: '추천요청' },
    ],
    '의류': [
      { keyword: '여름 셔츠 추천', category: '의류', target_need: '자기표현', expected_post_type: '추천요청' },
      { keyword: '데일리 가방 추천', category: '의류', target_need: '자기표현', expected_post_type: '추천요청' },
    ],
  };

  const plans: ConsumerKeywordPlan[] = [];

  for (const stat of stats) {
    const keywords = keywordMap[stat.category];
    if (keywords && keywords.length > 0) {
      plans.push({
        category: stat.category,
        keywords,
      });
    }
  }

  return plans;
}

// ─── Main ────────────────────────────────────────────────

function main(): void {
  log('=== 상품 DB 카테고리 분석 시작 ===');

  // Load products
  const raw = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf-8'));
  const products: ProductEntry[] = raw.products;
  log(`상품 로드: ${products.length}개`);

  // Phase 1: Category analysis
  const categoryStats = analyzeCategories(products);
  log(`\n=== Phase 1: 카테고리 분석 ===`);
  log(`카테고리 ${categoryStats.length}개 발견\n`);

  for (const stat of categoryStats) {
    log(`[${stat.category}] 상품 ${stat.product_count}개`);
    for (const p of stat.products) {
      log(`  - ${p.name} (${p.price_range}원)`);
    }
    const needsStr = Object.entries(stat.needs_distribution)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}(${v})`)
      .join(', ');
    log(`  니즈 분포: ${needsStr}`);
    log('');
  }

  // Phase 2: Consumer keyword design
  const keywordPlans = designConsumerKeywords(categoryStats);
  log(`\n=== Phase 2: 소비자 키워드 설계 ===`);

  let totalKeywords = 0;
  for (const plan of keywordPlans) {
    log(`\n[${plan.category}]`);
    for (const kw of plan.keywords) {
      log(`  "${kw.keyword}" → ${kw.target_need} / ${kw.expected_post_type}`);
      totalKeywords++;
    }
  }
  log(`\n총 키워드: ${totalKeywords}개`);

  // Save keyword plan
  const output = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    total_categories: categoryStats.length,
    total_products: products.length,
    total_keywords: totalKeywords,
    category_stats: categoryStats,
    keyword_plans: keywordPlans,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(KEYWORDS_OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  log(`\n키워드 플랜 저장: ${KEYWORDS_OUTPUT_PATH}`);

  // Summary table
  log('\n=== 요약 ===');
  log('| 카테고리 | 상품수 | 키워드수 | 주요 니즈 |');
  log('|---------|--------|---------|----------|');
  for (const stat of categoryStats) {
    const plan = keywordPlans.find(p => p.category === stat.category);
    const kwCount = plan?.keywords.length || 0;
    const topNeed = Object.entries(stat.needs_distribution)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => k)
      .join(', ');
    log(`| ${stat.category} | ${stat.product_count} | ${kwCount} | ${topNeed} |`);
  }
}

main();
