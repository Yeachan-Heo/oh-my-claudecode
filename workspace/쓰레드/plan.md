# Threads 쿠팡파트너스 광고 아이템 분석 + 트렌드 연관성 검증 파이프라인

## 목표

Threads 채널에서 쿠팡파트너스/제휴마케팅 광고 아이템을 분석하고, 아이템 선정 패턴과 인사이트를 도출하며, 네이버/구글 트렌드 데이터와의 연관성을 검증하는 데이터 수집·분석 파이프라인 구축

## 제약사항

- Threads API 사용 불가 → Playwright 브라우저 자동화로 데이터 수집
- Chrome CDP (Remote Debugging Port 9223) 연동
- gspread + GCP 서비스계정으로 Google Sheets 기록
- 네이버 DataLab API (primary) → pytrends (fallback)
- WSL2 + Windows Chrome 환경
- 저속 순차수집 (포스트간 3-5초, 채널간 30-60초) + exponential backoff + 차단신호별 세션교체·중단조건
- 공개데이터만 수집, robots.txt 준수, ToS 5항목 체크리스트

## 정규키 계약

모든 단계에서 공통으로 사용하는 레코드 식별자:

| 레벨 | 키 구성 | 용도 |
|------|---------|------|
| raw_post | `channel_id + post_id` | 수집 단계 중복제거 |
| normalized_item | `channel_id + post_id + canonical_product_id` | 아이템 DB 정규화 |
| trend_row | `canonical_product_id + date + source` | 트렌드 시계열 |

## Phase 1: 데이터 수집 (크롤링)

**목표**: Playwright 브라우저 자동화로 Threads에서 제휴마케팅 포스트 데이터를 수집하고 정규화
**KPI**: 20채널 × 40포스트 (총 800개), precision ≥ 0.9 / recall ≥ 0.85 (Wilson CI 95% 하한), Cohen's κ ≥ 0.8
**종료 게이트**: 800포스트 + P/R CI 통과 + κ ≥ 0.8 달성 시 Phase 2 진입
**데이터 저장**: Google Sheets 레퍼런스 시트 (`reference_template.csv` 참조) — 채널/포스트/링크/제품/메타 5개 섹션

### S-0. 로그인 및 세션 관리

Threads는 **로그인 상태에서만** 조회수, 전체 댓글, 상세 프로필 등을 확인할 수 있으므로 항상 로그인된 상태로 수집한다.

- **MCP**: `threads-playwright` (CDP endpoint `http://127.0.0.1:9223`)
- **Chrome 실행**: `C:\Users\campu\OneDrive\Desktop\Chrome (Claude).lnk` → `--remote-debugging-port=9223 --user-data-dir=C:\Users\campu\ChromeDebug`
- **로그인 플로우** (threads-analyze 스킬 기반):
  1. `https://www.threads.net` 접속 → 스냅샷으로 로그인 상태 판별
  2. 이미 로그인 → 수집 시작
  3. "Continue as..." 버튼 → 클릭하여 재로그인
  4. 로그인 필요 → Instagram 로그인 폼 사용
     - 자격증명 파일: `/mnt/c/Users/campu/OneDrive/Desktop/새 텍스트 문서 (2).txt` (Line1: email, Line3: password)
  5. 로그인 후 "Save login info?" / "알림 설정" → "나중에" 클릭
- **로그인 엣지 케이스 → 사용자 보고 후 대기**:
  - CAPTCHA/보안인증 → "수동으로 보안 인증을 완료해주세요" 보고 → 30초 간격 재확인 (최대 3회)
  - 2FA 코드 요청 → "2FA 코드를 입력해주세요" 보고 → 60초 대기
  - 비밀번호 오류 → "비밀번호가 틀립니다. 자격 증명 파일을 확인해주세요" 보고 → **중단**
  - 알 수 없는 상태 → 스크린샷 저장 → 사용자에게 상황 보고 → **수동 처리 대기**
- **세션 유지 확인**: 포스트 수집 중 매 10개마다 로그인 상태 재확인 (프로필 아이콘 존재 여부)

### S-1. Playwright Threads 크롤러

