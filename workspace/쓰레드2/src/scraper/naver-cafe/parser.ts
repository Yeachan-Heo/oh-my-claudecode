import type { Page, Frame } from 'playwright';
import type { CafeTarget } from './types.js';

// ─── Cafe Targets ────────────────────────────────────────

/**
 * 수집 대상 카페 목록.
 *
 * - cosmania: 파우더룸 (뷰티 커뮤니티, clubid=10050813)
 * - beautytalk: 뷰티톡 (뷰티 리뷰)
 *
 * 추후 직장인/생활 카페 추가 가능.
 */
export const CAFE_TARGETS: CafeTarget[] = [
  { id: 'cosmania', name: '파우더룸', category: '뷰티', clubid: '10050813' },
  { id: 'beautytalk', name: '뷰티톡', category: '뷰티', clubid: '' },
  { id: 'jihosoccer123', name: '아프니까 사장이다', category: '자영업', clubid: '23611966' },
];

// ─── Date Parsing ────────────────────────────────────────

export function parseCafeDate(dateText: string): Date | null {
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
export async function getCafeMainFrame(page: Page): Promise<Frame | null> {
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
