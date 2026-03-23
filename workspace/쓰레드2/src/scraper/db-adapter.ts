import { db } from '../db/index.js';
import { threadPosts, channels, crawlSessions } from '../db/schema.js';
import { sql } from 'drizzle-orm';
import type { CanonicalPost, DiscoveredChannel, CrawlCheckpoint } from '../types.js';

type ThreadPostRow = typeof threadPosts.$inferSelect;

export async function savePostsToDB(posts: CanonicalPost[], runId: string): Promise<number> {
  let inserted = 0;

  for (const post of posts) {
    try {
      const rows = await db
        .insert(threadPosts)
        .values({
          post_id: post.post_id,
          channel_id: post.channel_id,
          author: post.author ?? null,
          text: post.text,
          timestamp: post.timestamp ? new Date(post.timestamp) : null,
          permalink: post.permalink ?? null,
          view_count: post.metrics?.view_count ?? null,
          like_count: post.metrics?.like_count ?? 0,
          reply_count: post.metrics?.reply_count ?? 0,
          repost_count: post.metrics?.repost_count ?? 0,
          has_image: post.media?.has_image ?? false,
          media_urls: post.media?.urls ?? [],
          link_url: post.link?.url ?? null,
          link_domain: post.link?.domain ?? null,
          link_location: post.link?.location ?? null,
          primary_tag: post.tags?.primary ?? null,
          secondary_tags: post.tags?.secondary ?? [],
          comments: post.comments ?? [],
          channel_meta: post.channel_meta ?? null,
          crawl_at: post.crawl_meta?.crawl_at ? new Date(post.crawl_meta.crawl_at) : new Date(),
          run_id: runId,
          selector_tier: post.crawl_meta?.selector_tier ?? null,
          login_status: post.crawl_meta?.login_status ?? null,
          block_detected: post.crawl_meta?.block_detected ?? null,
          thread_type: post.thread_type ?? null,
          conversion_rate: post.conversion_rate ?? null,
          // Phase 1: topic tags
          topic_tags: post.topic_tags ?? null,
          topic_category: post.topic_category ?? null,
        })
        .onConflictDoUpdate({
          target: threadPosts.post_id,
          set: {
            view_count: sql`COALESCE(EXCLUDED.view_count, ${threadPosts.view_count})`,
            like_count: sql`EXCLUDED.like_count`,
            reply_count: sql`EXCLUDED.reply_count`,
            repost_count: sql`EXCLUDED.repost_count`,
            crawl_at: sql`EXCLUDED.crawl_at`,
            run_id: sql`EXCLUDED.run_id`,
          },
        })
        .returning({ post_id: threadPosts.post_id });

      if (rows.length > 0) {
        inserted++;
      }
    } catch {
      // Skip individual post errors
    }
  }

  return inserted;
}

export async function saveChannelsToDB(channelList: DiscoveredChannel[]): Promise<number> {
  let inserted = 0;

  for (const ch of channelList) {
    try {
      const rows = await db
        .insert(channels)
        .values({
          channel_id: ch.channel_id,
          display_name: ch.display_name,
          follower_count: ch.follower_count,
          bio: ch.bio || '',
          recent_ad_count: ch.recent_ad_count,
          source_keyword: ch.source_keyword,
          discovered_at: ch.discovered_at ? new Date(ch.discovered_at) : new Date(),
          is_active: true,
        })
        .onConflictDoNothing()
        .returning({ channel_id: channels.channel_id });

      if (rows.length > 0) {
        inserted++;
      }
    } catch {
      // Skip individual channel errors
    }
  }

  return inserted;
}

export async function saveCrawlSession(session: CrawlCheckpoint): Promise<void> {
  // Try insert first, then update
  await db
    .insert(crawlSessions)
    .values({
      run_id: session.run_id,
      target_channels: session.target_channels,
      target_posts_per_channel: session.target_posts_per_channel,
      channels_completed: session.channels_completed ?? [],
      channels_queue: session.channels_queue ?? [],
      channels_discovered: session.channels_discovered ?? [],
      current_channel: session.current_channel ?? null,
      current_channel_posts: session.current_channel_posts ?? [],
      total_threads_collected: session.total_threads_collected,
      total_sheets_rows: session.total_sheets_rows ?? 0,
      session_count: session.session_count ?? 1,
      browser_ops_this_session: session.browser_ops_this_session ?? 0,
      blocked_channels: session.blocked_channels ?? [],
      status: session.status,
      updated_at: new Date(),
    })
    .onConflictDoNothing();

  // Always run update to ensure latest state
  await db.execute(sql`
    UPDATE crawl_sessions SET
      target_channels = ${session.target_channels},
      target_posts_per_channel = ${session.target_posts_per_channel},
      channels_completed = ${JSON.stringify(session.channels_completed ?? [])}::jsonb,
      channels_queue = ${JSON.stringify(session.channels_queue ?? [])}::jsonb,
      channels_discovered = ${JSON.stringify(session.channels_discovered ?? [])}::jsonb,
      current_channel = ${session.current_channel ?? null},
      current_channel_posts = ${JSON.stringify(session.current_channel_posts ?? [])}::jsonb,
      total_threads_collected = ${session.total_threads_collected},
      total_sheets_rows = ${session.total_sheets_rows ?? 0},
      session_count = ${session.session_count ?? 1},
      browser_ops_this_session = ${session.browser_ops_this_session ?? 0},
      blocked_channels = ${JSON.stringify(session.blocked_channels ?? [])}::jsonb,
      status = ${session.status},
      updated_at = NOW()
    WHERE run_id = ${session.run_id}
  `);
}

export async function getSeenPostIds(): Promise<Set<string>> {
  const rows = await db
    .select({ post_id: threadPosts.post_id, channel_id: threadPosts.channel_id })
    .from(threadPosts);

  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(`${row.channel_id}_${row.post_id}`);
  }
  return seen;
}

export async function getUnanalyzedPosts(limit?: number): Promise<ThreadPostRow[]> {
  const query = db
    .select()
    .from(threadPosts)
    .where(sql`${threadPosts.post_id} NOT IN (SELECT source_post_id FROM content_lifecycle)`)
    .orderBy(threadPosts.crawl_at);

  if (limit) {
    return query.limit(limit);
  }
  return query;
}
