# 수집 시스템 리밸런싱 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 벤치마크 채널 편중(뷰티 58%) 해소, 수집 기준 확립, 건강/식품/인테리어 레퍼런스 채널 확보

**Architecture:** DB 직접 조작(유령 채널 정리, 가드레일) + evaluate-channels.ts 스코어링 개선 + Exa 검색 기반 신규 채널 발굴/검증. 기존 도구(collect.ts, evaluate-channels.ts)를 최대한 재사용하며, 새 스크립트는 만들지 않는다.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL (Supabase), Exa API, collect.ts (Playwright)

**현재 상태 (2026-03-25 기준):**
- 벤치마크 41개: 뷰티 24(58%), 건강 1(2%), 생활 6(15%), 다이어트 7(17%), 기타 3
- 유령 채널 9개 (포스트 0개, 전부 뷰티)
- post_source=null: 546개 (33%)
- 트렌드 키워드 활용률: 0.8% (847개 중 7개)
- 브랜드 이벤트 사용: 0/85
- 카테고리 '기타': 290개 (17%)

**목표 상태:**
- 벤치마크 ~30개: 뷰티 8, 건강 7, 식품 5, 생활 6, 다이어트 4, 인테리어 3
- 유령 채널 0개
- post_source=null < 5%
- 채널 선정 기준표 문서화 완료

---

## Chunk 1: 데이터 정리 (유령 채널 + post_source)

### Task 1: 유령 채널 9개 퇴출

**Files:**
- 없음 (DB 직접 조작)

**배경:** 포스트 0개인 벤치마크 채널 9개가 전부 뷰티. 이것만 정리하면 뷰티 24→15로 자연 감소.

유령 채널 목록:
```
hoo_hooahah, smile_._therapy, iguan_a9305, full_life_v,
woongs_daily__, dayoon.ii, angster_yum, nanahenao_, glow._.archive
```

- [ ] **Step 1: 유령 채널 현황 최종 확인**

```bash
cat > _ghost-check.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  const ghosts = await client`
    SELECT c.channel_id, c.category, c.benchmark_status,
           (SELECT COUNT(*) FROM thread_posts tp WHERE tp.channel_id = c.channel_id) as post_count
    FROM channels c
    WHERE c.is_benchmark = true
      AND NOT EXISTS (SELECT 1 FROM thread_posts tp WHERE tp.channel_id = c.channel_id)
  `;
  console.log('유령 채널 목록:');
  for (const g of ghosts) console.log(`  @${g.channel_id} | ${g.category} | status: ${g.benchmark_status} | posts: ${g.post_count}`);
  console.log(`\n총 ${ghosts.length}개`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _ghost-check.ts && rm _ghost-check.ts
```

Expected: 9개 채널 출력

- [ ] **Step 2: 유령 채널 retired 처리**

```bash
cat > _ghost-retire.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  const result = await client`
    UPDATE channels
    SET is_benchmark = false,
        benchmark_status = 'retired',
        notes = COALESCE(notes, '') || ' [2026-03-25] 포스트 0개로 자동 퇴출'
    WHERE is_benchmark = true
      AND NOT EXISTS (SELECT 1 FROM thread_posts tp WHERE tp.channel_id = channels.channel_id)
    RETURNING channel_id, category
  `;
  console.log('퇴출 완료:');
  for (const r of result) console.log(`  @${r.channel_id} (${r.category})`);
  console.log(`\n${result.length}개 채널 retired`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _ghost-retire.ts && rm _ghost-retire.ts
```

Expected: 9개 채널 retired, 뷰티 벤치마크 24→15

- [ ] **Step 3: 퇴출 결과 검증**

```bash
cat > _verify-retire.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  const active = await client`
    SELECT category, COUNT(*) as cnt
    FROM channels WHERE is_benchmark = true AND benchmark_status != 'retired'
    GROUP BY category ORDER BY cnt DESC
  `;
  console.log('벤치마크 현황 (retired 제외):');
  let total = 0;
  for (const r of active) { console.log(`  ${r.category}: ${r.cnt}개`); total += Number(r.cnt); }
  console.log(`총 ${total}개`);

  const ghosts = await client`
    SELECT COUNT(*) as cnt FROM channels
    WHERE is_benchmark = true AND benchmark_status != 'retired'
      AND NOT EXISTS (SELECT 1 FROM thread_posts tp WHERE tp.channel_id = channels.channel_id)
  `;
  console.log(`\n유령 채널: ${ghosts[0].cnt}개 (0이어야 함)`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _verify-retire.ts && rm _verify-retire.ts
```

