#!/usr/bin/env tsx
/**
 * login.ts
 * Playwright CDP(9223)로 Chrome에 연결하여 Threads 자동 로그인을 수행한다.
 *
 * Usage:
 *   npx tsx src/scraper/login.ts          # 단독 실행 → stdout JSON
 *   import { loginThreads } from './login.js'  # 모듈로 import
 */

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { LoginResult } from '../types.js';
import { gaussRandom, humanDelay } from '../utils/timing.js';
import { CDP_URL, checkCDP } from '../utils/browser.js';

// ─── Config ──────────────────────────────────────────────

const THREADS_URL = 'https://www.threads.net';
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH
  ?? '/mnt/c/Users/campu/OneDrive/Desktop/새 텍스트 문서 (2).txt';
const CHROME_LNK = "C:\\Users\\campu\\OneDrive\\Desktop\\Chrome (Claude).lnk";

const TIMING = {
  pageLoad:     { min: 3000, max: 6000 },
  actionDelay:  { min: 2000, max: 5000 },
  typeDelay:    { min: 80, max: 200 },
  mouseMove:    { min: 100, max: 500 },
};

const CDP_RETRY_MAX = 3;
const CDP_RETRY_WAIT_MS = 5000;

// ─── Utility Functions ───────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ${msg}`);
}

async function randomMouseMove(page: Page): Promise<void> {
  const x = randInt(100, 900);
  const y = randInt(100, 600);
  await page.mouse.move(x, y, { steps: randInt(5, 15) });
  await humanDelay(TIMING.mouseMove.min, TIMING.mouseMove.max);
}

function launchChrome(): void {
  log('Chrome 자동 실행 시도...');
  try {
    execSync(
      `powershell.exe -NoProfile -Command "Start-Process '${CHROME_LNK}'"`,
      { timeout: 10000, stdio: 'pipe' },
    );
  } catch (e) {
    const err = e as Error;
    log(`Chrome 실행 명령 오류: ${err.message}`);
  }
}

async function ensureCDP(): Promise<void> {
  if (await checkCDP()) {
    log('CDP 연결 확인 완료');
    return;
  }

  for (let attempt = 1; attempt <= CDP_RETRY_MAX; attempt++) {
    log(`CDP 미응답 — Chrome 실행 시도 (${attempt}/${CDP_RETRY_MAX})`);
    launchChrome();
    await new Promise(r => setTimeout(r, CDP_RETRY_WAIT_MS));

    if (await checkCDP()) {
      log('CDP 연결 확인 완료');
      return;
    }
  }

  throw new Error('CDP 연결 실패 — Chrome을 --remote-debugging-port=9223 으로 수동 실행하세요.');
}

// ─── Credentials ─────────────────────────────────────────

interface Credentials {
  email: string;
  password: string;
}

function readCredentials(): Credentials {
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const lines = content.split(/\r?\n/);
  const email = lines[0]?.trim();
  const password = lines[2]?.trim();
  if (!email || !password) {
    throw new Error(`자격증명 파일에서 이메일(1행) 또는 비밀번호(3행)을 읽을 수 없습니다: ${CREDENTIALS_PATH}`);
  }
  return { email, password };
}

// ─── Page State Detection ────────────────────────────────

type PageState =
  | 'logged_in'
  | 'continue_as'
  | 'login_needed'
  | 'instagram_login'
  | 'unknown';

