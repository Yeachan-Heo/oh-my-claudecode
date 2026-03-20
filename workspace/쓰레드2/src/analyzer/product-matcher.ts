/**
 * @file Product matcher — 니즈 기반 실시간 쿠팡 검색 + DB 사전 fallback.
 *
 * Phase 3 교체:
 *   기존: products_v1.json 정적 사전에서 LLM 매칭
 *   변경: 니즈에서 검색 키워드 추출 → 쿠팡 웹 검색(Playwright CDP) → 상위 제품 추출
 *         → 텔레그램으로 파트너스 링크 요청 전송
 *         → 검색 실패 시 기존 DB 사전 fallback (키워드 기반, LLM 없음)
 */

import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { db } from '../db/index.js';
import { products } from '../db/schema.js';
import type { DetectedNeed } from './content-generator.js';
import { sendProductRequest } from '../utils/telegram.js';
import type { NeedInfo, CoupangProduct } from '../utils/telegram.js';
import { CDP_URL, connectBrowser } from '../utils/browser.js';

// ─── Types ──────────────────────────────────────────────

export interface ProductMatch {
  need_id: string;
  product_id: string;
  match_score: number;
  match_why: string;
  competition: '상' | '중' | '하';
  priority: number;
}

/** 쿠팡 검색에서 추출된 제품 정보 */
interface CoupangSearchResult {
  name: string;
  price: string;
  url: string;
  rating?: string;
}

// ─── Anti-bot Utilities ─────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanDelay(min: number, max: number): Promise<void> {
  await new Promise(r => setTimeout(r, randInt(min, max)));
}

/** 사람처럼 페이지를 스크롤하며 읽는 동작 */
async function humanScroll(page: Page): Promise<void> {
  const scrolls = randInt(2, 4);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, randInt(200, 500));
    await humanDelay(800, 2000);
  }
}

// ─── Coupang Session Manager ────────────────────────────

/** 브라우저 세션을 유지하며 여러 검색을 처리하는 클래스 */
class CoupangSession {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async connect(): Promise<boolean> {
    try {
      this.browser = await connectBrowser();
      const context = this.browser.contexts()[0] ?? await this.browser.newContext();
      this.page = context.pages()[0] || await context.newPage();
      return true;
    } catch (err) {
      console.error(`[product-matcher] CDP 연결 실패: ${(err as Error).message}`);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    try { await this.browser?.close(); } catch { /* CDP disconnect 무시 */ }
    this.browser = null;
    this.page = null;
  }

  isConnected(): boolean {
    return this.page !== null;
  }

