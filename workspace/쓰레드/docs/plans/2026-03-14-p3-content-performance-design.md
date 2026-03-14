# P3 Content Generator + Performance Analyzer — Design Document

**Date:** 2026-03-14
**Status:** Design Phase
**Scope:** P3-1 (Content Generator) + P3-2 (Performance Analyzer)

---

## Overview

P3 completes the Threads affiliate marketing pipeline by adding two final stages:

1. **Content Generator** (`scripts/content-generator.ts`) — P3-1
   - Consumes positioning output → produces ready-to-use post drafts
   - Template-based, Korean natural tone, format-specific
   - LLM enhancement via `--prompt` flag

2. **Performance Analyzer** (`scripts/performance-analyzer.ts`) — P3-2
   - Consumes collected posts with metrics → produces engagement analysis
   - Auto-computes LearningEntry deltas to feed back into P2 scoring

```
[positioning.json] → [content-generator] → [content_drafts.json]
[canonical/posts.json] → [performance-analyzer] → [analysis_report.json]
                                                 → [learnings/latest.json] (merge)
```

---

## P3-1: Content Generator

### Input

`data/briefs/{today}_positioning.json` — `PositioningOutput` (see `scripts/types.ts`)

Key fields consumed per card:
- `product_id`, `product_name`, `need_id`
- `positions[].format` — determines template branch
- `positions[].hook` — seed for hook variants
- `positions[].cta_style` — determines CTA style in self-comments
- `positions[].tone` — informs body writing style
- `positions[].avoid` — strings to avoid in generated content

Also reads `data/briefs/{today}_products.json` for `affiliate_link` per product.

### Output

`data/briefs/{today}_content_drafts.json` — `ContentDraftOutput`

```json
{
  "date": "2026-03-14",
  "drafts": [
    {
      "product_id": "led_mood_lamp_001",
      "product_name": "무드등 LED 수면 조명",
      "need_id": "자기표현",
      "format": "솔직후기형",
      "hook": "광고 아니고 내 돈 주고 산 무드등 LED 후기",
      "bodies": [
        "산 지 한 달 됐는데 아직도 매일 켜고 있음\n색 바꾸는 게 의외로 기분 전환 돼서",
        "처음엔 그냥 분위기용인 줄 알았는데\n자기 전에 켜두면 진짜 잠이 빨리 옴\n몇 천 원짜리 앱이랑 비교하면 얘가 더 나았음",
        "1만원대치고 퀄리티 괜찮음\n단점은 조절 앱이 좀 불편한데 익숙해지면 됨"
      ],
      "hooks": [
        "광고 아니고 내 돈 주고 산 무드등 LED 후기",
        "무드등 LED 한 달 써보고 솔직하게 말함",
        "무드등 LED 2주 차 중간 점검",
        "3개월 째 무드등 LED 쓰는 사람으로서",
        "돈 주고 샀는데 이 가격이면 진짜 괜찮음"
      ],
      "self_comments": [
        "궁금한 거 있으면 프로필 링크에서 확인해봐",
        "수면 환경 바꿔보려고 여러 개 써봤는데 이게 가장 무난했음. 1만원대라 부담 없이 시작하기 좋아"
      ]
    }
  ],
  "meta": {
    "positioning_version": "2026-03-14",
    "drafts_generated": 18,
    "generated_at": "2026-03-14T10:00:00.000Z"
  }
}
```

### Format-Specific Body Templates

각 포맷은 구조적 패턴을 따르되, 광고 냄새를 최소화.

| 포맷 | 구조 | 어조 원칙 |
|------|------|-----------|
| 문제공감형 | 공감 (1줄) → 발견 (1줄) → 자연스런 소개 (1줄) | "나도 그랬는데" 느낌 |
| 솔직후기형 | 사용 기간/맥락 → 장점 → 단점 또는 한계 | 1인칭, 구어체, 완결된 경험 |
| 비교형 | 결론 먼저 → 비교 대상 → 선택 이유 | 수치/기간 구체적으로 |
| 입문추천형 | 대상 명시 → 제품 소개 → 진입 이유 | 친절하되 설명 과잉 금지 |
| 실수방지형 | 경고/실수 → 확인 기준 → 추천 | 경험 기반 경고 느낌 |
| 비추천형 | 솔직한 평가 → 실망 이유 → 대안 제시 | 냉정하되 도움되는 느낌 |

본문 규칙:
- 각 body는 1-3줄 (최대 60자 × 3줄)
- 한국어, 구어체
- 제품명은 첫 줄 이후 생략 또는 "얘", "이거"로 대체
- `avoid` 목록의 단어 사용 금지

### Hook Variant Generation

`generateHookVariants(variant: PositionVariant, productName: string, count: 5)` — 5개 훅 생성.

기존 `generateHook` (positioning.ts)을 seed offset으로 5회 호출하되, 각 호출에 다른 seed modifier를 적용:

