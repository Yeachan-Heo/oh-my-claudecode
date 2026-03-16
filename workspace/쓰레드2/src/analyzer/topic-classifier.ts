/**
 * @file Topic classifier — batch-classifies posts into TopicCategory.
 *
 * Strategy:
 *   1. Rule-based: map topic_tags to category via TAG_MAP (~50 frequent tags)
 *   2. LLM fallback: Haiku batch call for unmapped posts (cost ~$0.01/100 posts)
 *   3. DB UPDATE: fill topic_category column
 */

import { eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { threadPosts } from '../db/schema.js';
import { callLLM, parseJSON } from './llm.js';
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
// LLM batch classification
// ---------------------------------------------------------------------------

interface PostForClassification {
  post_id: string;
  text: string;
  topic_tags: string[] | null;
}

interface LLMClassificationResult {
  classifications: Array<{
    post_id: string;
    topic_category: TopicCategory;
  }>;
}

async function classifyByLLM(posts: PostForClassification[]): Promise<Map<string, TopicCategory>> {
  if (posts.length === 0) return new Map();

  const systemPrompt = `당신은 한국어 소셜미디어 포스트를 주제별로 분류하는 전문가입니다.

각 포스트를 다음 카테고리 중 하나로 분류하세요:
건강, 뷰티, 다이어트, 운동, 생활, 주방, 디지털, 육아, 인테리어, 패션, 식품, 문구, 향수, 기타

규칙:
- 포스트 본문과 topic_tags를 모두 고려하세요
- 확실하지 않으면 "기타"로 분류하세요
- JSON 형식으로 응답하세요`;

  const userMessage = JSON.stringify({
    instruction: 'Classify each post into one TopicCategory. Return JSON with a "classifications" array of { post_id, topic_category }.',
    posts: posts.map((p) => ({
      post_id: p.post_id,
      text: p.text.slice(0, 200), // truncate for cost savings
      topic_tags: p.topic_tags,
    })),
    valid_categories: VALID_CATEGORIES,
  });

  const raw = await callLLM({
    model: 'claude-sonnet-4-6-20250715', // Haiku-class cost; using available model
    systemPrompt,
    userMessage,
    maxTokens: 4096,
    temperature: 0,
  });

  const parsed = parseJSON<Record<string, unknown>>(raw);

  // Handle different LLM response shapes
  let classifications: Array<{ post_id: string; topic_category: string }>;
  if (Array.isArray(parsed)) {
    classifications = parsed as any;
  } else if (Array.isArray((parsed as any).classifications)) {
    classifications = (parsed as any).classifications;
  } else {
    const arrayProp = Object.values(parsed).find((v) => Array.isArray(v));
    classifications = arrayProp ? (arrayProp as any) : [];
  }

  const result = new Map<string, TopicCategory>();
  for (const c of classifications) {
    const category = VALID_CATEGORIES.includes(c.topic_category as TopicCategory)
      ? (c.topic_category as TopicCategory)
      : '기타';
    result.set(c.post_id, category);
  }

  return result;
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
 * 3. Fall back to LLM batch call for remaining
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
  const needsLLM: PostForClassification[] = [];

  // Phase 1: Rule-based classification
  for (const row of rows) {
    const category = classifyByRule(row.topic_tags);
    if (category) {
      await db
        .update(threadPosts)
        .set({ topic_category: category })
        .where(eq(threadPosts.post_id, row.post_id));
      ruleMatched++;
    } else {
      needsLLM.push({
        post_id: row.post_id,
        text: row.text,
        topic_tags: row.topic_tags,
      });
    }
  }

  console.log(`[topic-classifier] Rule-matched: ${ruleMatched}, needs LLM: ${needsLLM.length}`);

  // Phase 2: LLM batch classification (in chunks of 50)
  let llmClassified = 0;
  const BATCH_SIZE = 50;

  for (let i = 0; i < needsLLM.length; i += BATCH_SIZE) {
    const batch = needsLLM.slice(i, i + BATCH_SIZE);

    try {
      const classifications = await classifyByLLM(batch);

      for (const [postId, category] of classifications) {
        await db
          .update(threadPosts)
          .set({ topic_category: category })
          .where(eq(threadPosts.post_id, postId));
        llmClassified++;
      }
    } catch (err) {
      console.error(
        `[topic-classifier] LLM batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Mark remaining in this batch as '기타'
      for (const post of batch) {
        await db
          .update(threadPosts)
          .set({ topic_category: '기타' })
          .where(eq(threadPosts.post_id, post.post_id));
        llmClassified++;
      }
    }
  }

  const classified = ruleMatched + llmClassified;
  console.log(`[topic-classifier] Done: ${classified} classified (rule: ${ruleMatched}, llm: ${llmClassified})`);

  return { classified, ruleMatched, llmClassified };
}
