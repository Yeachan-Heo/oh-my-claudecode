import { describe, it, expect } from 'vitest';
import { truncateLineToMaxWidth } from '../../hud/render.js';
import { stringWidth } from '../../utils/string-width.js';
describe('truncateLineToMaxWidth', () => {
    describe('basic truncation', () => {
        it('returns line unchanged when within maxWidth', () => {
            const result = truncateLineToMaxWidth('short', 20);
            expect(result).toBe('short');
        });
        it('returns line unchanged when exactly at maxWidth', () => {
            const result = truncateLineToMaxWidth('12345', 5);
            expect(result).toBe('12345');
        });
        it('truncates with ellipsis when exceeding maxWidth', () => {
            const result = truncateLineToMaxWidth('this is a long line that exceeds the limit', 20);
            expect(result).toMatch(/\.\.\.$/);
            expect(stringWidth(result)).toBeLessThanOrEqual(20);
        });
        it('returns empty string for maxWidth of 0', () => {
            const result = truncateLineToMaxWidth('something', 0);
            expect(result).toBe('');
        });
        it('returns empty string for negative maxWidth', () => {
            const result = truncateLineToMaxWidth('something', -5);
            expect(result).toBe('');
        });
        it('handles empty string input', () => {
            const result = truncateLineToMaxWidth('', 20);
            expect(result).toBe('');
        });
    });
    describe('ANSI escape code handling', () => {
        it('preserves ANSI codes within truncated output', () => {
            const line = '\x1b[1m[OMC#4.5.0]\x1b[0m | rate: 45% | ctx: 30% | agents: 3 running';
            const result = truncateLineToMaxWidth(line, 30);
            expect(result).toContain('\x1b[1m');
            expect(result).toMatch(/\.\.\.$/);
        });
        it('does not count ANSI codes as visible width', () => {
            const withAnsi = '\x1b[32mhello\x1b[0m'; // "hello" in green
            const withoutAnsi = 'hello';
            expect(truncateLineToMaxWidth(withAnsi, 5)).toBe(withAnsi);
            expect(truncateLineToMaxWidth(withoutAnsi, 5)).toBe(withoutAnsi);
        });
        it('handles multiple ANSI sequences', () => {
            const line = '\x1b[1m[OMC]\x1b[0m \x1b[2m|\x1b[0m \x1b[33mrate: 45%\x1b[0m';
            const result = truncateLineToMaxWidth(line, 10);
            expect(result).toMatch(/\.\.\.$/);
        });
        it('appends ANSI reset before ellipsis to prevent style bleed', () => {
            // Open bold, content exceeds width, should get reset before "..."
            const line = '\x1b[33mthis is yellow text that is very long and will be truncated\x1b[0m';
            const result = truncateLineToMaxWidth(line, 20);
            // Should contain reset (\x1b[0m) before the ellipsis
            expect(result).toMatch(/\x1b\[0m\.\.\.$/);
        });
        it('does not append ANSI reset when no ANSI codes are present', () => {
            const result = truncateLineToMaxWidth('abcdefghijklmnop', 10);
            // Should NOT contain \x1b[0m - just plain text + ellipsis
            expect(result).toBe('abcdefg...');
            expect(result).not.toContain('\x1b');
        });
    });
    describe('ellipsis behavior', () => {
        it('adds ... when truncating', () => {
            const result = truncateLineToMaxWidth('abcdefghijklmnop', 10);
            expect(result).toBe('abcdefg...');
        });
        it('handles maxWidth smaller than ellipsis length', () => {
            const result = truncateLineToMaxWidth('abcdefghij', 2);
            expect(result).toBe('...');
        });
        it('handles maxWidth equal to ellipsis length', () => {
            const result = truncateLineToMaxWidth('abcdefghij', 3);
            expect(result).toBe('...');
        });
        it('truncates to exactly maxWidth visible columns', () => {
            const result = truncateLineToMaxWidth('abcdefghijklmnop', 10);
            expect(result).toBe('abcdefg...');
            expect(stringWidth(result)).toBe(10);
        });
    });
    describe('CJK and Unicode handling', () => {
        it('correctly handles CJK characters as double-width', () => {
            // Each CJK char is 2 columns wide
            const line = '\u4f60\u597d\u4e16\u754c'; // 4 CJK chars = 8 columns
            const result = truncateLineToMaxWidth(line, 6);
            // targetWidth = 6 - 3 = 3, can only fit 1 CJK char (2 cols)
            expect(stringWidth(result)).toBeLessThanOrEqual(6);
            expect(result).toMatch(/\.\.\.$/);
        });
        it('correctly handles Japanese Hiragana as double-width', () => {
            const line = '\u3053\u3093\u306b\u3061\u306f'; // konnichiha in hiragana, 5 chars = 10 cols
            const result = truncateLineToMaxWidth(line, 8);
            expect(stringWidth(result)).toBeLessThanOrEqual(8);
            expect(result).toMatch(/\.\.\.$/);
        });
        it('correctly handles Japanese Katakana as double-width', () => {
            const line = '\u30ab\u30bf\u30ab\u30ca'; // katakana, 4 chars = 8 cols
            const result = truncateLineToMaxWidth(line, 6);
            expect(stringWidth(result)).toBeLessThanOrEqual(6);
            expect(result).toMatch(/\.\.\.$/);
        });
        it('handles surrogate pairs (emoji) without corruption', () => {
            // Brain emoji U+1F9E0 is a surrogate pair in UTF-16
            const line = 'status: \uD83E\uDDE0 thinking about something long';
            const result = truncateLineToMaxWidth(line, 20);
            expect(result).toMatch(/\.\.\.$/);
            // Result should not contain orphaned surrogates
            // Verify by encoding to buffer - orphaned surrogates become replacement chars
            const buf = Buffer.from(result, 'utf-8');
            const roundtrip = buf.toString('utf-8');
            expect(roundtrip).toBe(result);
        });
        it('handles emoji-only content', () => {
            // Each emoji is width 1 in our getCharWidth (not CJK). 10 emoji = 10 columns.
            const line = '\uD83D\uDE00\uD83D\uDE01\uD83D\uDE02\uD83D\uDE03\uD83D\uDE04\uD83D\uDE05\uD83D\uDE06\uD83D\uDE07\uD83D\uDE08\uD83D\uDE09';
            const result = truncateLineToMaxWidth(line, 6);
            expect(result).toMatch(/\.\.\.$/);
            expect(stringWidth(result)).toBeLessThanOrEqual(6);
        });
    });
    describe('realistic HUD scenarios', () => {
        it('truncates a typical HUD header line', () => {
            const hudLine = '[OMC#4.5.0] | 5h:45% | ctx:30% | ralph:1/10 | agents:OeSe | bg:2';
            const result = truncateLineToMaxWidth(hudLine, 50);
            expect(result).toMatch(/\.\.\.$/);
            expect(stringWidth(result)).toBeLessThanOrEqual(50);
        });
        it('does not truncate a short HUD line within maxWidth', () => {
            const hudLine = '[OMC] | ctx:30%';
            const result = truncateLineToMaxWidth(hudLine, 80);
            expect(result).toBe(hudLine);
        });
        it('handles a detail line with tree characters', () => {
            const detailLine = '  |- architect(2m) analyzing code structure';
            const result = truncateLineToMaxWidth(detailLine, 30);
            expect(result).toMatch(/\.\.\.$/);
            expect(stringWidth(result)).toBeLessThanOrEqual(30);
        });
        it('handles HUD line with ANSI and CJK mixed', () => {
            const line = '\x1b[1m[OMC]\x1b[0m \u4f60\u597d hello world long text here';
            const result = truncateLineToMaxWidth(line, 15);
            expect(result).toMatch(/\.\.\.$/);
            expect(stringWidth(result)).toBeLessThanOrEqual(15);
        });
    });
});
//# sourceMappingURL=max-width.test.js.map