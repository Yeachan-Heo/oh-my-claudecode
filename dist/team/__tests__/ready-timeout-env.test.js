import { describe, expect, it } from 'vitest';
import { resolveWorkerReadyTimeoutMs } from '../scaling.js';
import { describeStartupReadyTimeout, parseReadyTimeoutMs, resolveStartupReadyTimeoutMs, } from '../ready-timeout.js';
describe('resolveWorkerReadyTimeoutMs', () => {
    it('reads a plain timeout at or above the 5000ms floor', () => {
        expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: '60000' })).toBe(60_000);
    });
    it('keeps the 45000ms default when the value is below the floor', () => {
        expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: '1000' })).toBe(45_000);
    });
    it.each(['0', '-60000', 'not-a-number', '1.5', ' ', '9007199254740992'])('keeps the default for invalid, below-floor, or unsafe value %j', (raw) => {
        expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: raw })).toBe(45_000);
    });
    it('trims surrounding whitespace around an integer value', () => {
        expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: ' 60000 ' })).toBe(60_000);
    });
    it('reads a scientific integer instead of stopping at the exponent', () => {
        expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: '5000e2' })).toBe(500_000);
    });
    it('ignores trailing junk instead of keeping a prefix that clears the floor', () => {
        expect(resolveWorkerReadyTimeoutMs({ OMC_TEAM_READY_TIMEOUT_MS: '20000x' })).toBe(45_000);
    });
});
describe('startup readiness wait from OMC_TEAM_READY_TIMEOUT_MS', () => {
    const env = (raw) => raw === undefined ? {} : { OMC_TEAM_READY_TIMEOUT_MS: raw };
    it.each([
        [undefined, undefined, 30_000],
        ['', undefined, 30_000],
        ['abc', undefined, 30_000],
        ['1.5', undefined, 30_000],
        ['NaN', undefined, 30_000],
        ['Infinity', undefined, 30_000],
        ['4999', 4_999, 30_000],
        ['5000', 5_000, 30_000],
        ['29999', 29_999, 30_000],
        ['30000', 30_000, 30_000],
        [' 60000 ', 60_000, 60_000],
        ['60000', 60_000, 60_000],
        ['120000', 120_000, 120_000],
        ['120001', 120_001, 120_000],
        ['600000', 600_000, 120_000],
    ])('reads %j as %j and waits %i ms at startup', (raw, parsed, waitMs) => {
        expect(parseReadyTimeoutMs(env(raw))).toBe(parsed);
        expect(resolveStartupReadyTimeoutMs(env(raw))).toBe(waitMs);
    });
    it('names the variable, the set value, and the wait the caller used', () => {
        expect(describeStartupReadyTimeout(env('5000'), 30_000)).toBe('OMC_TEAM_READY_TIMEOUT_MS=5000 (effective 30000ms; startup wait is clamped to 30000..120000ms)');
        expect(describeStartupReadyTimeout(env('600000'), 120_000)).toContain('=600000 (effective 120000ms;');
        expect(describeStartupReadyTimeout(env(undefined), 50)).toContain('OMC_TEAM_READY_TIMEOUT_MS unset (effective 50ms;');
    });
    it.each([
        ['a newline', '6\n0000', '"6\\n0000"'],
        ['a C1 CSI', '6\u009b0000', '"6\\u009b0000"'],
        ['DEL', '6\u007f0000', '"6\\u007f0000"'],
        ['a line separator', '6\u20280000', '"6\\u20280000"'],
        ['a paragraph separator', '6\u20290000', '"6\\u20290000"'],
        ['a right-to-left override', '6\u202e0000', '"6\\u202e0000"'],
        ['a right-to-left isolate', '6\u20670000', '"6\\u20670000"'],
        ['a right-to-left mark', '6\u200f0000', '"6\\u200f0000"'],
        ['an Arabic letter mark', '6\u061c0000', '"6\\u061c0000"'],
    ])('shows %s in the value as a visible escape', (_label, raw, shown) => {
        const note = describeStartupReadyTimeout(env(raw), 30_000);
        expect(note).toContain(`OMC_TEAM_READY_TIMEOUT_MS=${shown} (effective 30000ms;`);
        expect(note).toMatch(/^[\x20-\x7e]+$/);
    });
    it('leaves no raw bidi control, C0, C1, DEL or line separator in the note', () => {
        const unsafe = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
            .filter(char => /[\p{Bidi_Control}\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(char));
        expect(unsafe).toContain('\u061c');
        for (const char of unsafe) {
            const note = describeStartupReadyTimeout(env(`a${char}b`), 30_000);
            expect(note, `U+${char.charCodeAt(0).toString(16).padStart(4, '0')}`).not.toMatch(/\p{Bidi_Control}/u);
            expect(note).toMatch(/^[\x20-\x7e]+$/);
        }
    });
    it('marks a long value as truncated with its full length', () => {
        const raw = `${'0'.repeat(32)}60000`;
        expect(describeStartupReadyTimeout(env(raw), 60_000)).toBe(`OMC_TEAM_READY_TIMEOUT_MS="${'0'.repeat(32)}"... (truncated, 37 chars) ` +
            '(effective 60000ms; startup wait is clamped to 30000..120000ms)');
    });
});
//# sourceMappingURL=ready-timeout-env.test.js.map