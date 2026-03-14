#!/usr/bin/env tsx
/**
 * normalize-posts.ts
 * raw_posts (hook_* format) → canonical-schema.json format 변환기
 *
 * Usage:
 *   tsx scripts/normalize-posts.ts                    # 전체 raw_posts 변환
 *   tsx scripts/normalize-posts.ts --channel teri.hous # 특정 채널만
 *   tsx scripts/normalize-posts.ts --latest            # 가장 최근 런만
 *   tsx scripts/normalize-posts.ts --out data/canonical/all.json  # 출력 경로 지정
 */

import fs from 'fs';
import path from 'path';
import type { CanonicalPost, CrawlMeta, Tags, RawThreadUnit } from './types.js';

const RAW_DIR = path.join(__dirname, '..', 'data', 'raw_posts');
const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'canonical', 'posts.json');
const TAXONOMY_PATH = path.join(__dirname, '..', 'data', 'taxonomy.json');
const SCHEMA_PATH = path.join(__dirname, '..', 'docs', 'canonical-schema.json');

// --- CLI parsing ---
interface NormalizeOpts {
  channel: string | null;
  latest: boolean;
  out: string;
  help: boolean;
}

function parseArgs(): NormalizeOpts {
  const args = process.argv.slice(2);
  const opts: NormalizeOpts = { channel: null, latest: false, out: DEFAULT_OUT, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channel' && args[i + 1]) { opts.channel = args[++i]; }
    else if (args[i] === '--latest') { opts.latest = true; }
    else if (args[i] === '--out' && args[i + 1]) { opts.out = args[++i]; }
    else if (args[i] === '--help' || args[i] === '-h') { opts.help = true; }
  }
  return opts;
}

// --- Affiliate detection (URL/keyword based, before LLM classification) ---
const AFFILIATE_DOMAINS = ['coupang.com', 'coupa.ng', 'link.coupang.com', 'musinsa.com', 'smartstore.naver.com', 'ali.ski', 'toss.im'];
const AFFILIATE_KEYWORDS = ['쿠팡파트너스', '수수료를 제공받', '할인코드', '공구', '제휴링크', '파트너스 활동'];
const AFFILIATE_PATTERNS = [
  /\[광고\]/, /^광고\s/, /인증된 계정/,
  /댓글에.{0,10}(링크|남겨)/, /링크\s*바로\s*보내/,
  /역대최저가.{0,20}원/, /평균가 대비/,
  /답례품/, /오브오르/,
  /톡방\s*(운영|참여|입장)/, /남겨줘/,
  /포장은\s*우리가/, /선물세트.{0,20}준비해/,
  /후기♥|재방문\s*고객/,
];

function detectAffiliate(text: string, linkUrl: string): boolean {
  if (linkUrl) {
    for (const domain of AFFILIATE_DOMAINS) {
      if (linkUrl.includes(domain)) return true;
    }
  }
  if (text) {
    for (const kw of AFFILIATE_KEYWORDS) {
      if (text.includes(kw)) return true;
    }
    for (const pat of AFFILIATE_PATTERNS) {
      if (pat.test(text)) return true;
    }
  }
  return false;
}

// --- Multi-tag classification ---
// Priority: affiliate > purchase_signal > review > complaint > interest > general
// Purchase signal: patterns where someone is SEEKING info/products (not giving)
const SIGNAL_PATTERNS_SIMPLE = [
  /후기\s*(있|알려|보여|좀)/, /써\s*본\s*사람/, /리뷰\s*(좀|부탁)/,
  /살까/, /지를까/, /구매\s*(할까|하려)/, /장바구니/,
  /뭐가\s*나아/, /어떤\s*게\s*(좋|나아)/,
  /어디서\s*(사|팔)/, /추천\s*(해\s*줘|좀|부탁)/, /뭐가\s*좋아/,
  /쟁여야/, /이\s*가격이면/,
];
const COMPLAINT_KEYWORDS = ['실패', '실망', '별로', '짜증', '최악', '안좋', '냄새가 나', '맛없', '후회', '이게맞아', '엉망'];
const REVIEW_KEYWORDS = ['써봤', '사봤', '사용후기', '구매후기', '이거 샀', '먹어봤', '샀는데', '사왔는데', '갈아탐'];
const INTEREST_KEYWORDS = ['추천', '좋다', '맛있', '괜찮', '예쁘', '가볼', '해보', '꿀팁', '레시피', '귀여운'];

