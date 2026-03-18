#!/usr/bin/env tsx
/**
 * trend-filter.ts — X 트렌드 키워드 필터 DB 헬퍼
 *
 * 실제 분석은 Claude Code가 trend-analyzer.md 에이전트로 수행.
 * 이 파일은 DB 읽기/쓰기만 담당.
 *
 * 흐름:
 *   1. trend-fetcher.ts → 99개 DB 저장
 *   2. Claude Code가 trend-analyzer.md로 분석 → JSON 결과 생성
 *   3. 이 파일의 applyAnalysis()로 DB 마킹
 *
 * Usage (Claude Code 스킬에서 호출):
 *   import { getTodayTrends, applyAnalysis } from './trend-filter.js';
 *   const keywords = await getTodayTrends();
 *   // → Claude Code가 trend-analyzer.md로 분석
 *   await applyAnalysis(analysisResult);
 */

import { eq, and, gte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { trendKeywords } from '../db/schema.js';
import type { TrendItem } from './trend-fetcher.js';
import { fetchTrends } from './trend-fetcher.js';

// ─── Types ───────────────────────────────────────────────

export interface FilteredTrend {
  trend: string;
  category: string;
  mapped_keywords: string[];
  volume: string | null;
}

/** 에이전트 분석 결과 — trend-analyzer.md 출력 형식 */
export interface TrendAnalysisResult {
  selected: Array<{
    keyword: string;
    category: string;
    search_keywords: string[];
    reason: string;
    threads_angle: string;
  }>;
  skipped: Array<{
    keyword: string;
    reason: string;
  }>;
  summary: {
    total: number;
    selected: number;
    skipped: number;
    categories: Record<string, number>;
  };
}

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [trend-filter] ${msg}`);
}

// ─── DB Operations ───────────────────────────────────────

/**
 * 오늘 수집된 트렌드 키워드 목록을 DB에서 가져온다.
 * DB에 없으면 Apify로 수집 후 반환.
 */
export async function getTodayTrends(): Promise<string[]> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const existing = await db.execute(
    sql`SELECT keyword FROM trend_keywords WHERE fetched_at >= ${todayStart} ORDER BY rank ASC`
  );
  const rows = (existing as any).rows || existing;

  if (rows.length > 0) {
    log(`DB에서 오늘 트렌드 로드: ${rows.length}개`);
    return rows.map((r: any) => r.keyword);
  }

  // DB에 없으면 Apify로 수집
  log('오늘 트렌드 없음 → Apify 수집 시작...');
  const trends = await fetchTrends();
  return trends.map(t => t.trend);
}

/**
 * 에이전트 분석 결과를 DB에 반영한다.
 * selected → selected=true + reason
 * skipped → selected=false + reason
 */
export async function applyAnalysis(result: TrendAnalysisResult): Promise<void> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // 선택된 키워드 마킹
  for (const item of result.selected) {
    try {
      await db.update(trendKeywords)
        .set({
          selected: true,
          selected_reason: `[${item.category}] ${item.search_keywords.join(', ')}`,
        })
        .where(
          and(
            eq(trendKeywords.keyword, item.keyword),
            gte(trendKeywords.fetched_at, todayStart),
          )
        );
    } catch { /* non-critical */ }
  }

  // 스킵된 키워드 마킹
  for (const item of result.skipped) {
    try {
      await db.update(trendKeywords)
        .set({
          selected: false,
          selected_reason: item.reason,
        })
        .where(
          and(
            eq(trendKeywords.keyword, item.keyword),
            gte(trendKeywords.fetched_at, todayStart),
          )
        );
    } catch { /* non-critical */ }
  }

  log(`DB 마킹 완료: ${result.selected.length}개 선택 / ${result.skipped.length}개 거절`);
}

/**
 * 에이전트 분석 결과에서 Threads 검색용 키워드 목록 추출.
 */
export function extractSearchKeywords(result: TrendAnalysisResult): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const item of result.selected) {
    for (const kw of item.search_keywords) {
      if (!seen.has(kw)) {
        seen.add(kw);
        keywords.push(kw);
      }
    }
  }

  return keywords;
}

/**
 * 레거시 호환: FilteredTrend[] 형식으로 변환
 */
export function toFilteredTrends(result: TrendAnalysisResult): FilteredTrend[] {
  return result.selected.map(item => ({
    trend: item.keyword,
    category: item.category,
    mapped_keywords: item.search_keywords,
    volume: null,
  }));
}

// ─── CLI (정보 출력용) ───────────────────────────────────

async function main(): Promise<void> {
  log('=== 오늘 트렌드 키워드 현황 ===');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const all = await db.execute(
    sql`SELECT keyword, rank, selected, selected_reason FROM trend_keywords WHERE fetched_at >= ${todayStart} ORDER BY rank ASC`
  );
  const rows = (all as any).rows || all;

  if (rows.length === 0) {
    log('오늘 수집된 트렌드가 없습니다. 먼저 trend-fetcher.ts를 실행하세요.');
    process.exit(0);
  }

  const selected = rows.filter((r: any) => r.selected);
  const skipped = rows.filter((r: any) => !r.selected);

  console.log(`\n총 ${rows.length}개 (선택: ${selected.length}개, 스킵: ${skipped.length}개)`);

  if (selected.length > 0) {
    console.log('\n✅ 선택된 키워드:');
    for (const r of selected) {
      console.log(`  ${String(r.rank).padStart(3)}. ${r.keyword} — ${r.selected_reason}`);
    }
  }

  if (selected.length === 0) {
    console.log('\n⚠️ 아직 분석되지 않았습니다. Claude Code에서 trend-analyzer.md 에이전트로 분석을 실행하세요.');
  }

  process.exit(0);
}

const isDirectRun = process.argv[1]?.includes('trend-filter');
if (isDirectRun) {
  main().catch(err => { console.error(err); process.exit(1); });
}
