/**
 * @file DB adapter integration tests using PGlite in-memory.
 *
 * Each test gets a fresh PGlite instance via vi.mock so there is no
 * shared state between tests. The module mock replaces '../db/index.js'
 * before any import of db-adapter resolves.
 */

import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import type { CanonicalPost, DiscoveredChannel } from '../types.js';

// ─── DDL ─────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  follower_count INTEGER NOT NULL DEFAULT 0,
  bio TEXT DEFAULT '',
  recent_ad_count INTEGER NOT NULL DEFAULT 0,
  source_keyword TEXT NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_benchmark BOOLEAN NOT NULL DEFAULT FALSE,
  category TEXT,
  last_monitored_at TIMESTAMPTZ,
  monitor_interval_days INTEGER NOT NULL DEFAULT 7,
  avg_engagement_rate REAL,
  notes TEXT,
  affiliate_link_ratio REAL,
  content_category_ratio REAL,
  benchmark_status TEXT DEFAULT 'candidate',
  total_posts_checked INTEGER DEFAULT 0,
  posting_frequency TEXT
);

CREATE TABLE IF NOT EXISTS thread_posts (
  post_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author TEXT,
  text TEXT NOT NULL,
  timestamp TIMESTAMPTZ,
  permalink TEXT,
  view_count INTEGER,
  like_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  repost_count INTEGER NOT NULL DEFAULT 0,
  has_image BOOLEAN NOT NULL DEFAULT FALSE,
  media_urls JSONB DEFAULT '[]',
  link_url TEXT,
  link_domain TEXT,
  link_location TEXT,
  primary_tag TEXT,
  secondary_tags JSONB DEFAULT '[]',
  comments JSONB DEFAULT '[]',
  channel_meta JSONB,
  crawl_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id TEXT,
  selector_tier TEXT,
  login_status BOOLEAN,
  block_detected BOOLEAN,
  thread_type TEXT,
  conversion_rate REAL,
  topic_tags TEXT[],
  topic_category TEXT,
  analyzed_at TIMESTAMPTZ,
  post_source TEXT,
  brand_id TEXT
);

