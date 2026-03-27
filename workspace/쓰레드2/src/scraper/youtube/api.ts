/**
 * @file YouTube Data API v3 클라이언트.
 *
 * API 키 기반 공개 데이터 읽기 전용.
 * 쿼터: 10,000 units/일 (search=100, 나머지=1)
 */

import 'dotenv/config';
import type { YouTubeVideoItem, YouTubeCommentItem, YouTubeVideoStats } from './types.js';

const API_KEYS = [
  process.env.YOUTUBE_API_KEY,
  process.env.YOUTUBE_API_KEY_2,
  process.env.YOUTUBE_API_KEY_3,
].filter(Boolean) as string[];

let currentKeyIndex = 0;
function getApiKey(): string { return API_KEYS[currentKeyIndex] || ''; }
function rotateKey(): boolean {
  if (currentKeyIndex + 1 < API_KEYS.length) {
    currentKeyIndex++;
    console.log(`[YouTube API] 키 로테이션 → key #${currentKeyIndex + 1}`);
    return true;
  }
  return false;
}

const BASE = 'https://www.googleapis.com/youtube/v3';

if (API_KEYS.length === 0) {
  console.warn('[YouTube API] YOUTUBE_API_KEY not set in .env');
}

// ─── URL Builders (exported for testing) ─────────────────

export function buildSearchUrl(query: string, maxResults: number, pageToken?: string): string {
  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(maxResults),
    relevanceLanguage: 'ko',
    regionCode: 'KR',
    order: 'date',
    key: getApiKey(),
  });
  if (pageToken) params.set('pageToken', pageToken);
  return `${BASE}/search?${params}`;
}

/**
 * 채널 업로드 재생목록 ID 변환: UC... → UU...
 * playlistItems API는 채널의 업로드 재생목록을 직접 조회 (1 unit vs search 100 units)
 */
function channelToUploadsPlaylist(channelId: string): string {
  return 'UU' + channelId.slice(2);
}

export function buildChannelVideosUrl(channelId: string, maxResults: number, _publishedAfter?: string): string {
  const playlistId = channelToUploadsPlaylist(channelId);
  const params = new URLSearchParams({
    part: 'snippet',
    playlistId,
    maxResults: String(maxResults),
    key: getApiKey(),
  });
  return `${BASE}/playlistItems?${params}`;
}

export function buildVideosUrl(videoIds: string[]): string {
  const params = new URLSearchParams({
    part: 'snippet,statistics',
    id: videoIds.join(','),
    key: getApiKey(),
  });
  return `${BASE}/videos?${params}`;
}

export function buildCommentsUrl(videoId: string, maxResults: number, pageToken?: string): string {
  const params = new URLSearchParams({
    part: 'snippet',
    videoId,
    maxResults: String(Math.min(maxResults, 100)),
    order: 'relevance',
    textFormat: 'plainText',
    key: getApiKey(),
  });
  if (pageToken) params.set('pageToken', pageToken);
  return `${BASE}/commentThreads?${params}`;
}

// ─── Parsers (exported for testing) ──────────────────────

export function parseVideoItem(raw: any): YouTubeVideoItem {
  const snippet = raw.snippet || {};
  return {
    videoId: raw.id?.videoId || raw.id || '',
    channelId: snippet.channelId || '',
    channelTitle: snippet.channelTitle || '',
    title: snippet.title || '',
    description: (snippet.description || '').slice(0, 5000),
    publishedAt: snippet.publishedAt || '',
    thumbnailUrl: snippet.thumbnails?.default?.url,
  };
}

export function parseVideoStats(raw: any): YouTubeVideoStats {
  const stats = raw.statistics || {};
  return {
    viewCount: parseInt(stats.viewCount || '0', 10),
    likeCount: parseInt(stats.likeCount || '0', 10),
    commentCount: parseInt(stats.commentCount || '0', 10),
  };
}

export function parseCommentItem(raw: any): YouTubeCommentItem {
  const topComment = raw.snippet?.topLevelComment?.snippet || {};
  return {
    commentId: raw.id || '',
    authorName: topComment.authorDisplayName || '',
    text: (topComment.textDisplay || '').slice(0, 2000),
    likeCount: topComment.likeCount || 0,
    publishedAt: topComment.publishedAt || '',
    replyCount: raw.snippet?.totalReplyCount || 0,
  };
}

export function buildRepliesUrl(parentId: string, maxResults: number, pageToken?: string): string {
  const params = new URLSearchParams({
    part: 'snippet',
    parentId,
    maxResults: String(Math.min(maxResults, 100)),
    textFormat: 'plainText',
    key: getApiKey(),
  });
  if (pageToken) params.set('pageToken', pageToken);
  return `${BASE}/comments?${params}`;
}

