/**
 * Tests for rate limits error indicator (Issue #1253)
 */
import { describe, it, expect } from 'vitest';
import { renderRateLimitsError, renderApiKeyUsageHint } from '../../hud/elements/limits.js';
describe('renderRateLimitsError', () => {
    it('returns null when result is null', () => {
        const result = renderRateLimitsError(null);
        expect(result).toBeNull();
    });
    it('returns null when result has no error', () => {
        const usageResult = {
            rateLimits: {
                fiveHourPercent: 50,
                weeklyPercent: 30,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
            },
        };
        const result = renderRateLimitsError(usageResult);
        expect(result).toBeNull();
    });
    it('returns null when rateLimits is null but no error', () => {
        const usageResult = {
            rateLimits: null,
        };
        const result = renderRateLimitsError(usageResult);
        expect(result).toBeNull();
    });
    it('returns [API err] in yellow when network error', () => {
        const usageResult = {
            rateLimits: null,
            error: 'network',
        };
        const result = renderRateLimitsError(usageResult);
        expect(result).toContain('[API err]');
        expect(result).toContain('\x1b[33m'); // Yellow ANSI code
    });
    it('returns [API err] in yellow when timeout error', () => {
        const usageResult = {
            rateLimits: null,
            error: 'timeout',
        };
        const result = renderRateLimitsError(usageResult);
        expect(result).toContain('[API err]');
        expect(result).toContain('\x1b[33m'); // Yellow ANSI code
    });
    it('returns [API err] in yellow when http error', () => {
        const usageResult = {
            rateLimits: null,
            error: 'http',
        };
        const result = renderRateLimitsError(usageResult);
        expect(result).toContain('[API err]');
        expect(result).toContain('\x1b[33m'); // Yellow ANSI code
    });
    it('includes reset code in output', () => {
        const usageResult = {
            rateLimits: null,
            error: 'network',
        };
        const result = renderRateLimitsError(usageResult);
        expect(result).toContain('\x1b[0m'); // Reset ANSI code
    });
    it('returns dimmed [API 429] for rate_limited error', () => {
        const usageResult = {
            rateLimits: null,
            error: 'rate_limited',
        };
        const result = renderRateLimitsError(usageResult);
        expect(result).toContain('[API 429]');
        expect(result).toContain('\x1b[2m'); // Dim ANSI code
        expect(result).not.toContain('\x1b[33m'); // Not yellow
    });
    it('returns null for rate_limited error when stale rate limit data is available', () => {
        const usageResult = {
            rateLimits: {
                fiveHourPercent: 50,
                weeklyPercent: 30,
                fiveHourResetsAt: null,
                weeklyResetsAt: null,
            },
            error: 'rate_limited',
        };
        const result = renderRateLimitsError(usageResult);
        expect(result).toBeNull();
    });
});
describe('renderApiKeyUsageHint (Issue #3277)', () => {
    const noCreds = { rateLimits: null, error: 'no_credentials' };
    it('shows a custom-provider hint for API-key users with no built-in usage', () => {
        const result = renderApiKeyUsageHint(noCreds, true, false);
        expect(result).toContain('omcHud.rateLimitsProvider');
        expect(result).toContain('\x1b[2m'); // Dim ANSI code (unobtrusive)
    });
    it('returns null when not in API-key mode (OAuth users unaffected)', () => {
        expect(renderApiKeyUsageHint(noCreds, false, false)).toBeNull();
    });
    it('returns null when a custom rate limits provider is already configured', () => {
        expect(renderApiKeyUsageHint(noCreds, true, true)).toBeNull();
    });
    it('returns null when the error is not no_credentials', () => {
        expect(renderApiKeyUsageHint({ rateLimits: null, error: 'network' }, true, false)).toBeNull();
        expect(renderApiKeyUsageHint({ rateLimits: null, error: 'auth' }, true, false)).toBeNull();
    });
    it('returns null when usage data is present (no error)', () => {
        const ok = { rateLimits: { fiveHourPercent: 10, weeklyPercent: 5 } };
        expect(renderApiKeyUsageHint(ok, true, false)).toBeNull();
    });
    it('returns null when result is null', () => {
        expect(renderApiKeyUsageHint(null, true, false)).toBeNull();
    });
});
//# sourceMappingURL=rate-limits-error.test.js.map