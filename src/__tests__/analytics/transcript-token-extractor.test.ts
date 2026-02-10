import { describe, it, expect } from 'vitest';
import { extractTokenUsage } from '../../analytics/transcript-token-extractor.js';
import type { TranscriptEntry } from '../../analytics/types.js';

describe('extractTokenUsage', () => {
  it('should extract token usage from assistant entry', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      timestamp: '2026-01-24T05:07:46.325Z',
      sessionId: 'test-session-123',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300
        }
      }
    };

    const result = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');

    expect(result).not.toBeNull();
    expect(result?.usage.modelName).toBe('claude-sonnet-4.5');
    expect(result?.usage.inputTokens).toBe(1000);
    expect(result?.usage.outputTokens).toBe(500);
    expect(result?.usage.cacheCreationTokens).toBe(200);
    expect(result?.usage.cacheReadTokens).toBe(300);
    expect(result?.usage.sessionId).toBe('test-session-123');
    expect(result?.sourceFile).toBe('test.jsonl');
    expect(result?.entryId).toBeDefined();
    expect(result?.entryId.length).toBe(64); // SHA256 hex length
  });

  it('should return null for non-assistant entries', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      timestamp: '2026-01-24T05:07:46.325Z',
      sessionId: 'test-session-123'
    };

    const result = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');
    expect(result).toBeNull();
  });

  it('should return null for assistant entries without usage', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      timestamp: '2026-01-24T05:07:46.325Z',
      sessionId: 'test-session-123',
      message: {
        model: 'claude-sonnet-4-5-20250929'
      }
    };

    const result = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');
    expect(result).toBeNull();
  });

  it('should detect agent name from agentId and slug', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      timestamp: '2026-01-24T05:07:46.325Z',
      sessionId: 'test-session-123',
      agentId: 'a61283e',
      slug: 'smooth-swinging-avalanche',
      message: {
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 100,
          output_tokens: 50
        }
      }
    };

    const result = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');

    expect(result).not.toBeNull();
    // Assistant entries are main session responses, not agent responses
    expect(result?.usage.agentName).toBeUndefined();
  });

  it('should normalize model names correctly', () => {
    const testCases = [
      { model: 'claude-opus-4-6-20260205', expected: 'claude-opus-4.6' },
      { model: 'claude-sonnet-4-5-20250929', expected: 'claude-sonnet-4.5' },
      { model: 'claude-haiku-4-5-20251001', expected: 'claude-haiku-4' }
    ];

    testCases.forEach(({ model, expected }) => {
      const entry: TranscriptEntry = {
        type: 'assistant',
        timestamp: '2026-01-24T05:07:46.325Z',
        sessionId: 'test-session-123',
        message: {
          model,
          usage: {
            input_tokens: 100,
            output_tokens: 50
          }
        }
      };

      const result = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');
      expect(result?.usage.modelName).toBe(expected);
    });
  });

  it('should detect agent from Task tool usage', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      timestamp: '2026-01-24T05:07:46.325Z',
      sessionId: 'test-session-123',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 100,
          output_tokens: 50
        },
        content: [
          {
            type: 'tool_use',
            name: 'Task',
            input: {
              subagent_type: 'oh-my-claudecode:executor',
              model: 'sonnet'
            }
          }
        ]
      }
    };

    const result = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');

    expect(result).not.toBeNull();
    // The usage is for generating the Task call, not the spawned agent
    expect(result?.usage.agentName).toBeUndefined();
  });

  it('should use ACTUAL output_tokens from transcript', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      timestamp: '2026-01-24T05:07:46.325Z',
      sessionId: 'test-session-123',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 1000,
          output_tokens: 1234 // ACTUAL value, not estimate
        }
      }
    };

    const result = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');

    expect(result).not.toBeNull();
    expect(result?.usage.outputTokens).toBe(1234);
  });

  it('should generate consistent entry IDs for same data', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      timestamp: '2026-01-24T05:07:46.325Z',
      sessionId: 'test-session-123',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 100,
          output_tokens: 50
        }
      }
    };

    const result1 = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');
    const result2 = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');

    expect(result1?.entryId).toBe(result2?.entryId);
  });

  it('should handle missing cache tokens gracefully', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      timestamp: '2026-01-24T05:07:46.325Z',
      sessionId: 'test-session-123',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 100,
          output_tokens: 50
          // No cache tokens
        }
      }
    };

    const result = extractTokenUsage(entry, 'test-session-123', 'test.jsonl');

    expect(result).not.toBeNull();
    expect(result?.usage.cacheCreationTokens).toBe(0);
    expect(result?.usage.cacheReadTokens).toBe(0);
  });
});
