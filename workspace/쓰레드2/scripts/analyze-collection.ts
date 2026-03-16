#!/usr/bin/env tsx
/**
 * analyze-collection.ts — 키워드 수집 결과 분석 + 니즈 밀도 리포트
 *
 * Phase 4: 수집된 포스트를 카테고리별로 분석하여 니즈 밀도 및 engagement 통계를 산출한다.
 * 결과를 docs/category-analysis.md 로 저장한다.
 *
 * Usage:
 *   npx tsx scripts/analyze-collection.ts
 *   npx tsx scripts/analyze-collection.ts --input data/keyword_posts/kw_20260316_1200.json
 */

import fs from 'fs';
import path from 'path';
import type { CanonicalPost } from '../src/types.js';

// ─── Config ──────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
const KEYWORD_POSTS_DIR = path.join(DATA_DIR, 'keyword_posts');
const KEYWORDS_PATH = path.join(DATA_DIR, 'consumer_keywords.json');
const COLLECTION_LOG_PATH = path.join(DATA_DIR, 'keyword_collection_log.json');
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const REPORT_PATH = path.join(DOCS_DIR, 'category-analysis.md');

// ─── Types ───────────────────────────────────────────────

interface CategoryAnalysis {
  category: string;
  total_posts: number;
  needs_posts: number;
  needs_density: number; // percentage
  avg_likes: number;
  avg_replies: number;
  avg_reposts: number;
  total_engagement: number;
  avg_engagement: number;
  tag_distribution: Record<string, number>;
  top_posts: Array<{
    post_id: string;
    author: string;
    text_preview: string;
    likes: number;
    replies: number;
    tag: string;
  }>;
  keywords_used: string[];
}

interface CollectionLog {
  run_id: string;
  completed_at: string;
  total_keywords: number;
  total_posts_found: number;
  total_posts_new: number;
  categories: string[];
  results: Array<{
    keyword: string;
    category: string;
    posts_found: number;
    posts_new: number;
    posts_skipped: number;
  }>;
}

interface PostFile {
  meta: {
    run_id: string;
    collected_at: string;
    total_posts: number;
    keywords_searched?: number;
    categories?: string[];
    partial?: boolean;
  };
  posts: CanonicalPost[];
}

// ─── Utility ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Needs Detection ─────────────────────────────────────

const NEEDS_INDICATORS = [
  // Recommendation requests
  '추천', '추천해줘', '뭐가 좋', '뭐가좋', '뭐 쓰', '뭐써', '알려줘',
  // Questions / concerns
  '고민', '어떤게', '어떻게', '궁금', '질문',
  // Purchase intent
  '사고싶', '살까', '살려고', '구매', '장바구니',
  // Reviews / experience sharing
  '써봤는데', '써본', '사용해봤', '후기', '리뷰', '솔직',
  // Problem expressions
  '힘들다', '피곤', '지친다', '고민이', '어떡해', '도움',
  // Interest
  '관심', '궁금해', '알고싶', '찾고있', '필요해',
];

function isNeedsPost(text: string): boolean {
  for (const indicator of NEEDS_INDICATORS) {
    if (text.includes(indicator)) return true;
  }
  return false;
}

// ─── Load Posts ──────────────────────────────────────────

function loadPosts(inputPath?: string): CanonicalPost[] {
  if (inputPath && fs.existsSync(inputPath)) {
    const data: PostFile = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    log(`입력 파일 로드: ${inputPath} (${data.posts.length}개 포스트)`);
    return data.posts;
  }

  // Find latest file in keyword_posts directory
  if (!fs.existsSync(KEYWORD_POSTS_DIR)) {
    log('keyword_posts 디렉토리 없음 — 빈 결과로 분석');
    return [];
  }

  const files = fs.readdirSync(KEYWORD_POSTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    log('keyword_posts 디렉토리에 파일 없음');
    return [];
  }

  // Load all files and merge
  const allPosts: CanonicalPost[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    const filePath = path.join(KEYWORD_POSTS_DIR, file);
    try {
      const data: PostFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const post of data.posts) {
        if (!seenIds.has(post.post_id)) {
          seenIds.add(post.post_id);
          allPosts.push(post);
        }
      }
    } catch {
      log(`파일 로드 실패 (스킵): ${file}`);
    }
  }

  log(`총 ${allPosts.length}개 포스트 로드 (파일 ${files.length}개)`);
  return allPosts;
}

// ─── Category Mapping ────────────────────────────────────

