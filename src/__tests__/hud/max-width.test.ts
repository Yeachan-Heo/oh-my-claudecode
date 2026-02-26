import { describe, it, expect } from 'vitest';
import { truncateLineToMaxWidth } from '../../hud/render.js';

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
      // The visible width (stripping ellipsis) should fit within 20 columns
      expect(result.length).toBeLessThanOrEqual(20);
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
      // Bold text: \x1b[1m...\x1b[0m
      const line = '\x1b[1m[OMC#4.5.0]\x1b[0m | rate: 45% | ctx: 30% | agents: 3 running';
      const result = truncateLineToMaxWidth(line, 30);
      // Should contain ANSI codes
      expect(result).toContain('\x1b[1m');
      expect(result).toMatch(/\.\.\.$/);
    });

    it('does not count ANSI codes as visible width', () => {
      // Same visible content, one with ANSI codes, one without
      const withAnsi = '\x1b[32mhello\x1b[0m';  // "hello" in green
      const withoutAnsi = 'hello';

      // Both should NOT be truncated at width 5
      expect(truncateLineToMaxWidth(withAnsi, 5)).toBe(withAnsi);
      expect(truncateLineToMaxWidth(withoutAnsi, 5)).toBe(withoutAnsi);
    });

    it('handles multiple ANSI sequences', () => {
      const line = '\x1b[1m[OMC]\x1b[0m \x1b[2m|\x1b[0m \x1b[33mrate: 45%\x1b[0m';
      const result = truncateLineToMaxWidth(line, 10);
      // Should truncate visible content but preserve ANSI
      expect(result).toMatch(/\.\.\.$/);
    });
  });

  describe('ellipsis behavior', () => {
    it('adds ... when truncating', () => {
      const result = truncateLineToMaxWidth('abcdefghijklmnop', 10);
      expect(result).toBe('abcdefg...');
    });

    it('handles maxWidth smaller than ellipsis length', () => {
      const result = truncateLineToMaxWidth('abcdefghij', 2);
      // With maxWidth=2 and ellipsis=3, targetWidth=max(0,-1)=0
      // So result should just be "..."
      expect(result).toBe('...');
    });

    it('handles maxWidth equal to ellipsis length', () => {
      const result = truncateLineToMaxWidth('abcdefghij', 3);
      // targetWidth = max(0, 3-3) = 0, so just "..."
      expect(result).toBe('...');
    });

    it('truncates to exactly maxWidth visible columns', () => {
      // 'abcdefg...' = 10 visible columns
      const result = truncateLineToMaxWidth('abcdefghijklmnop', 10);
      expect(result).toBe('abcdefg...');
      expect(result.length).toBe(10); // 7 chars + 3 dots
    });
  });

  describe('realistic HUD scenarios', () => {
    it('truncates a typical HUD header line', () => {
      const hudLine = '[OMC#4.5.0] | 5h:45% | ctx:30% | ralph:1/10 | agents:OeSe | bg:2';
      const result = truncateLineToMaxWidth(hudLine, 50);
      expect(result).toMatch(/\.\.\.$/);
      expect(result.length).toBeLessThanOrEqual(50);
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
      expect(result.length).toBeLessThanOrEqual(30);
    });
  });
});
