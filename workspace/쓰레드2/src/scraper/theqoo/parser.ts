/**
 * @file 더쿠 HTML 파서 — cheerio 기반.
 *
 * 목록 페이지와 상세 페이지 HTML을 파싱하여 구조화된 데이터로 변환한다.
 * 댓글은 HTML에 없고 Rhymix AJAX API로 별도 요청해야 한다.
 */

import * as cheerio from 'cheerio';
import type { TheqooListItem, TheqooComment } from './types.js';
import type { RhymixCommentItem } from './fetcher.js';

const BASE_URL = 'https://theqoo.net';

// ─── List Page Parser ────────────────────────────────────

/**
 * HOT/square 게시판 목록 HTML에서 게시글 목록을 추출한다.
 *
 * 더쿠 목록 구조:
 *   table > tbody > tr
 *     td.title > a[href="/hot/{srl}"]  — 제목 + 링크
 *     td.cate                          — 카테고리
 *     td (숫자)                        — 조회수/댓글수
 */
export function parseListPage(html: string, board: string): TheqooListItem[] {
  const $ = cheerio.load(html);
  const items: TheqooListItem[] = [];

  $('table tbody tr').each((_i, row) => {
    const $row = $(row);

    // Skip notice rows
    if ($row.hasClass('notice')) return;

    // Title + link
    const titleLink = $row.find('td.title a').filter((_i, el) => {
      const href = $(el).attr('href') || '';
      return href.startsWith(`/${board}/`) && /\/\d+$/.test(href);
    }).first();

    if (!titleLink.length) return;

    const href = titleLink.attr('href') || '';
    const title = titleLink.text().trim();
    if (!title) return;

    // Extract document_srl from href: /hot/12345
    const srlMatch = href.match(/\/(\d+)$/);
    if (!srlMatch) return;
    const documentSrl = srlMatch[1];

    // Category
    const category = $row.find('td.cate').text().trim();

    // View count and comment count from td elements
    // 더쿠 테이블: 번호(no) | 카테고리(cate) | 제목(title) | 날짜(time) | 조회(m_no)
    let viewCount = 0;
    let commentCount = 0;

    // 조회수는 td.m_no (마지막 컬럼)
    const viewTd = $row.find('td.m_no');
    if (viewTd.length) {
      viewCount = parseInt(viewTd.text().trim().replace(/,/g, ''), 10) || 0;
    }

    // 댓글 수는 제목 옆에 [N] 형태로 표시됨
    const titleCell = $row.find('td.title').text();
    const commentMatch = titleCell.match(/\[(\d+)\]/);
    if (commentMatch) {
      commentCount = parseInt(commentMatch[1], 10) || 0;
    }

    items.push({
      documentSrl,
      title: title.replace(/\[\d+\]/, '').trim(), // 댓글 수 제거
      category,
      href: `${BASE_URL}${href}`,
      viewCount,
      commentCount,
    });
  });

  return items;
}

// ─── Detail Page Parser ──────────────────────────────────

/**
 * 상세 페이지 HTML에서 본문, 제목, 작성자, 날짜, 좋아요 수, 댓글 수를 추출한다.
 *
 * 더쿠 상세 구조 (Rhymix CMS):
 *   <title>더쿠 - {제목}</title>
 *   .rd_body article .xe_content  — 본문
 *   댓글은 JS로 동적 로드 (loadReply) — 별도 API 호출 필요
 */
export function parseDetailPage(
  html: string,
  documentSrl: string,
  board: string,
): {
  title: string;
  body: string;
  authorNickname: string;
  likeCount: number;
  commentCount: number;
  postedAt: Date | null;
  sourceUrl: string;
} {
  const $ = cheerio.load(html);

  // ── Title: <title> 태그에서 "더쿠 - " 접두사 제거 ──
  let title = $('title').text().trim();
  title = title.replace(/^더쿠\s*-\s*/, '');

  // ── Body: .rd_body article .xe_content ──
  let body = '';

  const xeContent = $('.rd_body article .xe_content');
  if (xeContent.length) {
    xeContent.find('script, style').remove();
    body = xeContent.text().trim();
  }

  // Fallback: .rd_body
  if (!body || body.length < 10) {
    const rdBody = $('.rd_body');
    if (rdBody.length) {
      rdBody.find('script, style, .rd_nav').remove();
      body = rdBody.text().trim();
    }
  }

  // ── Author ──
  const authorNickname =
    $('.rd_hd .nick').first().text().trim() ||
    $('.author .nick').first().text().trim() ||
    $('.member_nick a').first().text().trim() ||
    '';

  // ── Date ──
  // 더쿠 상세: .rd_hd .board .btm_area .side.fr > span 에 "2026.03.19 23:43" 형태
  const dateText =
    $('.rd_hd .btm_area .side.fr span').text().trim() ||
    $('.rd_hd .board .side.fr').text().trim() ||
    $('time[datetime]').attr('datetime') ||
    $('time').text().trim() ||
    '';
  const postedAt = parseTheqooDate(dateText);

  // ── Like count ──
  let likeCount = 0;
  const likeEl = $('.rd_like .like_count, .rd_hd .like, .vote_area .count').first();
  if (likeEl.length) {
    likeCount = parseInt(likeEl.text().replace(/[^0-9]/g, ''), 10) || 0;
  }

  // ── Comment count from HTML (댓글 N개) ──
  let commentCount = 0;
  const commentHeader = $('.comment_header_bar').text();
  const cmtCountMatch = commentHeader.match(/(\d+)/);
  if (cmtCountMatch) {
    commentCount = parseInt(cmtCountMatch[1], 10) || 0;
  }

  return {
    title,
    body: body.slice(0, 10000),
    authorNickname,
    likeCount,
    commentCount,
    postedAt,
    sourceUrl: `${BASE_URL}/${board}/${documentSrl}`,
  };
}

// ─── Comment API Response Parser ─────────────────────────

/**
 * Rhymix 댓글 API 응답에서 TheqooComment 배열을 추출한다.
 *
 * API 응답 형식:
 *   { srl: number, ct: string (HTML), rd: string (YYYYMMDDHHMMSS), ind: string }
 *
 * 비회원은 1시간 이내 댓글이 숨겨짐 (commentWarningMessage).
 */
export function parseComments(
  commentList: Record<string, RhymixCommentItem> | null,
): TheqooComment[] {
  if (!commentList) return [];

  const comments: TheqooComment[] = [];

  for (const key of Object.keys(commentList)) {
    const item = commentList[key];
    const content = item.ct || '';

    // Skip hidden comments (비회원 1시간 제한)
    if (content.includes('commentWarningMessage')) continue;

    // Strip HTML tags to get plain text
    const text = content
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .trim();

    if (!text || text.length === 0) continue;

    comments.push({
      nickname: '', // 비회원 API에서는 닉네임 미제공
      text: text.slice(0, 500),
    });
  }

  return comments;
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * 더쿠 날짜 문자열 파싱.
 * "2026.03.19 14:30:00", "2026-03-19 14:30", "2026.03.19" 등
 */
function parseTheqooDate(dateText: string): Date | null {
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

  // Date only: "2026.03.19"
  const dateOnly = t.match(/(\d{4})[.\-/](\d{2})[.\-/](\d{2})/);
  if (dateOnly) {
    return new Date(parseInt(dateOnly[1]), parseInt(dateOnly[2]) - 1, parseInt(dateOnly[3]));
  }

  return null;
}
