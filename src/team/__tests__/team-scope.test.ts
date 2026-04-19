import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { getWorktreeScopeToken, SCOPE_ENV_VAR, isValidScopeToken } from '../team-scope.js';

describe('getWorktreeScopeToken', () => {
  const TOKEN_RE = /^[0-9a-f]{8}$/;

  beforeEach(() => {
    delete process.env[SCOPE_ENV_VAR];
  });

  afterEach(() => {
    delete process.env[SCOPE_ENV_VAR];
  });

  it('produces a token matching /^[0-9a-f]{8}$/', () => {
    const token = getWorktreeScopeToken('/tmp/example/worktree-a');
    expect(token).toMatch(TOKEN_RE);
  });

  it('is stable across calls with the same input', () => {
    const a = getWorktreeScopeToken('/tmp/example/worktree-a');
    const b = getWorktreeScopeToken('/tmp/example/worktree-a');
    expect(a).toBe(b);
  });

  it('produces different tokens for different worktree paths', () => {
    const a = getWorktreeScopeToken('/tmp/example/worktree-a');
    const b = getWorktreeScopeToken('/tmp/example/worktree-b');
    expect(a).not.toBe(b);
  });

  it('falls back to a non-empty token when workingDirectory is undefined', () => {
    const token = getWorktreeScopeToken();
    expect(token).toMatch(TOKEN_RE);
  });

  it('honors OMC_TEAM_SCOPE_TOKEN env var when well-formed', () => {
    process.env[SCOPE_ENV_VAR] = 'deadbeef';
    expect(getWorktreeScopeToken('/tmp/anything')).toBe('deadbeef');
    expect(getWorktreeScopeToken()).toBe('deadbeef');
  });

  it('ignores OMC_TEAM_SCOPE_TOKEN when malformed', () => {
    process.env[SCOPE_ENV_VAR] = 'NOT-HEX';
    const token = getWorktreeScopeToken('/tmp/example/worktree-a');
    expect(token).toMatch(TOKEN_RE);
    expect(token).not.toBe('NOT-HEX');
  });

  it('isValidScopeToken accepts 8-hex strings only', () => {
    expect(isValidScopeToken('deadbeef')).toBe(true);
    expect(isValidScopeToken('DEADBEEF')).toBe(false);
    expect(isValidScopeToken('deadbeef0')).toBe(false);
    expect(isValidScopeToken('zzzzzzzz')).toBe(false);
    expect(isValidScopeToken(undefined)).toBe(false);
  });

  describe('with real git worktrees', () => {
    let primaryRoot: string;
    let linkedRoot: string;

    beforeEach(() => {
      primaryRoot = mkdtempSync(join(tmpdir(), 'team-scope-primary-'));
      execFileSync('git', ['init', '-q'], { cwd: primaryRoot, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: primaryRoot, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: primaryRoot, stdio: 'pipe' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: primaryRoot, stdio: 'pipe' });

      linkedRoot = primaryRoot + '-linked';
      execFileSync(
        'git',
        ['worktree', 'add', '-b', 'feat/scope-test', linkedRoot],
        { cwd: primaryRoot, stdio: 'pipe' }
      );
    });

    afterEach(() => {
      try { execFileSync('git', ['worktree', 'remove', '--force', linkedRoot], { cwd: primaryRoot, stdio: 'pipe' }); } catch { /* ignore */ }
      try { rmSync(linkedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(primaryRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('yields different tokens for primary and linked worktrees of the same repo', () => {
      const tokenPrimary = getWorktreeScopeToken(primaryRoot);
      const tokenLinked = getWorktreeScopeToken(linkedRoot);
      expect(tokenPrimary).toMatch(TOKEN_RE);
      expect(tokenLinked).toMatch(TOKEN_RE);
      expect(tokenPrimary).not.toBe(tokenLinked);
    });
  });
});
