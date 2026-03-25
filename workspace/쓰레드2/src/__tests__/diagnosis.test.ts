/**
 * @file Diagnosis engine unit tests — diagnoseBottleneck and generateTuningActions.
 * No DB calls. Tests pure decision-tree logic only.
 */

import { describe, it, expect } from 'vitest';
import {
  diagnoseBottleneck,
  diagnoseBottleneckWarmup,
  generateTuningActions,
  THRESHOLDS,
} from '../tracker/diagnosis.js';
import type { DiagnosisResult } from '../tracker/diagnosis.js';
import type { WeeklyStats } from '../tracker/metrics.js';

// ─── Helpers ─────────────────────────────────────────────

function makeStats(overrides: Partial<WeeklyStats> = {}): WeeklyStats {
  return {
    weekStart: '2026-03-10T00:00:00.000Z',
    weekEnd: '2026-03-17T00:00:00.000Z',
    totalPosts: 10,
    avgCtr: 0.05,               // above MIN_CTR (0.01)
    avgConversionRate: 0.01,    // above MIN_CONVERSION (0.001)
    avgRevenuePerPost: 500,     // above MIN_REVENUE_PER_POST (100)
    avgReach: 500,              // above MIN_REACH (100)
    avgProductRelevance: 0.7,   // above PRODUCT_RELEVANCE_THRESHOLD (0.5)
    categoryPerformance: {},
    ...overrides,
  };
}

// ─── diagnoseBottleneck ──────────────────────────────────

describe('diagnoseBottleneck', () => {
  it('returns none when totalPosts is zero', () => {
    const stats = makeStats({ totalPosts: 0 });
    const result = diagnoseBottleneck(stats);
    expect(result.bottleneck).toBe('none');
  });

  it('returns none when revenue is at or above threshold', () => {
    const stats = makeStats({ avgRevenuePerPost: THRESHOLDS.MIN_REVENUE_PER_POST });
    const result = diagnoseBottleneck(stats);
    expect(result.bottleneck).toBe('none');
  });

  it('returns publishing when reach is below threshold', () => {
    const stats = makeStats({
      avgRevenuePerPost: 0,
      avgReach: THRESHOLDS.MIN_REACH - 1,
    });
    const result = diagnoseBottleneck(stats);
    expect(result.bottleneck).toBe('publishing');
  });

  it('returns content when CTR is low but product relevance is high', () => {
    const stats = makeStats({
      avgRevenuePerPost: 0,
      avgReach: 500,
      avgCtr: THRESHOLDS.MIN_CTR - 0.001,
      avgProductRelevance: THRESHOLDS.PRODUCT_RELEVANCE_THRESHOLD + 0.1,
    });
    const result = diagnoseBottleneck(stats);
    expect(result.bottleneck).toBe('content');
  });

  it('returns matching when CTR is low and product relevance is low', () => {
    const stats = makeStats({
      avgRevenuePerPost: 0,
      avgReach: 500,
      avgCtr: THRESHOLDS.MIN_CTR - 0.001,
      avgProductRelevance: THRESHOLDS.PRODUCT_RELEVANCE_THRESHOLD - 0.1,
    });
    const result = diagnoseBottleneck(stats);
    expect(result.bottleneck).toBe('matching');
  });

  it('returns matching when CTR is OK but conversion rate is below threshold', () => {
    const stats = makeStats({
      avgRevenuePerPost: 0,
      avgReach: 500,
      avgCtr: THRESHOLDS.MIN_CTR + 0.01,
      avgConversionRate: THRESHOLDS.MIN_CONVERSION - 0.0001,
    });
    const result = diagnoseBottleneck(stats);
    expect(result.bottleneck).toBe('matching');
  });

  it('returns collection when all metrics are borderline low', () => {
    const stats = makeStats({
      avgRevenuePerPost: 0,
      avgReach: THRESHOLDS.MIN_REACH + 1,
      avgCtr: THRESHOLDS.MIN_CTR + 0.01,
      avgConversionRate: THRESHOLDS.MIN_CONVERSION + 0.001,
    });
    const result = diagnoseBottleneck(stats);
    expect(result.bottleneck).toBe('collection');
  });

  it('includes the stats object in the result', () => {
    const stats = makeStats();
    const result = diagnoseBottleneck(stats);
    expect(result.stats).toBe(stats);
  });

  it('includes non-empty evidence string in the result', () => {
    const stats = makeStats({ totalPosts: 0 });
    const result = diagnoseBottleneck(stats);
    expect(typeof result.evidence).toBe('string');
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});

// ─── generateTuningActions ───────────────────────────────

describe('generateTuningActions', () => {
  function makeDiagnosis(bottleneck: DiagnosisResult['bottleneck']): DiagnosisResult {
    return { bottleneck, evidence: 'test', stats: makeStats() };
  }

  it('returns empty array for bottleneck none', () => {
    const actions = generateTuningActions(makeDiagnosis('none'));
    expect(actions).toHaveLength(0);
  });

  it('returns scraper-targeted actions for collection bottleneck', () => {
    const actions = generateTuningActions(makeDiagnosis('collection'));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(a => a.target === 'scraper')).toBe(true);
  });

  it('returns analyzer-targeted actions for analysis bottleneck', () => {
    const actions = generateTuningActions(makeDiagnosis('analysis'));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(a => a.target === 'analyzer')).toBe(true);
  });

  it('returns matcher-targeted actions for matching bottleneck', () => {
    const actions = generateTuningActions(makeDiagnosis('matching'));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(a => a.target === 'matcher')).toBe(true);
  });

  it('returns content_generator-targeted actions for content bottleneck', () => {
    const actions = generateTuningActions(makeDiagnosis('content'));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(a => a.target === 'content_generator')).toBe(true);
  });

  it('returns publisher-targeted actions for publishing bottleneck', () => {
    const actions = generateTuningActions(makeDiagnosis('publishing'));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(a => a.target === 'publisher')).toBe(true);
  });

  it('all generated actions have applied=false initially', () => {
    for (const bottleneck of ['collection', 'analysis', 'matching', 'content', 'publishing'] as const) {
      const actions = generateTuningActions(makeDiagnosis(bottleneck));
      expect(actions.every(a => a.applied === false)).toBe(true);
    }
  });

  it('all generated actions have a non-empty action string', () => {
    const actions = generateTuningActions(makeDiagnosis('collection'));
    expect(actions.every(a => a.action.length > 0)).toBe(true);
  });

  it('includes at least one high priority action for each bottleneck type', () => {
    for (const bottleneck of ['collection', 'analysis', 'matching', 'content', 'publishing'] as const) {
      const actions = generateTuningActions(makeDiagnosis(bottleneck));
      const hasHigh = actions.some(a => a.priority === 'high');
      expect(hasHigh, `${bottleneck} should have a high priority action`).toBe(true);
    }
  });
});