async function detectPageState(page: Page): Promise<PageState> {
  // Wait for main content to settle
  await page.waitForLoadState('domcontentloaded');
  await humanDelay(2000, 4000);

  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const bodyHtml = await page.evaluate(() => document.body?.innerHTML || '');

  // Check: already logged in (app UI visible)
  // Look for navigation elements that only appear when logged in
  const loggedInSignals = [
    // Navigation bar icons / profile links
    await page.locator('[aria-label="Home"], [aria-label="홈"]').count(),
    await page.locator('[aria-label="Profile"], [aria-label="프로필"]').count(),
    await page.locator('[aria-label="Search"], [aria-label="검색"]').count(),
    // Feed content indicators
    await page.locator('article').count(),
  ];
  if (loggedInSignals.some(c => c > 0)) {
    return 'logged_in';
  }

  // Check: "Continue as ..." button
  const continueBtn = page.locator('button, [role="button"], div[role="button"]').filter({
    hasText: /Continue as|님으로 계속/i,
  });
  if (await continueBtn.count() > 0) {
    return 'continue_as';
  }

  // Check: "Log in with Instagram" visible directly
  const igLogin = page.locator('button, [role="button"], div[role="button"]').filter({
    hasText: /Log in with Instagram|Instagram으로 로그인/i,
  });
  if (await igLogin.count() > 0) {
    return 'instagram_login';
  }

  // Check: Login / 로그인 button
  const loginBtn = page.locator('button, [role="button"], div[role="button"]').filter({
    hasText: /^Log\s?in$|^로그인$/i,
  });
  if (await loginBtn.count() > 0) {
    return 'login_needed';
  }

  // Fallback: check for common login page text
  if (/Log\s?in|로그인/.test(bodyText)) {
    return 'login_needed';
  }

  // Also check raw HTML for logged-in state we may have missed
  if (bodyHtml.includes('ThreadsFeedPage') || bodyHtml.includes('MainFeedPage')) {
    return 'logged_in';
  }

  return 'unknown';
}

// ─── Post-Login Popup Handling ───────────────────────────

async function dismissPopups(page: Page): Promise<void> {
  // Handle "Save login info?" and "Turn on notifications?" popups
  const dismissTexts = [
    /Not [Nn]ow/,
    /나중에/,
    /Not Now/,
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    await humanDelay(1000, 2000);

    let dismissed = false;
    for (const textPattern of dismissTexts) {
      const btn = page.locator('button, [role="button"], div[role="button"]').filter({
        hasText: textPattern,
      });
      if (await btn.count() > 0) {
        await randomMouseMove(page);
        await btn.first().click();
        log(`팝업 닫기: ${textPattern.source}`);
        dismissed = true;
        await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);
        break;
      }
    }
    if (!dismissed) break;
  }
}

// ─── Login Error Detection ───────────────────────────────

async function detectLoginError(page: Page): Promise<LoginResult | null> {
  const bodyText = await page.evaluate(() => document.body?.innerText || '');

  // Wrong password
  if (
    /incorrect|wrong password|비밀번호.*틀|잘못된.*비밀번호/i.test(bodyText) ||
    /Sorry, your password was incorrect/i.test(bodyText)
  ) {
    return { status: 'needs_human', reason: 'wrong_password' };
  }

  // CAPTCHA / security challenge
  if (
    /captcha|security check|보안.*확인|challenge/i.test(bodyText) ||
    /suspicious.*activity|의심.*활동/i.test(bodyText)
  ) {
    return { status: 'needs_human', reason: 'captcha' };
  }

  // 2FA
  if (
    /two-factor|2fa|인증.*코드|verification code|security code/i.test(bodyText)
  ) {
    return { status: 'needs_human', reason: '2fa' };
  }

  return null;
}

// ─── Core Login Function ─────────────────────────────────