- **수집 흐름**: 채널 프로필 → 피드 스크롤 → **포스트 클릭 (필수)** → 조회수 확인 + 댓글 확인 → 돌아가기 → 다음 포스트
- **포스트 클릭이 필수인 이유**:
  - 조회수는 포스트를 클릭해서 상세 페이지에 들어가야만 표시됨
  - 제휴링크(쿠팡파트너스 등)는 대부분 본문이 아닌 **댓글에 작성**되므로 댓글 확인 필수
- **댓글 제휴링크 탐지**: 포스트 클릭 후 댓글 영역에서 `coupang.com`, `coupa.ng`, `smartstore.naver`, `ali.ski` 등의 링크 패턴 검색
- **checkpoint/resume**: `{channel_id, last_post_id, timestamp, scroll_position}` 상태 스키마
- **overlap-resume**: 재개 시 마지막 20개 포스트 오버랩 재수집 → raw key 기준 중복제거
- **갭 탐지**: post_id 역전, timestamp 비연속, 신규 삽입률 로그 → 임계치 초과 시 채널 재동기화
- **raw 저장**: `raw_posts/{run_id}/{channel}/{post_id}.json`
  - 포스트: 텍스트, timestamp, author, permalink, view_count, like_count, reply_count, repost_count
  - 댓글: comment_text, comment_author, 제휴링크 유무, link_url
  - 메타: selector_tier, crawl_at, DOM hash, login_status

#### 안티봇 회피 전략

- **비정규 패턴 수집**: 사람처럼 보이기 위해 모든 대기 시간에 랜덤 편차 적용
  - 포스트 간 대기: **2~8초** (균일분포가 아닌 정규분포, 평균 4초 ± 2초)
  - 채널 간 대기: **30~120초** (랜덤)
  - 포스트 클릭 후 상세 페이지 체류: **3~10초** (사람이 읽는 시간 시뮬레이션)
  - 가끔 의도적으로 **긴 휴식** 삽입: 매 15~25개 포스트마다 60~180초 대기
- **스크롤 패턴**: 일정 속도가 아닌 불규칙 스크롤 (빠르게 → 느리게 → 멈추기 → 다시)
- **차단신호 감지**: {429, 503, CAPTCHA, 빈 DOM, 로그인 풀림}
- **차단 시 대응 (3단계)**:
  1. **1차 차단**: 즉시 중단 → **2시간 대기** → 재시도
  2. **2차 차단** (같은 세션): 세션 교체 (브라우저 재시작) → **2시간 대기** → 재시도
  3. **3차 차단** (같은 채널): 해당 채널 스킵 → 다음 채널로 이동 → 해당 채널은 다음 날 재시도
- **수집 시간대 분산**: 항상 같은 시간에 수집하지 않도록 시작 시간 랜덤화

### S-2. 타겟 채널 발굴

- 선정 기준: **팔로워 ≥ 200**, 최근 30일 광고 ≥ 3건, 공개 프로필
- 채널 메타데이터 수집 (팔로워 수, 바이오, 카테고리)
- **광고 포스트 판정 체크리스트** (1개 이상 충족 시 광고 후보):
  - `#광고` / `#협찬` 해시태그 (본문)
  - 구매링크 포함 — **본문 또는 댓글**에서 탐지 (`coupang.com`, `coupa.ng`, `smartstore.naver`, `ali.ski` 등)
  - 할인코드 / 공구 표현 (본문 또는 댓글)
  - 브랜드 공식계정 태그 + 프로모션 문구
  - 댓글에 "링크", "쿠팡에서 검색", "정보 여기" 등의 유도 문구
- 애매 사례 → 검수큐로 이동

### S-3. 포스트 데이터 정규화

- 제품사전 (JSON 버전관리) + 정규식으로 제품명/브랜드/가격 추출
- **키워드 매핑 사전**: `canonical_product_id → [DataLab 검색어, pytrends 검색어]` (별도 JSON 버전관리)
- 신규상품 검수큐: 사전에 없는 제품은 수동 검수 대기열로
- 초기 사전 구축: 쿠팡 카테고리 크롤 + 수동 50건

### S-4. 라벨셋 검증

