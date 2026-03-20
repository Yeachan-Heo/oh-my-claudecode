/**
 * @file 인스티즈 HTML 파서 — cheerio 기반.
 *
 * 목록 페이지와 상세 페이지 HTML을 파싱하여 구조화된 데이터로 변환한다.
 * 댓글은 상세 페이지 HTML에서 직접 파싱한다 (AJAX API 없음).
 */

import * as cheerio from 'cheerio';
import type { InstizListItem, InstizComment } from './types.js';

const BASE_URL = 'https://www.instiz.net';

// ─── List Page Parser ────────────────────────────────────

/**
 * 인스티즈 게시판 목록 HTML에서 게시글 목록을 추출한다.
 *
 * 인스티즈 목록 구조:
 *   table > tbody > tr
 *     td.listsubject > a[href="/{board}/{id}"]  — 제목 + 링크
 *     span#hit (목록에서는 미제공, 상세에서 수집)
 */
export function parseListPage(html: string, board: string): InstizListItem[] {
  const $ = cheerio.load(html);
  const items: InstizListItem[] = [];
  const seen = new Set<string>();

  $('table tbody tr').each((_i, row) => {
    const $row = $(row);

    // Skip notice/header/ad rows
    if ($row.hasClass('notice') || $row.hasClass('noticerow')) return;
    if ($row.find('td.no_mouseover').length) return;

    // Title + link: td.listsubject a or td[class*="listsubject"] a
    const titleLink = $row.find('td.listsubject a, td[class*="listsubject"] a').filter((_i, el) => {
      const href = $(el).attr('href') || '';
      return href.includes(`/${board}/`);
    }).first();

    if (!titleLink.length) return;

    const href = titleLink.attr('href') || '';

    // Extract document ID from href: /{board}/12345?...
    const idMatch = href.match(/\/(\d+)(?:\?.*)?$/);
    if (!idMatch) return;
    const documentId = idMatch[1];

    // Deduplicate: green (promoted) and main listing overlap
    if (seen.has(documentId)) return;
    seen.add(documentId);

    // Title: prefer div.sbj text (main listing) over full link text (green listing)
    const sbjEl = titleLink.find('div.sbj');
    let title: string;
    if (sbjEl.length) {
      // Main listing: remove comment count spans and subtitle
      sbjEl.find('.cmt2, .cmt3, .cmt, .btnvt, .minitext').remove();
      title = sbjEl.text().trim();
    } else {
      // Green listing: remove comment count spans
      const clone = titleLink.clone();
      clone.find('.cmt2, .cmt3, .cmt, .btnvt, .minitext').remove();
      title = clone.text().trim();
    }
    if (!title) return;

    // Comment count from span.cmt2 or span.cmt3 title attribute
    let commentCount = 0;
    const cmtSpan = titleLink.find('.cmt2, .cmt3, .cmt').first();
    if (cmtSpan.length) {
      commentCount = parseInt(cmtSpan.text().trim(), 10) || 0;
    }

    // View count: try separate td.listno cells (green listing) or subtitle text (main listing)
    let viewCount = 0;
    const listnoTds = $row.find('td.listno');
    if (listnoTds.length >= 2) {
      // Green listing: date | viewCount | likeCount in separate tds
      viewCount = parseInt(listnoTds.eq(1).text().trim().replace(/,/g, ''), 10) || 0;
    } else {
      // Main listing: "조회 N" in div.list_subtitle
      const subtitleText = titleLink.find('.list_subtitle').text();
      const viewMatch = subtitleText.match(/조회\s*(\d[\d,]*)/);
      if (viewMatch) {
        viewCount = parseInt(viewMatch[1].replace(/,/g, ''), 10) || 0;
      }
    }

    // Strip icon prefixes from title
    title = title.replace(/^\s*/, '').trim();

    items.push({
      documentId,
      title,
      href: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      viewCount,
      commentCount,
    });
  });

  return items;
}

// ─── Detail Page Parser ──────────────────────────────────

/**
 * 상세 페이지 HTML에서 본문, 제목, 작성자, 날짜, 조회수, 좋아요 수를 추출한다.
 *
 * 인스티즈 상세 구조:
 *   <title>{제목} - 인스티즈</title>
 *   div#memo_content_1        — 본문
 *   span#hit                  — 조회수
 *   댓글은 HTML에 직접 포함됨
 */
