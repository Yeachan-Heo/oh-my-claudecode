import { describe, it, expect } from 'vitest';
import { formatModelName, renderModel } from '../../hud/elements/model.js';

describe('model element', () => {
  describe('formatModelName', () => {
    it('returns Opus for opus model IDs', () => {
      expect(formatModelName('claude-opus-4-7-20260416')).toBe('Opus');
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

    it('returns versioned name from model IDs', () => {
      expect(formatModelName('claude-opus-4-7-20260416', 'versioned')).toBe('Opus 4.7');
      expect(formatModelName('claude-sonnet-4-6-20260217', 'versioned')).toBe('Sonnet 4.6');
      expect(formatModelName('claude-haiku-4-5-20251001', 'versioned')).toBe('Haiku 4.5');
    });

    it('returns versioned name from display names', () => {
      expect(formatModelName('Sonnet 4.5', 'versioned')).toBe('Sonnet 4.5');
      expect(formatModelName('Opus 4.7', 'versioned')).toBe('Opus 4.7');
      expect(formatModelName('Haiku 4.5', 'versioned')).toBe('Haiku 4.5');
    });

    it('falls back to short name when no version found', () => {
      expect(formatModelName('claude-3-opus-20240229', 'versioned')).toBe('Opus');
    });

    it('returns full model ID in full format', () => {
      expect(formatModelName('claude-opus-4-7-20260416', 'full')).toBe('claude-opus-4-7-20260416');
    });

    it('truncates long unrecognized model names', () => {
      const longName = 'some-very-long-model-name-that-exceeds-limit';
      expect(formatModelName(longName)?.length).toBeLessThanOrEqual(20);
    });
  });

  describe('renderModel', () => {
    it('renders formatted model name', () => {
      const result = renderModel('claude-opus-4-7-20260416');
      expect(result).not.toBeNull();
      expect(result).toContain('Opus');
    });

    it('renders versioned format', () => {
      const result = renderModel('claude-opus-4-7-20260416', 'versioned');
      expect(result).not.toBeNull();
      expect(result).toContain('Opus');
      expect(result).toContain('4.7');
    });

    it('renders full format', () => {
      const result = renderModel('claude-opus-4-7-20260416', 'full');
      expect(result).not.toBeNull();
      expect(result).toContain('claude-opus-4-7');
    });

    it('returns null for null input', () => {
      expect(renderModel(null)).toBeNull();
    });
  });
});