Expected: 유령 채널 0개, 총 ~32개

- [ ] **Step 4: 커밋**

```bash
# DB 변경만이므로 코드 커밋 없음. strategy-log.md에 기록.
```

---

### Task 2: 포스트 0~2개인 저활동 벤치마크 추가 정리

**배경:** 유령(0개) 외에도 포스트 1~2개뿐인 채널이 있음 (orion_on82: 2개, da_on1426: 1개, shopia50000: 1개). 검증 기준(10개 이상) 미달.

- [ ] **Step 1: 포스트 10개 미만 벤치마크 확인**

```bash
cat > _low-post-check.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  const low = await client`
    SELECT c.channel_id, c.category, c.benchmark_status,
           (SELECT COUNT(*) FROM thread_posts tp WHERE tp.channel_id = c.channel_id) as post_count,
           (SELECT MAX(timestamp) FROM thread_posts tp WHERE tp.channel_id = c.channel_id) as last_post
    FROM channels c
    WHERE c.is_benchmark = true AND c.benchmark_status != 'retired'
      AND (SELECT COUNT(*) FROM thread_posts tp WHERE tp.channel_id = c.channel_id) < 10
    ORDER BY post_count ASC
  `;
  console.log('포스트 10개 미만 벤치마크:');
  for (const r of low) {
    console.log(`  @${r.channel_id} | ${r.category} | ${r.post_count}개 | 최신 ${r.last_post ? new Date(r.last_post).toLocaleDateString() : '없음'}`);
  }
  console.log(`\n총 ${low.length}개`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _low-post-check.ts && rm _low-post-check.ts
```

- [ ] **Step 2: 10개 미만 채널도 retired 처리**

Task 1 Step 2와 동일 패턴으로 포스트 10개 미만 + 최근 30일 활동 없는 채널 retired 처리.

```bash
cat > _low-retire.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  const result = await client`
    UPDATE channels
    SET is_benchmark = false,
        benchmark_status = 'retired',
        notes = COALESCE(notes, '') || ' [2026-03-25] 포스트 10개 미만으로 퇴출'
    WHERE is_benchmark = true AND benchmark_status != 'retired'
      AND (SELECT COUNT(*) FROM thread_posts tp WHERE tp.channel_id = channels.channel_id) < 10
      AND (SELECT MAX(timestamp) FROM thread_posts tp WHERE tp.channel_id = channels.channel_id) < NOW() - INTERVAL '30 days'
    RETURNING channel_id, category
  `;
  console.log('퇴출 완료:');
  for (const r of result) console.log(`  @${r.channel_id} (${r.category})`);
  console.log(`${result.length}개 retired`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _low-retire.ts && rm _low-retire.ts
```

- [ ] **Step 3: 검증 — 카테고리별 현황 확인**

Task 1 Step 3과 동일 검증 스크립트 실행. 뷰티가 15 이하로 감소했는지 확인.

---

### Task 3: post_source=null 역추적 + 태깅

**배경:** 546개 포스트(33%)의 post_source가 null. 벤치마크 채널에서 수집된 건 'benchmark'로, 나머지는 수집 시점 기반으로 추정 태깅.

- [ ] **Step 1: null 포스트 중 벤치마크 채널에서 온 것 확인**

```bash
cat > _null-source-check.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  // 벤치마크 채널에서 온 null 소스 포스트
  const benchNull = await client`
    SELECT COUNT(*) as cnt FROM thread_posts tp
    WHERE tp.post_source IS NULL
      AND EXISTS (SELECT 1 FROM channels c WHERE c.channel_id = tp.channel_id AND c.is_benchmark = true)
  `;
  // 전체 null 소스
  const totalNull = await client`SELECT COUNT(*) as cnt FROM thread_posts WHERE post_source IS NULL`;
  // 나머지
  const otherNull = Number(totalNull[0].cnt) - Number(benchNull[0].cnt);

  console.log(`post_source=null 총: ${totalNull[0].cnt}개`);
  console.log(`  벤치마크 채널에서 수집: ${benchNull[0].cnt}개 → 'benchmark'로 백필`);
  console.log(`  기타 채널에서 수집: ${otherNull}개 → 'legacy'로 태깅`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _null-source-check.ts && rm _null-source-check.ts
```

