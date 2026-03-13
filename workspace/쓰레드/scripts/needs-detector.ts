#!/usr/bin/env tsx
/**
 * needs-detector.ts — P1-2 니즈탐지 에이전트
 *
 * research brief + canonical posts → needs map JSON 생성.
 * 구매신호가 있는 포스트를 "사람들이 해결하고 싶은 문제" 단위로 재분류.
 *
 * Usage:
 *   tsx scripts/needs-detector.ts
 *   tsx scripts/needs-detector.ts --prompt    # LLM 프롬프트도 생성
 */

import fs from 'fs';
import path from 'path';
import type { CanonicalPost, NeedsCategory, PurchaseLinkage, NeedItem } from './types.js';

const CANONICAL_PATH = path.join(__dirname, '..', 'data', 'canonical', 'posts.json');
const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');
const TAXONOMY_PATH = path.join(__dirname, '..', 'data', 'taxonomy.json');

// --- 니즈 카테고리 정의 (plan2.md) ---
interface CategoryDef {
  desc: string;
  keywords: string[];
  examples: string[];
}

const NEEDS_CATEGORIES: Record<NeedsCategory, CategoryDef> = {
  '불편해소': {
    desc: '현재 겪는 고통 제거',
    keywords: ['안되', '못하', '힘들', '불편', '짜증', '스트레스', '졸리', '피곤', '아프', '아파'],
    examples: ['집중 안 됨', '잠이 얕음', '허리 아픔'],
  },
  '시간절약': {
    desc: '귀찮은 걸 빠르게',
    keywords: ['시간', '빠르', '자동', '간편', '귀찮', '한번에', '쉽게', '편하', '레시피', '만들기', '활용'],
    examples: ['회의록 정리', '요리 시간 절약', '청소 자동화'],
  },
  '돈절약': {
    desc: '더 싸게, 가성비',
    keywords: ['가성비', '싸게', '최저가', '할인', '세일', '저렴', '아끼', '절약', '무료', '품질', '이게맞아'],
    examples: ['구독 최적화', '대안 상품', '할인 정보'],
  },
  '성과향상': {
    desc: '더 잘하고 싶음',
    keywords: ['효율', '성과', '공부', '집중', '생산성', '향상', '잘하', '레벨업', '성장'],
    examples: ['공부 효율', '운동 효과', '업무 생산성'],
  },
  '외모건강': {
    desc: '더 나아보이고 싶음 / 건강 관리',
    keywords: ['피부', '다이어트', '살', '운동', '건강', '수면', '영양', '비타민', '모발', '탈모', '메이크업', '화장', '립', '변비'],
    examples: ['피부 관리', '다이어트', '수면 질 개선'],
  },
  '자기표현': {
    desc: '취향/정체성 표현',
    keywords: ['감성', '예쁘', '인테리어', '데코', '스타일', '취향', '미니멀', '빈티지', '전시', '향', '문화', '공연'],
    examples: ['미니멀 인테리어', '감성 소품', '패션 스타일'],
  },
};

// --- 구매 연결성 평가 ---
function assessPurchaseLinkage(_text: string, signalLevel: string | null, category: string): PurchaseLinkage {
  const level = parseInt((signalLevel || 'L0').replace('L', ''));
  if (level >= 4) return '상';
  if (level >= 2 && ['불편해소', '돈절약', '외모건강'].includes(category)) return '상';
  if (level >= 2) return '중';
  return '하';
}

// --- Threads 적합도 (1-5) ---
function threadsScore(category: NeedsCategory, postCount: number): number {
  const baseScores: Record<NeedsCategory, number> = {
    '불편해소': 5,
    '외모건강': 5,
    '돈절약': 4,
    '시간절약': 4,
    '성과향상': 3,
    '자기표현': 4,
  };
  let score = baseScores[category] || 3;
  if (postCount >= 5) score = Math.min(5, score + 0.5);
  return score;
}

// --- 포스트를 니즈 카테고리로 분류 ---
function classifyPost(post: CanonicalPost): NeedsCategory | null {
  const text = (post.text || '').toLowerCase();
  const scores: Partial<Record<NeedsCategory, number>> = {};

  for (const [cat, { keywords }] of Object.entries(NEEDS_CATEGORIES) as Array<[NeedsCategory, CategoryDef]>) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > 0) scores[cat] = score;
  }

  if (Object.keys(scores).length === 0) return null;

  const sorted = (Object.entries(scores) as Array<[NeedsCategory, number]>).sort((a, b) => b[1] - a[1]);
  return sorted[0][0];
}

