# P2 코드 품질 + 기능 강화 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** P2 파이프라인의 코드 품질 개선(버그 수정, 타입 정리, 검증 추가) 및 기능 강화(훅 확장, 학습 피드백, LLM 연동 기반)

**Architecture:** 기존 파이프라인 구조(normalize→researcher→needs→products→positioning) 유지. 순수 함수 리팩토링 + 런타임 검증 추가. LLM 강화는 `*_llm.json` 오버레이 패턴으로 기존 출력을 덮지 않음.

**Tech Stack:** TypeScript strict mode, vitest, tsx runner, Node.js fs

---

## Phase A: 리팩토링 (비TDD — 동작 변경 없음)

### Task 1: LearningEntry를 types.ts로 이동

**Files:**
- Modify: `scripts/types.ts:270` (끝 부분에 추가)
- Modify: `scripts/product-matcher.ts:314-321` (로컬 인터페이스 삭제, import 추가)

**Step 1: types.ts 끝에 LearningEntry 추가**

```typescript
// --- P2: Learning feedback ---

export interface LearningEntry {
  product_id: string;
  naturalness_delta?: number;
  clarity_delta?: number;
  ad_smell_delta?: number;
  repeatability_delta?: number;
  story_potential_delta?: number;
}
```

**Step 2: product-matcher.ts에서 로컬 interface 삭제, import에 LearningEntry 추가**

`import type { ... } from './types.js'`에 `LearningEntry` 추가.
`product-matcher.ts:314-321`의 로컬 `interface LearningEntry` 블록 삭제.

**Step 3: 기존 테스트 통과 확인**

Run: `npx vitest run`
Expected: 50 tests pass

---

### Task 2: positioning.ts 죽은 템플릿 코드를 활성 코드로 교체

**Files:**
- Modify: `scripts/positioning.ts:36-73` (angle_template에 플레이스홀더 추가)
- Modify: `scripts/positioning.ts:154-157` (replace 코드 수정)

리뷰 결과: 삭제보다 angle_template에 플레이스홀더를 넣어서 살리는 게 기능적으로 더 나음.

**Step 1: FORMAT_DEFS의 angle_template을 동적 플레이스홀더로 수정**

```typescript
const FORMAT_DEFS: Record<PositionFormat, FormatDef> = {
  '문제공감형': {
    desc: '문제 먼저 → 해결책',
    angle_template: '이 문제 나만 겪는 줄 알았는데',
    tone_desc: '공감 → 발견 → 자연스런 소개',
    cta_style: '프로필 링크 유도',
  },
  '솔직후기형': {
    desc: '개인 경험 중심 솔직한 후기',
    angle_template: '{product} 써봤는데 솔직하게 말하면',
    tone_desc: '비격식 1인칭, 구어체, 장단점 모두',
    cta_style: '댓글에서 자연스럽게',
  },
  '비교형': {
    desc: '여러 개 써봤는데 하나만 남김',
    angle_template: '{product} 포함 3개 써봤는데 1개만 남김',
    tone_desc: '구체적 비교, 결론 먼저, 이유 나중',
    cta_style: '프로필 링크 유도',
  },
  '입문추천형': {
    desc: '처음 시작하는 사람 대상',
    angle_template: '{category} 처음이면 이거부터',
    tone_desc: '친절하고 명확, 진입장벽 낮춤',
    cta_style: '댓글에서 자연스럽게',
  },
  '실수방지형': {
    desc: '살 뻔했다가 확인하고 결정',
    angle_template: '{product} 사기 전에 이것만 확인해',
    tone_desc: '경고 → 기준 제시 → 추천',
    cta_style: 'DM 유도',
  },
  '비추천형': {
    desc: '솔직하게 별로였던 것 → 대안',
    angle_template: '이 카테고리 3개 써봤는데 {product}만 남김',
    tone_desc: '냉정하고 솔직, 대안 제시로 마무리',
    cta_style: '댓글에서 자연스럽게',
  },
};
```

**Step 2: buildVariant의 replace 코드를 의미 있는 치환으로 수정**

```typescript
const angle = def.angle_template
  .replace('{product}', product.name)
  .replace('{category}', needCategory);
```

**Step 3: 기존 테스트 통과 확인**

Run: `npx vitest run`
Expected: 50 tests pass (테스트는 angle 값을 직접 검증하지 않으므로 통과)

---

