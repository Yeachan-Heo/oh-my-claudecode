/**
 * Tests for rate-limit-monitor.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRateLimitStatus, formatTimeUntilReset, formatRateLimitStatus, } from '../../features/rate-limit-wait/rate-limit-monitor.js';
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
        it('should return null when getUsage returns null rateLimits', async () => {
            vi.mocked(getUsage).mockResolvedValue({ rateLimits: null, error: 'no_credentials' });
            const result = await checkRateLimitStatus();
            expect(result).toBeNull();
        });
        it('should detect 5-hour rate limit', async () => {
            const resetTime = new Date(Date.now() + 3600000); // 1 hour from now
            vi.mocked(getUsage).mockResolvedValue({
                rateLimits: {
                    fiveHourPercent: 100,
                    weeklyPercent: 50,
                    fiveHourResetsAt: resetTime,
                    weeklyResetsAt: null,
                    monthlyPercent: 0,
                    monthlyResetsAt: null,
                },
            });
            const result = await checkRateLimitStatus();
            expect(result).not.toBeNull();
            expect(result.fiveHourLimited).toBe(true);
            expect(result.weeklyLimited).toBe(false);
            expect(result.isLimited).toBe(true);
            expect(result.nextResetAt).toEqual(resetTime);
        });
        it('should detect weekly rate limit', async () => {
            const resetTime = new Date(Date.now() + 86400000); // 1 day from now
            vi.mocked(getUsage).mockResolvedValue({
                rateLimits: {
                    fiveHourPercent: 50,
                    weeklyPercent: 100,
                    fiveHourResetsAt: null,
                    weeklyResetsAt: resetTime,
                    monthlyPercent: 0,
                    monthlyResetsAt: null,
                },
            });
            const result = await checkRateLimitStatus();
            expect(result).not.toBeNull();
            expect(result.fiveHourLimited).toBe(false);
            expect(result.weeklyLimited).toBe(true);
            expect(result.isLimited).toBe(true);
            expect(result.nextResetAt).toEqual(resetTime);
        });
        it('should detect both limits and return earliest reset', async () => {
            const fiveHourReset = new Date(Date.now() + 3600000); // 1 hour
            const weeklyReset = new Date(Date.now() + 86400000); // 1 day
            vi.mocked(getUsage).mockResolvedValue({
                rateLimits: {
                    fiveHourPercent: 100,
                    weeklyPercent: 100,
                    fiveHourResetsAt: fiveHourReset,
                    weeklyResetsAt: weeklyReset,
                    monthlyPercent: 0,
                    monthlyResetsAt: null,
                },
            });
            const result = await checkRateLimitStatus();
            expect(result).not.toBeNull();
            expect(result.fiveHourLimited).toBe(true);
            expect(result.weeklyLimited).toBe(true);
            expect(result.isLimited).toBe(true);
            expect(result.nextResetAt).toEqual(fiveHourReset); // Earlier reset
        });
        it('should return not limited when under thresholds', async () => {
            vi.mocked(getUsage).mockResolvedValue({
                rateLimits: {
                    fiveHourPercent: 50,
                    weeklyPercent: 75,
                    fiveHourResetsAt: null,
                    weeklyResetsAt: null,
                    monthlyPercent: 0,
                    monthlyResetsAt: null,
                },
            });
            const result = await checkRateLimitStatus();
            expect(result).not.toBeNull();
            expect(result.fiveHourLimited).toBe(false);
            expect(result.weeklyLimited).toBe(false);
            expect(result.isLimited).toBe(false);
            expect(result.nextResetAt).toBeNull();
            expect(result.timeUntilResetMs).toBeNull();
        });
        it('should surface stale-cache 429 state without claiming a clean all-clear', async () => {
            vi.mocked(getUsage).mockResolvedValue({
                rateLimits: {
                    fiveHourPercent: 83,
                    weeklyPercent: 57,
                    fiveHourResetsAt: new Date('2026-03-08T05:00:00.000Z'),
                    weeklyResetsAt: new Date('2026-03-13T05:00:00.000Z'),
                    monthlyPercent: 0,
                    monthlyResetsAt: null,
                },
                error: 'rate_limited',
            });
            const result = await checkRateLimitStatus();
            expect(result).not.toBeNull();
            expect(result.isLimited).toBe(false);
            expect(result.apiErrorReason).toBe('rate_limited');
            expect(result.usingStaleData).toBe(true);
            expect(formatRateLimitStatus(result)).toContain('stale cached usage');
            expect(formatRateLimitStatus(result)).not.toBe('Not rate limited');
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
            const status = {
                fiveHourLimited: false,
                weeklyLimited: false,
                isLimited: false,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
                monthlyLimited: false,
                monthlyResetsAt: null,
                nextResetAt: null,
                timeUntilResetMs: null,
                lastCheckedAt: new Date(),
            };
            expect(formatRateLimitStatus(status)).toBe('Not rate limited');
        });
        it('should format 5-hour limit', () => {
            const status = {
                fiveHourLimited: true,
                weeklyLimited: false,
                isLimited: true,
                fiveHourResetsAt: new Date(),
                weeklyResetsAt: null,
                monthlyLimited: false,
                monthlyResetsAt: null,
                nextResetAt: new Date(),
                timeUntilResetMs: 3600000, // 1 hour
                lastCheckedAt: new Date(),
            };
            const result = formatRateLimitStatus(status);
            expect(result).toContain('5-hour limit reached');
            expect(result).toContain('1h 0m');
        });
        it('should format weekly limit', () => {
            const status = {
                fiveHourLimited: false,
                weeklyLimited: true,
                isLimited: true,
                fiveHourResetsAt: null,
                weeklyResetsAt: new Date(),
                monthlyLimited: false,
                monthlyResetsAt: null,
                nextResetAt: new Date(),
                timeUntilResetMs: 86400000, // 1 day
                lastCheckedAt: new Date(),
            };
            const result = formatRateLimitStatus(status);
            expect(result).toContain('Weekly limit reached');
            expect(result).toContain('24h 0m');
        });
        it('should format degraded stale-cache 429 status', () => {
            const status = {
                fiveHourLimited: false,
                weeklyLimited: false,
                isLimited: false,
                fiveHourResetsAt: new Date(),
                weeklyResetsAt: new Date(),
                monthlyLimited: false,
                monthlyResetsAt: null,
                nextResetAt: null,
                timeUntilResetMs: null,
                fiveHourPercent: 83,
                weeklyPercent: 57,
                apiErrorReason: 'rate_limited',
                usingStaleData: true,
                lastCheckedAt: new Date(),
            };
            const result = formatRateLimitStatus(status);
            expect(result).toContain('Usage API rate limited');
            expect(result).toContain('5-hour 83%');
            expect(result).toContain('weekly 57%');
        });
        it('should format both limits', () => {
            const status = {
                fiveHourLimited: true,
                weeklyLimited: true,
                isLimited: true,
                fiveHourResetsAt: new Date(),
                weeklyResetsAt: new Date(),
                monthlyLimited: false,
                monthlyResetsAt: null,
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
//# sourceMappingURL=rate-limit-monitor.test.js.map