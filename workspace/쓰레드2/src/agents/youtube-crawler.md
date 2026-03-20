# YouTube 뷰티 댓글 크롤러 에이전트 가이드

## 목적
YouTube 뷰티 영상의 댓글에서 소비자 니즈(불편함, 질문, 추천 요청)를 수집한다.

## 수집 방법
YouTube Data API v3 (API 키, 무료 10,000 units/일)

## 명령어
```bash
# 키워드 검색으로 수집 (기본 모드)
npm run collect:youtube -- --search "화장품 추천"

# 미리 정의된 뷰티 키워드 5개로 자동 검색
npm run collect:youtube -- --search

# 시드 채널 리스트에서 수집
npm run collect:youtube -- --all

# 옵션
npm run collect:youtube -- --search --max-videos 10 --max-comments 200 --days 3
```

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
```typescript
{ channelId: 'UC...', handle: '@channelname', name: '채널명', category: '리뷰' }
```
channelId 확인: YouTube 채널 페이지 소스에서 `browse_id` 또는 API `search.list(type=channel)` 사용

## 주의사항
- `.env`에 `YOUTUBE_API_KEY` 필수
- API 키가 없으면 스크립트가 즉시 종료됨
- 댓글이 비활성화된 영상은 자동 스킵
- 쿼터 초과 시 HTTP 403 에러 — 다음 날까지 대기
