/**
 * @file Topic classifier — batch-classifies posts into TopicCategory.
 *
 * Strategy:
 *   1. Rule-based: map topic_tags to category via TAG_MAP (~50 frequent tags)
 *   2. No-match fallback: set to '기타'
 *   3. DB UPDATE: fill topic_category column
 */

import { eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { threadPosts } from '../db/schema.js';
import type { TopicCategory } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const _VALID_CATEGORIES: TopicCategory[] = [
  '건강', '뷰티', '다이어트', '운동', '생활', '주방',
  '디지털', '육아', '인테리어', '패션', '식품', '문구', '향수', '기타',
];

/**
 * Frequent topic_tags → TopicCategory mapping table (~50 tags).
 * Keys are lowercased for case-insensitive matching.
 */
export const TAG_MAP: Record<string, TopicCategory> = {
  // 건강
  '건강': '건강', '영양제': '건강', '유산균': '건강', '비타민': '건강',
  '혈압': '건강', '혈당': '건강', '관절': '건강', '수면': '건강',
  '면역력': '건강', '오메가3': '건강', '건강식품': '건강',

  // 뷰티
  '뷰티': '뷰티', '화장품': '뷰티', '스킨케어': '뷰티', '선크림': '뷰티',
  '클렌징': '뷰티', '세럼': '뷰티', '토너': '뷰티', '마스크팩': '뷰티',
  '메이크업': '뷰티', '파운데이션': '뷰티',
  // 스킨케어 확장
  '피부': '뷰티', '스킨': '뷰티', '에센스': '뷰티', '앰플': '뷰티',
  '크림': '뷰티', '로션': '뷰티', '수분크림': '뷰티', '보습': '뷰티',
  '각질': '뷰티', '모공': '뷰티', '블랙헤드': '뷰티', '트러블': '뷰티',
  '여드름': '뷰티', '피부결': '뷰티', '피부톤': '뷰티', '피부장벽': '뷰티',
  '기초케어': '뷰티', '세안': '뷰티', '폼클렌징': '뷰티', '오일클렌징': '뷰티',
  '필링': '뷰티', '팩': '뷰티', '시트팩': '뷰티', '미스트': '뷰티',
  // 메이크업 확장
  '화장': '뷰티', '파데': '뷰티', '쿠션': '뷰티', '컨실러': '뷰티',
  '프라이머': '뷰티', '베이스메이크업': '뷰티', '블러셔': '뷰티', '치크': '뷰티',
  '하이라이터': '뷰티', '쉐딩': '뷰티', '컨투어': '뷰티', '아이섀도': '뷰티',
  '아이라이너': '뷰티', '마스카라': '뷰티', '속눈썹': '뷰티', '립': '뷰티',
  '립스틱': '뷰티', '립틴트': '뷰티', '립밤': '뷰티', '립글로스': '뷰티',
  '브로우': '뷰티', '눈썹': '뷰티', '꾸안꾸': '뷰티',
  // 선케어
  '자외선차단': '뷰티', 'spf': '뷰티', 'uv': '뷰티', '선블록': '뷰티',
  '썬크림': '뷰티', '썬스틱': '뷰티',
  // 헤어
  '샴푸': '뷰티', '린스': '뷰티', '트리트먼트': '뷰티', '헤어팩': '뷰티',
  '두피': '뷰티', '탈모': '뷰티', '염색': '뷰티', '펌': '뷰티', '헤어오일': '뷰티',
  // 바디
  '바디로션': '뷰티', '바디워시': '뷰티', '핸드크림': '뷰티', '풋크림': '뷰티',
  '네일': '뷰티', '제모': '뷰티',
  // 일반 뷰티 표현
  '찐템': '뷰티', '재구매템': '뷰티', '공병': '뷰티', '데일리템': '뷰티',
  '겟레디': '뷰티', 'grwm': '뷰티', '동안': '뷰티', '주름': '뷰티',
  '탄력': '뷰티', '미백': '뷰티', '톤업': '뷰티',

  // 다이어트
  '다이어트': '다이어트', '다이어트식품': '다이어트', '체중감량': '다이어트',
  '식단관리': '다이어트', '단백질': '다이어트', '칼로리': '다이어트',

  // 운동
  '운동': '운동', '헬스': '운동', '홈트': '운동', '필라테스': '운동',
  '요가': '운동', '러닝': '운동', '운동기구': '운동',

  // 생활
  '생활': '생활', '생활용품': '생활', '세제': '생활', '청소': '생활',
  '수납': '생활', '정리정돈': '생활',

  // 주방
  '주방': '주방', '주방용품': '주방', '밀프렙': '주방', '에어프라이어': '주방',
  '냄비': '주방', '프라이팬': '주방', '식기': '주방',

  // 디지털
  '디지털': '디지털', '전자기기': '디지털', '이어폰': '디지털', '스마트폰': '디지털',
  '태블릿': '디지털', '노트북': '디지털', '충전기': '디지털',

  // 육아
  '육아': '육아', '아기': '육아', '유아': '육아', '아이간식': '육아',
  '젖병': '육아', '기저귀': '육아',

  // 인테리어
  '인테리어': '인테리어', '가구': '인테리어', '조명': '인테리어', '홈데코': '인테리어',

  // 패션
  '패션': '패션', '옷': '패션', '코디': '패션', '신발': '패션', '가방': '패션',

  // 식품
  '식품': '식품', '간식': '식품', '음료': '식품', '커피': '식품', '차': '식품',

  // 문구
  '문구': '문구', '다이어리': '문구', '펜': '문구', '노트': '문구',

  // 향수
  '향수': '향수', '퍼퓸': '향수', '디퓨저': '향수', '방향제': '향수',
};

// ---------------------------------------------------------------------------
// Text-based classification keywords (본문 매칭용)
// ---------------------------------------------------------------------------

/**
 * Category → keyword arrays for post body text matching.
 * Each category has weighted keywords: if 2+ keywords match, classify.
 * More specific keywords first to avoid false positives.
 */
const TEXT_KEYWORDS: Record<TopicCategory, string[]> = {
  '건강': [
    '오메가3', '오메가', '영양제', '비타민', '유산균', '프로바이오틱스',
    '철분제', '철분', '혈당', '혈압', '관절', '면역력', '면역',
    '건강기능식품', '건강식품', '약사', '보라지유', '루테인', '밀크씨슬',
    '홍삼', '프로폴리스', '마그네슘', '아연', '칼슘', '콜레스테롤',
    '혈관', '간건강', '장건강', '수면제', '수면', '피로',
    // 통증/질환
    '족저근막염', '오십견', '비염', '안구건조', '생리통', '생리통약',
    '피임약', '통증', '소염', '진통', '근막염', '콧물',
    '허리', '목디스크', '거북목', '어깨', '무릎', '찌릿',
    '마사지건', '마사지', '지압', '혈자리',
    // 보조제/보충제
    '엘더베리', '아르기닌', '보조제', '보충제', '섭취방법',
    // 약국/의약
    '약국', '처방', '복용', '의약품', '건강보조',
    '이비인후과', '치과', '병원', '의사', '감기',
    '입병', '구내염', '갱년기', '디톡스', '장디톡스',
    '편두통', '두통', '알부민', '성장호르몬', '벨타민', '식곤증', '춘곤증',
    '냉찜질', '온찜질', '공황', '불안장애',
    '베르베린', '글루타치온', '콘드로이친',
  ],
  '뷰티': [
    '스킨케어', '선크림', '화장품', '클렌징', '세럼', '토너',
    '마스크팩', '메이크업', '파운데이션', '피부관리', '피부고민',
    '여드름', '기미', '주름', '모공', '트러블', '미백',
    '올리브영', '쿠션', '립스틱', '아이크림', '에센스',
    '피부', '뷰티', '화장', '각질', '보습', '자외선',
    // 스킨케어 확장
    '앰플', '크림', '로션', '수분', '블랙헤드', '피부결', '피부톤', '피부장벽',
    '세안', '폼클렌징', '오일클렌징', '필링', '팩', '시트팩', '미스트',
    // 메이크업 확장
    '파데', '컨실러', '프라이머', '블러셔', '치크', '하이라이터', '쉐딩',
    '컨투어', '아이섀도', '아이라이너', '마스카라', '속눈썹',
    '립틴트', '립밤', '립글로스', '눈썹', '꾸안꾸',
    // 선케어
    'spf', 'uv', '선블록', '썬크림', '썬스틱',
    // 헤어
    '샴푸', '린스', '트리트먼트', '헤어팩', '두피', '탈모', '염색', '헤어오일',
    // 바디
    '바디로션', '바디워시', '핸드크림', '풋크림', '네일', '제모',
    // 일반 뷰티 표현
    '찐템', '재구매', '공병', '데일리템', '겟레디', 'grwm', '동안', '탄력', '톤업',
    // 콜라겐/흡수율
    '콜라겐', '흡수율', '고농축',
    // 립/색조 확장
    '립펜슬', '인생립', '겔마스크', '레이어드컷',
    // 보강: 구어체 뷰티 표현
    '코덕', '머릿결', '디올', '보들보들', '물미역',
    '피부과', '시술', '필러', '보톡스', '레이저',
    '웨이브', '고데기', '드라이기', '헤어스타일',
  ],
  '다이어트': [
    '다이어트', '체중감량', '뱃살', '체중', '식단관리', '식단',
    '단백질쉐이크', '저칼로리', '간헐적단식', '체지방',
    // 보강: 다이어트 + 운동 혼합
    '살빼', '감량', '지방감량', '식이조절', '칼로리',
    '살빠', '몸무게', '체중계',
  ],
  '운동': [
    '필라테스', '홈트레이닝', '홈트', '헬스장', '헬스', '요가',
    '러닝', '크로스핏', '운동루틴', '운동기구', '스트레칭',
    // 보강: 근육/운동 동작
    '풀업', '스쿼트', '데드리프트', '벤치프레스', '기립근', '내전근',
    '근육', '득근', '허벅지', '하체', '상체', '코어',
    '세트수', '백익스텐션', '슈퍼맨자세', '폼롤러',
    '보디빌딩', '천국의계단', '유산소', '무산소',
    '운동보조제', '프로틴', '단백질',
    '런지', '궁뎅이', '엉덩이', '힙업', '트레이너',
    '윗몸일으키기', '탄단지', '몸만들', '대회준비',
    '체력', '운동하', '벌크', '컷팅', '린매스',
  ],
  '식품': [
    '레시피', '요리', '도시락', '밀프렙', '홈메이드', '홈카페',
    '요거트', '에어프라이어', '탕수육', '반찬', '간식추천',
    '맛집', '먹방', '밀키트', '편의점신상', '로켓프레시',
    // 보강: 요리/음식
    '해먹', '끓여', '굴국밥', '알배추', '곤약', '에그타르트',
    '라면', '크래커', '과자', '모찌', '스콘', '아이스크림',
    '식재료', '장보러',
    // 보강: 디저트/음료/간식
    '쿠키', '말차', '카이막', '호떡', '사과칩', '빵', '디저트',
    '사탕', '초콜릿', '마카롱', '타르트', '블렌더',
    '오트밀', '탄수화물', '마라탕', '사골곰탕', '랍스터', '포키',
    '고기', '과일',
  ],
  '생활': [
    '생활용품', '세제', '청소', '수납', '정리정돈', '살림',
    '세탁', '빨래', '청소기', '제습기', '가습기',
    // 보강: 일상 살림
    '락스', '쉰내', '냄새', '정리법', '종량제', '분리수거',
    '살림템', '호텔수건', '수건',
    '면봉', '정리', '살림남', '스푼',
    // 환경/계절
    '미세먼지', '황사', '공기청정기',
    '타월', '발매트', '매트',
    '기름처리', '생활꿀팁', '층간소음',
  ],
  '주방': [
    '주방용품', '냄비', '프라이팬', '식기', '밀폐용기',
    '그릇', '도마', '칼', '텀블러',
  ],
  '디지털': [
    '이어폰', '스마트폰', '태블릿', '노트북', '충전기',
    '블루투스', '스마트워치', '갤럭시', '아이폰', '아이패드',
    '전자기기', '가전', '로봇청소기',
    // 보강: 배터리/악세사리
    '보조배터리', '맥세이프', '핸디선풍기', '배터리',
    '맥북', '키보드', '모니터', '마우스',
    '발뮤다', '다이슨', '브라운', '필립스',
  ],
  '육아': [
    '아기', '유아', '아이간식', '젖병', '기저귀', '이유식',
    '돌잔치', '육아템', '아기띠', '카시트',
  ],
  '인테리어': [
    '인테리어', '가구', '조명', '홈데코', '집꾸미기',
    '벽지', '커튼', '러그', '소파',
    // 보강
    '오늘의집', '책상꾸미기', '자취템',
    '원룸', '자취방', '우리집', '방꾸미기',
  ],
  '패션': [
    '코디', '패션', 'ootd', '신발', '가방', '악세사리',
    '스타일링', '룩북', '데일리룩',
    '쟈켓', '자켓', '티셔츠', '옷', '원피스', '바지', '치마',
    '후드', '맨투맨', '니트', '패딩', '코트',
  ],
  '문구': [
    '다이어리', '플래너', '문구', '스티커', '필기구',
    '필기감', '볼펜', '마커',
  ],
  '향수': [
    '향수', '퍼퓸', '디퓨저', '방향제', '향기',
  ],
  '기타': [],
};

// ---------------------------------------------------------------------------
// Rule-based classification
// ---------------------------------------------------------------------------

/**
 * Attempt to classify a post by matching its topic_tags against TAG_MAP.
 * Returns the first matched category, or null if no match.
 */
export function classifyByRule(topicTags: string[] | null): TopicCategory | null {
  if (!topicTags || topicTags.length === 0) return null;

  for (const tag of topicTags) {
    const normalized = tag.toLowerCase().trim();
    if (TAG_MAP[normalized]) {
      return TAG_MAP[normalized];
    }
  }

  return null;
}

/**
 * Classify a post by scanning its body text for category keywords.
 * Requires 1+ keyword hit to classify (topic_tags are empty for all posts).
 * Returns the category with the most hits, or null if no match.
 */
export function classifyByText(text: string | null): TopicCategory | null {
  if (!text || text.length < 5) return null;

  const normalized = text.toLowerCase();
  let bestCategory: TopicCategory | null = null;
  let bestCount = 0;

  for (const [category, keywords] of Object.entries(TEXT_KEYWORDS)) {
    if (category === '기타' || keywords.length === 0) continue;
    let count = 0;
    for (const kw of keywords) {
      if (normalized.includes(kw.toLowerCase())) count++;
    }
    if (count >= 1 && count > bestCount) {
      bestCount = count;
      bestCategory = category as TopicCategory;
    }
  }

  return bestCategory;
}

/**
 * Classify a post by checking its link URL domain or commercial text patterns.
 * Shopping/affiliate links and boilerplate indicate a product recommendation post.
 * Returns '생활' as a generic product category, or null if no match.
 */
export function classifyByLink(linkUrl: string | null | undefined, text?: string | null): TopicCategory | null {
  if (linkUrl && /coupang|coupa\.ng|link\.coupang|shopping\.naver|link\.inpock/.test(linkUrl)) {
    return '생활';
  }
  if (linkUrl && /link\.ohou|ozip\.me/.test(linkUrl)) {
    return '인테리어';
  }
  // Catch affiliate boilerplate text without explicit link_url
  if (text) {
    const lower = text.toLowerCase();
    if (/쿠팡\s*파트너스|수수료를\s*제공|일정액의\s*수수료/.test(lower)) return '생활';
    if (/link\.coupang|coupang\.com|coupa\.ng/.test(lower)) return '생활';
    if (/mkt\.shopping\.naver|link\.inpock/.test(lower)) return '생활';
    if (/link\.ohou|ozip\.me/.test(lower)) return '인테리어';
    if (/제품보기.*상품번호|상품번호.*검색/.test(lower)) return '생활';
    if (/쿠팡\s*링크|최저가\s*링크/.test(lower)) return '생활';
    if (/구매\s*방법|제품\s*정보|제품보기|상세\s*정보/.test(lower)) return '생활';
    if (/인생템|관리\s*꿀템|꿀템\s*추천|필수템/.test(lower)) return '생활';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Primary tag classification (intent-based)
// ---------------------------------------------------------------------------

/**
 * Classify a post's primary intent tag based on text content and link URL.
 * Returns one of: affiliate, purchase_signal, review, complaint, interest, general.
 */
export function classifyPrimaryTag(text: string, linkUrl?: string | null): string {
  const lower = text.toLowerCase();
  if (linkUrl && /coupang|coupa\.ng|link\.coupang/.test(linkUrl)) return 'affiliate';
  if (/추천해|살까|어디서.*사|비교|뭐가.*나을|골라|어떤게|뭐.*좋|써볼까/.test(lower)) return 'purchase_signal';
  if (/후기|리뷰|솔직|써봤|써보니|사용해보니|사용후기|체험/.test(lower)) return 'review';
  if (/실망|짜증|불편|별로|최악|환불|고장|하자/.test(lower)) return 'complaint';
  if (/궁금|알려줘|어때|좋을까|괜찮|효과.*있|성분/.test(lower)) return 'interest';
  return 'general';
}

// ---------------------------------------------------------------------------
// Main: classifyTopics
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  classified: number;
  ruleMatched: number;
  llmClassified: number;
}

/**
 * Batch-classify posts that have topic_category = null OR '기타'.
 *
 * 1. Fetch unclassified posts (up to `limit`)
 * 2. Try rule-based mapping via TAG_MAP (topic_tags)
 * 3. Try text-based mapping via TEXT_KEYWORDS (post body)
 * 4. Fall back to '기타' for remaining
 * 5. UPDATE topic_category in DB
 */
export async function classifyTopics(limit: number = 100, includeEtc: boolean = false): Promise<ClassifyResult> {
  // Fetch posts: either NULL only, or also '기타' for reclassification
  const condition = includeEtc
    ? sql`topic_category IS NULL OR topic_category = '기타'`
    : isNull(threadPosts.topic_category);

  const rows = await db
    .select({
      post_id: threadPosts.post_id,
      text: threadPosts.text,
      topic_tags: threadPosts.topic_tags,
      link_url: threadPosts.link_url,
    })
    .from(threadPosts)
    .where(condition)
    .limit(limit);

  if (rows.length === 0) {
    console.log('[topic-classifier] No unclassified posts found');
    return { classified: 0, ruleMatched: 0, llmClassified: 0 };
  }

  console.log(`[topic-classifier] Found ${rows.length} unclassified posts`);

  let ruleMatched = 0;
  let textMatched = 0;
  let fallbackCount = 0;

  for (const row of rows) {
    // 1. Try tag-based
    let category = classifyByRule(row.topic_tags);
    if (category) {
      ruleMatched++;
    } else {
      // 2. Try text-based
      category = classifyByText(row.text);
      if (category) {
        textMatched++;
      } else {
        // 3. Try link-based
        category = classifyByLink(row.link_url, row.text);
        if (category) {
          textMatched++;
        } else {
          category = '기타';
          fallbackCount++;
        }
      }
    }

    const tag = classifyPrimaryTag(row.text, row.link_url);

    await db
      .update(threadPosts)
      .set({
        topic_category: category,
        primary_tag: tag as typeof threadPosts.primary_tag.enumValues[number],
        analyzed_at: new Date(),
      })
      .where(eq(threadPosts.post_id, row.post_id));
  }

  const classified = ruleMatched + textMatched + fallbackCount;
  console.log(`[topic-classifier] Done: ${classified} classified (tag: ${ruleMatched}, text: ${textMatched}, fallback '기타': ${fallbackCount})`);

  return { classified, ruleMatched, llmClassified: textMatched };
}
