import { describe, it, expect } from 'vitest';
import { validatePayload, DEFAULT_PAYLOAD_LIMITS } from '../payload-limits.js';

describe('payload-limits', () => {
  describe('validatePayload', () => {
    it('should accept a small valid payload', () => {
      const result = validatePayload({ key: 'value', count: 42 });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept an empty object', () => {
      const result = validatePayload({});
      expect(result.valid).toBe(true);
    });

    it('should accept primitives', () => {
      expect(validatePayload('hello').valid).toBe(true);
      expect(validatePayload(42).valid).toBe(true);
      expect(validatePayload(null).valid).toBe(true);
      expect(validatePayload(true).valid).toBe(true);
    });

    describe('byte size limit', () => {
      it('should reject payloads exceeding maxPayloadBytes', () => {
        const largeString = 'x'.repeat(2_000_000);
        const result = validatePayload({ data: largeString });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('exceeds maximum');
        expect(result.error).toContain('MB');
      });

      it('should accept payloads just under the limit', () => {
        // Create a payload close to but under 1MB
        const str = 'a'.repeat(500_000);
        const result = validatePayload({ data: str });
        expect(result.valid).toBe(true);
      });

      it('should respect custom maxPayloadBytes', () => {
        const result = validatePayload(
          { data: 'x'.repeat(200) },
          { maxPayloadBytes: 100 },
        );
        expect(result.valid).toBe(false);
        expect(result.error).toContain('exceeds maximum');
      });
    });

    describe('nesting depth limit', () => {
      it('should reject deeply nested objects', () => {
        let obj: Record<string, unknown> = { leaf: true };
        for (let i = 0; i < 15; i++) {
          obj = { nested: obj };
        }
        const result = validatePayload(obj);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('nesting depth');
      });

      it('should accept objects at max nesting depth', () => {
        // Default max is 10
        let obj: Record<string, unknown> = { leaf: true };
        for (let i = 0; i < 9; i++) {
          obj = { nested: obj };
        }
        const result = validatePayload(obj);
        expect(result.valid).toBe(true);
      });

      it('should reject deeply nested arrays', () => {
        let arr: unknown[] = ['leaf'];
        for (let i = 0; i < 15; i++) {
          arr = [arr];
        }
        const result = validatePayload(arr);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('nesting depth');
      });

      it('should respect custom maxNestingDepth', () => {
        const obj = { a: { b: { c: true } } }; // depth 3
        const result = validatePayload(obj, { maxNestingDepth: 2 });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('nesting depth');
      });
    });

    describe('top-level key count limit', () => {
      it('should reject objects with too many top-level keys', () => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < 150; i++) {
          obj[`key_${i}`] = 'value';
        }
        const result = validatePayload(obj);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('top-level keys');
        expect(result.error).toContain('150');
      });

      it('should accept objects at the key limit', () => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < 100; i++) {
          obj[`key_${i}`] = 'value';
        }
        const result = validatePayload(obj);
        expect(result.valid).toBe(true);
      });

      it('should respect custom maxTopLevelKeys', () => {
        const result = validatePayload(
          { a: 1, b: 2, c: 3, d: 4 },
          { maxTopLevelKeys: 3 },
        );
        expect(result.valid).toBe(false);
        expect(result.error).toContain('top-level keys');
      });

      it('should not count keys on arrays', () => {
        const arr = Array.from({ length: 200 }, (_, i) => i);
        const result = validatePayload(arr);
        expect(result.valid).toBe(true);
      });
    });

    describe('check ordering', () => {
      it('should check key count before expensive serialization', () => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < 150; i++) {
          obj[`key_${i}`] = 'x'.repeat(10_000);
        }
        const result = validatePayload(obj);
        expect(result.valid).toBe(false);
        // Should fail on key count, not size
        expect(result.error).toContain('top-level keys');
      });
    });

    it('should expose sensible defaults', () => {
      expect(DEFAULT_PAYLOAD_LIMITS.maxPayloadBytes).toBe(1_048_576);
      expect(DEFAULT_PAYLOAD_LIMITS.maxNestingDepth).toBe(10);
      expect(DEFAULT_PAYLOAD_LIMITS.maxTopLevelKeys).toBe(100);
    });
  });
});
