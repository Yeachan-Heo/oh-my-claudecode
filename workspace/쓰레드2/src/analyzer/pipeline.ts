import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { eq, gte, like, notLike, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { threadPosts, products, affContents } from '../db/schema.js';
import type { CanonicalPost, CrawlMeta, TopicCategory } from '../types.js';
import { classifyTopics } from './topic-classifier.js';
import { analyzeWithResearcher } from './researcher.js';
import { detectNeeds } from './needs-detector.js';
import { matchProducts } from './product-matcher.js';
import { generateContent } from './content-generator.js';
import { sendAlert, sendErrorAlert } from '../utils/telegram.js';
import { pipelineLog } from '../utils/logger.js';

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

async function backupPglite(): Promise<void> {
  const dataDir = path.resolve('data');
  const src = path.join(dataDir, 'pglite');
  if (!fs.existsSync(src)) return;

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const dest = path.join(dataDir, `pglite.backup.${stamp}`);

  fs.cpSync(src, dest, { recursive: true });
  console.log(`[pipeline] DB backed up to ${dest}`);

  // Keep at most 2 backups (delete oldest when 3+)
  const entries = fs.readdirSync(dataDir)
    .filter((f) => f.startsWith('pglite.backup.'))
    .sort();
  if (entries.length >= 3) {
    const oldest = path.join(dataDir, entries[0]);
    fs.rmSync(oldest, { recursive: true, force: true });
    console.log(`[pipeline] Removed old backup: ${entries[0]}`);
  }
}

export type PostSource = 'all' | 'benchmark' | 'trend';

export async function runAnalysisPipeline(options?: {
  postLimit?: number;
  skipContentGeneration?: boolean;
  category?: string; // 특정 카테고리만 분석 (예: "뷰티", "건강")
  todayOnly?: boolean; // 오늘 수집한 포스트만 분석
  source?: PostSource; // 'benchmark' = 채널수집, 'trend' = 키워드/트렌드 검색, 'all' = 전체
}): Promise<PipelineResult> {
  const limit = options?.postLimit ?? 500;
  const targetCategory = options?.category;
  const todayOnly = options?.todayOnly ?? true;
  const source = options?.source ?? 'all';
  const errors: string[] = [];
  const emptyClassification = { classified: 0, ruleMatched: 0, llmClassified: 0 };

  // Auto-backup before pipeline
  try {
    await backupPglite();
  } catch (err) {
    console.error(`[pipeline] Backup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  const sourceLabel = source === 'all' ? '' : ` [${source}]`;
  const todayLabel = todayOnly ? ' (오늘 수집분)' : '';
  console.log(`[pipeline] Starting analysis pipeline...${targetCategory ? ` (category: ${targetCategory})` : ''}${sourceLabel}${todayLabel}`);
  pipelineLog('pipeline-start', { limit, category: targetCategory ?? 'all', source, todayOnly });
  await sendAlert(`🚀 분석 파이프라인 시작${sourceLabel}${todayLabel}${targetCategory ? ` (${targetCategory})` : ''}`).catch(() => {});

  // Step 0: Topic Classification — classify unclassified posts first
  let classificationResult = emptyClassification;
  try {
    classificationResult = await classifyTopics(limit);
    console.log(
      `[pipeline] Step 0 — Topic classification: ${classificationResult.classified} classified ` +
      `(rule: ${classificationResult.ruleMatched}, llm: ${classificationResult.llmClassified})`,
    );
    pipelineLog('topic-classify', classificationResult);
  } catch (err) {
    const msg = `Topic classification failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[pipeline] ${msg}`);
    pipelineLog('topic-classify-error', { error: msg });
    // Non-fatal: continue with uncategorized posts
  }

  // Step 1: Fetch posts from DB with filters (todayOnly, source, unanalyzed)
  const conditions = [];

  // 미분석 포스트만 (analyzed_at IS NULL)
  conditions.push(sql`${threadPosts.analyzed_at} IS NULL`);

  // 오늘 수집분만 필터 (crawl_at >= 오늘 00:00 UTC)
  if (todayOnly) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    conditions.push(gte(threadPosts.crawl_at, todayStart));
  }

  // 소스별 필터 (run_id 패턴)
  if (source === 'benchmark') {
    // 채널 수집: run_id = 'benchmark_collect_*' 또는 'run_*'
    conditions.push(sql`(${threadPosts.run_id} LIKE 'benchmark_%' OR ${threadPosts.run_id} LIKE 'run_%')`);
  } else if (source === 'trend') {
    // 키워드/트렌드 검색: run_id = 'search_*'
    conditions.push(like(threadPosts.run_id, 'search_%'));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = whereClause
    ? await db.select().from(threadPosts).where(whereClause).limit(limit)
    : await db.select().from(threadPosts).limit(limit);

  if (rows.length === 0) {
    const noPostsMsg = todayOnly
      ? `오늘 수집한 포스트가 없습니다${source !== 'all' ? ` (source: ${source})` : ''}. 먼저 수집을 실행하세요.`
      : 'DB에 포스트가 없습니다.';
    console.log(`[pipeline] ${noPostsMsg}`);
    pipelineLog('pipeline-end', { reason: 'no-posts', todayOnly, source });
    await sendAlert(`⚠️ ${noPostsMsg}`).catch(() => {});
    return {
      postsAnalyzed: 0,
      topicClassification: classificationResult,
      categoryGroups: 0,
      needsDetected: 0,
      productsMatched: 0,
      contentsGenerated: 0,
      errors: [noPostsMsg],
    };
  }

  const posts = rows.map(toCanonicalPost);
  console.log(`[pipeline] Fetched ${posts.length} posts`);
  pipelineLog('fetch-posts', { count: posts.length });

  // Group posts by topic_category
  const categoryGroups = new Map<string, CanonicalPost[]>();
  for (const post of posts) {
    const category = post.topic_category ?? '기타';
    const group = categoryGroups.get(category) ?? [];
    group.push(post);
    categoryGroups.set(category, group);
  }

  // 특정 카테고리만 분석할 경우 나머지 제거
  if (targetCategory) {
    for (const key of [...categoryGroups.keys()]) {
      if (key !== targetCategory) categoryGroups.delete(key);
    }
    if (categoryGroups.size === 0) {
      console.log(`[pipeline] 카테고리 "${targetCategory}"에 해당하는 포스트가 없습니다.`);
      return {
        postsAnalyzed: posts.length,
        topicClassification: classificationResult,
        categoryGroups: 0,
        needsDetected: 0,
        productsMatched: 0,
        contentsGenerated: 0,
        errors: [`No posts found for category "${targetCategory}"`],
      };
    }
  }

  console.log(`[pipeline] Grouped into ${categoryGroups.size} categories: ${[...categoryGroups.keys()].join(', ')}`);
  pipelineLog('group-categories', { count: categoryGroups.size, categories: [...categoryGroups.keys()] });

  // Step 2: Research — run per category group
  const allDetectedNeeds: Awaited<ReturnType<typeof detectNeeds>> = [];

  for (const [category, groupPosts] of categoryGroups) {
    console.log(`[pipeline] Analyzing category "${category}" (${groupPosts.length} posts)`);

    // Step 2a: Research per group
    let brief;
    try {
      brief = await analyzeWithResearcher(groupPosts);
      console.log(`[pipeline] [${category}] Research complete: ${brief.purchase_signals.length} signals found`);
      pipelineLog('research', { category, signals: brief.purchase_signals.length });
    } catch (err) {
      const msg = `Research failed for category "${category}": ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[pipeline] ${msg}`);
      pipelineLog('research-error', { category, error: msg });
      await sendErrorAlert(msg, `pipeline > research > ${category}`).catch(() => {});
      continue; // skip this category, proceed to next
    }

    // Step 2b: Needs detection per group
    try {
      const groupNeeds = await detectNeeds(brief);
      console.log(`[pipeline] [${category}] Needs detected: ${groupNeeds.length}`);
      pipelineLog('needs-detect', { category, count: groupNeeds.length });
      allDetectedNeeds.push(...groupNeeds);
    } catch (err) {
      const msg = `Needs detection failed for category "${category}": ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[pipeline] ${msg}`);
      pipelineLog('needs-detect-error', { category, error: msg });
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

  // Step 2.5: Filter out needs that are not suitable for Coupang product matching
  const coupangViableNeeds = allDetectedNeeds.filter((need) => {
    // Skip needs with low purchase linkage (services, apps, education, etc.)
    if (need.purchase_linkage === '하') {
      console.log(`[pipeline] 스킵 (linkage=하): "${need.problem}" [${need.category}]`);
      return false;
    }
    // Skip needs with empty product categories
    if (!need.product_categories || need.product_categories.length === 0) {
      console.log(`[pipeline] 스킵 (product_categories 없음): "${need.problem}" [${need.category}]`);
      return false;
    }
    return true;
  });

  console.log(`[pipeline] Coupang-viable needs: ${coupangViableNeeds.length}/${allDetectedNeeds.length}`);
  pipelineLog('filter-needs', { total: allDetectedNeeds.length, viable: coupangViableNeeds.length });

  if (coupangViableNeeds.length === 0) {
    console.log('[pipeline] No Coupang-viable needs found — skipping product matching');
    return {
      postsAnalyzed: posts.length,
      topicClassification: classificationResult,
      categoryGroups: categoryGroups.size,
      needsDetected: allDetectedNeeds.length,
      productsMatched: 0,
      contentsGenerated: 0,
      errors: [...errors, 'No Coupang-viable needs found (all filtered out)'],
    };
  }

  // Step 3: Product matching (across Coupang-viable needs only)
  let matches;
  try {
    matches = await matchProducts(coupangViableNeeds);
    console.log(`[pipeline] Products matched: ${matches.length}`);
    pipelineLog('product-match', { matched: matches.length, needsCount: coupangViableNeeds.length });
  } catch (err) {
    const msg = `Product matching failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(`[pipeline] ${msg}`);
    pipelineLog('product-match-error', { error: msg });
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

      let productInfo: {
        product_id: string;
        name: string;
        category: string;
        price_range: string;
        description: string;
        affiliate_link: string | null;
      };

      const productRows = await db
        .select()
        .from(products)
        .where(eq(products.product_id, match.product_id));

      if (productRows.length > 0) {
        const product = productRows[0];
        productInfo = {
          product_id: product.product_id,
          name: product.name,
          category: product.category,
          price_range: product.price_range,
          description: product.description,
          affiliate_link: product.affiliate_link,
        };
      } else {
        // Fallback: construct from match metadata (coupang search results that failed DB insert)
        console.log(`[pipeline] Product ${match.product_id} not in DB — using match metadata`);
        productInfo = {
          product_id: match.product_id,
          name: need.product_categories[0] ?? need.problem.slice(0, 50),
          category: need.category,
          price_range: '',
          description: match.match_why,
          affiliate_link: null,
        };
      }

      const generated = await generateContent(match, need, productInfo);
      contentsGenerated++;

      // Set source_type on the newly created aff_content record
      const sourceType = source === 'all' ? null : source; // 'benchmark' | 'trend' | null
      if (sourceType) {
        await db.update(affContents)
          .set({ source_type: sourceType })
          .where(eq(affContents.id, generated.id));
      }
    } catch (err) {
      const msg = `Content generation failed for product ${match.product_id}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[pipeline] ${msg}`);
    }
  }

  console.log(`[pipeline] Content generated: ${contentsGenerated}`);
  pipelineLog('content-generate', { generated: contentsGenerated });

  // Step 5: 분석 완료된 포스트에 analyzed_at 마킹
  const postIds = posts.map(p => p.post_id);
  const now = new Date();
  let markedCount = 0;
  for (const postId of postIds) {
    try {
      await db.update(threadPosts)
        .set({ analyzed_at: now })
        .where(eq(threadPosts.post_id, postId));
      markedCount++;
    } catch { /* non-critical */ }
  }
  console.log(`[pipeline] Marked ${markedCount} posts as analyzed`);
  pipelineLog('mark-analyzed', { marked: markedCount });

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
  pipelineLog('pipeline-end', { ...result });

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
// Usage: npx tsx src/analyzer/pipeline.ts [--category 뷰티] [--limit 50] [--skip-content] [--all] [--source benchmark|trend]
const isDirectRun = process.argv[1]?.endsWith('pipeline.ts') || process.argv[1]?.endsWith('pipeline.js');
if (isDirectRun) {
  // ⚠️ API 비용 경고: 이 코드는 Anthropic API(Sonnet)를 호출하며 비용이 발생합니다.
  // $0 대안: Claude Code에서 /threads-pipeline 스킬을 사용하세요.
  const args = process.argv.slice(2);

  if (!args.includes('--force')) {
    console.warn('\n' + '='.repeat(60));
    console.warn('⚠️  경고: 이 명령은 Anthropic API를 호출하여 비용이 발생합니다.');
    console.warn('');
    console.warn('$0 대안: Claude Code에서 /threads-pipeline 스킬을 사용하세요.');
    console.warn('  → Claude Code가 직접 분석하므로 API 비용 $0');
    console.warn('');
    console.warn('그래도 API로 실행하려면: npm run analyze -- --force');
    console.warn('='.repeat(60) + '\n');
    process.exit(0);
  }

  const categoryIdx = args.indexOf('--category');
  const limitIdx = args.indexOf('--limit');
  const sourceIdx = args.indexOf('--source');
  const cliOptions: Parameters<typeof runAnalysisPipeline>[0] = {};
  if (categoryIdx !== -1 && args[categoryIdx + 1]) {
    cliOptions.category = args[categoryIdx + 1];
  }
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    cliOptions.postLimit = parseInt(args[limitIdx + 1], 10);
  }
  if (args.includes('--skip-content')) {
    cliOptions.skipContentGeneration = true;
  }
  // --all: 오늘 수집분뿐 아니라 전체 포스트 분석 (기본은 todayOnly=true)
  if (args.includes('--all')) {
    cliOptions.todayOnly = false;
  }
  // --source benchmark|trend: 수집 소스별 필터
  if (sourceIdx !== -1 && args[sourceIdx + 1]) {
    const src = args[sourceIdx + 1];
    if (src === 'benchmark' || src === 'trend' || src === 'all') {
      cliOptions.source = src as PostSource;
    }
  }

  runAnalysisPipeline(cliOptions)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.errors.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Pipeline failed:', err);
      process.exit(1);
    });
}
