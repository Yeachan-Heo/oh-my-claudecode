# Threads AI 마케팅팀 — 제휴마케팅 에이전트 시스템

## 목표

Threads에서 소비자 니즈를 탐지하고, 제휴상품을 매칭하고, 판매 포지셔닝을 설계하는 AI 에이전트 팀을 구축한다.
시훈은 트리거와 최종 판단만 담당하고, 조사·분석·추천·콘텐츠 초안은 모두 에이전트가 실행한다.

## 핵심 원칙

1. **에이전트 퍼스트** — 모든 단계를 AI 에이전트가 실행. 사람은 트리거 + 최종 판단만.
2. **리서치·니즈탐지 최우선** — 나머지 에이전트는 이 출력에 의존. 여기가 틀리면 전부 틀림.
3. **문제 중심, 제품 나중** — 제품명이 아니라 "사람들이 해결하고 싶은 문제"를 먼저 파악.
4. **Threads 네이티브** — 대놓고 광고가 아니라, 경험·공감·솔직함 기반의 자연스러운 톤.
5. **피드백 루프** — 성과 데이터가 다음 사이클의 리서치에 반영. 에이전트가 스스로 똑똑해짐.
6. **점진적 자동화** — MVP는 대화형(A), 수집이 안정되면 cron 분리(→C 하이브리드).

## 제약사항

- Threads API 사용 불가 → Playwright 브라우저 자동화 (plan.md 인프라 재활용)
- Chrome CDP (Remote Debugging Port 9223) 연동
- gspread OAuth로 Google Sheets 기록
- WSL2 + Windows Chrome 환경
- 저속 순차수집 + 안티봇 회피 (plan.md S-1 전략 그대로 적용)
- 공개데이터만 수집, ToS 준수
- 콘텐츠 자동 포스팅 금지 — 에이전트는 초안만 생성, 시훈이 직접 게시
- **순차 실행 모델**: 1 트리거 → 1 Claude Code 세션. 동시 실행 없음. 크래시 → 재실행으로 복구.
- **모델 예산**: haiku(수집 ops), sonnet(분류×N), opus(리서치×1 + 니즈탐지×1 / cycle). 무제한 opus 호출 금지.

---

## 에이전트 아키텍처

```
[오케스트레이터] ─── 시훈이 "브리핑 줘" → 전체 파이프라인 조율
     │
     ├─ [1] 수집 에이전트 ────── Playwright로 Threads 크롤링
     │         ↓ raw_posts JSON
     ├─ [2] 리서처 에이전트 ──── 반복 키워드·질문·구매신호 추출 ★핵심
     │         ↓ 니즈 브리핑 JSON
     ├─ [3] 니즈탐지 에이전트 ── 문제 카테고리 분류 + 구매연결성 평가 ★핵심
     │         ↓ 문제-욕구 맵 JSON
     ├─ [4] 상품매칭 에이전트 ── 문제↔제휴상품 매핑 + Threads 적합도
     │         ↓ 상품 후보 리스트 JSON
     ├─ [5] 포지셔닝 에이전트 ── 상품별 판매 각도·말투·톤 설계
     │         ↓ 포지셔닝 카드 JSON
     ├─ [6] 콘텐츠 에이전트 ──── Threads 포스트 초안 생성
     │         ↓ 포스트 초안
     └─ [7] 성과분석 에이전트 ── 반응 데이터 분석 → 다음 사이클 피드백
              ↓ 학습 리포트 → [2]로 피드백
```

### 에이전트 실행 모델

- **MVP (Phase 0~3)**: Claude Code 서브에이전트. 시훈이 세션에서 명령하면 오케스트레이터가 순차 실행.
- **Phase 4**: 수집 에이전트만 cron 자동화(Python)로 분리. 나머지는 Claude Code 유지.
- **모델 라우팅**: 수집=haiku, 리서처/니즈탐지=opus, 상품매칭/포지셔닝=sonnet, 콘텐츠=sonnet, 성과분석=opus

---

## 에이전트 상세

### [0] 오케스트레이터

**역할**: 시훈의 명령을 받아 에이전트 파이프라인을 조율. 각 에이전트의 출력을 다음 에이전트의 입력으로 연결.

**트리거 명령어**:
- `브리핑 줘` → 전체 파이프라인 실행 (수집→리서치→니즈→상품→포지셔닝→콘텐츠)
- `리서치만` → [1]→[2]→[3]만 실행
- `이 문제로 상품 찾아줘 {문제}` → [4]부터 실행 (입력 직접 제공)
- `성과 분석해줘` → [7] 실행
- `수집만` → [1]만 실행

**실행 흐름**:
1. 기존 데이터 확인 (오늘 이미 수집했는지, 최신 브리핑이 있는지)
2. 필요한 에이전트만 순차 실행
3. 각 단계 출력을 파일로 저장 + 다음 에이전트에 전달
4. 최종 "오늘의 브리핑" 조립하여 시훈에게 보고

---

### [1] 수집 에이전트

**역할**: Playwright로 Threads 포스트를 크롤링하여 raw JSON으로 저장.

**plan.md 재활용**: S-0(로그인/세션관리), S-1(크롤러), S-2(채널발굴)의 인프라를 그대로 사용.

**수집 대상** (plan.md 확장):
- 기존: 제휴마케팅 광고 포스트
- 추가: **일반 소비자 포스트** — 질문, 고민, 후기, 비교 요청, 불만 등 구매 신호가 있는 포스트

**수집 포스트 분류 태그**:
| 태그 | 설명 | 예시 |
|------|------|------|
| `affiliate` | 제휴링크 포함 광고 포스트 | 쿠팡 링크, 할인코드 |
| `purchase_signal` | 구매 고민/질문/추천 요청 | "이거 살까 말까", "추천해줘" |
| `review` | 사용 후기/비교 | "써봤는데", "3개 비교" |
| `complaint` | 불만/문제 상황 | "이거 왜 이래", "별로였음" |
| `interest` | 관심/욕구 표현 | "이거 좋아보인다", "갖고 싶다" |
| `general` | 기타 | 분류 불가 |

**출력**: `data/raw_posts/{date}/{channel}/{post_id}.json`

```json
{
  "post_id": "...",
  "channel_id": "...",
  "author": "...",
  "text": "...",
  "timestamp": "...",
  "permalink": "...",
  "metrics": {
    "view_count": 0,
    "like_count": 0,
    "reply_count": 0,
    "repost_count": 0
  },
  "comments": [
    {
      "author": "...",
      "text": "...",
      "has_affiliate_link": false,
      "link_url": null
    }
  ],
  "tags": ["purchase_signal"],
  "crawl_meta": {
    "crawl_at": "...",
    "selector_tier": "data-testid",
    "login_status": true
  }
}
```

