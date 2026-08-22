import { describe, it, expect } from 'vitest';
import {
  RETIREMENT_POLICY,
  parseVersion,
  countMinorReleasesSince,
  isMinorThresholdMet,
  daysBetween,
  isDaysThresholdMet,
  isTemporalThresholdMet,
  canonicalShare,
  isCanonicalShareMet,
  isConsecutiveCanonicalShareMet,
} from '../policy.js';

describe('alias-retirement policy', () => {
  it('exposes authoritative policy constants', () => {
    expect(RETIREMENT_POLICY.minMinorReleases).toBe(2);
    expect(RETIREMENT_POLICY.minDays).toBe(90);
    expect(RETIREMENT_POLICY.minCanonicalShare).toBe(0.95);
    expect(RETIREMENT_POLICY.requiredConsecutiveReleases).toBe(2);
    expect(RETIREMENT_POLICY.requiresZeroCriticalIntegrations).toBe(true);
  });

  describe('parseVersion', () => {
    it('parses semver', () => {
      expect(parseVersion('4.15.10')).toEqual({ major: 4, minor: 15, patch: 10, raw: '4.15.10' });
      expect(parseVersion('v4.3.0')?.minor).toBe(3);
      expect(parseVersion('4.3.0-alpha')?.patch).toBe(0);
    });
    it('returns null for invalid', () => {
      expect(parseVersion('not-a-version')).toBeNull();
      expect(parseVersion('')).toBeNull();
    });
  });

  describe('countMinorReleasesSince', () => {
    it('counts minor diff within same major', () => {
      expect(countMinorReleasesSince('4.2.15', '4.15.10')).toBe(13);
      expect(countMinorReleasesSince('4.15.3', '4.15.10')).toBe(0);
      expect(countMinorReleasesSince('4.15.3', '4.17.0')).toBe(2);
      expect(countMinorReleasesSince('4.2.15', '4.4.0')).toBe(2);
      expect(countMinorReleasesSince('4.3.0', '4.5.0')).toBe(2);
    });
    it('treats major bump as large elapsed', () => {
      const elapsed = countMinorReleasesSince('4.15.3', '5.0.0');
      expect(elapsed).not.toBeNull();
      expect(elapsed! >= 2).toBe(true);
    });
    it('returns null for regressive version', () => {
      expect(countMinorReleasesSince('4.15.10', '4.2.15')).toBeNull();
      expect(countMinorReleasesSince('5.0.0', '4.15.10')).toBeNull();
    });
    it('returns null for invalid semver', () => {
      expect(countMinorReleasesSince('bad', '4.15.10')).toBeNull();
      expect(countMinorReleasesSince('4.2.15', 'bad')).toBeNull();
    });
  });

  describe('isMinorThresholdMet', () => {
    it('is met when elapsed >= 2', () => {
      expect(isMinorThresholdMet('4.2.15', '4.4.0').met).toBe(true);
      expect(isMinorThresholdMet('4.2.15', '4.15.10').met).toBe(true);
      expect(isMinorThresholdMet('4.15.3', '4.17.0').met).toBe(true);
    });
    it('is not met when elapsed < 2', () => {
      expect(isMinorThresholdMet('4.2.15', '4.3.0').met).toBe(false);
      expect(isMinorThresholdMet('4.15.3', '4.15.10').met).toBe(false);
      expect(isMinorThresholdMet('4.15.3', '4.16.0').met).toBe(false);
    });
    it('carries elapsed and reason', () => {
      const r = isMinorThresholdMet('4.15.3', '4.16.0');
      expect(r.elapsed).toBe(1);
      expect(r.reason).toMatch(/need 1 more/);
    });
  });

  describe('daysBetween / isDaysThresholdMet', () => {
    it('measures whole days', () => {
      const introduced = '2026-02-19';
      const now = new Date('2026-08-12T00:00:00Z');
      const days = daysBetween(introduced, now);
      expect(days).toBeGreaterThanOrEqual(170);
      expect(isDaysThresholdMet(introduced, now).met).toBe(true);
    });
    it('not met before 90 days', () => {
      const now = new Date('2026-03-20T00:00:00Z');
      expect(isDaysThresholdMet('2026-02-19', now).met).toBe(false);
      expect(isDaysThresholdMet('2026-07-10', new Date('2026-08-12T00:00:00Z')).met).toBe(false);
    });
    it('met exactly at 90 days', () => {
      const introduced = '2026-02-19';
      const at90 = new Date(new Date(introduced).getTime() + 90 * 24 * 60 * 60 * 1000);
      expect(isDaysThresholdMet(introduced, at90).met).toBe(true);
    });
    it('invalid date returns null', () => {
      expect(daysBetween('not-a-date', new Date())).toBeNull();
      expect(isDaysThresholdMet('not-a-date', new Date()).met).toBe(false);
    });
  });

  describe('isTemporalThresholdMet (whichever longer: 2 minors AND 90 days)', () => {
    it('requires both minors and days', () => {
      // learner introduced 4.2.15 / 2026-02-19, now is 4.15.10 / 2026-08-12 → both met
      const r = isTemporalThresholdMet('4.2.15', '2026-02-19', '4.15.10', new Date('2026-08-12T00:00:00Z'));
      expect(r.met).toBe(true);
      expect(r.minors.met).toBe(true);
      expect(r.days.met).toBe(true);
    });
    it('not met when minors not yet reached even if days met', () => {
      const r = isTemporalThresholdMet('4.15.3', '2026-07-10', '4.15.10', new Date('2026-08-12T00:00:00Z'));
      // days: 33 < 90, minors: 0 < 2 → both not met → not met
      expect(r.met).toBe(false);
      expect(r.minors.met).toBe(false);
      expect(r.days.met).toBe(false);
    });
    it('not met when days not yet reached even if minors met', () => {
      // fake: introduced at 4.2.15 but very recent date
      const r = isTemporalThresholdMet('4.2.15', '2026-07-20', '4.15.10', new Date('2026-08-12T00:00:00Z'));
      expect(r.minors.met).toBe(true);
      expect(r.days.met).toBe(false);
      expect(r.met).toBe(false);
    });
    it('provides nextEligibleDate and nextEligibleVersion when not met', () => {
      const r = isTemporalThresholdMet('4.15.3', '2026-07-10', '4.15.10', new Date('2026-08-12T00:00:00Z'));
      expect(r.nextEligibleDate).toBe('2026-10-08');
      expect(r.nextEligibleVersion).toBe('4.17.0');
    });
    it('learning: nextEligibleVersion null when minors already met', () => {
      const r = isTemporalThresholdMet('4.2.15', '2026-07-10', '4.15.10', new Date('2026-08-12T00:00:00Z'));
      expect(r.minors.met).toBe(true);
      expect(r.nextEligibleVersion).toBeNull();
      expect(r.days.met).toBe(false);
      expect(r.nextEligibleDate).not.toBeNull();
    });
  });

  describe('canonicalShare', () => {
    it('computes 95% threshold', () => {
      expect(canonicalShare(5, 95)).toBeCloseTo(0.95);
      expect(canonicalShare(1, 99)).toBeCloseTo(0.99);
      expect(canonicalShare(5, 95)).not.toBeNull();
    });
    it('null when no data', () => {
      expect(canonicalShare(0, 0)).toBeNull();
    });
    it('isCanonicalShareMet checks threshold', () => {
      expect(isCanonicalShareMet(5, 95).met).toBe(true);
      expect(isCanonicalShareMet(5, 95, 0.95).met).toBe(true);
      expect(isCanonicalShareMet(6, 94).met).toBe(false);
      expect(isCanonicalShareMet(0, 0).met).toBe(false);
    });
    it('95 exactly is met', () => {
      expect(isCanonicalShareMet(5, 95).met).toBe(true);
      expect(isCanonicalShareMet(50, 950).met).toBe(true);
    });
  });

  describe('isConsecutiveCanonicalShareMet', () => {
    it('requires 2 releases by default', () => {
      expect(isConsecutiveCanonicalShareMet([{ aliasCount: 2, canonicalCount: 98 }]).met).toBe(false);
    });
    it('met when last 2 both >=95%', () => {
      const r = isConsecutiveCanonicalShareMet([
        { aliasCount: 5, canonicalCount: 95 },
        { aliasCount: 2, canonicalCount: 98 },
      ]);
      expect(r.met).toBe(true);
    });
    it('not met when any of last 2 is below 95%', () => {
      const r = isConsecutiveCanonicalShareMet([
        { aliasCount: 2, canonicalCount: 98 },
        { aliasCount: 10, canonicalCount: 90 },
      ]);
      expect(r.met).toBe(false);
    });
    it('evaluates only last N when history longer', () => {
      const r = isConsecutiveCanonicalShareMet([
        { aliasCount: 50, canonicalCount: 50 }, // ignored (oldest)
        { aliasCount: 2, canonicalCount: 98 },
        { aliasCount: 1, canonicalCount: 99 },
      ]);
      expect(r.met).toBe(true);
    });
    it('no data -> not met', () => {
      expect(isConsecutiveCanonicalShareMet([]).met).toBe(false);
      expect(isConsecutiveCanonicalShareMet([{ aliasCount: 0, canonicalCount: 0 }]).met).toBe(false);
    });
  });
});
