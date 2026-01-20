import { describe, it, expect } from 'vitest';
import {
  detectExtractableMoment,
  shouldPromptExtraction,
  generateExtractionPrompt,
} from '../../hooks/learner/detector.js';

describe('Skill Detector', () => {
  describe('detectExtractableMoment', () => {
    it('should detect problem-solution pattern', () => {
      const message = 'The issue was caused by a race condition. I fixed it by adding proper locking.';

      const result = detectExtractableMoment(message);

      expect(result.detected).toBe(true);
      expect(result.patternType).toBe('problem-solution');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect technique pattern', () => {
      const message = 'A better way to handle this is to use the observer pattern instead of polling.';

      const result = detectExtractableMoment(message);

      expect(result.detected).toBe(true);
      expect(result.patternType).toBe('technique');
    });

    it('should detect best practice pattern', () => {
      const message = 'Best practices include keeping state as local as possible for React components.';

      const result = detectExtractableMoment(message);

      expect(result.detected).toBe(true);
      expect(result.patternType).toBe('best-practice');
    });

    it('should not detect in regular conversation', () => {
      const message = 'Sure, I can help you with that. What would you like to know?';

      const result = detectExtractableMoment(message);

      expect(result.detected).toBe(false);
    });

    it('should extract trigger keywords when pattern detected', () => {
      // Message that matches problem-solution pattern AND contains trigger keywords
      const message = 'The issue was caused by React state management. I fixed it by using TypeScript strict mode.';

      const result = detectExtractableMoment(message, 'How do I manage state in React?');

      expect(result.detected).toBe(true);
      expect(result.suggestedTriggers).toContain('react');
      expect(result.suggestedTriggers).toContain('typescript');
    });

    it('should detect workaround pattern', () => {
      const message = 'As a workaround, you can temporarily disable the cache while debugging.';

      const result = detectExtractableMoment(message);

      expect(result.detected).toBe(true);
      expect(result.patternType).toBe('workaround');
    });

    it('should detect optimization pattern', () => {
      const message = 'To get better performance, optimize by using memoization on expensive calculations.';

      const result = detectExtractableMoment(message);

      expect(result.detected).toBe(true);
      expect(result.patternType).toBe('optimization');
    });
  });

  describe('shouldPromptExtraction', () => {
    it('should return true when confidence exceeds threshold', () => {
      const detection = {
        detected: true,
        confidence: 75,
        patternType: 'problem-solution' as const,
        suggestedTriggers: [],
        reason: 'test',
      };

      expect(shouldPromptExtraction(detection, 60)).toBe(true);
    });

    it('should return false when not detected', () => {
      const detection = {
        detected: false,
        confidence: 0,
        patternType: 'problem-solution' as const,
        suggestedTriggers: [],
        reason: 'test',
      };

      expect(shouldPromptExtraction(detection)).toBe(false);
    });

    it('should return false when below threshold', () => {
      const detection = {
        detected: true,
        confidence: 40,
        patternType: 'problem-solution' as const,
        suggestedTriggers: [],
        reason: 'test',
      };

      expect(shouldPromptExtraction(detection, 60)).toBe(false);
    });
  });

  describe('generateExtractionPrompt', () => {
    it('should generate prompt with detection details', () => {
      const detection = {
        detected: true,
        confidence: 80,
        patternType: 'technique' as const,
        suggestedTriggers: ['react', 'hooks'],
        reason: 'Detected technique pattern',
      };

      const prompt = generateExtractionPrompt(detection);

      expect(prompt).toContain('useful technique');
      expect(prompt).toContain('80%');
      expect(prompt).toContain('react, hooks');
      expect(prompt).toContain('/learner');
    });
  });
});