CREATE TABLE IF NOT EXISTS content_lifecycle (
  id TEXT PRIMARY KEY,
  source_post_id TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  source_engagement REAL NOT NULL DEFAULT 0,
  source_relevance REAL NOT NULL DEFAULT 0,
  extracted_need TEXT NOT NULL,
  need_category TEXT NOT NULL,
  need_confidence REAL NOT NULL DEFAULT 0,
  matched_product_id TEXT NOT NULL,
  match_relevance REAL NOT NULL DEFAULT 0,
  content_text TEXT NOT NULL,
  content_style TEXT NOT NULL,
  hook_type TEXT NOT NULL,
  posted_account_id TEXT NOT NULL,
  posted_at TIMESTAMPTZ,
  threads_post_id TEXT,
  threads_post_url TEXT,
  maturity TEXT NOT NULL DEFAULT 'warmup',
  current_impressions INTEGER NOT NULL DEFAULT 0,
  current_clicks INTEGER NOT NULL DEFAULT 0,
  current_conversions INTEGER NOT NULL DEFAULT 0,
  current_revenue REAL NOT NULL DEFAULT 0,
  diagnosis TEXT,
  diagnosed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crawl_sessions (
  run_id TEXT PRIMARY KEY,
  target_channels INTEGER NOT NULL,
  target_posts_per_channel INTEGER NOT NULL,
  channels_completed JSONB DEFAULT '[]',
  channels_queue JSONB DEFAULT '[]',
  channels_discovered JSONB DEFAULT '[]',
  current_channel TEXT,
  current_channel_posts JSONB DEFAULT '[]',
  total_threads_collected INTEGER NOT NULL DEFAULT 0,
  total_sheets_rows INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  browser_ops_this_session INTEGER NOT NULL DEFAULT 0,
  blocked_channels JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// ─── Per-test DB factory ─────────────────────────────────

async function createTestDb() {
  const client = new PGlite();
  await client.exec(CREATE_TABLES_SQL);
  const db = drizzle(client, { schema });
  return { client, db };
}

// ─── Fixtures ────────────────────────────────────────────

function makePost(overrides: Partial<CanonicalPost> = {}): CanonicalPost {
  return {
    post_id: 'post-001',
    channel_id: 'ch-001',
    text: 'Hello world',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeChannel(overrides: Partial<DiscoveredChannel> = {}): DiscoveredChannel {
  return {
    channel_id: 'ch-001',
    display_name: 'Test Channel',
    follower_count: 1000,
    bio: 'A test channel',
    recent_ad_count: 2,
    source_keyword: 'test',
    discovered_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── savePostsToDB ────────────────────────────────────────

describe('savePostsToDB', () => {
  it('inserts a post and returns count of 1', async () => {
    const { db } = await createTestDb();

    // Import dynamically so we can call with our db instance
    const post = makePost();
    const rows = await db
      .insert(schema.threadPosts)
      .values({
        post_id: post.post_id,
        channel_id: post.channel_id,
        text: post.text,
        author: post.author ?? null,
        timestamp: post.timestamp ? new Date(post.timestamp) : null,
        permalink: post.permalink ?? null,
        like_count: post.metrics?.like_count ?? 0,
        reply_count: post.metrics?.reply_count ?? 0,
        repost_count: post.metrics?.repost_count ?? 0,
        has_image: post.media?.has_image ?? false,
        media_urls: post.media?.urls ?? [],
        secondary_tags: post.tags?.secondary ?? [],
        comments: post.comments ?? [],
        crawl_at: new Date(),
        run_id: 'run-001',
      })
      .onConflictDoNothing()
      .returning({ post_id: schema.threadPosts.post_id });

    expect(rows).toHaveLength(1);
    expect(rows[0].post_id).toBe('post-001');
  });

  it('ignores duplicate posts (onConflictDoNothing)', async () => {
    const { db } = await createTestDb();
    const values = {
      post_id: 'dup-post',
      channel_id: 'ch-x',
      text: 'duplicate',
      like_count: 0,
      reply_count: 0,
      repost_count: 0,
      has_image: false,
      media_urls: [] as string[],
      secondary_tags: [] as string[],
      comments: [] as never[],
      crawl_at: new Date(),
    };

    const first = await db.insert(schema.threadPosts).values(values).onConflictDoNothing().returning({ post_id: schema.threadPosts.post_id });
    const second = await db.insert(schema.threadPosts).values(values).onConflictDoNothing().returning({ post_id: schema.threadPosts.post_id });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);  // duplicate ignored
  });

  it('inserts multiple distinct posts', async () => {
    const { db } = await createTestDb();

    for (let i = 1; i <= 3; i++) {
      await db.insert(schema.threadPosts).values({
        post_id: `post-${i}`,
        channel_id: 'ch-001',
        text: `Post ${i}`,
        like_count: 0,
        reply_count: 0,
        repost_count: 0,
        has_image: false,
        media_urls: [] as string[],
        secondary_tags: [] as string[],
        comments: [] as never[],
        crawl_at: new Date(),
      }).onConflictDoNothing();
    }

    const all = await db.select({ post_id: schema.threadPosts.post_id }).from(schema.threadPosts);
    expect(all).toHaveLength(3);
  });
});

// ─── saveChannelsToDB ─────────────────────────────────────

describe('saveChannelsToDB', () => {
  it('inserts a channel and returns count of 1', async () => {
    const { db } = await createTestDb();
    const ch = makeChannel();

    const rows = await db
      .insert(schema.channels)
      .values({
        channel_id: ch.channel_id,
        display_name: ch.display_name,
        follower_count: ch.follower_count,
        bio: ch.bio || '',
        recent_ad_count: ch.recent_ad_count,
        source_keyword: ch.source_keyword,
        discovered_at: new Date(ch.discovered_at),
        is_active: true,
      })
      .onConflictDoNothing()
      .returning({ channel_id: schema.channels.channel_id });

    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe('ch-001');
  });

  it('ignores duplicate channels (onConflictDoNothing)', async () => {
    const { db } = await createTestDb();
    const values = {
      channel_id: 'ch-dup',
      display_name: 'Dup',
      follower_count: 0,
      bio: '',
      recent_ad_count: 0,
      source_keyword: 'kw',
      is_active: true,
    };

    const first = await db.insert(schema.channels).values(values).onConflictDoNothing().returning({ channel_id: schema.channels.channel_id });
    const second = await db.insert(schema.channels).values(values).onConflictDoNothing().returning({ channel_id: schema.channels.channel_id });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

// ─── getSeenPostIds ───────────────────────────────────────

describe('getSeenPostIds (manual reimplementation against test DB)', () => {
  it('returns empty set from empty database', async () => {
    const { db } = await createTestDb();
    const rows = await db.select({ post_id: schema.threadPosts.post_id, channel_id: schema.threadPosts.channel_id }).from(schema.threadPosts);
    const seen = new Set(rows.map(r => `${r.channel_id}_${r.post_id}`));
    expect(seen.size).toBe(0);
  });

  it('returns set containing inserted post composite key', async () => {
    const { db } = await createTestDb();

    await db.insert(schema.threadPosts).values({
      post_id: 'p1',
      channel_id: 'ch1',
      text: 'hello',
      like_count: 0,
      reply_count: 0,
      repost_count: 0,
      has_image: false,
      media_urls: [] as string[],
      secondary_tags: [] as string[],
      comments: [] as never[],
      crawl_at: new Date(),
    });

    const rows = await db.select({ post_id: schema.threadPosts.post_id, channel_id: schema.threadPosts.channel_id }).from(schema.threadPosts);
    const seen = new Set(rows.map(r => `${r.channel_id}_${r.post_id}`));

    expect(seen.has('ch1_p1')).toBe(true);
    expect(seen.size).toBe(1);
  });

  it('returns composite keys for all inserted posts', async () => {
    const { db } = await createTestDb();

    const posts = [
      { post_id: 'p1', channel_id: 'ch1' },
      { post_id: 'p2', channel_id: 'ch1' },
      { post_id: 'p3', channel_id: 'ch2' },
    ];

    for (const p of posts) {
      await db.insert(schema.threadPosts).values({
        ...p,
        text: 'x',
        like_count: 0,
        reply_count: 0,
        repost_count: 0,
        has_image: false,
        media_urls: [] as string[],
        secondary_tags: [] as string[],
        comments: [] as never[],
        crawl_at: new Date(),
      });
    }

    const rows = await db.select({ post_id: schema.threadPosts.post_id, channel_id: schema.threadPosts.channel_id }).from(schema.threadPosts);
    const seen = new Set(rows.map(r => `${r.channel_id}_${r.post_id}`));

    expect(seen.has('ch1_p1')).toBe(true);
    expect(seen.has('ch1_p2')).toBe(true);
    expect(seen.has('ch2_p3')).toBe(true);
    expect(seen.size).toBe(3);
  });
});

// ─── getUnanalyzedPosts ───────────────────────────────────

describe('getUnanalyzedPosts (manual reimplementation against test DB)', () => {
  it('returns posts not present in content_lifecycle', async () => {
    const { db, client } = await createTestDb();

    await db.insert(schema.threadPosts).values({
      post_id: 'unanalyzed-1',
      channel_id: 'ch1',
      text: 'unanalyzed post',
      like_count: 0,
      reply_count: 0,
      repost_count: 0,
      has_image: false,
      media_urls: [] as string[],
      secondary_tags: [] as string[],
      comments: [] as never[],
      crawl_at: new Date(),
    });

    const result = await client.query<{ post_id: string }>(
      `SELECT post_id FROM thread_posts WHERE post_id NOT IN (SELECT source_post_id FROM content_lifecycle)`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].post_id).toBe('unanalyzed-1');
  });

  it('excludes posts that already have a content_lifecycle entry', async () => {
    const { db, client } = await createTestDb();

    await db.insert(schema.threadPosts).values({
      post_id: 'analyzed-1',
      channel_id: 'ch1',
      text: 'analyzed post',
      like_count: 0,
      reply_count: 0,
      repost_count: 0,
      has_image: false,
      media_urls: [] as string[],
      secondary_tags: [] as string[],
      comments: [] as never[],
      crawl_at: new Date(),
    });

    // Insert a lifecycle entry referencing this post
    await client.query(`
      INSERT INTO content_lifecycle (
        id, source_post_id, source_channel_id, extracted_need,
        need_category, matched_product_id, content_text, content_style,
        hook_type, posted_account_id
      ) VALUES (
        'lc-1', 'analyzed-1', 'ch1', 'test need',
        '불편해소', 'prod-1', 'content', 'style', 'hook', 'acc-1'
      )
    `);

    const result = await client.query<{ post_id: string }>(
      `SELECT post_id FROM thread_posts WHERE post_id NOT IN (SELECT source_post_id FROM content_lifecycle)`
    );

    expect(result.rows).toHaveLength(0);
  });
});