**안티봇 전략**: plan.md S-1 그대로 적용
- 포스트 간 2~8초 (정규분포 평균 4초)
- 채널 간 30~120초
- 매 15~25포스트마다 60~180초 휴식
- 차단신호 감지 → 3단계 대응 (대기→세션교체→채널스킵)

**checkpoint**: `data/threads-watch-checkpoint.json` — 중단/재개 지원
- per-channel frontier: `last_post_id` + `last_timestamp` 저장
- overlap-resume: 재개 시 마지막 20개 포스트 오버랩 → 중복제거
- 원자적 쓰기: tmp 파일 → rename (WSL2 안전)

---

### [2] 리서처 에이전트 ★핵심

**역할**: 수집된 raw 포스트에서 반복 등장하는 관심사, 질문, 불만, 구매 신호를 추출하고 정리.

**모델**: opus (깊은 맥락 이해 필요)

**입력**: `data/raw_posts/{date}/` 전체 + 이전 학습 리포트(`data/learnings/latest.json`)

**분석 기준**:
1. **반복 키워드** — 여러 포스트에서 독립적으로 등장하는 주제어
2. **질문형 패턴** — "뭐가 좋아?", "추천해줘", "이거 괜찮아?" 등
3. **구매 신호 강도** — 단순 관심 vs 실제 구매 고민 vs 즉시 구매 의사
4. **감정 강도** — 강한 불만, 강한 만족, 강한 궁금증
5. **트렌드 방향** — 새로 뜨는 주제 vs 꾸준한 주제 vs 사그라드는 주제

**구매 신호 분류 체계**:
| 레벨 | 설명 | 예시 표현 |
|------|------|-----------|
| L1 관심 | 단순 관심 표현 | "이거 좋아보인다", "신기하네" |
| L2 탐색 | 정보 수집 중 | "이거 써본 사람?", "어디서 사?" |
| L3 비교 | 구매 직전 비교 | "A vs B 뭐가 나아?", "가성비는?" |
| L4 구매의사 | 구매 결정 단계 | "이거 살까", "지르고 싶다" |
| L5 후기탐색 | 구매 전 최종확인 | "후기 있어?", "실사용 어때?" |

**출력**: `data/briefs/{date}_research.json`

```json
{
  "date": "2026-03-13",
  "posts_analyzed": 200,
  "top_keywords": [
    {"keyword": "집중력", "count": 15, "signal_level": "L3", "trend": "rising"}
  ],
  "purchase_signals": [
    {
      "text": "오후만 되면 집중이 안 되는데 뭐 좋은 거 없나",
      "post_id": "...",
      "signal_level": "L2",
      "category_hint": "집중력/생산성"
    }
  ],
  "question_posts": [...],
  "emotional_posts": [...],
  "emerging_topics": [...],
  "declining_topics": [...]
}
```

---

### [3] 니즈탐지 에이전트 ★핵심

**역할**: 리서처 출력을 "사람들이 해결하고 싶은 문제" 단위로 재분류하고, 각 문제의 구매 연결 가능성을 평가.

**모델**: opus (판단력 필요)

**입력**: `data/briefs/{date}_research.json` + 상품사전(`data/product_dict/`)

**문제 분류 프레임워크**:
| 욕구 유형 | 설명 | 예시 |
|-----------|------|------|
| 불편 해소 | 현재 겪는 고통 제거 | 집중 안 됨, 잠이 얕음 |
| 시간 절약 | 귀찮은 걸 빠르게 | 회의록 정리, 요리 시간 |
| 돈 절약 | 더 싸게, 가성비 | 구독 최적화, 대안 상품 |
| 성과 향상 | 더 잘하고 싶음 | 공부 효율, 운동 효과 |
| 외모/건강 | 더 나아보이고 싶음 | 피부, 다이어트, 수면 |
| 자기표현 | 취향/정체성 표현 | 미니멀, 감성, 테크 |

**출력**: `data/briefs/{date}_needs.json`

```json
{
  "date": "2026-03-13",
  "needs_map": [
    {
      "need_id": "focus_afternoon",
      "category": "불편 해소",
      "problem": "오후 집중력 저하",
      "representative_expressions": [
        "오후만 되면 머리가 안 돌아감",
        "점심 먹고 나면 졸림"
      ],
      "signal_strength": "L3",
      "post_count": 12,
      "purchase_linkage": "상",
      "why_linkage": "명확한 불편 + 즉시 해결 가능한 상품군 존재",
      "product_categories": ["영양제", "집중 앱", "카페인 대체"],
      "threads_fit": 5,
      "threads_fit_reason": "경험 공유하기 쉬운 주제, 후기형 콘텐츠 자연스러움"
    }
  ],
  "priority_ranking": ["focus_afternoon", "sleep_quality", "..."],
  "low_priority_reasons": {
    "luxury_watch": "설명 복잡 + 신뢰 필요 + Threads 부적합"
  }
}
```

---

### [4] 상품매칭 에이전트

**역할**: 니즈탐지 결과에 맞는 제휴 가능 상품을 발굴하고, Threads 적합도를 평가.

**모델**: sonnet

**입력**: `data/briefs/{date}_needs.json` + 상품사전 + 학습 리포트

**상품 평가 기준 (5점 척도)**:
1. **Threads 소개 자연스러움** — 짧은 텍스트로 설명 가능한가
2. **문제 해결 명확성** — "왜 필요한지" 한 줄로 말할 수 있는가
3. **광고 냄새** — 추천이 자연스러운가, 억지스러운가
4. **반복 노출 가능성** — 여러 각도로 계속 말할 수 있는가
5. **후기/스토리 가능성** — 경험형 콘텐츠로 풀 수 있는가

**상품 소스**:
- 쿠팡파트너스 (1순위 — 한국 Threads 시장)
- 네이버 스마트스토어 제휴
- SaaS/디지털 제품 (글로벌 affiliate)
- 기타 제휴 플랫폼

**출력**: `data/briefs/{date}_products.json`

```json
{
  "date": "2026-03-13",
  "matches": [
    {
      "need_id": "focus_afternoon",
      "products": [
        {
          "product_id": "focus_supplement_001",
          "name": "XX 집중 보조제",
          "affiliate_platform": "coupang_partners",
          "affiliate_link_template": "...",
          "price_range": "15000~25000",
          "threads_score": {
            "naturalness": 4,
            "clarity": 5,
            "ad_smell": 4,
            "repeatability": 3,
            "story_potential": 5,
            "total": 4.2
          },
          "competition": "중",
          "priority": 1,
          "why": "명확한 문제 해결 + 후기 콘텐츠 적합 + 가격대 낮아 전환 쉬움"
        }
      ]
    }
  ]
}
```

---

### [5] 포지셔닝 에이전트

