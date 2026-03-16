/**
 * @file Product matcher — 니즈 기반 실시간 쿠팡 검색 + DB 사전 fallback.
 *
 * Phase 3 교체:
 *   기존: products_v1.json 정적 사전에서 LLM 매칭
 *   변경: 니즈에서 검색 키워드 추출 → 쿠팡 웹 검색(Playwright CDP) → 상위 제품 추출
 *         → 텔레그램으로 파트너스 링크 요청 전송
 *         → 검색 실패 시 기존 DB 사전 fallback
 */

import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { db } from '../db/index.js';
import { products } from '../db/schema.js';
import { callLLM, loadAgentPrompt, parseJSON } from './llm.js';
import type { DetectedNeed } from './needs-detector.js';
import { sendProductRequest } from '../utils/telegram.js';
import type { NeedInfo, CoupangProduct } from '../utils/telegram.js';
import { CDP_URL, checkCDP } from '../utils/browser.js';

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

// ─── Coupang Search ─────────────────────────────────────

/**
 * NeedItem에서 쿠팡 검색 키워드를 추출한다.
 * problem + product_categories를 조합하여 최적의 검색어를 만든다.
 */
function extractSearchKeyword(need: DetectedNeed): string {
  // product_categories가 있으면 첫 번째 카테고리를 검색어로 사용
  if (need.product_categories.length > 0) {
    const primaryCategory = need.product_categories[0];
    // 카테고리가 충분히 구체적이면 그대로 사용
    if (primaryCategory.length >= 3) {
      return primaryCategory;
    }
  }

  // problem에서 핵심 키워드 추출: 제품/솔루션 관련 명사를 추출
  const problem = need.problem;
  // product_categories가 있으면 첫 번째 + problem 핵심어 조합
  if (need.product_categories.length > 0) {
    return need.product_categories[0];
  }

  // fallback: problem 전체를 검색어로 (쿠팡이 알아서 파싱)
  // 너무 길면 앞 30자만 사용
  return problem.length > 30 ? problem.slice(0, 30) : problem;
}

/**
 * 쿠팡 웹 검색 결과 페이지를 Playwright CDP로 파싱하여 상위 제품을 추출한다.
 *
 * @param keyword - 검색 키워드
 * @param maxProducts - 추출할 최대 제품 수 (기본 5)
 * @returns 추출된 제품 배열 (빈 배열이면 검색 실패)
 */