// ─── diagnoseBottleneckWarmup ──────────────────────────────

describe('diagnoseBottleneckWarmup', () => {
  it('returns none when totalPosts is zero', () => {
    const stats = makeStats({ totalPosts: 0 });
    const result = diagnoseBottleneckWarmup(stats);
    expect(result.bottleneck).toBe('none');
    expect(result.evidence).toContain('워밍업');
  });

  it('returns publishing when reach is below threshold', () => {
    const stats = makeStats({
      avgReach: THRESHOLDS.MIN_REACH - 1,
      avgRevenuePerPost: 0,
      avgCtr: 0,
      avgConversionRate: 0,
    });
    const result = diagnoseBottleneckWarmup(stats);
    expect(result.bottleneck).toBe('publishing');
    expect(result.evidence).toContain('워밍업');
  });

  it('returns none when reach is OK (ignores revenue/CTR/conversion)', () => {
    const stats = makeStats({
      avgReach: THRESHOLDS.MIN_REACH + 100,
      avgRevenuePerPost: 0,        // Would normally trigger bottleneck
      avgCtr: 0,                    // Would normally trigger bottleneck
      avgConversionRate: 0,          // Would normally trigger bottleneck
    });
    const result = diagnoseBottleneckWarmup(stats);
    expect(result.bottleneck).toBe('none');
    expect(result.evidence).toContain('워밍업');
    expect(result.evidence).toContain('정상');
  });

  it('differs from standard diagnosis when revenue is 0 but reach is OK', () => {
    const stats = makeStats({
      avgReach: 500,
      avgRevenuePerPost: 0,
      avgCtr: 0.05,
      avgConversionRate: 0,
    });
    // Standard diagnosis: revenue=0 → traces to conversion → 'matching'
    const standard = diagnoseBottleneck(stats);
    expect(standard.bottleneck).not.toBe('none');

    // Warmup diagnosis: reach OK → 'none' (ignores revenue/conversion)
    const warmup = diagnoseBottleneckWarmup(stats);
    expect(warmup.bottleneck).toBe('none');
  });

  it('generates no tuning actions when warmup diagnosis is none', () => {
    const stats = makeStats({
      avgReach: 500,
      avgRevenuePerPost: 0,
    });
    const diagnosis = diagnoseBottleneckWarmup(stats);
    const actions = generateTuningActions(diagnosis);
    expect(actions).toHaveLength(0);
  });

  it('generates publishing actions when warmup diagnosis is publishing', () => {
    const stats = makeStats({
      avgReach: 10,
      avgRevenuePerPost: 0,
    });
    const diagnosis = diagnoseBottleneckWarmup(stats);
    expect(diagnosis.bottleneck).toBe('publishing');
    const actions = generateTuningActions(diagnosis);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(a => a.target === 'publisher')).toBe(true);
  });
});
