import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoresearchCommand, normalizeAutoresearchClaudeArgs, parseAutoresearchArgs, AUTORESEARCH_HELP } from '../autoresearch.js';

describe('normalizeAutoresearchClaudeArgs', () => {
  it('returns the provided args unchanged for the deprecated shim', () => {
    expect(normalizeAutoresearchClaudeArgs(['--model', 'opus'])).toEqual(['--model', 'opus']);
  });
});

describe('parseAutoresearchArgs', () => {
  it('marks empty invocation as deprecated', () => {
    expect(parseAutoresearchArgs([])).toEqual({ args: [], deprecated: true });
  });

  it('preserves arbitrary legacy args without attempting runtime parsing', () => {
    expect(parseAutoresearchArgs(['--mission', 'Improve onboarding', '--eval', 'npm run eval'])).toEqual({
      args: ['--mission', 'Improve onboarding', '--eval', 'npm run eval'],
      deprecated: true,
    });
  });

  it('publishes hard-deprecation guidance', () => {
    expect(AUTORESEARCH_HELP).toContain('HARD DEPRECATED');
    expect(AUTORESEARCH_HELP).toContain('/deep-interview --autoresearch');
    expect(AUTORESEARCH_HELP).toContain('/oh-my-claudecode:autoresearch');
    expect(AUTORESEARCH_HELP).toContain('single-mission only');
    expect(AUTORESEARCH_HELP).toContain('max-runtime ceiling');
  });
});

describe('autoresearchCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the deprecation message for no args', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await autoresearchCommand([]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain('HARD DEPRECATED');
  });

  it('prints the deprecation message and echoes received legacy args', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await autoresearchCommand(['--resume', 'old-run']);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toContain('Received legacy arguments: --resume old-run');
    expect(logSpy.mock.calls[0]?.[0]).toContain('/oh-my-claudecode:autoresearch');
  });
});
