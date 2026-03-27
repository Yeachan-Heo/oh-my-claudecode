/**
 * @file Content generator — 포맷 다양화 + 셀프댓글 품질 개선 + 훅 품질 강화.
 *
 * Phase 3 개선:
 *   1. 포맷 다양화: 6가지 포맷 라운드로빈 + 니즈 성격 기반 선택
 *   2. 셀프댓글: 워밍업(post_count < 20)이면 생략, 이후 자연스러운 후기 톤
 *   3. 훅: 제품명 직접 노출 금지, 니즈/공감 중심
 */

import type { PositionFormat } from '../types.js';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
// LLM 호출 제거됨 — 콘텐츠 생성은 Claude Code가 /threads-pipeline 스킬로 직접 수행
// 이 파일은 유틸 함수(포맷 선택, 워밍업 감지, 훅 새니타이징)만 제공

/** 니즈 타입 (needs-detector.ts 삭제됨, 로컬 정의) */
export interface DetectedNeed {
  need_id: string;
  category: string;
  problem: string;
  representative_expressions: string[];
  signal_strength: string;
  post_count: number;
  purchase_linkage: '상' | '중' | '하';
  why_linkage: string;
  product_categories: string[];
  threads_fit: number;
  threads_fit_reason: string;
  sample_post_ids: string[];
}

/** 제품 매칭 타입 */
export interface ProductMatch {
  need_id: string;
  product_id: string;
  match_score: number;
  match_why: string;
  competition: '상' | '중' | '하';
  priority: number;
}

// ─── Types ──────────────────────────────────────────────

interface _ProductInfo {
  product_id: string;
  name: string;
  category: string;
  price_range: string;
  description: string;
  affiliate_link: string | null;
}

export interface PositioningResult {
  format: PositionFormat;
  angle: string;
  tone: string;
  hook: string;
  avoid: string[];
  cta_style: string;
}

export interface GeneratedContent {
  id: string;
  product_id: string;
  product_name: string;
  need_id: string;
  format: PositionFormat;
  hook: string;
  bodies: string[];
  hooks: string[];
  self_comments: string[];
  positioning: {
    angle: string;
    tone: string;
    avoid: string[];
    cta_style: string;
  };
}

// ─── Format Selection ───────────────────────────────────

const ALL_FORMATS: PositionFormat[] = [
  '문제공감형',
  '솔직후기형',
  '비교형',
  '입문추천형',
  '실수방지형',
  '비추천형',
];

/** 라운드로빈 인덱스 — 프로세스 단위로 유지 */
let formatRoundRobinIndex = 0;

/**
 * 니즈 성격에 따라 적합한 포맷을 선택한다.
 * 기본은 라운드로빈이지만, 특정 니즈 패턴에는 가중치를 부여한다.
 */
export function selectFormat(need: DetectedNeed): PositionFormat {
  // 니즈 카테고리별 적합 포맷 매핑
  const categoryFormatMap: Record<string, PositionFormat[]> = {
    '불편해소': ['문제공감형', '실수방지형', '솔직후기형'],
    '시간절약': ['비교형', '솔직후기형', '입문추천형'],
    '돈절약': ['비교형', '비추천형', '솔직후기형'],
    '성과향상': ['솔직후기형', '입문추천형', '비교형'],
    '외모건강': ['문제공감형', '솔직후기형', '비추천형'],
    '자기표현': ['입문추천형', '솔직후기형', '문제공감형'],
  };

  const preferredFormats = categoryFormatMap[need.category];

  // purchase_linkage가 '상'이면 적합 포맷에서 우선 선택
  if (need.purchase_linkage === '상' && preferredFormats && preferredFormats.length > 0) {
    const idx = formatRoundRobinIndex % preferredFormats.length;
    formatRoundRobinIndex++;
    return preferredFormats[idx];
  }

  // 기본 라운드로빈
  const format = ALL_FORMATS[formatRoundRobinIndex % ALL_FORMATS.length];
  formatRoundRobinIndex++;
  return format;
}

// ─── Warmup Detection ───────────────────────────────────

/**
 * 현재 계정들의 총 포스트 수를 확인하여 워밍업 모드인지 판단한다.
 * 워밍업: 전체 post_count 합 < 20
 */
export async function isWarmupMode(): Promise<boolean> {
  try {
    const accountRows = await db.select().from(accounts);
    if (accountRows.length === 0) {
      // 계정이 없으면 워밍업으로 간주
      return true;
    }
    const totalPosts = accountRows.reduce((sum, a) => sum + a.post_count, 0);
    return totalPosts < 20;
  } catch {
    // DB 오류 시 안전하게 워밍업으로 간주
    return true;
  }
}

// ─── 유틸 함수만 export (LLM 호출 제거됨) ─────────────

// ─── Sanitization Helpers ───────────────────────────────

/**
 * 훅에서 제품명이 직접 노출되면 제거한다.
 */
export function sanitizeHook(hook: string, productName: string): string {
  if (!hook) return '';
  // 제품명이 포함되어 있으면 제거
  if (hook.includes(productName)) {
    return hook.replace(new RegExp(escapeRegex(productName), 'g'), '이거');
  }
  return hook;
}

/**
 * 훅 배열에서 제품명 직접 노출을 제거한다.
 */
export function sanitizeHooks(hooks: string[], productName: string): string[] {
  return hooks.map((h) => sanitizeHook(h, productName));
}

/**
 * 셀프댓글에서 무의미한 패턴을 필터링한다.
 */
export function sanitizeSelfComments(comments: string[]): string[] {
  const bannedPatterns = [
    '좋은 정보 감사',
    '잘 읽었습니다',
    '감사합니다',
    '좋은 글',
    '유익한 정보',
    '잘 보고 갑니다',
    '공감합니다',
    '도움이 됐습니다',
  ];

  return comments.filter((comment) => {
    const lower = comment.toLowerCase();
    return !bannedPatterns.some((pattern) => lower.includes(pattern));
  });
}

/**
 * 정규식 특수문자 이스케이프
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
