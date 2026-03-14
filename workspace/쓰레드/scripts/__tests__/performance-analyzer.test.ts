import { describe, test, expect } from 'vitest';
import { calcEngagementStats, analyzeTimePatterns, calcLearningDeltas } from '../performance-analyzer.js';
import type { CanonicalPost } from '../types.js';

// 테스트용 포스트 헬퍼
function makePost(overrides: Partial<CanonicalPost> = {}): CanonicalPost {
  return {
    post_id: `post_${Math.random().toString(36).slice(2)}`,
    channel_id: 'test_channel',
    text: '테스트 포스트',
    timestamp: '2026-03-14T10:00:00.000Z',
    metrics: { view_count: 100, like_count: 5, reply_count: 1, repost_count: 0 },
    tags: { primary: 'affiliate', secondary: [] },
    ...overrides,
  };
}

describe('calcEngagementStats', () => {
  test('groups posts by primary tag', () => {
    const posts = [
      makePost({ tags: { primary: 'affiliate', secondary: [] } }),
      makePost({ tags: { primary: 'affiliate', secondary: [] } }),
      makePost({ tags: { primary: 'general', secondary: [] } }),
    ];
    const stats = calcEngagementStats(posts);
    expect(stats['affiliate'].post_count).toBe(2);
    expect(stats['general'].post_count).toBe(1);
  });

  test('calculates correct avg_likes', () => {
    const posts = [
      makePost({ metrics: { view_count: 100, like_count: 10, reply_count: 0, repost_count: 0 } }),
      makePost({ metrics: { view_count: 200, like_count: 20, reply_count: 0, repost_count: 0 } }),
    ];
    const stats = calcEngagementStats(posts);
    expect(stats['affiliate'].avg_likes).toBe(15);
  });

  test('calculates correct avg_views excluding null', () => {
    const posts = [
      makePost({ metrics: { view_count: 100, like_count: 5, reply_count: 0, repost_count: 0 } }),
      makePost({ metrics: { view_count: null, like_count: 5, reply_count: 0, repost_count: 0 } }),
      makePost({ metrics: { view_count: 300, like_count: 5, reply_count: 0, repost_count: 0 } }),
    ];
    const stats = calcEngagementStats(posts);
    // null 제외: (100 + 300) / 2 = 200
    expect(stats['affiliate'].avg_views).toBe(200);
  });

  test('returns null avg_views when all views are null', () => {
    const posts = [
      makePost({ metrics: { view_count: null, like_count: 5, reply_count: 0, repost_count: 0 } }),
    ];
    const stats = calcEngagementStats(posts);
    expect(stats['affiliate'].avg_views).toBeNull();
  });

  test('handles empty posts array', () => {
    const stats = calcEngagementStats([]);
    expect(Object.keys(stats)).toHaveLength(0);
  });

  test('includes avg_replies in stats', () => {
    const posts = [
      makePost({ metrics: { view_count: 100, like_count: 5, reply_count: 2, repost_count: 0 } }),
      makePost({ metrics: { view_count: 100, like_count: 5, reply_count: 4, repost_count: 0 } }),
    ];
    const stats = calcEngagementStats(posts);
    expect(stats['affiliate'].avg_replies).toBe(3);
  });
});

describe('analyzeTimePatterns', () => {
  test('buckets posts into 4 time slots', () => {
    const posts = [
      makePost({ timestamp: '2026-03-14T01:00:00.000Z' }), // UTC 1시 = KST 10시 → 오전
      makePost({ timestamp: '2026-03-14T06:00:00.000Z' }), // UTC 6시 = KST 15시 → 오후
      makePost({ timestamp: '2026-03-14T14:00:00.000Z' }), // UTC 14시 = KST 23시 → 밤
      makePost({ timestamp: '2026-03-13T17:00:00.000Z' }), // UTC 17시 = KST 2시 → 새벽
    ];
    const patterns = analyzeTimePatterns(posts);
    expect(patterns['오전'].post_count).toBeGreaterThanOrEqual(1);
    expect(patterns['오후'].post_count).toBeGreaterThanOrEqual(1);
    expect(patterns['밤'].post_count).toBeGreaterThanOrEqual(1);
    expect(patterns['새벽'].post_count).toBeGreaterThanOrEqual(1);
  });

  test('all 4 slots exist in result', () => {
    const posts = [makePost()];
    const patterns = analyzeTimePatterns(posts);
    expect(Object.keys(patterns)).toContain('새벽');
    expect(Object.keys(patterns)).toContain('오전');
    expect(Object.keys(patterns)).toContain('오후');
    expect(Object.keys(patterns)).toContain('밤');
  });

  test('calculates correct avg_likes per slot', () => {
    // UTC 1시 = KST 10시 = 오전
    const posts = [
      makePost({
        timestamp: '2026-03-14T01:00:00.000Z',
        metrics: { view_count: 100, like_count: 10, reply_count: 0, repost_count: 0 },
      }),
      makePost({
        timestamp: '2026-03-14T02:00:00.000Z',
        metrics: { view_count: 200, like_count: 20, reply_count: 0, repost_count: 0 },
      }),
    ];
    const patterns = analyzeTimePatterns(posts);
    expect(patterns['오전'].avg_likes).toBe(15);
  });

  test('slot with no posts has post_count 0', () => {
    // 새벽 포스트만 있음 (UTC 15시 = KST 0시 = 새벽)
    const posts = [makePost({ timestamp: '2026-03-14T15:00:00.000Z' })];
    const patterns = analyzeTimePatterns(posts);
    expect(patterns['새벽'].post_count).toBe(1);
    expect(patterns['오전'].post_count).toBe(0);
  });
});

describe('calcLearningDeltas', () => {
  test('returns positive deltas for above-average engagement posts', () => {
    const overallAvgLikes = 5;
    // 10 > 5 → positive delta
    const deltas = calcLearningDeltas('prod_001', 10, overallAvgLikes);
    expect(deltas.naturalness_delta).toBeGreaterThan(0);
    expect(deltas.story_potential_delta).toBeGreaterThan(0);
  });

  test('returns negative deltas for below-average engagement posts', () => {
    const overallAvgLikes = 10;
    // 2 < 10 → negative delta
    const deltas = calcLearningDeltas('prod_001', 2, overallAvgLikes);
    expect(deltas.naturalness_delta).toBeLessThan(0);
    expect(deltas.story_potential_delta).toBeLessThan(0);
  });

  test('returns zero deltas for average engagement', () => {
    const deltas = calcLearningDeltas('prod_001', 5, 5);
    expect(deltas.naturalness_delta ?? 0).toBe(0);
    expect(deltas.story_potential_delta ?? 0).toBe(0);
  });

  test('clamps delta to [-2, 2]', () => {
    // 100배 차이가 나도 clamp
    const posDeltas = calcLearningDeltas('prod_001', 1000, 5);
    const negDeltas = calcLearningDeltas('prod_002', 1, 500);

    expect(posDeltas.naturalness_delta).toBeLessThanOrEqual(2);
    expect(negDeltas.naturalness_delta).toBeGreaterThanOrEqual(-2);
  });

  test('sets product_id correctly', () => {
    const deltas = calcLearningDeltas('my_product_id', 10, 5);
    expect(deltas.product_id).toBe('my_product_id');
  });
});