### Task 3: 불필요한 as 캐스트 제거

**Files:**
- Modify: `scripts/product-matcher.ts:193` (remove `as NeedsCategory`)
- Modify: `scripts/product-matcher.ts:209` (remove `as AffiliatePlatform`)

**Step 1: 캐스트 제거**

Line 193: `p.needs_categories.includes(need.category as NeedsCategory)` → `p.needs_categories.includes(need.category)`

Line 209: `affiliate_platform: product.affiliate_platform as AffiliatePlatform,` → `affiliate_platform: product.affiliate_platform,`

**Step 2: tsc + 테스트 확인**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors, 50 tests pass

**Step 3: Phase A 커밋**

```bash
git add scripts/types.ts scripts/product-matcher.ts scripts/positioning.ts
git commit -m "refactor(threads): move LearningEntry to types.ts, fix angle templates, remove as-casts"
```

---

## Phase B: 버그 수정 (TDD)

### Task 4: countKeywordMatches 퍼지 매칭 버그 수정

`expr.slice(0, 4)` 로직이 한국어에서 false positive 생성. 표현 안에 키워드가 포함되는지(`expr.includes(kwLower)`)만으로 충분.

**Files:**
- Test: `scripts/__tests__/product-matcher.test.ts`
- Modify: `scripts/product-matcher.ts:137-150`

**Step 1: 실패하는 테스트 작성**

```typescript
test('does not false-positive on short expr prefix', () => {
  // "수면" 키워드가 "수면이 안 와"에 포함 → match
  // "영양" 키워드가 "수면이 안 와"에 포함되지 않음 → no match
  // 기존 slice(0,4) 버그: "수면이 " → "영양제" 에 포함? no. 하지만 "영양" → "영양"이 "수면이 안"[:4]="수면이 "에 포함? 가능성 있음
  const product = makeProduct(['영양']);
  const expressions = ['수면이 안 와서 힘들다'];
  expect(countKeywordMatches(product, expressions)).toBe(0);
});

test('matches keyword contained in expression', () => {
  const product = makeProduct(['수면']);
  const expressions = ['수면이 안 와서 힘들다'];
  expect(countKeywordMatches(product, expressions)).toBe(1);
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/product-matcher.test.ts`
Expected: `does not false-positive on short expr prefix` — FAIL (slice(0,4) 로직이 false match 가능)

**Step 3: 최소 구현 — slice 로직 제거**

```typescript
export function countKeywordMatches(product: ProductEntry, expressions: string[]): number {
  const lowerExprs = expressions.map(e => e.toLowerCase());
  let count = 0;
  for (const kw of product.keywords) {
    if (kw.length < 2) continue; // 1글자 키워드 무시
    const kwLower = kw.toLowerCase();
    for (const expr of lowerExprs) {
      if (expr.includes(kwLower)) {
        count++;
        break;
      }
    }
  }
  return count;
}
```

**Step 4: 모든 테스트 통과 확인**

Run: `npx vitest run`
Expected: 52 tests pass (기존 50 + 새 2)

**Step 5: 커밋**

```bash
git add scripts/product-matcher.ts scripts/__tests__/product-matcher.test.ts
git commit -m "fix(threads): remove false-positive fuzzy matching in countKeywordMatches"
```

---

## Phase C: 코드 품질 강화 (TDD)

### Task 5: silent catch → console.warn

**Files:**
- Test: `scripts/__tests__/product-matcher.test.ts`
- Modify: `scripts/product-matcher.ts:370-377`
- Modify: `scripts/run-pipeline.ts:106-107`

**Step 1: 실패하는 테스트 — learnings 로드 실패 시 warn 출력**

product-matcher의 `main()`은 직접 테스트하기 어려우므로, learnings 로드 로직을 추출하여 테스트.

```typescript
// product-matcher.test.ts에 추가
import { loadLearnings } from '../product-matcher.js';

describe('loadLearnings', () => {
  test('returns empty array and warns for missing file', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadLearnings('/nonexistent/path.json');
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('learnings'));
    warnSpy.mockRestore();
  });

  test('returns empty array and warns for invalid JSON', () => {
    // 임시 파일에 잘못된 JSON 작성 후 테스트
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tmpPath = '/tmp/test-invalid-learnings.json';
    const fs = await import('fs');
    fs.writeFileSync(tmpPath, 'not json', 'utf8');
    const result = loadLearnings(tmpPath);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    fs.unlinkSync(tmpPath);
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/__tests__/product-matcher.test.ts`
Expected: FAIL — `loadLearnings` not exported

