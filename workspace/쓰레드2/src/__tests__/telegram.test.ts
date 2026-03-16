/**
 * @file Telegram notification module unit tests.
 *
 * fetch를 모킹하여 네트워크 호출 없이 메시지 포맷과 에러 처리를 검증한다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NeedInfo, CoupangProduct, WeeklyStats } from '../utils/telegram.js';

// ─── Setup: 환경변수 + fetch 모킹 ──────────────────────────

const ORIGINAL_ENV = { ...process.env };

function setTelegramEnv(): void {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token-123';
  process.env.TELEGRAM_CHAT_ID = 'test-chat-456';
}

function clearTelegramEnv(): void {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
}

// fetch를 모킹하기 위해 모듈을 동적으로 import
let sendAlert: typeof import('../utils/telegram.js').sendAlert;
let sendProductRequest: typeof import('../utils/telegram.js').sendProductRequest;
let sendErrorAlert: typeof import('../utils/telegram.js').sendErrorAlert;
let sendWeeklyReport: typeof import('../utils/telegram.js').sendWeeklyReport;

/** 성공 fetch mock */
function mockFetchSuccess(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ ok: true }),
  }));
}

/** 실패 fetch mock (API 에러) */
function mockFetchApiError(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ ok: false, description: 'Bad Request: chat not found' }),
  }));
}

/** 네트워크 에러 fetch mock */
function mockFetchNetworkError(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
}

beforeEach(async () => {
  vi.resetModules();
  setTelegramEnv();
  // 동적 import하여 환경변수가 반영되도록
  const mod = await import('../utils/telegram.js');
  sendAlert = mod.sendAlert;
  sendProductRequest = mod.sendProductRequest;
  sendErrorAlert = mod.sendErrorAlert;
  sendWeeklyReport = mod.sendWeeklyReport;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

// ─── sendAlert ──────────────────────────────────────────

describe('sendAlert', () => {
  it('sends a message and returns true on success', async () => {
    mockFetchSuccess();
    const result = await sendAlert('테스트 메시지');
    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.text).toBe('테스트 메시지');
    expect(body.chat_id).toBe('test-chat-456');
    expect(body.parse_mode).toBe('HTML');
  });

  it('returns false on API error without throwing', async () => {
    mockFetchApiError();
    const result = await sendAlert('테스트');
    expect(result).toBe(false);
  });

  it('returns false on network error without throwing', async () => {
    mockFetchNetworkError();
    const result = await sendAlert('테스트');
    expect(result).toBe(false);
  });
});

// ─── sendProductRequest ────────────────────────────────

describe('sendProductRequest', () => {
  it('formats product request message with need info and products', async () => {
    mockFetchSuccess();

    const needInfo: NeedInfo = {
      need_id: 'need-001',
      category: '불편해소',
      problem: '눈이 피로해서 블루라이트 차단 안경이 필요함',
      product_categories: ['안경', '눈건강'],
    };

    const products: CoupangProduct[] = [
      { name: '블루라이트 차단 안경 A', price: '15,000원', url: 'https://coupang.com/product/123' },
      { name: '블루라이트 차단 안경 B', url: 'https://coupang.com/product/456' },
    ];

    const result = await sendProductRequest(needInfo, products);
    expect(result).toBe(true);

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.text).toContain('파트너스 링크 요청');
    expect(body.text).toContain('블루라이트 차단 안경이 필요함');
    expect(body.text).toContain('블루라이트 차단 안경 A');
    expect(body.text).toContain('15,000원');
    expect(body.text).toContain('coupang.com/product/123');
    expect(body.text).toContain('블루라이트 차단 안경 B');
  });
});

// ─── sendErrorAlert ────────────────────────────────────

describe('sendErrorAlert', () => {
  it('formats error message with Error object', async () => {
    mockFetchSuccess();
    const result = await sendErrorAlert(new Error('CDP 연결 실패'), 'orchestrator');
    expect(result).toBe(true);

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.text).toContain('에러 알림');
    expect(body.text).toContain('CDP 연결 실패');
    expect(body.text).toContain('orchestrator');
  });

  it('formats error message with string', async () => {
    mockFetchSuccess();
    const result = await sendErrorAlert('차단 감지');
    expect(result).toBe(true);

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.text).toContain('차단 감지');
  });
});

// ─── sendWeeklyReport ──────────────────────────────────

describe('sendWeeklyReport', () => {
  it('formats weekly report with stats', async () => {
    mockFetchSuccess();

    const stats: WeeklyStats = {
      postsCollected: 137,
      needsDetected: 9,
      productsMatched: 4,
      contentsGenerated: 4,
      errors: 2,
      period: '2026-03-10 ~ 2026-03-16',
    };

    const result = await sendWeeklyReport(stats);
    expect(result).toBe(true);

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.text).toContain('주간 리포트');
    expect(body.text).toContain('137');
    expect(body.text).toContain('9');
    expect(body.text).toContain('4');
    expect(body.text).toContain('2026-03-10 ~ 2026-03-16');
  });
});

// ─── 환경변수 미설정 ────────────────────────────────────

describe('missing env vars', () => {
  it('returns false when TELEGRAM_BOT_TOKEN is missing', async () => {
    clearTelegramEnv();
    vi.resetModules();
    const mod = await import('../utils/telegram.js');
    mockFetchSuccess();
    const result = await mod.sendAlert('test');
    expect(result).toBe(false);
    // fetch가 호출되지 않아야 함
    expect(fetch).not.toHaveBeenCalled();
  });
});