```typescript
function generateHookVariants(
  variant: PositionVariant,
  productName: string,
  needCategory: NeedsCategory,
  problem: string,
): string[] {
  // seed 0,1,2,3,4 — 각각 다른 해시 오프셋
  // 기존 hash + offset 방식으로 templates 배열에서 다른 인덱스 선택
  // 중복 제거: Set으로 수집 후 부족하면 suffix(" (2)" 등) 추가
}
```

### Self-Comment Generation

`generateSelfComments(product: ProductMatch, variant: PositionVariant): string[]`

Comment 1 — CTA (cta_style 기반):
- `프로필 링크 유도` → "궁금하면 프로필 링크 확인해봐" 계열
- `댓글에서 자연스럽게` → "써본 거 더 궁금하면 댓글로" 계열
- `DM 유도` → "구체적으로 궁금하면 DM 줘" 계열

affiliate_link 있으면 Comment 1 또는 2에 자연스럽게 삽입:
- "프로필 링크: [url]" 형태로 마지막 줄에 추가 (직접 URL 노출)
- Threads는 본문 링크 미지원 → 자기 댓글에 링크가 관행

Comment 2 — 추가 컨텍스트:
- 가격대 언급 ("1만원대라 부담없이"), 사용 기간, 사용 상황 등
- Social proof 있으면 자연스럽게 ("주변에서도 좋다고 해서")

### `--prompt` Flag

`content_prompt.txt` 생성 — Claude Code에 붙여넣기용:

```
당신은 Threads 콘텐츠 작가입니다. 아래 규칙 기반 초안을 자연스럽게 개선하세요.

## 규칙
- 각 body는 1-3줄, 한국어 구어체
- 광고 냄새 없이 실제 경험담처럼
- avoid 목록의 단어 절대 사용 금지
- hook은 20자 이내

## 개선할 초안
{JSON.stringify(drafts, null, 2)}

## 출력 형식 (JSON)
{ContentDraftOutput 스키마}
```

### New Types

```typescript
// --- P3: Content Generation ---

export interface ContentDraft {
  product_id: string;
  product_name: string;
  need_id: string;
  format: PositionFormat;
  hook: string;           // 대표 훅 (positions[0].hook)
  bodies: string[];       // 3개 본문 변형
  hooks: string[];        // 5개 훅 변형
  self_comments: string[]; // 2개 자기 댓글
}

export interface ContentDraftOutput {
  date: string;
  drafts: ContentDraft[];
  meta: {
    positioning_version: string;
    drafts_generated: number;
    generated_at: string;
  };
}
```

---

## P3-2: Performance Analyzer

### Input

`data/canonical/posts.json` — `CanonicalOutput` (see `scripts/types.ts`)

Key fields consumed:
- `posts[].metrics` — view_count, like_count, reply_count, repost_count
- `posts[].timestamp` — for time-of-day bucketing
- `posts[].tags.primary` — format proxy (affiliate → 광고형, review → 후기형 등)
- `posts[].tags.secondary` — additional format hints
- `posts[].channel_id` — channel-level breakdown
- `posts[].link.url` — affiliate link presence

### Output 1: `data/briefs/{today}_analysis_report.json`

```json
{
  "date": "2026-03-14",
  "format_performance": {
    "affiliate": { "avg_views": 420, "avg_likes": 8.2, "avg_replies": 1.1, "post_count": 224 },
    "review": { "avg_views": 310, "avg_likes": 5.5, "avg_replies": 0.8, "post_count": 12 },
    "general": { "avg_views": 180, "avg_likes": 3.1, "avg_replies": 0.4, "post_count": 15 }
  },
  "time_performance": {
    "새벽": { "label": "0-6시", "avg_views": 250, "avg_likes": 4.1, "post_count": 18 },
    "오전": { "label": "6-12시", "avg_views": 480, "avg_likes": 9.3, "post_count": 72 },
    "오후": { "label": "12-18시", "avg_views": 510, "avg_likes": 10.1, "post_count": 89 },
    "밤":   { "label": "18-24시", "avg_views": 390, "avg_likes": 7.4, "post_count": 48 }
  },
  "top_performing_posts": [
    { "post_id": "...", "channel_id": "...", "views": 1200, "likes": 24, "tag": "affiliate" }
  ],
  "learning_deltas": [
    { "product_id": "led_mood_lamp_001", "naturalness_delta": 0.5, "story_potential_delta": 0.5 }
  ],
  "meta": {
    "posts_analyzed": 227,
    "date_range": { "from": "2025-10-18", "to": "2026-03-14" },
    "generated_at": "2026-03-14T10:00:00.000Z"
  }
}
```

### Output 2: `data/learnings/latest.json` (merge)

