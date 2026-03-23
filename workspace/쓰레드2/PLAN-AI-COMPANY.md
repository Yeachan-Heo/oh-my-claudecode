# BiniLab AI Company Plan v4 — 2026-03-23

> **미션**: 소비자의 진짜 고민에 공감하는 콘텐츠로, 자연스럽게 해결책을 연결하는 자율 AI 마케팅 대행사.
> **목표**: 하루 10개 포스트 자율 생산 → 워밍업 100개 → 제휴마케팅 수익화 → 10계정 확장
> **원칙**: 기존 도구 최대 활용. 새 코드 최소화. 성과 데이터 기반 의사결정. 역할별 권한 엄격 분리.

---

## 1. 현재 상태 (세션 12, 2026-03-23)

### 완성된 인프라

| 도구 | 상태 | 핵심 |
|------|------|------|
| `/수집` 스킬 | ✅ | 벤치마크(--since 24h) + YouTube(playlistItems 1unit) + X트렌드 + 성과. 병렬 실행. |
| `/기획` (threads-plan) | ✅ | 5소스 24h 스캔 → JTBD → 기획서 3개 |
| 토론 시스템 | ✅ | 가이드+빈이 토론 → 체크리스트 10/10 |
| `/threads-post` | ✅ | CDP 자동 게시 + DB 업데이트 |
| `collect.ts` | ✅ | upsert + --since 시간 기반 중단 |
| `topic-classifier.ts` | ✅ | TAG_MAP + classifyByText() 본문 매칭 |
| 네이버 검색량/트렌드 | ✅ | search.py + trend.py (API 키 연동 완료) |

### DB 현황
- thread_posts: 1,329개 (세션 12에서 +94 신규, +156 지표 업데이트)
- youtube_videos: 51개, youtube_channels: 49개 (47 UC + 2 핸들)
- channels: 29개 verified
- 워밍업: **8/100** (목표 변경: 20 → 100)
- 계정: 1개 (@duribeon231)

---

## 2. 조직 구조 — BiniLab

### 2-1. 에이전트 조직도

```
민준 CEO (Chief Executive Officer)
 │
 ├── 콘텐츠 본부 — 글쓰기 전담, 코드/설정 수정 불가
 │   ├── 빈이 — 뷰티 에디터
 │   ├── 하나 — 건강 에디터
 │   ├── 소라 — 생활 에디터
 │   └── 지우 — 다이어트 에디터
 │
 ├── 품질/분석 — 검증+분석 전담, 수정 불가
 │   ├── 도윤 — 품질관리자 (QA Manager)
 │   └── 서연 — 데이터 분석가 (Data Analyst)
 │
 ├── 리서치 — 수집+탐색 전담
 │   └── 준호 — 트렌드 리서처 (Trend Researcher)
 │
 └── 개발 — 코드/도구 수정 유일 권한
     └── 태호 — 시스템 엔지니어 (System Engineer)
```

**총 9명**: CEO 1 + 에디터 4 + QA 1 + 분석가 1 + 리서처 1 + 엔지니어 1

### 2-2. 권한 매트릭스 (엄격 분리)

| 에이전트 | 이름 | Read | Write(포스트) | Write(코드) | Bash | DB조회 | DB수정 | 스킬호출 | 에이전트스폰 |
|---------|------|------|-------------|------------|------|--------|--------|---------|-------------|
| CEO | 민준 | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| 뷰티 에디터 | 빈이 | ✅ | ✅포스트만 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 건강 에디터 | 하나 | ✅ | ✅포스트만 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 생활 에디터 | 소라 | ✅ | ✅포스트만 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 다이어트 에디터 | 지우 | ✅ | ✅포스트만 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| QA | 도윤 | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| 분석가 | 서연 | ✅ | ❌ | ❌ | ✅읽기 | ✅ | ❌ | ✅분석 | ❌ |
| 리서처 | 준호 | ✅ | ❌ | ❌ | ✅수집 | ✅ | ✅수집 | ✅수집 | ❌ |
| 엔지니어 | 태호 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

**핵심 규칙**:
- 에디터(빈이/하나/소라/지우)는 **포스트 글쓰기만** 가능. 코드, 프롬프트, 설정 수정 불가.
- 코드/도구/스킬 수정은 **오직 태호(엔지니어)만** 가능.
- CEO(민준)는 판단+지시만. 직접 글을 쓰거나 코드를 수정하지 않음.

