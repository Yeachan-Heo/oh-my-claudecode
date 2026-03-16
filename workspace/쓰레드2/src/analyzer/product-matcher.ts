import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { products } from '../db/schema.js';
import { callLLM, loadAgentPrompt, parseJSON } from './llm.js';
import type { DetectedNeed } from './needs-detector.js';
import { sendProductRequest } from '../utils/telegram.js';
import type { NeedInfo, CoupangProduct } from '../utils/telegram.js';

export interface ProductMatch {
  need_id: string;
  product_id: string;
  match_score: number;
  match_why: string;
  competition: '상' | '중' | '하';
  priority: number;
}

interface LLMMatchOutput {
  matches: Array<{
    need_id: string;
    product_id: string;
    match_score: number;
    match_why: string;
    competition: '상' | '중' | '하';
    priority: number;
  }>;
}

export async function matchProducts(needs: DetectedNeed[]): Promise<ProductMatch[]> {
  const activeProducts = await db
    .select()
    .from(products)
    .where(eq(products.is_active, true));

  if (activeProducts.length === 0) {
    console.warn('[product-matcher] No active products found in DB');
    return [];
  }

  if (needs.length === 0) {
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

  // Handle different LLM response shapes
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

  // Handle nested format: LLM may return { need_id, products: [...] } instead of flat { need_id, product_id, ... }
  const flatMatches: ProductMatch[] = [];
  for (const item of matchesArray) {
    if (item.product_id && item.need_id) {
      // Already flat format
      flatMatches.push(item);
    } else if (item.need_id && Array.isArray((item as any).products)) {
      // Nested format: flatten each product into a separate match
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
    } else {
      console.warn('[product-matcher] Skipping unrecognized match format:', item);
    }
  }

  // 매칭된 제품이 있으면 텔레그램으로 파트너스 링크 요청 전송
  if (flatMatches.length > 0) {
    // need_id별로 그룹핑하여 각 니즈에 대해 제품 링크 요청
    const matchesByNeed = new Map<string, ProductMatch[]>();
    for (const m of flatMatches) {
      const existing = matchesByNeed.get(m.need_id) ?? [];
      existing.push(m);
      matchesByNeed.set(m.need_id, existing);
    }

    for (const [needId, needMatches] of matchesByNeed) {
      const need = needs.find((n) => n.need_id === needId);
      if (!need) continue;

      const needInfo: NeedInfo = {
        need_id: needId,
        category: need.category,
        problem: need.problem,
        product_categories: need.product_categories,
      };

      // DB에서 제품 정보 조회하여 쿠팡 링크 구성
      const coupangProducts: CoupangProduct[] = [];
      for (const m of needMatches) {
        const productRows = await db
          .select()
          .from(products)
          .where(eq(products.product_id, m.product_id));
        if (productRows.length > 0) {
          const p = productRows[0];
          coupangProducts.push({
            name: p.name,
            price: p.price_range ?? undefined,
            url: p.affiliate_link ?? `https://www.coupang.com/np/search?q=${encodeURIComponent(p.name)}`,
          });
        }
      }

      if (coupangProducts.length > 0) {
        try {
          await sendProductRequest(needInfo, coupangProducts);
        } catch {
          console.error(`[product-matcher] 텔레그램 제품 요청 전송 실패: need=${needId}`);
        }
      }
    }
  }

  return flatMatches;
}