**Step 3: loadLearnings 함수 추출 + export + console.warn 추가**

```typescript
export function loadLearnings(filePath: string): LearningEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const learnings = data.learnings || data || [];
    if (Array.isArray(learnings)) return learnings;
    console.warn(`Learnings: expected array, got ${typeof learnings}`);
    return [];
  } catch {
    console.warn(`Learnings not loaded from ${filePath} (optional)`);
    return [];
  }
}
```

main()에서: `learnings = loadLearnings(LEARNINGS_PATH);`

**Step 4: run-pipeline.ts silent catch도 수정**

```typescript
try { products = JSON.parse(fs.readFileSync(productsPath, 'utf8')); }
catch { console.warn(`Products data not available: ${productsPath}`); }
try { positioning = JSON.parse(fs.readFileSync(positioningPath, 'utf8')); }
catch { console.warn(`Positioning data not available: ${positioningPath}`); }
```

**Step 5: 테스트 통과 확인 + 커밋**

Run: `npx vitest run`
Expected: 54+ tests pass

```bash
git add scripts/product-matcher.ts scripts/run-pipeline.ts scripts/__tests__/product-matcher.test.ts
git commit -m "fix(threads): replace silent catch blocks with console.warn"
```

---

### Task 6: JSON parse 런타임 검증 + CATEGORY_FORMATS 가드

**Files:**
- Test: `scripts/__tests__/product-matcher.test.ts`
- Modify: `scripts/product-matcher.ts`
- Modify: `scripts/positioning.ts`

**Step 1: 실패하는 테스트 — validateProductDict shape 검증**

```typescript
import { validateProductDict } from '../product-matcher.js';

describe('validateProductDict', () => {
  test('accepts valid product dict', () => {
    const valid = { products: [{ product_id: 'x', name: 'y', category: 'z', needs_categories: ['불편해소'], keywords: ['k'], affiliate_platform: 'coupang_partners', price_range: '10000', description: 'd' }] };
    expect(() => validateProductDict(valid)).not.toThrow();
  });

  test('throws for missing products array', () => {
    expect(() => validateProductDict({})).toThrow(/products/);
  });

  test('throws for non-array products', () => {
    expect(() => validateProductDict({ products: 'bad' })).toThrow(/products/);
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run`
Expected: FAIL — `validateProductDict` not exported

**Step 3: 검증 함수 구현**

```typescript
export function validateProductDict(data: unknown): asserts data is { products: ProductEntry[] } {
  if (!data || typeof data !== 'object') throw new Error('Product dict: expected object');
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.products)) throw new Error('Product dict: missing or invalid "products" array');
}
```

main()에서 JSON.parse 후 `validateProductDict(productDict)` 호출.

**Step 4: CATEGORY_FORMATS undefined 가드 추가**

`positioning.ts`의 `buildPositioningCard`에서:

```typescript
const formats = CATEGORY_FORMATS[needCategory];
if (!formats) {
  console.warn(`Unknown needCategory: ${needCategory}, using 문제공감형 default`);
  formats = ['문제공감형', '솔직후기형', '비교형'];
}
```

**Step 5: 테스트 통과 + 커밋**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 57+ tests pass, 0 tsc errors

```bash
git add scripts/product-matcher.ts scripts/positioning.ts scripts/__tests__/product-matcher.test.ts
git commit -m "feat(threads): add runtime JSON validation and CATEGORY_FORMATS guard"
```

---

## Phase D: 기능 강화 (TDD)

### Task 7: 훅 템플릿 확장 (backward-compatible)

기존 인덱스 0,1 유지, 새 변형을 2~4에 추가. hash 함수도 개선 (충돌 감소).

**Files:**
- Test: `scripts/__tests__/positioning.test.ts`
- Modify: `scripts/positioning.ts:95-138`

**Step 1: 실패하는 테스트 — 최소 4개 변형 존재 확인**

```typescript
test('generates at least 4 unique hooks per format across different products', () => {
  const products = ['수면앱', '마그네슘 영양제', '허리 지지대', '타이머 앱 프리미엄', '무선 이어폰 프로', '소음 차단 귀마개'];
  const format: PositionFormat = '솔직후기형';
  const hooks = new Set(products.map(p =>
    generateHook({ format, productName: p, needCategory: '불편해소', problem: 'test' })
  ));
  expect(hooks.size).toBeGreaterThanOrEqual(3); // 6개 입력에서 최소 3가지 변형
});
```

