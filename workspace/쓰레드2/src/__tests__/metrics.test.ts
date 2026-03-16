/**
 * @file Velocity metrics unit tests — calculateVelocity pure function.
 * No DB calls. Tests numeric computation only.
 */

import { describe, it, expect } from 'vitest';
import { calculateVelocity } from '../tracker/metrics.js';
import type { VelocityInput } from '../tracker/metrics.js';

const baseSnapshot: VelocityInput = {
  likes: 100,
  comments: 20,
  shares: 10,
  clicks: 50,
  conversions: 5,
};

// ─── calculateVelocity ───────────────────────────────────

describe('calculateVelocity', () => {
  it('returns zero velocities when ageHours is zero', () => {
    const result = calculateVelocity(baseSnapshot, 0);
    expect(result.engagement_velocity).toBe(0);
    expect(result.click_velocity).toBe(0);
    expect(result.conversion_velocity).toBe(0);
  });

  it('returns zero velocities when ageHours is negative', () => {
    const result = calculateVelocity(baseSnapshot, -5);
    expect(result.engagement_velocity).toBe(0);
    expect(result.click_velocity).toBe(0);
    expect(result.conversion_velocity).toBe(0);
  });

  it('calculates engagement_velocity as (likes + comments + shares) / ageHours', () => {
    const snapshot: VelocityInput = { likes: 60, comments: 30, shares: 10, clicks: 0, conversions: 0 };
    const result = calculateVelocity(snapshot, 10);
    // (60 + 30 + 10) / 10 = 10
    expect(result.engagement_velocity).toBe(10);
  });

  it('calculates click_velocity as clicks / ageHours', () => {
    const snapshot: VelocityInput = { likes: 0, comments: 0, shares: 0, clicks: 75, conversions: 0 };
    const result = calculateVelocity(snapshot, 25);
    // 75 / 25 = 3
    expect(result.click_velocity).toBe(3);
  });

  it('calculates conversion_velocity as conversions / ageHours', () => {
    const snapshot: VelocityInput = { likes: 0, comments: 0, shares: 0, clicks: 0, conversions: 10 };
    const result = calculateVelocity(snapshot, 5);
    // 10 / 5 = 2
    expect(result.conversion_velocity).toBe(2);
  });

  it('computes all three velocities simultaneously', () => {
    const snapshot: VelocityInput = {
      likes: 120,
      comments: 30,
      shares: 50,
      clicks: 40,
      conversions: 8,
    };
    const result = calculateVelocity(snapshot, 20);
    // engagement = (120+30+50)/20 = 10
    expect(result.engagement_velocity).toBe(10);
    // click = 40/20 = 2
    expect(result.click_velocity).toBe(2);
    // conversion = 8/20 = 0.4
    expect(result.conversion_velocity).toBeCloseTo(0.4);
  });

  it('returns fractional velocities for non-integer division', () => {
    const snapshot: VelocityInput = { likes: 10, comments: 5, shares: 0, clicks: 7, conversions: 3 };
    const result = calculateVelocity(snapshot, 6);
    // engagement = 15/6 = 2.5
    expect(result.engagement_velocity).toBeCloseTo(2.5);
    // click = 7/6 ≈ 1.1667
    expect(result.click_velocity).toBeCloseTo(7 / 6);
    // conversion = 3/6 = 0.5
    expect(result.conversion_velocity).toBeCloseTo(0.5);
  });

  it('handles zero engagement metrics with positive ageHours', () => {
    const snapshot: VelocityInput = { likes: 0, comments: 0, shares: 0, clicks: 0, conversions: 0 };
    const result = calculateVelocity(snapshot, 48);
    expect(result.engagement_velocity).toBe(0);
    expect(result.click_velocity).toBe(0);
    expect(result.conversion_velocity).toBe(0);
  });
});