  /**
   * 같은 탭에서 검색어를 입력하고 결과를 수집한다.
   * 사람처럼: 검색창 클릭 → 기존 텍스트 지우기 → 키워드 입력 → Enter → 결과 로드 대기 → 스크롤하며 읽기 → 파싱
   */
  async search(keyword: string, maxProducts = 5): Promise<CoupangSearchResult[]> {
    if (!this.page) return [];

    try {
      // 쿠팡 검색 페이지로 이동 (첫 검색이거나 에러 복구 시)
      const currentUrl = this.page.url();
      if (!currentUrl.includes('coupang.com')) {
        await this.page.goto('https://www.coupang.com', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await humanDelay(2000, 4000);
      }

      // 검색창에 키워드 입력 (사람처럼)
      const searchInput = await this.page.$('input.search-input, input[name="q"], input#headerSearchKeyword');
      if (searchInput) {
        await searchInput.click();
        await humanDelay(300, 800);
        await searchInput.fill('');
        await humanDelay(200, 500);
        // 타이핑 속도를 사람처럼 (글자당 50~150ms)
        for (const char of keyword) {
          await this.page.keyboard.type(char, { delay: randInt(50, 150) });
        }
        await humanDelay(500, 1000);
        await this.page.keyboard.press('Enter');
      } else {
        // 검색창을 못 찾으면 URL로 직접 이동
        const searchUrl = `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}&channel=user`;
        await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      }

      // 검색 결과 로딩 대기
      await this.page.waitForSelector('.search-product, #productList, [class*="product"]', { timeout: 10_000 }).catch(() => {});
      await humanDelay(2000, 4000);

      // 사람처럼 스크롤하며 결과 읽기
      await humanScroll(this.page);

      // 제품 파싱
      const results = await this.page.evaluate((max: number) => {
        const items: Array<{ name: string; price: string; url: string; rating?: string }> = [];

        const productCards = document.querySelectorAll('.search-product li.search-product-wrap, ul#productList li');
        for (const card of productCards) {
          if (items.length >= max) break;
          const nameEl = card.querySelector('.name, .product-name, [class*="name"]');
          const priceEl = card.querySelector('.price-value, .base-price, [class*="price"]');
          const linkEl = card.querySelector('a[href*="/products/"], a[href*="/vp/"]') as HTMLAnchorElement | null;
          const ratingEl = card.querySelector('.rating, [class*="rating"]');

          const name = nameEl?.textContent?.trim();
          const price = priceEl?.textContent?.trim();
          const href = linkEl?.getAttribute('href');

          if (name && href) {
            const fullUrl = href.startsWith('http') ? href : `https://www.coupang.com${href}`;
            items.push({
              name,
              price: price ?? '가격 미표시',
              url: fullUrl.split('?')[0],
              rating: ratingEl?.textContent?.trim(),
            });
          }
        }

        // Fallback: a 태그 기반 추출
        if (items.length === 0) {
          const allLinks = document.querySelectorAll('a[href*="/products/"], a[href*="/vp/"]');
          for (const link of allLinks) {
            if (items.length >= max) break;
            const href = (link as HTMLAnchorElement).getAttribute('href');
            const text = link.textContent?.trim();
            if (href && text && text.length > 5 && text.length < 200) {
              const fullUrl = href.startsWith('http') ? href : `https://www.coupang.com${href}`;
              items.push({
                name: text.slice(0, 100),
                price: '가격 미표시',
                url: fullUrl.split('?')[0],
              });
            }
          }
        }

        return items;
      }, maxProducts);

      return results;
    } catch (err) {
      console.error(`[product-matcher] 쿠팡 검색 실패 (keyword="${keyword}"): ${(err as Error).message}`);
      return [];
    }
  }
}

// ─── Coupang Search ─────────────────────────────────────

/**
 * 쿠팡에서 검색 불가능한 서비스/추상 키워드 블랙리스트.
 * 이 단어가 포함된 product_category는 쿠팡 검색 키워드로 사용하지 않는다.
 */
const SERVICE_BLACKLIST = [
  '상담', '시술', '교육', '서비스', '앱', '플랫폼', '코칭', '강의',
  '임대', '구독', '보험', '투자', '재테크', '대행', '컨설팅',
  '오피스', '클리닉', '병원', '성형', '시스템', '소프트웨어',
];

/**
 * 키워드가 쿠팡에서 물리적 제품 검색에 적합한지 판단한다.
 */
function isCoupangSearchable(keyword: string): boolean {
  return !SERVICE_BLACKLIST.some((blocked) => keyword.includes(blocked));
}

/**
 * NeedItem에서 쿠팡 검색 키워드를 추출한다.
 * 서비스/앱 등 쿠팡에 없는 키워드는 건너뛴다.
 */
function extractSearchKeyword(need: DetectedNeed): string | null {
  // product_categories에서 쿠팡 검색 가능한 첫 번째 키워드를 찾는다
  for (const category of need.product_categories) {
    if (category.length >= 3 && isCoupangSearchable(category)) {
      return category;
    }
  }

  // 모든 product_categories가 블랙리스트 또는 너무 짧으면 null 반환 (검색 스킵)
  // product_categories가 비어있으면 problem에서 추출 시도
  if (need.product_categories.length > 0) {
    console.warn(`[product-matcher] 모든 product_categories가 쿠팡 부적합 — 스킵: ${JSON.stringify(need.product_categories)}`);
    return null;
  }

  const keyword = need.problem.length > 30 ? need.problem.slice(0, 30) : need.problem;
  return isCoupangSearchable(keyword) ? keyword : null;
}

// ─── Fallback: DB 사전 기반 매칭 (키워드 기반) ──────────

/**
 * 기존 DB 상품사전(products 테이블)에서 키워드 기반 매칭을 수행한다.
 * 쿠팡 검색 실패 시 fallback으로 사용한다. LLM 없이 product_categories 키워드로 필터링.
 */
async function matchFromDictionary(needs: DetectedNeed[]): Promise<ProductMatch[]> {
  const activeProducts = await db
    .select()
    .from(products)
    .where(eq(products.is_active, true));

  if (activeProducts.length === 0) {
    console.warn('[product-matcher] DB에 활성 제품이 없어 사전 매칭 건너뜀');
    return [];
  }

  const matches: ProductMatch[] = [];

  for (const need of needs) {
    const keywords = need.product_categories.map((k) => k.toLowerCase());

    // 키워드가 제품의 needs_categories 또는 keywords와 겹치는 제품을 찾는다
    const scored = activeProducts
      .map((p) => {
        const pKeywords = [
          ...(p.needs_categories ?? []),
          ...(p.keywords ?? []),
          p.category ?? '',
        ].map((k) => k.toLowerCase());

        const overlap = keywords.filter((k) => pKeywords.some((pk) => pk.includes(k) || k.includes(pk)));
        return { product: p, score: overlap.length };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (let idx = 0; idx < scored.length; idx++) {
      const { product: p, score } = scored[idx];
      matches.push({
        need_id: need.need_id,
        product_id: p.product_id,
        match_score: Math.min(100, score * 20),
        match_why: `DB 사전 키워드 매칭 (overlap=${score})`,
        competition: '중' as const,
        priority: idx + 1,
      });
    }
  }

  return matches;
}

// ─── Main: matchProducts ────────────────────────────────

/**
 * 니즈 기반 제품 매칭 — 실시간 쿠팡 검색 우선, DB 사전 fallback.
 *
 * 흐름:
 * 1. 각 니즈에서 검색 키워드 추출
 * 2. 쿠팡 웹 검색으로 상위 3~5개 제품 추출
 * 3. 검색 성공 시: 쿠팡 제품 기반 ProductMatch 생성 + 텔레그램 파트너스 링크 요청
 * 4. 검색 실패 시: 기존 DB 사전 fallback (키워드 기반)
 */
export async function matchProducts(needs: DetectedNeed[]): Promise<ProductMatch[]> {
  if (needs.length === 0) {
    return [];
  }

  const allMatches: ProductMatch[] = [];
  const fallbackNeeds: DetectedNeed[] = [];

  // SKIP_COUPANG=1 이면 브라우저 검색 없이 DB 사전만 사용 (CI/테스트/안정성)
  if (process.env.SKIP_COUPANG === '1') {
    console.log('[product-matcher] SKIP_COUPANG=1 — DB 사전 fallback 모드');
    return matchFromDictionary(needs);
  }

  // Step 1: 쿠팡 세션 열기 (한 번만 연결, 같은 탭에서 검색어만 변경)
  const session = new CoupangSession();
  const connected = await session.connect();

  if (!connected) {
    console.warn('[product-matcher] CDP 연결 불가 — 전체 DB fallback');
    return matchFromDictionary(needs);
  }

  // Step 2: 각 니즈별로 쿠팡 검색 (같은 탭, 사람처럼)
  // 패턴: 검색 → 스크롤하며 읽기 → 수집 → 15~30초 대기 → 3개마다 60~120초 긴 휴식
  for (let i = 0; i < needs.length; i++) {
    const need = needs[i];
    const keyword = extractSearchKeyword(need);

    // 쿠팡 검색 불가능한 키워드(서비스/앱 등)는 스킵
    if (keyword === null) {
      console.log(`[product-matcher] 스킵 ${i + 1}/${needs.length}: 쿠팡 검색 불가 (need=${need.need_id}, categories=${JSON.stringify(need.product_categories)})`);
      fallbackNeeds.push(need);
      continue;
    }

    console.log(`[product-matcher] 쿠팡 검색 ${i + 1}/${needs.length}: "${keyword}" (need=${need.need_id})`);

    const coupangResults = await session.search(keyword, 5);

    // 안티봇 딜레이: 검색 완료 후 다음 검색 전 대기
    if (i < needs.length - 1) {
      if ((i + 1) % 3 === 0) {
        // 3개마다 긴 휴식 (60~120초) — 사람이 다른 일 하다가 돌아온 패턴
        console.log(`[product-matcher] 긴 휴식 시작 (${i + 1}/${needs.length} 완료)`);
        await humanDelay(60_000, 120_000);
      } else {
        // 일반 딜레이 (15~30초) — 결과를 읽고 생각하는 시간
        await humanDelay(15_000, 30_000);
      }
    }

    if (coupangResults.length > 0) {
      // 검색 성공: 쿠팡 결과를 DB에 저장 후 ProductMatch로 변환
      const needMatches: ProductMatch[] = [];
      for (let idx = 0; idx < coupangResults.length; idx++) {
        const result = coupangResults[idx];
        const productId = `coupang-${Date.now()}-${idx}`;

        // 쿠팡 검색 결과를 products 테이블에 삽입 (content-generator가 조회할 수 있도록)
        try {
          await db.insert(products).values({
            product_id: productId,
            name: result.name.slice(0, 200),
            category: need.category,
            needs_categories: [need.category],
            keywords: need.product_categories,
            affiliate_platform: 'coupang_partners',
            price_range: result.price ?? '가격 미표시',
            description: `쿠팡 검색 "${keyword}" 결과${result.rating ? ` (평점: ${result.rating})` : ''}`,
            affiliate_link: result.url,
            is_active: true,
          }).onConflictDoNothing();
        } catch (insertErr) {
          console.warn(`[product-matcher] 쿠팡 제품 DB 삽입 실패: ${(insertErr as Error).message}`);
        }

        needMatches.push({
          need_id: need.need_id,
          product_id: productId,
          match_score: 80 - idx * 5,
          match_why: `쿠팡 검색 "${keyword}" 상위 ${idx + 1}위 결과`,
          competition: '중' as const,
          priority: idx + 1,
        });
      }

      allMatches.push(...needMatches);

      // 텔레그램으로 파트너스 링크 요청 전송
      const needInfo: NeedInfo = {
        need_id: need.need_id,
        category: need.category,
        problem: need.problem,
        product_categories: need.product_categories,
      };

      const coupangProducts: CoupangProduct[] = coupangResults.map((r) => ({
        name: r.name,
        price: r.price !== '가격 미표시' ? r.price : undefined,
        url: r.url,
      }));

      try {
        await sendProductRequest(needInfo, coupangProducts);
        console.log(`[product-matcher] 텔레그램 파트너스 링크 요청 전송 완료 (need=${need.need_id}, products=${coupangProducts.length})`);
      } catch {
        console.error(`[product-matcher] 텔레그램 전송 실패: need=${need.need_id}`);
      }
    } else {
      // 검색 실패: fallback 대상에 추가
      console.warn(`[product-matcher] 쿠팡 검색 실패 — fallback 대상: need=${need.need_id}`);
      fallbackNeeds.push(need);
    }
  }

  // Step 3: 검색 실패한 니즈는 기존 DB 사전으로 fallback
  if (fallbackNeeds.length > 0) {
    console.log(`[product-matcher] DB 사전 fallback: ${fallbackNeeds.length}개 니즈`);
    try {
      const fallbackMatches = await matchFromDictionary(fallbackNeeds);
      allMatches.push(...fallbackMatches);

      // fallback 매칭된 제품도 텔레그램으로 파트너스 링크 요청
      if (fallbackMatches.length > 0) {
        const matchesByNeed = new Map<string, ProductMatch[]>();
        for (const m of fallbackMatches) {
          const existing = matchesByNeed.get(m.need_id) ?? [];
          existing.push(m);
          matchesByNeed.set(m.need_id, existing);
        }

        for (const [needId, needMatches] of matchesByNeed) {
          const need = fallbackNeeds.find((n) => n.need_id === needId);
          if (!need) continue;

          const needInfo: NeedInfo = {
            need_id: needId,
            category: need.category,
            problem: need.problem,
            product_categories: need.product_categories,
          };

          const coupangProductLinks: CoupangProduct[] = [];
          for (const m of needMatches) {
            const productRows = await db
              .select()
              .from(products)
              .where(eq(products.product_id, m.product_id));
            if (productRows.length > 0) {
              const p = productRows[0];
              coupangProductLinks.push({
                name: p.name,
                price: p.price_range ?? undefined,
                url: p.affiliate_link ?? `https://www.coupang.com/np/search?q=${encodeURIComponent(p.name)}`,
              });
            }
          }

          if (coupangProductLinks.length > 0) {
            try {
              await sendProductRequest(needInfo, coupangProductLinks);
            } catch {
              console.error(`[product-matcher] 텔레그램 전송 실패 (fallback): need=${needId}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[product-matcher] DB 사전 fallback 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 4: 쿠팡 세션 정리 (cleanup)
  await session.disconnect();

  console.log(`[product-matcher] 최종 매칭: ${allMatches.length}개 (fallback: ${fallbackNeeds.length}개)`);
  return allMatches;
}
