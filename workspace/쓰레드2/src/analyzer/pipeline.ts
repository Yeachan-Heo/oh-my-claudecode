import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { threadPosts, products } from '../db/schema.js';
import type { CanonicalPost, CrawlMeta } from '../types.js';
import { analyzeWithResearcher } from './researcher.js';
import { detectNeeds } from './needs-detector.js';
import { matchProducts } from './product-matcher.js';
import { generateContent } from './content-generator.js';
import { sendAlert, sendErrorAlert } from '../utils/telegram.js';

export interface PipelineResult {
  postsAnalyzed: number;
  needsDetected: number;
  productsMatched: number;
  contentsGenerated: number;
  errors: string[];
}

function toCanonicalPost(row: typeof threadPosts.$inferSelect): CanonicalPost {
  return {
    post_id: row.post_id,
    channel_id: row.channel_id,
    author: row.author ?? undefined,
    text: row.text,
    timestamp: row.timestamp?.toISOString() ?? new Date().toISOString(),
    permalink: row.permalink ?? undefined,
    metrics: {
      view_count: row.view_count,
      like_count: row.like_count,
      reply_count: row.reply_count,
      repost_count: row.repost_count,
    },
    media: {
      has_image: row.has_image,
      urls: (row.media_urls ?? []) as string[],
    },
    comments: (row.comments ?? []) as CanonicalPost['comments'],
    tags: row.primary_tag
      ? {
          primary: row.primary_tag,
          secondary: (row.secondary_tags ?? []) as string[],
        }
      : undefined,
    thread_type: row.thread_type ?? undefined,
    conversion_rate: row.conversion_rate ?? undefined,
    link: row.link_url
      ? {
          url: row.link_url,
          domain: row.link_domain ?? undefined,
          location: row.link_location ?? undefined,
        }
      : undefined,
    channel_meta: row.channel_meta as CanonicalPost['channel_meta'],
    crawl_meta: {
      crawl_at: row.crawl_at.toISOString(),
      run_id: row.run_id ?? undefined,
      selector_tier: (row.selector_tier ?? undefined) as CrawlMeta['selector_tier'],
      login_status: row.login_status ?? undefined,
      block_detected: row.block_detected ?? undefined,
    },
  };
}

export async function runAnalysisPipeline(options?: {
  postLimit?: number;
  skipContentGeneration?: boolean;
}): Promise<PipelineResult> {
  const limit = options?.postLimit ?? 100;
  const errors: string[] = [];

  console.log('[pipeline] Starting analysis pipeline...');
  await sendAlert('🚀 분석 파이프라인 시작').catch(() => {});

  // Step 1: Fetch posts from DB
  const rows = await db.select().from(threadPosts).limit(limit);

  if (rows.length === 0) {
    console.log('[pipeline] No posts found in DB');
    return { postsAnalyzed: 0, needsDetected: 0, productsMatched: 0, contentsGenerated: 0, errors: [] };
  }

  const posts = rows.map(toCanonicalPost);
  console.log(`[pipeline] Fetched ${posts.length} posts`);

  // Step 2: Research
  let brief;
  try {
    brief = await analyzeWithResearcher(posts);
    console.log(`[pipeline] Research complete: ${brief.purchase_signals.length} signals found`);
  } catch (err) {
    const msg = `Research step failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[pipeline] ${msg}`);
    await sendErrorAlert(msg, 'pipeline > research').catch(() => {});
    return { postsAnalyzed: posts.length, needsDetected: 0, productsMatched: 0, contentsGenerated: 0, errors };
  }

  // Step 3: Needs detection
  let detectedNeeds;
  try {
    detectedNeeds = await detectNeeds(brief);
    console.log(`[pipeline] Needs detected: ${detectedNeeds.length}`);
  } catch (err) {
    const msg = `Needs detection failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[pipeline] ${msg}`);
    await sendErrorAlert(msg, 'pipeline > needs-detection').catch(() => {});
    return { postsAnalyzed: posts.length, needsDetected: 0, productsMatched: 0, contentsGenerated: 0, errors };
  }

  // Step 4: Product matching
  let matches;
  try {
    matches = await matchProducts(detectedNeeds);
    console.log(`[pipeline] Products matched: ${matches.length}`);
  } catch (err) {
    const msg = `Product matching failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[pipeline] ${msg}`);
    await sendErrorAlert(msg, 'pipeline > product-matching').catch(() => {});
    return {
      postsAnalyzed: posts.length,
      needsDetected: detectedNeeds.length,
      productsMatched: 0,
      contentsGenerated: 0,
      errors,
    };
  }

  if (options?.skipContentGeneration) {
    return {
      postsAnalyzed: posts.length,
      needsDetected: detectedNeeds.length,
      productsMatched: matches.length,
      contentsGenerated: 0,
      errors,
    };
  }

  // Step 5: Content generation
  let contentsGenerated = 0;
  for (const match of matches) {
    try {
      const need = detectedNeeds.find((n) => n.need_id === match.need_id);
      if (!need) {
        errors.push(`Need ${match.need_id} not found for product ${match.product_id}`);
        continue;
      }

      const productRows = await db
        .select()
        .from(products)
        .where(eq(products.product_id, match.product_id));

      if (productRows.length === 0) {
        errors.push(`Product ${match.product_id} not found in DB`);
        continue;
      }

      const product = productRows[0];
      await generateContent(match, need, {
        product_id: product.product_id,
        name: product.name,
        category: product.category,
        price_range: product.price_range,
        description: product.description,
        affiliate_link: product.affiliate_link,
      });
      contentsGenerated++;
    } catch (err) {
      const msg = `Content generation failed for product ${match.product_id}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[pipeline] ${msg}`);
    }
  }

  console.log(`[pipeline] Content generated: ${contentsGenerated}`);

  const result: PipelineResult = {
    postsAnalyzed: posts.length,
    needsDetected: detectedNeeds.length,
    productsMatched: matches.length,
    contentsGenerated,
    errors,
  };

  console.log('[pipeline] Pipeline complete:', result);

  // 파이프라인 완료 알림
  const errSummary = result.errors.length > 0 ? `\n⚠️ 에러: ${result.errors.length}건` : '';
  await sendAlert(
    `✅ 분석 파이프라인 완료\n\n` +
    `📝 포스트: ${result.postsAnalyzed}개\n` +
    `🔍 니즈: ${result.needsDetected}개\n` +
    `🛒 매칭: ${result.productsMatched}개\n` +
    `✍️ 콘텐츠: ${result.contentsGenerated}개${errSummary}`,
  ).catch(() => {});

  return result;
}

// CLI entrypoint
const isDirectRun = process.argv[1]?.endsWith('pipeline.ts') || process.argv[1]?.endsWith('pipeline.js');
if (isDirectRun) {
  runAnalysisPipeline()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.errors.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Pipeline failed:', err);
      process.exit(1);
    });
}