기존 파일에 `analysis_report.learning_deltas`를 병합:
- 같은 `product_id` 있으면 delta 누적 (clamp [-2, 2])
- 없으면 신규 entry 추가
- `updated_at` 갱신

### Format-Level Engagement Analysis

`calcEngagementStats(posts: CanonicalPost[]): Record<string, PerformanceMetrics>`

- `posts[].tags.primary`로 그룹핑
- 각 그룹: avg_views, avg_likes, avg_replies 계산
- null view_count 제외 (null이면 해당 포스트의 views 집계 제외, likes/replies는 포함)

### Time-of-Day Pattern Analysis

`analyzeTimePatterns(posts: CanonicalPost[]): Record<TimeSlot, PerformanceMetrics>`

- `posts[].timestamp`에서 KST hour 추출 (UTC+9)
- Bucket 분류:
  - 새벽: 0 ≤ hour < 6
  - 오전: 6 ≤ hour < 12
  - 오후: 12 ≤ hour < 18
  - 밤: 18 ≤ hour < 24
- 각 bucket: avg_views, avg_likes, post_count

### Learning Delta Calculation

`calcLearningDeltas(stats: Record<string, PerformanceMetrics>, posts: CanonicalPost[]): LearningEntry[]`

기준: 전체 평균 대비 성능

- 전체 avg_views 계산
- 포스트의 link.url에서 product_id 역추적 (product_dict 참조 또는 URL 패턴 매칭)
- 특정 product_id와 연관된 포스트들의 avg_views가 전체 평균보다 높으면:
  - `naturalness_delta += 0.5` (공감 있음)
  - `story_potential_delta += 0.5` (스토리 가능)
- 낮으면: 해당 deltas -= 0.5
- Clamp [-2, 2] 적용

단순화: product_id 역추적이 어려우면 channel_id 기반으로 channel-level delta만 계산.

### New Types

```typescript
// --- P3: Performance Analysis ---

export type TimeSlot = '새벽' | '오전' | '오후' | '밤';

export interface PerformanceMetrics {
  avg_views: number | null;
  avg_likes: number;
  avg_replies: number;
  post_count: number;
}

export interface AnalysisReport {
  date: string;
  format_performance: Record<string, PerformanceMetrics>;
  time_performance: Record<TimeSlot, PerformanceMetrics>;
  top_performing_posts: Array<{
    post_id: string;
    channel_id: string;
    views: number | null;
    likes: number;
    tag: string;
  }>;
  learning_deltas: LearningEntry[];
  meta: {
    posts_analyzed: number;
    date_range: { from: string; to: string };
    generated_at: string;
  };
}
```

---

## Pipeline Integration

### run-pipeline.ts Step 6 + Step 7

```
Step 1: normalize-posts
Step 2: researcher
Step 3: needs-detector
Step 4: product-matcher
Step 5: positioning
Step 6: content-generator   ← NEW (P3-1)
Step 7: performance-analyzer ← NEW (P3-2)
```

### Flags

| Flag | Behavior |
|------|----------|
| `--content-only` | Steps 1-6 only (content generation without performance) |
| `--prompt` | Steps 4-6 also generate `*_prompt.txt` |
| `--brief` | After completion, output human-readable brief with content preview |

### npm Scripts

```json
{
  "content": "tsx scripts/content-generator.ts",
  "analyze": "tsx scripts/performance-analyzer.ts"
}
```

### Brief Extension

`--brief` 출력에 "콘텐츠 초안 미리보기" 섹션 추가:

```
■ 콘텐츠 초안 미리보기 (상위 3개)
────────────────────────────────────────
[무드등 LED 수면 조명] 솔직후기형
  훅: "광고 아니고 내 돈 주고 산 무드등 LED 후기"
  초안: "산 지 한 달 됐는데 아직도 매일 켜고 있음..."
```

---

## File Summary

| File | Role | Input | Output |
|------|------|-------|--------|
| `scripts/content-generator.ts` | P3-1 메인 | `positioning.json` | `content_drafts.json` |
| `scripts/performance-analyzer.ts` | P3-2 메인 | `canonical/posts.json` | `analysis_report.json`, `learnings/latest.json` (merge) |
| `scripts/types.ts` | 타입 추가 | — | `ContentDraft`, `ContentDraftOutput`, `AnalysisReport`, `PerformanceMetrics`, `TimeSlot` |
| `scripts/run-pipeline.ts` | 오케스트레이터 | — | Step 6, 7 추가, `--content-only` flag |

---

## Design Constraints

1. **No external dependencies** — 기존 파이프라인처럼 Node.js built-ins + tsx only
2. **Atomic writes** — `.tmp` → rename 패턴 유지
3. **isMainModule guard** — import 시 main() 미실행
4. **Korean comments** — 코드 내 주석은 한국어
5. **All types in types.ts** — 로컬 interface 금지
6. **LLM enhancement optional** — `--prompt` 없이도 완전히 동작
