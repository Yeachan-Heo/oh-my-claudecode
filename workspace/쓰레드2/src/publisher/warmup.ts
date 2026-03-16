/**
 * @file warmup.ts
 * 새 계정의 워밍업 관리 — 처음 20개 포스트는 제휴링크 없이 일반 콘텐츠로 발행.
 *
 * Usage:
 *   import { isWarmupComplete, getWarmupStatus, generateWarmupContent } from './warmup.js';
 */

import { db } from '../db/index.js';
import { contentLifecycle } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import type { WarmupStatus } from '../types.js';

// ─── Config ──────────────────────────────────────────────

const WARMUP_TARGET = 20;

// ─── Warmup Templates ───────────────────────────────────
// 일반적인 일상/관심사 포스트 (제휴링크 없음)

const WARMUP_TEMPLATES = [
  '오늘 카페에서 발견한 좋은 책 한 권. 가끔은 이렇게 아무 계획 없이 보내는 시간이 필요하다.',
  '요즘 자기 전에 10분씩 스트레칭하는데 확실히 다음 날 컨디션이 다르다. 작은 습관의 힘.',
  '주말에 동네 산책하다가 새로 생긴 빵집 발견. 소금빵이 진짜 맛있었다.',
  '최근에 시작한 취미가 하나 있는데, 매일 30분씩 하다 보니 어느새 한 달이 됐다.',
  '아침에 일어나자마자 물 한 잔 마시는 습관 들이고 나서 확실히 좋아진 느낌.',
  '요즘 읽고 있는 글에서 좋은 문장을 발견했다. "꾸준함이 재능을 이긴다."',
  '퇴근 후에 좋아하는 음악 틀어놓고 요리하는 시간이 하루 중 가장 좋다.',
  '오랜만에 친구를 만났는데, 같이 있으면 시간이 너무 빨리 간다.',
  '날씨가 좋은 날에는 그냥 걷는 것만으로도 기분이 좋아진다.',
  '새로운 걸 배우는 과정이 처음엔 어색하지만, 조금씩 나아지는 게 느껴지면 뿌듯하다.',
  '커피 한 잔의 여유. 바쁜 하루 속에서도 이런 작은 쉼표가 필요하다.',
  '요즘 일찍 자고 일찍 일어나는 생활을 시도 중인데, 확실히 오전 시간이 길어진 느낌.',
  '운동을 시작하고 나서 가장 좋은 건 체력보다 멘탈이 좋아진 거다.',
  '가끔은 SNS를 내려놓고 조용히 생각하는 시간도 필요하다고 느낀다.',
  '좋아하는 일을 꾸준히 하다 보면 어느 순간 그게 실력이 되어 있더라.',
] as const;

// 변형을 위한 접두사/접미사
const PREFIXES = [
  '', '갑자기 생각난 건데, ', '문득 느낀 건데, ', '오늘 느낀 점 — ',
  '솔직히 말하면, ', '요즘 드는 생각인데, ',
] as const;

const SUFFIXES = [
  '', ' 여러분은 어떠세요?', ' 다들 좋은 하루 보내세요!',
  ' 공감하시는 분?', ' 이런 거 나만 그런가.',
] as const;

// ─── Core Functions ──────────────────────────────────────

/**
 * 해당 계정의 총 포스트 수를 조회하여 워밍업 완료 여부를 반환한다.
 * content_lifecycle 테이블에서 posted_at이 NOT NULL인 레코드 수를 카운트.
 */
export async function isWarmupComplete(accountId: string): Promise<boolean> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentLifecycle)
    .where(eq(contentLifecycle.posted_account_id, accountId));

  const totalPosts = result[0]?.count ?? 0;
  return totalPosts >= WARMUP_TARGET;
}

/**
 * 계정의 워밍업 상태를 상세히 반환한다.
 */
export async function getWarmupStatus(accountId: string): Promise<WarmupStatus> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentLifecycle)
    .where(eq(contentLifecycle.posted_account_id, accountId));

  const totalPosts = result[0]?.count ?? 0;
  const isComplete = totalPosts >= WARMUP_TARGET;

  return {
    accountId,
    totalPosts,
    warmupTarget: WARMUP_TARGET,
    isComplete,
    remainingPosts: Math.max(0, WARMUP_TARGET - totalPosts),
  };
}

/**
 * 워밍업용 일반 콘텐츠를 생성한다.
 * 미리 정의된 템플릿에서 랜덤 선택 + 접두사/접미사 변형.
 */
export function generateWarmupContent(): string {
  const template = WARMUP_TEMPLATES[Math.floor(Math.random() * WARMUP_TEMPLATES.length)];
  const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
  const suffix = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];

  return `${prefix}${template}${suffix}`;
}