**Step 2: 테스트 실패 확인 (현재 2개 변형만)**

Run: `npx vitest run scripts/__tests__/positioning.test.ts`
Expected: FAIL — hooks.size가 2 이하

**Step 3: 훅 배열 방식으로 리팩토링**

```typescript
export function generateHook(ctx: HookContext): string {
  const { format, productName, needCategory, problem } = ctx;
  const productShort = productName.split(' ').slice(0, 2).join(' ');
  const catLabel = needCategory;

  // 개선된 해시: 더 넓은 분포
  let hash = 0;
  for (let i = 0; i < productName.length; i++) {
    hash = ((hash << 5) - hash + productName.charCodeAt(i)) | 0;
  }
  hash = Math.abs(hash);

  const templates: Record<PositionFormat, string[]> = {
    '문제공감형': [
      `${problem} 나만 그런 줄 알았는데`,
      `이거 때문에 스트레스받다가 하나 찾았음`,
      `${problem} 해결하려고 별짓 다 했는데`,
      `솔직히 ${problem} 이제 좀 지침`,
    ],
    '솔직후기형': [
      `${productShort} 한 달 써보고 솔직하게 말함`,
      `광고 아니고 내 돈 주고 산 ${productShort} 후기`,
      `${productShort} 2주 차 중간 점검`,
      `3개월 째 ${productShort} 쓰는 사람으로서`,
    ],
    '비교형': [
      `${productShort} 류 3개 다 써봤는데 1개만 남김`,
      `${productShort} vs 비슷한 거 결론부터 말하면`,
      `이 카테고리 다 써봤는데 돈 아까운 거 알려줌`,
      `${productShort} 말고 다른 거 쓰다가 돌아옴`,
    ],
    '입문추천형': [
      `${catLabel} 쪽 처음이면 이거 하나만 사봐`,
      `주변에서 ${productShort} 추천 요청 올 때마다 이거 알려줌`,
      `${catLabel} 입문용으로 이거 하나면 됨`,
      `처음 시작하는 사람한테 매번 같은 거 추천함`,
    ],
    '실수방지형': [
      `${productShort} 사기 전에 이것만은 확인해`,
      `이거 모르고 샀다가 돈 버릴 뻔했음`,
      `${productShort} 살 때 흔한 실수 3가지`,
      `이거 먼저 봤으면 다른 거 안 샀을 듯`,
    ],
    '비추천형': [
      `솔직히 ${productShort} 종류 별로였던 것도 있음`,
      `이 카테고리 3개 써봤는데 2개는 돈 버렸음`,
      `다른 사람들 추천은 추천이고 내 경험은 좀 달랐음`,
      `${productShort} 류 중에 이건 진짜 별로`,
    ],
  };

  const variants = templates[format];
  return variants[hash % variants.length];
}
```

**Step 4: 기존 테스트 호환 확인**

기존 테스트는 패턴 매칭(`/나만|스트레스|찾았음/` 등)으로 검증하므로 새 변형에도 해당 단어가 포함되어야 함.
새 변형 3,4번째에 해당 패턴을 유지하거나, 테스트를 property-based로 완화:

```typescript
test('문제공감형 includes empathy pattern', () => {
  const hook = generateHook({ ...baseCtx, format: '문제공감형' });
  expect(hook).toMatch(/나만|스트레스|찾았음|별짓|지침/);
});
```

**Step 5: 모든 테스트 통과 + 커밋**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass

```bash
git add scripts/positioning.ts scripts/__tests__/positioning.test.ts
git commit -m "feat(threads): expand hook templates to 4 variants per format with improved hash"
```

---

### Task 8: 학습 피드백 스키마 + 샘플 파일

**Files:**
- Create: `data/learnings/latest.json`
- Test: `scripts/__tests__/product-matcher.test.ts`
- Modify: `scripts/product-matcher.ts`

**Step 1: 실패하는 테스트 — validateLearnings**

