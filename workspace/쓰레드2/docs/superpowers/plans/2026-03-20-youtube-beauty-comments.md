# YouTube 뷰티 댓글 수집 시스템 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** YouTube 뷰티 영상 댓글을 수집하여 소비자 니즈(불편함, 질문, 추천 요청)를 발굴하고, 기존 community_posts 테이블에 통합 저장한다.

**Architecture:** YouTube Data API v3(무료, API 키 방식)로 채널 검색 → 최신 영상 조회 → 댓글 수집. 기존 theqoo/instiz와 동일한 모듈 구조(types, api, collector)를 따르되, HTML 파싱 대신 공식 REST API를 사용한다. community_posts에 source_platform='youtube'로 저장하며, 영상 1개 = 포스트 1개(본문=영상 제목+설명, 댓글=댓글 배열)로 매핑한다.

**Tech Stack:** YouTube Data API v3, node-fetch (내장), Drizzle ORM, TypeScript

---

## 유튜브 채널 선정 기준

### 채널 필터링 조건

| 기준 | 값 | 이유 |
|------|-----|------|
| **구독자 수** | 1만~50만 | 너무 크면 팬 댓글만, 너무 작으면 댓글 없음 |
| **언어** | 한국어 | 한국 소비자 니즈 타겟 |
| **콘텐츠 유형** | 리뷰, 추천, 루틴, 비교, 하울 | 댓글에 제품 관련 니즈가 집중 |
| **업로드 빈도** | 주 1회 이상 | 활성 채널 |
| **댓글 활성도** | 영상당 평균 30개+ | 니즈 수집 최소량 |

### 시드 채널 카테고리 (초기 10~15개)

| 카테고리 | 예시 채널 유형 | 댓글 특성 |
|---------|-------------|----------|
| **제품 리뷰어** | 신제품 리뷰, 솔직 후기 | "저도 써봤는데...", "이거 vs 저거 어때요?" |
| **피부 고민** | 트러블, 민감성, 건조 | "저도 이 증상인데...", "뭐 쓰세요?" |
| **가성비 추천** | 올영, 다이소, 저가 | "추천해주세요", "이거 사도 될까요?" |
| **비교/랭킹** | TOP 10, OO vs OO | "저는 이게 더 좋았어요", "다른 건 없나요?" |
| **루틴/하울** | 아침 루틴, 올영 하울 | "저도 이렇게 하고 싶은데...", "어디서 사요?" |

### 채널 발굴 방법

1. **수동 시드 리스트** — 알려진 뷰티 유튜버 10~15개 채널 ID 하드코딩
2. **API 검색 확장** — `search.list`로 "뷰티 추천", "화장품 리뷰" 등 검색 → 신규 채널 발굴
3. **성과 기반 추가** — 댓글 중 니즈 밀도 높은 채널을 우선순위 상향

### 영상 선정 기준

| 기준 | 값 | 이유 |
|------|-----|------|
| **업로드일** | 최근 7일 이내 | 최신 니즈 반영 |
| **조회수** | 1,000 이상 | 최소 댓글 보장 |
| **댓글 수** | 10개 이상 | 수집 가치 |
| **제목 키워드** | 리뷰, 추천, 비교, 루틴, 하울, 솔직, 찐후기 | 니즈 밀도 높은 영상 |

### 댓글 필터링 (수집 후)

니즈 발굴에 유용한 댓글 패턴:
- **질문형**: "추천해주세요", "뭐 써요?", "어떤 게 좋아요?", "이거 괜찮나요?"
- **고민형**: "피부가...", "트러블이...", "건조해서...", "고민이에요"
- **후기형**: "써봤는데", "효과가", "좋았어요", "별로였어요"
- **비교형**: "이거 vs 저거", "차이가 뭐예요?", "어떤 게 나아요?"

---

## YouTube Data API v3 쿼터 계산

**무료 일일 쿼터: 10,000 units**