- [ ] **Step 2: post_source enum에 'legacy' 값 추가**

`postSourceEnum`은 pgEnum이므로 정의에 없는 값을 INSERT/UPDATE하면 DB 에러. 먼저 enum에 'legacy' 추가.

```bash
cat > _add-legacy-enum.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  await client`ALTER TYPE post_source ADD VALUE IF NOT EXISTS 'legacy'`;
  console.log('post_source enum에 legacy 추가 완료');
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _add-legacy-enum.ts && rm _add-legacy-enum.ts
```

그리고 `src/db/schema.ts`의 postSourceEnum도 동기화:

```typescript
// src/db/schema.ts:139
export const postSourceEnum = pgEnum('post_source', [
  'brand',
  'keyword_search',
  'x_trend',
  'benchmark',
  'legacy',  // 추가: 소스 미분류 레거시 포스트
]);
```

- [ ] **Step 3: 벤치마크 채널 포스트 → post_source='benchmark' 백필**

```bash
cat > _backfill-source.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  const r1 = await client`
    UPDATE thread_posts SET post_source = 'benchmark'
    WHERE post_source IS NULL
      AND EXISTS (SELECT 1 FROM channels c WHERE c.channel_id = thread_posts.channel_id AND c.is_benchmark = true)
  `;
  console.log(`benchmark 태깅: ${r1.count}개`);

  const r2 = await client`
    UPDATE thread_posts SET post_source = 'legacy'
    WHERE post_source IS NULL
  `;
  console.log(`legacy 태깅: ${r2.count}개`);

  const verify = await client`SELECT COUNT(*) as cnt FROM thread_posts WHERE post_source IS NULL`;
  console.log(`\nnull 잔여: ${verify[0].cnt}개 (0이어야 함)`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _backfill-source.ts && rm _backfill-source.ts
```

Expected: null 잔여 0개

- [ ] **Step 5: post_source NOT NULL 제약 추가**

DB 마이그레이션으로 NOT NULL 제약 추가. 향후 소스 미태깅 수집을 원천 차단.

```bash
cat > _add-notnull.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  await client`ALTER TABLE thread_posts ALTER COLUMN post_source SET NOT NULL`;
  console.log('post_source NOT NULL 제약 추가 완료');

  // 스키마 확인
  const cols = await client`
    SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'thread_posts' AND column_name = 'post_source'
  `;
  console.log(`post_source nullable: ${cols[0].is_nullable} (NO여야 함)`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _add-notnull.ts && rm _add-notnull.ts
```

- [ ] **Step 6: 스키마 파일 동기화**

```
Modify: src/db/schema.ts:~해당 라인
```

`thread_posts` 테이블의 `post_source` 필드에 `.notNull()` 추가하여 drizzle 스키마와 DB를 동기화.

- [ ] **Step 7: 커밋**

```bash
git add src/db/schema.ts
git commit -m "fix(db): add legacy to post_source enum, backfill nulls, add NOT NULL constraint"
```

---

## Chunk 2: 벤치마크 가드레일 + 스코어링 개선

### Task 4: evaluate-channels.ts 스코어링 개선

**Files:**
- Modify: `scripts/evaluate-channels.ts`

**배경:** 현재 스코어링 `avg_views * 0.4 + avg_engagement * 100 * 0.3 + post_frequency * 0.3`은 조회수에 편향. 제휴마케팅 목적에 맞게 댓글(구매 의향 시그널) 가중치를 높인다.

- [ ] **Step 1: 새 스코어링 산식 설계**

변경 전:
```
score = avg_views * 0.4 + avg_engagement * 100 * 0.3 + post_frequency * 0.3
```

변경 후:
```
score = avg_views * 0.25 + avg_replies * 50 * 0.30 + avg_engagement * 100 * 0.25 + post_frequency * 0.20
```

핵심 변경:
- `avg_replies` 가중치 30%로 신설 (댓글 = 구매 관심/대화 유발 = Threads 알고리즘 부스트)
- `avg_views` 40% → 25%로 감소 (조회수만 높고 참여 없는 채널 불이익)
- `post_frequency` 30% → 20%로 감소 (저빈도 고참여 채널도 살릴 수 있게)

