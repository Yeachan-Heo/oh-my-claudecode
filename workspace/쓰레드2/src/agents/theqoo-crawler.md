# Theqoo Crawler Agent

## 역할
더쿠(theqoo.net) HOT 게시판과 스퀘어에서 인기글/자유글+댓글을 수집하여 `community_posts` 테이블에 저장한다.
Playwright 없이 HTTP fetch + cheerio로 동작한다. Cloudflare 차단 발생 시 Playwright fallback 전환.

## 실행 환경

- **HTTP**: `node-fetch` 또는 native `fetch` (Node 18+)
- **파싱**: `cheerio` (서버사이드 jQuery)
- **DB**: Supabase PostgreSQL, `community_posts` 테이블
- **수집 스크립트**: `scripts/collect-theqoo.ts`
- **딜레이**: 1~2초 랜덤 (`Math.random() * 1000 + 1000` ms)

## 수집 흐름

```
Step 1: 수집 대상 선택 (HOT or 스퀘어)
Step 2: 목록 페이지 fetch + cheerio 파싱
Step 3: 글 ID 목록 추출 + 필터링
Step 4: 각 글 상세 페이지 fetch → 본문 + 댓글 파싱
Step 5: DB 저장
Step 6: 결과 보고
```

## Step 1: 수집 대상 선택

| 게시판 | URL | 특징 |
|--------|-----|------|
| HOT 게시판 | `https://theqoo.net/hot` | 추천수 높은 인기글 |
| 스퀘어 | `https://theqoo.net/square` | 자유 게시판, 실시간 반응 |

- 기본값: HOT (트렌드 추적) + 스퀘어 (일상/고민 패턴)
- `--board hot` 또는 `--board square`로 개별 선택 가능

## Step 2: 목록 페이지 fetch

```typescript
const res = await fetch('https://theqoo.net/hot', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': 'https://theqoo.net',
  },
});
const html = await res.text();
const $ = cheerio.load(html);
```

### Cloudflare 감지
```typescript
if (res.status === 403 || html.includes('cf-browser-verification')) {
  // Playwright fallback 전환 (Step 2-F 참조)
  throw new Error('CLOUDFLARE_BLOCKED');
}
```

## Step 3: 글 목록 추출

### HOT 게시판 셀렉터
```typescript
// 글 목록 행
$('.theqoo_board_table tbody tr').each((_, row) => {
  const $row = $(row);
  // 공지, 광고 스킵
  if ($row.hasClass('notice') || $row.hasClass('ad')) return;

  const $link = $row.find('.title a').first();
  const title = $link.text().trim();
  const href = $link.attr('href') || '';
  // href 형식: /hot/1234567890 또는 /square/1234567890
  const postId = href.split('/').pop();
  const viewCount = parseInt($row.find('.view').text().replace(/,/g, '')) || 0;
  const likeCount = parseInt($row.find('.recommend').text()) || 0;
});
```

### 스퀘어 셀렉터
```typescript
// 스퀘어는 HOT과 동일 구조, URL만 다름
$('.theqoo_board_table tbody tr').each((_, row) => { /* 동일 */ });
```

### 필터링 조건
- 제목 4자 미만 스킵
- `[광고]`, `[공지]` 포함 제목 스킵
- 조회수 0인 글 스킵 (파싱 실패 가능성)
- 중복 postId 제거 (`Set<string>` 사용)

## Step 4: 상세 페이지 fetch → 본문 + 댓글 파싱

```typescript
const detailUrl = `https://theqoo.net/${board}/${postId}`;
const res = await fetch(detailUrl, { headers });
const $ = cheerio.load(await res.text());
```

### 본문 추출 셀렉터 (우선순위)
1. `.xe_content` (XpressEngine 기본 본문)
2. `.document_content`
3. `.post_content`
4. `#document_content`

```typescript
const body =
  $('.xe_content').text().trim() ||
  $('.document_content').text().trim() ||
  '';
```

