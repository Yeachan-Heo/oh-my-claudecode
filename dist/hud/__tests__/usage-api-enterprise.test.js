/**
 * Tests for parseUsageResponse with enterprise extra_usage payload
 */
import { describe, it, expect } from 'vitest';
import { parseUsageResponse } from '../usage-api.js';
describe('parseUsageResponse - enterprise extra_usage', () => {
    const baseResponse = {
        five_hour: null,
        seven_day: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
    };
    it('parses used_credits as enterpriseSpentUsd (÷100)', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 333391,
                monthly_limit: null,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response);
        expect(result).not.toBeNull();
        expect(result.enterpriseSpentUsd).toBeCloseTo(3333.91, 2);
    });
    it('keeps used_credits as enterprise cost when subscription metadata is unknown', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 333391,
                monthly_limit: null,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response, {
            subscriptionType: null,
            rateLimitTier: null,
        });
        expect(result).not.toBeNull();
        expect(result.enterpriseSpentUsd).toBeCloseTo(3333.91, 2);
        expect(result.enterpriseLimitUsd).toBeNull();
        expect(result.extraUsageSpentUsd).toBeUndefined();
    });
    it('keeps used_credits as enterprise cost for explicit enterprise subscriptions', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 333391,
                monthly_limit: 500000,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response, {
            subscriptionType: 'enterprise',
            rateLimitTier: 'default_claude_zero',
        });
        expect(result).not.toBeNull();
        expect(result.enterpriseSpentUsd).toBeCloseTo(3333.91, 2);
        expect(result.enterpriseLimitUsd).toBeCloseTo(5000, 2);
        expect(result.enterpriseUtilization).toBeCloseTo(66.6782, 4);
        expect(result.extraUsageSpentUsd).toBeUndefined();
        expect(result.extraUsageLimitUsd).toBeUndefined();
    });
    it('sets enterpriseLimitUsd to null when monthly_limit is null', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 333391,
                monthly_limit: null,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response);
        expect(result.enterpriseLimitUsd).toBeNull();
    });
    it('does NOT set extraUsageSpentUsd from enterprise payload', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 333391,
                monthly_limit: null,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response);
        expect(result.extraUsageSpentUsd).toBeUndefined();
        expect(result.extraUsageLimitUsd).toBeUndefined();
    });
    it('sets enterpriseCurrency from API response', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 50000,
                monthly_limit: null,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response);
        expect(result.enterpriseCurrency).toBe('USD');
    });
    it('defaults enterpriseCurrency to USD when currency is absent', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 50000,
                monthly_limit: null,
            },
        };
        const result = parseUsageResponse(response);
        expect(result.enterpriseCurrency).toBe('USD');
    });
    it('computes enterpriseUtilization when monthly_limit is positive', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 5000,
                monthly_limit: 10000,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response);
        expect(result.enterpriseSpentUsd).toBeCloseTo(50, 2);
        expect(result.enterpriseLimitUsd).toBeCloseTo(100, 2);
        expect(result.enterpriseUtilization).toBeCloseTo(50, 1);
    });
    it('does NOT set enterpriseUtilization when monthly_limit is null', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 0 },
            extra_usage: {
                is_enabled: true,
                used_credits: 333391,
                monthly_limit: null,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response);
        expect(result.enterpriseUtilization).toBeUndefined();
    });
    it('returns non-null when only used_credits is present (five_hour/seven_day both null)', () => {
        // Regression: early-return at parseUsageResponse used to reject this payload,
        // dropping enterprise data entirely. This is the actual Enterprise API response shape.
        const response = {
            five_hour: null,
            seven_day: null,
            seven_day_opus: null,
            seven_day_sonnet: null,
            extra_usage: {
                is_enabled: true,
                used_credits: 333391,
                monthly_limit: null,
                currency: 'USD',
            },
        };
        const result = parseUsageResponse(response);
        expect(result).not.toBeNull();
        expect(result.enterpriseSpentUsd).toBeCloseTo(3333.91, 2);
    });
    it('refuses to populate enterprise fields for non-USD currency (JPY)', () => {
        // JPY is a zero-digit minor-unit currency per ISO 4217 — 1 JPY = 1 unit (not /100).
        // Dividing by 100 would be 100x off, so we skip rather than guess.
        const response = {
            five_hour: null,
            seven_day: null,
            extra_usage: {
                is_enabled: true,
                used_credits: 50000,
                monthly_limit: null,
                currency: 'JPY',
            },
        };
        const result = parseUsageResponse(response);
        // No other usable data + rejected enterprise credits → null
        expect(result).toBeNull();
    });
    it('ignores non-USD enterprise credits but still emits rate limits when 5h is present', () => {
        const response = {
            five_hour: { utilization: 45 },
            seven_day: null,
            extra_usage: {
                is_enabled: true,
                used_credits: 50000,
                monthly_limit: null,
                currency: 'KRW',
            },
        };
        const result = parseUsageResponse(response);
        expect(result).not.toBeNull();
        expect(result.fiveHourPercent).toBe(45);
        expect(result.enterpriseSpentUsd).toBeUndefined();
        expect(result.enterpriseCurrency).toBeUndefined();
    });
    it('accepts currency case-insensitively (usd / Usd / USD)', () => {
        for (const currency of ['usd', 'Usd', 'USD']) {
            const result = parseUsageResponse({
                five_hour: null,
                seven_day: null,
                extra_usage: {
                    is_enabled: true,
                    used_credits: 100000,
                    monthly_limit: null,
                    currency,
                },
            });
            expect(result, `currency=${currency}`).not.toBeNull();
            expect(result.enterpriseSpentUsd).toBeCloseTo(1000, 2);
            expect(result.enterpriseCurrency).toBe('USD');
        }
    });
    it('returns null when neither rate-limit buckets nor enterprise credits are present', () => {
        const response = {
            five_hour: null,
            seven_day: null,
        };
        expect(parseUsageResponse(response)).toBeNull();
    });
    it('still parses Pro metered path (spent_usd/limit_usd) without interference', () => {
        const response = {
            ...baseResponse,
            five_hour: { utilization: 45 },
            extra_usage: {
                spent_usd: 3.21,
                limit_usd: 50,
                utilization: 6.42,
            },
        };
        const result = parseUsageResponse(response);
        expect(result.extraUsageSpentUsd).toBeCloseTo(3.21, 2);
        expect(result.extraUsageLimitUsd).toBeCloseTo(50, 2);
        expect(result.enterpriseSpentUsd).toBeUndefined();
    });
});
//# sourceMappingURL=usage-api-enterprise.test.js.map