# Safety Gate 운영 가이드

BiniLab 포스트 게시 전 반드시 통과해야 하는 8개 안전 게이트.

---

## 게이트 목록

| # | 게이트 | 타입 | 조건 | 설명 |
|---|--------|------|------|------|
| 1 | `gate1_warmupCheck` | **block** | 워밍업 모드에서 제휴/광고 키워드 | 쿠팡·coupang·제휴·광고 포함 시 차단 |
| 2 | `gate2_lengthCheck` | **block** | 500자 초과 | Threads 최대 길이 초과 |
| 3 | `gate3_frequencyCheck` | **block** | 마지막 게시 후 1시간 미경과 | 스팸 방지 최소 간격 |
| 4 | `gate4_duplicateCheck` | **block** | 유사도 > 0.8 (Jaccard bigram) | recycle.ts의 checkSimilarity 재사용 |
| 5 | `gate5_brandSafety` | **block** | 욕설·정치·경쟁사비방 키워드 | BANNED_PATTERNS 정규식 |
| 6 | `gate6_qaPassCheck` | **block** | QA 점수 < 10 | doyun-qa 체크리스트 미통과 |
| 7 | `gate7_dailyLimitCheck` | **block** | 오늘 10개 이상 게시 | 일일 한도 초과 |
| 8 | `gate8_captchaRisk` | **warn** | 연속 3개 간격 < 10분 | 캡차 유발 위험 — 차단 아님 |

---

## block vs warn 구분

- **block**: `allPassed = false` → 게시 중단. 원인 해결 후 재실행.
- **warn**: `allPassed = true` → 게시는 진행. 로그에 경고 기록.

`SafetyReport.blockers` → 즉시 해결 필요  
`SafetyReport.warnings` → 주의 필요, 게시는 허용

---

## 사용법

```typescript
import { runSafetyGates } from '../safety/gates.js';

const report = await runSafetyGates(content, accountId, qaScore, db);

if (!report.allPassed) {
  console.error('게시 차단:', report.blockers.map(r => r.reason));
  return; // 게시 중단
}

if (report.warnings.length > 0) {
  console.warn('경고:', report.warnings.map(r => r.reason));
  // 게시는 계속 진행
}
```

---

## 게이트별 실패 시 대응

| 게이트 | 대응 방법 |
|--------|-----------|
| gate1 | 제휴/광고 문구 제거 후 재작성. 워밍업 완료(100개) 후 사용 가능. |
| gate2 | 콘텐츠 500자 이하로 압축. 에디터에게 반려. |
| gate3 | 마지막 게시 후 1시간 대기. 스케줄러가 자동 재시도. |
| gate4 | 새 앵글로 재작성. recycle.ts의 generateVariationTemplate 참조. |
| gate5 | 금지 키워드 제거 후 재작성. BANNED_PATTERNS 확인. |
| gate6 | QA 재실행. doyun-qa 체크리스트 10항목 + K1~K4 킬러게이트 재검토. |
| gate7 | 내일 슬롯으로 이월. 일일 한도 10개 절대 준수. |
| gate8 | 10분 대기 후 재시도. 안티봇 간격 엄수. |

---

## 우회 금지 규칙 (hard)

- **게이트 우회 절대 금지.** 어떤 이유로도 `runSafetyGates()` 건너뛰기 불가.
- 엔지니어도 동일. 우회가 필요한 경우 사용자(시훈) 승인 필수.
- `block` 게이트 실패 시 게시 강행 금지. 원인 해결이 선행되어야 함.
- 로그 필수: 모든 게이트 결과를 `agent_messages` 또는 콘솔에 기록.

---

## 관련 파일

- 구현: `src/safety/gates.ts`
- 테스트: `src/__tests__/safety-gates.test.ts`
- 의존: `src/utils/warmup-gate.ts`, `src/recycler/recycle.ts`
