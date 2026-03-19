/**
 * @file 더쿠 수집 오케스트레이터.
 *
 * 목록 페이지 → 상세 페이지 → (선택) 댓글 API → community_posts DB 저장.
 * source_platform='theqoo', source_cafe='theqoo_hot' 등으로 통합 저장.
 */

import { db } from '../../db/index.js';
import { communityPosts } from '../../db/schema.js';
import { fetchListPage, fetchDetailPage, fetchComments, requestDelay } from './fetcher.js';
import { parseListPage, parseDetailPage, parseComments } from './parser.js';
import type { TheqooListItem, TheqooArticle, TheqooComment, TheqooCollectResult } from './types.js';

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Collect Comments via API ────────────────────────────

/**
 * Rhymix 댓글 API로 첫 페이지 댓글을 가져온다.
 * 비회원은 1시간 이내 댓글이 숨겨지지만, 이전 댓글은 정상 조회 가능.
 */
async function collectComments(
  documentSrl: string,
  board: string,
): Promise<TheqooComment[]> {
  try {
    const response = await fetchComments(documentSrl, board, 1);
    return parseComments(response.comment_list);
  } catch (err) {
    log(`    댓글 수집 실패 (${documentSrl}): ${(err as Error).message}`);
    return [];
  }
}

// ─── Collect Single Article ──────────────────────────────

/**
 * 단일 게시글 상세 페이지를 수집하여 TheqooArticle로 변환한다.
 */
async function collectArticle(
  item: TheqooListItem,
  board: string,
  shouldFetchComments: boolean,
): Promise<TheqooArticle | null> {
  try {
    const html = await fetchDetailPage(board, item.documentSrl);
    const detail = parseDetailPage(html, item.documentSrl, board);

    // Fetch comments via API if requested
    let comments: TheqooComment[] = [];
    if (shouldFetchComments) {
      await requestDelay();
      comments = await collectComments(item.documentSrl, board);
    }

    return {
      documentSrl: item.documentSrl,
      title: detail.title,
      body: detail.body,
      category: item.category,
      authorNickname: detail.authorNickname,
      viewCount: item.viewCount,
      likeCount: detail.likeCount,
      commentCount: detail.commentCount || item.commentCount,
      postedAt: detail.postedAt,
      sourceUrl: detail.sourceUrl,
      comments,
    };
  } catch (err) {
    log(`    상세 페이지 수집 실패 (${item.documentSrl}): ${(err as Error).message}`);
    return null;
  }
}

// ─── Save to DB ──────────────────────────────────────────

/**
 * TheqooArticle을 community_posts 테이블에 저장한다.
 *
 * @returns true if newly inserted, false if duplicate
 */
async function saveToDb(article: TheqooArticle, board: string): Promise<boolean> {
  try {
    const rows = await db
      .insert(communityPosts)
      .values({
        id: `theqoo_${article.documentSrl}`,
        source_platform: 'theqoo',
        source_cafe: `theqoo_${board}`,
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
    log(`    DB 저장 실패 (theqoo_${article.documentSrl}): ${(err as Error).message}`);
    return false;
  }
}

// ─── Main Collector ──────────────────────────────────────

/**
 * 더쿠 게시판 수집 메인 함수.
 *
 * @param board - 게시판 ('hot' | 'square')
 * @param pages - 수집할 페이지 수 (기본 1)
 * @param limit - 최대 수집 게시글 수 (기본 10)
 * @param shouldFetchComments - 댓글 수집 여부 (기본 false)
 */
export async function collectTheqoo(
  board: string,
  pages: number,
  limit: number,
  shouldFetchComments: boolean,
): Promise<TheqooCollectResult> {
  const startTime = Date.now();
  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  log(`=== 더쿠 ${board.toUpperCase()} 수집 시작 ===`);
  log(`페이지: ${pages}, 최대: ${limit}개, 댓글: ${shouldFetchComments ? 'O' : 'X'}`);

  // Step 1: Collect list items from all pages
  const allItems: TheqooListItem[] = [];

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
  log(`총 수집: ${total}개, 신규: ${inserted}개, 중복: ${skipped}개, 실패: ${failed}개`);
  log(`소요 시간: ${elapsed.toFixed(0)}초`);

  return { total, inserted, skipped, failed, elapsed };
}
