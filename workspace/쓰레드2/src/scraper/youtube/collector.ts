/**
 * @file YouTube 뷰티 댓글 수집 오케스트레이터.
 *
 * 채널/키워드 → 영상 조회 → 댓글 수집 → community_posts DB 저장.
 * source_platform='youtube', source_cafe='youtube_{handle}'
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { communityPosts } from '../../db/schema.js';
import {
  searchVideos,
  getChannelVideos,
  getVideoDetails,
  getVideoComments,
  getCommentReplies,
  getVideoTranscript,
} from './api.js';
import { SEED_CHANNELS, SEARCH_KEYWORDS, HIGH_NEED_KEYWORDS } from './channels.js';
import type {
  YouTubeChannel,
  YouTubeVideoItem,
  YouTubeVideoStats,
  YouTubeCommentItem,
  YouTubeCollectResult,
  YouTubeCliOptions,
} from './types.js';

// ─── Logging ─────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── DB Helpers ──────────────────────────────────────────

async function getExistingVideoIds(): Promise<Set<string>> {
  const rows = await db
    .select({ id: communityPosts.id })
    .from(communityPosts)
    .where(eq(communityPosts.source_platform, 'youtube'));
  return new Set(rows.map(r => r.id.replace('youtube_', '')));
}

// ─── Video Filtering ─────────────────────────────────────

/**
 * 영상이 수집 기준을 충족하는지 확인.
 */
function isVideoEligible(
  video: YouTubeVideoItem & YouTubeVideoStats,
  startTime: number,
  daysBack: number,
): boolean {
  // 날짜 필터
  const publishedDate = new Date(video.publishedAt);
  const maxAgeMs = daysBack * 24 * 60 * 60 * 1000;
  if (startTime - publishedDate.getTime() > maxAgeMs) return false;

  // 최소 댓글 수
  if (video.commentCount < 5) return false;

  return true;
}

// ─── Save to DB ──────────────────────────────────────────

async function saveToDb(
  video: YouTubeVideoItem & YouTubeVideoStats,
  comments: YouTubeCommentItem[],
  sourceHandle: string,
  transcript?: string,
): Promise<boolean> {
  try {
    const rows = await db
      .insert(communityPosts)
      .values({
        id: `youtube_${video.videoId}`,
        source_platform: 'youtube',
        source_cafe: `youtube_${sourceHandle}`,
        source_url: `https://youtube.com/watch?v=${video.videoId}`,
        title: video.title,
        body: transcript || video.description,
        comments: comments.map(c => ({
          nickname: c.authorName,
          text: c.text,
          like_count: c.likeCount,
        })),
        author_nickname: video.channelTitle,
        like_count: video.likeCount,
        comment_count: video.commentCount,
        view_count: video.viewCount,
        posted_at: new Date(video.publishedAt),
        collected_at: new Date(),
        analyzed: false,
        extracted_needs: [],
      })
      .onConflictDoNothing()
      .returning({ id: communityPosts.id });

    return rows.length > 0;
  } catch (err) {
    log(`    DB 저장 실패 (youtube_${video.videoId}): ${(err as Error).message}`);
    return false;
  }
}

// ─── Collect by Channel ──────────────────────────────────

