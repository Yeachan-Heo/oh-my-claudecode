CREATE TYPE "public"."account_status" AS ENUM('active', 'warming_up', 'restricted', 'banned', 'retired');--> statement-breakpoint
CREATE TYPE "public"."affiliate_platform" AS ENUM('coupang_partners', 'naver_smartstore', 'ali_express', 'other');--> statement-breakpoint
CREATE TYPE "public"."competition_level" AS ENUM('상', '중', '하');--> statement-breakpoint
CREATE TYPE "public"."crawl_status" AS ENUM('running', 'paused_context_limit', 'paused_blocked', 'budget_exhausted', 'completed', 'needs_human');--> statement-breakpoint
CREATE TYPE "public"."diagnosis_bottleneck" AS ENUM('collection', 'analysis', 'matching', 'content', 'publishing', 'none');--> statement-breakpoint
CREATE TYPE "public"."needs_category" AS ENUM('불편해소', '시간절약', '돈절약', '성과향상', '외모건강', '자기표현');--> statement-breakpoint
CREATE TYPE "public"."position_format" AS ENUM('문제공감형', '솔직후기형', '비교형', '입문추천형', '실수방지형', '비추천형');--> statement-breakpoint
CREATE TYPE "public"."post_maturity" AS ENUM('warmup', 'early', 'mature', 'final');--> statement-breakpoint
CREATE TYPE "public"."primary_tag" AS ENUM('affiliate', 'purchase_signal', 'review', 'complaint', 'interest', 'general');--> statement-breakpoint
CREATE TYPE "public"."purchase_linkage" AS ENUM('상', '중', '하');--> statement-breakpoint
CREATE TYPE "public"."report_type" AS ENUM('weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."signal_level" AS ENUM('L1', 'L2', 'L3', 'L4', 'L5');--> statement-breakpoint
CREATE TYPE "public"."snapshot_type" AS ENUM('early', 'mature', 'final');--> statement-breakpoint
CREATE TYPE "public"."tuning_priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."tuning_target" AS ENUM('scraper', 'analyzer', 'matcher', 'content_generator', 'publisher');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"status" "account_status" DEFAULT 'warming_up' NOT NULL,
	"proxy_id" text DEFAULT '' NOT NULL,
	"fingerprint_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_posted_at" timestamp with time zone,
	"post_count" integer DEFAULT 0 NOT NULL,
	"ban_count" integer DEFAULT 0 NOT NULL,
	"health_score" integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aff_contents" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"need_id" text NOT NULL,
	"format" "position_format" NOT NULL,
	"hook" text NOT NULL,
	"bodies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hooks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"self_comments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positioning" jsonb,
	"threads_score" jsonb,
	"competition" "competition_level",
	"match_priority" integer,
	"match_why" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"bio" text DEFAULT '',
	"recent_ad_count" integer DEFAULT 0 NOT NULL,
	"source_keyword" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_lifecycle" (
	"id" text PRIMARY KEY NOT NULL,
	"source_post_id" text NOT NULL,
	"source_channel_id" text NOT NULL,
	"source_engagement" real DEFAULT 0 NOT NULL,
	"source_relevance" real DEFAULT 0 NOT NULL,
	"extracted_need" text NOT NULL,
	"need_category" text NOT NULL,
	"need_confidence" real DEFAULT 0 NOT NULL,
	"matched_product_id" text NOT NULL,
	"match_relevance" real DEFAULT 0 NOT NULL,
	"content_text" text NOT NULL,
	"content_style" text NOT NULL,
	"hook_type" text NOT NULL,
	"posted_account_id" text NOT NULL,
	"posted_at" timestamp with time zone,
	"maturity" "post_maturity" DEFAULT 'warmup' NOT NULL,
	"current_impressions" integer DEFAULT 0 NOT NULL,
	"current_clicks" integer DEFAULT 0 NOT NULL,
	"current_conversions" integer DEFAULT 0 NOT NULL,
	"current_revenue" real DEFAULT 0 NOT NULL,
	"diagnosis" text,
	"diagnosed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_sessions" (
	"run_id" text PRIMARY KEY NOT NULL,
	"target_channels" integer NOT NULL,
	"target_posts_per_channel" integer NOT NULL,
	"channels_completed" jsonb DEFAULT '[]'::jsonb,
	"channels_queue" jsonb DEFAULT '[]'::jsonb,
	"channels_discovered" jsonb DEFAULT '[]'::jsonb,
	"current_channel" text,
	"current_channel_posts" jsonb DEFAULT '[]'::jsonb,
	"total_threads_collected" integer DEFAULT 0 NOT NULL,
	"total_sheets_rows" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"browser_ops_this_session" integer DEFAULT 0 NOT NULL,
	"blocked_channels" jsonb DEFAULT '[]'::jsonb,
	"status" "crawl_status" DEFAULT 'running' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnosis_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"report_type" "report_type" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_posts" integer DEFAULT 0 NOT NULL,
	"top_10_percent_count" integer DEFAULT 0 NOT NULL,
	"bottom_10_percent_count" integer DEFAULT 0 NOT NULL,
	"avg_source_engagement" real DEFAULT 0 NOT NULL,
	"avg_need_confidence" real DEFAULT 0 NOT NULL,
	"avg_ctr" real DEFAULT 0 NOT NULL,
	"avg_conversion_rate" real DEFAULT 0 NOT NULL,
	"avg_revenue_per_post" real DEFAULT 0 NOT NULL,
	"bottleneck" "diagnosis_bottleneck" DEFAULT 'none' NOT NULL,
	"bottleneck_evidence" text DEFAULT '' NOT NULL,
	"ai_analysis" text
);
--> statement-breakpoint
CREATE TABLE "needs" (
	"need_id" text PRIMARY KEY NOT NULL,
	"category" "needs_category" NOT NULL,
	"problem" text NOT NULL,
	"representative_expressions" jsonb DEFAULT '[]'::jsonb,
	"signal_strength" "signal_level",
	"post_count" integer DEFAULT 0 NOT NULL,
	"purchase_linkage" "purchase_linkage" NOT NULL,
	"why_linkage" text NOT NULL,
	"product_categories" jsonb DEFAULT '[]'::jsonb,
	"threads_fit" integer DEFAULT 0 NOT NULL,
	"threads_fit_reason" text DEFAULT '' NOT NULL,
	"sample_post_ids" jsonb DEFAULT '[]'::jsonb,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"snapshot_type" "snapshot_type" NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"revenue" real DEFAULT 0 NOT NULL,
	"engagement_velocity" real DEFAULT 0 NOT NULL,
	"click_velocity" real DEFAULT 0 NOT NULL,
	"conversion_velocity" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"product_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"needs_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affiliate_platform" "affiliate_platform" NOT NULL,
	"price_range" text NOT NULL,
	"description" text NOT NULL,
	"affiliate_link" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_posts" (
	"post_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"author" text,
	"text" text NOT NULL,
	"timestamp" timestamp with time zone,
	"permalink" text,
	"view_count" integer,
	"like_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"repost_count" integer DEFAULT 0 NOT NULL,
	"has_image" boolean DEFAULT false NOT NULL,
	"media_urls" jsonb DEFAULT '[]'::jsonb,
	"link_url" text,
	"link_domain" text,
	"link_location" text,
	"primary_tag" "primary_tag",
	"secondary_tags" jsonb DEFAULT '[]'::jsonb,
	"comments" jsonb DEFAULT '[]'::jsonb,
	"channel_meta" jsonb,
	"crawl_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text,
	"selector_tier" text,
	"login_status" boolean,
	"block_detected" boolean,
	"thread_type" text,
	"conversion_rate" real
);
--> statement-breakpoint
CREATE TABLE "tuning_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"target" "tuning_target" NOT NULL,
	"action" text NOT NULL,
	"priority" "tuning_priority" NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_username" ON "accounts" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_aff_contents_product" ON "aff_contents" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_aff_contents_need" ON "aff_contents" USING btree ("need_id");--> statement-breakpoint
CREATE INDEX "idx_channels_keyword" ON "channels" USING btree ("source_keyword");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_source_post" ON "content_lifecycle" USING btree ("source_post_id");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_product" ON "content_lifecycle" USING btree ("matched_product_id");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_account" ON "content_lifecycle" USING btree ("posted_account_id");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_maturity" ON "content_lifecycle" USING btree ("maturity");--> statement-breakpoint
CREATE INDEX "idx_needs_category" ON "needs" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_snapshots_post" ON "post_snapshots" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_snapshots_type" ON "post_snapshots" USING btree ("snapshot_type");--> statement-breakpoint
CREATE INDEX "idx_products_category" ON "products" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_products_platform" ON "products" USING btree ("affiliate_platform");--> statement-breakpoint
CREATE INDEX "idx_posts_channel" ON "thread_posts" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_posts_crawl_at" ON "thread_posts" USING btree ("crawl_at");--> statement-breakpoint
CREATE INDEX "idx_posts_primary_tag" ON "thread_posts" USING btree ("primary_tag");--> statement-breakpoint
CREATE INDEX "idx_tuning_report" ON "tuning_actions" USING btree ("report_id");