| API 호출 | 비용 | 일일 최대 횟수 |
|---------|------|-------------|
| `search.list` (채널/영상 검색) | 100 units | 100회 |
| `channels.list` (채널 정보) | 1 unit | 10,000회 |
| `videos.list` (영상 정보) | 1 unit | 10,000회 |
| `commentThreads.list` (댓글 100개/호출) | 1 unit | 10,000회 |

**일일 수집 시나리오 (보수적):**
- 채널 검색: 5회 × 100 = 500 units
- 영상 목록: 15채널 × 1 = 15 units
- 영상 상세: 50영상 × 1 = 50 units
- 댓글 수집: 50영상 × 평균 3페이지 = 150 units
- **합계: ~715 units/일** (쿼터의 7.2%)

→ 넉넉하게 사용 가능. 일일 50영상, 15,000댓글 수집 가능.

---

## API 키 설정

YouTube Data API v3는 **API 키만으로 공개 데이터 읽기 가능** (OAuth 불필요).

1. Google Cloud Console → APIs & Services → Credentials → API Key 생성
2. YouTube Data API v3 활성화
3. `.env`에 `YOUTUBE_API_KEY=AIza...` 추가

---

## File Structure

```
src/scraper/youtube/
  types.ts          — API 응답 타입 + 내부 모델
  api.ts            — YouTube Data API v3 클라이언트
  channels.ts       — 시드 채널 레지스트리 + 검색 확장
  collector.ts      — 수집 오케스트레이터 (영상 조회 → 댓글 수집 → DB 저장)

scripts/
  collect-youtube-comments.ts  — CLI 엔트리포인트

src/agents/
  youtube-crawler.md           — 에이전트 가이드

src/db/
  schema.ts                    — sourcePlatformEnum에 'youtube' 추가
```

### 데이터 매핑: YouTube → community_posts

| community_posts 컬럼 | YouTube 매핑 |
|---------------------|-------------|
| `id` | `youtube_{videoId}` |
| `source_platform` | `'youtube'` |
| `source_cafe` | `youtube_{channelHandle}` (예: `youtube_@risabae`) |
| `source_url` | `https://youtube.com/watch?v={videoId}` |
| `title` | 영상 제목 |
| `body` | 영상 설명 (description) |
| `comments` | 댓글 배열 `[{nickname, text, like_count}]` |
| `author_nickname` | 채널 이름 |
| `like_count` | 영상 좋아요 수 |
| `comment_count` | 영상 댓글 수 |
| `view_count` | 영상 조회수 |
| `posted_at` | 영상 게시일 |
| `collected_at` | 수집 시각 |

---

## Chunk 1: Schema + Types + API Client

### Task 1: Schema 업데이트 — sourcePlatformEnum에 'youtube' 추가

**Files:**
- Modify: `src/db/schema.ts:764-769`

- [ ] **Step 1: Write the test expectation**

```bash
grep "'youtube'" src/db/schema.ts
# Expected: no match (not yet added)
```

- [ ] **Step 2: Add 'youtube' to sourcePlatformEnum**

```typescript
// src/db/schema.ts:764-769
export const sourcePlatformEnum = pgEnum('source_platform', [
  'naver_cafe',
  'naver_blog',
  'theqoo',
  'instiz',
  'youtube',  // 추가
]);
```

- [ ] **Step 3: Generate migration + apply**

```bash
cd /home/sihun92/projects/oh-my-claudecode/workspace/쓰레드2
# DB에 직접 enum 값 추가 (기존 마이그레이션 패턴 유지)
cat > _add-youtube-enum.ts << 'SCRIPT'
import { db } from './src/db/index.js';
import { sql } from 'drizzle-orm';
async function main() {
  await db.execute(sql`ALTER TYPE source_platform ADD VALUE IF NOT EXISTS 'youtube'`);
  console.log('youtube enum value added');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _add-youtube-enum.ts && rm _add-youtube-enum.ts
```

- [ ] **Step 4: Regenerate drizzle migration snapshot**