async function collectFromChannel(
  channel: YouTubeChannel,
  opts: YouTubeCliOptions,
  startTime: number,
  existingIds: Set<string>,
): Promise<{ videos: number; comments: number; inserted: number; duplicate: number; stale: number }> {
  log(`\n▶ 채널: ${channel.name} (${channel.handle})`);

  const result = { videos: 0, comments: 0, inserted: 0, duplicate: 0, stale: 0 };

  // 1. Get recent videos
  const rawVideos = await getChannelVideos(channel.channelId, opts.maxVideosPerChannel, opts.daysBack);
  if (rawVideos.length === 0) {
    log(`  최근 ${opts.daysBack}일 내 영상 없음`);
    return result;
  }

  // 2. Get video details (statistics)
  const videoIds = rawVideos.map(v => v.videoId);
  const videos = await getVideoDetails(videoIds);
  log(`  영상 ${videos.length}개 발견`);

  // 3. Filter & collect
  for (const video of videos) {
    if (!isVideoEligible(video, startTime, opts.daysBack)) {
      result.stale++;
      continue;
    }

    result.videos++;
    log(`  [${result.videos}] ${video.title.slice(0, 50)}... (${video.viewCount}뷰, ${video.commentCount}댓글)`);

    if (existingIds.has(video.videoId)) {
      log(`    이미 수집됨 — 스킵`);
      result.duplicate++;
      continue;
    }

    // 4. Get comments
    let comments: YouTubeCommentItem[] = [];
    try {
      comments = await getVideoComments(video.videoId, opts.maxCommentsPerVideo);
      result.comments += comments.length;
      log(`    댓글 ${comments.length}개 수집`);
    } catch (err) {
      log(`    댓글 수집 실패: ${(err as Error).message}`);
    }

    // 4-1. Collect replies for active discussion threads
    const repliesCollected: YouTubeCommentItem[] = [];
    const activeThreads = comments.filter(c => c.replyCount >= 2);
    for (const thread of activeThreads.slice(0, 10)) {
      try {
        const replies = await getCommentReplies(thread.commentId, 20);
        for (const reply of replies) {
          repliesCollected.push({ ...reply, authorName: `↳ ${reply.authorName}` });
        }
      } catch { /* skip failed reply fetch */ }
    }
    if (repliesCollected.length > 0) {
      comments.push(...repliesCollected);
      result.comments += repliesCollected.length;
      log(`    답글 ${repliesCollected.length}개 추가 수집`);
    }

    // 5. Get transcript (yt-dlp, no API quota)
    let transcript = '';
    try {
      transcript = await getVideoTranscript(video.videoId);
      if (transcript) {
        log(`    대본 ${transcript.length}자 수집`);
      }
    } catch {}

    // 6. Save
    const isNew = await saveToDb(video, comments, channel.handle, transcript);
    if (isNew) {
      result.inserted++;
      log(`    DB 저장 완료`);
    } else {
      result.duplicate++;
      log(`    중복 스킵`);
    }
  }

  return result;
}

// ─── Collect by Search ───────────────────────────────────

async function collectFromSearch(
  query: string,
  opts: YouTubeCliOptions,
  startTime: number,
  existingIds: Set<string>,
): Promise<{ videos: number; comments: number; inserted: number; duplicate: number; stale: number }> {
  log(`\n▶ 검색: "${query}"`);

  const result = { videos: 0, comments: 0, inserted: 0, duplicate: 0, stale: 0 };

  // 1. Search videos
  const rawVideos = await searchVideos(query, opts.maxVideosPerChannel);
  if (rawVideos.length === 0) {
    log(`  검색 결과 없음`);
    return result;
  }

  // 2. Get video details
  const videoIds = rawVideos.map(v => v.videoId);
  const videos = await getVideoDetails(videoIds);
  log(`  영상 ${videos.length}개 발견`);

  // 3. Filter & collect
  for (const video of videos) {
    if (!isVideoEligible(video, startTime, opts.daysBack)) {
      result.stale++;
      continue;
    }

    result.videos++;
    log(`  [${result.videos}] ${video.title.slice(0, 50)}... (${video.viewCount}뷰, ${video.commentCount}댓글)`);

    if (existingIds.has(video.videoId)) {
      log(`    이미 수집됨 — 스킵`);
      result.duplicate++;
      continue;
    }

    let comments: YouTubeCommentItem[] = [];
    try {
      comments = await getVideoComments(video.videoId, opts.maxCommentsPerVideo);
      result.comments += comments.length;
      log(`    댓글 ${comments.length}개 수집`);
    } catch (err) {
      log(`    댓글 수집 실패: ${(err as Error).message}`);
    }

    // Collect replies for active discussion threads
    const repliesCollected: YouTubeCommentItem[] = [];
    const activeThreads = comments.filter(c => c.replyCount >= 2);
    for (const thread of activeThreads.slice(0, 10)) {
      try {
        const replies = await getCommentReplies(thread.commentId, 20);
        for (const reply of replies) {
          repliesCollected.push({ ...reply, authorName: `↳ ${reply.authorName}` });
        }
      } catch { /* skip failed reply fetch */ }
    }
    if (repliesCollected.length > 0) {
      comments.push(...repliesCollected);
      result.comments += repliesCollected.length;
      log(`    답글 ${repliesCollected.length}개 추가 수집`);
    }

    // Get transcript (yt-dlp, no API quota)
    let transcript = '';
    try {
      transcript = await getVideoTranscript(video.videoId);
      if (transcript) {
        log(`    대본 ${transcript.length}자 수집`);
      }
    } catch {}

    const handle = video.channelTitle.replace(/\s+/g, '_');
    const isNew = await saveToDb(video, comments, handle, transcript);
    if (isNew) {
      result.inserted++;
    } else {
      result.duplicate++;
    }
  }

  return result;
}

