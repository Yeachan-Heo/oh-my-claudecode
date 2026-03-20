/**
 * @file 인스티즈 수집 오케스트레이터.
 *
 * 목록 페이지 → 상세 페이지 → (선택) 댓글 파싱 → community_posts DB 저장.
 * source_platform='instiz', source_cafe='instiz_name_beauty' 등으로 통합 저장.
 */

import { db } from '../../db/index.js';
import { communityPosts } from '../../db/schema.js';
import { fetchListPage, fetchDetailPage, requestDelay } from './fetcher.js';
import { parseListPage, parseDetailPage, parseComments } from './parser.js';
import type { InstizListItem, InstizArticle, InstizComment, InstizCollectResult } from './types.js';

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Collect Single Article ──────────────────────────────

/**
 * 단일 게시글 상세 페이지를 수집하여 InstizArticle로 변환한다.
 */
async function collectArticle(
  item: InstizListItem,
  board: string,
  shouldFetchComments: boolean,
): Promise<InstizArticle | null> {
  try {
    const html = await fetchDetailPage(board, item.documentId);
    const detail = parseDetailPage(html, item.documentId, board);

    // Parse comments from HTML if requested
    let comments: InstizComment[] = [];
    if (shouldFetchComments) {
      comments = parseComments(html);
    }

    return {
      documentId: item.documentId,
      title: detail.title || item.title,
      body: detail.body,
      authorNickname: detail.authorNickname,
      viewCount: detail.viewCount || item.viewCount,
      likeCount: detail.likeCount,
      commentCount: detail.commentCount || item.commentCount,
      postedAt: detail.postedAt,
      sourceUrl: detail.sourceUrl,
      comments,
    };
  } catch (err) {
    log(`    상세 페이지 수집 실패 (${item.documentId}): ${(err as Error).message}`);
    return null;
  }
}

// ─── Save to DB ──────────────────────────────────────────

/**
 * InstizArticle을 community_posts 테이블에 저장한다.
 *
 * @returns true if newly inserted, false if duplicate
 */
async function saveToDb(article: InstizArticle, board: string): Promise<boolean> {
  try {
    const rows = await db
      .insert(communityPosts)
      .values({
        id: `instiz_${article.documentId}`,
        source_platform: 'instiz',
        source_cafe: `instiz_${board}`,
        source_url: article.sourceUrl,
        title: article.title,
        body: article.body,
        comments: article.comments,
        author_nickname: article.authorNickname || null,
        like_count: article.likeCount,
        comment_count: article.commentCount,
        view_count: article.viewCount,
        posted_at: article.postedAt ?? undefined,
        collected_at: new Date(),
        analyzed: false,
        extracted_needs: [],
      })
      .onConflictDoNothing()
      .returning({ id: communityPosts.id });

    return rows.length > 0;
  } catch (err) {
    log(`    DB 저장 실패 (instiz_${article.documentId}): ${(err as Error).message}`);
    return false;
  }
}

// ─── Main Collector ──────────────────────────────────────

/**
 * 인스티즈 게시판 수집 메인 함수.
 *
 * @param board - 게시판 ('name_beauty' | 'pt')
 * @param pages - 수집할 페이지 수 (기본 1)
 * @param limit - 최대 수집 게시글 수 (기본 10)
 * @param shouldFetchComments - 댓글 수집 여부 (기본 false)
 */
export async function collectInstiz(
  board: string,
  pages: number,
  limit: number,
  shouldFetchComments: boolean,
): Promise<InstizCollectResult> {
  const startTime = Date.now();
  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let stale = 0;
  let failed = 0;

  const boardLabel = board === 'name_beauty' ? '뷰티' : board === 'pt' ? '인기글' : board;
  log(`=== 인스티즈 ${boardLabel.toUpperCase()} 수집 시작 ===`);
  log(`페이지: ${pages}, 최대: ${limit}개, 댓글: ${shouldFetchComments ? 'O' : 'X'}`);

  // Step 1: Collect list items from all pages
  const allItems: InstizListItem[] = [];

  for (let page = 1; page <= pages; page++) {
    log(`\n페이지 ${page}/${pages} 로드 중...`);
    try {
      const html = await fetchListPage(board, page);
      const items = parseListPage(html, board);
      log(`  게시글 ${items.length}개 추출`);
      allItems.push(...items);

      if (page < pages) {
        await requestDelay();
      }
    } catch (err) {
      log(`  페이지 ${page} 로드 실패: ${(err as Error).message}`);
    }
  }

  // Apply limit
  const targetItems = allItems.slice(0, limit);
  log(`\n총 ${allItems.length}개 중 ${targetItems.length}개 수집 대상`);

  // Step 2: Collect detail pages + save to DB
  for (let i = 0; i < targetItems.length; i++) {
    const item = targetItems[i];
    log(`  [${i + 1}/${targetItems.length}] ${item.title.slice(0, 40)}...`);

    const article = await collectArticle(item, board, shouldFetchComments);
    if (!article) {
      failed++;
      continue;
    }

    total++;

    // Skip articles with very short body
    if (article.body.length < 10) {
      log(`    본문 너무 짧음 (${article.body.length}자) — 스킵`);
      failed++;
      continue;
    }

    // Skip posts older than 16 hours
    if (article.postedAt) {
      const ageMs = startTime - article.postedAt.getTime();
      const maxAgeMs = 16 * 60 * 60 * 1000; // 16 hours
      if (ageMs > maxAgeMs) {
        log(`    16시간 초과 (${Math.round(ageMs / 3600000)}h) — 스킵`);
        stale++;
        continue;
      }
    }

    const isNew = await saveToDb(article, board);
    if (isNew) {
      inserted++;
      log(`    저장: ${article.viewCount}조회, ${article.comments.length}댓글, ${article.body.length}자`);
    } else {
      skipped++;
      log(`    중복 스킵`);
    }

    // Anti-bot delay between requests
    if (i < targetItems.length - 1) {
      await requestDelay();
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;

  log('\n=== 수집 완료 ===');
  log(`총 수집: ${total}개, 신규: ${inserted}개, 중복: ${skipped}개, 기간초과: ${stale}개, 실패: ${failed}개`);
  log(`소요 시간: ${elapsed.toFixed(0)}초`);

  return { total, inserted, skipped, stale, failed, elapsed };
}
