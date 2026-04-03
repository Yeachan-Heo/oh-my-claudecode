/**
 * OMC HUD - Git Elements
 *
 * Renders git repository name and branch information.
 */

import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { dim, cyan } from '../colors.js';

const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface WorktreeDetection {
  isWorktree: boolean;
  worktreeName: string | null;
}

const repoCache = new Map<string, CacheEntry<string | null>>();
const branchCache = new Map<string, CacheEntry<string | null>>();
const worktreeCache = new Map<string, CacheEntry<WorktreeDetection>>();

/**
 * Clear all git caches. Call in tests beforeEach to ensure a clean slate.
 */
export function resetGitCache(): void {
  repoCache.clear();
  branchCache.clear();
  worktreeCache.clear();
}

/**
 * Get git repository name from remote URL.
 * Extracts the repo name from URLs like:
 * - https://github.com/user/repo.git
 * - git@github.com:user/repo.git
 *
 * @param cwd - Working directory to run git command in
 * @returns Repository name or null if not available
 */
export function getGitRepoName(cwd?: string): string | null {
  const key = cwd ? resolve(cwd) : process.cwd();
  const cached = repoCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  let result: string | null = null;
  try {
    const url = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
    }).trim();

    if (!url) {
      result = null;
    } else {
      // Extract repo name from URL
      // Handles: https://github.com/user/repo.git, git@github.com:user/repo.git
      const match = url.match(/\/([^/]+?)(?:\.git)?$/) || url.match(/:([^/]+?)(?:\.git)?$/);
      result = match ? match[1].replace(/\.git$/, '') : null;
    }
  } catch {
    result = null;
  }

  repoCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Get current git branch name.
 *
 * @param cwd - Working directory to run git command in
 * @returns Branch name or null if not available
 */
export function getGitBranch(cwd?: string): string | null {
  const key = cwd ? resolve(cwd) : process.cwd();
  const cached = branchCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  let result: string | null = null;
  try {
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
    }).trim();

    result = branch || null;
  } catch {
    result = null;
  }

  branchCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Detect if the current directory is inside a git linked worktree.
 * Compares --git-dir with --git-common-dir; they differ in linked worktrees.
 * When in a worktree, extracts the worktree name from the git-dir path.
 *
 * @param cwd - Working directory
 * @returns Worktree detection result (cached for CACHE_TTL_MS)
 */
export function getWorktreeInfo(cwd?: string): WorktreeDetection {
  const key = cwd ? resolve(cwd) : process.cwd();
  const cached = worktreeCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const execOpts = {
    cwd,
    encoding: 'utf-8' as BufferEncoding,
    timeout: 1000,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
  };

  let result: WorktreeDetection = { isWorktree: false, worktreeName: null };
  try {
    const gitDir = (execSync('git rev-parse --git-dir', execOpts) as string).trim();
    const gitCommonDir = (execSync('git rev-parse --git-common-dir', execOpts) as string).trim();

    // Canonicalize via realpathSync to handle symlinked repo paths
    let resolvedGitDir = resolve(key, gitDir);
    let resolvedCommonDir = resolve(key, gitCommonDir);
    try { resolvedGitDir = realpathSync(resolvedGitDir); } catch { /* use resolved */ }
    try { resolvedCommonDir = realpathSync(resolvedCommonDir); } catch { /* use resolved */ }

    if (resolvedGitDir !== resolvedCommonDir) {
      // Extract worktree name from gitDir path (e.g. /repo/.git/worktrees/my-wt → my-wt)
      result = { isWorktree: true, worktreeName: basename(resolvedGitDir) };
    }
  } catch {
    // Not in a git repo or command failed
  }

  worktreeCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Render git repository name element.
 *
 * @param cwd - Working directory
 * @returns Formatted repo name or null
 */
export function renderGitRepo(cwd?: string): string | null {
  const repo = getGitRepoName(cwd);
  if (!repo) return null;
  return `${dim('repo:')}${cyan(repo)}`;
}

/**
 * Render git branch element.
 * When inside a linked worktree, appends the worktree name as suffix:
 *   branch:feature-x (wt:my-wt)
 *
 * @param cwd - Working directory
 * @returns Formatted branch name or null
 */
export function renderGitBranch(cwd?: string): string | null {
  const branch = getGitBranch(cwd);
  if (!branch) return null;

  const wtInfo = getWorktreeInfo(cwd);
  if (wtInfo.isWorktree && wtInfo.worktreeName) {
    return `${dim('branch:')}${cyan(branch)} ${dim('(wt:')}${cyan(wtInfo.worktreeName)}${dim(')')}`;
  }

  return `${dim('branch:')}${cyan(branch)}`;
}