// ─── Main Collector ──────────────────────────────────────

/**
 * YouTube 뷰티 댓글 수집 메인 함수.
 */
export async function collectYouTube(opts: YouTubeCliOptions): Promise<YouTubeCollectResult> {
  const startTime = Date.now();
  const totals = {
    channelsProcessed: 0,
    videosFound: 0,
    videosCollected: 0,
    commentsCollected: 0,
    postsInserted: 0,
    postsDuplicate: 0,
    stale: 0,
    elapsed: 0,
  };

  log('=== YouTube 뷰티 댓글 수집 시작 ===');

  const existingIds = await getExistingVideoIds();
  log(`기존 수집 영상: ${existingIds.size}개 (중복 스킵 대상)`);

  if (opts.channels === 'search') {
    // 키워드 검색 모드
    const queries = opts.searchQuery ? [opts.searchQuery] : SEARCH_KEYWORDS.slice(0, 5);
    log(`검색 모드: ${queries.length}개 키워드`);

    for (const query of queries) {
      const r = await collectFromSearch(query, opts, startTime, existingIds);
      totals.channelsProcessed++;
      totals.videosCollected += r.videos;
      totals.commentsCollected += r.comments;
      totals.postsInserted += r.inserted;
      totals.postsDuplicate += r.duplicate;
      totals.stale += r.stale;
    }
  } else {
    // 채널 모드
    const allChannels = opts.channels === 'all' ? SEED_CHANNELS : opts.channels;
    const channels = allChannels.slice(opts.fromIndex, opts.toIndex || allChannels.length);
    log(`채널 모드: ${channels.length}개 채널 (인덱스 ${opts.fromIndex}~${opts.toIndex || allChannels.length}), 채널당 최대 ${opts.maxVideosPerChannel}영상`);

    for (const channel of channels) {
      const r = await collectFromChannel(channel, opts, startTime, existingIds);
      totals.channelsProcessed++;
      totals.videosCollected += r.videos;
      totals.commentsCollected += r.comments;
      totals.postsInserted += r.inserted;
      totals.postsDuplicate += r.duplicate;
      totals.stale += r.stale;
    }
  }

  totals.elapsed = (Date.now() - startTime) / 1000;

  log('\n=== 수집 완료 ===');
  log(`채널/검색: ${totals.channelsProcessed}개`);
  log(`영상: ${totals.videosCollected}개, 댓글: ${totals.commentsCollected}개`);
  log(`DB 신규: ${totals.postsInserted}개, 중복: ${totals.postsDuplicate}개, 기간초과: ${totals.stale}개`);
  log(`소요 시간: ${totals.elapsed.toFixed(0)}초`);

  return totals;
}
