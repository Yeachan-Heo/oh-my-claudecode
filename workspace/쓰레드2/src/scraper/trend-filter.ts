#!/usr/bin/env tsx
/**
 * trend-filter.ts — X 트렌드에서 제품 연결 가능한 키워드 선별
 *
 * 2단계 필터:
 *  1. 규칙 기반 매핑 사전 (빈이 페르소나에 맞는 뷰티/건강/생활)
 *  2. 나머지는 스킵 (정치, 연예, 사건사고, 스포츠 등)
 *
 * Usage:
 *   npx tsx src/scraper/trend-filter.ts
 *   npx tsx src/scraper/trend-filter.ts --json '[{"trend":"미세먼지"},...]'
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

// ─── Trend → Product Keyword Mapping ────────────────────

interface MappingRule {
  pattern: RegExp;
  category: string;
  keywords: string[];
}

const MAPPING_RULES: MappingRule[] = [
  // 뷰티
  { pattern: /미세먼지|황사|먼지/, category: '뷰티', keywords: ['클렌징 추천', '미세먼지 피부 관리', '마스크팩'] },
  { pattern: /자외선|UV|선크림|선케어|자차/, category: '뷰티', keywords: ['선크림 추천', '자외선 차단제'] },
  { pattern: /건조|보습|각질/, category: '뷰티', keywords: ['보습크림 추천', '립밤 추천', '각질 케어'] },
  { pattern: /피부|트러블|여드름|모공/, category: '뷰티', keywords: ['스킨케어 추천', '여드름 관리'] },
  { pattern: /메이크업|화장|쿠션|파운데이션/, category: '뷰티', keywords: ['쿠션 추천', '파운데이션 추천'] },
  { pattern: /헤어|머릿결|탈모|샴푸/, category: '뷰티', keywords: ['헤어케어 추천', '트리트먼트 추천'] },
  { pattern: /네일|매니큐어/, category: '뷰티', keywords: ['네일 추천', '셀프네일'] },
  { pattern: /향수|바디미스트/, category: '뷰티', keywords: ['향수 추천', '바디미스트'] },

  // 건강
  { pattern: /다이어트|체중|살빼|저탄고지|간헐적단식|키토/, category: '건강', keywords: ['다이어트 식품 추천', '단백질 쉐이크'] },
  { pattern: /알레르기|꽃가루|비염/, category: '건강', keywords: ['알레르기 영양제', '공기청정기 추천'] },
  { pattern: /수면|불면|잠|숙면/, category: '건강', keywords: ['수면 영양제', '마그네슘 추천'] },
  { pattern: /영양제|비타민|오메가|유산균|프로바이오틱/, category: '건강', keywords: ['영양제 추천', '유산균 추천'] },
  { pattern: /운동|헬스|피트니스|근육|스트레칭/, category: '건강', keywords: ['운동용품 추천', '폼롤러 추천', '마사지건'] },
  { pattern: /다이어트.*음식|칼로리|식단/, category: '건강', keywords: ['다이어트 간식', '닭가슴살 추천'] },
  { pattern: /레몬|디톡스|클렌즈/, category: '건강', keywords: ['레몬즙 추천', '디톡스 음료'] },
  { pattern: /장건강|변비|소화/, category: '건강', keywords: ['유산균 추천', '식이섬유'] },
  { pattern: /눈건강|블루라이트|안구건조/, category: '건강', keywords: ['루테인 추천', '눈 영양제'] },

  // 생활
  { pattern: /장마|폭우|습기|곰팡이|제습/, category: '생활', keywords: ['제습기 추천', '곰팡이 제거'] },
  { pattern: /더위|폭염|열대야/, category: '생활', keywords: ['선풍기 추천', '쿨링용품'] },
  { pattern: /추위|한파|동장군/, category: '생활', keywords: ['전기장판 추천', '핫팩'] },
  { pattern: /청소|먼지|위생/, category: '생활', keywords: ['청소용품 추천', '로봇청소기'] },
  { pattern: /냄새|탈취|디퓨저/, category: '생활', keywords: ['탈취제 추천', '디퓨저 추천'] },
];

// 절대 스킵해야 하는 패턴 (정치, 사건사고, 연예 등)
const SKIP_PATTERNS = [
  /정치|국회|대통령|선거|탄핵|검찰|법원/,
  /사고|사망|화재|지진|태풍|사건/,
  /속보|긴급|비보/,
  /아이돌|데뷔|컴백|방탄|블랙핑크|뉴진스/,
  /축구|야구|농구|WBC|올림픽|월드컵/,
  /주식|코인|비트코인|환율|금리/,
  /전쟁|군사|미사일|북한/,
];

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [trend-filter] ${msg}`);
}

// ─── Filter Logic ────────────────────────────────────────

export async function filterTrends(trends: TrendItem[]): Promise<FilteredTrend[]> {
  const results: FilteredTrend[] = [];

  for (const item of trends) {
    const text = item.trend;

    // 1. Skip 패턴 체크
    if (SKIP_PATTERNS.some(p => p.test(text))) {
      continue;
    }

    // 2. 매핑 규칙 매칭
    for (const rule of MAPPING_RULES) {
      if (rule.pattern.test(text)) {
        results.push({
          trend: text,
          category: rule.category,
          mapped_keywords: rule.keywords,
          volume: item.volume,
        });
        break; // 첫 번째 매칭만
      }
    }
  }

  // DB에서 선택/거절 이유 마킹
  await markSelectionInDB(trends, results);

  return results;
}

/**
 * DB의 trend_keywords 테이블에 선택/거절 여부를 업데이트한다.
 * 오늘 수집된 트렌드만 대상.
 */
