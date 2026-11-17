/**
 * Render tests for `scopedWeeklyBuckets` (issue #3576): unrecognized weekly_scoped
 * model buckets (e.g. "Fable") must render across all three rate-limit renderers.
 */
import { describe, it, expect } from 'vitest';
import { renderRateLimits, renderRateLimitsCompact, renderRateLimitsWithBar } from '../../hud/elements/limits.js';
function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
function baseLimits(overrides = {}) {
    return {
        fiveHourPercent: 12,
        weeklyPercent: 10,
        ...overrides,
    };
}
describe('scopedWeeklyBuckets rendering (#3576)', () => {
    it('renderRateLimits shows the generic bucket after sn/op with a reset time above threshold', () => {
        const limits = baseLimits({
            sonnetWeeklyPercent: 20,
            scopedWeeklyBuckets: [
                { id: 'fable', label: 'Fable', percent: 61, resetsAt: new Date(Date.now() + 3 * 3600_000), isActive: true },
            ],
        });
        const rendered = stripAnsi(renderRateLimits(limits, false));
        expect(rendered).toContain('sn:20%');
        expect(rendered).toMatch(/fable:61%\([0-9]+h[0-9]+m\)/);
    });
    it('renderRateLimits renders multiple generic buckets in order', () => {
        const limits = baseLimits({
            scopedWeeklyBuckets: [
                { id: 'fable', label: 'Fable', percent: 61, resetsAt: null, isActive: true },
                { id: 'nova', label: 'Nova', percent: 5, resetsAt: null, isActive: false },
            ],
        });
        const rendered = stripAnsi(renderRateLimits(limits, false));
        const fableIdx = rendered.indexOf('fable:61%');
        const novaIdx = rendered.indexOf('nova:5%');
        expect(fableIdx).toBeGreaterThan(-1);
        expect(novaIdx).toBeGreaterThan(fableIdx);
    });
    it('renderRateLimits omits the section entirely when scopedWeeklyBuckets is absent (no regression)', () => {
        const limits = baseLimits();
        const rendered = stripAnsi(renderRateLimits(limits, false));
        expect(rendered).not.toContain(':undefined%');
        expect(rendered).toBe('5h:12% wk:10%');
    });
    it('renderRateLimitsCompact appends generic bucket percentages', () => {
        const limits = baseLimits({
            sonnetWeeklyPercent: 20,
            scopedWeeklyBuckets: [
                { id: 'fable', label: 'Fable', percent: 61, resetsAt: null, isActive: true },
            ],
        });
        const rendered = stripAnsi(renderRateLimitsCompact(limits, false));
        expect(rendered).toBe('12%/10%/20%/61%');
    });
    it('renderRateLimitsWithBar draws a bar for the generic bucket', () => {
        const limits = baseLimits({
            scopedWeeklyBuckets: [
                { id: 'fable', label: 'Fable', percent: 50, resetsAt: null, isActive: true },
            ],
        });
        const rendered = stripAnsi(renderRateLimitsWithBar(limits, 8, false));
        expect(rendered).toContain('fable:[');
        expect(rendered).toContain(']50%');
    });
    it('stale marker applies to generic buckets like other buckets', () => {
        const limits = baseLimits({
            scopedWeeklyBuckets: [
                { id: 'fable', label: 'Fable', percent: 61, resetsAt: null, isActive: true },
            ],
        });
        const rendered = stripAnsi(renderRateLimits(limits, true));
        expect(rendered).toContain('fable:61%*');
    });
});
//# sourceMappingURL=scoped-weekly-buckets-render.test.js.map