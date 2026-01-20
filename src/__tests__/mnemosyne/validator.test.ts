import { describe, it, expect } from 'vitest';
import { validateExtractionRequest, validateSkillMetadata } from '../../hooks/learner/validator.js';

describe('Skill Validator', () => {
  describe('validateExtractionRequest', () => {
    it('should pass valid extraction request', () => {
      const request = {
        problem: 'How to handle React state updates correctly',
        solution: 'Use the functional form of setState when the new state depends on the previous state. This ensures you always have the latest state value.',
        triggers: ['react', 'state', 'setState'],
        targetScope: 'user' as const,
      };

      const result = validateExtractionRequest(request);

      expect(result.valid).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(50);
    });

    it('should fail with missing problem', () => {
      const request = {
        problem: '',
        solution: 'Use functional setState for dependent updates',
        triggers: ['react'],
        targetScope: 'user' as const,
      };

      const result = validateExtractionRequest(request);

      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('problem (minimum 10 characters)');
    });

    it('should warn about generic triggers', () => {
      const request = {
        problem: 'How to handle data correctly',
        solution: 'Always validate and sanitize input data before processing',
        triggers: ['the', 'data', 'this'],
        targetScope: 'user' as const,
      };

      const result = validateExtractionRequest(request);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('Generic triggers'))).toBe(true);
    });

    it('should fail with short solution', () => {
      const request = {
        problem: 'Valid problem statement here',
        solution: 'Too short',
        triggers: ['test'],
        targetScope: 'user' as const,
      };

      const result = validateExtractionRequest(request);

      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('solution (minimum 20 characters)');
    });

    it('should fail with empty triggers', () => {
      const request = {
        problem: 'Valid problem statement here',
        solution: 'Valid solution that is long enough',
        triggers: [],
        targetScope: 'user' as const,
      };

      const result = validateExtractionRequest(request);

      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('triggers (at least one required)');
    });
  });

  describe('validateSkillMetadata', () => {
    it('should pass valid metadata', () => {
      const metadata = {
        id: 'skill-001',
        name: 'Test Skill',
        description: 'A test skill',
        source: 'extracted' as const,
        triggers: ['test'],
        createdAt: '2024-01-19T12:00:00Z',
      };

      const result = validateSkillMetadata(metadata);

      expect(result.valid).toBe(true);
    });

    it('should fail with missing required fields', () => {
      const metadata = {
        name: 'Incomplete',
      };

      const result = validateSkillMetadata(metadata);

      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('id');
      expect(result.missingFields).toContain('triggers');
    });
  });
});
