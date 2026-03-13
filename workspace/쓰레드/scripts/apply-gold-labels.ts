#!/usr/bin/env tsx
/**
 * apply-gold-labels.ts
 * eval 세트 30개 포스트에 gold label 적용 (수동 분석 결과).
 *
 * Usage: tsx scripts/apply-gold-labels.ts
 */

import fs from 'fs';
import path from 'path';
import type { EvalSet, GoldLabel } from './types.js';

const EVAL_PATH = path.join(__dirname, '..', 'data', 'eval', 'eval_set_v1.json');

// --- Gold labels (human-reviewed, verified against current eval_set_v1 posts 2026-03-13) ---
// FROZEN: Do NOT rebuild eval set. Use update-eval-tags.ts for classifier iterations.
const GOLD_LABELS: Record<string, GoldLabel> = {
  'E-001': {
    primary_tag: 'interest',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: '자기표현',
    confidence: 'high',
    notes: '전시 추천 콘텐츠 (스하리프로젝트)',
  },
  'E-002': {
    primary_tag: 'affiliate',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '토스쇼핑 쉐어링크 수수료 명시',
  },
  'E-003': {
    primary_tag: 'affiliate',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '"광고" 명시, 양배추 계란찜 제품',
  },
  'E-004': {
    primary_tag: 'interest',
    secondary_tags: ['review'],
    purchase_signal_level: null,
    needs_category: '시간절약',
    confidence: 'high',
    notes: '다이소 오리 메이커 활용 레시피 공유',
  },
  'E-005': {
    primary_tag: 'interest',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: '외모건강',
    confidence: 'medium',
    notes: '다이어트 긍정 경험 공유',
  },
  'E-006': {
    primary_tag: 'affiliate',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '인증된 계정, 인스타 링크 유도',
  },
  'E-007': {
    primary_tag: 'purchase_signal',
    secondary_tags: ['complaint'],
    purchase_signal_level: 'L2',
    needs_category: '불편해소',
    confidence: 'high',
    notes: '태아보험 탐색 질문, 불만도 있으나 주 의도는 정보 탐색',
  },
  'E-008': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '뉴스/시사 속보 (트럼프-이란)',
  },
  'E-009': {
    primary_tag: 'affiliate',
    secondary_tags: ['review'],
    purchase_signal_level: null,
    needs_category: '외모건강',
    confidence: 'high',
    notes: '인증된 계정, 삶의질 상승템 3가지 추천',
  },
  'E-010': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'medium',
    notes: 'shop_ovor 유리컵 취향 표현, 짧은 텍스트로 상업 의도 불명확',
  },
  'E-011': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'medium',
    notes: '타로 재회 조언 콘텐츠, 상업 의도 약함',
  },
  'E-012': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '일상 잡담 (스타벅스 줄)',
  },
  'E-013': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'medium',
    notes: '사진클래스 자기 기획, 추천이 아닌 자기 계획',
  },
  'E-014': {
    primary_tag: 'affiliate',
    secondary_tags: ['interest'],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '인증된 계정, 무인양품 추천 리스트',
  },
  'E-015': {
    primary_tag: 'affiliate',
    secondary_tags: ['interest'],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '답글에 link.coupang.com, 김치전 과자 흥분형 어필리에이트',
  },
  'E-016': {
    primary_tag: 'affiliate',
    secondary_tags: ['interest'],
    purchase_signal_level: null,
    needs_category: '외모건강',
    confidence: 'high',
    notes: '답글에 link.coupang.com, 메이크업 정보형 어필리에이트',
  },
  'E-017': {
    primary_tag: 'affiliate',
    secondary_tags: ['review'],
    purchase_signal_level: null,
    needs_category: '외모건강',
    confidence: 'high',
    notes: '답글에 link.coupang.com, 다이어트 체험형 어필리에이트 (위고비 비교)',
  },
  'E-018': {
    primary_tag: 'affiliate',
    secondary_tags: ['interest'],
    purchase_signal_level: null,
    needs_category: '외모건강',
    confidence: 'high',
    notes: '답글에 link.coupang.com, 레시피형 어필리에이트',
  },
  'E-019': {
    primary_tag: 'affiliate',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '쿠팡파트너스 수수료 명시 + link.coupang.com',
  },
  'E-020': {
    primary_tag: 'affiliate',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '[광고] 명시, 역대최저가 드레싱, 쿠팡 링크',
  },
  'E-021': {
    primary_tag: 'complaint',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: '돈절약',
    confidence: 'high',
    notes: 'LA갈비 마블링 없음 불만, 판매처 클레임',
  },
  'E-022': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'medium',
    notes: 'shop_ovor 자기 사업 근황 + 명절 질문 이야기',
  },
  'E-023': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '팔로워 감소 이야기, 일상 잡담',
  },
  'E-024': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '돼지갈비 파스타 일상 음식 일기',
  },
  'E-025': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '남편 핸드폰 이야기, 일상 잡담',
  },
  'E-026': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'medium',
    notes: '타로 재회 조언 콘텐츠, 심리 분석 게시물',
  },
  'E-027': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '관상/소개팅 일상 이야기',
  },
  'E-028': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'high',
    notes: '휴대폰 중독 일상 반성',
  },
  'E-029': {
    primary_tag: 'general',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: null,
    confidence: 'medium',
    notes: '블로그 글쓰기 클래스 링크 공유, 자기홍보 가능성 있으나 명확하지 않음',
  },
  'E-030': {
    primary_tag: 'interest',
    secondary_tags: [],
    purchase_signal_level: null,
    needs_category: '자기표현',
    confidence: 'high',
    notes: '향 추천 콘텐츠 (스하리프로젝트)',
  },
};

function main(): void {
  const evalSet: EvalSet = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));

  let applied = 0;
  for (const post of evalSet.posts) {
    const label = GOLD_LABELS[post.eval_id];
    if (label) {
      post.gold_label = label;
      applied++;
    }
  }

  evalSet.meta.labeling_status = 'complete';

  // Atomic write
  const tmpPath = EVAL_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(evalSet, null, 2), 'utf8');
  fs.renameSync(tmpPath, EVAL_PATH);

  console.log(`Gold labels applied: ${applied}/${evalSet.posts.length}`);

  // Stats
  const tags: Record<string, number> = {};
  const needs: Record<string, number> = {};
  let withSignal = 0;
  for (const post of evalSet.posts) {
    const t = post.gold_label.primary_tag || 'unknown';
    tags[t] = (tags[t] || 0) + 1;
    if (post.gold_label.needs_category) {
      needs[post.gold_label.needs_category] = (needs[post.gold_label.needs_category] || 0) + 1;
    }
    if (post.gold_label.purchase_signal_level) withSignal++;
  }

  console.log('\nTag distribution:');
  for (const [tag, count] of Object.entries(tags).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag}: ${count}`);
  }
  console.log(`\nWith purchase signal: ${withSignal}`);
  console.log('\nNeeds distribution:');
  for (const [need, count] of Object.entries(needs).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${need}: ${count}`);
  }
}

main();