// ─── API Fetchers ────────────────────────────────────────

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (res.status === 403 && rotateKey()) {
    // 쿼터 초과 → 다음 키로 재시도
    const retryUrl = url.replace(/key=[^&]+/, `key=${getApiKey()}`);
    const retry = await fetch(retryUrl);
    if (!retry.ok) {
      const body = await retry.text();
      throw new Error(`YouTube API ${retry.status}: ${body.slice(0, 200)}`);
    }
    return retry.json();
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * 키워드로 영상 검색.
 * 비용: 100 units/호출
 */
export async function searchVideos(query: string, maxResults: number = 10): Promise<YouTubeVideoItem[]> {
  const data = await fetchJson(buildSearchUrl(query, maxResults));
  return (data.items || []).map(parseVideoItem);
}

/**
 * 채널의 최신 영상 목록 (playlistItems API 사용).
 * 비용: 1 unit/호출 (search 대비 100배 절약)
 *
 * playlistItems는 publishedAfter 필터가 없으므로 클라이언트 측에서 날짜 필터링.
 */
export async function getChannelVideos(
  channelId: string,
  maxResults: number = 5,
  daysBack: number = 7,
): Promise<YouTubeVideoItem[]> {
  const cutoff = Date.now() - daysBack * 86400000;
  const data = await fetchJson(buildChannelVideosUrl(channelId, maxResults));

  return (data.items || [])
    .map((item: any) => {
      const snippet = item.snippet || {};
      // playlistItems returns videoId in snippet.resourceId.videoId
      const videoId = snippet.resourceId?.videoId || item.id?.videoId || '';
      return {
        videoId,
        channelId: snippet.channelId || channelId,
        channelTitle: snippet.channelTitle || '',
        title: snippet.title || '',
        description: (snippet.description || '').slice(0, 5000),
        publishedAt: snippet.publishedAt || '',
        thumbnailUrl: snippet.thumbnails?.default?.url,
      } as YouTubeVideoItem;
    })
    .filter((v: YouTubeVideoItem) => {
      // 클라이언트 측 날짜 필터
      if (!v.publishedAt) return false;
      return new Date(v.publishedAt).getTime() >= cutoff;
    });
}

/**
 * 영상 상세 정보 (통계 포함).
 * 비용: 1 unit/호출 (최대 50개 배치)
 */
export async function getVideoDetails(
  videoIds: string[],
): Promise<Array<YouTubeVideoItem & YouTubeVideoStats>> {
  const batches: string[][] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    batches.push(videoIds.slice(i, i + 50));
  }

  const results: Array<YouTubeVideoItem & YouTubeVideoStats> = [];
  for (const batch of batches) {
    const data = await fetchJson(buildVideosUrl(batch));
    for (const item of data.items || []) {
      results.push({
        ...parseVideoItem({ ...item, id: { videoId: item.id } }),
        videoId: item.id, // videos.list returns id as string, not object
        ...parseVideoStats(item),
      });
    }
  }
  return results;
}

/**
 * 영상 댓글 수집 (페이지네이션).
 * 비용: 1 unit/페이지
 */
export async function getVideoComments(
  videoId: string,
  maxComments: number = 100,
): Promise<YouTubeCommentItem[]> {
  const comments: YouTubeCommentItem[] = [];
  let pageToken: string | undefined;

  while (comments.length < maxComments) {
    const remaining = maxComments - comments.length;
    const pageSize = Math.min(remaining, 100);

    const data = await fetchJson(buildCommentsUrl(videoId, pageSize, pageToken));
    const items = (data.items || []).map(parseCommentItem);
    comments.push(...items);

    pageToken = data.nextPageToken;
    if (!pageToken || items.length === 0) break;
  }

  return comments.slice(0, maxComments);
}

/**
 * 긴 대본을 추출형 요약으로 압축한다 (LLM 없이 규칙 기반).
 *
 * 전략:
 * - 첫 2000자 유지 (도입부 — 영상 주제/제품 소개)
 * - 마지막 1000자 유지 (결론 — 추천/비추 정리)
 * - 중간: 뷰티 키워드 밀도가 높은 문장만 선별
 * - 총 8000자 이내로 압축
 */
