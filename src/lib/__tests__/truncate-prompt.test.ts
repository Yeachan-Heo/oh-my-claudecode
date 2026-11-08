import { describe, it, expect } from 'vitest';
import {
  truncatePromptForEcho,
  DEFAULT_PROMPT_ECHO_MAX_CHARS,
} from '../truncate-prompt.js';

describe('truncatePromptForEcho', () => {
  it('returns short prompts unchanged', () => {
    expect(truncatePromptForEcho('Fix the bug')).toBe('Fix the bug');
  });

  it('returns prompt exactly at the limit unchanged', () => {
    const exact = 'x'.repeat(DEFAULT_PROMPT_ECHO_MAX_CHARS);
    expect(truncatePromptForEcho(exact)).toBe(exact);
  });

  it('truncates prompts that exceed the limit and appends ellipsis', () => {
    const long = 'a'.repeat(DEFAULT_PROMPT_ECHO_MAX_CHARS + 50);
    const result = truncatePromptForEcho(long);
    expect(result).toBe('a'.repeat(DEFAULT_PROMPT_ECHO_MAX_CHARS) + '…');
  });

  it('result length is maxChars + 1 (the ellipsis char) for over-limit input', () => {
    const long = 'b'.repeat(500);
    const result = truncatePromptForEcho(long);
    // "…" is a single Unicode character
    expect([...result].length).toBe(DEFAULT_PROMPT_ECHO_MAX_CHARS + 1);
  });

  it('trims surrounding whitespace before checking length', () => {
    const padded = '  hello world  ';
    expect(truncatePromptForEcho(padded)).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(truncatePromptForEcho('')).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(truncatePromptForEcho('   ')).toBe('');
  });

  it('respects a custom maxChars parameter', () => {
    const result = truncatePromptForEcho('Hello World', 5);
    expect(result).toBe('Hello…');
  });

  it('custom maxChars: returns unchanged when input is within limit', () => {
    expect(truncatePromptForEcho('Hi', 5)).toBe('Hi');
  });

  it('truncates a realistic multi-paragraph ralph task prompt', () => {
    const realistic =
      'Fix issue #2542 in /home/user/project. Stop-hook feedback for ' +
      'ralph/ultrawork is reinjecting full task prompts and wasting context. ' +
      'Add a shared truncation helper so stop-hook task echoes are capped to ' +
      'a compact length, preserve enough task identity to stay useful, add ' +
      'regression tests for long prompts in the affected modes, run focused ' +
      'tests, commit, push, and open a PR against dev.';
    const result = truncatePromptForEcho(realistic);
    expect([...result].length).toBe(DEFAULT_PROMPT_ECHO_MAX_CHARS + 1);
    expect(result.endsWith('…')).toBe(true);
    // Should still contain enough identity info from the start
    expect(result.startsWith('Fix issue #2542')).toBe(true);
  });
});
