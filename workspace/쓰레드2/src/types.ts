/**
 * @file Shared type definitions for threads-watch pipeline.
 * Mirrors canonical-schema.json and checkpoint-schema.json.
 *
 * Migrated from 쓰레드/scripts/types.ts + extended with Account, Snapshot,
 * ContentLifecycle, Diagnosis types for 쓰레드2 pipeline.
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

  // Phase 1: Threads native topic tags (raw)
  topic_tags?: string[];
  topic_category?: string;
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
  affiliate_link?: string;
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

// --- P2: Learning feedback ---

export interface LearningEntry {
  product_id: string;
  naturalness_delta?: number;
  clarity_delta?: number;
  ad_smell_delta?: number;
  repeatability_delta?: number;
  story_potential_delta?: number;
}

// --- P3: Content Generation ---

export interface ContentDraft {
  product_id: string;
  product_name: string;
  need_id: string;
  format: PositionFormat;
  hook: string;            // 대표 훅 (positions[0].hook)
  bodies: string[];        // 3개 본문 변형
  hooks: string[];         // 5개 훅 변형
  self_comments: string[]; // 2개 자기 댓글
}

export interface ContentDraftOutput {
  date: string;
  drafts: ContentDraft[];
  meta: {
    positioning_version: string;
    drafts_generated: number;
    generated_at: string;
  };
}

// --- P3: Performance Analysis ---

export type TimeSlot = '새벽' | '오전' | '오후' | '밤';

export interface PerformanceMetrics {
  avg_views: number | null;
  avg_likes: number;
  avg_replies: number;
  post_count: number;
}

export interface AnalysisReport {
  date: string;
  format_performance: Record<string, PerformanceMetrics>;
  time_performance: Record<TimeSlot, PerformanceMetrics>;
  top_performing_posts: Array<{
    post_id: string;
    channel_id: string;
    views: number | null;
    likes: number;
    tag: string;
  }>;
  learning_deltas: LearningEntry[];
  meta: {
    posts_analyzed: number;
    date_range: { from: string; to: string };
    generated_at: string;
  };
}

// --- Crawl orchestration types (S-0~S-2) ---

export interface LoginResult {
  status: 'logged_in' | 'needs_human' | 'error';
  reason?: 'captcha' | '2fa' | 'wrong_password' | 'unknown';
  screenshot?: string;
}

export interface DiscoveredChannel {
  channel_id: string;
  display_name: string;
  follower_count: number;
  bio: string;
  recent_ad_count: number;
  source_keyword: string;
  discovered_at: string;
}

export interface DiscoveryResult {
  channels: DiscoveredChannel[];
  review_queue: DiscoveredChannel[];
  stats: { searched: number; passed: number; filtered: number };
}

export interface CrawlOptions {
  resume?: boolean;
  channels?: number;
  postsPerChannel?: number;
  skipDiscover?: boolean;
}

export interface ChannelCompletion {
  channel_id: string;
  threads_collected: number;
  session: number;
}

export interface CrawlCheckpoint {
  run_id: string;
  target_channels: number;
  target_posts_per_channel: number;
  channels_completed: ChannelCompletion[];
  channels_queue: string[];
  channels_discovered: string[];
  current_channel: string | null;
  current_channel_posts: string[];
  total_threads_collected: number;
  total_sheets_rows: number;
  session_count: number;
  browser_ops_this_session: number;
  blocked_channels: string[];
  timestamp: string;
  status: 'running' | 'paused_context_limit' | 'paused_blocked' | 'budget_exhausted' | 'completed' | 'needs_human';
}

// =============================================================================
// 쓰레드2 신규 타입 — 계정관리, 스냅샷 추적, 콘텐츠 라이프사이클, 진단
// =============================================================================

// --- 계정 관리 ---

export interface Account {
  id: string;
  username: string;
  email: string;
  status: 'active' | 'warming_up' | 'restricted' | 'banned' | 'retired';
  proxy_id: string;
  fingerprint_id: string;
  created_at: string;
  last_posted_at: string | null;
  post_count: number;
  ban_count: number;
  health_score: number; // 0-100
}

// --- 포스트 스냅샷 (6h/48h/7d) ---

export interface PostSnapshot {
  id: string;
  post_id: string;
  snapshot_type: 'early' | 'mature' | 'final'; // 6h, 48h, 7d
  snapshot_at: string;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  conversions: number;
  revenue: number;
  engagement_velocity: number;  // (likes+comments+shares) / age_hours
  click_velocity: number;       // clicks / age_hours
  conversion_velocity: number;  // conversions / age_hours

  // Phase 1: separate view counts
  post_views?: number;
  comment_views?: number;
}

// --- 포스트 성숙도 ---

export type PostMaturity = 'warmup' | 'early' | 'mature' | 'final';

// --- 콘텐츠 전체 라이프사이클 ---

export interface ContentLifecycle {
  id: string;

  // 1. 수집 단계
  source_post_id: string;
  source_channel_id: string;
  source_engagement: number;
  source_relevance: number; // 0-1

  // 2. 분석 단계
  extracted_need: string;
  need_category: string; // 6개 욕구 유형
  need_confidence: number; // 0-1

  // 3. 매칭 단계
  matched_product_id: string;
  match_relevance: number; // 0-1

  // 4. 콘텐츠 단계
  content_text: string;
  content_style: string; // 6가지 포맷
  hook_type: string; // 5가지 훅 타입

  // 5. 발행 단계
  posted_account_id: string;
  posted_at: string;

  // 6. 성과 (스냅샷에서 집계)
  maturity: PostMaturity;
  current_impressions: number;
  current_clicks: number;
  current_conversions: number;
  current_revenue: number;

  // 7. 진단
  diagnosis: string | null; // 'collection_weak' | 'analysis_wrong' | 'match_wrong' | 'content_weak' | 'publishing_issue' | null
  diagnosed_at: string | null;
}

// --- 진단 리포트 ---

export interface DiagnosisReport {
  id: string;
  report_type: 'weekly' | 'monthly';
  period_start: string;
  period_end: string;
  created_at: string;

  // 코호트 통계
  total_posts: number;
  top_10_percent_count: number;
  bottom_10_percent_count: number;

  // 단계별 지표 요약
  avg_source_engagement: number;
  avg_need_confidence: number;
  avg_ctr: number;
  avg_conversion_rate: number;
  avg_revenue_per_post: number;

  // 병목 진단
  bottleneck: 'collection' | 'analysis' | 'matching' | 'content' | 'publishing' | 'none';
  bottleneck_evidence: string;

  // 튜닝 제안
  tuning_actions: TuningAction[];

  // AI 분석 결과 (TOP/BOTTOM 비교)
  ai_analysis: string | null;
}

export interface TuningAction {
  target: 'scraper' | 'analyzer' | 'matcher' | 'content_generator' | 'publisher';
  action: string;
  priority: 'high' | 'medium' | 'low';
  applied: boolean;
  applied_at: string | null;
}

// --- 주간 코호트 ---

export interface WeeklyCohort {
  week_start: string;
  week_end: string;
  posts: ContentLifecycle[];
  top_performers: ContentLifecycle[];    // engagement_velocity 상위 10%
  bottom_performers: ContentLifecycle[]; // engagement_velocity 하위 10%
}

// =============================================================================
// Publisher 모듈 타입 — 포스팅, 워밍업, 스케줄러
// =============================================================================

// --- 포스팅 ---

export interface PostOptions {
  text: string;               // 포스트 본문
  accountId: string;          // 발행 계정
  selfComment?: string;       // 셀프댓글 (제휴링크 포함 가능)
  dryRun?: boolean;           // true면 실제 게시 안 함 (테스트용)
}

export interface PostResult {
  success: boolean;
  postId?: string;            // 게시된 포스트 ID (URL에서 추출)
  postUrl?: string;           // 게시된 포스트 URL
  error?: string;
}

// --- 워밍업 ---

export interface WarmupStatus {
  accountId: string;
  totalPosts: number;
  warmupTarget: number;       // 20
  isComplete: boolean;
  remainingPosts: number;
}

// --- 스케줄러 ---

export interface QueueItem {
  contentId: string;
  accountId: string;
  scheduledAt: Date;
  text: string;
  selfComment?: string;
  isAffiliate: boolean;
}

// --- 계정 등록 ---

export interface NewAccount {
  username: string;
  email: string;
  proxyId?: string;
  fingerprintId?: string;
}