- [ ] **Step 2: evaluate-channels.ts 수정**

`scripts/evaluate-channels.ts:50-80` 영역 수정:

```typescript
// stats 쿼리에 avg_replies 추가
const stats = await db.execute(sql`
  SELECT
    count(*) as post_count,
    coalesce(avg(view_count), 0) as avg_views,
    coalesce(avg(reply_count), 0) as avg_replies,
    coalesce(avg(
      CASE WHEN coalesce(view_count, 0) > 0
        THEN (coalesce(like_count, 0) + coalesce(reply_count, 0) + coalesce(repost_count, 0))::numeric / view_count
        ELSE 0
      END
    ), 0) as avg_engagement
  FROM thread_posts
  WHERE channel_id = ${channelId}
    AND crawl_at < NOW() - INTERVAL '2 days'
`);

// 새 스코어링
const avgReplies = parseFloat(s.avg_replies) || 0;
const score = avgViews * 0.25 + avgReplies * 50 * 0.30 + avgEng * 100 * 0.25 + postFreq * 0.20;
```

ChannelScore 인터페이스에 `avg_replies: number` 추가. 출력 테이블에도 댓글 컬럼 추가.

- [ ] **Step 3: 카테고리별 보호 로직 추가**

`evaluate-channels.ts`의 `--apply` 로직에 카테고리당 최소 3개 보호 규칙 추가:

```typescript
if (applyMode) {
  // 카테고리별 현재 수 확인
  const catCounts = new Map<string, number>();
  for (const s of scores) {
    const cat = /* channels 테이블에서 조회 */ '';
    catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
  }

  for (const s of bottomChannels) {
    const cat = /* 해당 채널의 카테고리 */;
    const remaining = catCounts.get(cat) || 0;
    if (remaining <= 3) {
      console.log(`  ⚠️ ${s.name} (${cat}) — 카테고리 최소 3개 보호로 스킵`);
      continue;
    }
    // retired 처리
    catCounts.set(cat, remaining - 1);
  }
}
```

- [ ] **Step 4: 카테고리 상한 체크 추가 (등록 시)**

스크립트에 `--check-limits` 플래그 추가. 새 채널 등록 전 카테고리 포화도 확인:

```typescript
if (args.includes('--check-limits')) {
  const limits = await db.execute(sql`
    SELECT category, COUNT(*) as cnt
    FROM channels WHERE is_benchmark = true AND benchmark_status != 'retired'
    GROUP BY category ORDER BY cnt DESC
  `);
  console.log('\n카테고리 가드레일:');
  for (const r of limits) {
    const cnt = Number((r as any).cnt);
    const status = cnt >= 10 ? '🔴 상한 초과' : cnt >= 8 ? '🟡 거의 포화' : '🟢 여유';
    console.log(`  ${(r as any).category}: ${cnt}개 ${status} (상한 10)`);
  }
}
```

- [ ] **Step 5: 테스트 — dry-run 실행**

```bash
npx tsx scripts/evaluate-channels.ts --check-limits
npx tsx scripts/evaluate-channels.ts --top 10
```

Expected: 새 스코어링 반영된 결과 출력, 카테고리 가드레일 표시

- [ ] **Step 6: 커밋**

```bash
git add scripts/evaluate-channels.ts
git commit -m "feat(evaluate): reply-weighted scoring + category guardrails"
```

---

## Chunk 3: 건강/식품 채널 발굴 + 검증

### Task 5: 건강 카테고리 채널 발굴 (목표: 7개)

**Files:**
- 없음 (Exa 검색 + collect.ts 기존 도구 사용)

**배경:** 건강 벤치마크 현재 1개(yaksa_tipbox). 참여율 TOP 외부 채널에 ez_yaksa(38댓), manyjjju_yaksa(7댓), alpaca_yaksa(8댓)이 이미 수집되어 있으나 벤치마크 미등록.

- [ ] **Step 1: DB에 이미 있는 건강 고참여 채널 확인**

