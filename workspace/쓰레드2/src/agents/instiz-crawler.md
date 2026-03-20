# 인스티즈 크롤러 에이전트

## 역할

instiz.net(인스티즈) 게시판에서 여성 니즈 발굴용 포스트를 수집한다.
수집된 데이터는 `community_posts` 테이블에 저장하여 분석 파이프라인에서 활용한다.

## 게시판

| 게시판 | URL | 특징 |
|--------|-----|------|
| `name_beauty` | instiz.net/name_beauty | 뷰티 전용 — 여성 니즈 수집 최적 |
| `pt` | instiz.net/pt | 인기글 — 다양한 주제, 높은 반응 |

## 수집 명령

```bash
# 뷰티 게시판 10개 수집
npx tsx scripts/collect-instiz.ts --board name_beauty --pages 1 --limit 10

# 뷰티 게시판 3페이지 댓글 포함 수집
npx tsx scripts/collect-instiz.ts --board name_beauty --pages 3 --comments

# 인기글 20개 수집
npx tsx scripts/collect-instiz.ts --board pt --pages 2 --limit 20

# npm 스크립트 사용
npm run collect:instiz -- --board name_beauty --pages 1 --limit 10
```

## 파일 구조

```
src/scraper/instiz/
  types.ts      — 타입 정의 (InstizListItem, InstizArticle, InstizComment 등)
  fetcher.ts    — HTTP 요청 (fetchListPage, fetchDetailPage, requestDelay)
  parser.ts     — HTML 파싱 (parseListPage, parseDetailPage, parseComments)
  collector.ts  — 수집 오케스트레이터 (collectInstiz, saveToDb)

scripts/
  collect-instiz.ts  — CLI 진입점
```

## 핵심 선택자

| 대상 | 선택자 |
|------|--------|
| 목록 링크 | `td.listsubject a` |
| 본문 | `div#memo_content_1` |
| 조회수 | `span#hit` |
| 댓글 | `.memo_list li`, `.comment_list li` 등 |

## DB 저장 형식

```
community_posts:
  id: 'instiz_{documentId}'
  source_platform: 'instiz'
  source_cafe: 'instiz_name_beauty' | 'instiz_pt'
  source_url: 'https://www.instiz.net/{board}/{documentId}'
  title, body, comments, view_count, like_count, comment_count
  analyzed: false  (분석 파이프라인 대기)
```

## 특이사항

- **Cloudflare 없음**: HTTP fetch로 직접 수집 가능 (Playwright 불필요)
- **SSR**: 댓글 포함 HTML이 서버에서 렌더링됨 (AJAX API 없음)
- **로그인 불필요**: 본문 + 댓글 모두 비로그인으로 접근 가능
- **anti-bot**: 요청 사이 1~2초 랜덤 딜레이 적용

## 수집 주기 권장

- 뷰티 게시판: 매일 1회, 2~3페이지 (40~60개)
- 인기글: 주 2~3회, 1~2페이지 (20~40개)
