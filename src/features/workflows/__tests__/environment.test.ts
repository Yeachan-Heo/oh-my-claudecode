import { afterEach, describe, expect, it } from 'vitest';

import { parseClaudeVersion, readClaudeCodeVersion } from '../environment.js';

const ORIGINAL = process.env.CLAUDE_CODE_VERSION;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.CLAUDE_CODE_VERSION;
  } else {
    process.env.CLAUDE_CODE_VERSION = ORIGINAL;
  }
});

describe('parseClaudeVersion', () => {
  it('extracts a dotted version from varied CLI output', () => {
    expect(parseClaudeVersion('2.1.160 (Claude Code)')).toBe('2.1.160');
    expect(parseClaudeVersion('claude version v2.2.0\n')).toBe('2.2.0');
  });

  it('returns null when no version is present', () => {
    expect(parseClaudeVersion('no version here')).toBeNull();
    expect(parseClaudeVersion('')).toBeNull();
  });
});

describe('readClaudeCodeVersion', () => {
  it('prefers a parseable CLAUDE_CODE_VERSION env value without probing the CLI', () => {
    process.env.CLAUDE_CODE_VERSION = '2.1.200';
    expect(readClaudeCodeVersion()).toBe('2.1.200');
  });
});