```bash
cat > _health-candidates.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  // 이미 수집된 건강 관련 채널 중 벤치마크 아닌 것
  const candidates = await client`
    SELECT tp.channel_id, COUNT(*) as posts,
           ROUND(AVG(tp.view_count)) as avg_views,
           ROUND(AVG(tp.reply_count)) as avg_replies,
           MAX(tp.timestamp) as last_post,
           c.is_benchmark, c.category
    FROM thread_posts tp
    LEFT JOIN channels c ON c.channel_id = tp.channel_id
    WHERE tp.topic_category IN ('건강', '식품')
      AND tp.view_count > 0
    GROUP BY tp.channel_id, c.is_benchmark, c.category
    HAVING COUNT(*) >= 10 AND AVG(tp.reply_count) >= 3
    ORDER BY AVG(tp.reply_count) DESC
    LIMIT 20
  `;
  console.log('건강/식품 고참여 채널 (벤치마크 후보):');
  for (const r of candidates) {
    const mark = r.is_benchmark ? '✅벤치' : '⬜후보';
    console.log(`  ${mark} @${r.channel_id} | ${r.posts}포스트 | ${r.avg_views}뷰 | ${r.avg_replies}댓 | 최신 ${new Date(r.last_post).toLocaleDateString()}`);
  }
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _health-candidates.ts && rm _health-candidates.ts
```

- [ ] **Step 2: 이미 검증된 채널 벤치마크 등록**

DB에 이미 10개+ 포스트가 있고 참여율 높은 채널(ez_yaksa, manyjjju_yaksa, alpaca_yaksa 등)을 벤치마크로 승격:

```bash
cat > _promote-health.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  // Step 1에서 확인된 후보 채널 ID 입력 (실행 시 결과 보고 결정)
  const candidates = ['ez_yaksa', 'manyjjju_yaksa', 'alpaca_yaksa']; // Step 1 결과에 따라 조정

  for (const ch of candidates) {
    // channels 테이블에 없으면 INSERT, 있으면 UPDATE
    await client`
      INSERT INTO channels (channel_id, display_name, source_keyword, is_benchmark, benchmark_status, category)
      VALUES (${ch}, ${ch}, 'auto-promote', true, 'verified', '건강')
      ON CONFLICT (channel_id) DO UPDATE SET
        is_benchmark = true,
        benchmark_status = 'verified',
        category = '건강',
        notes = COALESCE(channels.notes, '') || ' [2026-03-25] 고참여 기반 벤치마크 승격'
    `;
    console.log(`✅ @${ch} 벤치마크 등록 (건강)`);
  }
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _promote-health.ts && rm _promote-health.ts
```

- [ ] **Step 3: Exa 검색으로 추가 건강 채널 후보 발굴**

Exa MCP 도구로 검색:
```
검색어 목록:
- "쓰레드 영양제 추천 계정"
- "threads 건강 꿀팁 한국"
- "쓰레드 자취 건강 루틴"
- "threads 비타민 추천 후기 계정"
```

결과에서 @ 사용자명 추출 → 후보 리스트 작성.

**필터 기준:**
- 비전문가 톤 (약사/의사 계정은 별도 'expert' 태깅)
- 팔로워 1K~50K 범위
- 최근 2주 내 포스팅 활동

- [ ] **Step 4: collect.ts로 후보 채널 검증 수집**

```bash
# 셸 루프로 순차 수집 (Step 3에서 발굴된 채널 ID 사용)
CHANNELS="candidate1 candidate2 candidate3"
for ch in $CHANNELS; do
  echo "=== 수집 중: @$ch ==="
  npx tsx src/scraper/collect.ts "$ch" 30 2>&1
  sleep $((RANDOM % 6 + 5))
done
```

- [ ] **Step 5: DB 데이터로 검증 판단**

```sql
SELECT channel_id, COUNT(*) as posts,
       AVG(view_count) as avg_views,
       AVG(reply_count) as avg_replies,
       MAX(timestamp) as last_post
FROM thread_posts
WHERE channel_id IN ('candidate1', 'candidate2', 'candidate3')
GROUP BY channel_id
ORDER BY AVG(reply_count) DESC;
```

통과 기준:
- 수집 성공 (포스트 10개 이상)
- 최근 1개월 이내 활동
- 참여율 > 0.5%
- 비전문가 톤 확인 (포스트 샘플 3개 읽기)

- [ ] **Step 6: 통과 채널 벤치마크 등록**

Step 2와 동일 패턴으로 검증 통과 채널을 `is_benchmark=true, benchmark_status='verified', category='건강'`으로 등록.

---

### Task 6: 식품 카테고리 채널 발굴 (목표: 5개)