### 2-3. 코드 수정 프로토콜 (태호 전용)

```
어떤 에이전트든 문제/개선 발견
  예: 도윤(QA) "체크리스트에 '네이버 검색량 확인' 항목 추가 필요"
  예: 서연(분석가) "topic-classifier에 '단백질' 키워드 누락"
  예: 준호(리서처) "collect.ts 타임아웃이 짧아서 실패 잦음"
  ↓
민준(CEO)에게 변경 요청:
  - 사유: 왜 변경이 필요한지
  - 변경 내용: 구체적으로 뭘 바꿀지
  - 예상 효과: 바꾸면 뭐가 좋아지는지
  ↓
민준 판단:
  - 합당 → 시훈에게 보고 + 승인 요청
  - 불합당 → 반려 + 사유 전달
  ↓
시훈 승인
  ↓
태호(엔지니어)에게 작업 지시:
  1. git commit — 현재 상태 백업
  2. 코드 수정 — 승인된 범위만
  3. 타입체크 — npx tsc --noEmit
  4. 테스트 — npm test
  5. 검증 성공 → 완료 보고 → CEO+요청자에게 알림
  6. 검증 실패 → git revert → 다른 방법 탐색 → CEO에게 보고
```

### 2-4. 에이전트 캐릭터 설계

#### 민준 — CEO (Chief Executive Officer)
```yaml
# .claude/agents/minjun-ceo.md
name: minjun-ceo
model: opus
tools: Read, Glob, Grep
skills: [수집, 기획, analyze-performance, daily-run, weekly-retro]
```
```
성격: 냉철, 분석적. 감이 아닌 숫자로 판단. 성과 최우선.
원칙:
  1. ROI 낮으면 즉시 손절 — 감정적 미련 없음
  2. 실험 30% 강제 할당 (3/10 포스트)
  3. 하위 20% 전략 매주 교체
  4. 파라미터 변경 시 사유 보고 + 시훈 승인 후 태호에게 지시
역할: 일일 directive 생성, 에이전트 작업 배분, 전략 결정, 코드 변경 승인 중개
```

#### 빈이 — 뷰티 에디터
```yaml
# .claude/agents/bini-beauty-editor.md
name: bini-beauty-editor
model: sonnet
tools: Read
disallowedTools: Write, Edit, Bash
```
```
전문성: 스킨케어, 메이크업, 올리브영, 성분 분석
톤: 밝고 솔직, "이거 써봤는데 진짜 달라" 스타일
특기: 제품 비교, 성분 해석을 쉽게 풀어냄
도메인 지식: 피부 타입별 루틴, 시즌별 스킨케어, 성분 효능
제한: 포스트 초안 작성만. 코드/설정/프롬프트 수정 불가.
```

#### 하나 — 건강 에디터
```yaml
# .claude/agents/hana-health-editor.md
name: hana-health-editor
model: sonnet
tools: Read
disallowedTools: Write, Edit, Bash
```
```
전문성: 영양제, 건강기능식품, 약사 관점
톤: 정보+공감, "나도 피곤해서 찾아봤는데" 스타일
특기: 복잡한 건강 정보를 일상 언어로 번역
도메인 지식: 영양제 조합, 흡수율, 부작용, 복용 시간
제한: 포스트 초안 작성만.
```

#### 소라 — 생활 에디터
```yaml
# .claude/agents/sora-lifestyle-editor.md
name: sora-lifestyle-editor
model: sonnet
tools: Read
disallowedTools: Write, Edit, Bash
```
```
전문성: 생활용품, 주방, 인테리어, 가전, 가성비
톤: 실용적, "이거 쓰고 나서 안 쓰던게 후회됨" 스타일
특기: 가성비 비교, 실사용 후기, 대안 추천
도메인 지식: 쿠팡/다이소 제품, 수납, 청소, 자취 꿀팁
제한: 포스트 초안 작성만.
```