- **평가 단위**: post-product pair (다중 제품 포함 포스트 허용)
- **라벨링 프로토콜**: 2인 독립 라벨링 → 불일치 조정 → Cohen's κ ≥ 0.8 달성 필수
- 층화 **150건** holdout + 주요 카테고리별 최소 20건
- 목표: precision ≥ 0.9, recall ≥ 0.85 (**Wilson CI 95% 하한** 기준)

### S-5. 테스트 + 컴플라이언스 + 관측성

- **셀렉터 3계층 전략**: `data-testid > aria-label > CSS(:nth-child)` 순 우선
- DOM 스냅샷 diff: 일일 비교, 변경 감지 시 스모크 테스트 자동 실행
- 장애주입: 차단신호 시뮬레이션 → 복구전략 검증
- **ToS 체크리스트**: robots.txt 확인, 공개데이터만, rate-limit 준수, 개인정보 비수집 (로그인은 사용자 본인 계정으로 수행)
- **운영 관측 임계치**:
  - `blocked_channel_rate > 30%` → 수집 중단
  - `selector_fallback_rate > 20%` → 경고 + DOM 변경 점검
  - batch 3회 연속 실패 → 수동 검토 큐
  - 로그인 풀림 감지 → 즉시 수집 일시정지 → 재로그인 시도

## Phase 2: 분석

**목표**: 수집된 아이템 DB 구축 + 트렌드 데이터와의 상관관계 통계 검증
**KPI**: Pearson r + Fisher-z CI + p값 산출, 유효 70/90일, insufficient_data 분리 보고
**종료 게이트**: 90일 데이터 확보 + 상관분석 r 산출 완료 시 Phase 3 진입

### S-6. 제휴 아이템 DB

- 정규키 (`channel_id + post_id + canonical_product_id`) 기준 축적
- **lineage 연결**: raw → normalize → item → trend를 `run_id`로 추적
- 리포스트/중복광고/동일상품 반복 제거 (제거율 ≥ 95%)

### S-7. 트렌드 데이터 수집

- **네이버 DataLab** (primary): 일별 검색량 추이 → min-max 정규화
- **Google Trends** (fallback): pytrends 일별 → min-max 정규화
- **키워드 매핑 사전 참조**: S-3에서 정의한 `canonical_product_id → [검색어]` 사용
- **source 정규화 규칙**: source 혼합 분석 금지, 겹침 14일 기준 z-score 정규화 후 연결
- **fallback 조건**: DataLab 실패 3회 → pytrends 전환, 재복귀 조건 문서화
- **시계열 진입 조건**: 유효일수 70/90일 이상, 비0 검색량 10일 이상, pairwise complete
- 일치도 검증: Spearman ρ ≥ 0.8 (교차검증 전용)
- 조건 미달 제품 → `insufficient_data`로 분리 보고

### S-8. 트렌드-포스트 상관분석

- **사전등록**: 주 lag = 1일 (확인적), 보조 lag {0, 3, 7} (탐색적)
- 전처리: 7일 MA detrend + 계절성 diff
- 최소 데이터: 90일 이상 수집 후 분석 실행
- 다중비교: Bonferroni-Holm + Bartlett 자기상관 보정
- 효과크기: Pearson r ≥ 0.3, 95% Fisher-z CI 방향 일치, α = 0.05
- 홀드아웃: 시간분할 70/30 + 채널격리
- **insufficient_data 분리**: 시계열 진입 조건 미달 제품은 분석 대상에서 제외, 별도 보고

## Phase 3: 대시보드 + 자동화

**목표**: Google Sheets 대시보드 자동 기록 + 아이템 선정 패턴 3가지 도출·자동화
**KPI**: Sheets 멱등 (batch_id + checksum 기반), 3패턴 홀드아웃 재현

### S-9. Google Sheets 대시보드

- gspread + GCP 서비스계정 (설정 절차 문서 포함)
- upsert key: `channel_id + post_id + date`
- **batch 스펙**: 500행/회, `batch_id + checksum` 검증, 불일치 시 해당 batch만 재전송
- **멱등성**: `run_id` 기반, staging 컬럼 (`updated_at`, `checksum`), 재실행 시 중복 0건
- 대상 시트: posts_management, weekly_tracker, hook_reference

