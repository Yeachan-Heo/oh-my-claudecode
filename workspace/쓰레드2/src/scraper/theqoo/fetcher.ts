/**
 * @file 더쿠 HTTP 요청 모듈.
 *
 * Node.js fetch API로 theqoo.net에서 HTML을 가져온다.
 * Cloudflare 차단 없음 확인됨 (SSR, Rhymix CMS).
 */

import { humanDelay } from '../../utils/timing.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BASE_URL = 'https://theqoo.net';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

/**
 * 더쿠 게시판 목록 페이지 HTML을 가져온다.
 *
 * @param board - 게시판 ID ('hot' | 'square')
 * @param page - 페이지 번호 (1부터)
 */
export async function fetchListPage(board: string, page: number): Promise<string> {
  const url = page > 1
    ? `${BASE_URL}/${board}?page=${page}`
    : `${BASE_URL}/${board}`;

  const res = await fetch(url, {
    headers: DEFAULT_HEADERS,
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`목록 페이지 요청 실패: ${res.status} ${res.statusText} (${url})`);
  }

  return res.text();
}

/**
 * 더쿠 상세 페이지 HTML을 가져온다.
 *
 * @param board - 게시판 ID
 * @param documentSrl - 게시글 고유 번호
 */
export async function fetchDetailPage(board: string, documentSrl: string): Promise<string> {
  const url = `${BASE_URL}/${board}/${documentSrl}`;

  const res = await fetch(url, {
    headers: DEFAULT_HEADERS,
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`상세 페이지 요청 실패: ${res.status} ${res.statusText} (${url})`);
  }

  return res.text();
}

/** Rhymix 댓글 API raw 응답 아이템 */
export interface RhymixCommentItem {
  srl: number;
  ct: string;  // HTML content
  rd: string;  // date: YYYYMMDDHHMMSS
  ind: string; // indent (-1 = top-level)
}

/** Rhymix 댓글 API 응답 */
export interface RhymixCommentResponse {
  comment_list: Record<string, RhymixCommentItem> | null;
  document_srl: number;
  now_comment_page: number;
}

/**
 * 더쿠 댓글 API (Rhymix dispTheqooContentCommentListTheqoo).
 *
 * 비회원은 1시간 이내 댓글이 숨겨지지만, 그 이전 댓글은 정상 조회 가능.
 * 전체 댓글을 가져오려면 page 1부터 순회해야 한다.
 *
 * @param documentSrl - 게시글 고유 번호
 * @param board - 게시판 ID (Referer용)
 * @param cpage - 댓글 페이지 (0 = 마지막, 1 = 첫 페이지)
 */
export async function fetchComments(
  documentSrl: string,
  board: string,
  cpage: number = 1,
): Promise<RhymixCommentResponse> {
  const res = await fetch(`${BASE_URL}/index.php`, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Referer': `${BASE_URL}/${board}/${documentSrl}`,
    },
    body: JSON.stringify({
      act: 'dispTheqooContentCommentListTheqoo',
      document_srl: parseInt(documentSrl, 10),
      cpage,
    }),
  });

  if (!res.ok) {
    throw new Error(`댓글 API 요청 실패: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<RhymixCommentResponse>;
}

/**
 * 요청 사이 anti-bot 딜레이 (1~2초 랜덤).
 */
export async function requestDelay(): Promise<void> {
  await humanDelay(1000, 2000);
}
