/**
 * Tests for rate-limit-monitor.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkRateLimitStatus,
  formatTimeUntilReset,
  formatRateLimitStatus,
} from '../../features/rate-limit-wait/rate-limit-monitor.js';
import type { RateLimitStatus } from '../../features/rate-limit-wait/types.js';

// Mock the usage-api module
vi.mock('../../hud/usage-api.js', () => ({
  getUsage: vi.fn(),
}));

import { getUsage } from '../../hud/usage-api.js';

describe('rate-limit-monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkRateLimitStatus', () => {
    it('should return null when getUsage returns null', async () => {
      vi.mocked(getUsage).mockResolvedValue(null);

      const result = await checkRateLimitStatus();

      expect(result).toBeNull();
    });

    it('should detect 5-hour rate limit', async () => {
      const resetTime = new Date(Date.now() + 3600000); // 1 hour from now
      vi.mocked(getUsage).mockResolvedValue({
        fiveHourPercent: 100,
        weeklyPercent: 50,
        fiveHourResetsAt: resetTime,
        weeklyResetsAt: null,
      });

      const result = await checkRateLimitStatus();

      expect(result).not.toBeNull();
      expect(result!.fiveHourLimited).toBe(true);
      expect(result!.weeklyLimited).toBe(false);
      expect(result!.isLimited).toBe(true);
      expect(result!.nextResetAt).toEqual(resetTime);
    });

    it('should detect weekly rate limit', async () => {
      const resetTime = new Date(Date.now() + 86400000); // 1 day from now
      vi.mocked(getUsage).mockResolvedValue({
        fiveHourPercent: 50,
        weeklyPercent: 100,
        fiveHourResetsAt: null,
        weeklyResetsAt: resetTime,
      });

      const result = await checkRateLimitStatus();

      expect(result).not.toBeNull();
      expect(result!.fiveHourLimited).toBe(false);
      expect(result!.weeklyLimited).toBe(true);
      expect(result!.isLimited).toBe(true);
      expect(result!.nextResetAt).toEqual(resetTime);
    });

    it('should detect both limits and return earliest reset', async () => {
      const fiveHourReset = new Date(Date.now() + 3600000); // 1 hour
      const weeklyReset = new Date(Date.now() + 86400000); // 1 day
      vi.mocked(getUsage).mockResolvedValue({
        fiveHourPercent: 100,
        weeklyPercent: 100,
        fiveHourResetsAt: fiveHourReset,
        weeklyResetsAt: weeklyReset,
      });

      const result = await checkRateLimitStatus();

      expect(result).not.toBeNull();
      expect(result!.fiveHourLimited).toBe(true);
      expect(result!.weeklyLimited).toBe(true);
      expect(result!.isLimited).toBe(true);
      expect(result!.nextResetAt).toEqual(fiveHourReset); // Earlier reset
    });

    it('should return not limited when under thresholds', async () => {
      vi.mocked(getUsage).mockResolvedValue({
        fiveHourPercent: 50,
        weeklyPercent: 75,
        fiveHourResetsAt: null,
        weeklyResetsAt: null,
      });

      const result = await checkRateLimitStatus();

      expect(result).not.toBeNull();
      expect(result!.fiveHourLimited).toBe(false);
      expect(result!.weeklyLimited).toBe(false);
      expect(result!.isLimited).toBe(false);
      expect(result!.nextResetAt).toBeNull();
      expect(result!.timeUntilResetMs).toBeNull();
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(getUsage).mockRejectedValue(new Error('API error'));

      const result = await checkRateLimitStatus();

      expect(result).toBeNull();
    });
  });

  describe('formatTimeUntilReset', () => {
    it('should format hours and minutes', () => {
      const twoHours = 2 * 60 * 60 * 1000 + 30 * 60 * 1000; // 2h 30m
      expect(formatTimeUntilReset(twoHours)).toBe('2h 30m');
    });

    it('should format minutes and seconds', () => {
      const fiveMinutes = 5 * 60 * 1000 + 45 * 1000; // 5m 45s
      expect(formatTimeUntilReset(fiveMinutes)).toBe('5m 45s');
    });

    it('should format seconds only', () => {
      const thirtySeconds = 30 * 1000;
      expect(formatTimeUntilReset(thirtySeconds)).toBe('30s');
    });

    it('should return "now" for zero or negative', () => {
      expect(formatTimeUntilReset(0)).toBe('now');
      expect(formatTimeUntilReset(-1000)).toBe('now');
    });
  });

  describe('formatRateLimitStatus', () => {
    it('should format not limited status', () => {
      const status: RateLimitStatus = {
        fiveHourLimited: false,
        weeklyLimited: false,
        isLimited: false,
        fiveHourResetsAt: null,
        weeklyResetsAt: null,
        nextResetAt: null,
        timeUntilResetMs: null,
        lastCheckedAt: new Date(),
      };

      expect(formatRateLimitStatus(status)).toBe('Not rate limited');
    });

    it('should format 5-hour limit', () => {
      const status: RateLimitStatus = {
        fiveHourLimited: true,
        weeklyLimited: false,
        isLimited: true,
        fiveHourResetsAt: new Date(),
        weeklyResetsAt: null,
        nextResetAt: new Date(),
        timeUntilResetMs: 3600000, // 1 hour
        lastCheckedAt: new Date(),
      };

      const result = formatRateLimitStatus(status);
      expect(result).toContain('5-hour limit reached');
      expect(result).toContain('1h 0m');
    });

    it('should format weekly limit', () => {
      const status: RateLimitStatus = {
        fiveHourLimited: false,
        weeklyLimited: true,
        isLimited: true,
        fiveHourResetsAt: null,
        weeklyResetsAt: new Date(),
        nextResetAt: new Date(),
        timeUntilResetMs: 86400000, // 1 day
        lastCheckedAt: new Date(),
      };

      const result = formatRateLimitStatus(status);
      expect(result).toContain('Weekly limit reached');
      expect(result).toContain('24h 0m');
    });

    it('should format both limits', () => {
      const status: RateLimitStatus = {
        fiveHourLimited: true,
        weeklyLimited: true,
        isLimited: true,
        fiveHourResetsAt: new Date(),
        weeklyResetsAt: new Date(),
        nextResetAt: new Date(),
        timeUntilResetMs: 3600000,
        lastCheckedAt: new Date(),
      };

      const result = formatRateLimitStatus(status);
      expect(result).toContain('5-hour limit reached');
      expect(result).toContain('Weekly limit reached');
    });
  });
});
