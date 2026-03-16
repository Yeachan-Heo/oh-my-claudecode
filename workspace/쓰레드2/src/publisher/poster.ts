/**
 * @file poster.ts
 * Playwright CDP(9223)로 Threads UI를 직접 조작하여 포스트를 게시한다.
 *
 * Usage:
 *   import { postToThreads } from './poster.js';
 *   const result = await postToThreads({ text: '...', accountId: 'acc-1' });
 */

import type { Browser, Page } from 'playwright';
import type { PostOptions, PostResult } from '../types.js';
import { gaussRandom, humanDelay } from '../utils/timing.js';
import { connectBrowser } from '../utils/browser.js';

// Re-export for backward compatibility
export { gaussianDelay } from '../utils/timing.js';

// ─── Config ──────────────────────────────────────────────

const THREADS_URL = 'https://www.threads.com';

/** DOM selectors — 상수로 분리하여 UI 변경 시 쉽게 업데이트 */
const SELECTORS = {
  // 새 글 작성 버튼
  newPostButton: '[aria-label="Create"], [aria-label="만들기"], [aria-label="New thread"], [aria-label="새 스레드"]',
  // 텍스트 입력 영역
  textInput: '[contenteditable="true"][role="textbox"], div[contenteditable="true"][data-text="true"], p[contenteditable="true"]',
  // 게시 버튼
  postButton: 'div[role="button"]:has-text("Post"), div[role="button"]:has-text("게시"), button:has-text("Post"), button:has-text("게시")',
  // 댓글 입력
  commentInput: '[contenteditable="true"][role="textbox"]',
  // 댓글 게시 버튼
  commentPostButton: 'div[role="button"]:has-text("Post"), div[role="button"]:has-text("게시"), button:has-text("Post"), button:has-text("게시")',
  // 로그인 상태 확인
  loggedInIndicator: '[aria-label="Home"], [aria-label="홈"], article',
  // 자기 포스트 (방금 게시한 것)
  ownPost: 'article',
} as const;

const TIMING = {
  pageLoad:    { min: 3000, max: 6000 },
  actionDelay: { min: 2000, max: 5000 },
  typeChar:    { min: 80, max: 200 },
  mouseMove:   { min: 100, max: 500 },
  postWait:    { min: 3000, max: 8000 },
} as const;

