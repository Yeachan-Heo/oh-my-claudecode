CREATE TYPE "public"."source_platform" AS ENUM('naver_cafe', 'naver_blog');--> statement-breakpoint
CREATE TABLE "community_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"source_platform" "source_platform" NOT NULL,
	"source_cafe" text NOT NULL,
	"source_url" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"comments" jsonb DEFAULT '[]'::jsonb,
	"author_nickname" text,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"posted_at" timestamp with time zone,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"analyzed" boolean DEFAULT false NOT NULL,
	"extracted_needs" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE TABLE "thread_comments" (
	"comment_id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"view_count" integer,
	"like_count" integer DEFAULT 0 NOT NULL,
	"has_affiliate_link" boolean DEFAULT false NOT NULL,
	"affiliate_platform" text,
	"mentioned_product" text,
	"is_our_comment" boolean DEFAULT false NOT NULL,
	"crawl_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_keywords" (
	"id" text PRIMARY KEY NOT NULL,
	"keyword" text NOT NULL,
	"rank" integer,
	"source" text DEFAULT 'x_trending' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"selected_reason" text,
	"posts_collected" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aff_contents" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "is_benchmark" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_monitored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "monitor_interval_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "avg_engagement_rate" real;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "affiliate_link_ratio" real;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "content_category_ratio" real;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "benchmark_status" text DEFAULT 'candidate';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "total_posts_checked" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "posting_frequency" text;--> statement-breakpoint
ALTER TABLE "content_lifecycle" ADD COLUMN "threads_post_id" text;--> statement-breakpoint
ALTER TABLE "content_lifecycle" ADD COLUMN "threads_post_url" text;--> statement-breakpoint
ALTER TABLE "post_snapshots" ADD COLUMN "post_views" integer;--> statement-breakpoint
ALTER TABLE "post_snapshots" ADD COLUMN "comment_views" integer;--> statement-breakpoint
ALTER TABLE "thread_posts" ADD COLUMN "topic_tags" text[];--> statement-breakpoint
ALTER TABLE "thread_posts" ADD COLUMN "topic_category" text;--> statement-breakpoint
ALTER TABLE "thread_posts" ADD COLUMN "analyzed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_community_posts_platform" ON "community_posts" USING btree ("source_platform");--> statement-breakpoint
CREATE INDEX "idx_community_posts_cafe" ON "community_posts" USING btree ("source_cafe");--> statement-breakpoint
CREATE INDEX "idx_community_posts_analyzed" ON "community_posts" USING btree ("analyzed");--> statement-breakpoint
CREATE INDEX "idx_community_posts_collected_at" ON "community_posts" USING btree ("collected_at");--> statement-breakpoint
CREATE INDEX "idx_comments_post" ON "thread_comments" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_comments_author" ON "thread_comments" USING btree ("author");--> statement-breakpoint
CREATE INDEX "idx_comments_product" ON "thread_comments" USING btree ("mentioned_product");--> statement-breakpoint
CREATE INDEX "idx_comments_our" ON "thread_comments" USING btree ("is_our_comment");--> statement-breakpoint
CREATE INDEX "idx_trend_fetched_at" ON "trend_keywords" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "idx_trend_selected" ON "trend_keywords" USING btree ("selected");--> statement-breakpoint
CREATE INDEX "idx_posts_analyzed_at" ON "thread_posts" USING btree ("analyzed_at");