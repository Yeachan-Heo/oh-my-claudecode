/**
 * Tests for resolveTranscriptPath (issue #1094)
 *
 * Verifies that worktree-mismatched transcript paths are correctly
 * resolved to the original project's transcript path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
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
});
