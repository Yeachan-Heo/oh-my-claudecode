import { describe, it, expect } from 'vitest';
import {
  isModelError,
  isRateLimitError,
  isRetryableError,
} from '../mcp/codex-core.js';
import {
  isGeminiRetryableError,
} from '../mcp/gemini-core.js';
import {
  CODEX_MODEL_FALLBACKS,
  GEMINI_MODEL_FALLBACKS,
} from '../features/model-routing/external-model-policy.js';

describe('MCP Fallback on 429/Rate-Limit Errors', () => {
  describe('Codex: isModelError', () => {
    it('should detect model_not_found in JSONL output', () => {
      const output = JSON.stringify({ type: 'error', message: 'model_not_found: gpt-5.3-codex' });
      const result = isModelError(output);
      expect(result.isError).toBe(true);
      expect(result.message).toContain('model_not_found');
    });

    it('should detect model is not supported', () => {
      const output = JSON.stringify({ type: 'error', message: 'The model is not supported for this endpoint' });
      const result = isModelError(output);
      expect(result.isError).toBe(true);
    });

    it('should not flag non-model errors', () => {
      const output = JSON.stringify({ type: 'error', message: 'Internal server error' });
      const result = isModelError(output);
      expect(result.isError).toBe(false);
    });

    it('should handle turn.failed with nested error', () => {
      const output = JSON.stringify({ type: 'turn.failed', error: { message: 'model_not_found' } });
      const result = isModelError(output);
      expect(result.isError).toBe(true);
    });

    it('should skip non-JSON lines gracefully', () => {
      const output = 'Loading...\n' + JSON.stringify({ type: 'error', message: 'model_not_found' }) + '\nDone.';
      const result = isModelError(output);
      expect(result.isError).toBe(true);
    });
  });

  describe('Codex: isRateLimitError', () => {
    it('should detect 429 status code in output', () => {
      const result = isRateLimitError('', 'Error: 429 Too Many Requests');
      expect(result.isError).toBe(true);
      expect(result.message).toContain('429');
    });

    it('should detect rate_limit in JSONL error', () => {
      const output = JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Please retry after 30 seconds.' });
      const result = isRateLimitError(output);
      expect(result.isError).toBe(true);
    });

    it('should detect too many requests', () => {
      const result = isRateLimitError('', 'Error: Too Many Requests');
      expect(result.isError).toBe(true);
    });

    it('should detect quota_exceeded', () => {
      const result = isRateLimitError('', 'quota_exceeded: You have exceeded your API quota');
      expect(result.isError).toBe(true);
    });

    it('should detect resource_exhausted', () => {
      const result = isRateLimitError('', 'RESOURCE_EXHAUSTED: Rate limit reached');
      expect(result.isError).toBe(true);
    });

    it('should not flag normal errors', () => {
      const result = isRateLimitError('', 'Connection refused');
      expect(result.isError).toBe(false);
    });

    it('should not flag normal output', () => {
      const output = JSON.stringify({ type: 'message', content: 'Here is my analysis of your code.' });
      const result = isRateLimitError(output);
      expect(result.isError).toBe(false);
    });
  });

  describe('Codex: isRetryableError', () => {
    it('should detect model errors as retryable with type "model"', () => {
      const output = JSON.stringify({ type: 'error', message: 'model_not_found: gpt-5.3-codex' });
      const result = isRetryableError(output);
      expect(result.isError).toBe(true);
      expect(result.type).toBe('model');
    });

    it('should detect rate limit errors as retryable with type "rate_limit"', () => {
      const result = isRetryableError('', 'Error: 429 Too Many Requests');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('rate_limit');
    });

    it('should prioritize model errors over rate limit errors', () => {
      const output = JSON.stringify({ type: 'error', message: 'model_not_found' });
      const result = isRetryableError(output, '429 Too Many Requests');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('model');
    });

    it('should return type "none" for non-retryable errors', () => {
      const result = isRetryableError('', 'Connection timeout');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });
  });

  describe('Gemini: isGeminiRetryableError', () => {
    it('should detect 429 in stderr', () => {
      const result = isGeminiRetryableError('', 'Error 429: Too Many Requests');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('rate_limit');
    });

    it('should NOT detect rate limit from stdout (response content)', () => {
      // Gemini CLI outputs plain text to stdout — searching it causes false positives
      const result = isGeminiRetryableError('rate limit exceeded for model gemini-3-pro-preview', '');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should detect quota_exceeded', () => {
      const result = isGeminiRetryableError('', 'QUOTA_EXCEEDED: API quota exhausted');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('rate_limit');
    });

    it('should detect resource_exhausted (Google Cloud error format)', () => {
      const result = isGeminiRetryableError('', 'RESOURCE_EXHAUSTED: Quota exceeded for tokens per minute');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('rate_limit');
    });

    it('should detect model not found', () => {
      const result = isGeminiRetryableError('', 'model_not_found: gemini-3-pro-preview');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('model');
    });

    it('should detect model not available', () => {
      const result = isGeminiRetryableError('', 'The model gemini-3-pro-preview is not available in your region');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('model');
    });

    it('should detect model does not exist', () => {
      const result = isGeminiRetryableError('', 'Model gemini-3-pro-preview does not exist');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('model');
    });

    it('should not flag normal output', () => {
      const result = isGeminiRetryableError('Here is my analysis of the codebase.', '');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should not flag unrelated errors', () => {
      const result = isGeminiRetryableError('', 'ENOENT: file not found');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should prioritize model errors over rate limit errors in stderr', () => {
      // Both patterns in stderr: model error check runs first
      const result = isGeminiRetryableError('', 'model_not_found\n429 Too Many Requests');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('model');
    });

    it('should ignore model_not_found in stdout (response content)', () => {
      // stdout is response text, only stderr is checked
      const result = isGeminiRetryableError('model_not_found', '');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });
  });

  describe('Gemini: false positive prevention (response content with error keywords)', () => {
    it('should NOT flag response discussing rate limits', () => {
      const response = 'To handle HTTP 429 rate limit errors, implement exponential backoff with quota exceeded detection.';
      const result = isGeminiRetryableError(response, '');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should NOT flag response containing "429" and "too many requests"', () => {
      const response = 'The server returned 429 Too Many Requests. This means resource exhausted.';
      const result = isGeminiRetryableError(response, '');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });

    it('should NOT flag response about model availability', () => {
      const response = 'The model is not available in all regions. Check model_not_found errors.';
      const result = isGeminiRetryableError(response, '');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });

    it('SHOULD detect real rate limit from stderr', () => {
      const result = isGeminiRetryableError('', 'Error 429: Too Many Requests');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('rate_limit');
    });

    it('SHOULD detect real model error from stderr', () => {
      const result = isGeminiRetryableError('', 'ModelNotFoundError: Requested entity was not found.');
      expect(result.isError).toBe(true);
      expect(result.type).toBe('model');
    });

    it('should NOT flag when response has rate limit keywords but stderr has unrelated error', () => {
      const response = '429 rate limit errors are common in distributed systems.';
      const result = isGeminiRetryableError(response, 'ENOENT: file not found');
      expect(result.isError).toBe(false);
      expect(result.type).toBe('none');
    });
  });

  describe('Fallback chain configuration', () => {
    it('Codex should have a valid fallback chain', () => {
      expect(CODEX_MODEL_FALLBACKS.length).toBeGreaterThanOrEqual(2);
      expect(CODEX_MODEL_FALLBACKS[0]).toContain('codex');
    });

    it('Gemini should have a valid fallback chain', () => {
      expect(GEMINI_MODEL_FALLBACKS.length).toBeGreaterThanOrEqual(2);
      expect(GEMINI_MODEL_FALLBACKS[0]).toContain('gemini');
    });

    it('Codex fallback chain models should all be valid format', () => {
      for (const model of CODEX_MODEL_FALLBACKS) {
        expect(model).toMatch(/^[a-z0-9][a-z0-9._-]+$/i);
      }
    });

    it('Gemini fallback chain models should all be valid format', () => {
      for (const model of GEMINI_MODEL_FALLBACKS) {
        expect(model).toMatch(/^[a-z0-9][a-z0-9._-]+$/i);
      }
    });
  });
});
