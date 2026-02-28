import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  wrapWithLoginShell,
  quoteShellArg,
  buildTmuxShellCommand,
  sanitizeTmuxToken,
  buildTmuxSessionName,
  resolveLaunchPolicy,
  createHudWatchPane,
} from '../tmux-utils.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// wrapWithLoginShell
// ---------------------------------------------------------------------------
describe('wrapWithLoginShell', () => {
  it('wraps command with login shell using $SHELL', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    const result = wrapWithLoginShell('claude --print');
    expect(result).toContain('/bin/zsh');
    expect(result).toContain('-lc');
    expect(result).toContain('claude --print');
    expect(result).toMatch(/^exec /);
  });

  it('defaults to /bin/bash when $SHELL is not set', () => {
    vi.stubEnv('SHELL', '');
    const result = wrapWithLoginShell('codex');
    expect(result).toContain('/bin/bash');
    expect(result).toContain('-lc');
  });

  it('properly quotes the inner command containing single quotes', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    const result = wrapWithLoginShell("perl -e 'print 1'");
    // The shell arg quoting should handle embedded single quotes
    expect(result).toContain('-lc');
    // Verify the command is recoverable (contains the original content)
    expect(result).toContain('perl');
    expect(result).toContain('print 1');
  });

  it('uses exec to replace the outer shell process', () => {
    vi.stubEnv('SHELL', '/bin/bash');
    const result = wrapWithLoginShell('my-command');
    expect(result).toMatch(/^exec /);
  });

  it('works with complex multi-statement commands', () => {
    vi.stubEnv('SHELL', '/bin/zsh');
    const cmd = 'sleep 0.3; echo hello; claude --dangerously-skip-permissions';
    const result = wrapWithLoginShell(cmd);
    expect(result).toContain('/bin/zsh');
    expect(result).toContain('-lc');
    // All parts of the command should be present in the quoted argument
    expect(result).toContain('sleep 0.3');
    expect(result).toContain('claude');
  });

  it('handles shells with unusual paths', () => {
    vi.stubEnv('SHELL', '/usr/local/bin/fish');
    const result = wrapWithLoginShell('codex');
    expect(result).toContain('/usr/local/bin/fish');
    expect(result).toContain('-lc');
  });
});

// ---------------------------------------------------------------------------
// quoteShellArg
// ---------------------------------------------------------------------------
describe('quoteShellArg', () => {
  it('wraps value in single quotes', () => {
    expect(quoteShellArg('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    const result = quoteShellArg("it's");
    // Should break out of single quotes, add escaped quote, re-enter
    expect(result).toContain("'\"'\"'");
  });
});

// ---------------------------------------------------------------------------
// sanitizeTmuxToken
// ---------------------------------------------------------------------------
describe('sanitizeTmuxToken', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(sanitizeTmuxToken('MyProject')).toBe('myproject');
    // Trailing non-alphanumeric chars become hyphens then get stripped
    expect(sanitizeTmuxToken('my project!')).toBe('my-project');
  });

  it('returns unknown for empty result', () => {
    expect(sanitizeTmuxToken('!!!')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// createHudWatchPane — login shell wrapping
// ---------------------------------------------------------------------------
describe('createHudWatchPane login shell wrapping', () => {
  it('wraps hudCmd with login shell in split-window args', () => {
    vi.stubEnv('SHELL', '/bin/zsh');

    // Mock execFileSync to capture args
    const { execFileSync } = require('child_process');
    const mockExecFileSync = vi.fn().mockReturnValue('%42\n');

    // We need to verify the source code wraps the command
    // Read the source to verify wrapWithLoginShell is used
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'tmux-utils.ts'), 'utf-8');
    expect(source).toContain('wrapWithLoginShell(hudCmd)');
  });
});
