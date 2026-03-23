/**
 * @file YouTube Data API v3 타입 + 내부 모델.
 */

// ─── API Response Types ──────────────────────────────────

/** YouTube search.list / videos.list 응답 아이템 */
export interface YouTubeVideoItem {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: string;       // ISO 8601
  thumbnailUrl?: string;
}

/** YouTube videos.list statistics */
export interface YouTubeVideoStats {
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

/** YouTube commentThreads.list 응답 아이템 */
export interface YouTubeCommentItem {
  commentId: string;
  authorName: string;
  text: string;
  likeCount: number;
  publishedAt: string;
  replyCount: number;
}

// ─── Internal Models ─────────────────────────────────────

/** 수집 대상 채널 */
export interface YouTubeChannel {
  channelId: string;
  handle: string;            // @risabae 등
  name: string;              // 표시 이름
  category: string;          // '리뷰', '피부고민', '가성비' 등
  subscriberRange?: string;  // '10K-50K' 등
}

/** 수집 결과 */
export interface YouTubeCollectResult {
  channelsProcessed: number;
  videosFound: number;
  videosCollected: number;
  commentsCollected: number;
  postsInserted: number;
  postsDuplicate: number;
  stale: number;             // 7일 초과 스킵
  elapsed: number;
}

/** CLI 옵션 */
export interface YouTubeCliOptions {
  channels: YouTubeChannel[] | 'all' | 'search' | 'db';
  searchQuery?: string;       // search 모드에서 사용
  maxVideosPerChannel: number; // 채널당 최대 영상 수 (기본 5)
  maxCommentsPerVideo: number; // 영상당 최대 댓글 수 (기본 100)
  daysBack: number;            // 최근 N일 이내 영상만 (기본 7)
  fromIndex: number;           // 채널 시작 인덱스 (기본 0)
  toIndex: number;             // 채널 끝 인덱스 (기본 전체, exclusive)
}