// --- 문제 단위로 그룹화 ---
interface SignalEntry {
  post_id: string;
  signal_level: string;
}

interface NeedsGroup {
  category: NeedsCategory;
  posts: CanonicalPost[];
  expressions: string[];
  signal_levels: string[];
}

function groupIntoNeeds(posts: CanonicalPost[], signals: SignalEntry[]): Record<string, NeedsGroup> {
  const signalMap: Record<string, SignalEntry> = {};
  for (const s of signals) {
    signalMap[s.post_id] = s;
  }

  const needsGroups: Record<string, NeedsGroup> = {};

  for (const post of posts) {
    const signal = signalMap[post.post_id];
    const category = classifyPost(post);
    if (!category) continue;

    if (!needsGroups[category]) {
      needsGroups[category] = {
        category,
        posts: [],
        expressions: [],
        signal_levels: [],
      };
    }

    needsGroups[category].posts.push(post);
    if (post.text) {
      const firstSentence = post.text.split(/[.\n!?]/)[0].trim().slice(0, 100);
      if (firstSentence.length > 10) {
        needsGroups[category].expressions.push(firstSentence);
      }
    }
    if (signal) {
      needsGroups[category].signal_levels.push(signal.signal_level);
    }
  }

  return needsGroups;
}

// --- Build needs map ---
function buildNeedsMap(needsGroups: Record<string, NeedsGroup>): NeedItem[] {
  const needsList: NeedItem[] = [];

  for (const [category, group] of Object.entries(needsGroups)) {
    const postCount = group.posts.length;
    if (postCount < 1) continue;

    const levelCounts: Record<string, number> = {};
    for (const l of group.signal_levels) levelCounts[l] = (levelCounts[l] || 0) + 1;
    const dominantLevel = Object.entries(levelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const uniqueExpressions = [...new Set(group.expressions)].slice(0, 5);

    const needId = category.replace(/[^가-힣a-z]/g, '_').toLowerCase();
    const linkage = assessPurchaseLinkage(
      group.posts[0]?.text || '',
      dominantLevel,
      category
    );

    const catKey = category as NeedsCategory;
    needsList.push({
      need_id: needId,
      category: catKey,
      problem: NEEDS_CATEGORIES[catKey]?.desc || category,
      representative_expressions: uniqueExpressions,
      signal_strength: (dominantLevel as NeedItem['signal_strength']) || null,
      post_count: postCount,
      purchase_linkage: linkage,
      why_linkage: `${postCount}개 포스트에서 감지, 신호 레벨 ${dominantLevel || 'N/A'}`,
      product_categories: [],
      threads_fit: threadsScore(catKey, postCount),
      threads_fit_reason: `${NEEDS_CATEGORIES[catKey]?.desc || ''} 관련 콘텐츠`,
      sample_post_ids: group.posts.slice(0, 5).map(p => p.post_id),
    });
  }

  return needsList.sort((a, b) => b.post_count - a.post_count);
}

// --- LLM prompt for deeper needs analysis ---
function generateLLMPrompt(posts: CanonicalPost[], researchBrief: { purchase_signals?: unknown[] }, ruleBasedNeeds: NeedItem[]): string {
  const signalPosts = posts
    .filter(p => {
      const text = (p.text || '').toLowerCase();
      return /추천|살까|써봤|후기|비교|좋아보|갖고싶|궁금|어디서|괜찮/.test(text);
    })
    .slice(0, 60)
    .map(p => ({
      id: p.post_id,
      ch: p.channel_id,
      text: (p.text || '').slice(0, 250),
      views: p.metrics?.view_count,
      reply: p.comments?.[0]?.text?.slice(0, 80) || null,
    }));

  return `당신은 소비자 니즈 분석 전문가입니다. 아래 포스트에서 "사람들이 해결하고 싶은 문제"를 추출하세요.

## 구매신호 포스트 (${signalPosts.length}개)
${JSON.stringify(signalPosts, null, 0)}

## 규칙 기반 사전 분석
- 감지된 카테고리: ${ruleBasedNeeds.map(n => `${n.category}(${n.post_count}건)`).join(', ')}
- 총 구매신호: ${researchBrief.purchase_signals?.length || 0}건

## 니즈 카테고리 (택1)
불편해소 | 시간절약 | 돈절약 | 성과향상 | 외모건강 | 자기표현

## 구매신호 레벨
L1(관심) < L2(탐색) < L3(비교) < L4(구매의사) < L5(후기탐색)

## 요구 출력 (JSON)
{
  "needs_map": [
    {
      "need_id": "slug",
      "category": "카테고리",
      "problem": "구체적 문제 설명",
      "representative_expressions": ["원문 발췌 1", "원문 발췌 2"],
      "signal_strength": "L1-L5",
      "post_count": N,
      "purchase_linkage": "상|중|하",
      "why_linkage": "연결성 이유",
      "product_categories": ["상품 카테고리1", "상품 카테고리2"],
      "threads_fit": 1-5,
      "threads_fit_reason": "적합도 이유"
    }
  ],
  "priority_ranking": ["need_id1", "need_id2"],
  "low_priority_reasons": {"need_id": "이유"}
}

## 규칙
- 문제 중심 (제품명이 아니라 "해결하고 싶은 문제")
- 각 need에 post_id 근거 2개 이상
- product_categories는 구체적 상품군 (예: "영양제", "수면 앱")
- purchase_linkage가 "상"인 것 우선 정렬
- 최대 1000 토큰`;
}

// --- Main ---
function main(): void {
  const args = process.argv.slice(2);
  const generatePrompt = args.includes('--prompt');

  const today = new Date().toISOString().slice(0, 10);

  // Load canonical posts
  const data = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf8'));
  const posts: CanonicalPost[] = data.posts;

  // Load research brief
  const briefPath = path.join(BRIEFS_DIR, `${today}_research.json`);
  let researchBrief: { purchase_signals?: SignalEntry[] };
  try {
    researchBrief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  } catch {
    console.error(`Research brief not found: ${briefPath}`);
    console.error(`Run researcher.ts first.`);
    process.exit(1);
  }

  console.log(`Analyzing needs from ${posts.length} posts...`);

  const signals: SignalEntry[] = researchBrief.purchase_signals || [];

  const needsGroups = groupIntoNeeds(posts, signals);
  const needsMap = buildNeedsMap(needsGroups);

  const linkageOrder: Record<string, number> = { '상': 0, '중': 1, '하': 2 };
  const ranked = [...needsMap].sort((a, b) => {
    const linkDiff = (linkageOrder[a.purchase_linkage] || 2) - (linkageOrder[b.purchase_linkage] || 2);
    if (linkDiff !== 0) return linkDiff;
    return b.post_count - a.post_count;
  });

  // Per-post needs classification for eval
  const postNeeds: Record<string, string> = {};
  for (const post of posts) {
    const category = classifyPost(post);
    if (category) {
      postNeeds[post.post_id] = category;
    }
  }

  const output = {
    date: today,
    needs_map: needsMap,
    post_needs: postNeeds,
    priority_ranking: ranked.map(n => n.need_id),
    low_priority_reasons: {} as Record<string, string>,
    meta: {
      taxonomy_version: data.meta.taxonomy_version as string,
      schema_version: data.meta.schema_version as string,
      analysis_type: 'rule-based',
      posts_analyzed: posts.length,
      signals_input: signals.length,
      generated_at: new Date().toISOString(),
    },
  };

  for (const need of needsMap) {
    if (need.purchase_linkage === '하' || need.threads_fit < 3) {
      output.low_priority_reasons[need.need_id] = `purchase_linkage=${need.purchase_linkage}, threads_fit=${need.threads_fit}`;
    }
  }

  // Write
  const outPath = path.join(BRIEFS_DIR, `${today}_needs.json`);
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(tmpPath, outPath);

  // Generate LLM prompt
  if (generatePrompt) {
    const prompt = generateLLMPrompt(posts, researchBrief, needsMap);
    const promptPath = path.join(BRIEFS_DIR, `${today}_needs_prompt.txt`);
    fs.writeFileSync(promptPath, prompt, 'utf8');
    console.log(`  LLM prompt: ${promptPath}`);
  }

  // Print summary
  console.log(`\nNeeds map: ${outPath}`);
  console.log(`\n--- 니즈 분석 결과 ---`);
  for (const need of ranked) {
    console.log(`  ${need.category} (${need.post_count}건) — 연결성:${need.purchase_linkage}, 적합도:${need.threads_fit}, 신호:${need.signal_strength || 'N/A'}`);
    if (need.representative_expressions.length > 0) {
      console.log(`    예: "${need.representative_expressions[0]}"`);
    }
  }
  console.log(`\n우선순위: ${output.priority_ranking.join(' > ')}`);
}

main();
