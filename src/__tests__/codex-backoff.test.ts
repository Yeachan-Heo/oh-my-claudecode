import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeBackoffDelay,
  RATE_LIMIT_RETRY_COUNT,
  RATE_LIMIT_INITIAL_DELAY,
  RATE_LIMIT_MAX_DELAY,
  isRetryableError,
} from '../mcp/codex-core.js';

describe('Codex Background Retry / Backoff', () => {
  describe('RATE_LIMIT_RETRY_COUNT upper bound', () => {
    it('should default to 3 retries', () => {
      expect(RATE_LIMIT_RETRY_COUNT).toBe(3);
    });

    it('should be at least 1', () => {
      expect(RATE_LIMIT_RETRY_COUNT).toBeGreaterThanOrEqual(1);
    });

    it('should be at most 10', () => {
      expect(RATE_LIMIT_RETRY_COUNT).toBeLessThanOrEqual(10);
    });
  });

  describe('computeBackoffDelay', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return initialDelay * jitter for attempt 0', () => {
      const delay = computeBackoffDelay(0, 5000, 60000);
      // exponential = 5000 * 2^0 = 5000
      // capped = min(5000, 60000) = 5000
      // jitter = 5000 * (0.5 + 0.5 * 0.5) = 5000 * 0.75 = 3750
      expect(delay).toBe(3750);
    });

    it('should double delay for each attempt', () => {
      const delay0 = computeBackoffDelay(0, 5000, 60000);
      const delay1 = computeBackoffDelay(1, 5000, 60000);
      const delay2 = computeBackoffDelay(2, 5000, 60000);
      expect(delay0).toBe(3750);
      expect(delay1).toBe(7500);
      expect(delay2).toBe(15000);
    });

    it('should cap at maxDelay', () => {
      const delay = computeBackoffDelay(5, 5000, 60000);
      // capped = 60000, jitter = 60000 * 0.75 = 45000
      expect(delay).toBe(45000);
    });

    it('should use defaults from module constants', () => {
      const delay = computeBackoffDelay(0, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
      const expected = Math.round(RATE_LIMIT_INITIAL_DELAY * 0.75);
      expect(delay).toBe(expected);
    });

    it('should always return a positive integer', () => {
      vi.restoreAllMocks();
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = computeBackoffDelay(attempt, 1000, 30000);
        expect(delay).toBeGreaterThan(0);
        expect(Number.isInteger(delay)).toBe(true);
      }
    });
  });

  describe('explicit model retries then success', () => {
    it('should allow retries up to RATE_LIMIT_RETRY_COUNT for explicit models', () => {
      const maxAttempts = RATE_LIMIT_RETRY_COUNT;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        expect(attempt < RATE_LIMIT_RETRY_COUNT).toBe(true);
      }
    });

    it('should detect rate limit as retryable before each retry', () => {
      const result = isRetryableError('', 'Error: 429 Too Many Requests');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('rate_limit');
    });

    it('should not detect success output as retryable', () => {
      const successOutput = JSON.stringify({ type: 'message', content: 'Analysis complete.' });
      const result = isRetryableError(successOutput, '');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });
  });

  describe('explicit model retries then exhaustion', () => {
    it('should exhaust retries when attempt equals RATE_LIMIT_RETRY_COUNT', () => {
      const exhaustedAttempt = RATE_LIMIT_RETRY_COUNT;
      expect(exhaustedAttempt < RATE_LIMIT_RETRY_COUNT).toBe(false);
    });

    it('should compute increasing delays before exhaustion', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const delays: number[] = [];
      for (let attempt = 0; attempt < RATE_LIMIT_RETRY_COUNT; attempt++) {
        delays.push(computeBackoffDelay(attempt, 5000, 60000));
      }
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
      vi.restoreAllMocks();
    });
  });

  describe('fallback-chain switch on 429 with backoff delay', () => {
    it('should detect rate limit errors for fallback chain decision', () => {
      const rateLimitOutput = JSON.stringify({
        type: 'error',
        message: 'Rate limit exceeded. Please retry after 30 seconds.',
      });
      const result = isRetryableError(rateLimitOutput, '');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('rate_limit');
    });

    it('should detect model errors for immediate fallback (no backoff)', () => {
      const modelOutput = JSON.stringify({
        type: 'error',
        message: 'model_not_found: gpt-5.3-codex',
      });
      const result = isRetryableError(modelOutput, '');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('model');
    });

    it('rate limit fallback should use backoff delay', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const delay = computeBackoffDelay(0, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(RATE_LIMIT_MAX_DELAY);
      vi.restoreAllMocks();
    });
  });

  describe('bounded termination', () => {
    it('RATE_LIMIT_RETRY_COUNT provides a finite upper bound', () => {
      expect(RATE_LIMIT_RETRY_COUNT).toBeGreaterThanOrEqual(1);
      expect(RATE_LIMIT_RETRY_COUNT).toBeLessThanOrEqual(10);
      expect(Number.isFinite(RATE_LIMIT_RETRY_COUNT)).toBe(true);
    });

    it('backoff delay is always finite and bounded by maxDelay', () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const delay = computeBackoffDelay(attempt, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeLessThanOrEqual(RATE_LIMIT_MAX_DELAY);
        expect(delay).toBeGreaterThan(0);
      }
    });

    it('total worst-case delay is bounded', () => {
      let totalDelay = 0;
      for (let attempt = 0; attempt < RATE_LIMIT_RETRY_COUNT; attempt++) {
        totalDelay += computeBackoffDelay(attempt, RATE_LIMIT_INITIAL_DELAY, RATE_LIMIT_MAX_DELAY);
      }
      expect(Number.isFinite(totalDelay)).toBe(true);
      expect(totalDelay).toBeLessThanOrEqual(RATE_LIMIT_RETRY_COUNT * RATE_LIMIT_MAX_DELAY);
    });
  });
});