**역할**: 선정된 상품을 Threads에서 어떤 관점·말투·톤으로 소개할지 설계.

**모델**: sonnet

**입력**: `data/briefs/{date}_products.json` + 학습 리포트

**포지셔닝 포맷 라이브러리**:
| 포맷 | 설명 | 예시 톤 |
|------|------|---------|
| 문제공감형 | 문제 먼저 → 해결책 | "이 문제 나만 겪는 줄 알았는데" |
| 솔직후기형 | 직접 써봤다는 톤 | "광고 아니고, 돈 주고 써본 기준" |
| 비교형 | 여러 개 써보고 골랐다 | "3개 써봤는데 1개만 남김" |
| 입문추천형 | 처음 쓰는 사람용 | "이쪽 처음이면 이거부터" |
| 실수방지형 | 잘못 살 뻔한 경험 | "이거 사기 전에 이것만 확인해" |
| 비추천형 | 솔직한 비추 → 대안 | "솔직히 이건 별로였고, 대신 이게 나았음" |

**Threads 톤 가이드라인**:
- 짧은 문장 (1~3줄)
- 날것 같은 느낌 (정제된 광고 카피 금지)
- 1인칭 경험 ("내가 써봤는데")
- 공감 먼저, 추천 나중
- CTA는 부드럽게 ("궁금하면 프로필 링크")

**출력**: `data/briefs/{date}_positioning.json`

```json
{
  "date": "2026-03-13",
  "positioning_cards": [
    {
      "product_id": "focus_supplement_001",
      "positions": [
        {
          "format": "문제공감형",
          "angle": "오후 3시의 멘붕",
          "tone": "공감+솔직",
          "hook": "오후 3시만 되면 머리가 안 돌아가는 사람 나만 아니지?",
          "avoid": ["최고의 제품", "꼭 사세요", "놓치면 후회"],
          "cta_style": "프로필 링크 유도"
        },
        {
          "format": "비교형",
          "angle": "집중 보조 3종 비교",
          "tone": "분석적+솔직",
          "hook": "집중 보조제 3개 다 써봤는데 1개만 남김",
          "avoid": ["협찬", "광고"],
          "cta_style": "댓글에서 자연스럽게"
        }
      ]
    }
  ]
}
```

---

### [6] 콘텐츠 에이전트

**역할**: 포지셔닝 카드를 바탕으로 실제 Threads 포스트 초안을 생성.

**모델**: sonnet

**입력**: `data/briefs/{date}_positioning.json`

**생성 규칙**:
- 본문은 500자 이내 (Threads 특성)
- 첫 문장은 스크롤 멈추게 만드는 훅
- AI 말투 금지 (자연스러운 구어체)
- 과장 표현 금지
- CTA는 1회 이하, 부드럽게
- 해시태그는 0~3개 (과도한 해시태그 = 광고 냄새)

**출력 구성**:
| 항목 | 개수 | 용도 |
|------|------|------|
| 본문 초안 | 상품당 3개 | 시훈이 골라서 게시 |
| 대안 훅 | 상품당 5개 | 첫 문장 교체용 |
| 후속 댓글 | 상품당 2개 | 본문에 달 자기 댓글 |
| 프로필 유도 | 상품당 1개 | "자세한 건 프로필에" |

**출력**: `data/briefs/{date}_content.json`

```json
{
  "date": "2026-03-13",
  "drafts": [
    {
      "product_id": "focus_supplement_001",
      "position_format": "문제공감형",
      "posts": [
        {
          "draft_id": "draft_001",
          "body": "오후 3시만 되면 머리가 안 돌아가는 사람 나만 아니지?\n\n회의 끝나면 뇌가 셧다운 되는 느낌이라\n이것저것 찾아보다가 하나 걸렸는데\n솔직히 플라시보인 줄 알았는데 2주째 괜찮음.\n\n궁금한 사람은 프로필에 남겨놨음.",
          "hook_alternatives": [
            "점심 먹고 나면 뇌가 꺼지는 사람 손",
            "오후에 집중 안 되는 거 체질인 줄 알았는데",
            "커피 3잔째인데도 안 깨는 오후",
            "회의 중에 졸린 거 나만 그런 거 아니지?",
            "오후 슬럼프 해결법 찾다가 의외의 거 발견"
          ],
          "follow_up_comment": "혹시 비슷한 사람 있으면 뭐 쓰는지 궁금. 나는 영양제 쪽으로 갔는데 다른 방법도 있을 듯.",
          "profile_cta": "링크 프로필에 있음. 근데 사기 전에 댓글 먼저 봐도 좋음.",
          "hashtags": ["#오후슬럼프", "#집중력"]
        }
      ]
    }
  ]
}
```

**중요**: 에이전트는 초안만 생성. 시훈이 검토·수정·게시를 직접 한다.

---

### [7] 성과분석 에이전트

**역할**: 게시된 포스트의 반응 데이터를 분석하여 "뭐가 먹혔는지" 학습하고, 다음 사이클의 리서처에 피드백.

**모델**: opus (패턴 인식 + 깊은 분석)

**입력**:
- 게시된 포스트의 반응 데이터 (시훈이 수동 입력 또는 크롤링)
- 이전 학습 리포트 (`data/learnings/`)
- 이전 브리핑들 (`data/briefs/`)

**분석 지표**:
| 지표 | 의미 | 수집 방법 |
|------|------|-----------|
| 좋아요 | 공감도 | Playwright 크롤링 |
| 답글 수 | 대화 유발력 | Playwright 크롤링 |
| 답글 톤 | 긍정/부정/질문 | LLM 분석 |
| 리포스트 | 확산력 | Playwright 크롤링 |
| 조회수 | 도달력 | Playwright 크롤링 (포스트 클릭) |
| 프로필 클릭 | 전환 시작 | Threads 인사이트 (시훈 수동) |
| 링크 클릭 | 전환 | 제휴 플랫폼 대시보드 (시훈 수동) |

**학습 항목**:
1. **잘 먹히는 조합**: 어떤 문제 + 어떤 포맷 + 어떤 톤이 반응 좋았는지
2. **안 먹히는 조합**: 반응이 나빴던 패턴과 이유 추정
3. **시간대 효과**: 게시 시간대별 반응 차이
4. **카테고리 전환율**: 어떤 문제 카테고리가 실제 구매로 이어지는지
5. **훅 효과**: 어떤 첫 문장이 스크롤을 멈추게 했는지

**출력**: `data/learnings/{date}_report.json` + `data/learnings/latest.json` (누적)