function getCategoryFromPost(post: CanonicalPost): string {
  // channel_meta.category contains "search:카테고리명" for keyword-collected posts
  const catMeta = post.channel_meta?.category || '';
  if (catMeta.startsWith('search:')) {
    return catMeta.replace('search:', '');
  }
  // Fallback: try to find from secondary tags
  return '기타';
}

// ─── Analysis ────────────────────────────────────────────

function analyzeByCategory(posts: CanonicalPost[]): CategoryAnalysis[] {
  const categoryMap = new Map<string, CanonicalPost[]>();

  for (const post of posts) {
    const category = getCategoryFromPost(post);
    const existing = categoryMap.get(category) || [];
    existing.push(post);
    categoryMap.set(category, existing);
  }

  const analyses: CategoryAnalysis[] = [];

  for (const [category, catPosts] of categoryMap) {
    let totalLikes = 0;
    let totalReplies = 0;
    let totalReposts = 0;
    let needsPostCount = 0;
    const tagDist: Record<string, number> = {};
    const keywordsUsed = new Set<string>();

    for (const post of catPosts) {
      totalLikes += post.metrics?.like_count || 0;
      totalReplies += post.metrics?.reply_count || 0;
      totalReposts += post.metrics?.repost_count || 0;

      if (isNeedsPost(post.text)) {
        needsPostCount++;
      }

      const tag = post.tags?.primary || 'unknown';
      tagDist[tag] = (tagDist[tag] || 0) + 1;

      // Extract keyword from secondary tags or channel_meta
      if (post.crawl_meta?.run_id) {
        keywordsUsed.add(post.crawl_meta.run_id);
      }
    }

    const count = catPosts.length;
    const totalEngagement = totalLikes + totalReplies + totalReposts;

    // Top posts by engagement
    const sortedPosts = [...catPosts]
      .sort((a, b) => {
        const engA = (a.metrics?.like_count || 0) + (a.metrics?.reply_count || 0) + (a.metrics?.repost_count || 0);
        const engB = (b.metrics?.like_count || 0) + (b.metrics?.reply_count || 0) + (b.metrics?.repost_count || 0);
        return engB - engA;
      })
      .slice(0, 5);

    analyses.push({
      category,
      total_posts: count,
      needs_posts: needsPostCount,
      needs_density: count > 0 ? Math.round((needsPostCount / count) * 100 * 10) / 10 : 0,
      avg_likes: count > 0 ? Math.round(totalLikes / count * 10) / 10 : 0,
      avg_replies: count > 0 ? Math.round(totalReplies / count * 10) / 10 : 0,
      avg_reposts: count > 0 ? Math.round(totalReposts / count * 10) / 10 : 0,
      total_engagement: totalEngagement,
      avg_engagement: count > 0 ? Math.round(totalEngagement / count * 10) / 10 : 0,
      tag_distribution: tagDist,
      top_posts: sortedPosts.map(p => ({
        post_id: p.post_id,
        author: p.author || 'unknown',
        text_preview: p.text.slice(0, 80).replace(/\n/g, ' ') + (p.text.length > 80 ? '...' : ''),
        likes: p.metrics?.like_count || 0,
        replies: p.metrics?.reply_count || 0,
        tag: p.tags?.primary || 'unknown',
      })),
      keywords_used: [...keywordsUsed],
    });
  }

  // Sort by needs density descending
  analyses.sort((a, b) => b.needs_density - a.needs_density);
  return analyses;
}

// ─── Report Generation ──────────────────────────────────

