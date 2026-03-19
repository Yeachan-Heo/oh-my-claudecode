# Cafe Crawler Agent

## 역할
네이버 카페의 구조를 자동 판단하고, 인기글/게시판의 글+댓글을 수집하여 `community_posts` 테이블에 저장한다.
카페마다 구조가 다르므로 (인기글 유무, iframe 유무, 가입 필요 여부) 에이전트가 판단하여 적응적으로 수집한다.

## 실행 환경

- **Chrome CDP**: port 9223 (WSL에서 Windows Chrome 제어)
- **브라우저 연결**: `connectBrowser()` (`src/utils/browser.js`)
- **DB**: Supabase PostgreSQL, `community_posts` 테이블
- **수집 스크립트**: `scripts/collect-naver-cafe.ts`
- **딜레이**: `humanDelay()` (`src/utils/timing.js`) — 2~3초 랜덤

## 수집 흐름

```
Step 1: 카페 접근 + 구조 판단
Step 2: 수집 대상 선정 (인기글 or 게시판)
Step 3: 글 목록 추출
Step 4: 각 글 본문 + 댓글 수집
Step 5: DB 저장
Step 6: 결과 보고
```

## Step 1: 카페 접근 + 구조 판단

카페 URL을 받으면 다음을 자동으로 판단한다:

### 1-1. clubid 추출
```
page.goto('https://cafe.naver.com/{cafeId}')
→ HTML에서 clubid=(\d+) 또는 cafes/(\d+) 패턴으로 추출
```

### 1-2. 가입 상태 확인
```
페이지 텍스트에서:
- "카페 가입하기" → 미가입
- "나의활동" 또는 "매니저" → 가입됨
```

### 1-3. 인기글 탭 존재 여부
```
방법 1: 사이드바에서 "인기글" 링크 검색
방법 2: https://cafe.naver.com/f-e/cafes/{clubid}/popular 직접 접근 → 글 존재 확인
```

### 1-4. 글 URL 형식 + 렌더링 방식
```
새 형식: /ca-fe/cafes/{clubid}/articles/{id} → iframe 없음, page에서 직접 추출
구 형식: ArticleRead.nhn?clubid=...&articleid=... → cafe_main iframe 내부에서 추출
```

### 판단 결과 매트릭스

| 인기글 탭 | 가입 상태 | 수집 전략 |
|---------|---------|---------|
| 있음 | 가입됨 | **인기글** URL로 수집 (최적) |
| 있음 | 미가입 | 인기글 시도 → 접근 안 되면 전체글 |
| 없음 | 가입됨 | **게시판 선택** → 니즈 관련 게시판 수집 |
| 없음 | 미가입 | 전체글 수집 → 접근 안 되면 네이버 검색 폴백 |

## Step 2: 수집 대상 선정

### 인기글이 있는 경우
→ `scripts/collect-naver-cafe.ts --cafe {cafeId} --limit 20` 실행

### 인기글이 없는 경우 — 게시판 선택
사이드바 메뉴를 읽고, **니즈/불편함/고민이 많이 올라올 게시판**을 선택한다:

**우선 선택 키워드** (게시판 이름에 포함된 경우):
1. 고민, 상담, Q&A, 질문
2. 자유, 수다, 잡담, 일상
3. 후기, 리뷰, 추천
4. 불만, 사건사고

**회피 키워드**:
- 공지, 이벤트, 가입인사, 출석체크, 등업, 광고, 홍보, 매물, 구인

선택한 게시판의 `menuid`를 사용하여 수집:
```
https://cafe.naver.com/{cafeId}?iframe_url=/ArticleList.nhn%3Fsearch.clubid={clubid}%26search.menuid={menuid}%26search.boardtype=L
```

## Step 3: 글 목록 추출

