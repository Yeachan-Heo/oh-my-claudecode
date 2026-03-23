# Revenue Tracking Ops

## 개요

쿠팡 파트너스 제휴 링크 클릭/구매 수익 추적 시스템.
워밍업 완료(100포스트) 이후 활성화된다.

---

## 단계별 활성화 조건

### 워밍업 중 (포스트 수 < 100): 비활성

- `isWarmupMode()` = `true`
- `coupang_link` 포함 콘텐츠 금지 (`validateContent()` 거부)
- 수익 추적 함수 호출 불필요 (호출해도 무해하지만 의미 없음)
- 현재 상태: **7/100 완료**

### 워밍업 완료 (포스트 수 ≥ 100): 활성

- `isWarmupMode()` = `false`
- `affiliateContent.coupang_link` 포함 포스트 발행 허용
- 포스트 발행 후 `trackClick`, `trackPurchase` 호출 시작
- 쿠팡 파트너스 대시보드 클릭/전환 데이터와 대조 검증

---

## 수익 추적 절차

### 1. 클릭 추적

포스트에 제휴 링크가 포함된 경우 클릭 기록:

```typescript
import { trackClick } from './src/db/revenue.js';

await trackClick(
  postId,       // thread_posts.post_id
  productId,    // matched_products.id
  coupangLink,  // 쿠팡 파트너스 단축 URL
);
```

### 2. 구매 추적

쿠팡 파트너스 대시보드에서 전환 확인 후 기록:

```typescript
import { trackPurchase } from './src/db/revenue.js';

await trackPurchase(
  postId,      // 전환 발생한 포스트
  amount,      // 구매 금액 (원)
  commission,  // 수수료 (원, 통상 amount * 0.05)
);
```

### 3. 조회 쿼리

```typescript
import {
  getRevenueByPost,
  getRevenueByDate,
  getDailyRevenueSummary,
} from './src/db/revenue.js';

// 포스트별 수익
const rows = await getRevenueByPost('post_abc123');

// 기간별 수익
const rows = await getRevenueByDate('2026-04-01', '2026-04-30');

// 일별 요약 (전체 기간)
const summary = await getDailyRevenueSummary();
```

---

## CEO 일일 수익 보고

매일 `minjun-ceo`에게 `agent_messages`로 수익 현황 보고:

```typescript
import { sendMessage } from './src/db/agent-messages.js';
import { getDailyRevenueSummary } from './src/db/revenue.js';

const summary = await getDailyRevenueSummary();
const today = summary[0];

await sendMessage(
  'revenue-tracker',
  'minjun-ceo',
  'daily-revenue',
  `💰 ${today.tracked_date} 수익 현황\n` +
  `클릭: ${today.total_clicks}회\n` +
  `구매: ${today.total_purchases}건\n` +
  `수익: ₩${Number(today.total_revenue).toLocaleString()}\n` +
  `수수료: ₩${Number(today.total_commission).toLocaleString()}`,
);
```

---

## DB 스키마

```sql
CREATE TABLE revenue_tracking (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  product_id TEXT,
  coupang_link TEXT,
  click_count INT DEFAULT 0,
  purchase_count INT DEFAULT 0,
  revenue NUMERIC(10,2) DEFAULT 0,
  commission NUMERIC(10,2) DEFAULT 0,
  tracked_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 관련 파일

- `src/db/revenue.ts` — 헬퍼 함수 (trackClick, trackPurchase, getRevenueByPost, getRevenueByDate, getDailyRevenueSummary)
- `src/db/schema.ts` — `revenueTracking` 테이블 정의
- `src/utils/warmup-gate.ts` — `isWarmupMode()`, `validateContent()`
- `src/db/agent-messages.ts` — CEO 보고용 메시지 전송
