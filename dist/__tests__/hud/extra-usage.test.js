/**
 * Tests for extra usage (metered spend) data parsing and rendering.
 * Covers issue #2570: display $spent/$limit in HUD.
 */
import { describe, it, expect } from 'vitest';
import { parseUsageResponse } from '../../hud/usage-api.js';
import { renderRateLimits, renderRateLimitsCompact, renderRateLimitsWithBar, } from '../../hud/elements/limits.js';
// ---------------------------------------------------------------------------
// parseUsageResponse — extra_usage parsing
// ---------------------------------------------------------------------------
describe('parseUsageResponse — extra_usage', () => {
    it('ignores extra_usage when limit_usd is absent', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { spent_usd: 3.1 },
        });
        expect(result).not.toBeNull();
        expect(result.extraUsagePercent).toBeUndefined();
        expect(result.extraUsageSpentUsd).toBeUndefined();
        expect(result.extraUsageLimitUsd).toBeUndefined();
    });
    it('ignores extra_usage when limit_usd is zero', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { spent_usd: 0, limit_usd: 0 },
        });
        expect(result).not.toBeNull();
        expect(result.extraUsagePercent).toBeUndefined();
    });
    it('parses extra_usage with API-provided utilization', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { utilization: 18, spent_usd: 3.1, limit_usd: 17.0 },
        });
        expect(result).not.toBeNull();
        expect(result.extraUsagePercent).toBe(18);
        expect(result.extraUsageSpentUsd).toBeCloseTo(3.1);
        expect(result.extraUsageLimitUsd).toBeCloseTo(17.0);
        expect(result.extraUsageResetsAt).toBeNull();
    });
    it('derives utilization from spent/limit when API utilization is absent', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { spent_usd: 5, limit_usd: 20 },
        });
        expect(result).not.toBeNull();
        // 5/20 = 25%
        expect(result.extraUsagePercent).toBe(25);
    });
    it('clamps utilization above 100 to 100', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { utilization: 150, spent_usd: 20, limit_usd: 17 },
        });
        expect(result.extraUsagePercent).toBe(100);
    });
    it('clamps negative utilization to 0', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { utilization: -5, spent_usd: 0, limit_usd: 17 },
        });
        expect(result.extraUsagePercent).toBe(0);
    });
    it('parses resets_at as a Date when present', () => {
        const resetIso = '2026-05-01T00:00:00Z';
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { spent_usd: 3.1, limit_usd: 17, resets_at: resetIso },
        });
        expect(result.extraUsageResetsAt).toBeInstanceOf(Date);
        expect(result.extraUsageResetsAt.getTime()).toBe(new Date(resetIso).getTime());
    });
    it('treats invalid resets_at as null', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { spent_usd: 3.1, limit_usd: 17, resets_at: 'not-a-date' },
        });
        expect(result.extraUsageResetsAt).toBeNull();
    });
    it('defaults spent_usd to 0 when absent', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: { limit_usd: 17 },
        });
        expect(result.extraUsageSpentUsd).toBe(0);
        expect(result.extraUsagePercent).toBe(0);
    });
    it('parses Max organization overage used_credits as extra usage without enterprise fields', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 3 },
            seven_day: { utilization: 16 },
            seven_day_sonnet: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 2726,
                monthly_limit: 5000,
                currency: 'USD',
            },
        }, {
            subscriptionType: 'max',
            rateLimitTier: 'default_claude_max_20x',
        });
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(3);
        expect(result.weeklyPercent).toBe(16);
        expect(result.sonnetWeeklyPercent).toBe(0);
        expect(result.extraUsageSpentUsd).toBeCloseTo(27.26, 2);
        expect(result.extraUsageLimitUsd).toBeCloseTo(50, 2);
        expect(result.extraUsagePercent).toBeCloseTo(54.52, 2);
        expect(result.enterpriseSpentUsd).toBeUndefined();
        expect(result.enterpriseLimitUsd).toBeUndefined();
        expect(result.enterpriseUtilization).toBeUndefined();
    });
    it('uses API utilization for non-enterprise used_credits overage when present', () => {
        const result = parseUsageResponse({
            five_hour: { utilization: 10 },
            extra_usage: {
                used_credits: 1000,
                monthly_limit: 5000,
                utilization: 30,
                currency: 'USD',
            },
        }, { subscriptionType: 'pro', rateLimitTier: 'default' });
        expect(result).not.toBeNull();
        expect(result.extraUsagePercent).toBe(30);
        expect(result.extraUsageSpentUsd).toBeCloseTo(10, 2);
        expect(result.extraUsageLimitUsd).toBeCloseTo(50, 2);
        expect(result.enterpriseSpentUsd).toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// renderRateLimits — extra usage display
// ---------------------------------------------------------------------------
describe('renderRateLimits — extra usage', () => {
    const base = { fiveHourPercent: 10 };
    it('omits extra section when extraUsagePercent is absent', () => {
        const result = renderRateLimits(base);
        expect(result).not.toContain('extra:');
    });
    it('omits extra section when extraUsageLimitUsd is absent', () => {
        const limits = { ...base, extraUsagePercent: 18 };
        const result = renderRateLimits(limits);
        expect(result).not.toContain('extra:');
    });
    it('renders extra usage with dollar amounts', () => {
        const limits = {
            ...base,
            extraUsagePercent: 18,
            extraUsageSpentUsd: 3.10,
            extraUsageLimitUsd: 17.00,
        };
        const result = renderRateLimits(limits);
        expect(result).toContain('extra:');
        expect(result).toContain('18%');
        expect(result).toContain('$3.10');
        expect(result).toContain('$17.00');
    });
    it('renders 0% extra usage with correct dollar amounts', () => {
        const limits = {
            ...base,
            extraUsagePercent: 0,
            extraUsageSpentUsd: 0,
            extraUsageLimitUsd: 17.00,
        };
        const result = renderRateLimits(limits);
        expect(result).toContain('extra:');
        expect(result).toContain('0%');
        expect(result).toContain('$0.00');
        expect(result).toContain('$17.00');
    });
    it('defaults spent to $0.00 when extraUsageSpentUsd is absent', () => {
        const limits = {
            ...base,
            extraUsagePercent: 5,
            extraUsageLimitUsd: 10,
        };
        const result = renderRateLimits(limits);
        expect(result).toContain('$0.00');
        expect(result).toContain('$10.00');
    });
    it('uses red color at >= 90%', () => {
        const limits = {
            ...base,
            extraUsagePercent: 95,
            extraUsageSpentUsd: 16,
            extraUsageLimitUsd: 17,
        };
        const result = renderRateLimits(limits);
        // Red ANSI code before the percentage
        expect(result).toContain('\x1b[31m');
    });
    it('uses green color at < 70%', () => {
        const limits = {
            ...base,
            extraUsagePercent: 18,
            extraUsageSpentUsd: 3.1,
            extraUsageLimitUsd: 17,
        };
        const result = renderRateLimits(limits);
        // Green ANSI code before the extra percentage
        const extraIndex = result.indexOf('extra:');
        const afterExtra = result.slice(extraIndex);
        expect(afterExtra).toContain('\x1b[32m');
    });
    it('renders stale marker when stale=true', () => {
        const limits = {
            ...base,
            extraUsagePercent: 18,
            extraUsageSpentUsd: 3.1,
            extraUsageLimitUsd: 17,
        };
        const result = renderRateLimits(limits, true);
        expect(result).toContain('*');
    });
});
// ---------------------------------------------------------------------------
// renderRateLimitsCompact — extra usage
// ---------------------------------------------------------------------------
describe('renderRateLimitsCompact — extra usage', () => {
    it('omits extra from compact when absent', () => {
        const limits = { fiveHourPercent: 10 };
        const result = renderRateLimitsCompact(limits);
        // only one percentage in output
        expect(result).not.toBeNull();
        expect((result.match(/%/g) ?? []).length).toBe(1);
    });
    it('appends extra percentage in compact when present', () => {
        const limits = {
            fiveHourPercent: 10,
            extraUsagePercent: 18,
            extraUsageLimitUsd: 17,
        };
        const result = renderRateLimitsCompact(limits);
        expect(result).not.toBeNull();
        // Should contain 18% somewhere
        expect(result).toContain('18%');
    });
});
// ---------------------------------------------------------------------------
// renderRateLimitsWithBar — extra usage
// ---------------------------------------------------------------------------
describe('renderRateLimitsWithBar — extra usage', () => {
    it('omits extra bar when absent', () => {
        const limits = { fiveHourPercent: 10 };
        const result = renderRateLimitsWithBar(limits);
        expect(result).not.toContain('extra:');
    });
    it('renders extra bar with dollar amounts', () => {
        const limits = {
            fiveHourPercent: 10,
            extraUsagePercent: 18,
            extraUsageSpentUsd: 3.10,
            extraUsageLimitUsd: 17.00,
        };
        const result = renderRateLimitsWithBar(limits);
        expect(result).toContain('extra:');
        expect(result).toContain('18%');
        expect(result).toContain('$3.10');
        expect(result).toContain('$17.00');
        // Bar characters present
        expect(result).toMatch(/[█░]/);
    });
});
//# sourceMappingURL=extra-usage.test.js.map