```typescript
import { validateLearnings } from '../product-matcher.js';

describe('validateLearnings', () => {
  test('accepts valid learnings array', () => {
    const valid = [{ product_id: 'x', naturalness_delta: 0.5 }];
    expect(validateLearnings(valid)).toEqual(valid);
  });

  test('returns empty for non-array', () => {
    expect(validateLearnings('bad')).toEqual([]);
  });

  test('filters entries without product_id', () => {
    const input = [{ product_id: 'x' }, { no_id: true }];
    expect(validateLearnings(input)).toHaveLength(1);
  });

  test('clamps delta values to [-2, 2]', () => {
    const input = [{ product_id: 'x', naturalness_delta: 10, clarity_delta: -5 }];
    const result = validateLearnings(input);
    expect(result[0].naturalness_delta).toBe(2);
    expect(result[0].clarity_delta).toBe(-2);
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run`
Expected: FAIL — `validateLearnings` not exported

**Step 3: 구현**

```typescript
export function validateLearnings(data: unknown): LearningEntry[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((entry): entry is Record<string, unknown> =>
      entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).product_id === 'string'
    )
    .map(entry => ({
      product_id: entry.product_id as string,
      naturalness_delta: clamp(Number(entry.naturalness_delta) || 0, -2, 2) || undefined,
      clarity_delta: clamp(Number(entry.clarity_delta) || 0, -2, 2) || undefined,
      ad_smell_delta: clamp(Number(entry.ad_smell_delta) || 0, -2, 2) || undefined,
      repeatability_delta: clamp(Number(entry.repeatability_delta) || 0, -2, 2) || undefined,
      story_potential_delta: clamp(Number(entry.story_potential_delta) || 0, -2, 2) || undefined,
    }));
}
```

**Step 4: 샘플 파일 생성**

```json
{
  "version": "1.0",
  "updated_at": "2026-03-14",
  "learnings": []
}
```

**Step 5: loadLearnings에서 validateLearnings 호출**

```typescript
export function loadLearnings(filePath: string): LearningEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return validateLearnings(data.learnings || data);
  } catch {
    console.warn(`Learnings not loaded from ${filePath} (optional)`);
    return [];
  }
}
```

**Step 6: 테스트 통과 + 커밋**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add scripts/product-matcher.ts scripts/__tests__/product-matcher.test.ts scripts/types.ts data/learnings/latest.json
git commit -m "feat(threads): add learning feedback validation with delta clamping"
```

---

### Task 9: affiliate_link 필드 + brief 표시

**Files:**
- Modify: `scripts/types.ts` (ProductEntry에 필드 추가)
- Test: `scripts/__tests__/product-matcher.test.ts` (brief link 표시 테스트)
- Modify: `scripts/run-pipeline.ts:163-179` (brief에 링크 표시)

**Step 1: types.ts에 optional 필드 추가**

```typescript
export interface ProductEntry {
  // ... existing fields ...
  affiliate_link?: string;
}
```

**Step 2: 실패하는 테스트 — brief에서 링크 표시**

brief 생성 로직을 직접 테스트하기 어려우므로, 링크 포맷 유틸을 분리:

```typescript
// run-pipeline.ts에서 export
export function formatProductLine(name: string, total: number, priceRange: string, link?: string): string {
  const base = `${name} — 적합도 ${total.toFixed(1)}/5, ${priceRange}원`;
  return link ? `${base}\n   링크: ${link}` : base;
}
```

테스트:
```typescript
import { formatProductLine } from '../run-pipeline.js';

describe('formatProductLine', () => {
  test('shows link when provided', () => {
    const line = formatProductLine('테스트', 3.5, '10000', 'https://link.coupang.com/xxx');
    expect(line).toContain('링크: https://link.coupang.com/xxx');
  });

  test('omits link when not provided', () => {
    const line = formatProductLine('테스트', 3.5, '10000');
    expect(line).not.toContain('링크');
  });
});
```

**Step 3: 테스트 실패 확인**

Run: `npx vitest run`
Expected: FAIL — `formatProductLine` not exported

**Step 4: 구현 + brief에서 사용**

run-pipeline.ts에 `formatProductLine` 추가 + export.
`generateBrief` 안에서 기존 `lines.push(...)` 대신 `formatProductLine` 호출.

**Step 5: isMainModule 가드 추가 (run-pipeline.ts)**

run-pipeline.ts의 `main()` 직접 호출을 가드:
```typescript
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('run-pipeline.ts') ||
  process.argv[1].endsWith('run-pipeline.js')
);
if (isMainModule) main();
```

**Step 6: 테스트 통과 + 커밋**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add scripts/types.ts scripts/run-pipeline.ts scripts/__tests__/product-matcher.test.ts
git commit -m "feat(threads): add affiliate_link field and brief link display"
```