#### 지우 — 다이어트 에디터
```yaml
# .claude/agents/jiu-diet-editor.md
name: jiu-diet-editor
model: sonnet
tools: Read
disallowedTools: Write, Edit, Bash
```
```
전문성: 다이어트, 식단, 홈트, 체중관리
톤: 응원+현실, "의지 탓 아니야, 방법이 틀린 거야" 스타일
특기: 현실적 식단, 실패 경험 공유, 동기부여
도메인 지식: 칼로리 계산, 간헐적 단식, 단백질, 보충제
제한: 포스트 초안 작성만.
```

#### 도윤 — 품질관리자 (QA Manager)
```yaml
# .claude/agents/doyun-qa.md
name: doyun-qa
model: opus           # 품질 판단은 복잡한 맥락 이해 필요
tools: Read, Grep, Glob
disallowedTools: Write, Edit, Bash
```
```
전문성: 콘텐츠 품질 관리, 체크리스트 검증
성격: 엄격하지만 근거 기반. "느낌"으로 반려하지 않음.
역할: 체크리스트 10항목 + K1~K4 킬러게이트 검증
제한: 포스트 검증만. 포스트 수정/코드 수정 불가. 문제 발견 시 에디터에게 반려 또는 CEO에게 보고.
```

#### 서연 — 데이터 분석가 (Data Analyst)
```yaml
# .claude/agents/seoyeon-analyst.md
name: seoyeon-analyst
model: opus           # 니즈 분석, 실험 설계 등 복잡한 추론 필요
tools: Read, Grep, Glob, Bash
skills: [analyze-performance, keyword-search]
```
```
전문성: 성과 분석, 시장 분석, A/B 실험 설계
성격: 숫자 뒤의 "왜"를 파는 사람. 상관관계 ≠ 인과관계 구분.
역할: 일일 성과 리포트, 주간 트렌드 분석, 실험 결과 해석, 네이버 검색량 분석
제한: DB 읽기+분석만. 코드/데이터 수정 불가.
```

#### 준호 — 트렌드 리서처 (Trend Researcher)
```yaml
# .claude/agents/junho-researcher.md
name: junho-researcher
model: sonnet
tools: Read, Grep, Glob, Bash
skills: [수집]
```
```
전문성: 소비자 트렌드 발굴, 경쟁사 모니터링, 브랜드 리서치
성격: 호기심 왕성, 소비자 시선으로 세상을 봄
역할: 벤치마크 채널 관리, 경쟁사 포스트 분석, 브랜드 이벤트 탐색, 신규 채널 발굴
제한: 수집 스크립트 실행 + DB 수집 데이터 저장만. 코드 수정 불가.
```

#### 태호 — 시스템 엔지니어 (System Engineer)
```yaml
# .claude/agents/taeho-engineer.md
name: taeho-engineer
model: opus
tools: Read, Write, Edit, Bash, Grep, Glob
```
```
전문성: TypeScript, Python, PostgreSQL, Playwright, 시스템 아키텍처
성격: 신중하고 꼼꼼. 변경 전 항상 백업. 테스트 후 배포.
역할: 코드/도구/스킬 수정의 유일한 실행자
프로토콜:
  1. CEO로부터 승인된 작업 지시 수신
  2. git commit (백업)
  3. 수정 (승인 범위만)
  4. tsc --noEmit + npm test (검증)
  5. 성공 → 완료 보고 / 실패 → revert + 대안 탐색
제한: CEO 또는 시훈의 승인 없이 자발적 코드 수정 금지.
```

---

## 3. 에이전트 소통 시스템

### 3-1. 정기 회의

| 회의 | 주기 | 참여자 | 목적 |
|------|------|--------|------|
| **데일리 스탠드업** | 매일 | CEO + 전원 | 오늘 할 일 결정, 어제 성과 리뷰 |
| **주간 전략회의** | 매주 일 | CEO + 분석가 + 빈이 대표 | 주간 성과, 전략 조정, 실험 설계 |
| **콘텐츠 토론** | 포스트마다 | 가이드 + 해당 빈이 | 포스트 품질 검증 |

### 3-2. 비동기 채팅 시스템

> **구현 전 리서치 필요**: 멀티 에이전트 소통 시스템 논문/GitHub 사례 조사 후 설계.
> 리서치 대상: CrewAI, AutoGen, MetaGPT, ChatDev 등 멀티에이전트 프레임워크의 통신 패턴.