export function parseDetailPage(
  html: string,
  documentId: string,
  board: string,
): {
  title: string;
  body: string;
  authorNickname: string;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  postedAt: Date | null;
  sourceUrl: string;
} {
  const $ = cheerio.load(html);

  // ── Title: prefer #nowsubject (clean), fallback to <title> tag ──
  let title = '';
  const nowSubject = $('#nowsubject');
  if (nowSubject.length) {
    const clone = nowSubject.clone();
    clone.find('.cmt, .cmt2, .cmt3').remove();
    title = clone.text().trim();
  }
  if (!title) {
    title = $('title').text().trim();
    title = title.replace(/\s*[-–]\s*인스티즈.*$/i, '').trim();
  }

  // ── Body: div#memo_content_1 ──
  let body = '';
  const memoContent = $('#memo_content_1');
  if (memoContent.length) {
    memoContent.find('script, style').remove();
    body = memoContent.text().trim();
  }

  // Fallback: broader content selectors
  if (!body || body.length < 10) {
    const contentEl = $('.memo_content, .content, #content').first();
    if (contentEl.length) {
      contentEl.find('script, style').remove();
      body = contentEl.text().trim();
    }
  }

  // ── View count: span#hit ──
  let viewCount = 0;
  const hitEl = $('span#hit');
  if (hitEl.length) {
    viewCount = parseInt(hitEl.text().trim().replace(/,/g, ''), 10) || 0;
  }

  // ── Author ──
  const authorNickname =
    $('.memo_writer, .writer, .nick, .author').first().text().trim() ||
    $('[class*="writer"]').first().text().trim() ||
    '';

  // ── Date: prefer meta tag or itemprop attribute ──
  let postedAt: Date | null = null;
  const metaDate = $('meta[property="article:published_time"]').attr('content');
  if (metaDate) {
    postedAt = new Date(metaDate);
    if (isNaN(postedAt.getTime())) postedAt = null;
  }
  if (!postedAt) {
    const itempropDate = $('[itemprop="datePublished"]').attr('content');
    if (itempropDate) {
      postedAt = new Date(itempropDate);
      if (isNaN(postedAt.getTime())) postedAt = null;
    }
  }
  if (!postedAt) {
    const dateText =
      $('.memo_date, .date, time').first().text().trim() ||
      $('time').attr('datetime') ||
      '';
    postedAt = parseInstizDate(dateText);
  }

  // ── Like count ──
  let likeCount = 0;
  const likeEl = $('.like_count, .like, .good, [class*="like"]').first();
  if (likeEl.length) {
    likeCount = parseInt(likeEl.text().replace(/[^0-9]/g, ''), 10) || 0;
  }

  // ── Comment count: hidden input#cmt or span.cmt ──
  let commentCount = 0;
  const cmtInput = $('input#cmt');
  if (cmtInput.length) {
    commentCount = parseInt(cmtInput.val() as string, 10) || 0;
  } else {
    const cmtSpan = $('#nowsubject .cmt, .cmt_count').first();
    if (cmtSpan.length) {
      commentCount = parseInt(cmtSpan.text().replace(/[^0-9]/g, ''), 10) || 0;
    }
  }

  return {
    title,
    body: body.slice(0, 10000),
    authorNickname,
    likeCount,
    commentCount,
    viewCount,
    postedAt,
    sourceUrl: `${BASE_URL}/${board}/${documentId}`,
  };
}

// ─── Comment Parser ───────────────────────────────────────

/**
 * 상세 페이지 HTML에서 댓글 목록을 추출한다.
 *
 * 인스티즈는 댓글이 HTML에 직접 포함됨 (AJAX 없음).
 * 일반적인 댓글 컨테이너 선택자를 순차적으로 시도한다.
 */
export function parseComments(html: string): InstizComment[] {
  const $ = cheerio.load(html);
  const comments: InstizComment[] = [];

  // Instiz comment structure:
  //   #ajax_table tr.cmt_view — top-level comments
  //     span[id^="com"] — nickname (e.g., "쀼1")
  //     span[id^="n"]   — comment text
  //   div.cmt_sb > div.comment_r — nested replies
  //     span[id^="n"]   — reply text

  $('#ajax_table tr.cmt_view').each((_i, row) => {
    const $row = $(row);

    // Top-level comment
    const nickname = $row.find('span[id^="com"]').first().text().trim();
    const textEl = $row.find('td.comment_memo > div > .comment_line span[id^="n"]').first();
    if (!textEl.length) return;
    const text = textEl.text().trim();
    if (!text || text.includes('삭제된') || text.includes('차단된')) return;

    comments.push({
      nickname,
      text: text.slice(0, 500),
    });

    // Nested replies within div.cmt_sb
    $row.find('div.cmt_sb span[id^="n"]').each((_j, replyEl) => {
      const replyText = $(replyEl).text().trim();
      if (!replyText || replyText.includes('삭제된')) return;

      // Reply nickname from closest comment_r block
      const replyBlock = $(replyEl).closest('.cmt_sb');
      const replyNick = replyBlock.find('span[id^="com"]').first().text().trim();

      comments.push({
        nickname: replyNick,
        text: replyText.slice(0, 500),
      });
    });
  });

  return comments;
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * 인스티즈 날짜 문자열 파싱.
 * "2026.03.19 14:30", "26.03.19", "2026-03-19" 등
 */
function parseInstizDate(dateText: string): Date | null {
  const t = dateText.trim();
  if (!t) return null;

  // "2026.03.19 14:30:00" or "2026-03-19 14:30"
  const fullMatch = t.match(/(\d{4})[.\-/](\d{2})[.\-/](\d{2})\s*(\d{2}):(\d{2})/);
  if (fullMatch) {
    return new Date(
      parseInt(fullMatch[1]),
      parseInt(fullMatch[2]) - 1,
      parseInt(fullMatch[3]),
      parseInt(fullMatch[4]),
      parseInt(fullMatch[5]),
    );
  }

  // Short year: "26.03.19 14:30"
  const shortFull = t.match(/(\d{2})[.\-/](\d{2})[.\-/](\d{2})\s*(\d{2}):(\d{2})/);
  if (shortFull) {
    return new Date(
      2000 + parseInt(shortFull[1]),
      parseInt(shortFull[2]) - 1,
      parseInt(shortFull[3]),
      parseInt(shortFull[4]),
      parseInt(shortFull[5]),
    );
  }

  // Date only: "2026.03.19" or "26.03.19"
  const dateOnly = t.match(/(\d{2,4})[.\-/](\d{2})[.\-/](\d{2})/);
  if (dateOnly) {
    const year = dateOnly[1].length === 2 ? 2000 + parseInt(dateOnly[1]) : parseInt(dateOnly[1]);
    return new Date(year, parseInt(dateOnly[2]) - 1, parseInt(dateOnly[3]));
  }

  return null;
}