async function searchCoupang(keyword: string, maxProducts = 5): Promise<CoupangSearchResult[]> {
  // CDP 가용 여부 확인 — 미실행 시 빈 배열 반환 (fallback 유도)
  const cdpAvailable = await checkCDP();
  if (!cdpAvailable) {
    console.warn('[product-matcher] CDP 미연결 — 쿠팡 검색 건너뜀');
    return [];
  }

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0] ?? await browser.newContext();
    page = await context.newPage();

    const searchUrl = `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}&channel=user`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });

    // 검색 결과 로딩 대기
    await page.waitForSelector('.search-product, #productList, [class*="product"]', { timeout: 10_000 }).catch(() => {
      // 셀렉터 실패해도 계속 진행 — 아래에서 빈 배열 반환됨
    });

    // 쿠팡 검색 결과 파싱 — 여러 셀렉터 전략 시도
    const results = await page.evaluate((max: number) => {
      const items: Array<{ name: string; price: string; url: string; rating?: string }> = [];

      // Strategy 1: .search-product li (일반 검색 결과)
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
            url: fullUrl.split('?')[0], // 쿼리 파라미터 제거
            rating: ratingEl?.textContent?.trim(),
          });
        }
      }

      // Strategy 2: Fallback — a 태그 기반 추출
      if (items.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/products/"], a[href*="/vp/"]');
        for (const link of allLinks) {
          if (items.length >= max) break;
          const href = (link as HTMLAnchorElement).getAttribute('href');
          const text = link.textContent?.trim();
          if (href && text && text.length > 5 && text.length < 200) {
            const fullUrl = href.startsWith('http') ? href : `https://www.coupang.com${href}`;
            items.push({
              name: text.slice(0, 100), // 이름 너무 길면 자르기
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
    console.error(`[product-matcher] 쿠팡 검색 실패 (keyword="${keyword}"): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    try { await page?.close(); } catch { /* ignore */ }
    try { await browser?.close(); } catch { /* CDP disconnect 무시 */ }
  }
}

// ─── Fallback: DB 사전 기반 매칭 ────────────────────────

/**
 * 기존 DB 상품사전(products 테이블)에서 LLM 매칭을 수행한다.
 * 쿠팡 검색 실패 시 fallback으로 사용한다.
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

  const systemPrompt = loadAgentPrompt('product-matcher');

  const userMessage = JSON.stringify({
    instruction: 'Match needs to products. For each need, select up to 3 best-matching products. Return JSON with a "matches" array.',
    needs: needs.map((n) => ({
      need_id: n.need_id,
      category: n.category,
      problem: n.problem,
      product_categories: n.product_categories,
      signal_strength: n.signal_strength,
      purchase_linkage: n.purchase_linkage,
      threads_fit: n.threads_fit,
    })),
    products: activeProducts.map((p) => ({
      product_id: p.product_id,
      name: p.name,
      category: p.category,
      needs_categories: p.needs_categories,
      keywords: p.keywords,
      price_range: p.price_range,
      description: p.description,
    })),
    expected_output_schema: {
      matches: 'Array<{ need_id, product_id, match_score, match_why, competition, priority }>',
    },
  });

  const raw = await callLLM({
    model: 'claude-sonnet-4-20250514',
    systemPrompt,
    userMessage,
    maxTokens: 4096,
  });

  const rawParsed = parseJSON<Record<string, unknown>>(raw);

  let matchesArray: ProductMatch[];
  if (Array.isArray(rawParsed)) {
    matchesArray = rawParsed as unknown as ProductMatch[];
  } else if (Array.isArray((rawParsed as any).matches)) {
    matchesArray = (rawParsed as any).matches;
  } else {
    const arrayProp = Object.values(rawParsed).find(v => Array.isArray(v));
    if (arrayProp) {
      matchesArray = arrayProp as unknown as ProductMatch[];
    } else {
      console.warn('[product-matcher] LLM returned unexpected shape:', Object.keys(rawParsed));
      matchesArray = [];
    }
  }

  // Handle nested format: LLM may return { need_id, products: [...] }
  const flatMatches: ProductMatch[] = [];
  for (const item of matchesArray) {
    if (item.product_id && item.need_id) {
      flatMatches.push(item);
    } else if (item.need_id && Array.isArray((item as any).products)) {
      for (const prod of (item as any).products) {
        if (prod.product_id) {
          flatMatches.push({
            need_id: item.need_id,
            product_id: prod.product_id,
            match_score: prod.threads_score?.total ?? prod.match_score ?? 0,
            match_why: prod.why ?? prod.match_why ?? '',
            competition: prod.competition ?? '중',
            priority: prod.priority ?? 1,
          });
        }
      }
    }
  }

  return flatMatches;
}

// ─── Main: matchProducts ────────────────────────────────

/**
 * 니즈 기반 제품 매칭 — 실시간 쿠팡 검색 우선, DB 사전 fallback.
 *
 * 흐름:
 * 1. 각 니즈에서 검색 키워드 추출
 * 2. 쿠팡 웹 검색으로 상위 3~5개 제품 추출
 * 3. 검색 성공 시: 쿠팡 제품 기반 ProductMatch 생성 + 텔레그램 파트너스 링크 요청
 * 4. 검색 실패 시: 기존 DB 사전 fallback
 */
export async function matchProducts(needs: DetectedNeed[]): Promise<ProductMatch[]> {
  if (needs.length === 0) {
    return [];
  }

  const allMatches: ProductMatch[] = [];
  const fallbackNeeds: DetectedNeed[] = [];

  // Step 1: 각 니즈별로 쿠팡 실시간 검색 시도
  for (const need of needs) {
    const keyword = extractSearchKeyword(need);
    console.log(`[product-matcher] 쿠팡 검색: "${keyword}" (need=${need.need_id})`);

    const coupangResults = await searchCoupang(keyword, 5);

    if (coupangResults.length > 0) {
      // 검색 성공: 쿠팡 결과를 ProductMatch로 변환
      const needMatches: ProductMatch[] = coupangResults.slice(0, 5).map((result, idx) => ({
        need_id: need.need_id,
        product_id: `coupang-${Date.now()}-${idx}`, // 임시 ID (쿠팡 URL이 실제 식별자)
        match_score: 80 - idx * 5, // 순위 기반 점수 (80, 75, 70, ...)
        match_why: `쿠팡 검색 "${keyword}" 상위 ${idx + 1}위 결과`,
        competition: '중' as const,
        priority: idx + 1,
      }));

      allMatches.push(...needMatches);

      // 텔레그램으로 파트너스 링크 요청 전송
      const needInfo: NeedInfo = {
        need_id: need.need_id,
        category: need.category,
        problem: need.problem,
        product_categories: need.product_categories,
      };

      const coupangProducts: CoupangProduct[] = coupangResults.slice(0, 5).map((r) => ({
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

  // Step 2: 검색 실패한 니즈는 기존 DB 사전으로 fallback
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

  console.log(`[product-matcher] 최종 매칭: ${allMatches.length}개 (쿠팡 검색: ${allMatches.length - (fallbackNeeds.length > 0 ? 0 : 0)}, fallback 포함)`);
  return allMatches;
}