**DB 스키마 (agent_messages 테이블)**:
```sql
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,        -- 'ceo', 'bini_beauty', 'guide', 'analyst', 'researcher'
  recipient TEXT NOT NULL,     -- 에이전트 이름 또는 'all' (전체)
  channel TEXT NOT NULL,       -- 'standup', 'weekly', 'debate', 'async'
  message TEXT NOT NULL,
  context JSONB,               -- 관련 post_id, experiment_id 등
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_by JSONB DEFAULT '[]'   -- 읽은 에이전트 목록
);

CREATE INDEX idx_agent_msg_date ON agent_messages(created_at);
CREATE INDEX idx_agent_msg_channel ON agent_messages(channel);
CREATE INDEX idx_agent_msg_sender ON agent_messages(sender);
```

**기능**:
- 날짜별 대화 조회
- 채널별 필터 (스탠드업/토론/비동기)
- 에이전트별 읽음 상태 추적
- 긴급 메시지: 리서처 → CEO (급한 트렌드 발견 시)

---

## 4. 일일 파이프라인 — `/daily-run`

### 4-1. 하루 10개 포스트 생산 플로우

```
/daily-run (매일 실행)
│
├─ Phase 1: 데이터 수집 (병렬)
│   ├─ [병렬] 벤치마크 29채널 --since 24 (CDP)
│   ├─ [병렬] YouTube 47채널 --days 1 (API)
│   ├─ [병렬] X트렌드 수집+필터 (Apify)
│   ├─ [병렬] 네이버 검색량 수집 (카테고리 대표키워드)
│   ├─ [병렬] 네이버 트렌드 수집 (trend.py)
│   └─ [병렬] 브랜드 리서치 80개/카테고리 (6에이전트 × 10브랜드/라운드)
│
├─ Phase 2: 분석 (Phase 1 완료 후)
│   ├─ 카테고리 자동 분류 (topic-classifier)
│   ├─ 성과 분석 (/analyze-performance)
│   ├─ 니즈 스캔 (24h 신호 5소스)
│   ├─ 네이버 키워드 확장 검색 (니즈에서 발견된 키워드 → 변형 검색)
│   └─ 경쟁사 포스트 분석 (벤치마크 TOP 포스트)
│
├─ Phase 3: CEO 스탠드업
│   ├─ Phase 2 결과 종합
│   ├─ 니즈 기반 카테고리 비율 결정 (뷰티 4 / 건강 3 / 생활 2 / 다이어트 1 등)
│   ├─ 10개 포스트 할당 (7개 일반 + 3개 실험)
│   ├─ 시간대 배분 (최소 1시간 간격)
│   ├─ 리사이클 후보 선정 (고성과 포스트 변형 재게시)
│   └─ daily_directive 생성
│
├─ Phase 4: 콘텐츠 생성 (10개, 카테고리별 빈이 담당)
│   ├─ 기획: /threads-plan + 네이버 검색량 지표
│   ├─ 토론: 가이드 + 해당 카테고리 빈이
│   ├─ QA: 체크리스트 + 워밍업 게이트
│   └─ 큐 등록: aff_contents status='ready'
│
├─ Phase 5: 게시 (시간대별 분산)
│   ├─ 승인 대기 (시훈 텔레그램 알림)
│   ├─ 승인 시: /threads-post 자동 게시
│   └─ 최소 1시간 간격 유지
│
└─ Phase 6: 사후 관리
    ├─ 성과 수집 (track-performance.ts, 게시 24h 후)
    ├─ 실험 결과 기록
    └─ 에이전트 학습 기록
```

### 4-2. 시간대 배분 전략

CEO가 벤치마크 데이터 기반으로 최적 시간대 할당:

```
오전 8시  — 2개 (avg 8,125뷰, 최고 시간대)
오전 11시 — 1개 (avg 6,298뷰)
오후 2시  — 1개 (avg 6,365뷰)
오후 3시  — 1개 (avg 7,438뷰)
저녁 6시  — 1개 (avg 5,657뷰)
저녁 8시  — 2개 (avg 6,229뷰)
밤 9시   — 1개 (avg 5,276뷰)
밤 10시  — 1개 (실험 슬롯 — 시간대 실험용)
```

규칙: 게시 간 **최소 1시간 간격**. CEO가 실험 데이터 기반으로 매주 조정.

