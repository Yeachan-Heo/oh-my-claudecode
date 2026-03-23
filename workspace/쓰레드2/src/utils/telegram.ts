/**
 * @file Telegram Bot API notification module.
 *
 * 파이프라인의 각 단계에서 사용자에게 알림을 보낸다.
 * 알림 실패는 console.error만 출력하고 파이프라인을 중단시키지 않는다.
 */

import 'dotenv/config';

// ─── Config ──────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

/** Telegram sendMessage API 응답 (필요한 필드만) */
interface TelegramResponse {
  ok: boolean;
  description?: string;
}

/** sendProductRequest에 전달하는 니즈 정보 */
export interface NeedInfo {
  need_id: string;
  category: string;
  problem: string;
  product_categories: string[];
}

/** sendProductRequest에 전달하는 쿠팡 제품 링크 */
export interface CoupangProduct {
  name: string;
  price?: string;
  url: string;
}

/** sendWeeklyReport에 전달하는 주간 통계 */
export interface WeeklyStats {
  postsCollected: number;
  needsDetected: number;
  productsMatched: number;
  contentsGenerated: number;
  errors: number;
  period: string; // 예: "2026-03-10 ~ 2026-03-16"
}

// ─── Internal: Telegram API 호출 ──────────────────────────

/**
 * Telegram Bot API sendMessage를 호출한다.
 * 환경변수 미설정 또는 API 오류 시 false를 반환하고, 예외를 던지지 않는다.
 */
async function sendTelegramMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[telegram] TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 설정되지 않았습니다.');
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const data = await res.json() as TelegramResponse;

    if (!data.ok) {
      console.error(`[telegram] API 오류: ${data.description ?? 'unknown'}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[telegram] 전송 실패: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────

/**
 * 일반 알림 메시지를 전송한다.
 */
export async function sendAlert(message: string): Promise<boolean> {
  return sendTelegramMessage(message);
}

/**
 * 파트너스 링크 요청 메시지를 전송한다.
 * 니즈 정보 + 쿠팡 제품 링크를 사용자에게 전달하여 파트너스 링크 생성을 요청한다.
 */
export async function sendProductRequest(needInfo: NeedInfo, coupangProducts: CoupangProduct[]): Promise<boolean> {
  const productLines = coupangProducts
    .map((p, i) => {
      const price = p.price ? ` (${p.price})` : '';
      return `  ${i + 1}. <b>${escapeHtml(p.name)}</b>${price}\n     ${p.url}`;
    })
    .join('\n');

  const text = `🛒 <b>파트너스 링크 요청</b>

📋 <b>니즈:</b> ${escapeHtml(needInfo.problem)}
📂 카테고리: ${escapeHtml(needInfo.category)}
🏷️ 제품군: ${escapeHtml(needInfo.product_categories.join(', '))}

🔗 <b>쿠팡 제품 링크:</b>
${productLines}

👆 위 제품들의 <b>쿠팡 파트너스 링크</b>를 만들어주세요.`;

  return sendTelegramMessage(text);
}

/**
 * 크롤 에러/차단 긴급 알림을 전송한다.
 */
export async function sendErrorAlert(error: Error | string, context?: string): Promise<boolean> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const contextLine = context ? `\n📍 위치: ${escapeHtml(context)}` : '';

  const text = `🚨 <b>에러 알림</b>

❌ ${escapeHtml(errorMessage)}${contextLine}
🕐 ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`;

  return sendTelegramMessage(text);
}

/**
 * 주간 리포트를 전송한다.
 */
export async function sendWeeklyReport(stats: WeeklyStats): Promise<boolean> {
  const text = `📊 <b>주간 리포트</b>

📅 기간: ${escapeHtml(stats.period)}

📝 수집 포스트: <b>${stats.postsCollected}</b>개
🔍 니즈 감지: <b>${stats.needsDetected}</b>개
🛒 제품 매칭: <b>${stats.productsMatched}</b>개
✍️ 콘텐츠 생성: <b>${stats.contentsGenerated}</b>개
⚠️ 에러: ${stats.errors}건`;

  return sendTelegramMessage(text);
}

// ─── Helpers ────────────────────────────────────────────

/** HTML 특수문자 이스케이프 (Telegram HTML parse_mode용) */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
