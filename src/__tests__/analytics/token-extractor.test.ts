import { describe, it, expect, beforeEach } from 'vitest';
import { extractTokens, createSnapshot } from '../../analytics/token-extractor.js';
import type { TokenSnapshot, ExtractedTokens } from '../../analytics/token-extractor.js';
import type { StatuslineStdin } from '../../hud/types.js';

describe('TokenExtractor', () => {
  let mockStdin: StatuslineStdin;

  beforeEach(() => {
    mockStdin = {
      transcript_path: '/path/to/transcript.jsonl',
      cwd: '/home/user',
      model: {
        id: 'claude-sonnet-4-5-20250929',
        display_name: 'Claude Sonnet 4.5'
      },
      context_window: {
        context_window_size: 200000,
        used_percentage: 35,
        current_usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 2000
        }
      }
    };
  });

  describe('extractTokens', () => {
    it('should extract tokens from StatuslineStdin without previous snapshot', () => {
      const result = extractTokens(mockStdin, null, 'claude-sonnet-4-5-20250929');

      expect(result.inputTokens).toBe(1000);
      expect(result.cacheCreationTokens).toBe(500);
      expect(result.cacheReadTokens).toBe(2000);
      expect(result.modelName).toBe('claude-sonnet-4-5-20250929');
      expect(result.isEstimated).toBe(true);
      expect(result.timestamp).toBeDefined();
      expect(result.agentName).toBeUndefined();
    });

    it('should calculate correct deltas with previous snapshot', () => {
      const previousSnapshot: TokenSnapshot = {
        inputTokens: 600,
        cacheCreationTokens: 200,
        cacheReadTokens: 1000,
        timestamp: '2026-01-24T00:00:00.000Z'
      };

      const result = extractTokens(mockStdin, previousSnapshot, 'claude-sonnet-4-5-20250929');

      // Deltas: current - previous
      expect(result.inputTokens).toBe(400); // 1000 - 600
      expect(result.cacheCreationTokens).toBe(300); // 500 - 200
      expect(result.cacheReadTokens).toBe(1000); // 2000 - 1000
    });

    it('should estimate output tokens for Haiku (30% ratio)', () => {
      const result = extractTokens(mockStdin, null, 'claude-haiku-4-5-20251001');

      // 1000 input tokens * 30% = 300
      expect(result.outputTokens).toBe(300);
    });

    it('should estimate output tokens for Sonnet (40% ratio)', () => {
      const result = extractTokens(mockStdin, null, 'claude-sonnet-4-5-20250929');

      // 1000 input tokens * 40% = 400
      expect(result.outputTokens).toBe(400);
    });

    it('should estimate output tokens for Opus (50% ratio)', () => {
      const result = extractTokens(mockStdin, null, 'claude-opus-4-6-20260205');

      // 1000 input tokens * 50% = 500
      expect(result.outputTokens).toBe(500);
    });

    it('should handle zero output tokens correctly', () => {
      mockStdin.context_window.current_usage = {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      };

      const result = extractTokens(mockStdin, null, 'claude-sonnet-4-5-20250929');

      expect(result.outputTokens).toBe(0);
      expect(result.inputTokens).toBe(0);
    });

    it('should include agentName when provided', () => {
      const result = extractTokens(
        mockStdin,
        null,
        'claude-sonnet-4-5-20250929',
        'test-agent'
      );

      expect(result.agentName).toBe('test-agent');
    });

    it('should handle missing usage data gracefully', () => {
      mockStdin.context_window.current_usage = undefined;

      const result = extractTokens(mockStdin, null, 'claude-sonnet-4-5-20250929');

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.cacheCreationTokens).toBe(0);
      expect(result.cacheReadTokens).toBe(0);
    });

    it('should handle undefined context_window gracefully', () => {
      // Create stdin with undefined context_window
      const stdinWithoutContext = {
        ...mockStdin,
        context_window: undefined as any
      };

      const result = extractTokens(stdinWithoutContext, null, 'claude-sonnet-4-5-20250929');

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.cacheCreationTokens).toBe(0);
      expect(result.cacheReadTokens).toBe(0);
    });

    it('should handle undefined context_window.current_usage gracefully', () => {
      // Create stdin with context_window but no current_usage
      const stdinWithoutUsage = {
        ...mockStdin,
        context_window: {
          ...mockStdin.context_window,
          current_usage: undefined
        }
      };

      const result = extractTokens(stdinWithoutUsage, null, 'claude-sonnet-4-5-20250929');

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.cacheCreationTokens).toBe(0);
      expect(result.cacheReadTokens).toBe(0);
    });

    it('should ensure non-negative deltas', () => {
      const previousSnapshot: TokenSnapshot = {
        inputTokens: 2000, // Greater than current
        cacheCreationTokens: 1000,
        cacheReadTokens: 3000,
        timestamp: '2026-01-24T00:00:00.000Z'
      };

      const result = extractTokens(mockStdin, previousSnapshot, 'claude-sonnet-4-5-20250929');

      // Should clamp to 0 if delta is negative
      expect(result.inputTokens).toBe(0); // max(0, 1000 - 2000)
    });
  });

  describe('createSnapshot', () => {
    it('should create snapshot from current usage', () => {
      const snapshot = createSnapshot(mockStdin);

      expect(snapshot.inputTokens).toBe(1000);
      expect(snapshot.cacheCreationTokens).toBe(500);
      expect(snapshot.cacheReadTokens).toBe(2000);
      expect(snapshot.timestamp).toBeDefined();
    });

    it('should handle missing usage data in snapshot', () => {
      mockStdin.context_window.current_usage = undefined;

      const snapshot = createSnapshot(mockStdin);

      expect(snapshot.inputTokens).toBe(0);
      expect(snapshot.cacheCreationTokens).toBe(0);
      expect(snapshot.cacheReadTokens).toBe(0);
    });

    it('should create fresh timestamp for each snapshot', () => {
      const snapshot1 = createSnapshot(mockStdin);
      const snapshot2 = createSnapshot(mockStdin);

      // Timestamps should be different (or very close if fast)
      expect(snapshot1.timestamp).toBeDefined();
      expect(snapshot2.timestamp).toBeDefined();
    });

    it('should handle undefined context_window in snapshot', () => {
      // TEST FIRST: This test should FAIL before the fix
      const stdinWithoutContextWindow = {
        transcript_path: '/path/to/transcript.jsonl',
        cwd: '/home/user',
        model: {
          id: 'claude-sonnet-4-5-20250929',
          display_name: 'Claude Sonnet 4.5'
        },
        context_window: undefined as any
      };

      const snapshot = createSnapshot(stdinWithoutContextWindow);

      expect(snapshot.inputTokens).toBe(0);
      expect(snapshot.cacheCreationTokens).toBe(0);
      expect(snapshot.cacheReadTokens).toBe(0);
      expect(snapshot.timestamp).toBeDefined();
    });
  });
});
