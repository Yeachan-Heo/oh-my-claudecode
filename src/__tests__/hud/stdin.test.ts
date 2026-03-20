import { describe, expect, it } from 'vitest';

import type { StatuslineStdin } from '../../hud/types.js';
import { getContextPercent, stabilizeContextPercent } from '../../hud/stdin.js';

function makeStdin(overrides: Partial<StatuslineStdin> = {}): StatuslineStdin {
  return {
    cwd: '/tmp/worktree',
    transcript_path: '/tmp/worktree/session.jsonl',
    model: {
      id: 'claude-sonnet',
      display_name: 'Claude Sonnet',
    },
    context_window: {
      context_window_size: 1000,
      current_usage: {
        input_tokens: 520,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides.context_window,
    },
    ...overrides,
  };
}

describe('HUD stdin context percent', () => {
  it('prefers the native percentage when available', () => {
    const stdin = makeStdin({
      context_window: {
        used_percentage: 53.6,
        context_window_size: 1000,
        current_usage: {
          input_tokens: 520,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });

    expect(getContextPercent(stdin)).toBe(54);
  });

  it('reuses the previous native percentage when a transient fallback would cause ctx jitter', () => {
    const previous = makeStdin({
      context_window: {
        used_percentage: 54,
        context_window_size: 1000,
        current_usage: {
          input_tokens: 540,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const current = makeStdin({
      context_window: {
        context_window_size: 1000,
        current_usage: {
          input_tokens: 520,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });

    expect(getContextPercent(current)).toBe(52);
    expect(getContextPercent(stabilizeContextPercent(current, previous))).toBe(54);
  });

  it('does not hide a real context jump when the fallback differs materially', () => {
    const previous = makeStdin({
      context_window: {
        used_percentage: 80,
        context_window_size: 1000,
        current_usage: {
          input_tokens: 800,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const current = makeStdin({
      context_window: {
        context_window_size: 1000,
        current_usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });

    expect(getContextPercent(stabilizeContextPercent(current, previous))).toBe(20);
  });
});
