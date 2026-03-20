import type { Page } from 'playwright';
import { db } from '../../db/index.js';
import { communityPosts } from '../../db/schema.js';
import { humanDelay } from '../../utils/timing.js';
import type { CafeTarget, CafeArticle, CollectedPost } from './types.js';
import { parseCafeDate, getCafeMainFrame } from './parser.js';

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Article List Extraction ─────────────────────────────

/**
 * 카페 인기글 페이지에서 게시글 목록을 추출한다.
 *
 * clubid가 있으면 /f-e/cafes/{clubid}/popular (인기글) 사용.
 * 없으면 카페 메인 페이지 폴백.
 */
export async function extractArticleList(
  page: Page,
  cafe: CafeTarget,
  limit: number,
): Promise<CafeArticle[]> {
  const url = cafe.clubid
    ? `https://cafe.naver.com/f-e/cafes/${cafe.clubid}/popular`
    : `https://cafe.naver.com/${cafe.id}`;
  log(`  ${cafe.clubid ? '인기글' : '카페 메인'} 로드: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await humanDelay(3000, 5000);

  const frame = await getCafeMainFrame(page);
  if (!frame) {
    log('  cafe_main 프레임을 찾을 수 없음');
    return [];
  }

  // Wait for content
  await humanDelay(1500, 2500);

  const cafeId = cafe.id;
  const articles = await frame.evaluate((args: { maxArticles: number; cafeId: string }) => {
    const results: Array<{ articleId: string; title: string; href: string }> = [];
    const seen = new Set<string>();
    const links = document.querySelectorAll('a');

    for (const a of links) {
      if (results.length >= args.maxArticles) break;

      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim();

      // Skip short text (navigation, UI elements)
      if (!text || text.length < 4 || text.length > 200) continue;

      // Match article ID from various URL patterns:
      // - /cafeid/12345
      // - articleid=12345
      // - /articles/12345
      let articleId = '';
      const patterns = [
        href.match(new RegExp(`/${args.cafeId}/(\\d{5,})`)),
        href.match(/articleid=(\d+)/),
        href.match(/\/articles\/(\d+)/),
      ];
      for (const m of patterns) {
        if (m) { articleId = m[1]; break; }
      }
      if (!articleId) continue;

      // Skip duplicates
      if (seen.has(articleId)) continue;
      seen.add(articleId);

      // Skip common non-article patterns (notices, events with very short text)
      if (text.includes('[공지]') || text.includes('[안내]')) continue;

      results.push({ articleId, title: text.slice(0, 100), href });
    }

    return results;
  }, { maxArticles: limit * 2, cafeId }); // Fetch extra to filter

  log(`  게시글 추출: ${articles.length}개`);
  return articles.slice(0, limit);
}

// ─── Article Content Extraction ──────────────────────────

export async function extractArticleContent(
  page: Page,
  cafe: CafeTarget,
  article: CafeArticle,
): Promise<CollectedPost | null> {
  // Build full URL: the href from the frame already contains the full path
  let fullUrl: string;
  if (article.href.startsWith('http')) {
    fullUrl = article.href;
  } else {
    fullUrl = `https://cafe.naver.com${article.href}`;
  }

  try {
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await humanDelay(2000, 4000);

    // 새 URL 형식(/ca-fe/cafes/...)은 iframe 없이 직접 렌더링,
    // 구 URL 형식(ArticleRead.nhn)은 cafe_main iframe 사용
    const frame = page.frame('cafe_main');
    const target = frame || page;

    // Wait for content to load
    try {
      await target.waitForSelector(
        '.se-main-container, .ContentRenderer, #body, .article_viewer, .post-content, article',
        { timeout: 8000 },
      );
    } catch {
      // Try anyway
    }

    const content = await target.evaluate((): {
      body: string;
      nickname: string;
      viewCount: number;
      likeCount: number;
      commentCount: number;
      dateText: string;
      comments: Array<{ nickname: string; text: string; like_count: number }>;
    } => {
      // ── Extract body text ──
      let body = '';

      // SmartEditor 3 (SE3) — most modern cafe posts
      const se3Container = document.querySelector('.se-main-container');
      if (se3Container) {
        const textParts: string[] = [];
        const paragraphs = se3Container.querySelectorAll(
          '.se-text-paragraph, .se-module-text p, .se-text, .se-module-text span',
        );
        for (const p of paragraphs) {
          const t = (p.textContent || '').trim();
          if (t) textParts.push(t);
        }
        body = textParts.join('\n');
      }

      // Fallback: ContentRenderer or article_viewer
      if (!body || body.length < 20) {
        const contentSelectors = [
          '.ContentRenderer',
          '.article_viewer',
          '#body',
          '.post-content',
          'article',
          '.content_area',
          '#art_body',
          '.ArticleContentBox',
        ];
        for (const sel of contentSelectors) {
          const el = document.querySelector(sel);
          if (el && (el.textContent || '').trim().length > 20) {
            body = (el.textContent || '').trim();
            break;
          }
        }
      }

      // Last fallback
      if (!body || body.length < 20) {
        body = (document.body.textContent || '').trim().slice(0, 5000);
      }

      // ── Extract metadata ──
      let nickname = '';
      const nickSelectors = [
        '.nickname a',
        '.profile_info .nick',
        '.WriterInfo .nickname',
        '.article_writer .nick',
        '.profile_area .nickname',
        '.nick_btn',
      ];
      for (const sel of nickSelectors) {
        const el = document.querySelector(sel);
        if (el) { nickname = (el.textContent || '').trim(); break; }
      }

      let viewCount = 0;
      const viewSelectors = [
        '.article_info .count',
        '.article_info .no',
        '.view_count',
        '[class*="view"] .num',
      ];
      for (const sel of viewSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          viewCount = parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10) || 0;
          if (viewCount > 0) break;
        }
      }
      // Fallback: search for "조회 N" pattern in full page text
      if (viewCount === 0) {
        const allText = document.body.innerText || '';
        const viewMatch = allText.match(/조회\s*([\d,]+)/);
        if (viewMatch) viewCount = parseInt(viewMatch[1].replace(/,/g, ''), 10) || 0;
      }

      let likeCount = 0;
      const likeSelectors = [
        '.like_article .u_cnt',
        '.sympathy_cnt',
        '[class*="like"] .count',
        '.like_count',
      ];
      for (const sel of likeSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          likeCount = parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10) || 0;
          if (likeCount > 0) break;
        }
      }

      let commentCount = 0;
      const commentCountSelectors = [
        '.comment_count',
        '.comment_info .count',
        '[class*="comment"] .num',
        '.CommentCount',
      ];
      for (const sel of commentCountSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          commentCount = parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10) || 0;
          if (commentCount > 0) break;
        }
      }

      let dateText = '';
      const dateSelectors = [
        '.article_info .date',
        '.WriterInfo .date',
        'time',
        '.article_writer .date',
        '.article_info span.date',
      ];
      for (const sel of dateSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          dateText = (el.textContent || el.getAttribute('datetime') || '').trim();
          if (dateText) break;
        }
      }

      // ── Extract comments ──
      const comments: Array<{ nickname: string; text: string; like_count: number }> = [];
      const commentSelectors = [
        '.comment_box .comment_text_box',
        '.CommentItem',
        '.comment_area .comment_item',
        'ul.comment_list > li',
        '.CommentBox',
        '.comment_list_box .comment_item',
      ];

      for (const sel of commentSelectors) {
        const items = document.querySelectorAll(sel);
        if (items.length === 0) continue;

        for (const item of items) {
          const cmtNickEl = item.querySelector(
            '.comment_nickname a, .nickname, .comment_info_date .nick, .nick_btn',
          );
          const cmtTextEl = item.querySelector(
            '.comment_text_view span, .comment_text, .text_comment, .comment_content',
          );
          const cmtLikeEl = item.querySelector(
            '.comment_like .u_cnt, .like_count, .sympathy .count',
          );

          const cmtNick = cmtNickEl ? (cmtNickEl.textContent || '').trim() : '';
          const cmtText = cmtTextEl ? (cmtTextEl.textContent || '').trim() : '';
          const cmtLike = cmtLikeEl
            ? parseInt((cmtLikeEl.textContent || '').replace(/[^0-9]/g, ''), 10) || 0
            : 0;

          if (cmtText && cmtText.length > 1) {
            comments.push({ nickname: cmtNick, text: cmtText.slice(0, 500), like_count: cmtLike });
          }
        }

        if (comments.length > 0) break; // Use first matching selector set
      }

      return {
        body: body.slice(0, 10000),
        nickname,
        viewCount,
        likeCount,
        commentCount,
        dateText,
        comments,
      };
    });

    const postedAt = parseCafeDate(content.dateText || '');

    return {
      id: `${cafe.id}_${article.articleId}`,
      title: article.title,
      body: content.body,
      url: fullUrl,
      nickname: content.nickname,
      viewCount: content.viewCount,
      likeCount: content.likeCount,
      commentCount: content.commentCount,
      postedAt,
      comments: content.comments,
    };
  } catch (err) {
    log(`    글 수집 실패 (${article.articleId}): ${(err as Error).message}`);
    return null;
  }
}

