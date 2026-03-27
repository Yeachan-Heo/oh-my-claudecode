#!/usr/bin/env tsx
/**
 * collect-naver-cafe.ts -- 네이버 카페 인기글 + 댓글 수집
 *
 * Chrome CDP(9223)로 연결하여 네이버 카페 메인에서 글 + 댓글을 수집한다.
 * 수집된 데이터는 community_posts 테이블에 저장한다.
 *
 * 주의: 네이버 카페는 iframe 구조 — 본문이 cafe_main 프레임 안에 있다.
 *
 * Usage:
 *   npx tsx scripts/collect-naver-cafe.ts --cafe cosmania --limit 20
 *   npx tsx scripts/collect-naver-cafe.ts --cafe beautytalk --limit 10
 *   npx tsx scripts/collect-naver-cafe.ts --all --limit 20
 */

import { connectBrowser } from '../src/utils/browser.js';
import { humanDelay } from '../src/utils/timing.js';
import { collectCafe, CAFE_TARGETS } from '../src/scraper/naver-cafe/index.js';
import type { CafeTarget } from '../src/scraper/naver-cafe/types.js';

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── CLI ─────────────────────────────────────────────────

function parseCliArgs(): { cafes: CafeTarget[]; limit: number } {
  const args = process.argv.slice(2);
  let cafes: CafeTarget[] = [];
  let limit = 20;
  let all = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cafe' && args[i + 1]) {
      const cafeId = args[i + 1];
      const target = CAFE_TARGETS.find(c => c.id === cafeId);
      if (target) {
        cafes.push(target);
      } else {
        // Allow unknown cafe IDs with defaults
        cafes.push({ id: cafeId, name: cafeId, category: '기타', clubid: '' });
      }
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10) || 20;
      i++;
    } else if (args[i] === '--all') {
      all = true;
    }
  }

  if (all || cafes.length === 0) {
    cafes = [...CAFE_TARGETS];
  }

  return { cafes, limit };
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs();
  const runStart = Date.now();

  log(`=== 네이버 카페 수집 시작 ===`);
  log(`대상 카페: ${opts.cafes.map(c => `${c.name}(${c.id})`).join(', ')}`);
  log(`카페당 최대 ${opts.limit}개`);

  // Connect browser
  let browser;
  try {
    browser = await connectBrowser();
  } catch (err) {
    console.error(`브라우저 연결 실패: ${(err as Error).message}`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error('브라우저 컨텍스트 없음');
    await browser.close();
    process.exit(1);
  }

  const page = context.pages()[0] || await context.newPage();

  // Check naver login status
  try {
    await page.goto('https://cafe.naver.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await humanDelay(2000, 3000);

    const isLoggedIn = await page.evaluate(() => {
      const loginBtn = document.querySelector(
        '.gnb_btn_login, a[href*="nid.naver.com/nidlogin"]',
      );
      return !loginBtn;
    });

    log(isLoggedIn ? '네이버 로그인 상태 확인' : '네이버 미로그인 — 일부 카페 접근이 제한될 수 있음');
  } catch (err) {
    log(`네이버 접근 확인 실패: ${(err as Error).message} — 계속 진행`);
  }

  let totalCollected = 0;
  let totalInserted = 0;
  const _allResults: Array<{
    cafe: string;
    title: string;
    views: number;
    comments: number;
    body_len: number;
  }> = [];

  try {
    for (let i = 0; i < opts.cafes.length; i++) {
      const cafe = opts.cafes[i];
      const result = await collectCafe(page, cafe, opts.limit);

      totalCollected += result.collected;
      totalInserted += result.inserted;

      // Delay between cafes
      if (i < opts.cafes.length - 1) {
        const delay = await humanDelay(5000, 10000);
        log(`  다음 카페까지 대기: ${(delay / 1000).toFixed(1)}초`);
      }
    }
  } finally {
    await browser.close();
    log('\n브라우저 disconnect 완료');
  }

  // Summary
  const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);
  log('\n=== 수집 완료 ===');
  log(`총 수집: ${totalCollected}개, DB 신규 저장: ${totalInserted}개`);
  log(`소요 시간: ${elapsed}초`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
