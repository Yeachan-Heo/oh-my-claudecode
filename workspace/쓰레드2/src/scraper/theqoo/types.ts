/**
 * @file 더쿠(theqoo.net) 크롤러 전용 타입 정의.
 */

/** HOT 게시판 목록에서 추출한 게시글 요약 정보 */
export interface TheqooListItem {
  documentSrl: string;
  title: string;
  category: string;
  href: string;
  viewCount: number;
  commentCount: number;
}

/** 상세 페이지에서 추출한 게시글 전체 정보 */
export interface TheqooArticle {
  documentSrl: string;
  title: string;
  category: string;
  body: string;
  authorNickname: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  postedAt: Date | null;
  sourceUrl: string;
  comments: TheqooComment[];
}

/** 댓글 */
export interface TheqooComment {
  nickname: string;
  text: string;
  like_count?: number;
}

/** CLI 옵션 */
export interface TheqooCliOptions {
  board: 'hot' | 'square';
  pages: number;
  limit: number;
  comments: boolean;
}

/** 수집 결과 통계 */
export interface TheqooCollectResult {
  total: number;
  inserted: number;
  skipped: number;
  failed: number;
  elapsed: number;
}