### S-10. 아이템 선정 패턴 도출 + 자동화

**사전등록 3패턴** (훈련구간 도출 → 홀드아웃 재현):

| 패턴 | 정의 | 채택기준 |
|------|------|----------|
| ① 트렌드 선행 | 검색량 피크 → 포스트 (lag ≥ 1일) | 주 lag Pearson r ≥ 0.3, p < 0.05 |
| ② 셀럽/이슈 동시 | 이슈 발생 ±2일 내 포스트 | 해당 기간 포스트 비율 유의하게 높음 |
| ③ 카테고리 순환 | 동일 카테고리 반복 주기 | 주기성 자기상관 유의 |

- 자동화 워크플로우: 주기적 크롤링 + 트렌드 매칭 + 시트 업데이트
- retry budget + dead-letter queue

## 리스크 대응 (내재화 완료)

모든 리스크는 해당 Step에 구체적 대응 스펙이 내재화되어 있음.

| 심각도 | 리스크 | 대응 (내재화된 Step) |
|--------|--------|---------------------|
| MEDIUM | Threads 안티봇/rate-limit | 비정규패턴수집 + 차단 시 2시간 대기 + 세션교체 + 채널스킵 + blocked>30% 중단 → S-1, S-5 |
| LOW | DOM 구조 변경 | 3계층 셀렉터(data-testid>aria>CSS) + DOM 스냅샷 diff + fallback>20% 경고 → S-5 |
| LOW | 제품명 추출 정확도 | 제품사전 + 키워드매핑 + JSON 버전관리 + 검수큐 + 광고판정 4항목 체크리스트 → S-2, S-3 |
| LOW | 시계열 허위상관 | 90일 게이트 + 유효 70일 + detrend + Bonferroni-Holm + insufficient 분리 → S-7, S-8 |
| LOW | 이용약관 위반 | ToS 체크리스트 (robots.txt, 공개데이터, rate준수, 비개인정보) + 로그인은 사용자 본인 계정 → S-0, S-5 |

## 완료 기준

- [ ] 20채널 × 40포스트 수집 (총 800개, raw lineage 포함, 댓글 제휴링크 포함)
- [ ] 150건 holdout 기반 precision ≥ 0.9, recall ≥ 0.85 (Wilson CI 95% 하한), κ ≥ 0.8
- [ ] Pearson r + Fisher-z CI + p값 산출 + 유의성 플래깅 (insufficient_data 분리)
- [ ] 시간분할 70/30 + 채널격리 홀드아웃에서 사전등록 3패턴 재현
- [ ] DataLab-pytrends Spearman ≥ 0.8 (교차검증, 겹침 ≥ 14일)
- [ ] Sheets upsert 멱등 (batch_id + checksum 검증, 재실행 시 중복 0건)
- [ ] 리포스트/중복 제거율 ≥ 95%
- [ ] Phase Gate (ToS 5항목) + 장애주입 + checkpoint/overlap-resume 통과
- [ ] 운영 관측 임계치 정의 및 적용 (blocked>30%, fallback>20%, batch 3연속실패)
- [ ] Phase 진입 게이트: P1→P2 = 800포스트+P/R CI+κ≥0.8, P2→P3 = 90일+r산출완료
- [ ] 로그인 세션 관리: 로그인 엣지 케이스 발생 시 사용자 보고 + 대기 프로토콜 작동
- [ ] 레퍼런스 시트 템플릿 반영 (채널/포스트/링크/제품/메타 5개 섹션)

## 토론 메트릭

- **1차 토론**: 15/15 라운드 (Opus vs Codex gpt-5.4) → 평점 9/10
- **2차 토론 (리스크 해소)**: 5/10 라운드, 수렴 종료 (Opus vs Codex gpt-5.4)
  - 이슈: ~18개 발견, 18개 해결, 미해결 0개
  - 최종 평점: **8/10**
  - 핵심 개선: 리스크 5개 전체 해소 (severity 하향), Phase별 KPI·게이트 정의, 정규키 계약, 관측성 임계치, 광고 판정 기준, 라벨링 프로토콜(Wilson CI), 시계열 진입 조건, raw lineage, Sheets batch 검증