---

## 5. 데이터 수집 확장

### 5-1. 네이버 데이터 통합

**`/수집`에 네이버 추가**:

```bash
# 카테고리별 대표 키워드 검색량
python3 naver-keyword-search/search.py "선크림" "영양제" "생활용품" "다이어트 식품" --no-expand

# 네이버 트렌드 (30일)
python3 naver-keyword-search/trend.py "선크림" "영양제 추천" "가성비 생활템" --period 30
```

**`/기획`에서 네이버 데이터 활용**:

니즈 분석에서 발견된 키워드 → 네이버 검색량 확장 검색:
```
키워드 "선크림" 발견
  → L1: "선크림" (월 320,000)
  → L2: "선크림 추천" (월 45,000) / "지성 선크림" (월 12,000)
  → L3: "지성 선크림 추천" (월 3,500) / "선크림 뭐 써" (월 2,100)
  → 시장 판단: A+ (대시장 + 상승) → 기회 점수 가산
```

### 5-2. 브랜드 리서치 확장 (40 → 80개/카테고리)

```
현재: 40개 브랜드 (전체)
목표: 카테고리별 최대 80개 (없으면 찾은 수만큼)

실행 방식:
  라운드 1: 6 에이전트 × 10 브랜드 = 60개 병렬 검색
  라운드 2: 남은 20개 (또는 카테고리별 잔여)

카테고리별:
  뷰티: 80개 (올리브영, 시세이도, 에스티로더, ... )
  건강: 80개 (마이프로틴, 일동, 종근당, ...)
  생활: 80개 (다이슨, 샤오미, 무인양품, ...)
  다이어트: 60개 (가용 브랜드 제한)
```

### 5-3. 경쟁사 모니터링 시스템

**기존 벤치마크 수집 스크립트를 활용한 자동 채널 관리:**

```
매주 일요일 (주간회의 전):
  1. 채널 평가 — 수집 후 2일+ 된 포스트만 평가
     평가 지표:
       - 평균 조회수 (view_count)
       - 평균 참여율 ((likes + replies + reposts) / views)
       - 포스팅 빈도 (7일 내 포스트 수)
       - 제휴 콘텐츠 비율 (thread_type별)

  2. 하위 20% 제거 — 29채널 중 하위 6개 channels.benchmark_status='retired'
     (5일이면 Threads 포스트가 충분히 도달하므로 2일+ 데이터로 평가 가능)

  3. 신규 채널 발굴 — 리서처가 키워드 검색 + Exa 웹 검색으로 후보 탐색
     scripts/discover-youtube-channels.py 패턴을 Threads에 적용
     후보 검증: collect.ts로 30개 포스트 수집 → 평균 성과 확인 → verified 승격

  4. 채널 수 유지: 항상 25~35개 verified 상태 유지
```

---

## 6. 자율 진화 시스템

### 6-1. 코드/설정 변경 프로토콜

```
성과 분석 결과 이상 감지
  ↓
분석가: "어떤 지표가 왜 떨어졌는지" 원인 분석
  ↓
CEO: 수정 필요 여부 판단 + 수정 범위 결정
  ↓
시훈에게 보고: "이유: X, 변경안: Y, 예상 효과: Z"
  ↓
시훈 승인
  ↓
git commit (현재 상태 백업)
  ↓
변경 실행 (승인된 범위만)
  ↓
검증 (타입체크 + 테스트)
  ↓
실패 시: git revert → 다른 방법 탐색
성공 시: 변경 기록 → strategy-log
```

**변경 가능 범위**:
- soul/ops 문서 수정 (전략 조정)
- 수집 스크립트 파라미터 (키워드, 채널 수, 시간 필터)
- 분류기 키워드 (TAG_MAP, TEXT_KEYWORDS)
- **코드 자체 수정은 반드시 시훈 승인 후**

### 6-2. autoresearch 통합 — 콘텐츠 전략 실험

```
실험 유형 (3/10 포스트 할당):
  1. 훅 최적화: "숫자 포함 vs 미포함" → 24h 조회수 비교
  2. 포맷 실험: "비교형 vs 리스트형" → 참여율 비교
  3. 시간대 실험: "오전 8시 vs 밤 10시" → 조회수 비교

실험 스키마:
  experiment_id, hypothesis, variable, variant_a, variant_b
  start_date, end_date, post_ids[], status, verdict, confidence

결과 처리:
  n=1 → 'directional' (방향성 참고)
  3회 일관된 방향 → 'replicated' (전략 반영)
```

