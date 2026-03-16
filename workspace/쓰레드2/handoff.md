# Threads 파이프라인 개선 — Handoff

> 2026-03-16 기준. 각 Phase는 독립적으로 병렬 작업 가능.

## 현재 상태

- 137개 포스트 수집 완료 (소비자 키워드 기반)
- 분석 파이프라인 1회 실행 완료: 니즈 9개, 매칭 4개, 콘텐츠 4개
- DB: PGlite (로컬), Drizzle ORM
- 텔레그램 봇 연결 완료 (`@threads_kr_bot`, .env에 토큰/채팅ID 저장됨)

## 발견된 문제

1. 셀프댓글 전부 "좋은 정보 감사합니다!" — 제휴링크 미삽입
2. 포맷 전부 "문제공감형" — 6가지 중 1개만 사용
3. 건강식품으로 카테고리 편향 — 뷰티/주방/생활 니즈 미추출
4. 상품사전 50개로 매칭 실패 5/9 → **실시간 검색으로 전환 결정**
5. snapshot.ts의 clicks/conversions/revenue 하드코딩 0
6. topic_tags, 정확한 포스트 날짜 미수집
7. DB `threads_post_id` 컬럼 누락 에러

## 운영 규칙 (반드시 준수)

- **워밍업**: 첫 20개 포스트는 광고/셀프댓글 없이 순수 콘텐츠만 발행
- **상품사전 폐지**: 정적 products_v1.json → 니즈 기반 실시간 쿠팡/네이버 검색
- **파트너스 링크**: 쿠팡 제품 링크를 사용자에게 텔레그램으로 전달 → 사용자가 파트너스에서 링크 생성 → 시스템에 입력

---

## Phase 1: 수집 개선 (collect.ts + DB 스키마)

**목표**: topic_tags, 정확한 날짜, 조회수를 수집할 수 있도록 개선

### Task 1-1: DB 스키마 수정
- `thread_posts` 테이블에 컬럼 추가:
  - `topic_tags TEXT[]` — Threads 네이티브 주제 태그 (raw)
  - `topic_category TEXT` — 분류된 주제 카테고리 (배치 분류 후 UPDATE)
- `content_lifecycle` 테이블에 컬럼 추가:
  - `threads_post_id TEXT` — 발행된 포스트 ID
  - `threads_post_url TEXT` — 발행된 포스트 URL
- `post_snapshots` 테이블에 컬럼 추가:
  - `post_views INTEGER` — 본문 조회수
  - `comment_views INTEGER` — 셀프댓글 조회수
- 파일: `src/db/schema.ts`, `src/types.ts`

### Task 1-2: collect.ts — topic_tags + 날짜 수집
- 피드 스크롤 시 포스트 헤더에서 추출:
  - `username > 주제태그 날짜` 패턴 파싱
  - 주제태그 없는 경우 null
  - 상대 날짜("6일") → 절대 날짜 변환
  - 절대 날짜("2025-03-26") → 그대로 저장
- DOM 패턴 참고 (스크린샷 기반):
  - `작성자 > 주제태그 날짜` (태그 있는 경우)
  - `작성자 상대시간` (태그 없는 경우)
- 파일: `src/scraper/collect.ts`

### Task 1-3: collect.ts — 조회수 수집
- 현재: 포스트 상세 페이지 방문 시 좋아요/댓글/리포스트만 수집
- 변경: 상단 "스레드 조회 N회" 텍스트도 추출하여 `view_count`에 저장
- DOM 위치: 포스트 상세 페이지 상단 중앙 "스레드" 아래 "조회 X회" 또는 "조회 X천회" / "조회 X만회"
- 파일: `src/scraper/collect.ts`

---

## Phase 2: 분류 + 파이프라인 개선

**목표**: TopicCategory 배치 분류 → 카테고리별 그룹 분석

### Task 2-1: TopicCategory 타입 정의
- `src/types.ts`에 추가:
```typescript
export type TopicCategory =
  | '건강' | '뷰티' | '다이어트' | '운동' | '생활' | '주방'
  | '디지털' | '육아' | '인테리어' | '패션' | '식품' | '문구' | '향수' | '기타';
```

### Task 2-2: topic-classifier.ts (신규)
- 위치: `src/analyzer/topic-classifier.ts`
- 입력: `topic_category = null`인 포스트 배치 (50~100개)
- 처리:
  1. `topic_tags`가 있으면 규칙 매핑 (빈번 태그 ~50개 테이블)
  2. 매핑 실패 or 태그 없음 → Haiku 배치 호출 (본문 + topic_tags → TopicCategory)
  3. DB UPDATE: `topic_category` 채움
