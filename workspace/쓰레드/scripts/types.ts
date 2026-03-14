/**
 * @file Shared type definitions for threads-watch pipeline.
 * Mirrors canonical-schema.json and checkpoint-schema.json.
 */

// --- Base types ---

export interface Metrics {
  view_count: number | null;
  like_count: number;
  reply_count: number;
  repost_count: number;
}

export interface Comment {
  comment_id?: string;
  author?: string;
  text?: string;
  has_affiliate_link?: boolean;
  link_url?: string | null;
  metrics?: { view_count?: number | null; like_count?: number };
  media_urls?: string[];
}

export interface Tags {
  primary: 'affiliate' | 'purchase_signal' | 'review' | 'complaint' | 'interest' | 'general';
  secondary: string[];
}

export interface CrawlMeta {
  crawl_at: string; // ISO 8601
  run_id?: string;
  selector_tier?: 'data-testid' | 'aria-label' | 'css-nth-child' | 'fallback';
  login_status?: boolean;
  block_detected?: boolean;
}

// --- Canonical post (canonical-schema.json v1.0) ---

export interface CanonicalPost {
  post_id: string;
  channel_id: string;
  author?: string;
  text: string;
  timestamp: string; // ISO 8601
  permalink?: string;
  metrics?: Metrics;
  media?: { has_image: boolean; urls: string[] };
  comments?: Comment[];
  tags?: Tags;
  thread_type?: string;
  conversion_rate?: number | null;
  link?: { url?: string | null; domain?: string | null; location?: string };
  channel_meta?: { display_name?: string; follower_count?: number; category?: string };
  crawl_meta?: CrawlMeta;
}

export interface CanonicalMeta {
  generated_at: string;
  taxonomy_version: string;
  schema_version: string;
  final_count: number;
  channels: string[];
  validity_rate: number;
}

export interface CanonicalOutput {
  meta: CanonicalMeta;
  posts: CanonicalPost[];
}

// --- Research ---

export interface PurchaseSignal {
  post_id: string;
  channel_id?: string;
  text: string;
  signal_level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  matched_pattern?: string;
  category_hint?: string | null;
  engagement?: Metrics;
}

export interface KeywordEntry {
  keyword: string;
  count: number;
  signal_level: string | null;
  trend: string | null;
}

export interface TrendEntry {
  keyword: string;
  recent_count: number;
  old_count: number;
  trend: string;
  sample_post_ids?: string[];
}

export interface ResearchBrief {
  date: string;
  posts_analyzed: number;
  top_keywords: KeywordEntry[];
  purchase_signals: PurchaseSignal[];
  purchase_signals_non_affiliate?: PurchaseSignal[];
  question_posts?: unknown[];
  emotional_posts?: unknown[];
  emerging_topics?: TrendEntry[];
  declining_topics?: TrendEntry[];
  engagement_summary?: Record<string, unknown>;
  channel_breakdown?: Record<string, unknown>;
}

// --- Needs detection ---

export type NeedsCategory = '불편해소' | '시간절약' | '돈절약' | '성과향상' | '외모건강' | '자기표현';
export type PurchaseLinkage = '상' | '중' | '하';
export type SignalLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface NeedItem {
  need_id: string;
  category: NeedsCategory;
  problem: string;
  representative_expressions: string[];
  signal_strength: SignalLevel | null;
  post_count: number;
  purchase_linkage: PurchaseLinkage;
  why_linkage: string;
  product_categories: string[];
  threads_fit: number;
  threads_fit_reason: string;
  sample_post_ids?: string[];
}

export interface NeedsMap {
  date: string;
  needs_map: NeedItem[];
  priority_ranking: string[];
  low_priority_reasons: Record<string, string>;
  meta?: {
    taxonomy_version: string;
    schema_version: string;
    analysis_type: string;
    posts_analyzed: number;
    signals_input: number;
    generated_at: string;
  };
}

// --- Eval ---

export interface GoldLabel {
  primary_tag: string | null;
  secondary_tags: string[];
  purchase_signal_level: string | null;
  needs_category: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  notes: string;
}

export interface EvalPost {
  eval_id: string;
  post_id: string;
  channel_id: string;
  text: string;
  timestamp: string;
  permalink?: string;
  thread_type?: string;
  link?: CanonicalPost['link'];
  metrics?: Metrics;
  comments?: { text?: string; has_affiliate_link?: boolean }[];
  auto_tags: Tags;
  gold_label: GoldLabel;
}

export interface EvalSet {
  meta: {
    version: string;
    created_at: string;
    taxonomy_version: string;
    schema_version: string;
    total_posts: number;
    source: string;
    selection_strategy: string;
    seed: number;
    labeling_status: string;
    channels_represented: string[];
  };
  posts: EvalPost[];
}

// --- P2: Product matching ---

export type AffiliatePlatform = 'coupang_partners' | 'naver_smartstore' | 'ali_express' | 'other';

export interface ThreadsScore {
  naturalness: number;   // 1-5: Threads 소개 자연스러움
  clarity: number;       // 1-5: 문제 해결 명확성
  ad_smell: number;      // 1-5: 광고 냄새 안 남 (높을수록 자연스러움)
  repeatability: number; // 1-5: 반복 노출 가능성
  story_potential: number; // 1-5: 후기/스토리 가능성
  total: number;         // 가중평균
}

export interface ProductEntry {
  product_id: string;
  name: string;
  category: string;
  needs_categories: NeedsCategory[];
  keywords: string[];
  affiliate_platform: AffiliatePlatform;
  price_range: string;
  description: string;
}

export interface ProductMatch {
  product_id: string;
  name: string;
  affiliate_platform: AffiliatePlatform;
  price_range: string;
  threads_score: ThreadsScore;
  competition: '상' | '중' | '하';
  priority: number;
  why: string;
}

export interface ProductMatchOutput {
  date: string;
  matches: Array<{
    need_id: string;
    need_category: NeedsCategory;
    need_problem: string;
    products: ProductMatch[];
  }>;
  meta: {
    product_dict_version: string;
    needs_input_count: number;
    products_matched: number;
    generated_at: string;
  };
}

// --- P2: Positioning ---

export type PositionFormat = '문제공감형' | '솔직후기형' | '비교형' | '입문추천형' | '실수방지형' | '비추천형';

export interface PositionVariant {
  format: PositionFormat;
  angle: string;
  tone: string;
  hook: string;
  avoid: string[];
  cta_style: string;
}

export interface PositioningCard {
  product_id: string;
  product_name: string;
  need_id: string;
  positions: PositionVariant[];
}

export interface PositioningOutput {
  date: string;
  positioning_cards: PositioningCard[];
  meta: {
    products_input: number;
    cards_generated: number;
    generated_at: string;
  };
}

// --- Raw data (from collect-posts.js) ---

export interface RawThreadUnit {
  hook_post_id?: string;
  hook_text?: string;
  hook_date?: string;
  hook_author?: string;
  hook_views?: string;
  hook_likes?: string;
  hook_reposts?: string;
  hook_replies?: string;
  hook_has_image?: boolean;
  hook_link_text?: string;
  hook_link_url?: string;
  comments?: Array<{
    text?: string;
    has_affiliate_link?: boolean;
    link_url?: string | null;
    media_urls?: string[];
  }>;
  [key: string]: unknown;
}

export interface RawPostFile {
  meta: {
    channel: string;
    collected_at: string;
    run_id?: string;
    selector_tier?: string;
    login_status?: boolean;
  };
  thread_units: RawThreadUnit[];
}