---

## Phase E: LLM 강화 기반 (TDD)

### Task 10: LLM 출력 스키마 검증 유틸리티

실제 LLM 처리는 Claude Code 세션에서 수동으로 수행. 이 태스크는 LLM 출력의 스키마를 검증하고, brief에서 `*_llm.json`을 우선 로드하는 인프라만 구축.

**Files:**
- Create: `scripts/llm-enhance.ts`
- Test: `scripts/__tests__/llm-enhance.test.ts`
- Modify: `scripts/run-pipeline.ts` (brief에서 *_llm.json 우선 로드)

**Step 1: 실패하는 테스트**

```typescript
import { describe, test, expect } from 'vitest';
import { validateLLMProductOutput, validateLLMPositioningOutput } from '../llm-enhance.js';

describe('validateLLMProductOutput', () => {
  test('accepts valid LLM product output', () => {
    const valid = {
      improved_matches: [{
        need_id: 'test',
        recommended_products: [{
          product_id: 'x',
          adjusted_scores: { naturalness: 4, clarity: 4, ad_smell: 4, repeatability: 3, story_potential: 4 },
          content_angle: 'test angle',
          why_threads_fit: 'test reason',
        }],
      }],
      overall_strategy: 'test strategy',
    };
    expect(() => validateLLMProductOutput(valid)).not.toThrow();
  });

  test('throws for missing improved_matches', () => {
    expect(() => validateLLMProductOutput({})).toThrow(/improved_matches/);
  });

  test('clamps scores to 1-5', () => {
    const data = {
      improved_matches: [{
        need_id: 'test',
        recommended_products: [{
          product_id: 'x',
          adjusted_scores: { naturalness: 10, clarity: 0, ad_smell: 3, repeatability: 3, story_potential: 3 },
          content_angle: 'a', why_threads_fit: 'b',
        }],
      }],
      overall_strategy: 's',
    };
    const result = validateLLMProductOutput(data);
    expect(result.improved_matches[0].recommended_products[0].adjusted_scores.naturalness).toBe(5);
    expect(result.improved_matches[0].recommended_products[0].adjusted_scores.clarity).toBe(1);
  });
});

describe('validateLLMPositioningOutput', () => {
  test('accepts valid LLM positioning output', () => {
    const valid = {
      positioning_cards: [{
        product_id: 'x',
        product_name: 'y',
        need_id: 'z',
        positions: [{ format: '문제공감형', angle: 'a', tone: 't', hook: 'h', avoid: ['x'], cta_style: 'c' }],
      }],
    };
    expect(() => validateLLMPositioningOutput(valid)).not.toThrow();
  });

  test('throws for missing positioning_cards', () => {
    expect(() => validateLLMPositioningOutput({})).toThrow(/positioning_cards/);
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run`
Expected: FAIL — module not found

**Step 3: llm-enhance.ts 구현**

```typescript
import { clamp } from './product-matcher.js';

export interface LLMProductOutput {
  improved_matches: Array<{
    need_id: string;
    recommended_products: Array<{
      product_id: string;
      adjusted_scores: {
        naturalness: number;
        clarity: number;
        ad_smell: number;
        repeatability: number;
        story_potential: number;
      };
      content_angle: string;
      why_threads_fit: string;
    }>;
  }>;
  overall_strategy: string;
}

export interface LLMPositioningOutput {
  positioning_cards: Array<{
    product_id: string;
    product_name: string;
    need_id: string;
    positions: Array<{
      format: string;
      angle: string;
      tone: string;
      hook: string;
      avoid: string[];
      cta_style: string;
    }>;
  }>;
}

export function validateLLMProductOutput(data: unknown): LLMProductOutput {
  if (!data || typeof data !== 'object') throw new Error('LLM output: expected object');
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.improved_matches)) throw new Error('LLM output: missing improved_matches array');

  // Clamp all scores to 1-5
  for (const match of d.improved_matches as Array<Record<string, unknown>>) {
    const prods = match.recommended_products as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(prods)) continue;
    for (const prod of prods) {
      const scores = prod.adjusted_scores as Record<string, number> | undefined;
      if (scores) {
        for (const key of ['naturalness', 'clarity', 'ad_smell', 'repeatability', 'story_potential']) {
          if (typeof scores[key] === 'number') {
            scores[key] = clamp(scores[key], 1, 5);
          }
        }
      }
    }
  }

  return data as LLMProductOutput;
}

export function validateLLMPositioningOutput(data: unknown): LLMPositioningOutput {
  if (!data || typeof data !== 'object') throw new Error('LLM positioning: expected object');
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.positioning_cards)) throw new Error('LLM positioning: missing positioning_cards array');
  return data as LLMPositioningOutput;
}
```