```json
{
  "date": "2026-03-13",
  "period": "2026-03-06 ~ 2026-03-13",
  "posts_analyzed": 15,
  "top_performers": [
    {
      "draft_id": "draft_001",
      "product_id": "focus_supplement_001",
      "format": "문제공감형",
      "likes": 45,
      "replies": 12,
      "views": 1200,
      "why_worked": "오후 슬럼프라는 보편적 문제에 공감 + 솔직한 톤"
    }
  ],
  "patterns_learned": {
    "winning_formats": ["문제공감형 > 비교형 > 솔직후기형"],
    "winning_categories": ["집중력 > 수면 > 생산성"],
    "winning_hooks": ["질문형 훅이 단정형보다 답글 2.3배"],
    "losing_patterns": ["직접적 CTA가 있는 포스트는 반응 40% 낮음"]
  },
  "next_cycle_recommendations": {
    "priority_needs": ["수면 질 개선 — 아직 테스트 안 함, 잠재력 높음"],
    "try_formats": ["비추천형 — 신뢰도 높일 수 있음"],
    "avoid": ["건강기능식품 과장 표현 — 부정 반응 있었음"],
    "experiment": ["주말 저녁 게시 테스트 — 평일 대비 도달력 비교"]
  }
}
```

**피드백 루프**: `latest.json`이 다음 사이클에서 [2] 리서처와 [4] 상품매칭 에이전트의 입력으로 들어감.

---

## 데이터 흐름

```
Threads 포스트 (Playwright)
  → data/raw_posts/{date}/ (JSON)
    → [2] 리서처: 키워드·신호 추출
      → data/briefs/{date}_research.json
        → [3] 니즈탐지: 문제 카테고리 분류
          → data/briefs/{date}_needs.json
            → [4] 상품매칭: 제휴상품 발굴
              → data/briefs/{date}_products.json
                → [5] 포지셔닝: 판매 각도 설계
                  → data/briefs/{date}_positioning.json
                    → [6] 콘텐츠: 포스트 초안 생성
                      → data/briefs/{date}_content.json

시훈이 포스트 게시 (수동)
  → 반응 데이터 축적
    → [7] 성과분석: 패턴 학습
      → data/learnings/{date}_report.json
        → data/learnings/latest.json (누적)
          → 다음 사이클 [2][4]에 피드백
```

## 저장소 구조

```
data/
  raw_posts/           # [1] 수집 원본
    {date}/
      {channel}/
        {post_id}.json
  briefs/              # [2]~[6] 일별 브리핑 체인
    {date}_research.json
    {date}_needs.json
    {date}_products.json
    {date}_positioning.json
    {date}_content.json
    {date}_brief.md        # 오케스트레이터가 조립한 최종 브리핑 (사람 읽기용)
  product_dict/        # 제품사전 (누적, 버전관리)
    products_v{N}.json
  learnings/           # [7] 성과 학습 (누적)
    {date}_report.json
    latest.json            # 전체 누적 학습 요약
  performance/         # 게시된 포스트 반응 데이터
    {post_date}_{draft_id}.json
  taxonomy.json        # P0-2: 태그 분류 단일 진실 소스 (버전 고정)
  seen_posts.json      # P0-3: 영속 dedup 원장 (channel_id+post_id)
  telemetry/           # P0-5a: 런 텔레메트리 로그
    {date}_run.json
  quarantine/          # P0-5: 필드 검증 실패 레코드 격리
    {date}_{post_id}.json
  eval/                # P1-3: 30개 평가 세트
    eval_set_v{N}.json     # taxonomy+schema 버전 메타데이터 포함
    gold_labels_v{N}.json  # 수동 라벨링 정답
  sheets/              # Google Sheets 템플릿
    reference_template.csv
  threads-watch-checkpoint.json  # 수집 checkpoint (상태머신+frontier)
```

---

## Phase별 구현 계획

### Phase 0: 크롤링 인프라 + 에이전트 자율실행 기반 구축

**목표**: plan.md의 수집 인프라를 AI 에이전트가 자율적으로 실행할 수 있는 구조로 래핑하고, 마케팅 리서치 용도로 검증.

> **Codex-Plan 토론 결과 반영** (7라운드, Opus vs Codex gpt-5.4)
> - 이슈 ~30개 발견, 20+개 해결, 미합의 2개(엔터프라이즈 수준 — 프로젝트 범위 밖)
> - 핵심 개선: 에이전트 상태머신, MCP↔CLI 브릿지, 헬스 게이트, 영속 dedup, 셀렉터 매니페스트, eval 세트, 모델 예산 캡, 채널 프론티어, 런 텔레메트리

#### P0-1. 에이전트 상태머신

에이전트의 자율 실행 흐름을 상태머신으로 정의. 모든 상태 전이는 checkpoint.json에 기록.

```
[시작] → 헬스체크 → 채널발굴 → 수집 → 분류 → 다음채널?
                                    ↓ (차단/예산초과/에러)
                                  핸드오프 → [종료]
                                    ↓ (완료)
                                  완료 → [종료]
```

- **checkpoint.json**: 원자적 쓰기 (tmp 파일 → rename)
- **per-channel frontier**: `last_post_id` + `last_timestamp` 저장 → 재개 시 이어서 수집
- **overlap-resume**: 재개 시 마지막 20개 포스트 오버랩 → 중복제거
- **순차 세션**: 동시 실행 없음. 크래시 → checkpoint에서 재실행. lease/lock 불필요.
- **멱등성**: 각 단계는 같은 입력에 같은 결과. 재실행 안전.

#### P0-1a. MCP↔CLI 브릿지

| 단계 | 도구 | 이유 |
|------|------|------|
| 로그인, 채널 탐색 | MCP `threads-playwright` | 대화형 판단 필요 (팝업, 채널 선정) |
| 포스트 대량 수집 | CLI `node scripts/collect-posts.js` | 컨텍스트 절약, 안티봇, 자동 체크포인트 |
| 태그 분류 | Claude (sonnet) | 문맥 이해 기반 분류 |

- 전환 시점: checkpoint의 `state` 필드로 관리 (`login` → `discover` → `collect` → `classify`)
- MCP 실패 시: 에이전트가 CLI fallback 또는 사용자 보고 후 대기

#### P0-1b. 헬스 게이트

**시작 시 (필수)**:
1. CDP 연결 확인: `curl -s http://127.0.0.1:9223/json/version`
2. MCP 연결 확인: `browser_navigate` 테스트
3. gspread 인증 확인: `.venv/bin/python -c "import gspread; gc = gspread.oauth(); gc.open_by_key('...')"`
4. 하나라도 실패 → 진단 메시지 출력 + **중단**

**중간 (매 10포스트)**:
1. 로그인 상태 재확인 (프로필 아이콘 존재 여부)
2. CDP 연결 상태 확인
3. 실패 → 재연결 시도 (최대 2회) → 실패 시 checkpoint 저장 + 핸드오프

#### P0-2. 태그 Taxonomy