**배경:** 식품 벤치마크 0개. 빈이 최고 성과(탕수육/버섯 15,000뷰)가 식품 인접. 벤치마크 0개는 소재 고갈의 직접 원인.

- [ ] **Step 1: DB에 이미 있는 식품 고참여 채널 확인**

Task 5 Step 1과 동일 패턴. `topic_category = '식품'` 필터.

- [ ] **Step 2: Exa 검색으로 식품 채널 발굴**

```
검색어:
- "쓰레드 자취 요리 추천 계정"
- "threads 간편식 편의점 추천"
- "쓰레드 밀프렙 한국"
- "threads 식품 꿀템 공유"
- "쓰레드 다이어트 식단 추천"
```

- [ ] **Step 3: collect.ts로 검증 수집**

Task 5 Step 4와 동일 패턴.

- [ ] **Step 4: 검증 + 벤치마크 등록**

Task 5 Step 5-6과 동일 패턴. `category='식품'`.

---

### Task 7: 인테리어 카테고리 채널 발굴 (목표: 3개)

**배경:** 인테리어 포스트 25개뿐인데 평균 좋아요 154, 댓글 17로 참여율 전체 최상위. 벤치마크 0개.

- [ ] **Step 1: DB에 이미 있는 인테리어 채널 확인**

```sql
SELECT channel_id, COUNT(*) as posts, AVG(view_count), AVG(reply_count)
FROM thread_posts WHERE topic_category = '인테리어'
GROUP BY channel_id ORDER BY AVG(reply_count) DESC;
```

- [ ] **Step 2: Exa 검색으로 인테리어 채널 발굴**

```
검색어:
- "쓰레드 자취방 인테리어 계정"
- "threads 집꾸미기 추천"
- "쓰레드 원룸 꾸미기"
```

- [ ] **Step 3: collect.ts 검증 + 벤치마크 등록**

Task 5와 동일 패턴. `category='인테리어'`.

---

## Chunk 4: 뷰티 축소 + 다이어트 정리 + 최종 검증

### Task 8: 뷰티 채널 15→8 축소

**배경:** 유령 9개 제거 후 뷰티 ~15개. 목표 8개로 추가 정리. `evaluate-channels.ts --apply`로 하위 정리.

- [ ] **Step 1: 뷰티 채널 스코어 확인**

```bash
npx tsx scripts/evaluate-channels.ts
```

뷰티 카테고리 채널의 새 스코어(댓글 가중치 반영) 확인.

- [ ] **Step 2: 하위 뷰티 채널 retired 처리**

뷰티 채널 중 스코어 하위 7개를 retired 처리. 단, 최소 8개는 잔류.

```bash
cat > _beauty-trim.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  // 뷰티 채널만 스코어순 정렬
  const beauty = await client`
    SELECT c.channel_id, c.display_name,
           COALESCE(AVG(tp.view_count), 0) as avg_views,
           COALESCE(AVG(tp.reply_count), 0) as avg_replies,
           COUNT(tp.post_id) as post_count
    FROM channels c
    LEFT JOIN thread_posts tp ON tp.channel_id = c.channel_id
    WHERE c.is_benchmark = true AND c.benchmark_status != 'retired'
      AND c.category LIKE '%뷰티%'
    GROUP BY c.channel_id, c.display_name
    ORDER BY AVG(tp.reply_count) DESC NULLS LAST
  `;

  const TARGET = 8;
  if (beauty.length <= TARGET) {
    console.log(`뷰티 채널 ${beauty.length}개 — 이미 목표(${TARGET}) 이하. 정리 불필요.`);
    await client.end();
    process.exit(0);
  }

  const keep = beauty.slice(0, TARGET);
  const retire = beauty.slice(TARGET);

  console.log(`잔류 (${keep.length}개):`);
  for (const r of keep) console.log(`  ✅ @${r.channel_id} | ${r.post_count}포스트 | ${Number(r.avg_replies).toFixed(1)}댓`);

  console.log(`\n퇴출 (${retire.length}개):`);
  for (const r of retire) console.log(`  ❌ @${r.channel_id} | ${r.post_count}포스트 | ${Number(r.avg_replies).toFixed(1)}댓`);

  // 퇴출 실행
  for (const r of retire) {
    await client`
      UPDATE channels SET is_benchmark = false, benchmark_status = 'retired',
        notes = COALESCE(notes, '') || ' [2026-03-25] 뷰티 리밸런싱으로 퇴출'
      WHERE channel_id = ${r.channel_id}
    `;
  }
  console.log(`\n${retire.length}개 retired 완료`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _beauty-trim.ts && rm _beauty-trim.ts
```

