# 채널/콘텐츠 발굴 가이드 — 검색 발굴 + 브라우저 검증 패턴

## 핵심 원칙

**발굴은 검색 API, 검증만 브라우저.**

```
❌ 기존 (느림, 토큰 낭비)
Playwright → Threads 검색 → 결과 클릭 → 프로필 확인 → 뒤로가기 → 반복
= 모든 과정을 브라우저로 → 채널 1개당 5분+

✅ 현재 (빠름, 효율적)
Exa/웹 검색 → 후보 리스트 수집 (30초)
→ 검증 스크립트 → Playwright로 실데이터 확인 (채널당 30초)
→ 통과한 것만 DB 등록
= 발굴과 검증 분리 → 21개 채널 13분
```

## 사용 시나리오

### 1. 벤치마크 채널 추가

**Step 1: 웹 검색으로 후보 발굴**
```
Exa 검색 (mcp__exa__web_search_exa) 또는 Agent(general-purpose)에게 위임:
- "쓰레드 건강 영양제 추천 계정"
- "threads 뷰티 인플루언서 한국"
- "쓰레드 생활용품 꿀템 계정"

→ 블로그, 유튜브, 기사에서 언급된 계정명 수집
→ 카테고리별 7개씩 후보 리스트 작성
```

**Step 2: 브라우저로 채널 직접 확인 (필수 — 생략 금지)**

collect.ts 실행 전에 반드시 Playwright로 채널을 방문하여 포스트를 직접 확인한다.

```
벤치마크 채널 선정 시:
1. threads.net/@채널명 방문 (Playwright browser_navigate)
2. 스크롤하여 10개 포스트 확인 (browser_snapshot 또는 스크롤)
3. AI가 아래 기준으로 판단:
   - 포스트 주제가 우리 카테고리(뷰티/건강/생활/다이어트/식품/인테리어)에 맞는가?
   - 제품 추천/후기 콘텐츠가 30% 이상인가?
   - 비전문가/친구 톤인가? (전문가 강의 톤 → 탈락)
   - 최근 2주 이내 포스팅이 3개 이상인가?
4. 기준 충족 → Step 3 수집 진행
5. 기준 미충족 → 스킵 + 이유 기록

일반 수집 시:
1. threads.net/@채널명 방문
2. 상위 5개 포스트 확인
3. 오늘 기준 24시간 이내 포스트가 1개 이상 → 수집
4. 24h 이내 포스트 없음 → 수집 스킵 (비활성)
```

**절대 금지**: collect.ts 맹목 실행 (브라우저 확인 없이)

**Step 3: collect.ts로 수집 (셸 루프)**

브라우저 확인을 통과한 채널만 수집한다. 5개 이상 채널 시 셸 루프 사용.

```bash
# 셸 루프로 순차 수집 (채널당 30개 포스트)
CHANNELS="yaksamom alpaca_yaksa yak_secret ..."

for ch in $CHANNELS; do
  echo "수집 중: @$ch"
  npx tsx src/scraper/collect.ts "$ch" 30 2>&1
  sleep $((RANDOM % 6 + 5))  # anti-bot 대기
done
```

- `collect.ts`가 GraphQL 인터셉터 + DOM 폴백 + DB 저장을 전부 처리
- 새 검증/수집 스크립트를 작성하지 않는다
- 수집 결과는 `thread_posts` 테이블에 자동 저장
- **파이프 금지** — `| tail`, `| head` 걸지 마. `2>&1`만 사용

**Step 4: DB 데이터로 검증 판단**

수집 완료 후 DB 쿼리로 검증:
```sql
SELECT channel_id, COUNT(*) as posts,
       AVG(view_count) as avg_views,
       AVG(like_count) as avg_likes,
       AVG(reply_count) as avg_replies
FROM thread_posts
WHERE channel_id IN ('yaksamom', 'alpaca_yaksa', ...)
GROUP BY channel_id
ORDER BY avg_replies DESC;
```

통과 기준:
- 수집 성공 (포스트 10개 이상)
- 최근 1개월 이내 활동
- 참여율 > 0.5%

통과한 채널 → `channels` 테이블에 `is_benchmark=true`로 등록

### 2. 트렌드 키워드 → 콘텐츠 수집

**Step 1: 트렌드 키워드 수집 (API)**
```bash
npx tsx src/scraper/trend-fetcher.ts
# → Apify API로 X 한국 트렌드 99개 수집 ($0.04)
# → trend_keywords 테이블에 전부 저장
```

**Step 2: AI 필터 + 웹 검색 보강**
```bash
npx tsx src/scraper/trend-filter.ts
# → 규칙 기반 필터 (뷰티/건강/생활 매핑)
# → trend_keywords에 selected=true/false 마킹
```

필터 통과율이 낮을 때 (99개 중 1~2개만 통과):
```
Exa 검색으로 보강:
- 통과한 키워드 + "추천" "후기" "써봤는데"로 검색
- Threads에서 이미 다뤄지고 있는 주제인지 확인
- 관련 채널/포스트 URL 수집
→ 검색에서 찾은 URL만 Playwright로 방문해서 포스트 수집
```