async function markSelectionInDB(allTrends: TrendItem[], selected: FilteredTrend[]): Promise<void> {
  const selectedSet = new Set(selected.map(s => s.trend));
  const selectedReasons = new Map(selected.map(s => [s.trend, `[${s.category}] ${s.mapped_keywords.join(', ')}`]));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  for (const item of allTrends) {
    const isSelected = selectedSet.has(item.trend);
    const reason = isSelected
      ? selectedReasons.get(item.trend) ?? '필터 통과'
      : SKIP_PATTERNS.some(p => p.test(item.trend))
        ? '정치/연예/스포츠/사건사고'
        : '제품 연결 불가';

    try {
      await db.update(trendKeywords)
        .set({
          selected: isSelected,
          selected_reason: reason,
        })
        .where(
          and(
            eq(trendKeywords.keyword, item.trend),
            gte(trendKeywords.fetched_at, todayStart),
          )
        );
    } catch { /* non-critical */ }
  }

  log(`DB 마킹 완료: ${selectedSet.size}개 선택 / ${allTrends.length - selectedSet.size}개 거절`);
}

/**
 * 필터 결과에서 Threads 검색에 쓸 유니크 키워드 목록 추출
 */
export function extractSearchKeywords(filtered: FilteredTrend[]): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const f of filtered) {
    for (const kw of f.mapped_keywords) {
      if (!seen.has(kw)) {
        seen.add(kw);
        keywords.push(kw);
      }
    }
  }

  return keywords;
}

// ─── CLI ─────────────────────────────────────────────────

async function main(): Promise<void> {
  log('=== X 트렌드 필터링 시작 ===');

  // --json 옵션으로 직접 트렌드 주입 가능
  const jsonArg = process.argv.find((a, i) => process.argv[i - 1] === '--json');
  let trends: TrendItem[];

  if (jsonArg) {
    trends = JSON.parse(jsonArg);
    log(`직접 입력 트렌드: ${trends.length}개`);
  } else {
    // DB에서 오늘 수집된 트렌드가 있으면 재사용 (Apify 중복 호출 방지)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const existing = await db.execute(
      sql`SELECT keyword FROM trend_keywords WHERE fetched_at >= ${todayStart} LIMIT 1`
    );
    const existingRows = (existing as any).rows || existing;

    if (existingRows.length > 0) {
      // 오늘 이미 수집된 트렌드가 있으면 DB에서 가져오기
      const allRows = await db.execute(
        sql`SELECT keyword FROM trend_keywords WHERE fetched_at >= ${todayStart} ORDER BY rank ASC`
      );
      trends = ((allRows as any).rows || allRows).map((r: any) => ({
        trend: r.keyword,
        volume: null,
        timePeriod: null,
        time: null,
      }));
      log(`DB에서 오늘 수집된 트렌드 재사용: ${trends.length}개 (Apify 스킵)`);
    } else {
      log('Apify에서 트렌드 수집 중...');
      trends = await fetchTrends();
    }
  }

  const filtered = await filterTrends(trends);
  const keywords = extractSearchKeywords(filtered);

  console.log('\n== 필터링 결과 ==');
  filtered.forEach((f, i) => {
    console.log(`${i + 1}. [${f.category}] "${f.trend}" → ${f.mapped_keywords.join(', ')}`);
  });

  console.log(`\n원본: ${trends.length}개 → 필터 통과: ${filtered.length}개`);
  console.log(`검색 키워드: ${keywords.join(', ')}`);

  process.exit(0);
}

const isDirectRun = process.argv[1]?.includes('trend-filter');
if (isDirectRun) {
  main().catch(err => { console.error(err); process.exit(1); });
}