function summarizeTranscript(text: string, maxLen: number = 10000): string {
  if (text.length <= maxLen) return text;

  const INTRO_LEN = 2000;
  const OUTRO_LEN = 1000;
  const MID_BUDGET = maxLen - INTRO_LEN - OUTRO_LEN - 100; // 여유분

  const intro = text.slice(0, INTRO_LEN);
  const outro = text.slice(-OUTRO_LEN);
  const middle = text.slice(INTRO_LEN, -OUTRO_LEN);

  // 중간 부분을 문장 단위로 분리
  const sentences = middle.split(/(?<=[.!?。다요죠세])\s+/).filter(s => s.length > 10);

  // 뷰티/니즈 관련 키워드로 문장 점수 매기기
  const SCORE_KEYWORDS = [
    '추천', '비추', '솔직', '후기', '리뷰', '비교',
    '좋아', '별로', '최고', '최악', '실패', '성공',
    '건조', '지성', '민감', '트러블', '모공', '피부',
    '가격', '가성비', '비싸', '저렴', '할인', '세일',
    '파운데이션', '쿠션', '립', '세럼', '토너', '크림',
    '올리브영', '다이소', '쿠팡',
    '꼭', '무조건', '절대', '진짜', '제발', '강력',
  ];

  const scored = sentences.map((s, i) => {
    let score = 0;
    const lower = s.toLowerCase();
    for (const kw of SCORE_KEYWORDS) {
      if (lower.includes(kw)) score++;
    }
    return { text: s, score, index: i };
  });

  // 점수 높은 순으로 정렬, 원래 순서 유지하며 budget 내에서 선택
  scored.sort((a, b) => b.score - a.score);

  const selected: typeof scored = [];
  let usedLen = 0;
  for (const s of scored) {
    if (s.score === 0) continue; // 키워드 없는 문장 제외
    if (usedLen + s.text.length > MID_BUDGET) continue;
    selected.push(s);
    usedLen += s.text.length;
  }

  // 원래 순서대로 재정렬
  selected.sort((a, b) => a.index - b.index);
  const middleSummary = selected.map(s => s.text).join(' ');

  return `${intro} [...요약됨...] ${middleSummary} [...] ${outro}`;
}

/**
 * yt-dlp로 영상 자막(대본)을 추출한다 (API 쿼터 0).
 * 한국어 자동 자막 → SRT → 순수 텍스트 변환.
 */
export async function getVideoTranscript(videoId: string): Promise<string> {
  const { execSync } = await import('child_process');
  const tmpDir = '/tmp/yt-subs';
  const tmpFile = `${tmpDir}/${videoId}`;

  try {
    // Ensure tmp directory exists
    execSync(`mkdir -p ${tmpDir}`);

    // Download Korean auto-generated subtitles as SRT
    execSync(
      `yt-dlp --write-auto-sub --sub-lang ko --sub-format srt --skip-download -o "${tmpFile}" "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
      { timeout: 30000 },
    );

    // Read SRT file
    const fs = await import('fs');
    const srtPath = `${tmpFile}.ko.srt`;
    if (!fs.existsSync(srtPath)) return '';

    const srt = fs.readFileSync(srtPath, 'utf-8');

    // Parse SRT → plain text (remove timestamps, sequence numbers, duplicates)
    const lines = srt.split('\n');
    const textLines: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines, sequence numbers, timestamps
      if (!trimmed) continue;
      if (/^\d+$/.test(trimmed)) continue;
      if (/^\d{2}:\d{2}:\d{2}/.test(trimmed)) continue;
      // Deduplicate (YouTube auto-subs repeat lines)
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      textLines.push(trimmed);
    }

    // Clean up temp files
    try {
      fs.unlinkSync(srtPath);
    } catch { /* ignored */ }

    const fullText = textLines.join(' ');
    return summarizeTranscript(fullText);
  } catch {
    return ''; // Silently fail — not all videos have subtitles
  }
}

/**
 * 댓글 답글 수집 (comments.list).
 * 비용: 1 unit/페이지
 */
export async function getCommentReplies(
  parentId: string,
  maxReplies: number = 100,
): Promise<YouTubeCommentItem[]> {
  const replies: YouTubeCommentItem[] = [];
  let pageToken: string | undefined;

  while (replies.length < maxReplies) {
    const remaining = maxReplies - replies.length;
    const data = await fetchJson(buildRepliesUrl(parentId, Math.min(remaining, 100), pageToken));

    for (const item of data.items || []) {
      const s = item.snippet || {};
      replies.push({
        commentId: item.id || '',
        authorName: s.authorDisplayName || '',
        text: (s.textDisplay || '').slice(0, 2000),
        likeCount: s.likeCount || 0,
        publishedAt: s.publishedAt || '',
        replyCount: 0,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken || (data.items || []).length === 0) break;
  }

  return replies.slice(0, maxReplies);
}
