/**
 * @file 인스티즈 HTTP 요청 모듈.
 *
 * Node.js fetch API로 instiz.net에서 HTML을 가져온다.
 * Cloudflare 차단 없음 확인됨 (SSR, 로그인 불필요).
 */

import { humanDelay } from '../../utils/timing.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BASE_URL = 'https://www.instiz.net';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

/**
 * 인스티즈 게시판 목록 페이지 HTML을 가져온다.
 *
 * @param board - 게시판 ID ('name_beauty' | 'pt')
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
 * 인스티즈 상세 페이지 HTML을 가져온다.
 *
 * @param board - 게시판 ID
 * @param documentId - 게시글 고유 번호
 */
export async function fetchDetailPage(board: string, documentId: string): Promise<string> {
  const url = `${BASE_URL}/${board}/${documentId}`;

  const res = await fetch(url, {
    headers: DEFAULT_HEADERS,
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`상세 페이지 요청 실패: ${res.status} ${res.statusText} (${url})`);
  }

  return res.text();
}

/**
 * 요청 사이 anti-bot 딜레이 (1~2초 랜덤).
 */
export async function requestDelay(): Promise<void> {
  await humanDelay(1000, 2000);
}
