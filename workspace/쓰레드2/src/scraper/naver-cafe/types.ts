// ─── Naver Cafe Scraper Types ───────────────────────────

export interface CafeTarget {
  id: string;
  name: string;
  category: string;
  clubid: string;
}

export interface CafeArticle {
  articleId: string;
  title: string;
  href: string;
}

export interface CollectedPost {
  id: string;
  title: string;
  body: string;
  url: string;
  nickname: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  postedAt: Date | null;
  comments: Array<{ nickname: string; text: string; like_count?: number }>;
}

export interface CafeCliOptions {
  cafes: CafeTarget[];
  limit: number;
}

export interface CafeCollectResult {
  total: number;
  inserted: number;
  skipped: number;
  failed: number;
  elapsed: number;
}
