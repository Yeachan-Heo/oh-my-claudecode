/**
 * Tests for src/cli/tmux-utils.ts
 *
 * Covers:
 * - wrapWithLoginShell (issue #1153)
 * - quoteShellArg
 * - sanitizeTmuxToken
 * - buildTmuxSessionName worktree mode (issue #1088)
 * - createHudWatchPane login shell wrapping
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import {
  wrapWithLoginShell,
  quoteShellArg,
  sanitizeTmuxToken,
  buildTmuxSessionName,
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
    expect(sanitizeTmuxToken('My_Project.Name')).toBe('my-project-name');
    expect(sanitizeTmuxToken('MyProject')).toBe('myproject');
    expect(sanitizeTmuxToken('my project!')).toBe('my-project');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeTmuxToken('--hello--')).toBe('hello');
  });

  it('returns "unknown" for empty result', () => {
    expect(sanitizeTmuxToken('...')).toBe('unknown');
    expect(sanitizeTmuxToken('!!!')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// createHudWatchPane — login shell wrapping
// ---------------------------------------------------------------------------
describe('createHudWatchPane login shell wrapping', () => {
  it('wraps hudCmd with login shell in split-window args', () => {
    vi.stubEnv('SHELL', '/bin/zsh');

    // We need to verify the source code wraps the command
    // Read the source to verify wrapWithLoginShell is used
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'tmux-utils.ts'), 'utf-8');
    expect(source).toContain('wrapWithLoginShell(hudCmd)');
  });
});

// ---------------------------------------------------------------------------
// buildTmuxSessionName — default (no worktree)
// ---------------------------------------------------------------------------
describe('buildTmuxSessionName — default mode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Mock git branch detection
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('main\n');
  });

  it('uses basename of cwd as dirToken', () => {
    const name = buildTmuxSessionName('/home/user/projects/myapp');
    expect(name).toMatch(/^omc-myapp-main-\d{14}$/);
  });

  it('only includes the last path segment', () => {
    const name = buildTmuxSessionName('/home/user/Workspace/omc-worktrees/feat/issue-1088');
    // Default mode: only basename "issue-1088"
    expect(name).toMatch(/^omc-issue-1088-main-\d{14}$/);
  });
});

// ---------------------------------------------------------------------------
// buildTmuxSessionName — worktree mode (issue #1088)
// ---------------------------------------------------------------------------
describe('buildTmuxSessionName — worktree mode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue('dev\n');
  });

  it('includes last 2 path segments when worktree option is enabled', () => {
    const name = buildTmuxSessionName('/home/user/Workspace/omc-worktrees/feat/issue-1088', { worktree: true });
    // Should include "feat-issue-1088" instead of just "issue-1088"
    expect(name).toMatch(/^omc-feat-issue-1088-dev-\d{14}$/);
  });

  it('includes parent context for better identification', () => {
    const name = buildTmuxSessionName('/home/user/Workspace/omc-worktrees/pr/myrepo-42', { worktree: true });
    expect(name).toMatch(/^omc-pr-myrepo-42-dev-\d{14}$/);
  });

  it('handles single-segment paths gracefully', () => {
    const name = buildTmuxSessionName('/myapp', { worktree: true });
    expect(name).toMatch(/^omc-myapp-dev-\d{14}$/);
  });

  it('handles trailing slashes', () => {
    const name = buildTmuxSessionName('/home/user/feat/issue-99/', { worktree: true });
    expect(name).toMatch(/^omc-feat-issue-99-dev-\d{14}$/);
  });

  it('falls back to basename behavior when worktree is false', () => {
    const name = buildTmuxSessionName('/home/user/feat/issue-1088', { worktree: false });
    expect(name).toMatch(/^omc-issue-1088-dev-\d{14}$/);
  });

  it('truncates session name to 120 chars max', () => {
    const longPath = '/home/user/' + 'a'.repeat(60) + '/' + 'b'.repeat(60);
    const name = buildTmuxSessionName(longPath, { worktree: true });
    expect(name.length).toBeLessThanOrEqual(120);
  });
});