// --- Contextual disambiguation (P1 LLM-equivalent rules) ---
// E-007 fix: info-seeking question + complaint → purchase_signal
const INFO_SEEKING_PATTERNS = [
  /잘\s*아는\s*(사람|분|스친)/,
  /아는\s*(사람|분|스친).*있을까/,
  /알려\s*줄\s*(사람|분)/,
  /알\s*(수|게)\s*있을까/,
];
// E-011, E-026 fix: advice/instructional content → not personal complaint
const ADVICE_CONTENT_MARKERS = [/▶️/, /✅/, /👉/, /단계/, /관점에서/, /이유는/];
// E-022 fix: seller self-reference → not purchase_signal
const SELF_BUSINESS_PATTERNS = [
  /사업은?\s*(잘|이)/,
  /베스트셀러.*덕분/,
  /우리\s*(제품|가게|매장|브랜드)/,
];

function classifyTag(text: string, isAffiliate: boolean): Tags {
  const tags: Tags = { primary: 'general', secondary: [] };

  if (isAffiliate) {
    tags.primary = 'affiliate';
    // Check if affiliate post also has complaint/review/signal characteristics
    if (COMPLAINT_KEYWORDS.some(kw => text.includes(kw))) tags.secondary.push('complaint');
    if (REVIEW_KEYWORDS.some(kw => text.includes(kw))) tags.secondary.push('review');
    if (SIGNAL_PATTERNS_SIMPLE.some(pat => pat.test(text))) tags.secondary.push('purchase_signal');
    return tags;
  }

  // --- Contextual disambiguation (before primary classification) ---
  const hasComplaintKw = COMPLAINT_KEYWORDS.some(kw => text.includes(kw));

  // E-007: Info-seeking question + complaint keywords → purchase_signal (not complaint)
  if (hasComplaintKw && INFO_SEEKING_PATTERNS.some(pat => pat.test(text))) {
    tags.primary = 'purchase_signal';
    tags.secondary.push('complaint');
    return tags;
  }

  // Non-affiliate classification
  if (SIGNAL_PATTERNS_SIMPLE.some(pat => pat.test(text))) {
    // E-022: Seller self-reference → not a real purchase signal
    if (SELF_BUSINESS_PATTERNS.some(pat => pat.test(text))) {
      tags.primary = 'general';
      return tags;
    }
    tags.primary = 'purchase_signal';
    if (REVIEW_KEYWORDS.some(kw => text.includes(kw))) tags.secondary.push('review');
    return tags;
  }

  if (REVIEW_KEYWORDS.some(kw => text.includes(kw))) {
    tags.primary = 'review';
    return tags;
  }

  if (hasComplaintKw) {
    // E-011, E-026: Advice content with negative keywords → not personal complaint
    const adviceMarkerCount = ADVICE_CONTENT_MARKERS.filter(pat => pat.test(text)).length;
    if (adviceMarkerCount >= 2) {
      tags.primary = 'general';
      return tags;
    }
    tags.primary = 'complaint';
    return tags;
  }

  if (INTEREST_KEYWORDS.some(kw => text.includes(kw))) {
    tags.primary = 'interest';
    return tags;
  }

  return tags;
}

// --- Convert one thread_unit (hook_* format) → canonical format ---
interface RunMeta {
  collected_at?: string;
  run_id?: string;
  channel?: string;
  selector_tier?: string;
  login_status?: boolean;
}

