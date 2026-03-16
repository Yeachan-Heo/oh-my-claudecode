import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { threadPosts, products } from '../db/schema.js';
import type { CanonicalPost, CrawlMeta, TopicCategory } from '../types.js';
import { classifyTopics } from './topic-classifier.js';
import { analyzeWithResearcher } from './researcher.js';
import { detectNeeds } from './needs-detector.js';
import { matchProducts } from './product-matcher.js';
import { generateContent } from './content-generator.js';
import { sendAlert, sendErrorAlert } from '../utils/telegram.js';

export interface PipelineResult {
  postsAnalyzed: number;
  topicClassification: { classified: number; ruleMatched: number; llmClassified: number };
  categoryGroups: number;
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

    // Phase 2: topic classification
    topic_tags: row.topic_tags ?? undefined,
    topic_category: row.topic_category ?? undefined,
  };
}

export async function runAnalysisPipeline(options?: {
  postLimit?: number;
  skipContentGeneration?: boolean;
}): Promise<PipelineResult> {
  const limit = options?.postLimit ?? 100;
  const errors: string[] = [];
  const emptyClassification = { classified: 0, ruleMatched: 0, llmClassified: 0 };

  console.log('[pipeline] Starting analysis pipeline...');
  await sendAlert('🚀 분석 파이프라인 시작').catch(() => {});

  // Step 0: Topic Classification — classify unclassified posts first
  let classificationResult = emptyClassification;
  try {
    classificationResult = await classifyTopics(limit);
    console.log(
      `[pipeline] Step 0 — Topic classification: ${classificationResult.classified} classified ` +
      `(rule: ${classificationResult.ruleMatched}, llm: ${classificationResult.llmClassified})`,
    );
  } catch (err) {
    const msg = `Topic classification failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[pipeline] ${msg}`);
    // Non-fatal: continue with uncategorized posts
  }

  // Step 1: Fetch posts from DB and group by TopicCategory
  const rows = await db.select().from(threadPosts).limit(limit);

  if (rows.length === 0) {
    console.log('[pipeline] No posts found in DB');
    return {
      postsAnalyzed: 0,
      topicClassification: classificationResult,
      categoryGroups: 0,
      needsDetected: 0,
      productsMatched: 0,
      contentsGenerated: 0,
      errors: [],
    };
  }

  const posts = rows.map(toCanonicalPost);
  console.log(`[pipeline] Fetched ${posts.length} posts`);

  // Group posts by topic_category
  const categoryGroups = new Map<string, CanonicalPost[]>();
  for (const post of posts) {
    const category = post.topic_category ?? '기타';
    const group = categoryGroups.get(category) ?? [];
    group.push(post);
    categoryGroups.set(category, group);
  }

  console.log(`[pipeline] Grouped into ${categoryGroups.size} categories: ${[...categoryGroups.keys()].join(', ')}`);

  // Step 2: Research — run per category group
  const allDetectedNeeds: Awaited<ReturnType<typeof detectNeeds>> = [];

  for (const [category, groupPosts] of categoryGroups) {
    console.log(`[pipeline] Analyzing category "${category}" (${groupPosts.length} posts)`);

    // Step 2a: Research per group
    let brief;
    try {
      brief = await analyzeWithResearcher(groupPosts);
      console.log(`[pipeline] [${category}] Research complete: ${brief.purchase_signals.length} signals found`);
    } catch (err) {
      const msg = `Research failed for category "${category}": ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[pipeline] ${msg}`);
      await sendErrorAlert(msg, `pipeline > research > ${category}`).catch(() => {});
      continue; // skip this category, proceed to next
    }

    // Step 2b: Needs detection per group
    try {
      const groupNeeds = await detectNeeds(brief);
      console.log(`[pipeline] [${category}] Needs detected: ${groupNeeds.length}`);
      allDetectedNeeds.push(...groupNeeds);
    } catch (err) {
      const msg = `Needs detection failed for category "${category}": ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[pipeline] ${msg}`);
      await sendErrorAlert(msg, `pipeline > needs-detection > ${category}`).catch(() => {});
      continue;
    }
  }

  if (allDetectedNeeds.length === 0 && errors.length > 0) {
    return {
      postsAnalyzed: posts.length,
      topicClassification: classificationResult,
      categoryGroups: categoryGroups.size,
      needsDetected: 0,
      productsMatched: 0,
      contentsGenerated: 0,
      errors,
    };
  }

  console.log(`[pipeline] Total needs detected across all categories: ${allDetectedNeeds.length}`);

  // Step 3: Product matching (across all needs)
  let matches;
  try {
    matches = await matchProducts(allDetectedNeeds);
    console.log(`[pipeline] Products matched: ${matches.length}`);
  } catch (err) {
    const msg = `Product matching failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[pipeline] ${msg}`);
    await sendErrorAlert(msg, 'pipeline > product-matching').catch(() => {});
    return {
      postsAnalyzed: posts.length,
      topicClassification: classificationResult,
      categoryGroups: categoryGroups.size,
      needsDetected: allDetectedNeeds.length,
      productsMatched: 0,
      contentsGenerated: 0,
      errors,
    };
  }

  if (options?.skipContentGeneration) {
    return {
      postsAnalyzed: posts.length,
      topicClassification: classificationResult,
      categoryGroups: categoryGroups.size,
      needsDetected: allDetectedNeeds.length,
      productsMatched: matches.length,
      contentsGenerated: 0,
      errors,
    };
  }

  // Step 4: Content generation
  let contentsGenerated = 0;
  for (const match of matches) {
    try {
      const need = allDetectedNeeds.find((n) => n.need_id === match.need_id);
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
    topicClassification: classificationResult,
    categoryGroups: categoryGroups.size,
    needsDetected: allDetectedNeeds.length,
    productsMatched: matches.length,
    contentsGenerated,
    errors,
  };

  console.log('[pipeline] Pipeline complete:', result);

  // 파이프라인 완료 알림
  const errSummary = result.errors.length > 0 ? `\n⚠️ 에러: ${result.errors.length}건` : '';
  await sendAlert(
    `✅ 분석 파이프라인 완료\n\n` +
    `🏷️ 분류: ${result.topicClassification.classified}개 (규칙: ${result.topicClassification.ruleMatched}, LLM: ${result.topicClassification.llmClassified})\n` +
    `📂 카테고리: ${result.categoryGroups}개 그룹\n` +
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