### 6-3. 포스트 리사이클 시스템

```
조건: 게시 14일+ 경과, 조회수 상위 20% 포스트
방법:
  1. 원본 포스트에서 핵심 소재 추출
  2. 다른 앵글/포맷으로 재작성 (같은 빈이가 다른 접근)
  3. 원본과 코사인 유사도 < 0.7 확인 (중복 방지)
  4. 새 포스트로 게시 (리사이클 태그)
CEO가 매일 리사이클 후보 1~2개 선정
```

---

## 7. 학습 시스템

### 7-1. 에이전트 메모리

```
agents/memory/
├── strategy-log.md      — CEO 일일 결정 + 결과 (append-only)
├── experiment-log.md    — 실험 결과 (hypothesis → verdict)
├── weekly-insights.md   — 주간 요약 (TOP/BOTTOM 분석)
├── category-playbook/   — 카테고리별 학습 기록
│   ├── beauty.md        — 뷰티: 뭐가 먹히고 뭐가 안 먹히는지
│   ├── health.md
│   ├── lifestyle.md
│   └── diet.md
└── retro/               — 주간회의 기록
    └── retro-2026-03-23.md
```

### 7-2. 다양성 체크

```
분석가가 매일 체크:
  - 최근 10개 포스트 중 같은 포맷 > 60% → "포맷 단조로움" 경고
  - 같은 카테고리 > 50% → "카테고리 편중" 경고
  - CEO가 다음 날 directive에 반영
```

---

## 8. Phase 로드맵

### Phase 1: Foundation (세션 A~B, 2세션)

| Step | 작업 | 완료 기준 |
|------|------|----------|
| S-1 | agency.md + 8개 soul 파일 작성 (4 빈이 + CEO + 가이드 + 분석가 + 리서처) | soul/ops 분리, 기존 스킬 정상 동작 |
| S-2a | CEO soul 상세화 + daily-standup-ops.md | DB 쿼리 템플릿 포함 |
| S-2b | CEO Shadow Mode 5일 — 추천만, 실행 안 함. 정확도 ≥ 80% | 5일 연속 shadow report + 시훈 채점 |
| S-3 | agent_messages DB 테이블 생성 | 날짜별/채널별 조회 가능 |
| S-4 | 멀티에이전트 소통 시스템 리서치 (CrewAI, AutoGen, MetaGPT, ChatDev) | 리서치 보고서 + 적용 계획 |

### Phase 2: Semi-Autonomous (세션 C~E, 3세션)

| Step | 작업 | 완료 기준 |
|------|------|----------|
| S-5 | `/daily-run` 스킬 (10개 포스트 파이프라인) | E2E 3회 성공 |
| S-6 | aff_contents.status 컬럼 + 워밍업 게이트 (published < 100) | DB 트리거 검증 |
| S-7 | 네이버 검색량/트렌드 → /수집 + /기획 통합 | 기획서에 네이버 데이터 반영 |
| S-8 | 브랜드 리서치 확장 (80개/카테고리, 6에이전트 병렬) | 320개 브랜드 DB 등록 |
| S-9 | 경쟁사 모니터링 (하위 20% 주간 교체 + 신규 발굴) | 주간 채널 평가 자동화 |
| S-10 | autoresearch 실험 시스템 (스키마 + 평가 스크립트) | 실험 1회 완주 |
| S-11 | 포스트 리사이클 시스템 | 리사이클 포스트 1개 게시 |
| S-12 | 학습 시스템 (memory/ + 다양성 체크) | strategy-log 누적 |

### Phase 3: Full Autonomous (세션 F~G, 2세션)

| Step | 작업 | 완료 기준 |
|------|------|----------|
| S-13 | Safety Check 8개 게이트 | 개별 게이트 테스트 통과 |
| S-14 | 자율 게시 + 30분 모니터링 | 7일 자율 운영, 삭제 0건 |
| S-15 | 주간 전략회의 자동화 (/team 3자 회의) | 전략 변경 → 성과 반영 1회 |
| S-16 | 수익 추적 시스템 (워밍업 100 완료 후) | 쿠팡파트너스 수익 DB 연동 |
| S-17 | CEO 자율 실험 설계 (3회 성공 후 승인 불필요) | 자율 실험 1회 |

