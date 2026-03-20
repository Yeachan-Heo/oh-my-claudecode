/**
 * @file Topic classifier — batch-classifies posts into TopicCategory.
 *
 * Strategy:
 *   1. Rule-based: map topic_tags to category via TAG_MAP (~50 frequent tags)
 *   2. No-match fallback: set to '기타'
 *   3. DB UPDATE: fill topic_category column
 */

import { eq, isNull } from 'drizzle-orm';
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

// ---------------------------------------------------------------------------
// Main: classifyTopics
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  classified: number;
  ruleMatched: number;
  llmClassified: number;
}

/**
 * Batch-classify posts that have topic_category = null.
 *
 * 1. Fetch unclassified posts (up to `limit`)
 * 2. Try rule-based mapping via TAG_MAP
 * 3. Fall back to '기타' for remaining (no LLM)
 * 4. UPDATE topic_category in DB
 */
export async function classifyTopics(limit: number = 100): Promise<ClassifyResult> {
  // Fetch posts with topic_category = null
  const rows = await db
    .select({
      post_id: threadPosts.post_id,
      text: threadPosts.text,
      topic_tags: threadPosts.topic_tags,
    })
    .from(threadPosts)
    .where(isNull(threadPosts.topic_category))
    .limit(limit);

  if (rows.length === 0) {
    console.log('[topic-classifier] No unclassified posts found');
    return { classified: 0, ruleMatched: 0, llmClassified: 0 };
  }

  console.log(`[topic-classifier] Found ${rows.length} unclassified posts`);

  let ruleMatched = 0;
  let fallbackCount = 0;

  for (const row of rows) {
    const category = classifyByRule(row.topic_tags) ?? '기타';
    await db
      .update(threadPosts)
      .set({ topic_category: category })
      .where(eq(threadPosts.post_id, row.post_id));

    if (category !== '기타') {
      ruleMatched++;
    } else {
      fallbackCount++;
    }
  }

  const classified = ruleMatched + fallbackCount;
  console.log(`[topic-classifier] Done: ${classified} classified (rule: ${ruleMatched}, fallback '기타': ${fallbackCount})`);

  return { classified, ruleMatched, llmClassified: 0 };
}
