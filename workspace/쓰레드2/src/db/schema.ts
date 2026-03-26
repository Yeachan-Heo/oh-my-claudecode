/**
 * @file Drizzle ORM schema for threads-affiliate pipeline.
 *
 * Maps plan.md section 9 DB entities + types.ts interfaces to PostgreSQL tables.
 * Uses PGlite for local development; compatible with full PostgreSQL for production.
 */

import {
  pgTable,
  pgEnum,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  numeric,
  date,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const needsCategoryEnum = pgEnum('needs_category', [
  '불편해소',
  '시간절약',
  '돈절약',
  '성과향상',
  '외모건강',
  '자기표현',
]);

export const signalLevelEnum = pgEnum('signal_level', [
  'L1',
  'L2',
  'L3',
  'L4',
  'L5',
]);

export const purchaseLinkageEnum = pgEnum('purchase_linkage', [
  '상',
  '중',
  '하',
]);

export const affiliatePlatformEnum = pgEnum('affiliate_platform', [
  'coupang_partners',
  'naver_smartstore',
  'ali_express',
  'other',
]);

export const positionFormatEnum = pgEnum('position_format', [
  '문제공감형',
  '솔직후기형',
  '비교형',
  '입문추천형',
  '실수방지형',
  '비추천형',
]);

export const accountStatusEnum = pgEnum('account_status', [
  'active',
  'warming_up',
  'restricted',
  'banned',
  'retired',
]);

export const snapshotTypeEnum = pgEnum('snapshot_type', [
  'early',   // 6h
  'mature',  // 48h
  'final',   // 7d
]);

export const postMaturityEnum = pgEnum('post_maturity', [
  'warmup',
  'early',
  'mature',
  'final',
]);

export const primaryTagEnum = pgEnum('primary_tag', [
  'affiliate',
  'purchase_signal',
  'review',
  'complaint',
  'interest',
  'general',
]);

export const diagnosisBottleneckEnum = pgEnum('diagnosis_bottleneck', [
  'collection',
  'analysis',
  'matching',
  'content',
  'publishing',
  'none',
]);

export const reportTypeEnum = pgEnum('report_type', [
  'weekly',
  'monthly',
]);

export const tuningTargetEnum = pgEnum('tuning_target', [
  'scraper',
  'analyzer',
  'matcher',
  'content_generator',
  'publisher',
]);

export const tuningPriorityEnum = pgEnum('tuning_priority', [
  'high',
  'medium',
  'low',
]);

export const crawlStatusEnum = pgEnum('crawl_status', [
  'running',
  'paused_context_limit',
  'paused_blocked',
  'budget_exhausted',
  'completed',
  'needs_human',
]);

export const competitionLevelEnum = pgEnum('competition_level', [
  '상',
  '중',
  '하',
]);

export const postSourceEnum = pgEnum('post_source', [
  'brand',
  'keyword_search',
  'x_trend',
  'benchmark',
  'legacy',
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * trend_keywords - X(트위터) 트렌드 키워드 수집 + AI 선택 추적.
 *
 * 100개 전부 저장, AI가 고른 것만 selected=true.
 */
export const trendKeywords = pgTable(
  'trend_keywords',
  {
    id: text('id').primaryKey(),
    keyword: text('keyword').notNull(),
    rank: integer('rank'),                // 트렌딩 순위 (1~99)
    source: text('source').notNull().default('x_trending'), // 'x_trending', 'naver' 등
    fetched_at: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    selected: boolean('selected').notNull().default(false),  // AI가 선택했는지
    selected_reason: text('selected_reason'),                // 선택/거절 이유
    posts_collected: integer('posts_collected').notNull().default(0), // 수집된 포스트 수
  },
  (table) => [
    index('idx_trend_fetched_at').on(table.fetched_at),
    index('idx_trend_selected').on(table.selected),
  ],
);

/**
 * channels - Discovered channels (maps to discovered_channels.json).
 */
export const channels = pgTable(
  'channels',
  {
    channel_id: text('channel_id').primaryKey(),
    display_name: text('display_name').notNull(),
    follower_count: integer('follower_count').notNull().default(0),
    bio: text('bio').default(''),
    recent_ad_count: integer('recent_ad_count').notNull().default(0),
    source_keyword: text('source_keyword').notNull(),
    discovered_at: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    is_active: boolean('is_active').notNull().default(true),

    // Benchmark tracking
    is_benchmark: boolean('is_benchmark').notNull().default(false),
    category: text('category'), // '뷰티', '건강' etc
    last_monitored_at: timestamp('last_monitored_at', { withTimezone: true }),
    monitor_interval_days: integer('monitor_interval_days').notNull().default(7),
    avg_engagement_rate: real('avg_engagement_rate'),
    notes: text('notes'),

    // Benchmark validation
    affiliate_link_ratio: real('affiliate_link_ratio'), // 제휴링크 비율 (본문+첫댓글 기준)
    content_category_ratio: real('content_category_ratio'), // 뷰티/건강 콘텐츠 비율
    benchmark_status: text('benchmark_status').default('candidate'), // 'candidate' | 'verified' | 'rejected' | 'retired'
    total_posts_checked: integer('total_posts_checked').default(0),
    posting_frequency: text('posting_frequency'), // '주 N회' 등
  },
  (table) => [
    index('idx_channels_keyword').on(table.source_keyword),
  ],
);

/**
 * thread_posts - Raw collected posts (maps to raw_posts/*.json thread_units).
 */
export const threadPosts = pgTable(
  'thread_posts',
  {
    post_id: text('post_id').primaryKey(),
    channel_id: text('channel_id').notNull(),
    author: text('author'),
    text: text('text').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }),
    permalink: text('permalink'),

    // Metrics
    view_count: integer('view_count'),
    like_count: integer('like_count').notNull().default(0),
    reply_count: integer('reply_count').notNull().default(0),
    repost_count: integer('repost_count').notNull().default(0),

    // Media
    has_image: boolean('has_image').notNull().default(false),
    media_urls: jsonb('media_urls').$type<string[]>().default([]),

    // Link info
    link_url: text('link_url'),
    link_domain: text('link_domain'),
    link_location: text('link_location'),

    // Tags
    primary_tag: primaryTagEnum('primary_tag'),
    secondary_tags: jsonb('secondary_tags').$type<string[]>().default([]),

    // Comments stored as JSONB (nested structure)
    comments: jsonb('comments').$type<Array<{
      comment_id?: string;
      author?: string;
      text?: string;
      has_affiliate_link?: boolean;
      link_url?: string | null;
      metrics?: { view_count?: number | null; like_count?: number };
      media_urls?: string[];
    }>>().default([]),

    // Channel meta snapshot at crawl time
    channel_meta: jsonb('channel_meta').$type<{
      display_name?: string;
      follower_count?: number;
      category?: string;
    }>(),

    // Crawl metadata
    crawl_at: timestamp('crawl_at', { withTimezone: true }).notNull().defaultNow(),
    run_id: text('run_id'),
    selector_tier: text('selector_tier'),
    login_status: boolean('login_status'),
    block_detected: boolean('block_detected'),

    thread_type: text('thread_type'),
    conversion_rate: real('conversion_rate'),

    // Phase 1: topic tags from Threads native topic tags
    topic_tags: text('topic_tags').array(),
    topic_category: text('topic_category'),

    // Analysis tracking: null = 미분석, timestamp = 분석 완료 시점
    analyzed_at: timestamp('analyzed_at', { withTimezone: true }),

    // Source tracking: 수집 소스 구분
    post_source: postSourceEnum('post_source'),   // 'brand' | 'keyword_search' | 'x_trend' | 'benchmark'
    brand_id: text('brand_id'),                    // 브랜드 소스인 경우 brands FK
  },
  (table) => [
    index('idx_posts_channel').on(table.channel_id),
    index('idx_posts_crawl_at').on(table.crawl_at),
    index('idx_posts_primary_tag').on(table.primary_tag),
    index('idx_posts_analyzed_at').on(table.analyzed_at),
    index('idx_posts_source').on(table.post_source),
  ],
);

/**
 * needs - Extracted needs from analysis pipeline.
 */
export const needs = pgTable(
  'needs',
  {
    need_id: text('need_id').primaryKey(),
    category: needsCategoryEnum('category').notNull(),
    problem: text('problem').notNull(),
    representative_expressions: jsonb('representative_expressions').$type<string[]>().default([]),
    signal_strength: signalLevelEnum('signal_strength'),
    post_count: integer('post_count').notNull().default(0),
    purchase_linkage: purchaseLinkageEnum('purchase_linkage').notNull(),
    why_linkage: text('why_linkage').notNull(),
    product_categories: jsonb('product_categories').$type<string[]>().default([]),
    threads_fit: integer('threads_fit').notNull().default(0), // 1-5
    threads_fit_reason: text('threads_fit_reason').notNull().default(''),
    sample_post_ids: jsonb('sample_post_ids').$type<string[]>().default([]),
    extracted_at: timestamp('extracted_at', { withTimezone: true }).notNull().defaultNow(),

    // Structured need extraction (ontogpt SPIRES pattern)
    structured_data: jsonb('structured_data').$type<{
      symptom?: string;
      concern?: string[];
      urgency?: 'low' | 'medium' | 'high';
      price_sensitivity?: 'low' | 'medium' | 'high';
      season?: string;
      target_demographic?: string;
      hook_type?: string;
      format?: string;
      duration?: string;
      emotion?: string;
    }>(),
  },
  (table) => [
    index('idx_needs_category').on(table.category),
  ],
);

/**
 * products - Affiliate product database (maps to products_v1.json).
 */
export const products = pgTable(
  'products',
  {
    product_id: text('product_id').primaryKey(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    needs_categories: jsonb('needs_categories').$type<string[]>().notNull().default([]),
    keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
    affiliate_platform: affiliatePlatformEnum('affiliate_platform').notNull(),
    price_range: text('price_range').notNull(),
    description: text('description').notNull(),
    affiliate_link: text('affiliate_link'),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_products_category').on(table.category),
    index('idx_products_platform').on(table.affiliate_platform),
  ],
);

/**
 * aff_contents - Generated affiliate content drafts (maps to content_drafts).
 */
export const affContents = pgTable(
  'aff_contents',
  {
    id: text('id').primaryKey(),
    product_id: text('product_id').notNull(),
    product_name: text('product_name').notNull(),
    need_id: text('need_id').notNull(),
    format: positionFormatEnum('format').notNull(),
    hook: text('hook').notNull(),
    bodies: jsonb('bodies').$type<string[]>().notNull().default([]),
    hooks: jsonb('hooks').$type<string[]>().notNull().default([]),
    self_comments: jsonb('self_comments').$type<string[]>().notNull().default([]),

    // Positioning data
    positioning: jsonb('positioning').$type<{
      angle?: string;
      tone?: string;
      avoid?: string[];
      cta_style?: string;
    }>(),

    // Product matching scores
    threads_score: jsonb('threads_score').$type<{
      naturalness: number;
      clarity: number;
      ad_smell: number;
      repeatability: number;
      story_potential: number;
      total: number;
    }>(),
    competition: competitionLevelEnum('competition'),
    match_priority: integer('match_priority'),
    match_why: text('match_why'),

    source_type: text('source_type'),  // 레거시 — content_source로 대체
    content_source: postSourceEnum('content_source'),  // 어떤 분석 소스에서 생성됐는지
    source_brand_id: text('source_brand_id'),          // 브랜드 기반이면 어떤 브랜드
    source_post_ids: jsonb('source_post_ids').$type<string[]>().default([]),  // 원본 포스트 ID들

    status: text('status').default('draft'),  // 'draft' | 'published' | 'rejected'

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_aff_contents_product').on(table.product_id),
    index('idx_aff_contents_need').on(table.need_id),
    index('idx_aff_contents_source').on(table.content_source),
  ],
);

/**
 * accounts - Publishing account management (1 initially, up to 10 in Phase 3).
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    status: accountStatusEnum('status').notNull().default('warming_up'),
    proxy_id: text('proxy_id').notNull().default(''),
    fingerprint_id: text('fingerprint_id').notNull().default(''),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    last_posted_at: timestamp('last_posted_at', { withTimezone: true }),
    post_count: integer('post_count').notNull().default(0),
    ban_count: integer('ban_count').notNull().default(0),
    health_score: integer('health_score').notNull().default(100), // 0-100
  },
  (table) => [
    uniqueIndex('idx_accounts_username').on(table.username),
  ],
);

/**
 * post_snapshots - 6h/48h/7d performance snapshots with velocity metrics.
 */
export const postSnapshots = pgTable(
  'post_snapshots',
  {
    id: text('id').primaryKey(),
    post_id: text('post_id').notNull(),
    snapshot_type: snapshotTypeEnum('snapshot_type').notNull(),
    snapshot_at: timestamp('snapshot_at', { withTimezone: true }).notNull().defaultNow(),
    likes: integer('likes').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    shares: integer('shares').notNull().default(0),
    saves: integer('saves').notNull().default(0),
    clicks: integer('clicks').notNull().default(0),
    conversions: integer('conversions').notNull().default(0),
    revenue: real('revenue').notNull().default(0),
    engagement_velocity: real('engagement_velocity').notNull().default(0),
    click_velocity: real('click_velocity').notNull().default(0),
    conversion_velocity: real('conversion_velocity').notNull().default(0),

    // Phase 1: separate view counts for post and comment
    post_views: integer('post_views'),
    comment_views: integer('comment_views'),

    // Phase 2: distinguish collection failures from zero-performance
    status: text('status').notNull().default('success'),
  },
  (table) => [
    index('idx_snapshots_post').on(table.post_id),
    index('idx_snapshots_type').on(table.snapshot_type),
  ],
);

/**
 * content_lifecycle - Full lifecycle tracking from collection to revenue.
 */
export const contentLifecycle = pgTable(
  'content_lifecycle',
  {
    id: text('id').primaryKey(),

    // 1. Collection stage
    source_post_id: text('source_post_id').notNull(),
    source_channel_id: text('source_channel_id').notNull(),
    source_engagement: real('source_engagement').notNull().default(0),
    source_relevance: real('source_relevance').notNull().default(0),

    // 2. Analysis stage
    extracted_need: text('extracted_need').notNull(),
    need_category: text('need_category').notNull(),
    need_confidence: real('need_confidence').notNull().default(0),

    // 3. Matching stage
    matched_product_id: text('matched_product_id').notNull(),
    match_relevance: real('match_relevance').notNull().default(0),

    // 4. Content stage
    content_text: text('content_text').notNull(),
    content_style: text('content_style').notNull(),
    hook_type: text('hook_type').notNull(),

    // 5. Publishing stage
    posted_account_id: text('posted_account_id').notNull(),
    posted_at: timestamp('posted_at', { withTimezone: true }),
    threads_post_id: text('threads_post_id'),
    threads_post_url: text('threads_post_url'),

    // 6. Performance (aggregated from snapshots)
    maturity: postMaturityEnum('maturity').notNull().default('warmup'),
    current_impressions: integer('current_impressions').notNull().default(0),
    current_clicks: integer('current_clicks').notNull().default(0),
    current_conversions: integer('current_conversions').notNull().default(0),
    current_revenue: real('current_revenue').notNull().default(0),

    // 7. Diagnosis
    diagnosis: text('diagnosis'), // collection_weak, analysis_wrong, etc.
    diagnosed_at: timestamp('diagnosed_at', { withTimezone: true }),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_lifecycle_source_post').on(table.source_post_id),
    index('idx_lifecycle_product').on(table.matched_product_id),
    index('idx_lifecycle_account').on(table.posted_account_id),
    index('idx_lifecycle_maturity').on(table.maturity),
  ],
);

/**
 * diagnosis_reports - Weekly/monthly diagnosis results.
 */
export const diagnosisReports = pgTable(
  'diagnosis_reports',
  {
    id: text('id').primaryKey(),
    report_type: reportTypeEnum('report_type').notNull(),
    period_start: timestamp('period_start', { withTimezone: true }).notNull(),
    period_end: timestamp('period_end', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // Cohort stats
    total_posts: integer('total_posts').notNull().default(0),
    top_10_percent_count: integer('top_10_percent_count').notNull().default(0),
    bottom_10_percent_count: integer('bottom_10_percent_count').notNull().default(0),

    // Stage-level metric summaries
    avg_source_engagement: real('avg_source_engagement').notNull().default(0),
    avg_need_confidence: real('avg_need_confidence').notNull().default(0),
    avg_ctr: real('avg_ctr').notNull().default(0),
    avg_conversion_rate: real('avg_conversion_rate').notNull().default(0),
    avg_revenue_per_post: real('avg_revenue_per_post').notNull().default(0),

    // Bottleneck diagnosis
    bottleneck: diagnosisBottleneckEnum('bottleneck').notNull().default('none'),
    bottleneck_evidence: text('bottleneck_evidence').notNull().default(''),

    // AI analysis result (TOP/BOTTOM comparison)
    ai_analysis: text('ai_analysis'),
  },
);

/**
 * tuning_actions - Tuning action log linked to diagnosis reports.
 */
export const tuningActions = pgTable(
  'tuning_actions',
  {
    id: text('id').primaryKey(),
    report_id: text('report_id').notNull(),
    target: tuningTargetEnum('target').notNull(),
    action: text('action').notNull(),
    priority: tuningPriorityEnum('priority').notNull(),
    applied: boolean('applied').notNull().default(false),
    applied_at: timestamp('applied_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_tuning_report').on(table.report_id),
  ],
);

/**
 * crawl_sessions - Crawl session state (maps to checkpoint JSON).
 */
/**
 * thread_comments - 포스트 댓글 별도 저장. 제품 언급 추적 + 전환율 추정용.
 */
export const threadComments = pgTable(
  'thread_comments',
  {
    comment_id: text('comment_id').primaryKey(),
    post_id: text('post_id').notNull(),
    author: text('author').notNull(),
    text: text('text').notNull(),
    view_count: integer('view_count'),
    like_count: integer('like_count').notNull().default(0),
    has_affiliate_link: boolean('has_affiliate_link').notNull().default(false),
    affiliate_platform: text('affiliate_platform'), // 'coupang', 'naver', 'ali' etc
    mentioned_product: text('mentioned_product'), // 댓글에서 언급된 제품명
    is_our_comment: boolean('is_our_comment').notNull().default(false), // 우리 계정(@duribeon231) 댓글
    crawl_at: timestamp('crawl_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_comments_post').on(table.post_id),
    index('idx_comments_author').on(table.author),
    index('idx_comments_product').on(table.mentioned_product),
    index('idx_comments_our').on(table.is_our_comment),
  ],
);

export const crawlSessions = pgTable(
  'crawl_sessions',
  {
    run_id: text('run_id').primaryKey(),
    target_channels: integer('target_channels').notNull(),
    target_posts_per_channel: integer('target_posts_per_channel').notNull(),
    channels_completed: jsonb('channels_completed').$type<Array<{
      channel_id: string;
      threads_collected: number;
      session: number;
    }>>().default([]),
    channels_queue: jsonb('channels_queue').$type<string[]>().default([]),
    channels_discovered: jsonb('channels_discovered').$type<string[]>().default([]),
    current_channel: text('current_channel'),
    current_channel_posts: jsonb('current_channel_posts').$type<string[]>().default([]),
    total_threads_collected: integer('total_threads_collected').notNull().default(0),
    total_sheets_rows: integer('total_sheets_rows').notNull().default(0),
    session_count: integer('session_count').notNull().default(0),
    browser_ops_this_session: integer('browser_ops_this_session').notNull().default(0),
    blocked_channels: jsonb('blocked_channels').$type<string[]>().default([]),
    status: crawlStatusEnum('status').notNull().default('running'),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ---------------------------------------------------------------------------
// Brand Research
// ---------------------------------------------------------------------------

/**
 * brands - 모니터링 대상 브랜드/제품.
 * 리서치 에이전트가 병렬로 이벤트/신제품/할인을 조사.
 */
export const brands = pgTable(
  'brands',
  {
    brand_id: text('brand_id').primaryKey(),           // 'brand_nivea', 'brand_anua'
    name: text('name').notNull(),                       // '니베아', '아누아'
    category: text('category').notNull(),               // '스킨케어', '영양제', '생활용품'
    subcategory: text('subcategory'),                   // '선크림', '비타민C'

    // 검색용
    search_keywords: jsonb('search_keywords').$type<string[]>().default([]),  // ['니베아 선크림', '니베아 바디로션']
    search_templates: jsonb('search_templates').$type<string[]>().default([]), // ['{name} 신제품', '{name} 할인']
    related_channels: jsonb('related_channels').$type<string[]>().default([]), // ['@yaksamom']

    // 제휴 정보
    coupang_link: text('coupang_link'),
    commission_rate: real('commission_rate'),            // 0.03 = 3%
    price_range: text('price_range'),                   // '10000-30000'

    // 상태
    is_active: boolean('is_active').notNull().default(true),
    priority: integer('priority').notNull().default(0),  // 높을수록 우선 분석
    notes: text('notes'),

    last_researched_at: timestamp('last_researched_at', { withTimezone: true }),
    last_research_status: text('last_research_status'),   // 'found_3' | 'no_events' | 'error: ...'
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_brands_category').on(table.category),
    index('idx_brands_active').on(table.is_active),
  ],
);

/**
 * brand_events - 브랜드 리서치 결과 (신제품, 할인, 팝업, 이벤트).
 * 리서치 에이전트가 웹 검색 → 이벤트 추출 → 여기에 저장.
 * 중복 체크: pg_trgm similarity(title) > 0.4 within 7 days.
 */
export const brandEvents = pgTable(
  'brand_events',
  {
    event_id: text('event_id').primaryKey(),
    brand_id: text('brand_id').notNull(),               // brands FK

    event_type: text('event_type').notNull(),            // 'new_product' | 'sale' | 'popup' | 'event' | 'collab'
    title: text('title').notNull(),                      // '아누아 어성초 라인 2세대 출시'
    summary: text('summary').notNull(),                  // 1-2문장 요약
    source_url: text('source_url'),                      // 출처 URL
    source_title: text('source_title'),                  // 출처 제목

    // 콘텐츠 적합성 (에이전트 평가)
    threads_relevance: integer('threads_relevance').notNull().default(0), // 1-5 (포스트 소재 적합도)
    suggested_angle: text('suggested_angle'),            // '비교형: 1세대 vs 2세대 차이점'
    urgency: text('urgency').notNull().default('medium'), // 'high' | 'medium' | 'low'

    // 날짜 관리
    event_date: timestamp('event_date', { withTimezone: true }), // 이벤트 실제 발생/시작일
    expires_at: timestamp('expires_at', { withTimezone: true }),  // 이벤트 종료일
    discovered_at: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    is_stale: boolean('is_stale').notNull().default(false),      // 30일+ 경과 자동 마킹
    is_used: boolean('is_used').notNull().default(false),         // 포스트에 활용했는지
  },
  (table) => [
    index('idx_brand_events_brand').on(table.brand_id),
    index('idx_brand_events_type').on(table.event_type),
    index('idx_brand_events_relevance').on(table.threads_relevance),
    index('idx_brand_events_used').on(table.is_used),
    index('idx_brand_events_date').on(table.event_date),
    index('idx_brand_events_stale').on(table.is_stale),
  ],
);

/**
 * daily_performance_reports - 일일 성과분석 리포트.
 * Claude Code가 매일 포스트 성과를 분석하여 패턴/추천을 저장.
 */
export const dailyPerformanceReports = pgTable(
  'daily_performance_reports',
  {
    id: text('id').primaryKey(),
    report_date: timestamp('report_date', { mode: 'date' }).notNull().unique(),

    // 포스트 현황
    total_posts: integer('total_posts').notNull().default(0),
    new_posts_today: integer('new_posts_today').notNull().default(0),

    // 절대 지표 요약 (당일 스냅샷 기준)
    total_views: integer('total_views').notNull().default(0),
    total_likes: integer('total_likes').notNull().default(0),
    total_comments: integer('total_comments').notNull().default(0),
    total_reposts: integer('total_reposts').notNull().default(0),
    avg_engagement_rate: real('avg_engagement_rate').notNull().default(0),

    // 최고/최저 포스트
    top_post_id: text('top_post_id'),
    top_post_views: integer('top_post_views').default(0),
    top_post_text: text('top_post_text'),
    worst_post_id: text('worst_post_id'),
    worst_post_views: integer('worst_post_views').default(0),

    // 성장 추이
    views_growth_pct: real('views_growth_pct').default(0),
    likes_growth_pct: real('likes_growth_pct').default(0),

    // Claude Code 분석 결과 (JSON)
    content_analysis: jsonb('content_analysis'),
    recommendations: jsonb('recommendations'),
    raw_post_data: jsonb('raw_post_data'),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * source_performance - 소스별 성과 집계 (주기적 스냅샷).
 */
export const sourcePerformance = pgTable(
  'source_performance',
  {
    id: text('id').primaryKey(),
    period_start: timestamp('period_start', { withTimezone: true }).notNull(),
    period_end: timestamp('period_end', { withTimezone: true }).notNull(),
    source: postSourceEnum('source').notNull(),
    brand_id: text('brand_id'),                          // brand 소스인 경우

    // 퍼널 지표
    posts_collected: integer('posts_collected').notNull().default(0),
    posts_analyzed: integer('posts_analyzed').notNull().default(0),
    needs_detected: integer('needs_detected').notNull().default(0),
    contents_generated: integer('contents_generated').notNull().default(0),
    contents_posted: integer('contents_posted').notNull().default(0),

    // 성과 지표
    avg_likes: real('avg_likes').notNull().default(0),
    avg_replies: real('avg_replies').notNull().default(0),
    avg_views: real('avg_views').notNull().default(0),
    avg_engagement_rate: real('avg_engagement_rate').notNull().default(0),
    total_clicks: integer('total_clicks').notNull().default(0),
    total_revenue: real('total_revenue').notNull().default(0),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_source_perf_source').on(table.source),
    index('idx_source_perf_period').on(table.period_start),
  ],
);

// ---------------------------------------------------------------------------
// YouTube Channels & Videos
// ---------------------------------------------------------------------------

export const youtubeChannels = pgTable(
  'youtube_channels',
  {
    channel_id: text('channel_id').primaryKey(),
    name: text('name').notNull(),
    handle: text('handle'),
    subscriber_count: integer('subscriber_count').default(0),
    description: text('description'),
    category: text('category').notNull().default('뷰티'),
    recent_video_count: integer('recent_video_count').default(0),
    sample_titles: jsonb('sample_titles').$type<string[]>().default([]),
    is_active: boolean('is_active').notNull().default(true),
    discovered_at: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    last_checked_at: timestamp('last_checked_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (table) => [
    index('idx_yt_channels_category').on(table.category),
    index('idx_yt_channels_active').on(table.is_active),
  ],
);

export const youtubeVideos = pgTable(
  'youtube_videos',
  {
    id: text('id').primaryKey(),
    channel_id: text('channel_id').notNull(),
    video_id: text('video_id'),
    title: text('title'),
    transcript: text('transcript'),
    comments: jsonb('comments').$type<Array<{
      nickname?: string;
      text?: string;
      like_count?: number;
    }>>().default([]),
    view_count: integer('view_count').default(0),
    like_count: integer('like_count').default(0),
    comment_count: integer('comment_count').default(0),
    published_at: timestamp('published_at', { withTimezone: true }),
    collected_at: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
    analyzed: boolean('analyzed').notNull().default(false),
    extracted_needs: jsonb('extracted_needs').$type<string[]>().default([]),
    source_url: text('source_url'),
  },
  (table) => [
    index('idx_yt_videos_channel').on(table.channel_id),
    index('idx_yt_videos_analyzed').on(table.analyzed),
    index('idx_yt_videos_collected').on(table.collected_at),
  ],
);

// ---------------------------------------------------------------------------
// Community Posts (네이버 카페 + 더쿠 + 인스티즈 통합)
// ---------------------------------------------------------------------------

export const sourcePlatformEnum = pgEnum('source_platform', [
  'naver_cafe',
  'naver_blog',
  'theqoo',
  'instiz',
  'youtube',
]);

/**
 * community_posts - 외부 커뮤니티 수집 포스트 (니즈 발굴용).
 * source_platform으로 플랫폼 구분, source_cafe로 세부 소스 구분.
 */
export const communityPosts = pgTable(
  'community_posts',
  {
    id: text('id').primaryKey(),
    source_platform: sourcePlatformEnum('source_platform').notNull(),
    source_cafe: text('source_cafe'),           // 'cosmania', 'theqoo_hot' 등
    source_url: text('source_url'),
    title: text('title'),
    body: text('body'),
    comments: jsonb('comments').$type<Array<{
      nickname?: string;
      text?: string;
      like_count?: number;
    }>>().default([]),
    author_nickname: text('author_nickname'),
    like_count: integer('like_count').notNull().default(0),
    comment_count: integer('comment_count').notNull().default(0),
    view_count: integer('view_count').notNull().default(0),
    posted_at: timestamp('posted_at', { withTimezone: true }),
    collected_at: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
    analyzed: boolean('analyzed').notNull().default(false),
    extracted_needs: jsonb('extracted_needs').$type<string[]>().default([]),
  },
  (table) => [
    index('idx_community_posts_platform').on(table.source_platform),
    index('idx_community_posts_cafe').on(table.source_cafe),
    index('idx_community_posts_analyzed').on(table.analyzed),
    index('idx_community_posts_collected').on(table.collected_at),
  ],
);

// ---------------------------------------------------------------------------
// Agent Messages (AI Company Communication)
// ---------------------------------------------------------------------------

/**
 * agent_messages - AI 에이전트 간 메시지 채널.
 * CEO/에이전트 간 standup, general 등 채널 기반 소통.
 */
export const agentMessages = pgTable(
  'agent_messages',
  {
    id: text('id').primaryKey(),
    sender: text('sender').notNull(),
    recipient: text('recipient').notNull(),
    channel: text('channel').notNull(),
    message: text('message').notNull(),
    context: jsonb('context'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    read_by: jsonb('read_by').notNull().default([]),
    message_type: text('message_type').default('report'),
    // 'report' | 'directive' | 'feedback' | 'handoff' | 'alert' | 'simulation'
    // + 'task_assign' | 'task_result' | 'qa_request' | 'approval_request' | 'knowledge_update'
    task_id: text('task_id'),
    // 같은 daily-run 실행의 메시지를 묶는 ID (예: 'daily-20260323')
    room_id: text('room_id'),
    // 회의방 ID — 회의 메시지 그루핑 (v2 추가)
    reply_to: text('reply_to'),
    // 답장 대상 메시지 ID (Phase 4 chat)
    payload: jsonb('payload'),
    // 구조화된 데이터: {post_ids, scores, reasons, ...}
    // message_type별 payload 스키마:
    // 'task_assign': {task_id, priority, deadline}
    // 'task_result': {task_id, status, output_data}
    // 'qa_request': {post_id, issues}
    // 'approval_request': {item_type, item_id}
    mentions: jsonb('mentions').$type<string[]>().default([]),
    // @멘션된 에이전트 ID 목록 (Phase 4 chat)
  },
  (table) => [
    index('idx_agent_msg_date').on(table.created_at),
    index('idx_agent_msg_channel').on(table.channel),
    index('idx_agent_msg_sender').on(table.sender),
    index('idx_agent_messages_task_id').on(table.task_id),
    index('idx_agent_messages_type').on(table.message_type),
    index('idx_agent_messages_room').on(table.room_id),
  ],
);

// ---------------------------------------------------------------------------
// Experiments (autoresearch)
// ---------------------------------------------------------------------------

/**
 * experiments - A/B 실험 추적. 훅/포맷/시간대 최적화 실험.
 * CEO가 daily_directive에서 실험 배정, 48h 후 평가.
 */
export const experiments = pgTable(
  'experiments',
  {
    id: text('id').primaryKey(),
    hypothesis: text('hypothesis').notNull(),
    variable: text('variable').notNull(),      // '훅 스타일' | '포맷' | '시간대'
    variant_a: text('variant_a').notNull(),
    variant_b: text('variant_b').notNull(),
    post_id_a: text('post_id_a'),
    post_id_b: text('post_id_b'),
    start_date: timestamp('start_date', { withTimezone: true }).notNull().defaultNow(),
    end_date: timestamp('end_date', { withTimezone: true }),
    status: text('status').notNull().default('active'),   // 'active' | 'closed'
    verdict: text('verdict'),                             // 'variant_a_wins' | 'variant_b_wins' | 'no_difference'
    confidence: text('confidence').notNull().default('directional'), // 'directional' | 'replicated'
    results: jsonb('results'),
    created_by: text('created_by').notNull().default('minjun-ceo'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    autonomy_level: integer('autonomy_level').notNull().default(0), // 0=manual,1=low,2=medium,3=high-risk-only
  },
  (table) => [
    index('idx_experiments_status').on(table.status),
    index('idx_experiments_variable').on(table.variable),
    index('idx_experiments_created').on(table.created_at),
  ],
);

/**
 * revenue_tracking - 클릭/구매/수익 추적.
 * 워밍업 완료(100포스트) 후 제휴 링크 포함 콘텐츠 발행 시 활성화.
 */
export const revenueTracking = pgTable(
  'revenue_tracking',
  {
    id: text('id').primaryKey(),
    post_id: text('post_id').notNull(),
    product_id: text('product_id'),
    coupang_link: text('coupang_link'),
    click_count: integer('click_count').notNull().default(0),
    purchase_count: integer('purchase_count').notNull().default(0),
    revenue: numeric('revenue', { precision: 10, scale: 2 }).notNull().default('0'),
    commission: numeric('commission', { precision: 10, scale: 2 }).notNull().default('0'),
    tracked_date: date('tracked_date').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_revenue_post').on(table.post_id),
    index('idx_revenue_date').on(table.tracked_date),
  ],
);

// ---------------------------------------------------------------------------
// AI Company v2 — 6 신규 테이블
// ---------------------------------------------------------------------------

/**
 * agents - 에이전트 레지스트리 (대시보드 연동).
 * 11명 시딩: seed-agents.ts 참조.
 */
export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    department: text('department').notNull(),
    team: text('team'),
    is_team_lead: boolean('is_team_lead').notNull().default(false),
    personality: jsonb('personality'),
    avatar_color: text('avatar_color'),
    status: text('status').notNull().default('idle'),
    // 'idle' | 'active' | 'standby'
    agent_file: text('agent_file'),
    // 예: '.claude/agents/bini-beauty-editor.md'
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * agent_memories - 에이전트 의미 기억 (Semantic Memory).
 * 랭킹 공식: recency×0.4 + importance×0.4 + scope_match×0.2
 */
export const agentMemories = pgTable(
  'agent_memories',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    agent_id: text('agent_id').notNull(),
    scope: text('scope').notNull(),
    // 'global' | 'marketing' | 'analysis' | 'private'
    memory_type: text('memory_type').notNull(),
    // 'pattern' | 'insight' | 'rule' | 'fact'
    content: text('content').notNull(),
    importance: real('importance').notNull().default(0.5),
    source: text('source'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_memories_agent_scope').on(table.agent_id, table.scope),
    index('idx_memories_global').on(table.scope),
  ],
);

/**
 * agent_episodes - 에피소드 기억 (pipeline_run 통합 — M7).
 * event_type: 'decision' | 'experiment' | 'meeting' | 'post' | 'error' | 'pipeline_run'
 */
export const agentEpisodes = pgTable(
  'agent_episodes',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    agent_id: text('agent_id').notNull(),
    event_type: text('event_type').notNull(),
    summary: text('summary').notNull(),
    details: jsonb('details'),
    // pipeline_run 시: {phases_completed, gate_failures, errors}
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_episodes_agent').on(table.agent_id, table.occurred_at),
    index('idx_episodes_pipeline').on(table.event_type),
  ],
);

/**
 * strategy_archive - 전략 버전 관리 + 롤백.
 * CEO 전용 태그: [CREATE_STRATEGY_VERSION]
 */
export const strategyArchive = pgTable(
  'strategy_archive',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    version: text('version').notNull(),
    parent_version: text('parent_version'),
    strategy: jsonb('strategy').notNull(),
    // {category_ratio, time_slots, experiments, categories[], ...}
    performance: jsonb('performance'),
    // {avg_roi, avg_views, revenue_target, revenue_actual}
    status: text('status').notNull().default('active'),
    // 'active' | 'archived' | 'rolled_back'
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    evaluated_at: timestamp('evaluated_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_archive_status').on(table.status, table.created_at),
    uniqueIndex('idx_archive_version').on(table.version),
  ],
);

/**
 * meetings - 회의 메타데이터 (자유토론 세션).
 * room_id는 agent_messages.room_id와 연결.
 */
export const meetings = pgTable(
  'meetings',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    room_name: text('room_name').notNull(),
    meeting_type: text('meeting_type').notNull(),
    // 'standup' | 'strategy' | 'review' | 'debate'
    agenda: text('agenda'),
    participants: jsonb('participants').$type<string[]>().default([]),
    status: text('status').notNull().default('active'),
    // 'active' | 'concluded'
    decisions: jsonb('decisions'),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    concluded_at: timestamp('concluded_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_meetings_status').on(table.status, table.created_at),
  ],
);

/**
 * pending_approvals - 시훈(오너) 승인 대기 항목.
 * approval_type: 'ops_change' | 'new_agent' | 'system_change' | 'rollback' | 'budget' | 'new_category'
 */
export const pendingApprovals = pgTable(
  'pending_approvals',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    requested_by: text('requested_by').notNull(),
    approval_type: text('approval_type').notNull(),
    description: text('description').notNull(),
    details: jsonb('details'),
    status: text('status').notNull().default('pending'),
    // 'pending' | 'approved' | 'rejected'
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_approvals_status').on(table.status, table.created_at),
  ],
);

// ---------------------------------------------------------------------------
// 온톨로지 그래프 (OpenCrab 5-공간)
// ---------------------------------------------------------------------------

export const ontologySpaceEnum = pgEnum('ontology_space', [
  'evidence', 'concept', 'resource', 'outcome', 'lever'
]);

/**
 * ontology_nodes - 온톨로지 그래프 노드 (OpenCrab 5-공간).
 * space: evidence(포스트), concept(니즈), resource(상품), outcome(성과), lever(실험변수)
 */
export const ontologyNodes = pgTable(
  'ontology_nodes',
  {
    id: text('id').primaryKey(),                    // UUID
    space: ontologySpaceEnum('space').notNull(),     // 5-공간 중 하나
    node_type: text('node_type').notNull(),          // "Post", "Need", "Product", "KPI", "Variable"
    label: text('label').notNull(),                  // 사람이 읽는 이름
    properties: jsonb('properties').$type<Record<string, unknown>>().default({}),
    status: text('status').notNull().default('active'), // active, archived
    created_at: timestamp('created_at').notNull().defaultNow(),
    source_id: text('source_id'),                    // 원본 테이블의 ID (thread_posts.post_id 등)
    source_table: text('source_table'),              // "thread_posts", "needs", "products" 등
  },
  (table) => [
    index('idx_onto_nodes_space').on(table.space),
    index('idx_onto_nodes_source').on(table.source_table, table.source_id),
  ],
);

export const ontologyRelationEnum = pgEnum('ontology_relation', [
  'mentions', 'supports', 'contradicts', 'solves',
  'contributes_to', 'related_to', 'affects', 'measures'
]);

/**
 * ontology_edges - 온톨로지 그래프 엣지 (관계).
 * relation: mentions, supports, contradicts, solves, contributes_to, related_to, affects, measures
 */
export const ontologyEdges = pgTable(
  'ontology_edges',
  {
    id: text('id').primaryKey(),                     // UUID
    from_id: text('from_id').notNull(),              // ontology_nodes.id
    relation: ontologyRelationEnum('relation').notNull(),
    to_id: text('to_id').notNull(),                  // ontology_nodes.id
    properties: jsonb('properties').$type<Record<string, unknown>>().default({}),
    strength: real('strength').default(0.5),          // 0-1 관계 강도
    created_at: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_onto_edges_from').on(table.from_id),
    index('idx_onto_edges_to').on(table.to_id),
    index('idx_onto_edges_relation').on(table.relation),
  ],
);

// ---------------------------------------------------------------------------
// Chat System (Phase 4)
// ---------------------------------------------------------------------------

/**
 * chat_rooms - 채팅방 메타데이터 (DM, 회의, 공지, 오너, 팀).
 * Phase 4 에이전트 간 자율 소통 인프라.
 */
export const chatRooms = pgTable(
  'chat_rooms',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    // 'dm' | 'meeting' | 'announcement' | 'owner' | 'team'
    status: text('status').notNull().default('active'),
    // 'active' | 'archived'
    created_by: text('created_by').notNull(),
    meeting_id: text('meeting_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    last_message_at: timestamp('last_message_at', { withTimezone: true }),
    message_count: integer('message_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_chat_rooms_type').on(table.type),
    index('idx_chat_rooms_status').on(table.status),
    index('idx_chat_rooms_last_msg').on(table.last_message_at),
  ],
);

/**
 * chat_participants - 채팅방 참여자 목록.
 * left_at이 NULL이면 현재 참여 중.
 */
export const chatParticipants = pgTable(
  'chat_participants',
  {
    id: text('id').primaryKey(),
    room_id: text('room_id').notNull(),
    agent_id: text('agent_id').notNull(),
    role: text('role').notNull().default('member'),
    // 'owner' | 'admin' | 'member'
    joined_at: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    left_at: timestamp('left_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_chat_participants_room').on(table.room_id),
    index('idx_chat_participants_agent').on(table.agent_id),
  ],
);

// ---------------------------------------------------------------------------
// Phase 2-A — 구조화된 업무 할당 + 프롬프트 버전 관리 + 시스템 상태
// ---------------------------------------------------------------------------

/**
 * agent_tasks — 구조화된 업무 할당.
 * status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
 */
export const agentTasks = pgTable('agent_tasks', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  title: text('title').notNull(),
  description: text('description'),
  assigned_to: text('assigned_to').notNull(),
  assigned_by: text('assigned_by').notNull(),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(5),
  input_data: jsonb('input_data'),
  output_data: jsonb('output_data'),
  depends_on: jsonb('depends_on').$type<string[]>().default([]),
  deadline: timestamp('deadline', { withTimezone: true }),
  started_at: timestamp('started_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_agent_tasks_assigned').on(table.assigned_to),
  index('idx_agent_tasks_status').on(table.status),
]);

/**
 * agent_prompt_versions — 프롬프트 버전 관리.
 * 에이전트별 프롬프트 이력 + 성과 스코어 + 활성 버전 관리.
 */
export const agentPromptVersions = pgTable('agent_prompt_versions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  agent_id: text('agent_id').notNull(),
  version: integer('version').notNull(),
  prompt_text: text('prompt_text').notNull(),
  performance_score: real('performance_score'),
  eval_data: jsonb('eval_data'),
  is_active: boolean('is_active').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_prompt_agent_version').on(table.agent_id, table.version),
  index('idx_prompt_active').on(table.agent_id, table.is_active),
]);

/**
 * system_state — 시스템 상태 key-value 스토어.
 * 워밍업 상태, 파이프라인 플래그, 설정값 등을 저장.
 */
export const systemState = pgTable('system_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updated_by: text('updated_by'),
});
