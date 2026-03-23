# 경쟁사 채널 모니터링 운영 가이드

## 개요

벤치마크 채널(현재 29개)의 성과를 주기적으로 평가하고, 저성과 채널을 교체하는 프로세스.
**목표 채널 수: 25~35개**

---

## 매주 일요일 실행 절차

### 1단계: 평가 실행 (dry-run)
```bash
cd /home/sihun92/projects/oh-my-claudecode/workspace/쓰레드2
npx tsx scripts/evaluate-channels.ts
```
결과 확인: 하위 20% (약 5~7개) 채널 목록 출력됨.

### 2단계: 결과 검토
- 하위 채널의 점수 및 이유 파악
- 데이터 부족(crawl_at 2일 미만 포스트만 있는 채널) 구분
- 실제 저성과 채널만 retired 대상으로 확정

### 3단계: retired 처리
```bash
npx tsx scripts/evaluate-channels.ts --apply
```

### 4단계: 신규 채널 보충
- retired 수만큼 신규 채널 발굴 (DISCOVERY_GUIDE.md 참조)
- 신규 채널: `benchmark_status='candidate'` → 30개 포스트 수집 → 평가 후 `verified`로 승격

---

## 평가 지표 상세

### 사용 데이터
- `thread_posts` 테이블에서 `crawl_at < NOW() - 2 days` 포스트만 사용
- (신규 수집 직후 포스트는 조회수가 아직 안정화 전이므로 제외)

### 지표 계산

| 지표 | 계산식 | 가중치 |
|------|--------|--------|
| `avg_views` | 2일+ 경과 포스트 평균 조회수 | 40% |
| `avg_engagement` | (좋아요+댓글+리포스트) / 조회수 평균 | 30% |
| `post_frequency` | 최근 7일 내 포스트 수 | 30% |

**종합 점수** = `avg_views * 0.4 + avg_engagement * 100 * 0.3 + post_frequency * 0.3`

### benchmark_status 값

| 값 | 의미 |
|----|------|
| `candidate` | 발굴됨, 아직 검증 전 |
| `verified` | 검증 완료, 활성 모니터링 중 |
| `rejected` | 검증 실패 (제휴링크 과다, 카테고리 불일치 등) |
| `retired` | 성과 부진으로 모니터링 중단 |

---

## 채널 교체 프로세스

```
[발굴] → candidate → (30개 수집 + 검증) → verified  ← 활성 모니터링
                                          ↓
                                       rejected       (제휴링크 과다, 카테고리 불일치)

[활성] verified → (주간 평가 하위 20%) → retired      (성과 부진)
```

### 채널 수 유지 규칙

- **목표**: 25~35개 유지
- retired 발생 시 동수 이상으로 신규 candidate 보충
- 현재 29개 → retired 5개 → 5개 이상 신규 발굴 필요
- 30개 이하면 적극적으로 신규 채널 탐색

### 신규 채널 발굴 방법

```bash
# Exa로 카테고리별 Threads 채널 검색
# 예: 뷰티, 건강, 다이어트 카테고리 인플루언서
```
DISCOVERY_GUIDE.md 참조.

---

## 트러블슈팅

### 채널 점수가 모두 0인 경우
→ 해당 채널의 crawl_at이 모두 2일 미만 (최근에 처음 수집된 채널)
→ 다음 주에 재평가

### 활성 채널이 25개 미만으로 줄 경우
→ `--apply` 사용 중단, 수동으로 하위 채널 확인 후 선택적 retired 처리

### 채널 복구 (retired → verified)
```sql
UPDATE channels SET benchmark_status = 'verified' WHERE channel_id = '<id>';
```