- 비용 목표: $0.01~0.05/일 (300포스트 기준)

### Task 2-3: pipeline.ts — 카테고리별 그룹 분석
- 기존: 100개 포스트를 통째로 Researcher에게 전달
- 변경:
  1. Step 0: Topic Classification (Task 2-2 호출)
  2. Step 1: TopicCategory별로 그룹핑
  3. Step 2: 각 그룹별로 Researcher → Needs-detector 실행
  4. 이후 단계는 동일
- 파일: `src/analyzer/pipeline.ts`

---

## Phase 3: 제품 검색 + 콘텐츠 개선

**목표**: 실시간 제품 검색, 포맷 다양화, 셀프댓글 품질 개선

### Task 3-1: 실시간 제품 검색 (product-matcher.ts 교체)
- 기존: `products_v1.json` 정적 사전에서 검색
- 변경: 니즈 기반으로 쿠팡 웹 검색 → 상위 제품 추출
- 흐름:
  1. 니즈에서 검색 키워드 추출 (AI 또는 규칙)
  2. 쿠팡 웹 검색 (Playwright or HTTP)
  3. 상위 3~5개 제품 추출 (이름, 가격, URL)
  4. 텔레그램으로 사용자에게 전달: "이 제품의 파트너스 링크를 만들어주세요"
  5. 사용자가 파트너스 링크 입력 → DB 저장 → 콘텐츠 생성 진행
- 파일: `src/analyzer/product-matcher.ts` (교체)

### Task 3-2: content-generator.ts 개선
- **포맷 다양화**: 6가지 포맷(문제공감형/솔직후기형/비교형/입문추천형/실수방지형/비추천형)을 라운드로빈 또는 니즈 성격에 맞게 선택
- **셀프댓글 품질**: 워밍업(post_count < 20)이면 셀프댓글 생략. 이후에는:
  - 자연스러운 후기 톤 + 제휴링크 포함
  - "좋은 정보 감사합니다" 같은 무의미한 댓글 금지
- **훅 품질**: 제품명 직접 노출 금지, 니즈/공감 중심 훅
- 파일: `src/analyzer/content-generator.ts`

---

## Phase 4: 추적 + 알림

**목표**: 조회수 기반 전환율 측정, 텔레그램 알림 시스템

### Task 4-1: snapshot.ts — 조회수 기반 전환율
- 기존: `clicks = 0, conversions = 0, revenue = 0` 하드코딩
- 변경:
  - 포스트 상세 페이지 방문 → "조회 N회" 추출 → `post_views`
  - 셀프댓글 상세 페이지 방문 → "조회 N회" 추출 → `comment_views`
  - 전환율 프록시: `comment_views / post_views`
  - `clicks` 필드에 `comment_views` 저장 (제휴링크 노출 수의 프록시)
- 파일: `src/tracker/snapshot.ts`

### Task 4-2: 텔레그램 알림 모듈 (신규)
- 위치: `src/utils/telegram.ts`
- 기능:
  - `sendAlert(message)` — 일반 알림
  - `sendProductRequest(needInfo, coupangLinks)` — 파트너스 링크 요청
  - `sendErrorAlert(error)` — 크롤 에러/차단 알림
  - `sendWeeklyReport(stats)` — 주간 리포트
- 환경변수: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (.env)
- 파일: `src/utils/telegram.ts`

### Task 4-3: 파이프라인에 텔레그램 연동
- pipeline.ts: 각 단계 완료/에러 시 알림
- product-matcher.ts: 제품 발견 시 쿠팡 링크 + 파트너스 요청 전송
- orchestrator.ts: 크롤 에러/차단 감지 시 긴급 알림
- scheduler.ts: 워밍업 20개 완료 알림
- 파일: 각 모듈에 telegram import 추가

---

## Phase 간 의존성

```
Phase 1 (수집) ──→ Phase 2 (분류/파이프라인)
                        ↓
Phase 3 (제품/콘텐츠) ←─┘
                        ↓
Phase 4 (추적/알림) ←───┘

단, Phase 4의 텔레그램 모듈(Task 4-2)은 독립적으로 먼저 작업 가능
```

## 기술 스택

- Runtime: Node.js + tsx
- DB: PGlite (로컬) + Drizzle ORM
- Scraping: Playwright (CDP, port 9223)
- LLM: Anthropic API (Haiku/Sonnet)
- Notification: Telegram Bot API
- Test: Vitest