// ─── Utility Functions ───────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function randomMouseMove(page: Page): Promise<void> {
  const x = randInt(100, 900);
  const y = randInt(100, 600);
  await page.mouse.move(x, y, { steps: randInt(5, 15) });
  await humanDelay(TIMING.mouseMove.min, TIMING.mouseMove.max);
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[poster][${ts}] ${msg}`);
}

/**
 * 사람처럼 텍스트를 입력한다 (가우스 타이밍, 80~200ms/글자).
 */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.click();
  await humanDelay(300, 800);

  for (const char of text) {
    await el.pressSequentially(char, {
      delay: gaussRandom(TIMING.typeChar.min, TIMING.typeChar.max),
    });
  }
}

// ─── Post URL Extraction ─────────────────────────────────

function extractPostId(url: string): string | undefined {
  // Threads URL 형식: https://www.threads.net/@username/post/XXXXX
  const match = url.match(/\/post\/([A-Za-z0-9_-]+)/);
  return match?.[1];
}

// ─── Core Posting ────────────────────────────────────────

/**
 * Threads에 포스트를 게시한다.
 *
 * Playwright CDP로 Threads UI를 직접 조작:
 * 1. Chrome CDP 연결
 * 2. Threads 홈 접속 + 로그인 상태 확인
 * 3. 새 글 작성 → 텍스트 입력 → 게시
 * 4. selfComment가 있으면 댓글 추가
 * 5. postId/postUrl 추출하여 반환
 */
export async function postToThreads(options: PostOptions): Promise<PostResult> {
  const { text, accountId, selfComment, dryRun } = options;

  if (dryRun) {
    log(`[dryRun] 게시 시뮬레이션 — accountId=${accountId}, text="${text.slice(0, 50)}..."`);
    return {
      success: true,
      postId: `dry-run-${Date.now()}`,
      postUrl: `https://www.threads.net/@test/post/dry-run-${Date.now()}`,
    };
  }

  let browser: Browser;
  try {
    browser = await connectBrowser();
  } catch (e) {
    const err = e as Error;
    return { success: false, error: err.message };
  }

  try {
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) {
      return { success: false, error: 'BrowserContext가 없습니다.' };
    }

    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    // Step 1: Threads 홈 접속
    log('Threads 홈 접속...');
    await randomMouseMove(page);
    await page.goto(THREADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(TIMING.pageLoad.min, TIMING.pageLoad.max);

    // Step 2: 로그인 상태 확인
    const loggedIn = await page.locator(SELECTORS.loggedInIndicator).first().isVisible().catch(() => false);
    if (!loggedIn) {
      return { success: false, error: '로그인되지 않은 상태입니다. 먼저 loginThreads()를 실행하세요.' };
    }
    log('로그인 상태 확인 완료');

    // Step 3: 새 글 작성 버튼 클릭
    log('새 글 작성 시작...');
    await randomMouseMove(page);

    const newPostBtn = page.locator(SELECTORS.newPostButton).first();
    const newPostVisible = await newPostBtn.isVisible().catch(() => false);

    if (newPostVisible) {
      await newPostBtn.click();
    } else {
      // Fallback: + 버튼이나 compose 영역 찾기
      const composeFallback = page.locator('a[href*="compose"], svg[aria-label="Create"], svg[aria-label="만들기"]').first();
      const fallbackVisible = await composeFallback.isVisible().catch(() => false);
      if (fallbackVisible) {
        await composeFallback.click();
      } else {
        return { success: false, error: '새 글 작성 버튼을 찾을 수 없습니다.' };
      }
    }
    await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

    // Step 4: 텍스트 입력 (가우스 타이밍)
    log('텍스트 입력 중...');
    const textArea = page.locator(SELECTORS.textInput).first();
    const textAreaVisible = await textArea.isVisible({ timeout: 10000 }).catch(() => false);
    if (!textAreaVisible) {
      return { success: false, error: '텍스트 입력 영역을 찾을 수 없습니다.' };
    }

    await randomMouseMove(page);
    await textArea.click();
    await humanDelay(500, 1000);

    // 사람처럼 타이핑 (pressSequentially with gaussian delay)
    await textArea.pressSequentially(text, {
      delay: gaussRandom(TIMING.typeChar.min, TIMING.typeChar.max),
    });
    await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

    // Step 5: 게시 버튼 클릭
    // 다이얼로그 내부의 게시 버튼을 우선 찾고, 없으면 일반 게시 버튼 사용
    log('게시 버튼 클릭...');
    await randomMouseMove(page);

    const dialogPostBtn = page.locator('dialog div[role="button"]:has-text("게시"), dialog button:has-text("게시"), dialog div[role="button"]:has-text("Post"), dialog button:has-text("Post")').first();
    const generalPostBtn = page.locator(SELECTORS.postButton).first();

    const dialogBtnVisible = await dialogPostBtn.isVisible().catch(() => false);
    const generalBtnVisible = await generalPostBtn.isVisible().catch(() => false);

    if (dialogBtnVisible) {
      await dialogPostBtn.click();
    } else if (generalBtnVisible) {
      await generalPostBtn.click();
    } else {
      return { success: false, error: '게시 버튼을 찾을 수 없습니다.' };
    }

    // Step 6: 게시 완료 대기 — "게시되었습니다" 토스트 또는 "보기" 링크 감지
    log('게시 완료 대기...');
    await humanDelay(TIMING.postWait.min, TIMING.postWait.max);

    // 게시 후 "보기" 링크가 나타나면 postUrl을 추출
    const currentUrl = page.url();
    let postId = extractPostId(currentUrl);
    let postUrl: string | undefined;

    if (postId) {
      postUrl = currentUrl;
    } else {
      // "게시되었습니다" 토스트의 "보기" 링크에서 URL 추출 시도
      const viewLink = page.locator('a:has-text("보기"), a:has-text("View")').first();
      const viewLinkVisible = await viewLink.isVisible({ timeout: 5000 }).catch(() => false);
      if (viewLinkVisible) {
        const href = await viewLink.getAttribute('href');
        if (href) {
          postId = extractPostId(href);
          postUrl = href.startsWith('http') ? href : `https://www.threads.com${href}`;
        }
      }

      // 피드로 돌아온 경우 — 최근 포스트에서 URL 추출 시도
      if (!postId) {
        await humanDelay(2000, 4000);
        const firstArticleLink = page.locator('article a[href*="/post/"]').first();
        const linkVisible = await firstArticleLink.isVisible().catch(() => false);
        if (linkVisible) {
          const href = await firstArticleLink.getAttribute('href');
          if (href) {
            postId = extractPostId(href);
            postUrl = href.startsWith('http') ? href : `https://www.threads.com${href}`;
          }
        }
      }
    }

    log(`게시 완료 — postId=${postId || 'unknown'}`);

    // Step 7: selfComment가 있으면 댓글 추가
    if (selfComment && postUrl) {
      log('셀프댓글 작성 중...');
      await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

      // 방금 게시한 포스트로 이동
      if (!currentUrl.includes('/post/')) {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(TIMING.pageLoad.min, TIMING.pageLoad.max);
      }

      // 댓글 입력 영역 찾기
      await randomMouseMove(page);
      const commentArea = page.locator(SELECTORS.commentInput).first();
      const commentVisible = await commentArea.isVisible({ timeout: 10000 }).catch(() => false);

      if (commentVisible) {
        await commentArea.click();
        await humanDelay(500, 1000);
        await commentArea.pressSequentially(selfComment, {
          delay: gaussRandom(TIMING.typeChar.min, TIMING.typeChar.max),
        });
        await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

        // 댓글 게시
        const commentBtn = page.locator(SELECTORS.commentPostButton).first();
        const commentBtnVisible = await commentBtn.isVisible().catch(() => false);
        if (commentBtnVisible) {
          await commentBtn.click();
          await humanDelay(TIMING.postWait.min, TIMING.postWait.max);
          log('셀프댓글 게시 완료');
        } else {
          log('셀프댓글 게시 버튼을 찾지 못함 — 댓글 생략');
        }
      } else {
        log('댓글 입력 영역을 찾지 못함 — 댓글 생략');
      }
    }

    return {
      success: true,
      postId,
      postUrl,
    };

  } catch (e) {
    const err = e as Error;
    log(`게시 오류: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    try { await browser.close(); } catch { /* CDP disconnect 무시 */ }
  }
}