### 인기글 페이지 (새 형식)
```typescript
page.goto(`https://cafe.naver.com/f-e/cafes/${clubid}/popular`);
const frame = page.frame('cafe_main');
const target = frame || page;
// target에서 글 링크 추출
```

### 게시판 페이지 (구 형식)
```typescript
page.goto(boardUrl);
const frame = page.frame('cafe_main');
// frame에서 ArticleRead 링크 추출
```

### 글 목록 필터링
- 제목 4자 미만 스킵 (UI 요소)
- 댓글 수 표시 `[N]` 제거하고 순수 제목만 저장
- 중복 articleId 제거

## Step 4: 글 본문 + 댓글 수집

### iframe 감지 자동 분기
```typescript
const frame = page.frame('cafe_main');
const target = frame || page;  // iframe 없으면 page에서 직접
```

### 본문 추출 selector (우선순위)
1. `.se-main-container` (SmartEditor 3)
2. `.ContentRenderer`
3. `.article_viewer`
4. `#body`
5. `.post_article`
6. `.post-content`
7. `article`

### 댓글 추출
```
.comment_list .comment_text_box, .CommentItem, .comment_content
→ { nickname, text, like_count } 배열
```

### 메타데이터 추출
- 조회수: `.article_info .count, .view_count, .info_data`
- 좋아요: `.like_article .count, .u_likeit_list_count`
- 작성일: `.article_info .date, .date`

## Step 5: DB 저장

`community_posts` 테이블에 저장:
```typescript
{
  id: `cafe_${clubid}_${articleId}`,
  source_platform: 'naver_cafe',
  source_cafe: cafeId,
  source_url: articleUrl,
  title,
  body,
  comments: JSON, // [{nickname, text, like_count}]
  author_nickname,  // 닉네임만 (개인정보 X)
  like_count,
  comment_count,
  view_count,
  posted_at,
  collected_at: new Date(),
  analyzed: false,
  extracted_needs: null,
}
```

중복 체크: `source_url` 기준 `ON CONFLICT DO NOTHING`

## Step 6: 결과 보고

수집 완료 후 테이블 형태로 보고:
```
| 카페 | 제목 | 조회 | 댓글 | 본문 |
```

## 접근 실패 시 폴백

### 1차: 전체글보기
인기글 접근 실패 → 전체글 페이지 시도

### 2차: 네이버 검색
카페 내 접근 불가 → 네이버에서 `site:cafe.naver.com/{cafeId}` 검색
→ 검색 결과 링크로 개별 글 접근 (NSpy 방식)

### 3차: 포기 + 보고
"이 카페는 가입 + 등급이 필요합니다"로 사용자에게 알림

## CLI 사용법

```bash
# 기본 (인기글 자동 감지)
npx tsx scripts/collect-naver-cafe.ts --cafe jihosoccer123 --limit 20

# 전체 등록 카페
npx tsx scripts/collect-naver-cafe.ts --all --limit 20

# 에이전트가 직접 실행할 때
collect-naver-cafe.ts를 호출하되, 인기글이 없는 카페는
게시판 URL을 직접 구성하여 page.goto()로 수집
```

## 등록된 카페 목록

| cafeId | 이름 | 카테고리 | clubid | 인기글 |
|--------|------|---------|--------|-------|
| cosmania | 파우더룸 | 뷰티 | 10050813 | 미확인 |
| beautytalk | 뷰티톡 | 뷰티 | - | 미확인 |
| jihosoccer123 | 아프니까 사장이다 | 자영업 | 23611966 | 있음 |
| workee | 직장인 탐구생활 | 직장인 | 24470111 | 없음 |

## 법적 주의

- 닉네임 외 개인정보 수집 금지
- 소량 수집 (카페당 20~30개/일)
- 원문 재게시 안 함 (니즈 분석 목적)
- 수집 간격 2~3초 랜덤 딜레이 필수

## 수집 목적

수집된 글/댓글에서 **여성 니즈, 직장인 불편함, 실생활 고민 패턴**을 추출하여
빈이 채널(@duribeon231)의 콘텐츠 소재로 활용한다.

분석은 Claude가 직접 수행 (API 비용 $0):
1. 수집된 글/댓글 읽기
2. 반복되는 불편함/고민 키워드 추출
3. 빈이 스타일(직장인 자취생, 자조유머, 솔직후기)로 변환 가능한 소재 선정