**Step 3: Playwright는 수집만**
```bash
npx tsx scripts/collect-by-keyword.ts --keywords "미세먼지 피부,선크림 추천" --posts-per-keyword 10
# → 필터된 키워드로 Threads 검색 → 포스트 수집
# → thread_posts 테이블에 저장 (run_id = 'search_*')
```

### 3. 경쟁 채널 조사

**Step 1: 웹 검색으로 경쟁자 파악**
```
Exa 검색:
- "쓰레드 쿠팡파트너스 수익 후기"
- "threads 제휴마케팅 계정 추천"
→ 비슷한 전략을 쓰는 채널 리스트 수집
```

**Step 2: 검증 스크립트로 실데이터 확인**
```
CHANNELS 배열에 추가 → 스크립트 실행
→ 참여율, 제휴 비율, 콘텐츠 스타일 비교
```

## 비용 비교

| 방식 | 채널 발굴 | 검증 | 총 시간 (21개) | 토큰 |
|------|----------|------|--------------|------|
| 전체 Playwright | 브라우저 검색+클릭 | 브라우저 스크롤 | ~2시간 | 매우 많음 |
| **검색+검증 분리** | Exa/웹 검색 | 스크립트 자동화 | **~15분** | 적음 |

## 스크립트 위치

| 파일 | 용도 |
|------|------|
| `scripts/verify-benchmark-channels.ts` | 벤치마크 채널 검증 (30+ 포스트 스크롤) |
| `src/scraper/trend-fetcher.ts` | X 트렌드 수집 (Apify) |
| `src/scraper/trend-filter.ts` | 트렌드 필터 + DB 마킹 |
| `scripts/collect-by-keyword.ts` | 키워드로 Threads 포스트 수집 |
| `scripts/run-trend-pipeline.ts` | 트렌드 → 수집 전체 파이프라인 |

## 채널 선정 기준 (2026-03-25 확립)

### 필수 조건 (모두 충족)
1. **수집 성공**: collect.ts로 10개+ 포스트 수집
2. **활동성**: 최근 2주 내 포스팅 있음
3. **참여율**: > 0.5% (댓글 기준)
4. **카테고리 정렬**: 빈이 활성 카테고리(뷰티/건강/식품/생활/인테리어) 해당
5. **카테고리 포화도**: 해당 카테고리 벤치마크 < 10개

### 가산점 (우선 승인)
- 댓글 평균 5개+
- 비전문가/친구 톤 (전문가 계정은 별도 태깅)
- 제품 추천/후기형 콘텐츠 비율 30%+
- 팔로워 5K~20K (빈이 참고 가능 규모)
- 주 3회+ 포스팅

### 카테고리별 가드레일
| 카테고리 | 최소 | 최대 | 비고 |
|---------|------|------|------|
| 뷰티 | 5 | 10 | 과포화 주의 |
| 건강 | 5 | 10 | 약사 채널은 expert 태깅 |
| 식품 | 3 | 7 | 신규 확보 필요 |
| 생활 | 5 | 8 | 유지 |
| 다이어트 | 3 | 5 | 축소됨 |
| 인테리어 | 3 | 5 | 신규 확보 필요 |

### 자동 퇴출 조건
- 30일간 신규 포스트 0개 → retired
- evaluate-channels.ts 하위 20% (카테고리 최소 3개 보호)
- 실행: `npx tsx scripts/evaluate-channels.ts --apply`

### 포화도 확인
```bash
npx tsx scripts/evaluate-channels.ts --check-limits
```

---

## 핵심 규칙

1. **Playwright는 "확인된 URL 방문"에만 사용** — 탐색/검색은 API로
2. **웹 검색 결과는 반드시 검증** — 계정 존재, 활동 여부, 팔로워 확인
3. **30개 이상 포스트 수집** — 최근 포스트 몇 개만 보면 편향 발생
4. **anti-bot 필수** — 채널 간 5~10초, 스크롤 시 랜덤 딜레이
5. **기존 도구를 재사용한다 — 새 스크립트 만들지 않는다**
   - 채널 수집: `collect.ts` (GraphQL 인터셉터 + DOM 폴백 + DB 저장)
   - 키워드 수집: `collect-by-keyword.ts`
   - 새 검증/수집 스크립트를 처음부터 작성하지 않는다
6. **검증 = collect.ts로 30개 수집 후 DB 데이터로 판단**
   ```bash
   # 채널 검증: 30개 포스트 수집 → DB에서 메트릭 확인
   npx tsx src/scraper/collect.ts <username> 30
   ```
   수집된 DB 데이터(view_count, like_count, reply_count)로 검증 판단:
   - 계정 존재: 수집 성공 여부
   - 활동 여부: timestamp 확인
   - 참여율/제휴 비율: DB 쿼리로 계산