```bash
rm -rf src/db/migrations/*
npx drizzle-kit generate
npx drizzle-kit migrate
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit
grep "'youtube'" src/db/schema.ts  # should match
```

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations/
git commit -m "feat(threads2): add 'youtube' to sourcePlatformEnum"
```

---

### Task 2: YouTube Types 정의

**Files:**
- Create: `src/scraper/youtube/types.ts`

- [ ] **Step 1: Create types file**

```typescript
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
  channels: YouTubeChannel[] | 'all' | 'search';
  searchQuery?: string;       // search 모드에서 사용
  maxVideosPerChannel: number; // 채널당 최대 영상 수 (기본 5)
  maxCommentsPerVideo: number; // 영상당 최대 댓글 수 (기본 100)
  daysBack: number;            // 최근 N일 이내 영상만 (기본 7)
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/scraper/youtube/types.ts
git commit -m "feat(threads2): add YouTube scraper types"
```

---

### Task 3: YouTube API Client

**Files:**
- Create: `src/scraper/youtube/api.ts`
- Reference: YouTube Data API v3 docs

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/youtube-api.test.ts
import { describe, it, expect } from 'vitest';
import { buildSearchUrl, buildVideosUrl, buildCommentsUrl, parseVideoItem, parseCommentItem } from '../scraper/youtube/api.js';

describe('YouTube API URL builders', () => {
  it('buildSearchUrl constructs correct URL', () => {
    const url = buildSearchUrl('뷰티 추천', 5);
    expect(url).toContain('search?');
    expect(url).toContain('q=%EB%B7%B0%ED%8B%B0');
    expect(url).toContain('maxResults=5');
    expect(url).toContain('type=video');
  });

  it('buildVideosUrl includes statistics part', () => {
    const url = buildVideosUrl(['abc123', 'def456']);
    expect(url).toContain('videos?');
    expect(url).toContain('id=abc123%2Cdef456');
    expect(url).toContain('part=snippet%2Cstatistics');
  });

  it('buildCommentsUrl includes videoId', () => {
    const url = buildCommentsUrl('abc123', 100);
    expect(url).toContain('commentThreads?');
    expect(url).toContain('videoId=abc123');
    expect(url).toContain('maxResults=100');
  });
});

describe('YouTube API parsers', () => {
  it('parseVideoItem extracts fields', () => {
    const raw = {
      id: { videoId: 'abc123' },
      snippet: {
        channelId: 'ch1',
        channelTitle: 'TestChannel',
        title: '테스트 영상',
        description: '설명',
        publishedAt: '2026-03-19T10:00:00Z',
        thumbnails: { default: { url: 'http://img.jpg' } },
      },
    };
    const item = parseVideoItem(raw);
    expect(item.videoId).toBe('abc123');
    expect(item.title).toBe('테스트 영상');
    expect(item.channelTitle).toBe('TestChannel');
  });

  it('parseCommentItem extracts fields', () => {
    const raw = {
      id: 'cmt1',
      snippet: {
        topLevelComment: {
          snippet: {
            authorDisplayName: 'User1',
            textDisplay: '이거 좋아요!',
            likeCount: 5,
            publishedAt: '2026-03-19T12:00:00Z',
          },
        },
        totalReplyCount: 2,
      },
    };
    const item = parseCommentItem(raw);
    expect(item.commentId).toBe('cmt1');
    expect(item.authorName).toBe('User1');
    expect(item.text).toBe('이거 좋아요!');
    expect(item.likeCount).toBe(5);
    expect(item.replyCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/__tests__/youtube-api.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: Implement API client**

```typescript
// src/scraper/youtube/api.ts
/**
 * @file YouTube Data API v3 클라이언트.
 *
 * API 키 기반 공개 데이터 읽기 전용.
 * 쿼터: 10,000 units/일 (search=100, 나머지=1)
 */

import 'dotenv/config';
import type { YouTubeVideoItem, YouTubeCommentItem, YouTubeVideoStats } from './types.js';

const API_KEY = process.env.YOUTUBE_API_KEY || '';
const BASE = 'https://www.googleapis.com/youtube/v3';

if (!API_KEY) {
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
    key: API_KEY,
  });
  if (pageToken) params.set('pageToken', pageToken);
  return `${BASE}/search?${params}`;
}