// ─── DB Save ─────────────────────────────────────────────

export async function saveToDb(post: CollectedPost, cafe: CafeTarget): Promise<boolean> {
  try {
    const rows = await db
      .insert(communityPosts)
      .values({
        id: post.id,
        source_platform: 'naver_cafe',
        source_cafe: cafe.id,
        source_url: post.url,
        title: post.title,
        body: post.body,
        comments: post.comments,
        author_nickname: post.nickname || null,
        like_count: post.likeCount,
        comment_count: post.commentCount,
        view_count: post.viewCount,
        posted_at: post.postedAt ?? undefined,
        collected_at: new Date(),
        analyzed: false,
        extracted_needs: [],
      })
      .onConflictDoNothing()
      .returning({ id: communityPosts.id });

    return rows.length > 0;
  } catch (err) {
    log(`    DB 저장 실패 (${post.id}): ${(err as Error).message}`);
    return false;
  }
}

// ─── Main collection function for a single cafe ──────────

/**
 * 단일 카페의 인기글을 수집하고 DB에 저장한다.
 * Returns { inserted, skipped, failed, articles }
 */
export async function collectCafe(
  page: Page,
  cafe: CafeTarget,
  limit: number,
): Promise<{ inserted: number; skipped: number; failed: number; collected: number }> {
  log(`\n▶ 카페: ${cafe.name} (${cafe.id})`);

  const articles = await extractArticleList(page, cafe, limit);
  if (articles.length === 0) {
    log(`  게시글 없음 — 스킵`);
    return { inserted: 0, skipped: 0, failed: 0, collected: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let collected = 0;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    log(`  [${i + 1}/${articles.length}] ${article.title.slice(0, 40)}...`);

    const post = await extractArticleContent(page, cafe, article);
    if (!post) {
      failed++;
      continue;
    }

    collected++;

    // Body too short — likely access restricted
    if (post.body.length < 20) {
      log(`    본문 너무 짧음 (${post.body.length}자) — 접근 제한 가능`);
      failed++;
      continue;
    }

    const isNew = await saveToDb(post, cafe);
    if (isNew) {
      inserted++;
      log(`    저장: ${post.viewCount}조회, ${post.comments.length}댓글, ${post.body.length}자`);
    } else {
      skipped++;
      log(`    중복 스킵`);
    }

    // Anti-bot delay: 2~4초
    if (i < articles.length - 1) {
      await humanDelay(2000, 4000);
    }
  }

  log(`  결과: 신규 ${inserted}개, 중복 ${skipped}개, 실패 ${failed}개`);
  return { inserted, skipped, failed, collected };
}