export async function loginThreads(): Promise<LoginResult> {
  // Step 0: Ensure CDP is available
  try {
    await ensureCDP();
  } catch (e) {
    const err = e as Error;
    return { status: 'error', reason: 'unknown', screenshot: err.message };
  }

  // Connect to Chrome via CDP
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    const err = e as Error;
    return { status: 'error', reason: 'unknown', screenshot: `CDP 연결 실패: ${err.message}` };
  }

  try {
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) {
      return { status: 'error', reason: 'unknown', screenshot: 'BrowserContext가 없습니다.' };
    }

    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    // Step 1: Navigate to Threads
    log('Threads 접속 중...');
    await randomMouseMove(page);
    await page.goto(THREADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(TIMING.pageLoad.min, TIMING.pageLoad.max);

    // Step 2: Detect current state
    const state = await detectPageState(page);
    log(`페이지 상태: ${state}`);

    switch (state) {
      case 'logged_in': {
        log('이미 로그인됨');
        return { status: 'logged_in' };
      }

      case 'continue_as': {
        // Click "Continue as ..." button
        log('"Continue as..." 버튼 클릭');
        await randomMouseMove(page);
        const continueBtn = page.locator('button, [role="button"], div[role="button"]').filter({
          hasText: /Continue as|님으로 계속/i,
        });
        await continueBtn.first().click();
        await humanDelay(TIMING.pageLoad.min, TIMING.pageLoad.max);

        // Dismiss post-login popups
        await dismissPopups(page);

        // Verify login
        const postState = await detectPageState(page);
        if (postState === 'logged_in') {
          log('로그인 성공 (Continue as)');
          return { status: 'logged_in' };
        }

        // Check for errors
        const err = await detectLoginError(page);
        if (err) return err;

        return { status: 'logged_in' };
      }

      case 'login_needed': {
        // Click "Log in" / "로그인" button first
        log('"Log in" 버튼 클릭');
        await randomMouseMove(page);
        const loginBtn = page.locator('button, [role="button"], div[role="button"]').filter({
          hasText: /^Log\s?in$|^로그인$/i,
        });
        await loginBtn.first().click();
        await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

        // Now look for "Log in with Instagram"
        const igBtn = page.locator('button, [role="button"], div[role="button"]').filter({
          hasText: /Log in with Instagram|Instagram으로 로그인/i,
        });
        if (await igBtn.count() > 0) {
          await randomMouseMove(page);
          await igBtn.first().click();
          await humanDelay(TIMING.pageLoad.min, TIMING.pageLoad.max);
        }

        // Fill credentials
        return await fillCredentialsAndSubmit(page);
      }

      case 'instagram_login': {
        // "Log in with Instagram" already visible
        log('"Log in with Instagram" 버튼 클릭');
        await randomMouseMove(page);
        const igBtn = page.locator('button, [role="button"], div[role="button"]').filter({
          hasText: /Log in with Instagram|Instagram으로 로그인/i,
        });
        await igBtn.first().click();
        await humanDelay(TIMING.pageLoad.min, TIMING.pageLoad.max);

        // Fill credentials
        return await fillCredentialsAndSubmit(page);
      }

      case 'unknown':
      default: {
        log('알 수 없는 페이지 상태');
        // Try to take a screenshot for debugging
        let screenshotPath: string | undefined;
        try {
          const screenshotDir = path.join(__dirname, '..', '..', 'data');
          fs.mkdirSync(screenshotDir, { recursive: true });
          screenshotPath = path.join(screenshotDir, 'login-unknown-state.png');
          await page.screenshot({ path: screenshotPath, fullPage: false });
          log(`스크린샷 저장: ${screenshotPath}`);
        } catch { /* ignore screenshot failure */ }

        return {
          status: 'needs_human',
          reason: 'unknown',
          screenshot: screenshotPath,
        };
      }
    }
  } finally {
    // CDP: browser.close() on a CDP-connected browser only disconnects
    // the Playwright client — it does NOT kill the Chrome process.
    try {
      await browser.close();
    } catch { /* ignore disconnect errors */ }
  }
}

// ─── Credential Input + Submit ───────────────────────────