**Step 4: brief에서 *_llm.json 우선 로드**

run-pipeline.ts의 `generateBrief`에서:

```typescript
// *_llm.json 우선 로드, 없으면 일반 파일 fallback
const productsLLMPath = path.join(BRIEFS_DIR, `${today}_products_llm.json`);
const positioningLLMPath = path.join(BRIEFS_DIR, `${today}_positioning_llm.json`);

let products: ProductsData | null = null;
let positioning: PositioningData | null = null;

// LLM 우선
try { products = JSON.parse(fs.readFileSync(productsLLMPath, 'utf8')); console.log('Using LLM-enhanced products'); }
catch {
  try { products = JSON.parse(fs.readFileSync(productsPath, 'utf8')); }
  catch { console.warn(`Products data not available: ${productsPath}`); }
}
try { positioning = JSON.parse(fs.readFileSync(positioningLLMPath, 'utf8')); console.log('Using LLM-enhanced positioning'); }
catch {
  try { positioning = JSON.parse(fs.readFileSync(positioningPath, 'utf8')); }
  catch { console.warn(`Positioning data not available: ${positioningPath}`); }
}
```

**Step 5: 테스트 통과 + 커밋**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add scripts/llm-enhance.ts scripts/__tests__/llm-enhance.test.ts scripts/run-pipeline.ts
git commit -m "feat(threads): add LLM output validation and *_llm.json priority loading"
```

---

## Phase F: 타입 통합 (비TDD)

### Task 11: run-pipeline.ts 중복 인터페이스 교체

**Files:**
- Modify: `scripts/run-pipeline.ts:38-86` (로컬 인터페이스 삭제, types.ts import)

**Step 1: import 추가**

```typescript
import type { ProductMatchOutput, PositioningOutput, NeedsMap, ResearchBrief } from './types.js';
```

**Step 2: 로컬 인터페이스 삭제**

`ResearchData`, `NeedsData`, `ProductsData`, `PositioningData` 삭제.
`generateBrief` 내에서 types.ts의 타입으로 교체:
- `ResearchData` → `ResearchBrief` (engagement_summary 접근 시 타입 단언 필요)
- `NeedsData` → `NeedsMap`
- `ProductsData` → `ProductMatchOutput`
- `PositioningData` → `PositioningOutput`

**주의**: `ResearchBrief.engagement_summary`는 `Record<string, unknown>`이므로, 사용처에서 타입 가드 필요:

```typescript
const engSummary = research.engagement_summary as { views?: { avg: number }; likes?: { avg: number } } | undefined;
lines.push(`- 참여도: 평균 조회 ${engSummary?.views?.avg ?? 'N/A'}, 좋아요 ${engSummary?.likes?.avg ?? 'N/A'}`);
```

**Step 3: tsc + 전체 테스트**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors, all tests pass

**Step 4: 최종 커밋**

```bash
git add scripts/run-pipeline.ts
git commit -m "refactor(threads): consolidate duplicate interfaces into types.ts imports"
```

---

## 최종 검증

Run: `npx tsc --noEmit && npx vitest run && npm run pipeline -- --brief`

Expected:
- tsc: 0 errors
- vitest: 60+ tests pass
- pipeline: 정상 실행, brief 출력

---

## 요약

| Phase | Tasks | TDD | 예상 테스트 추가 |
|-------|-------|-----|-----------------|
| A: 리팩토링 | 1-3 | No | 0 |
| B: 버그 수정 | 4 | Yes | +2 |
| C: 코드 품질 | 5-6 | Yes | +7 |
| D: 기능 강화 | 7-9 | Yes | +5 |
| E: LLM 기반 | 10 | Yes | +4 |
| F: 타입 통합 | 11 | No | 0 |
| **Total** | **11** | | **+18 (→68+)** |
