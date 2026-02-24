import { describe, it, expect } from 'vitest';
import { limitOutputLines } from '../../hud/render.js';
import { DEFAULT_HUD_CONFIG, PRESET_CONFIGS } from '../../hud/types.js';

describe('limitOutputLines', () => {
  describe('basic functionality', () => {
    it('returns all lines when count is within limit', () => {
      const lines = ['line1', 'line2', 'line3'];
      const result = limitOutputLines(lines, 5);
      expect(result).toEqual(['line1', 'line2', 'line3']);
      expect(result).toHaveLength(3);
    });

    it('returns all lines when count equals limit', () => {
      const lines = ['line1', 'line2', 'line3', 'line4'];
      const result = limitOutputLines(lines, 4);
      expect(result).toEqual(['line1', 'line2', 'line3', 'line4']);
      expect(result).toHaveLength(4);
    });

    it('truncates lines with indicator when count exceeds limit', () => {
      const lines = ['header', 'detail1', 'detail2', 'detail3', 'detail4', 'detail5'];
      const result = limitOutputLines(lines, 4);
      expect(result).toEqual(['header', 'detail1', 'detail2', '... (+3 lines)']);
      expect(result).toHaveLength(4);
    });

    it('preserves the first (header) line when truncating', () => {
      const lines = ['[OMC] Header Line', 'Agents: ...', 'Todos: ...', 'Analytics: ...', 'Extra: ...'];
      const result = limitOutputLines(lines, 3);
      expect(result[0]).toBe('[OMC] Header Line');
      expect(result).toHaveLength(3);
      expect(result[2]).toBe('... (+3 lines)');
    });

    it('handles empty array', () => {
      const result = limitOutputLines([], 4);
      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it('handles single line array', () => {
      const result = limitOutputLines(['only line'], 4);
      expect(result).toEqual(['only line']);
      expect(result).toHaveLength(1);
    });
  });

  describe('truncation indicator', () => {
    it('shows correct count of truncated lines', () => {
      const lines = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6'];
      const result = limitOutputLines(lines, 3);
      expect(result).toEqual(['line1', 'line2', '... (+4 lines)']);
    });

    it('shows +2 lines when truncating 5 lines to 4', () => {
      const lines = ['a', 'b', 'c', 'd', 'e'];
      const result = limitOutputLines(lines, 4);
      expect(result[3]).toBe('... (+2 lines)');
    });
  });

  describe('default value usage', () => {
    it('uses DEFAULT_HUD_CONFIG.elements.maxOutputLines when maxLines not specified', () => {
      const defaultLimit = DEFAULT_HUD_CONFIG.elements.maxOutputLines;
      const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
      const result = limitOutputLines(lines);
      expect(result).toHaveLength(defaultLimit);
    });

    it('uses DEFAULT_HUD_CONFIG.elements.maxOutputLines when maxLines is undefined', () => {
      const defaultLimit = DEFAULT_HUD_CONFIG.elements.maxOutputLines;
      const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
      const result = limitOutputLines(lines, undefined);
      expect(result).toHaveLength(defaultLimit);
    });

    it('overrides default when maxLines is explicitly provided', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
      const result = limitOutputLines(lines, 2);
      expect(result).toHaveLength(2);
      expect(result).toEqual(['line1', '... (+9 lines)']);
    });
  });

  describe('edge cases', () => {
    it('handles maxLines of 1', () => {
      const lines = ['header', 'detail1', 'detail2'];
      const result = limitOutputLines(lines, 1);
      expect(result).toEqual(['... (+3 lines)']);
      expect(result).toHaveLength(1);
    });

    it('clamps maxLines of 0 to 1', () => {
      const lines = ['header', 'detail1'];
      const result = limitOutputLines(lines, 0);
      expect(result).toEqual(['... (+2 lines)']);
      expect(result).toHaveLength(1);
    });

    it('clamps negative maxLines to 1', () => {
      const lines = ['header', 'detail1', 'detail2'];
      const result = limitOutputLines(lines, -5);
      expect(result).toHaveLength(1);
    });

    it('does not mutate the original array', () => {
      const original = ['line1', 'line2', 'line3', 'line4', 'line5'];
      const originalCopy = [...original];
      limitOutputLines(original, 2);
      expect(original).toEqual(originalCopy);
    });

    it('handles lines with multiline content (newlines within strings)', () => {
      const lines = ['header\nwith newline', 'detail1', 'detail2'];
      const result = limitOutputLines(lines, 2);
      expect(result).toEqual(['header\nwith newline', '... (+2 lines)']);
    });

    it('handles lines with empty strings', () => {
      const lines = ['header', '', 'detail', ''];
      const result = limitOutputLines(lines, 3);
      expect(result).toEqual(['header', '', '... (+2 lines)']);
    });
  });

  describe('preset-specific defaults', () => {
    it('has correct maxOutputLines for each preset', () => {
      expect(PRESET_CONFIGS.minimal.maxOutputLines).toBe(2);
      expect(PRESET_CONFIGS.focused.maxOutputLines).toBe(4);
      expect(PRESET_CONFIGS.full.maxOutputLines).toBe(12);
      expect(PRESET_CONFIGS.dense.maxOutputLines).toBe(6);
      expect(PRESET_CONFIGS.opencode.maxOutputLines).toBe(4);
    });
  });

  describe('Issue #222 scenario simulation', () => {
    it('prevents input field shrinkage by limiting excessive HUD output', () => {
      const excessiveOutput = [
        '[OMC] Rate: 45% | Context: 30%',
        'agents: architect(5m) | executor(2m) | explorer',
        'todos: [1/5] Implementing feature X',
        'Analytics: $1.23 | 50k tokens | Cache: 67%',
        'Budget warning: Approaching limit',
        'Agent detail 1: Working on...',
        'Agent detail 2: Searching...',
        'Extra line that would cause shrinkage',
      ];

      const result = limitOutputLines(excessiveOutput, 4);

      expect(result).toHaveLength(4);
      expect(result[0]).toContain('[OMC]');
      expect(result[3]).toBe('... (+5 lines)');
    });

    it('works with DEFAULT_HUD_CONFIG elements.maxOutputLines value of 4', () => {
      expect(DEFAULT_HUD_CONFIG.elements.maxOutputLines).toBe(4);
    });
  });
});