async function fillCredentialsAndSubmit(page: Page): Promise<LoginResult> {
  // Read credentials
  let creds: Credentials;
  try {
    creds = readCredentials();
  } catch (e) {
    const err = e as Error;
    return { status: 'error', reason: 'unknown', screenshot: err.message };
  }

  log('자격증명 입력 중...');

  // Wait for Instagram login form to appear
  await page.waitForLoadState('domcontentloaded');
  await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

  // Find email/username input
  const usernameInput = page.locator('input[name="username"], input[type="text"], input[aria-label*="username" i], input[aria-label*="사용자" i], input[aria-label*="email" i], input[aria-label*="이메일" i], input[aria-label*="Phone" i], input[aria-label*="전화" i]');
  if (await usernameInput.count() === 0) {
    log('이메일 입력 필드를 찾을 수 없습니다');
    return { status: 'needs_human', reason: 'unknown', screenshot: '이메일 입력 필드 미발견' };
  }

  // Type email with human-like delay
  await randomMouseMove(page);
  await usernameInput.first().click();
  await humanDelay(TIMING.mouseMove.min, TIMING.mouseMove.max);
  await usernameInput.first().fill('');
  await usernameInput.first().pressSequentially(creds.email, {
    delay: gaussRandom(TIMING.typeDelay.min, TIMING.typeDelay.max),
  });
  await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

  // Find password input
  const passwordInput = page.locator('input[name="password"], input[type="password"]');
  if (await passwordInput.count() === 0) {
    log('비밀번호 입력 필드를 찾을 수 없습니다');
    return { status: 'needs_human', reason: 'unknown', screenshot: '비밀번호 입력 필드 미발견' };
  }

  // Type password
  await randomMouseMove(page);
  await passwordInput.first().click();
  await humanDelay(TIMING.mouseMove.min, TIMING.mouseMove.max);
  await passwordInput.first().fill('');
  await passwordInput.first().pressSequentially(creds.password, {
    delay: gaussRandom(TIMING.typeDelay.min, TIMING.typeDelay.max),
  });
  await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

  // Submit
  log('로그인 제출...');
  await randomMouseMove(page);

  // Try to find and click the submit button
  const submitBtn = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("로그인"), div[role="button"]:has-text("Log in"), div[role="button"]:has-text("로그인")');
  if (await submitBtn.count() > 0) {
    await submitBtn.first().click();
  } else {
    // Fallback: press Enter
    await passwordInput.first().press('Enter');
  }

  // Wait for navigation / response
  await humanDelay(TIMING.pageLoad.min, TIMING.pageLoad.max);

  // Check for login errors
  const loginError = await detectLoginError(page);
  if (loginError) {
    log(`로그인 오류: ${loginError.reason}`);
    return loginError;
  }

  // Wait additional time for any redirects
  await humanDelay(TIMING.actionDelay.min, TIMING.actionDelay.max);

  // Dismiss post-login popups (save login, notifications, etc.)
  await dismissPopups(page);

  // Final state check
  const finalState = await detectPageState(page);
  if (finalState === 'logged_in') {
    log('로그인 성공');
    return { status: 'logged_in' };
  }

  // Check for errors one more time after popups
  const finalError = await detectLoginError(page);
  if (finalError) {
    return finalError;
  }

  // If we're still not sure, check if the page looks like it might need human intervention
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  if (bodyText.length < 100) {
    // Very short page — probably still loading or blocked
    await humanDelay(TIMING.pageLoad.min, TIMING.pageLoad.max);
    const retryState = await detectPageState(page);
    if (retryState === 'logged_in') {
      log('로그인 성공 (지연 확인)');
      return { status: 'logged_in' };
    }
  }

  log('로그인 상태 불확실 — 수동 확인 필요');
  let screenshotPath: string | undefined;
  try {
    const screenshotDir = path.join(__dirname, '..', '..', 'data');
    fs.mkdirSync(screenshotDir, { recursive: true });
    screenshotPath = path.join(screenshotDir, 'login-uncertain.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch { /* ignore */ }

  return { status: 'needs_human', reason: 'unknown', screenshot: screenshotPath };
}

// ─── CLI Entry Point ─────────────────────────────────────

async function main(): Promise<void> {
  try {
    const result = await loginThreads();
    // Output result as JSON to stdout
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'logged_in' ? 0 : 1);
  } catch (e) {
    const err = e as Error;
    const result: LoginResult = { status: 'error', reason: 'unknown', screenshot: err.message };
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

// Run if executed directly (not imported)
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  main();
}