### 댓글 추출
```typescript
const comments: Array<{ nickname: string; text: string; like_count: number }> = [];

$('.fdb_itm').each((_, el) => {
  const $el = $(el);
  // 삭제된 댓글 스킵
  if ($el.find('.delete').length) return;

  const nickname = $el.find('.nick').text().trim();
  const text = $el.find('.xe_content').text().trim();
  const likeCount = parseInt($el.find('.vote_up').text()) || 0;

  if (text) comments.push({ nickname, text, like_count: likeCount });
});
```

### 메타데이터 추출
```typescript
// 조회수
const viewCount = parseInt($('.view_count').text().replace(/[^0-9]/g, '')) || 0;
// 추천수
const likeCount = parseInt($('.like_count, .vote_up_cnt').first().text()) || 0;
// 작성일
const postedAt = $('.date_time').text().trim(); // "2026.03.19 14:30"
// 댓글 수
const commentCount = parseInt($('.comment_cnt').text()) || 0;
```

## Step 5: DB 저장

`community_posts` 테이블에 저장:
```typescript
{
  id: `theqoo_${board}_${postId}`,
  source_platform: 'theqoo',
  source_cafe: board,            // 'hot' 또는 'square'
  source_url: detailUrl,
  title,
  body,
  comments: JSON,                // [{nickname, text, like_count}]
  author_nickname,               // 닉네임만 (개인정보 X)
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
| 게시판 | 제목 | 조회 | 추천 | 댓글수 |
```

## CLI 사용법

```bash
# HOT 게시판 20개 수집
npx tsx scripts/collect-theqoo.ts --board hot --limit 20

# 스퀘어 30개 수집
npx tsx scripts/collect-theqoo.ts --board square --limit 30

# HOT + 스퀘어 동시 수집 (기본)
npx tsx scripts/collect-theqoo.ts --limit 20

# 건식 실행 (DB 저장 안 하고 콘솔 출력만)
npx tsx scripts/collect-theqoo.ts --board hot --limit 5 --dry-run
```

### 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--board` | `both` | `hot`, `square`, `both` |
| `--limit` | `20` | 게시판당 수집 개수 |
| `--dry-run` | false | DB 저장 없이 콘솔 출력 |
| `--delay` | `1500` | 요청 간 딜레이 ms (랜덤 ±500) |

## Cloudflare Fallback (Step 2-F)

HTTP fetch가 403 또는 `cf-browser-verification` 응답을 받으면:

```typescript
// Playwright로 전환
const browser = await connectBrowser(); // port 9223
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
const html = await page.content();
const $ = cheerio.load(html); // 이후 파싱은 동일
```

현재(2026-03) 더쿠는 Cloudflare 없음. 활성화 시 fallback 전환.

## DB 스키마 참고

```sql
-- community_posts 테이블
id              TEXT PRIMARY KEY,   -- 'theqoo_hot_1234567890'
source_platform TEXT,               -- 'theqoo'
source_cafe     TEXT,               -- 'hot' | 'square'
source_url      TEXT UNIQUE,
title           TEXT,
body            TEXT,
comments        JSONB,
author_nickname TEXT,
like_count      INT,
comment_count   INT,
view_count      INT,
posted_at       TIMESTAMPTZ,
collected_at    TIMESTAMPTZ,
analyzed        BOOLEAN DEFAULT false,
extracted_needs JSONB
```

## 딜레이 구현

```typescript
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 수집 루프 내에서
await sleep(1000 + Math.random() * 1000); // 1~2초 랜덤
```

## 법적 주의

- 닉네임 외 개인정보 수집 금지 (IP, 이메일, 전화번호 등)
- 소량 수집 (게시판당 20~30개/일)
- 원문 재게시 안 함 (니즈 분석 목적)
- 수집 간격 1~2초 랜덤 딜레이 필수
- robots.txt 확인: `https://theqoo.net/robots.txt`

## 수집 목적

수집된 글/댓글에서 **여성 니즈, 직장인 불편함, 실생활 고민 패턴**을 추출하여
빈이 채널(@duribeon231)의 콘텐츠 소재로 활용한다.

분석은 Claude가 직접 수행 (API 비용 $0):
1. 수집된 글/댓글 읽기
2. 반복되는 불편함/고민 키워드 추출
3. 빈이 스타일(직장인 자취생, 자조유머, 솔직후기)로 변환 가능한 소재 선정