function generateReport(
  analyses: CategoryAnalysis[],
  totalPosts: number,
  collectionLog?: CollectionLog,
): string {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lines: string[] = [];

  lines.push('# 상품 DB 카테고리 분석 리포트');
  lines.push('');
  lines.push(`> 생성일시: ${now}`);
  if (collectionLog) {
    lines.push(`> 수집 ID: ${collectionLog.run_id}`);
    lines.push(`> 수집 완료: ${collectionLog.completed_at}`);
  }
  lines.push('');

  // ── Section 1: Category Stats ──
  lines.push('## 1. 상품 DB 카테고리 분석');
  lines.push('');

  // Load category stats from consumer_keywords.json if available
  if (fs.existsSync(KEYWORDS_PATH)) {
    const kwData = JSON.parse(fs.readFileSync(KEYWORDS_PATH, 'utf-8'));
    const stats = kwData.category_stats || [];
    lines.push(`- 총 상품: ${kwData.total_products}개`);
    lines.push(`- 카테고리: ${kwData.total_categories}개`);
    lines.push('');
    lines.push('| 카테고리 | 상품수 | 주요 니즈 |');
    lines.push('|---------|--------|----------|');
    for (const stat of stats) {
      const topNeeds = Object.entries(stat.needs_distribution as Record<string, number>)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 2)
        .map(([k]) => k)
        .join(', ');
      lines.push(`| ${stat.category} | ${stat.product_count} | ${topNeeds} |`);
    }
  }
  lines.push('');

  // ── Section 2: Consumer Keywords ──
  lines.push('## 2. 소비자 키워드 설계');
  lines.push('');
  if (fs.existsSync(KEYWORDS_PATH)) {
    const kwData = JSON.parse(fs.readFileSync(KEYWORDS_PATH, 'utf-8'));
    const plans = kwData.keyword_plans || [];
    lines.push('| 카테고리 | 키워드 | 예상 타겟 |');
    lines.push('|---------|--------|----------|');
    for (const plan of plans) {
      for (const kw of plan.keywords) {
        lines.push(`| ${kw.category} | ${kw.keyword} | ${kw.target_need} / ${kw.expected_post_type} |`);
      }
    }
  }
  lines.push('');

  // ── Section 3: Collection Results ──
  lines.push('## 3. 수집 결과');
  lines.push('');
  lines.push(`- 총 포스트: ${totalPosts}개`);

  if (collectionLog) {
    lines.push(`- 검색 키워드: ${collectionLog.total_keywords}개`);
    lines.push(`- 포스트 발견: ${collectionLog.total_posts_found}개`);
    lines.push(`- 신규 포스트: ${collectionLog.total_posts_new}개`);
    lines.push(`- 카테고리: ${collectionLog.categories.join(', ')}`);
  }

  if (analyses.length > 0) {
    lines.push('');
    lines.push('카테고리별 수집:');
    lines.push('');
    lines.push('| 카테고리 | 포스트수 | 평균좋아요 | 평균답글 | 평균리포스트 |');
    lines.push('|---------|---------|----------|---------|-----------|');
    for (const a of analyses) {
      lines.push(`| ${a.category} | ${a.total_posts} | ${a.avg_likes} | ${a.avg_replies} | ${a.avg_reposts} |`);
    }
  }
  lines.push('');

  // ── Section 4: Needs Density Analysis ──
  lines.push('## 4. 니즈 밀도 분석');
  lines.push('');
  lines.push('니즈 밀도 = (니즈 관련 포스트 수 / 전체 포스트 수) x 100');
  lines.push('');

  if (analyses.length > 0) {
    lines.push('| 순위 | 카테고리 | 니즈 포스트 | 전체 포스트 | 니즈 밀도 | 평균 engagement |');
    lines.push('|-----|---------|-----------|-----------|---------|----------------|');
    analyses.forEach((a, idx) => {
      lines.push(`| ${idx + 1} | ${a.category} | ${a.needs_posts} | ${a.total_posts} | ${a.needs_density}% | ${a.avg_engagement} |`);
    });
    lines.push('');

    // Ranking highlight
    const top3 = analyses.slice(0, 3);
    lines.push('### 니즈 밀도 TOP 3');
    lines.push('');
    for (let i = 0; i < top3.length; i++) {
      const a = top3[i];
      lines.push(`**${i + 1}위: ${a.category}** - 니즈 밀도 ${a.needs_density}%`);
      lines.push(`- 포스트: ${a.total_posts}개 (니즈 ${a.needs_posts}개)`);
      lines.push(`- 평균 engagement: ${a.avg_engagement}`);
      lines.push(`- 태그 분포: ${Object.entries(a.tag_distribution).map(([k, v]) => `${k}(${v})`).join(', ')}`);
      lines.push('');
    }
  } else {
    lines.push('(수집된 포스트가 없어 분석 불가)');
    lines.push('');
  }

  // ── Section 5: Tag Distribution ──
  lines.push('## 5. 포스트 태그 분포');
  lines.push('');

  if (analyses.length > 0) {
    const globalTags: Record<string, number> = {};
    for (const a of analyses) {
      for (const [tag, count] of Object.entries(a.tag_distribution)) {
        globalTags[tag] = (globalTags[tag] || 0) + count;
      }
    }
    const sortedTags = Object.entries(globalTags).sort((a, b) => b[1] - a[1]);
    lines.push('| 태그 | 수량 | 비율 |');
    lines.push('|------|-----|------|');
    for (const [tag, count] of sortedTags) {
      const pct = totalPosts > 0 ? Math.round(count / totalPosts * 100 * 10) / 10 : 0;
      lines.push(`| ${tag} | ${count} | ${pct}% |`);
    }
  }
  lines.push('');

  // ── Section 6: Top Posts ──
  lines.push('## 6. Top Engagement 포스트');
  lines.push('');

  if (analyses.length > 0) {
    for (const a of analyses) {
      if (a.top_posts.length === 0) continue;
      lines.push(`### ${a.category}`);
      lines.push('');
      for (const p of a.top_posts.slice(0, 3)) {
        lines.push(`- **@${p.author}** (${p.tag}) - likes:${p.likes}, replies:${p.replies}`);
        lines.push(`  > ${p.text_preview}`);
      }
      lines.push('');
    }
  }

  // ── Section 7: Recommendations ──
  lines.push('## 7. 추천 전략');
  lines.push('');

  if (analyses.length > 0) {
    const topCategory = analyses[0];
    const highEngagement = analyses.sort((a, b) => b.avg_engagement - a.avg_engagement)[0];

    lines.push('### 집중 카테고리');
    lines.push('');
    lines.push(`- **니즈 밀도 1위**: ${topCategory.category} (${topCategory.needs_density}%)`);
    lines.push(`  - 소비자 니즈 표현이 가장 많이 발견되는 카테고리`);
    lines.push(`  - 제휴마케팅 콘텐츠의 자연스러운 삽입 가능성 높음`);
    lines.push('');

    if (highEngagement.category !== topCategory.category) {
      lines.push(`- **Engagement 1위**: ${highEngagement.category} (평균 ${highEngagement.avg_engagement})`);
      lines.push(`  - 사용자 반응이 가장 활발한 카테고리`);
      lines.push('');
    }

    lines.push('### 추천 키워드');
    lines.push('');
    // Recommend keywords from top performing categories
    const topCategories = analyses.slice(0, 3);
    for (const cat of topCategories) {
      lines.push(`- **${cat.category}**: engagement가 높은 포스트의 키워드 패턴 분석 권장`);
    }
    lines.push('');

    lines.push('### 다음 단계');
    lines.push('');
    lines.push('1. 니즈 밀도 높은 카테고리의 키워드를 추가 확장하여 2차 수집');
    lines.push('2. 수집된 포스트에 대해 AI 분석 파이프라인 적용 (`npm run analyze`)');
    lines.push('3. 분석 결과를 바탕으로 제휴 콘텐츠 포지셔닝 설계');
  } else {
    lines.push('(수집 데이터가 없어 추천 불가. 먼저 collect-by-keyword.ts 를 실행하세요.)');
  }
  lines.push('');

  return lines.join('\n');
}

