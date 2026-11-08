/**
 * Tests for stale data indicator in rate limits display.
 *
 * When usage data is stale (429 rate limited or lock contention),
 * percentages should show DIM + asterisk (*) marker.
 * After 15 minutes, stale data should be discarded → [API 429].
 */
import { describe, it, expect } from 'vitest';
import { renderRateLimits, renderRateLimitsCompact, renderRateLimitsWithBar } from '../../hud/elements/limits.js';
const DIM = '\x1b[2m';
describe('stale indicator: renderRateLimits', () => {
    it('shows asterisk marker when stale=true', () => {
        const result = renderRateLimits({ fiveHourPercent: 11, weeklyPercent: 45 }, true);
        expect(result).not.toBeNull();
        expect(result).toContain('*');
    });
    it('does not show asterisk when stale=false', () => {
        const result = renderRateLimits({ fiveHourPercent: 11, weeklyPercent: 45 }, false);
        expect(result).not.toBeNull();
        expect(result).not.toContain('*');
    });
    it('does not show asterisk when stale is undefined', () => {
        const result = renderRateLimits({ fiveHourPercent: 11, weeklyPercent: 45 });
        expect(result).not.toBeNull();
        expect(result).not.toContain('*');
    });
    it('preserves color coding when stale (green for low usage)', () => {
        const result = renderRateLimits({ fiveHourPercent: 11 }, true);
        expect(result).not.toBeNull();
        // Green ANSI code should be present
        expect(result).toContain('\x1b[32m');
    });
    it('applies DIM to stale percentages', () => {
        const result = renderRateLimits({ fiveHourPercent: 11 }, true);
        expect(result).not.toBeNull();
        // DIM should be applied
        expect(result).toContain(DIM);
    });
    it('shows tilde on reset time when stale', () => {
        const futureDate = new Date(Date.now() + 3 * 3600_000 + 42 * 60_000);
        const result = renderRateLimits({ fiveHourPercent: 45, fiveHourResetsAt: futureDate }, true);
        expect(result).not.toBeNull();
        // Should show ~Xh prefix for stale reset time
        expect(result).toContain('~');
    });
    it('does not show tilde on reset time when fresh', () => {
        const futureDate = new Date(Date.now() + 3 * 3600_000 + 42 * 60_000);
        const result = renderRateLimits({ fiveHourPercent: 45, fiveHourResetsAt: futureDate }, false);
        expect(result).not.toBeNull();
        expect(result).not.toContain('~');
    });
});
describe('stale indicator: renderRateLimitsCompact', () => {
    it('shows group-level asterisk when stale', () => {
        const result = renderRateLimitsCompact({ fiveHourPercent: 45, weeklyPercent: 12 }, true);
        expect(result).not.toBeNull();
        expect(result).toContain('*');
        // Should have only one asterisk at the end (group marker)
        const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
        expect(stripped).toMatch(/\*$/);
    });
    it('does not show asterisk when fresh', () => {
        const result = renderRateLimitsCompact({ fiveHourPercent: 45, weeklyPercent: 12 });
        expect(result).not.toBeNull();
        const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
        expect(stripped).not.toContain('*');
    });
});
describe('stale indicator: renderRateLimitsWithBar', () => {
    it('shows asterisk marker when stale', () => {
        const result = renderRateLimitsWithBar({ fiveHourPercent: 45, weeklyPercent: 12 }, 8, true);
        expect(result).not.toBeNull();
        expect(result).toContain('*');
    });
    it('does not show asterisk when fresh', () => {
        const result = renderRateLimitsWithBar({ fiveHourPercent: 45, weeklyPercent: 12 }, 8, false);
        expect(result).not.toBeNull();
        expect(result).not.toContain('*');
    });
});
//# sourceMappingURL=stale-indicator.test.js.map