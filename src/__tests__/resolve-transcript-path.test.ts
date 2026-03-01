/**
 * Tests for resolveTranscriptPath (issues #1094, #1191)
 *
 * Verifies that worktree-mismatched transcript paths are correctly
 * resolved to the original project's transcript path.
 *
 * Covers:
 *   - Claude internal worktrees (.claude/worktrees/X) — issue #1094
 *   - Native git worktrees (git worktree add) — issue #1191
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveTranscriptPath } from '../lib/worktree-paths.js';

describe('resolveTranscriptPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `omc-test-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('returns undefined for undefined input', () => {
    expect(resolveTranscriptPath(undefined)).toBeUndefined();
  });

  it('returns the original path when file exists', () => {
    const filePath = join(tempDir, 'transcript.jsonl');
    writeFileSync(filePath, '{}');
    expect(resolveTranscriptPath(filePath)).toBe(filePath);
  });

  it('returns the original path when no worktree pattern detected', () => {
    const nonExistent = join(tempDir, 'nonexistent', 'transcript.jsonl');
    expect(resolveTranscriptPath(nonExistent)).toBe(nonExistent);
  });

  it('resolves worktree-encoded transcript path to original project path', () => {
    // Simulate: ~/.claude/projects/-Users-user-project/<session>.jsonl (real)
    const projectDir = join(tempDir, 'projects', '-Users-user-project');
    mkdirSync(projectDir, { recursive: true });
    const realTranscript = join(projectDir, 'abc123.jsonl');
    writeFileSync(realTranscript, '{}');

    // Worktree-encoded path that doesn't exist:
    // ~/.claude/projects/-Users-user-project--claude-worktrees-refactor/<session>.jsonl
    const worktreeDir = join(tempDir, 'projects', '-Users-user-project--claude-worktrees-refactor');
    const worktreePath = join(worktreeDir, 'abc123.jsonl');

    const resolved = resolveTranscriptPath(worktreePath);
    expect(resolved).toBe(realTranscript);
  });

  it('resolves worktree paths with complex worktree names', () => {
    const projectDir = join(tempDir, 'projects', '-home-bellman-Workspace-myproject');
    mkdirSync(projectDir, { recursive: true });
    const realTranscript = join(projectDir, 'session-uuid.jsonl');
    writeFileSync(realTranscript, '{}');

    // Worktree with a path-like name (e.g., from OMC project-session-manager)
    const worktreePath = join(
      tempDir,
      'projects',
      '-home-bellman-Workspace-myproject--claude-worktrees-home-bellman-Workspace-omc-worktrees-fix-issue-1094',
      'session-uuid.jsonl',
    );

    const resolved = resolveTranscriptPath(worktreePath);
    expect(resolved).toBe(realTranscript);
  });

  it('resolves worktree paths with simple single-word names', () => {
    const projectDir = join(tempDir, 'projects', '-Users-dev-app');
    mkdirSync(projectDir, { recursive: true });
    const realTranscript = join(projectDir, 'sess.jsonl');
    writeFileSync(realTranscript, '{}');

    const worktreePath = join(
      tempDir,
      'projects',
      '-Users-dev-app--claude-worktrees-feature',
      'sess.jsonl',
    );

    const resolved = resolveTranscriptPath(worktreePath);
    expect(resolved).toBe(realTranscript);
  });

  it('returns original path when resolved path also does not exist', () => {
    // Both worktree and original paths don't exist
    const worktreePath = join(
      tempDir,
      'projects',
      '-missing-project--claude-worktrees-wt',
      'transcript.jsonl',
    );

    const resolved = resolveTranscriptPath(worktreePath);
    expect(resolved).toBe(worktreePath);
  });

  it('handles empty string transcript path', () => {
    expect(resolveTranscriptPath('')).toBeUndefined();
  });

  it('does not modify paths without worktree pattern even if file missing', () => {
    const normalPath = join(tempDir, 'projects', '-Users-user-project', 'missing.jsonl');
    expect(resolveTranscriptPath(normalPath)).toBe(normalPath);
  });

  // --- Native git worktree tests (issue #1191) ---

  describe('native git worktree fallback', () => {
    let mainRepoDir: string;
    let worktreeDir: string;
    let fakeClaudeDir: string;
    let origClaudeConfigDir: string | undefined;

    beforeEach(() => {
      // Save and override CLAUDE_CONFIG_DIR so Strategy 3 finds our fake projects dir
      origClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

      // Create a real git repo with a linked worktree
      mainRepoDir = join(tempDir, 'main-repo');
      mkdirSync(mainRepoDir, { recursive: true });
      execSync('git init', { cwd: mainRepoDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', {
        cwd: mainRepoDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      });

      worktreeDir = join(tempDir, 'linked-worktree');
      execSync(`git worktree add "${worktreeDir}" -b test-branch`, {
        cwd: mainRepoDir,
        stdio: 'pipe',
      });

      // Simulate ~/.claude/projects/ with a transcript at the main repo's encoded path
      fakeClaudeDir = join(tempDir, 'fake-claude');
      process.env.CLAUDE_CONFIG_DIR = fakeClaudeDir;
      const encodedMain = mainRepoDir.replace(/[/\\]/g, '-');
      const projectDir = join(fakeClaudeDir, 'projects', encodedMain);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'session-abc.jsonl'), '{}');
    });

    afterEach(() => {
      // Restore CLAUDE_CONFIG_DIR
      if (origClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origClaudeConfigDir;
      }

      // Clean up worktree before the main afterEach removes tempDir
      try {
        execSync(`git worktree remove "${worktreeDir}" --force`, {
          cwd: mainRepoDir,
          stdio: 'pipe',
        });
      } catch {
        // ignore
      }
    });

    it('resolves transcript path from native git worktree to main repo (issue #1191)', () => {
      // The worktree-encoded transcript path (does not exist)
      const encodedWorktree = worktreeDir.replace(/[/\\]/g, '-');
      const worktreePath = join(fakeClaudeDir, 'projects', encodedWorktree, 'session-abc.jsonl');

      const resolved = resolveTranscriptPath(worktreePath, worktreeDir);
      const encodedMain = mainRepoDir.replace(/[/\\]/g, '-');
      const expectedPath = join(fakeClaudeDir, 'projects', encodedMain, 'session-abc.jsonl');

      expect(resolved).toBe(expectedPath);
    });

    it('does not alter path when CWD is the main repo (not a worktree)', () => {
      const encodedMain = mainRepoDir.replace(/[/\\]/g, '-');
      const mainPath = join(fakeClaudeDir, 'projects', encodedMain, 'session-abc.jsonl');

      // Path exists and CWD is the main repo — should return as-is
      const resolved = resolveTranscriptPath(mainPath, mainRepoDir);
      expect(resolved).toBe(mainPath);
    });

    it('returns original path when main repo transcript also missing', () => {
      const encodedWorktree = worktreeDir.replace(/[/\\]/g, '-');
      // Use a session file that doesn't exist at the main repo path either
      const worktreePath = join(fakeClaudeDir, 'projects', encodedWorktree, 'nonexistent.jsonl');

      const resolved = resolveTranscriptPath(worktreePath, worktreeDir);
      expect(resolved).toBe(worktreePath);
    });
  });
});