// ─── CLI Args ────────────────────────────────────────────

function parseCliArgs(): { inputPath?: string } {
  const args = process.argv.slice(2);
  const opts: { inputPath?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      opts.inputPath = args[i + 1];
      i++;
    }
  }
  return opts;
}

// ─── Main ────────────────────────────────────────────────

function main(): void {
  const opts = parseCliArgs();
  log('=== 키워드 수집 결과 분석 시작 ===');

  // Load posts
  const posts = loadPosts(opts.inputPath);

  // Load collection log if available
  let collectionLog: CollectionLog | undefined;
  try {
    if (fs.existsSync(COLLECTION_LOG_PATH)) {
      collectionLog = JSON.parse(fs.readFileSync(COLLECTION_LOG_PATH, 'utf-8'));
    }
  } catch {
    log('collection log 로드 실패 — 무시');
  }

  // Analyze
  const analyses = analyzeByCategory(posts);
  log(`분석 완료: ${analyses.length}개 카테고리`);

  // Print summary to console
  log('\n=== 분석 결과 요약 ===');
  log(`총 포스트: ${posts.length}개`);
  log(`카테고리: ${analyses.length}개\n`);

  if (analyses.length > 0) {
    log('니즈 밀도 순위:');
    analyses.forEach((a, idx) => {
      log(`  ${idx + 1}위: [${a.category}] — 니즈 ${a.needs_density}% (${a.needs_posts}/${a.total_posts}), engagement 평균 ${a.avg_engagement}`);
    });
  }

  // Generate report
  const report = generateReport(analyses, posts.length, collectionLog);

  // Save report
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, report, 'utf-8');
  log(`\n리포트 저장: ${REPORT_PATH}`);
}

main();