function normalizeUnit(unit: RawThreadUnit, runMeta: RunMeta): CanonicalPost {
  const text = (unit.hook_text as string) || '';
  const replyText = (unit as Record<string, unknown>).reply_text as string || '';
  const linkUrl = (unit as Record<string, unknown>).link_url as string || '';
  const isAffiliate = detectAffiliate(text + ' ' + replyText, linkUrl);

  // Build comments array from reply fields
  const comments: CanonicalPost['comments'] = [];
  if ((unit as Record<string, unknown>).reply_post_id) {
    const u = unit as Record<string, unknown>;
    comments.push({
      comment_id: u.reply_post_id as string,
      author: (u.display_name as string) || (u.channel_id as string) || '',
      text: replyText,
      has_affiliate_link: detectAffiliate(replyText, (u.link_location === '답글' ? linkUrl : '')),
      link_url: (u.link_location === '답글' || u.link_location === 'both') ? linkUrl : null,
      metrics: {
        view_count: typeof u.reply_view_count === 'number' ? u.reply_view_count : null,
        like_count: typeof u.reply_like_count === 'number' ? u.reply_like_count : 0,
      },
      media_urls: (u.reply_media_urls as string[]) || [],
    });
  }

  // Tags: multi-tag classification (P1 enhanced)
  const tags = classifyTag(text + ' ' + replyText, isAffiliate);

  const u = unit as Record<string, unknown>;
  const crawlMeta: CrawlMeta = {
    crawl_at: runMeta.collected_at || new Date().toISOString(),
    run_id: runMeta.run_id || '',
    selector_tier: ((unit.crawl_meta as Record<string, unknown>)?.selector_tier as CrawlMeta['selector_tier']) || 'aria-label',
    login_status: true,
    block_detected: false,
  };

  const canonical: CanonicalPost = {
    post_id: (unit.hook_post_id as string) || '',
    channel_id: (u.channel_id as string) || '',
    author: (u.display_name as string) || (u.channel_id as string) || '',
    text,
    timestamp: (unit.hook_date as string) || '',
    permalink: (u.hook_post_url as string) || '',
    metrics: {
      view_count: typeof u.hook_view_count === 'number' ? u.hook_view_count : null,
      like_count: typeof u.hook_like_count === 'number' ? u.hook_like_count : 0,
      reply_count: typeof u.hook_reply_count === 'number' ? u.hook_reply_count : 0,
      repost_count: typeof u.hook_repost_count === 'number' ? u.hook_repost_count : 0,
    },
    media: {
      has_image: !!(unit.hook_has_image),
      urls: (u.hook_media_urls as string[]) || [],
    },
    comments,
    tags,
    thread_type: (u.thread_type as string) || '단독형',
    conversion_rate: typeof u.conversion_rate === 'number' ? u.conversion_rate : null,
    link: {
      url: linkUrl || null,
      domain: (u.link_domain as string) || null,
      location: (u.link_location as string) || '없음',
    },
    channel_meta: {
      display_name: (u.display_name as string) || '',
      follower_count: typeof u.follower_count === 'number' ? u.follower_count : 0,
      category: (u.category as string) || '기타',
    },
    crawl_meta: crawlMeta,
  };

  return canonical;
}

// --- Validate required fields (P0-5 rules) ---
function validate(post: CanonicalPost): string[] {
  const errors: string[] = [];
  if (!post.post_id || !/^[A-Za-z0-9_-]+$/.test(post.post_id)) {
    errors.push('post_id: empty or invalid pattern');
  }
  if (!post.timestamp || isNaN(Date.parse(post.timestamp))) {
    errors.push('timestamp: empty or not ISO 8601');
  }
  if (!post.text || post.text.length === 0) {
    errors.push('text: empty');
  }
  if (!post.channel_id) {
    errors.push('channel_id: empty');
  }
  return errors;
}