`data/taxonomy.json` — 태그 분류의 단일 진실 소스 (single source of truth).

```json
{
  "version": "1.0",
  "tags": {
    "affiliate": {"desc": "제휴링크 포함", "precedence": 1, "examples": ["쿠팡 링크", "할인코드"]},
    "purchase_signal": {"desc": "구매 고민/질문/추천 요청", "precedence": 2, "examples": ["이거 살까", "추천해줘"]},
    "review": {"desc": "사용 후기/비교", "precedence": 3, "examples": ["써봤는데", "3개 비교"]},
    "complaint": {"desc": "불만/문제 상황", "precedence": 4, "examples": ["이거 왜 이래", "별로였음"]},
    "interest": {"desc": "관심/욕구 표현", "precedence": 5, "examples": ["좋아보인다", "갖고 싶다"]},
    "general": {"desc": "기타/분류 불가", "precedence": 6, "examples": []}
  },
  "rules": {
    "primary": "가장 높은 precedence(낮은 숫자) 태그가 primary",
    "secondary": "해당되는 나머지 태그 모두 secondary 배열에",
    "classifier": "sonnet — 포스트 텍스트 읽고 문맥 기반 분류"
  }
}
```

- **버전 고정**: eval 세트 생성 전 taxonomy 버전 동결 필수
- **precedence**: affiliate > purchase_signal > review > complaint > interest > general

#### P0-3. 듀얼 트랙 채널 발굴

| 트랙 | 대상 | 선정 기준 | 검색 키워드 |
|------|------|-----------|-------------|
| **마케터 트랙** | 제휴마케팅 채널 | 팔로워≥200, 광고≥3건/30일 | "쿠팡파트너스", "핫딜", "추천템" |
| **소비자 트랙** | 일반 사용자 채널 | 구매신호 포스트 ≥2건 | "추천해줘", "뭐가 좋아", "써본 사람" |

- **영속 dedup 원장**: `data/seen_posts.json` — checkpoint와 별도 파일
  - 키: `channel_id + post_id` 복합키
  - 크로스 런 중복 방지
  - MVP는 JSON, 확장 시 NDJSON+compaction

#### P0-4. 컨텍스트 예산 자가 모니터

에이전트가 자기 자원 소모를 추적하고 임계치 초과 시 자동 핸드오프.

| 지표 | 임계치 | 초과 시 |
|------|--------|---------|
| `browser_ops` (navigate+snapshot 합산) | ≤ 150 | checkpoint + handoff |
| `channels_completed` | ≤ 3 / 세션 | checkpoint + handoff |
| 컨텍스트 사용량 | ≤ 70% | checkpoint + handoff |

- `browser_ops` 카운터를 checkpoint.json에 저장
- 매 포스트 수집 후 카운터 체크
- **예산 소진 시**: 부분 출력 저장 + terminal checkpoint (`status: "budget_exhausted"`) + handoff.md 작성
- 다음 세션에서 checkpoint 읽고 남은 작업부터 재개

#### P0-5. 캐노니컬 JSON 스키마 + 필드 유효성 검증

threads-watch CLI 출력 → 리서처 입력을 연결하는 표준 스키마.

**필드 유효성 검증 (수집 시 필수)**:
| 필드 | 검증 규칙 | 실패 시 |
|------|-----------|---------|
| `post_id` | 비공, 정규식 `^[A-Za-z0-9_-]+$` | 레코드 reject |
| `timestamp` | ISO 8601 파싱 가능 | 레코드 reject |
| `text` (content) | 비공, 길이 > 0 | 레코드 reject |
| `view_count` | 정수 ≥ 0 또는 null (정당하게 숨겨진 경우만) | 경고 로그 |
| `channel_id` | 비공 | 레코드 reject |

- reject된 레코드는 `data/quarantine/` 폴더에 별도 저장 + 로그
- **validity rate**: 유효 레코드 / 전체 레코드 ≥ 90% 필수. 미달 시 수집 중단 + 셀렉터 점검

#### P0-5a. 셀렉터 매니페스트 + 런 텔레메트리

**셀렉터 3-tier 전략** (threads-watch 재활용):
1. `data-testid` (최우선)
2. `aria-label`
3. CSS `:nth-child` (최후수단)

- tier별 성공률을 런 텔레메트리에 기록
- fallback_rate > 20% → 경고 + DOM 변경 점검

**런 텔레메트리**: `data/telemetry/{date}_run.json`
```json
{
  "run_id": "...",
  "date": "2026-03-13",
  "stages": {
    "health_check": {"status": "pass", "duration_ms": 1200},
    "discovery": {"channels_found": 5, "duration_ms": 45000},
    "collection": {"posts_collected": 95, "posts_rejected": 3, "duration_ms": 1800000},
    "classification": {"posts_classified": 95, "duration_ms": 30000}
  },
  "budget": {"browser_ops": 142, "channels_completed": 3, "model_calls": {"haiku": 0, "sonnet": 95, "opus": 0}},
  "errors": [{"type": "login_expiry", "recovered": true, "at_post": 45}],
  "selector_stats": {"tier1_rate": 0.85, "tier2_rate": 0.12, "tier3_rate": 0.03},
  "validity_rate": 0.97
}
```

#### P0-6. 채널 소진 처리

채널이 목표 포스트 수(20개)를 채울 수 없는 경우:

| 상황 | 판정 기준 | 동작 |
|------|-----------|------|
| 포스트 부족 | 스크롤 3회 연속 새 포스트 0 | `exhausted` 태그, 수집된 만큼만 저장 |
| 핀/추천 반복 | 연속 5개 중복 윈도우 | `exhausted` 태그 |
| 비공개 전환 | 피드 접근 불가 | `skipped` 태그 |

- `collected < target`은 소진 기준 충족 시 허용 (로그 남김)
- 목표는 "채널당 정확히 20개"가 아니라 "가능한 만큼 수집"

#### P0-7. 장애 주입 테스트

| 시나리오 | 시뮬레이션 방법 | 검증 포인트 |
|----------|----------------|-------------|
| HTTP 429 | 차단 신호 주입 | 2시간 대기 → 재시도 동작 |
| CAPTCHA | 로그인 페이지 강제 전환 | 사용자 보고 + 대기 프로토콜 |
| 빈 DOM | 빈 응답 주입 | 셀렉터 fallback + 경고 |
| 로그인 만료 | 세션 쿠키 무효화 | 재로그인 → 수집 재개 |
| 예산 소진 | ops 카운터 강제 설정 | partial output + terminal checkpoint |
| gspread 실패 | OAuth 토큰 무효화 | 멱등 재시도 (3회) + 에러 보고 |
| 셀렉터 드리프트 | DOM 구조 변경 | fallback tier 작동 + validity rate 체크 |