---

## 9. 기존 도구 활용 매핑

| 기능 | 기존 도구 (변경 없음) | 새로 만들 것 |
|------|---------------------|-------------|
| Threads 수집 | `collect.ts` (upsert + --since) | - |
| YouTube 수집 | `collect-youtube-comments.ts` (playlistItems) | - |
| X 트렌드 | `run-trend-pipeline.ts` (Apify) | - |
| 네이버 검색량 | `naver-keyword-search/search.py` | /수집 통합만 |
| 네이버 트렌드 | `naver-keyword-search/trend.py` | /기획 통합만 |
| 카테고리 분류 | `topic-classifier.ts` (TAG_MAP + text) | - |
| 포스트 기획 | `/threads-plan` 스킬 | 네이버 데이터 연동 |
| 포스트 작성 | 토론 시스템 | 카테고리별 빈이 분기 |
| 포스트 게시 | `/threads-post` 스킬 | - |
| 성과 수집 | `track-performance.ts` | - |
| 성과 분석 | `/analyze-performance` 스킬 | - |
| 브랜드 리서치 | `research-brands.ts` + Exa | 80개 확장 + 병렬 |
| 채널 발굴 | `discover-youtube-channels.py` | Threads 버전 |
| 병렬 실행 | `/team` 스킬 | - |
| 실험 시스템 | `omc autoresearch` | 평가 스크립트 1개 |
| **새로 만들 것** | | |
| 에이전트 채팅 | - | `agent_messages` 테이블 |
| Daily Pipeline | - | `/daily-run` 스킬 (오케스트레이션) |
| 게시 큐 | - | `aff_contents.status` 컬럼 |
| 경쟁사 평가 | - | 주간 평가 스크립트 |
| 리사이클 | - | 유사도 체크 + 변형 로직 |
| 수익 추적 | - | 쿠팡파트너스 API 연동 (Phase 3) |

---

## 10. 워밍업 전략 (8/100)

```
현재: 8개 완료
목표: 100개 (이전 20개에서 확대)
하루 10개 → 약 10일이면 완료

워밍업 규칙:
  - 제휴링크/광고 금지 (DB 트리거로 강제)
  - 셀프댓글 금지
  - 순수 정보+공감 콘텐츠만
  - 카테고리별로 고르게 분배
  - 워밍업 끝나면 즉시 수익화 시스템 가동
```

---

## 11. 리스크 & 대응

| 리스크 | 심각도 | 대응 |
|--------|--------|------|
| CEO 잘못된 판단 | HIGH | Shadow Mode 검증 + 주간 전략회의 + 시훈 승인 |
| 하루 10개 품질 저하 | HIGH | 가이드 전수 검증 + 카테고리별 전문 빈이 |
| 계정 제재/밴 | HIGH | 8개 Safety Gate + 게시 간격 1시간 + 일 최대 10개 |
| 소재 고갈 | MEDIUM | 리사이클 시스템 + 5소스 다중 수집 + 네이버 트렌드 |
| 실험 낭비 | MEDIUM | 3/10으로 제한 + 48h 평가 + directional 라벨 |
| 학습 오버피팅 | MEDIUM | 다양성 체크 (포맷 60% / 카테고리 50% 경고) |
| CDP 블록 | MEDIUM | 순차 실행 + 랜덤 딜레이 + 수동 fallback |
| API 비용 | LOW | 전부 Claude Code 직접 분석 ($0) + playlistItems (1 unit) |

---

## 12. 시훈의 역할 변화

| Phase | 시훈이 하는 것 | 시훈이 안 하는 것 | 예상 시간 |
|-------|---------------|-----------------|----------|
| Phase 1 | soul 검토, 구조 승인, CEO 채점 | 수집/분석 명령 | 30분/일 |
| Phase 2 | 포스트 10개 승인, 파라미터 변경 승인 | 수집/분석/기획/작성 | 10분/일 |
| Phase 3 | 주간 리포트 리뷰, 월간 방향 | 일상 운영 전부 | 10분/주 |
