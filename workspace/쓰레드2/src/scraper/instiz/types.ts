/**
 * @file 인스티즈(instiz.net) 크롤러 전용 타입 정의.
 */

/** 게시판 목록에서 추출한 게시글 요약 정보 */
export interface InstizListItem {
  documentId: string;
  title: string;
  href: string;
  viewCount: number;
  commentCount: number;
}

/** 상세 페이지에서 추출한 게시글 전체 정보 */
export interface InstizArticle {
  documentId: string;
  title: string;
  body: string;
  authorNickname: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  postedAt: Date | null;
  sourceUrl: string;
  comments: InstizComment[];
}

/** 댓글 */
export interface InstizComment {
  nickname: string;
  text: string;
  like_count?: number;
}

/** CLI 옵션 */
export interface InstizCliOptions {
  board: 'name_beauty' | 'pt';
  pages: number;
  limit: number;
  comments: boolean;
}

/** 수집 결과 통계 */
export interface InstizCollectResult {
  total: number;
  inserted: number;
  skipped: number;
  stale: number;
  failed: number;
  elapsed: number;
}
