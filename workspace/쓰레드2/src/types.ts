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

// --- Topic classification ---

export type TopicCategory =
  | '건강' | '뷰티' | '다이어트' | '운동' | '생활' | '주방'
  | '디지털' | '육아' | '인테리어' | '패션' | '식품' | '문구' | '향수' | '기타';

// --- P2: Positioning ---

export type PositionFormat = '문제공감형' | '솔직후기형' | '비교형' | '입문추천형' | '실수방지형' | '비추천형';

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

  // 워밍업 모드 플래그 — true이면 revenue/conversion 기반 진단이 스킵됨
  warmup_mode?: boolean;
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