- [ ] **Step 3: 검증**

카테고리별 벤치마크 수 최종 확인.

---

### Task 9: 다이어트 채널 7→4 축소

**배경:** 다이어트 46개 포스트에 평균 댓글 2개. 7개 벤치마크는 과다. 4개로 축소.

- [ ] **Step 1: 다이어트 채널 스코어 확인 + 하위 3개 retired**

Task 8과 동일 패턴. `category = '다이어트'`, TARGET = 4.

---

### Task 10: 최종 벤치마크 현황 검증

- [ ] **Step 1: 전체 벤치마크 카테고리 분포 확인**

```bash
cat > _final-check.ts << 'SCRIPT'
import { client } from './src/db/index.js';
async function main() {
  const result = await client`
    SELECT category, COUNT(*) as cnt,
           ROUND(AVG((SELECT AVG(reply_count) FROM thread_posts tp WHERE tp.channel_id = c.channel_id))) as avg_cat_replies
    FROM channels c
    WHERE is_benchmark = true AND benchmark_status != 'retired'
    GROUP BY category ORDER BY cnt DESC
  `;

  let total = 0;
  console.log('=== 최종 벤치마크 현황 ===');
  console.log('| 카테고리 | 채널수 | 평균댓글 | 상태 |');
  console.log('|---------|--------|--------|------|');
  for (const r of result) {
    const cnt = Number(r.cnt);
    total += cnt;
    const status = cnt < 3 ? '🔴 부족' : cnt > 10 ? '🔴 초과' : '🟢 적정';
    console.log(`| ${r.category} | ${cnt} | ${r.avg_cat_replies || '-'} | ${status} |`);
  }
  console.log(`\n총 ${total}개`);

  // 유령 채널 확인
  const ghosts = await client`
    SELECT COUNT(*) as cnt FROM channels
    WHERE is_benchmark = true AND benchmark_status != 'retired'
      AND NOT EXISTS (SELECT 1 FROM thread_posts tp WHERE tp.channel_id = channels.channel_id)
  `;
  console.log(`유령 채널: ${ghosts[0].cnt}개`);

  // post_source null 확인
  const nullSrc = await client`
    SELECT COUNT(*) as cnt FROM thread_posts WHERE post_source IS NULL
  `;
  console.log(`post_source=null: ${nullSrc[0].cnt}개`);

  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
npx tsx _final-check.ts && rm _final-check.ts
```

Expected:
- 뷰티: 8개
- 건강: 5~7개
- 식품: 3~5개
- 생활: 6개
- 다이어트: 4개
- 인테리어: 3개
- 총: ~30개
- 유령 채널: 0
- post_source=null: 0

- [ ] **Step 2: 검증 통과 시 전략 로그 기록**

`agents/memory/strategy-log.md`에 append:

```markdown
## [20260325] 벤치마크 리밸런싱

### 결정
- 유령 채널 9개 + 저활동 채널 N개 퇴출
- 건강/식품/인테리어 신규 벤치마크 N개 등록
- 뷰티 24→8, 다이어트 7→4 축소
- post_source NOT NULL 제약 추가
- evaluate-channels.ts 스코어링 개선 (댓글 가중치 30%)

### 근거
- 뷰티 58% 편중인데 빈이 뷰티 성과 최하위 (984뷰)
- 건강 참여율 1위(평균 댓글 10)인데 벤치마크 1개뿐
- 식품 벤치마크 0개인데 빈이 최고 성과(15,000뷰)가 식품
- post_source=null 33%로 데이터 계보 추적 불가

### 결과 (이 줄 아래에 다음 세션에서 기록)
```

---

## Chunk 5: 채널 선정 기준 문서화

### Task 11: 채널 선정 기준표 문서화

**Files:**
- Modify: `src/agents/DISCOVERY_GUIDE.md` (기존 검증 기준에 전략 기준 추가)

- [ ] **Step 1: DISCOVERY_GUIDE.md에 채널 선정 기준 추가**

기존 "통과 기준" 섹션을 확장:

