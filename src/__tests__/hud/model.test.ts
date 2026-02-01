import { describe, it, expect } from 'vitest';
import { formatModelName, renderModel } from '../../hud/elements/model.js';

describe('model element', () => {
  describe('formatModelName', () => {
    it('returns Opus for opus model IDs', () => {
      expect(formatModelName('claude-opus-4-5-20251101')).toBe('Opus');
      expect(formatModelName('claude-3-opus-20240229')).toBe('Opus');
    });

    it('returns Sonnet for sonnet model IDs', () => {
      expect(formatModelName('claude-sonnet-4-20250514')).toBe('Sonnet');
      expect(formatModelName('claude-3-5-sonnet-20241022')).toBe('Sonnet');
    });

    it('returns Haiku for haiku model IDs', () => {
      expect(formatModelName('claude-3-haiku-20240307')).toBe('Haiku');
    });

    it('returns null for null/undefined', () => {
      expect(formatModelName(null)).toBeNull();
      expect(formatModelName(undefined)).toBeNull();
    });

    it('truncates long unrecognized model names', () => {
      const longName = 'some-very-long-model-name-that-exceeds-limit';
      expect(formatModelName(longName)?.length).toBeLessThanOrEqual(20);
    });
  });

  describe('renderModel', () => {
    it('renders formatted model name', () => {
      const result = renderModel('claude-opus-4-5-20251101');
      expect(result).toContain('model:');
      expect(result).toContain('Opus');
    });

    it('returns null for null input', () => {
      expect(renderModel(null)).toBeNull();
    });
  });
});