export function buildChannelVideosUrl(channelId: string, maxResults: number, publishedAfter?: string): string {
  const params = new URLSearchParams({
    part: 'snippet',
    channelId,
    type: 'video',
    maxResults: String(maxResults),
    order: 'date',
    key: API_KEY,
  });
  if (publishedAfter) params.set('publishedAfter', publishedAfter);
  return `${BASE}/search?${params}`;
}

export function buildVideosUrl(videoIds: string[]): string {
  const params = new URLSearchParams({
    part: 'snippet,statistics',
    id: videoIds.join(','),
    key: API_KEY,
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
    key: API_KEY,
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

// ─── API Fetchers ────────────────────────────────────────

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
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
 * 채널의 최신 영상 목록.
 * 비용: 100 units/호출
 */
export async function getChannelVideos(
  channelId: string,
  maxResults: number = 5,
  daysBack: number = 7,
): Promise<YouTubeVideoItem[]> {
  const publishedAfter = new Date(Date.now() - daysBack * 86400000).toISOString();
  const data = await fetchJson(buildChannelVideosUrl(channelId, maxResults, publishedAfter));
  return (data.items || []).map(parseVideoItem);
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/__tests__/youtube-api.test.ts
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/scraper/youtube/api.ts src/__tests__/youtube-api.test.ts
git commit -m "feat(threads2): add YouTube Data API v3 client with tests"
```

---

## Chunk 2: Channel Registry + Collector + CLI

### Task 4: 시드 채널 레지스트리

**Files:**
- Create: `src/scraper/youtube/channels.ts`

- [ ] **Step 1: Create channels registry**

```typescript
// src/scraper/youtube/channels.ts
/**
 * @file YouTube 뷰티 채널 시드 리스트 + 검색 확장.
 *
 * 초기 10~15개 수동 큐레이션 → API 검색으로 확장.
 * 채널 추가/제거는 이 파일만 수정.
 */

import type { YouTubeChannel } from './types.js';

/**
 * 시드 채널 리스트.
 *
 * 선정 기준: 구독자 1만~50만, 한국어, 뷰티 리뷰/추천 콘텐츠,
 * 댓글에 실제 고민/질문이 많은 채널 우선.
 *
 * channelId는 YouTube Studio 또는 API로 확인 가능.
 * handle은 유튜브 URL에 표시되는 @핸들.
 */
export const SEED_CHANNELS: YouTubeChannel[] = [
  // ── 제품 리뷰/추천 ──
  // 실제 채널 ID는 첫 수집 시 API 검색으로 확인 후 업데이트
  // 아래는 플레이스홀더 — 실행 전 반드시 실제 ID로 교체

  // { channelId: 'UC_PLACEHOLDER_1', handle: '@channel1', name: '뷰티 리뷰어 A', category: '리뷰' },
  // { channelId: 'UC_PLACEHOLDER_2', handle: '@channel2', name: '피부과 전문의 B', category: '피부고민' },
];

/**
 * 채널 검색 키워드.
 * searchVideos()에 전달하여 영상 직접 검색에 사용.
 */
export const SEARCH_KEYWORDS = [
  '화장품 추천 2026',
  '스킨케어 루틴 추천',
  '뷰티 솔직 리뷰',
  '올영 추천템',
  '피부 고민 해결',
  '가성비 화장품',
  '민감성 피부 추천',
  '여드름 스킨케어',
  '다이소 뷰티 추천',
  '건조 피부 보습',
];

/**
 * 영상 제목에서 니즈 밀도를 예측하는 키워드.
 * 이 키워드를 포함하는 영상은 수집 우선순위 상향.
 */
export const HIGH_NEED_KEYWORDS = [
  '추천', '리뷰', '비교', '솔직', '찐후기',
  '루틴', '하울', '고민', '해결', '꿀팁',
  'vs', 'TOP', '순위', '가성비', '인생템',
];
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/scraper/youtube/channels.ts
git commit -m "feat(threads2): add YouTube beauty channel seed list + search keywords"
```

---

### Task 5: 수집 오케스트레이터

**Files:**
- Create: `src/scraper/youtube/collector.ts`

- [ ] **Step 1: Create collector**

```typescript
// src/scraper/youtube/collector.ts
/**
 * @file YouTube 뷰티 댓글 수집 오케스트레이터.
 *
 * 채널/키워드 → 영상 조회 → 댓글 수집 → community_posts DB 저장.
 * source_platform='youtube', source_cafe='youtube_{handle}'
 */

import { db } from '../../db/index.js';
import { communityPosts } from '../../db/schema.js';
import {
  searchVideos,
  getChannelVideos,
  getVideoDetails,
  getVideoComments,
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

// ─── Video Filtering ─────────────────────────────────────

/**
 * 영상 제목에 니즈 관련 키워드가 포함되어 있는지 확인.
 */
function hasNeedKeywords(title: string): boolean {
  const lower = title.toLowerCase();
  return HIGH_NEED_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

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
        body: video.description,
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
): Promise<{ videos: number; comments: number; inserted: number; duplicate: number; stale: number }> {
  log(`\n▶ 채널: ${channel.name} (${channel.handle})`);

  let result = { videos: 0, comments: 0, inserted: 0, duplicate: 0, stale: 0 };

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

    // 4. Get comments
    let comments: YouTubeCommentItem[] = [];
    try {
      comments = await getVideoComments(video.videoId, opts.maxCommentsPerVideo);
      result.comments += comments.length;
      log(`    댓글 ${comments.length}개 수집`);
    } catch (err) {
      log(`    댓글 수집 실패: ${(err as Error).message}`);
    }

    // 5. Save
    const isNew = await saveToDb(video, comments, channel.handle);
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
): Promise<{ videos: number; comments: number; inserted: number; duplicate: number; stale: number }> {
  log(`\n▶ 검색: "${query}"`);

  let result = { videos: 0, comments: 0, inserted: 0, duplicate: 0, stale: 0 };

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

    let comments: YouTubeCommentItem[] = [];
    try {
      comments = await getVideoComments(video.videoId, opts.maxCommentsPerVideo);
      result.comments += comments.length;
      log(`    댓글 ${comments.length}개 수집`);
    } catch (err) {
      log(`    댓글 수집 실패: ${(err as Error).message}`);
    }

    const handle = video.channelTitle.replace(/\s+/g, '_');
    const isNew = await saveToDb(video, comments, handle);
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
  let totals = {
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

  if (opts.channels === 'search') {
    // 키워드 검색 모드
    const queries = opts.searchQuery ? [opts.searchQuery] : SEARCH_KEYWORDS.slice(0, 5);
    log(`검색 모드: ${queries.length}개 키워드`);

    for (const query of queries) {
      const r = await collectFromSearch(query, opts, startTime);
      totals.channelsProcessed++;
      totals.videosCollected += r.videos;
      totals.commentsCollected += r.comments;
      totals.postsInserted += r.inserted;
      totals.postsDuplicate += r.duplicate;
      totals.stale += r.stale;
    }
  } else {
    // 채널 모드
    const channels = opts.channels === 'all' ? SEED_CHANNELS : opts.channels;
    log(`채널 모드: ${channels.length}개 채널, 채널당 최대 ${opts.maxVideosPerChannel}영상`);

    for (const channel of channels) {
      const r = await collectFromChannel(channel, opts, startTime);
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
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/scraper/youtube/collector.ts
git commit -m "feat(threads2): add YouTube comment collector orchestrator"
```

---

### Task 6: CLI 엔트리포인트

**Files:**
- Create: `scripts/collect-youtube-comments.ts`
- Modify: `package.json` (add npm script)

- [ ] **Step 1: Create CLI script**

```typescript
#!/usr/bin/env tsx
/**
 * collect-youtube-comments.ts — YouTube 뷰티 영상 댓글 수집
 *
 * Usage:
 *   npx tsx scripts/collect-youtube-comments.ts --search "화장품 추천"
 *   npx tsx scripts/collect-youtube-comments.ts --search --max-videos 10
 *   npx tsx scripts/collect-youtube-comments.ts --all
 *   npx tsx scripts/collect-youtube-comments.ts --max-videos 5 --max-comments 200 --days 3
 */

import 'dotenv/config';
import { collectYouTube } from '../src/scraper/youtube/collector.js';
import { SEED_CHANNELS } from '../src/scraper/youtube/channels.js';
import type { YouTubeCliOptions } from '../src/scraper/youtube/types.js';

function parseArgs(): YouTubeCliOptions {
  const args = process.argv.slice(2);
  let channels: YouTubeCliOptions['channels'] = 'search'; // 기본: 검색 모드
  let searchQuery: string | undefined;
  let maxVideosPerChannel = 5;
  let maxCommentsPerVideo = 100;
  let daysBack = 7;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--all':
        channels = 'all';
        break;
      case '--search':
        channels = 'search';
        if (args[i + 1] && !args[i + 1].startsWith('--')) {
          searchQuery = args[++i];
        }
        break;
      case '--max-videos':
        maxVideosPerChannel = parseInt(args[++i], 10) || 5;
        break;
      case '--max-comments':
        maxCommentsPerVideo = parseInt(args[++i], 10) || 100;
        break;
      case '--days':
        daysBack = parseInt(args[++i], 10) || 7;
        break;
      case '--help':
        console.log(`
YouTube 뷰티 댓글 수집

Usage:
  --search [query]     키워드 검색 모드 (기본: 미리 정의된 뷰티 키워드)
  --all                시드 채널 모드 (channels.ts 리스트)
  --max-videos N       채널/검색당 최대 영상 수 (기본: 5)
  --max-comments N     영상당 최대 댓글 수 (기본: 100)
  --days N             최근 N일 이내 영상만 (기본: 7)

Requires: YOUTUBE_API_KEY in .env
        `);
        process.exit(0);
    }
  }

  return { channels, searchQuery, maxVideosPerChannel, maxCommentsPerVideo, daysBack };
}

async function main(): Promise<void> {
  if (!process.env.YOUTUBE_API_KEY) {
    console.error('YOUTUBE_API_KEY가 .env에 설정되지 않았습니다.');
    console.error('Google Cloud Console에서 YouTube Data API v3 키를 생성하세요.');
    process.exit(1);
  }

  const opts = parseArgs();
  await collectYouTube(opts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script to package.json**

```json
"collect:youtube": "tsx scripts/collect-youtube-comments.ts"
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add scripts/collect-youtube-comments.ts package.json
git commit -m "feat(threads2): add YouTube comment collection CLI"
```

---

### Task 7: 에이전트 가이드 + CLAUDE.md 업데이트

**Files:**
- Create: `src/agents/youtube-crawler.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create agent guide**

```markdown
# YouTube 뷰티 댓글 크롤러 에이전트 가이드

## 목적
YouTube 뷰티 영상의 댓글에서 소비자 니즈(불편함, 질문, 추천 요청)를 수집한다.

## 수집 방법
YouTube Data API v3 (API 키, 무료 10,000 units/일)

## 명령어
\`\`\`bash
# 키워드 검색으로 수집 (기본 모드)
npm run collect:youtube -- --search "화장품 추천"

# 미리 정의된 뷰티 키워드 5개로 자동 검색
npm run collect:youtube -- --search

# 시드 채널 리스트에서 수집
npm run collect:youtube -- --all

# 옵션
npm run collect:youtube -- --search --max-videos 10 --max-comments 200 --days 3
\`\`\`

## 채널 선정 기준
- 구독자 1만~50만 (댓글 질 보장)
- 뷰티 리뷰/추천/비교/루틴 콘텐츠
- 한국어 채널
- 댓글 활성도 높은 채널

## 데이터 저장
- 테이블: `community_posts`
- `source_platform`: `'youtube'`
- `source_cafe`: `youtube_{채널핸들}`
- 영상 1개 = 포스트 1개, 댓글은 comments 배열에 저장

## 쿼터 관리
- 일일 10,000 units
- 검색: 100 units/호출
- 댓글: 1 unit/100댓글
- 보수적 사용 시 일일 50영상, 15,000댓글 수집 가능

## 시드 채널 추가 방법
`src/scraper/youtube/channels.ts`의 `SEED_CHANNELS` 배열에 추가:
\`\`\`typescript
{ channelId: 'UC...', handle: '@channelname', name: '채널명', category: '리뷰' }
\`\`\`
channelId 확인: YouTube 채널 페이지 소스에서 `browse_id` 또는 API `search.list(type=channel)` 사용

## 주의사항
- `.env`에 `YOUTUBE_API_KEY` 필수
- API 키가 없으면 스크립트가 즉시 종료됨
- 댓글이 비활성화된 영상은 자동 스킵
- 쿼터 초과 시 HTTP 403 에러 — 다음 날까지 대기
```

- [ ] **Step 2: Update CLAUDE.md**

기존 도구 섹션에 추가:
```
- YouTube 댓글 수집: `scripts/collect-youtube-comments.ts` (`npm run collect:youtube`)
```

DB 섹션의 주요 테이블에 youtube 추가:
```
community_posts(source_platform: naver_cafe|theqoo|instiz|youtube)
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/youtube-crawler.md CLAUDE.md
git commit -m "docs(threads2): add YouTube crawler agent guide + update CLAUDE.md"
```

---

## Chunk 3: 통합 테스트 + API 키 설정

### Task 8: .env에 API 키 추가 + 통합 테스트

**Files:**
- Modify: `.env`
- Modify: `.gitignore` (confirm .env is ignored)

- [ ] **Step 1: API 키 설정**

```bash
# Google Cloud Console에서 키 생성 후:
echo "YOUTUBE_API_KEY=AIzaSy..." >> .env

# .env가 gitignore에 포함되어 있는지 확인
grep ".env" .gitignore
```

- [ ] **Step 2: 검색 모드로 통합 테스트**

```bash
npx tsx scripts/collect-youtube-comments.ts --search "올영 추천템 2026" --max-videos 3 --max-comments 50 --days 7
```

Expected output:
```
[HH:MM:SS] === YouTube 뷰티 댓글 수집 시작 ===
[HH:MM:SS] 검색 모드: 1개 키워드
[HH:MM:SS] ▶ 검색: "올영 추천템 2026"
[HH:MM:SS]   영상 3개 발견
[HH:MM:SS]   [1] 올영 추천템 리뷰... (12345뷰, 89댓글)
[HH:MM:SS]     댓글 50개 수집
[HH:MM:SS]     DB 저장 완료
...
```

- [ ] **Step 3: DB에 저장 확인**

```bash
cat > _check-youtube.ts << 'SCRIPT'
import { db } from './src/db/index.js';
import { sql } from 'drizzle-orm';
async function main() {
  const result = await db.execute(sql`
    SELECT source_cafe, title, view_count, comment_count,
           LEFT(posted_at::text, 10) as date
    FROM community_posts WHERE source_platform = 'youtube'
    ORDER BY collected_at DESC LIMIT 5
  `);
  console.table(result);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _check-youtube.ts && rm _check-youtube.ts
```

- [ ] **Step 4: 최종 빌드 확인**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/youtube-api.test.ts
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(threads2): YouTube beauty comment collection system complete"
```

---

## Summary

| Task | 내용 | 예상 시간 |
|------|------|----------|
| 1 | Schema + migration | 2분 |
| 2 | Types 정의 | 2분 |
| 3 | API client + tests | 5분 |
| 4 | Channel registry | 2분 |
| 5 | Collector orchestrator | 5분 |
| 6 | CLI script + npm | 3분 |
| 7 | Agent guide + CLAUDE.md | 2분 |
| 8 | API 키 설정 + 통합 테스트 | 5분 |

**Prerequisites:**
- Google Cloud Console에서 YouTube Data API v3 활성화 + API 키 생성
- `.env`에 `YOUTUBE_API_KEY` 설정