```markdown
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
| 건강 | 5 | 10 | 현재 부족 — 우선 충원 |
| 식품 | 3 | 7 | 현재 부족 — 우선 충원 |
| 생활 | 5 | 8 | 유지 |
| 다이어트 | 3 | 5 | 축소 |
| 인테리어 | 3 | 5 | 신규 |

### 자동 퇴출 조건
- 30일간 신규 포스트 0개 → retired
- evaluate-channels.ts 하위 20% (카테고리 최소 3개 보호)
- 주간 자동 실행: `npx tsx scripts/evaluate-channels.ts --apply`
```

- [ ] **Step 2: 커밋**

```bash
git add src/agents/DISCOVERY_GUIDE.md
git commit -m "docs(discovery): add channel selection criteria and category guardrails"
```

---

### Task 12: handoff.md 업데이트

**Files:**
- Modify: `handoff.md`

- [ ] **Step 1: handoff.md에 리밸런싱 결과 반영**

이번 세션의 모든 변경사항을 handoff.md에 반영:
- 벤치마크 현황 (카테고리별 수)
- post_source NOT NULL 제약
- evaluate-channels.ts 스코어링 변경
- 다음 세션 우선순위 업데이트

- [ ] **Step 2: 커밋**

```bash
git add handoff.md agents/memory/strategy-log.md
git commit -m "docs: update handoff with benchmark rebalancing results"
```

---

## 실행 순서 요약

```
Chunk 1 (데이터 정리) ← 반드시 먼저
  Task 1: 유령 채널 퇴출 (5분)
  Task 2: 저활동 채널 추가 정리 (5분)
  Task 3: post_source 백필 + NOT NULL (10분)

Chunk 2 (도구 개선) ← Chunk 1 이후
  Task 4: evaluate-channels.ts 스코어링 + 가드레일 (15분)

Chunk 3 (채널 발굴) ← Chunk 1, 2 이후. 병렬 가능.
  Task 5: 건강 채널 발굴 (30분) ← 최우선
  Task 6: 식품 채널 발굴 (30분) ← 병렬 가능
  Task 7: 인테리어 채널 발굴 (20분) ← 병렬 가능

Chunk 4 (축소 + 검증) ← Chunk 3 이후
  Task 8: 뷰티 15→8 축소 (10분)
  Task 9: 다이어트 7→4 축소 (5분)
  Task 10: 최종 검증 (5분)

Chunk 5 (문서화) ← 마지막
  Task 11: 채널 선정 기준 문서화 (10분)
  Task 12: handoff.md 업데이트 (5분)
```

**총 예상: ~2.5시간** (채널 발굴의 Exa 검색 + collect.ts 수집 시간 포함)

---

## Acceptance Criteria

| 기준 | 측정 방법 | 목표값 |
|------|---------|--------|
| 유령 채널 | `WHERE is_benchmark AND NOT EXISTS(posts)` | 0개 |
| 뷰티 비율 | 뷰티 채널 / 전체 벤치마크 | < 35% |
| 건강 벤치마크 | `WHERE category='건강' AND is_benchmark` | >= 5개 |
| 식품 벤치마크 | `WHERE category='식품'` | >= 3개 |
| post_source null | `WHERE post_source IS NULL` | 0개 |
| 카테고리 커버리지 | 3개 이상 벤치마크가 있는 카테고리 수 | >= 5 |
| 전체 벤치마크 수 | `WHERE is_benchmark AND status!='retired'` | 25~35개 |

---

## Out of Scope (별도 세션에서 처리)

이번 플랜에서 의도적으로 제외한 회의 합의 항목:

1. **트렌드 파이프라인 폐기 판단** — 활용률 0.8%. 리밸런싱 완료 후 별도 세션에서 A안(필터 확장) vs B안(폐기) 판단.
2. **빈이 channel_id 정합성 수정** — thread_posts에서 빈이 포스트가 조회되지 않는 문제. 수집 시스템과 별개의 계측 인프라 이슈로 분리.
3. **브랜드 이벤트 85개 미사용** — 워밍업 완료(12개 남음) 후 자연 해소 예상. 워밍업 완료 시점에 재검토.
4. **evaluate-channels.ts 주간 자동 실행 스케줄** — 스코어링 개선 후 수동 실행으로 검증하고, 안정화 확인 후 cron 등록.
