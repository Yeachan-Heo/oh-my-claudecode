#!/usr/bin/env tsx
/**
 * run-trend-pipeline.ts — X 트렌드 → Threads 수집 오케스트레이터
 *
 * 전체 흐름:
 *   1. X 한국 트렌드 수집 (Apify)
 *   2. 제품 연결 가능한 키워드 필터링
 *   3. 필터된 키워드로 Threads 검색 수집 (collect-by-keyword.ts 호출)
 *   4. 결과 요약 + 텔레그램 알림
 *
 * Usage:
 *   npx tsx scripts/run-trend-pipeline.ts
 *   npx tsx scripts/run-trend-pipeline.ts --dry-run   # 수집 없이 트렌드+필터만
 *   npx tsx scripts/run-trend-pipeline.ts --skip-fetch # Apify 스킵, 키워드 직접 지정
 *     --keywords "미세먼지 피부,선크림 추천"
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import path from 'path';
import { eq, and, gte, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { trendKeywords, threadPosts } from '../src/db/schema.js';
import { fetchTrends } from '../src/scraper/trend-fetcher.js';
import { getTodayTrends } from '../src/scraper/trend-filter.js';
import { sendAlert } from '../src/utils/telegram.js';

// ─── Config ──────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const COLLECT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'collect-by-keyword.ts');

// ─── CLI Args ────────────────────────────────────────────

interface CliOptions {
  dryRun: boolean;
  skipFetch: boolean;
  keywords: string[] | null;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = { dryRun: false, skipFetch: false, keywords: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    if (args[i] === '--skip-fetch') opts.skipFetch = true;
    if (args[i] === '--keywords' && args[i + 1]) {
      opts.keywords = args[i + 1].split(',').map(k => k.trim());
      i++;
    }
  }

  return opts;
}

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [trend-pipeline] ${msg}`);
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  log('=== X 트렌드 → Threads 수집 파이프라인 시작 ===');

  // Step 1: 트렌드 수집
  let keywords: string[];

  if (opts.keywords) {
    keywords = opts.keywords;
    log(`직접 키워드 지정: ${keywords.join(', ')}`);
  } else if (opts.skipFetch) {
    log('--skip-fetch: Apify 수집 건너뜀');
    keywords = [];
  } else {
    log('\nStep 1: X 한국 트렌드 수집 (Apify)');
    const trends = await fetchTrends();
    log(`수집 완료: ${trends.length}개 트렌드`);

    // 상위 10개 트렌드 미리보기
    trends.slice(0, 10).forEach((t, i) => {
      log(`  ${i + 1}. ${t.trend} ${t.volume ? `(${t.volume})` : ''}`);
    });

    // Step 2: DB에서 선택된 트렌드 키워드 조회 (에이전트가 사전 분석)
    log('\nStep 2: DB에서 선택된 트렌드 키워드 조회');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const selectedRows = await db.select()
      .from(trendKeywords)
      .where(and(
        eq(trendKeywords.selected, true),
        gte(trendKeywords.fetched_at, todayStart),
      ));

    keywords = selectedRows.map((r: { keyword: string }) => r.keyword);
    log(`필터 결과: ${trends.length}개 → ${selectedRows.length}개 트렌드 통과`);
    selectedRows.forEach((r: { keyword: string; selected_reason: string | null }) => {
      log(`  "${r.keyword}" — ${r.selected_reason ?? ''}`);
    });

    if (keywords.length === 0) {
      log('제품 연결 가능한 트렌드가 없습니다. 종료.');
      await sendAlert('ℹ️ 트렌드 파이프라인: 제품 연결 가능한 트렌드 0개 — 오늘은 스킵');
      process.exit(0);
    }

    log(`\n검색 키워드 ${keywords.length}개: ${keywords.join(', ')}`);
  }

  if (keywords.length === 0) {
    log('키워드 없음. 종료.');
    process.exit(0);
  }

  // Step 3: Threads 검색 수집
  if (opts.dryRun) {
    log('\n--dry-run: Threads 수집 건너뜀');
    log(`실제 실행 시 명령: npx tsx ${COLLECT_SCRIPT} --keywords "${keywords.join(',')}" --posts-per-keyword 10`);
  } else {
    log(`\nStep 3: Threads 검색 수집 (키워드 ${keywords.length}개, 키워드당 10개)`);
    const cmd = `npx tsx "${COLLECT_SCRIPT}" --keywords "${keywords.join(',')}" --posts-per-keyword 10 --max-age-days 7`;
    log(`실행: ${cmd}`);

    try {
      const output = execSync(cmd, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 30 * 60 * 1000, // 30분 타임아웃
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      // 마지막 10줄만 출력 (요약)
      const lines = output.trim().split('\n');
      const summary = lines.slice(-10).join('\n');
      log(`\n수집 결과:\n${summary}`);
    } catch (err) {
      const msg = (err as Error).message;
      log(`수집 실패: ${msg}`);
      await sendAlert(`❌ 트렌드 파이프라인 수집 실패\n\n${msg.slice(0, 200)}`);
      process.exit(1);
    }
  }

  // Step 4: posts_collected 업데이트 (선택된 키워드별 수집된 포스트 수)
  if (!opts.dryRun) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    for (const kw of keywords) {
      try {
        // 오늘 search_*로 수집된 포스트 중 이 키워드와 관련된 것 카운트
        const result = await db.execute(sql`
          SELECT COUNT(*) as cnt FROM thread_posts
          WHERE run_id LIKE 'search_%'
            AND crawl_at >= ${todayStart}
            AND text ILIKE ${'%' + kw.split(' ')[0] + '%'}
        `);
        const cnt = Number(((result as any).rows || result)[0]?.cnt ?? 0);

        if (cnt > 0) {
          // 키워드에 매핑된 트렌드의 posts_collected 업데이트
          await db.update(trendKeywords)
            .set({ posts_collected: cnt })
            .where(
              and(
                eq(trendKeywords.selected, true),
                gte(trendKeywords.fetched_at, todayStart),
              )
            );
          log(`posts_collected 업데이트: "${kw}" → ${cnt}개`);
        }
      } catch { /* non-critical */ }
    }
  }

  // Step 5: 요약 + 텔레그램
  const summary = [
    '✅ 트렌드 파이프라인 완료',
    '',
    `키워드: ${keywords.join(', ')}`,
    opts.dryRun ? '(dry-run — 실제 수집 안 함)' : '수집 완료 — /threads-pipeline으로 니즈 분석 진행',
  ].join('\n');

  log(`\n${summary}`);

  if (!opts.dryRun) {
    await sendAlert(summary);
  }

  log('\n=== 트렌드 파이프라인 종료 ===');
  log('다음 단계: /threads-pipeline으로 수집된 포스트 니즈 분석');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