// --- Main ---
function main(): void {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`Usage: tsx normalize-posts.ts [--channel <id>] [--latest] [--out <path>]`);
    console.log(`  Converts raw_posts (hook_* format) to canonical-schema.json format.`);
    process.exit(0);
  }

  // Load taxonomy + schema versions for metadata
  let taxonomyVersion = '1.0';
  let schemaVersion = '1.0';
  try {
    const tax = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
    taxonomyVersion = tax.version || '1.0';
  } catch { /* ignore */ }
  try {
    const sch = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    schemaVersion = sch.version || '1.0';
  } catch { /* ignore */ }

  // Read raw files
  const files = fs.readdirSync(RAW_DIR)
    .filter((f: string) => f.endsWith('.json') && !f.includes('checkpoint'))
    .sort();

  let targetFiles = files;
  if (opts.channel) {
    targetFiles = files.filter((f: string) => f.startsWith(opts.channel!));
  }
  if (opts.latest) {
    const byChannel: Record<string, string> = {};
    for (const f of targetFiles) {
      const ch = f.replace(/_run_\d+_\d+\.json$/, '');
      if (!byChannel[ch] || f > byChannel[ch]) byChannel[ch] = f;
    }
    targetFiles = Object.values(byChannel);
  }

  console.log(`Processing ${targetFiles.length} files...`);

  const allPosts: CanonicalPost[] = [];
  const quarantine: Array<CanonicalPost & { _validation_errors: string[]; _source_file: string }> = [];
  const stats = { total: 0, valid: 0, invalid: 0, affiliate: 0, channels: new Set<string>() };

  for (const file of targetFiles) {
    const filePath = path.join(RAW_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const meta: RunMeta = data.meta || {};
      const units: RawThreadUnit[] = data.thread_units || [];

      for (const unit of units) {
        stats.total++;
        const post = normalizeUnit(unit, meta);
        const errors = validate(post);

        if (errors.length > 0) {
          stats.invalid++;
          quarantine.push({ ...post, _validation_errors: errors, _source_file: file });
        } else {
          stats.valid++;
          stats.channels.add(post.channel_id);
          if (post.tags?.primary === 'affiliate') stats.affiliate++;
          allPosts.push(post);
        }
      }
    } catch (err) {
      console.error(`  Error reading ${file}: ${(err as Error).message}`);
    }
  }

  // Dedup by post_id (keep latest)
  const seen = new Map<string, CanonicalPost>();
  for (const post of allPosts) {
    const key = `${post.channel_id}_${post.post_id}`;
    const existing = seen.get(key);
    if (!existing || (post.crawl_meta!.crawl_at > existing.crawl_meta!.crawl_at)) {
      seen.set(key, post);
    }
  }
  const dedupedPosts = [...seen.values()];
  const dupCount = allPosts.length - dedupedPosts.length;

  // Build output
  const output = {
    meta: {
      generated_at: new Date().toISOString(),
      taxonomy_version: taxonomyVersion,
      schema_version: schemaVersion,
      source_files: targetFiles.length,
      total_raw: stats.total,
      valid: stats.valid,
      invalid: stats.invalid,
      deduplicated: dupCount,
      final_count: dedupedPosts.length,
      channels: [...stats.channels].sort(),
      validity_rate: stats.total > 0 ? +(stats.valid / stats.total).toFixed(4) : 0,
      affiliate_count: stats.affiliate,
    },
    posts: dedupedPosts,
  };

  // Ensure output directory
  const outDir = path.dirname(opts.out);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Atomic write
  const tmpPath = opts.out + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(tmpPath, opts.out);

  // Write quarantine if any
  if (quarantine.length > 0) {
    const qDir = path.join(__dirname, '..', 'data', 'quarantine');
    if (!fs.existsSync(qDir)) fs.mkdirSync(qDir, { recursive: true });
    const qPath = path.join(qDir, `normalize_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(qPath, JSON.stringify(quarantine, null, 2), 'utf8');
    console.log(`  Quarantined: ${quarantine.length} → ${qPath}`);
  }

  console.log(`\nDone!`);
  console.log(`  Sources: ${targetFiles.length} files`);
  console.log(`  Total raw: ${stats.total}`);
  console.log(`  Valid: ${stats.valid}, Invalid: ${stats.invalid}`);
  console.log(`  Deduped: ${dupCount}`);
  console.log(`  Final: ${dedupedPosts.length} posts from ${stats.channels.size} channels`);
  console.log(`  Validity rate: ${output.meta.validity_rate}`);
  console.log(`  Affiliate: ${stats.affiliate}`);
  console.log(`  Output: ${opts.out}`);
}

main();
