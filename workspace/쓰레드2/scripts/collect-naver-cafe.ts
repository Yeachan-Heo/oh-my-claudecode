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
import { db } from '../src/db/index.js';
import { communityPosts } from '../src/db/schema.js';
import type { Page, Frame } from 'playwright';

// ─── Constants ───────────────────────────────────────────

/**
 * 수집 대상 카페 목록.
 *
 * - cosmania: 파우더룸 (뷰티 커뮤니티, clubid=10050813)
 * - beautytalk: 뷰티톡 (뷰티 리뷰)
 *
 * 추후 직장인/생활 카페 추가 가능.
 */
const CAFE_TARGETS: CafeTarget[] = [
  { id: 'cosmania', name: '파우더룸', category: '뷰티', clubid: '10050813' },
  { id: 'beautytalk', name: '뷰티톡', category: '뷰티', clubid: '' },
  { id: 'jihosoccer123', name: '아프니까 사장이다', category: '자영업', clubid: '23611966' },
];

// ─── Types ───────────────────────────────────────────────

interface CafeTarget {
  id: string;
  name: string;
  category: string;
  clubid: string;
}

interface CafeArticle {
  articleId: string;
  title: string;
  href: string;
}

interface CollectedPost {
  id: string;
  title: string;
  body: string;
  url: string;
  nickname: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  postedAt: Date | null;
  comments: Array<{ nickname: string; text: string; like_count?: number }>;
}

interface CliOptions {
  cafes: CafeTarget[];
  limit: number;
}

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── CLI ─────────────────────────────────────────────────

function parseCliArgs(): CliOptions {
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
        cafes.push({ id: cafeId, name: cafeId, category: '기타' });
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

// ─── Date Parsing ────────────────────────────────────────

function parseCafeDate(dateText: string): Date | null {
  const t = dateText.trim();

  // "2026.03.19." or "2026.03.19"
  const dotMatch = t.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (dotMatch) {
    return new Date(parseInt(dotMatch[1]), parseInt(dotMatch[2]) - 1, parseInt(dotMatch[3]));
  }

  // "03.19." (current year)
  const shortDotMatch = t.match(/^(\d{2})\.(\d{2})/);
  if (shortDotMatch) {
    const now = new Date();
    return new Date(now.getFullYear(), parseInt(shortDotMatch[1]) - 1, parseInt(shortDotMatch[2]));
  }

  // "N분 전", "N시간 전", "N일 전"
  const now = new Date();
  const minMatch = t.match(/(\d+)\s*분\s*전/);
  if (minMatch) { now.setMinutes(now.getMinutes() - parseInt(minMatch[1])); return now; }

  const hourMatch = t.match(/(\d+)\s*시간\s*전/);
  if (hourMatch) { now.setHours(now.getHours() - parseInt(hourMatch[1])); return now; }

  const dayMatch = t.match(/(\d+)\s*일\s*전/);
  if (dayMatch) { now.setDate(now.getDate() - parseInt(dayMatch[1])); return now; }

  return null;
}

// ─── iframe helper ───────────────────────────────────────

/**
 * 네이버 카페의 cafe_main iframe 프레임을 가져온다.
 * 카페 글은 항상 이 iframe 안에 렌더링된다.
 */
async function getCafeMainFrame(page: Page): Promise<Frame | null> {
  // Wait for the iframe to appear
  try {
    await page.waitForSelector('iframe#cafe_main', { timeout: 10000 });
  } catch {
    try {
      await page.waitForSelector('iframe[name="cafe_main"]', { timeout: 5000 });
    } catch {
      return null;
    }
  }

  const frame = page.frame('cafe_main');
  if (frame) {
    try {
      await frame.waitForLoadState('domcontentloaded');
    } catch {
      // Best effort
    }
  }
  return frame;
}

// ─── Article List Extraction ─────────────────────────────

/**
 * 카페 인기글 페이지에서 게시글 목록을 추출한다.
 *
 * clubid가 있으면 /f-e/cafes/{clubid}/popular (인기글) 사용.
 * 없으면 카페 메인 페이지 폴백.
 */
async function extractArticleList(
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

async function extractArticleContent(
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
      // Direct element
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

async function saveToDb(post: CollectedPost, cafe: CafeTarget): Promise<boolean> {
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
  const allResults: Array<{
    cafe: string;
    title: string;
    views: number;
    comments: number;
    body_len: number;
  }> = [];

  try {
    for (const cafe of opts.cafes) {
      log(`\n▶ 카페: ${cafe.name} (${cafe.id})`);

      // Step 1: Get article list from main page
      const articles = await extractArticleList(page, cafe, opts.limit);
      if (articles.length === 0) {
        log(`  게시글 없음 — 스킵`);
        continue;
      }

      let inserted = 0;
      let skipped = 0;
      let failed = 0;

      // Step 2: Visit each article
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        log(`  [${i + 1}/${articles.length}] ${article.title.slice(0, 40)}...`);

        const post = await extractArticleContent(page, cafe, article);
        if (!post) {
          failed++;
          continue;
        }

        totalCollected++;

        // Body too short — likely access restricted
        if (post.body.length < 20) {
          log(`    본문 너무 짧음 (${post.body.length}자) — 접근 제한 가능`);
          failed++;
          continue;
        }

        // Save to DB
        const isNew = await saveToDb(post, cafe);
        if (isNew) {
          inserted++;
          totalInserted++;
          log(`    저장: ${post.viewCount}조회, ${post.comments.length}댓글, ${post.body.length}자`);
        } else {
          skipped++;
          log(`    중복 스킵`);
        }

        allResults.push({
          cafe: cafe.id,
          title: post.title.slice(0, 30),
          views: post.viewCount,
          comments: post.comments.length,
          body_len: post.body.length,
        });

        // Anti-bot delay: 2~4초
        if (i < articles.length - 1) {
          await humanDelay(2000, 4000);
        }
      }

      log(`  결과: 신규 ${inserted}개, 중복 ${skipped}개, 실패 ${failed}개`);

      // Delay between cafes
      if (opts.cafes.indexOf(cafe) < opts.cafes.length - 1) {
        const delay = await humanDelay(5000, 10000);
        log(`  다음 카페까지 대기: ${(delay / 1000).toFixed(1)}초`);
      }
    }
  } finally {
    await browser.close();
    log('\n브라우저 disconnect 완료');
  }

  // Summary table
  const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);
  log('\n=== 수집 완료 ===');
  log(`총 수집: ${totalCollected}개, DB 신규 저장: ${totalInserted}개`);
  log(`소요 시간: ${elapsed}초`);

  if (allResults.length > 0) {
    log('\n┌─────────────┬────────────────────────────────┬───────┬───────┬────────┐');
    log('│ 카페        │ 제목                           │ 조회  │ 댓글  │ 본문   │');
    log('├─────────────┼────────────────────────────────┼───────┼───────┼────────┤');
    for (const r of allResults) {
      const cafeCol = r.cafe.padEnd(11);
      const title = r.title.padEnd(30).slice(0, 30);
      const views = String(r.views).padStart(5);
      const cmts = String(r.comments).padStart(5);
      const body = String(r.body_len).padStart(6);
      log(`│ ${cafeCol} │ ${title} │ ${views} │ ${cmts} │ ${body} │`);
    }
    log('└─────────────┴────────────────────────────────┴───────┴───────┴────────┘');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