**작업**:
1. threads-watch 크롤링 코드/스킬 검증 (S-0 로그인, S-1 크롤러, S-2 채널발굴)
2. 에이전트 상태머신 + checkpoint 구현 (P0-1)
3. MCP↔CLI 브릿지 + 헬스 게이트 (P0-1a, P0-1b)
4. 태그 taxonomy 파일 생성 (P0-2)
5. 듀얼 트랙 채널 발굴 + dedup 원장 (P0-3)
6. 컨텍스트 예산 자가 모니터 (P0-4)
7. 캐노니컬 스키마 + 필드 검증 (P0-5)
8. 셀렉터 매니페스트 + 텔레메트리 (P0-5a)
9. 5채널 × 20포스트 자율 테스트 수집 (P0-6)
10. 장애 주입 테스트 7개 시나리오 (P0-7)

**완료 기준**:
- [x] 5채널 × 20포스트 자율 수집 성공 (13채널 227포스트 수집됨)
- [x] 태그 taxonomy 적용 (primary + secondary) — v1.0 동결 완료
- [x] dedup 원장 + per-channel frontier 동작
- [x] checkpoint/resume/handoff 전체 동작
- [x] 헬스 게이트: 시작 시(CDP+gspread, Chrome 자동실행) + 매 10포스트 재검증
- [ ] 장애 주입 7개 시나리오 모두 통과 (→ GAP #16, 후속)
- [x] 필드 유효성 검증: validity rate = 1.0 (≥ 0.9 충족)
- [x] 셀렉터 매니페스트: tier2(aria-label) 100% (fallback 0%)
- [x] 런 텔레메트리 로그 생성 (data/telemetry/)
- [x] 채널 소진 시 graceful 처리 (exhausted 태그)
- [x] 컨텍스트 예산 초과 시 auto-handoff 동작 (exit 4)

**의존성**: 없음 (첫 단계)

#### P0-infra. 패키지 관리 + 타입 안전성 (2026-03-13 추가)

- **package.json**: v1.1.0, `npm run validate/pipeline/research/needs` 스크립트 등록
- **TypeScript 전환 완료**: strict mode, `scripts/types.ts`에 interface/enum 기반 타입
- **tsconfig.json**: ES2022, Node16, allowJs=true, checkJs=false (collect-posts.js 제외)
- **실행**: tsx (TypeScript Execute) — `npx tsx scripts/*.ts`
- **collect-posts.js**: JS 유지 (1539줄, strict 검사 제외)
- **CI/CD**: `npm run validate` = `node -c collect-posts.js && tsc --noEmit`

---

### Phase 1: 리서치 + 니즈탐지 MVP ★최우선

**목표**: "오늘의 니즈 브리핑" 출력 가능. 수집 데이터에서 사람들의 문제·욕구를 추출하고 분류. **에이전트가 자율적으로 실행.**

#### P1-1. 리서처 에이전트 (opus × 1/cycle)

- **입력**: `data/raw_posts/{date}/` + `data/learnings/latest.json` (피드백)
- **출력**: `data/briefs/{date}_research.json`
- **모델**: opus (깊은 맥락 이해) — **cycle당 1회 호출 (예산 제한)**
- **citation 요구사항**: 브리핑의 모든 주장(claim)에 원본 포스트 참조 ≥ 80%
- **evidence 요구사항**: 각 주장당 근거 포스트 ≥ 2개

#### P1-2. 니즈탐지 에이전트 (opus × 1/cycle)

- **입력**: `data/briefs/{date}_research.json` + `data/product_dict/`
- **출력**: `data/briefs/{date}_needs.json`
- **모델**: opus — **cycle당 1회 호출 (예산 제한)**
- **gspread 기록**: post_id 기반 멱등 upsert (중복 쓰기 방지)

#### P1-3. 30개 평가 세트 (Eval Set)

리서처/니즈탐지의 분류 품질을 검증하기 위한 벤치마크.

**구성**:
- P0 수집물에서 30개 포스트 선별 (채널/태그 분포 고려)
- 각 포스트에 **수동 라벨링**: 구매신호 레벨(L1-L5) + 니즈 카테고리
- primary label (1개) + secondary tags (0~N개)

**eval 스펙**:
- 단일 라벨 scoring: primary label 기준
- precision = 정확히 맞춘 / 예측한
- recall = 정확히 맞춘 / 실제 정답
- 애매한 케이스 → 보수적 라벨 (낮은 신호 레벨)

**목표**: purchase signal precision ≥ 0.8, needs category accuracy ≥ 0.7

**달성 결과** (2026-03-13):
| Metric | Result | Target | Status |
|--------|--------|--------|--------|
| Tag accuracy | 86.7% (26/30) | ≥70% | PASS |
| Signal precision | 100.0% (0 FP) | ≥80% | PASS |
| Needs accuracy | 90.0% (9/10) | ≥70% | PASS |

#### P1-3a. Eval 세트 동결 정책

**eval_set_v1.json은 동결 상태 — `build-eval-set.ts` 재실행 금지.**

**동결 이유**:
- `build-eval-set.ts`의 포스트 선택이 분류기 출력(`tags.primary`)에 의존
- 분류기 개선 → affiliate/non-affiliate 풀 변경 → 같은 seed라도 다른 30개 선택됨
- gold label(수동 라벨링)이 무효화됨 → 개발 중 3회 재작성 경험

**안전장치**:
- `build-eval-set.ts`에 재빌드 방지 로직: `labeling_status=complete`이면 `--force` 없이 거부
- `eval_set_v1.json`은 git에 커밋하여 진정한 불변성 보장

**분류기 개선 워크플로** (eval 재빌드 없이):
```
normalize-posts.ts 수정 → npm run normalize
    ↓
npx tsx scripts/update-eval-tags.ts   # auto_tags만 갱신 (포스트 불변)
    ↓
npx tsx scripts/apply-gold-labels.ts  # gold label 재적용
    ↓
npx tsx scripts/eval-accuracy.ts      # 정확도 측정
```

**v2 eval 세트 계획** (P2 이후):
- 현재 30개는 통계적 신뢰도가 낮음 (1개 오분류 = 3.3% 변동)
- gold purchase_signal이 1개뿐 → signal recall 측정 무의미
- 데이터 확보 후 100개로 확대 → `eval_set_v2.json`으로 별도 생성 + 새로 라벨링

#### P1-3b. 의존성 게이트

**taxonomy + schema 동결 → eval 세트 생성 순서 강제**

```
[P0-2] taxonomy 확정 (버전 고정)
    ↓
[P0-5] canonical schema 확정 (버전 고정)
    ↓
[P1-3] eval 세트 생성 (taxonomy+schema 버전과 함께 저장)
    ↓
[P1-3a] eval 세트 동결 (gold label 완료 후)
    ↓
[P1-1, P1-2] 에이전트 개선 → update-eval-tags.ts로 정확도 측정
```

- taxonomy 또는 schema가 변경되면 → eval 세트 v2 생성 필수 (v1은 동결 유지)
- eval 세트 파일에 taxonomy_version + schema_version 메타데이터 포함

**작업**:
1. [2] 리서처 에이전트 프롬프트 작성 + 테스트 (P1-1)
2. [3] 니즈탐지 에이전트 프롬프트 작성 + 테스트 (P1-2)
3. 30개 eval 세트 생성 + 라벨링 (P1-3)
4. 의존성 게이트 검증 (P1-3a)
5. 오케스트레이터의 `리서치만` 명령 구현
6. 출력 JSON → 사람 읽기용 브리핑 마크다운 변환

**MVP 출력 (니즈 브리핑)**:
```
[2026-03-13 니즈 브리핑]

■ 오늘 뜨는 문제 TOP 5
1. 오후 집중력 저하 (구매신호 12건, L3) ↑ rising  [출처: post_abc, post_def, ...]
2. 수면 질 (구매신호 8건, L2) → steady  [출처: post_ghi, ...]
3. ...

■ 주목할 구매 신호
- "오후만 되면 머리가 안 돌아가는데 뭐 좋은 거 없나" (L2) [post_abc]
- "수면 앱 3개 써봤는데 다 별로" (L3) [post_jkl]

■ 새로 뜨는 주제
- AI 업무 자동화 (이번 주 처음 등장, 급상승)

■ 사그라드는 주제
- 다이어트 챌린지 (지난주 대비 -40%)

■ 메타
- 분석 포스트: 100개, citation rate: 85%, 평균 evidence/claim: 2.4
```

**완료 기준**:
- [x] 100개 포스트 입력 → 니즈 브리핑 출력 성공 (227개 포스트 → 브리핑 생성)
- [x] 문제 카테고리 5개 이상 분류 (6개: 시간절약/외모건강/돈절약/불편해소/자기표현/성과향상)
- [x] 구매신호 레벨(L1~L5) 분류 동작 (11건 감지: L5:2, L4:1, L3:4, L1:4)
- [x] 트렌드 방향(rising/steady/declining) 판단 동작
- [ ] citation rate ≥ 80% (→ LLM 강화 시 측정)
- [ ] evidence ≥ 2/claim (→ LLM 강화 시 측정)
- [x] 30개 eval 세트 기준: tag accuracy 86.7%, signal precision 100%, needs accuracy 90.0% — **ALL TARGETS MET**
- [x] eval 세트 동결 + 재빌드 방지 안전장치 (`--force` 없이 거부)
- [x] 의존성 게이트: taxonomy v1.0 + schema v1.0 동결 후 eval 실행
- [ ] 모델 예산: opus × 1(리서처) + opus × 1(니즈탐지) per cycle (→ LLM 강화 시)
- [ ] 시훈이 브리핑 보고 "쓸만하다" 판단

**잔여 4개 misclassification** (규칙 기반 한계, LLM 강화 대상):
- E-007: complaint→purchase_signal (보험 탐색인데 불만 키워드 동시)
- E-011, E-026: complaint→general (타로 조언에 부정 키워드)
- E-022: purchase_signal→general (shop_ovor 사업 이야기)

**구현된 스크립트** (E단계, TypeScript 전환 완료 2026-03-13):
- `scripts/types.ts` — 공유 타입 정의 (interface/enum 기반)
- `scripts/normalize-posts.ts` — raw(hook_*) → canonical 변환 + multi-tag 분류 (E-2)
- `scripts/researcher.ts` — 키워드/구매신호/트렌드 추출 + LLM 프롬프트 (E-4)
- `scripts/needs-detector.ts` — 니즈 카테고리 분류 + 구매연결성 (E-5)
- `scripts/build-eval-set.ts` — 30개 eval 세트 선별 + 재빌드 방지 (E-3)
- `scripts/apply-gold-labels.ts` — gold label 적용 (30개 수동 라벨링) (E-7)
- `scripts/update-eval-tags.ts` — auto_tags 갱신 (eval 재빌드 없이) (E-8)
- `scripts/eval-accuracy.ts` — 정확도 측정 리포트 (tag/signal/needs) (E-9)
- `scripts/run-pipeline.ts` — 오케스트레이터: normalize→research→needs→brief (E-6)

**의존성**: Phase 0 완료

---

### Phase 2: 상품매칭 + 포지셔닝

**목표**: 니즈 브리핑에서 바로 "이 문제엔 이 상품을 이 각도로" 추천이 나옴.

**작업**:
1. [4] 상품매칭 에이전트 프롬프트 작성 + 테스트
2. [5] 포지셔닝 에이전트 프롬프트 작성 + 테스트
3. 초기 상품사전 구축 (쿠팡파트너스 인기 카테고리 50개)
4. 오케스트레이터의 `브리핑 줘` 명령 구현 (수집→리서치→니즈→상품→포지셔닝)

**완료 기준**:
- [ ] 니즈 5개 입력 → 상품 후보 각 3개 이상 출력
- [ ] Threads 적합도 점수(1~5) 산출
- [ ] 상품별 포지셔닝 3가지 이상 제안
- [ ] 상품사전 50개 이상 구축
- [ ] "문제→상품→각도" 파이프라인 end-to-end 동작

**의존성**: Phase 1 완료

---

### Phase 3: 콘텐츠 생성 + 성과분석

**목표**: 포스트 초안 자동 생성 + 게시 후 반응 분석 → 피드백 루프 완성.

**작업**:
1. [6] 콘텐츠 에이전트 프롬프트 작성 + 테스트
2. [7] 성과분석 에이전트 프롬프트 작성 + 테스트
3. 성과 데이터 입력 방식 구현 (크롤링 + 시훈 수동 입력)
4. 학습 리포트 → 다음 사이클 피드백 연결
5. 오케스트레이터 전체 파이프라인 완성 (`브리핑 줘` → 콘텐츠까지)

**완료 기준**:
- [ ] 상품 3개 → 포스트 초안 각 3개 (총 9개) 생성
- [ ] 초안이 Threads 톤 가이드라인 준수 (AI 말투 없음, 자연스러운 구어체)
- [ ] 게시 후 반응 데이터 수집 → 학습 리포트 생성
- [ ] 학습 리포트가 다음 사이클 리서처/상품매칭에 반영됨
- [ ] "오늘의 Threads 브리핑" 전체 출력 가능

**의존성**: Phase 2 완료

---

### Phase 4: 수집 자동화 분리 (A→C 진화)

**목표**: 수집 에이전트를 cron 자동화로 분리. 에이전트 팀은 이미 수집된 데이터로 분석부터 시작.

**작업**:
1. 수집 로직을 Python 스크립트로 추출
2. cron 스케줄 설정 (매일 새벽 자동 수집)
3. 수집 완료 알림 (시훈에게 "수집 완료, 브리핑 요청하세요")
4. 에러 핸들링 + 모니터링 (수집 실패 시 알림)

**완료 기준**:
- [ ] 매일 자동 수집 동작 (cron)
- [ ] 수집 실패 시 알림 동작
- [ ] 에이전트 팀이 수집 대기 없이 바로 분석 시작 가능
- [ ] 수동 수집 트리거도 여전히 동작 (백업)

**의존성**: Phase 3 완료 + 2주 이상 안정 운영 확인

---

## 오케스트레이터 출력: "오늘의 Threads 브리핑"

모든 에이전트가 동작한 후 최종 조립되는 브리핑 포맷:

```
[2026-03-13 Threads 마케팅 브리핑]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 오늘 뜨는 문제 TOP 5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 오후 집중력 저하 (구매신호 12건, L3) ↑
2. 수면 질 저하 (구매신호 8건, L2) →
3. 업무 자동화 (구매신호 6건, L2) ↑↑ NEW
4. 다이어트 정체기 (구매신호 5건, L1) ↓
5. 피부 관리 (구매신호 4건, L3) →

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 추천 상품 TOP 3
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. XX 집중 보조제 — 적합도 4.2/5, 문제공감형 추천
   → "오후 3시만 되면 머리가 안 돌아가는 사람용"
2. YY 수면 앱 — 적합도 3.8/5, 비교형 추천
   → "수면 앱 3개 써봤는데 이게 제일 나았음"
3. ZZ 노션 템플릿 — 적합도 4.0/5, 입문추천형
   → "업무 자동화 처음이면 이거부터"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 오늘 올릴 포스트 초안 (시훈 선택용)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[초안1] 오후 3시만 되면 머리가 안 돌아가는 사람 나만 아니지?
        회의 끝나면 뇌가 셧다운 되는 느낌이라...
[초안2] 수면 앱 3개 다 써봤는데 1개만 남김.
        솔직히 처음엔 다 비슷할 줄 알았는데...
[초안3] 노션으로 업무 자동화 시작하려는 사람한테.
        템플릿 하나만 깔면 세팅 끝...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 지난주 학습 (피드백 루프)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 문제공감형 > 비교형 (좋아요 2.3배)
- 질문형 훅이 단정형보다 답글 2배
- 건강 카테고리 전환율 가장 높음
- 직접적 CTA 포스트는 반응 40% 낮음
- 실험 제안: 주말 저녁 게시 테스트

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 다음 실험
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 수면 카테고리 비추천형 포맷 테스트
- 업무 자동화 (신규 주제) 탐색 확대
```

---

## plan.md → plan2.md 인프라 매핑

| plan.md 항목 | plan2.md 재활용 | 변경사항 |
|-------------|----------------|----------|
| S-0 로그인/세션 | [1] 수집 에이전트 | 그대로 사용 |
| S-1 크롤러 | [1] 수집 에이전트 | 태그 분류 추가 (광고 외 일반 포스트) |
| S-2 채널 발굴 | [1] 수집 에이전트 | 소비자 채널도 대상에 추가 |
| S-3 정규화 | [2] 리서처 | LLM 기반으로 대체 (정규식→LLM) |
| S-4 라벨셋 검증 | 삭제 | 학술적 검증 불필요, 성과 기반 피드백으로 대체 |
| S-5 테스트/컴플 | [1] 수집 에이전트 | 안티봇+ToS 부분만 유지 |
| S-6 아이템 DB | [4] 상품사전 | 구조 간소화 (상품사전 JSON) |
| S-7 트렌드 수집 | [2] 리서처 | Threads 자체 트렌드로 대체 (외부 API 불필요) |
| S-8 상관분석 | 삭제 | 통계 검증 대신 성과 기반 학습 |
| S-9 Sheets | 유지 | 대시보드/캘린더 기록용 |
| S-10 패턴도출 | [7] 성과분석 | LLM이 패턴 학습 (통계 대신) |

---

## 완료 기준 (전체)

**P0: 크롤링 인프라 + 에이전트 자율실행**
- [ ] 5채널 × 20포스트 자율 수집 (에이전트 단독 실행, 채널 소진 시 graceful 처리)
- [ ] 태그 taxonomy 적용 (primary + secondary) + 버전 고정
- [ ] dedup 원장 + per-channel frontier + overlap-resume 동작
- [ ] checkpoint/resume/handoff + 원자적 쓰기 전체 동작
- [ ] 헬스 게이트: 시작 시(CDP+MCP+gspread) + 매 10포스트 재검증
- [ ] 장애 주입 7개 시나리오 모두 통과
- [ ] 필드 유효성 검증: validity rate ≥ 90% + quarantine 동작
- [ ] 셀렉터 매니페스트: fallback_rate < 20% + 런 텔레메트리 로그
- [ ] 컨텍스트 예산 초과 시 auto-handoff + budget_exhausted terminal state

**P1: 리서치 + 니즈탐지**
- [x] 100개 포스트 → 니즈 브리핑 출력 (227개 → 6카테고리, L1-L5, 트렌드)
- [ ] citation rate ≥ 80% + evidence ≥ 2/claim (→ LLM 강화 시)
- [x] 30개 eval 세트: tag 86.7%, signal 100%, needs 90.0% — **ALL TARGETS MET**
- [x] eval 세트 동결 + 재빌드 방지 + git 커밋 (v2는 100개로 확대 예정)
- [x] 의존성 게이트: taxonomy+schema 버전 고정 후 eval 실행
- [ ] 모델 예산: opus × 1(리서처) + opus × 1(니즈탐지) per cycle (→ LLM 강화 시)

**P2~P4: 상품매칭 → 콘텐츠 → 자동화**
- [ ] P2: 니즈→상품→포지셔닝 파이프라인 동작 (상품사전 50개+)
- [ ] P3: 포스트 초안 자동 생성 + 성과 학습 리포트 + 피드백 루프
- [ ] P4: 수집 cron 자동화 + 에이전트는 분석부터 시작

**전체 시스템**
- [ ] "브리핑 줘" 한마디로 수집→분석→추천→콘텐츠 전체 파이프라인 동작
- [ ] "리서치만" → 수집→리서처→니즈탐지 자율 실행
- [ ] 피드백 루프: 성과 데이터가 다음 사이클 리서치에 반영
- [ ] 순차 실행 모델: 1 트리거 → 1 세션, 크래시 → 재실행 복구
- [ ] 콘텐츠 자동 포스팅 없음 — 에이전트는 초안만, 시훈이 직접 게시
