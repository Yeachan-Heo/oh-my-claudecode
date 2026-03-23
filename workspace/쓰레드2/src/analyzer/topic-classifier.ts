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

const VALID_CATEGORIES: TopicCategory[] = [
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
  ],
  '뷰티': [
    '스킨케어', '선크림', '화장품', '클렌징', '세럼', '토너',
    '마스크팩', '메이크업', '파운데이션', '피부관리', '피부고민',
    '여드름', '기미', '주름', '모공', '트러블', '미백',
    '올리브영', '쿠션', '립스틱', '아이크림', '에센스',
    '피부', '뷰티', '화장', '각질', '보습', '자외선',
  ],
  '다이어트': [
    '다이어트', '체중감량', '뱃살', '체중', '식단관리', '식단',
    '단백질쉐이크', '저칼로리', '간헐적단식', '체지방',
  ],
  '운동': [
    '필라테스', '홈트레이닝', '홈트', '헬스장', '헬스', '요가',
    '러닝', '크로스핏', '운동루틴', '운동기구', '스트레칭',
  ],
  '식품': [
    '레시피', '요리', '도시락', '밀프렙', '홈메이드', '홈카페',
    '요거트', '에어프라이어', '탕수육', '반찬', '간식추천',
    '맛집', '먹방', '밀키트', '편의점신상', '로켓프레시',
  ],
  '생활': [
    '생활용품', '세제', '청소', '수납', '정리정돈', '살림',
    '세탁', '빨래', '청소기', '제습기', '가습기',
  ],
  '주방': [
    '주방용품', '냄비', '프라이팬', '식기', '밀폐용기',
    '그릇', '도마', '칼', '텀블러',
  ],
  '디지털': [
    '이어폰', '스마트폰', '태블릿', '노트북', '충전기',
    '블루투스', '스마트워치', '갤럭시', '아이폰', '아이패드',
    '전자기기', '가전', '로봇청소기',
  ],
  '육아': [
    '아기', '유아', '아이간식', '젖병', '기저귀', '이유식',
    '돌잔치', '육아템', '아기띠', '카시트',
  ],
  '인테리어': [
    '인테리어', '가구', '조명', '홈데코', '집꾸미기',
    '벽지', '커튼', '러그', '소파',
  ],
  '패션': [
    '코디', '패션', 'ootd', '신발', '가방', '악세사리',
    '스타일링', '룩북', '데일리룩',
  ],
  '문구': [
    '다이어리', '플래너', '문구', '스티커', '필기구',
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
 * Requires 2+ keyword hits to classify (reduces false positives).
 * Returns the category with the most hits, or null if no match.
 */
export function classifyByText(text: string | null): TopicCategory | null {
  if (!text || text.length < 10) return null;

  const normalized = text.toLowerCase();
  let bestCategory: TopicCategory | null = null;
  let bestCount = 0;

  for (const [category, keywords] of Object.entries(TEXT_KEYWORDS)) {
    if (category === '기타' || keywords.length === 0) continue;
    let count = 0;
    for (const kw of keywords) {
      if (normalized.includes(kw.toLowerCase())) count++;
    }
    if (count >= 2 && count > bestCount) {
      bestCount = count;
      bestCategory = category as TopicCategory;
    }
  }

  return bestCategory;
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
        category = '기타';
        fallbackCount++;
      }
    }

    await db
      .update(threadPosts)
      .set({ topic_category: category })
      .where(eq(threadPosts.post_id, row.post_id));
  }

  const classified = ruleMatched + textMatched + fallbackCount;
  console.log(`[topic-classifier] Done: ${classified} classified (tag: ${ruleMatched}, text: ${textMatched}, fallback '기타': ${fallbackCount})`);

  return { classified, ruleMatched, llmClassified: textMatched };
}
