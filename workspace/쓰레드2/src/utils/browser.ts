/**
 * @file Shared browser/CDP connection utilities.
 *
 * Extracted from poster.ts and snapshot.ts to eliminate duplication.
 * CDP 미실행 시 자동으로 Chrome을 WSL에서 실행한다.
 */

import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import http from 'http';
import { execSync, spawn } from 'child_process';

/** CDP endpoint URL — 환경변수로 오버라이드 가능 */
export const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9223';

const CDP_PORT = parseInt(new URL(CDP_URL).port, 10) || 9223;

/**
 * CDP 엔드포인트 가용 여부를 확인한다.
 */
export async function checkCDP(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * WSL에서 Windows Chrome(Claude) 바로가기를 실행한다.
 * 바로가기에 CDP 포트 설정이 포함되어 있다.
 */
export async function launchChromeCDP(): Promise<void> {
  const shortcut = 'C:\\Users\\campu\\OneDrive\\Desktop\\Chrome (Claude).lnk';

  console.log(`[CDP] Chrome (Claude) 바로가기 실행 중...`);
  const child = spawn('cmd.exe', ['/c', 'start', '', shortcut], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Chrome 시작 대기 (최대 15초)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await checkCDP()) {
      console.log('[CDP] Chrome 연결 확인');
      return;
    }
  }
  throw new Error('Chrome이 시작되었지만 CDP 연결이 안 됩니다.');
}

/**
 * CDP 가용 여부를 확인한 뒤 Playwright 브라우저에 연결한다.
 * CDP 미실행 시 자동으로 Chrome을 실행한다.
 */
export async function connectBrowser(): Promise<Browser> {
  if (!(await checkCDP())) {
    console.log('[CDP] Chrome이 실행되어 있지 않습니다. 자동 실행합니다...');
    await launchChromeCDP();
  }
  return chromium.connectOverCDP(CDP_URL);
}
