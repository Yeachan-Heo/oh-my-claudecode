import { beforeEach, describe, expect, it } from 'vitest';
import { getStableContextDisplayPercent, renderContext, renderContextWithBar, resetContextDisplayState, } from '../../hud/elements/context.js';
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const thresholds = {
    contextWarning: 70,
    contextCompactSuggestion: 80,
    contextCritical: 85,
    ralphWarning: 7,
};
function stripAnsi(value) {
    return value.replace(ANSI_REGEX, '');
}
describe('HUD context display smoothing', () => {
    beforeEach(() => {
        resetContextDisplayState();
    });
    it('suppresses nearby ctx jitter in the plain display', () => {
        expect(stripAnsi(renderContext(54, thresholds, 'session-a') ?? '')).toBe('ctx:54%');
        expect(stripAnsi(renderContext(52, thresholds, 'session-a') ?? '')).toBe('ctx:54%');
        expect(stripAnsi(renderContext(54, thresholds, 'session-a') ?? '')).toBe('ctx:54%');
    });
    it('updates when the context percentage changes materially', () => {
        expect(getStableContextDisplayPercent(54, thresholds, 'session-a')).toBe(54);
        expect(getStableContextDisplayPercent(50, thresholds, 'session-a')).toBe(50);
        expect(stripAnsi(renderContext(50, thresholds, 'session-a') ?? '')).toBe('ctx:50%');
    });
    it('updates immediately when a threshold bucket changes', () => {
        expect(stripAnsi(renderContext(79, thresholds, 'session-a') ?? '')).toBe('ctx:79%');
        expect(stripAnsi(renderContext(80, thresholds, 'session-a') ?? '')).toBe('ctx:80% COMPRESS?');
    });
    it('applies the same smoothing to the bar display', () => {
        expect(stripAnsi(renderContextWithBar(54, thresholds, 10, 'session-a') ?? '')).toContain('54%');
        expect(stripAnsi(renderContextWithBar(52, thresholds, 10, 'session-a') ?? '')).toContain('54%');
    });
    it('resets smoothing when the display scope changes', () => {
        expect(getStableContextDisplayPercent(54, thresholds, 'session-a')).toBe(54);
        expect(getStableContextDisplayPercent(52, thresholds, 'session-a')).toBe(54);
        expect(getStableContextDisplayPercent(52, thresholds, 'session-b')).toBe(52);
    });
    it('allows callers to reset cached display state', () => {
        expect(getStableContextDisplayPercent(54, thresholds, 'session-a')).toBe(54);
        expect(getStableContextDisplayPercent(52, thresholds, 'session-a')).toBe(54);
        resetContextDisplayState();
        expect(getStableContextDisplayPercent(52, thresholds, 'session-a')).toBe(52);
    });
});
//# sourceMappingURL=context.test.js.map