/**
 * OMC HUD - Worktree Element
 *
 * Displays the current git worktree name when running inside a linked worktree
 * (created via `git worktree add` or `omc teleport`). Returns null in the main repo.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dim, yellow } from '../colors.js';

const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const worktreeCache = new Map<string, CacheEntry<string | null>>();

/**
 * Clear worktree cache. Call in tests beforeEach to ensure a clean slate.
 */
export function resetWorktreeCache(): void {
  worktreeCache.clear();
}

/**
 * Detect whether the cwd is inside a linked git worktree and return its name.
 *
 * A linked worktree has a git-dir of the form:
 *   /path/to/main-repo/.git/worktrees/<name>
 *
 * The main working tree has a git-dir of simply `.git` (relative) or
 * `/path/to/repo/.git` (absolute) with no `worktrees/` segment.
 *
 * @param cwd - Working directory to check (defaults to process.cwd())
 * @returns Worktree name, or null when in the main repo or not in git
 */
export function getWorktreeName(cwd?: string): string | null {
  const key = cwd ? resolve(cwd) : process.cwd();
  const cached = worktreeCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  let result: string | null = null;
  try {
    const gitDir = execSync('git rev-parse --git-dir', {
      cwd,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
    }).trim();

    // Linked worktrees have a git-dir ending in .git/worktrees/<name>
    const match = gitDir.match(/[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);
    result = match ? match[1] : null;
  } catch {
    result = null;
  }

  worktreeCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Render the worktree indicator element.
 *
 * Shows `wt:<name>` when inside a linked worktree, null otherwise.
 *
 * @param cwd - Working directory
 * @returns Formatted worktree indicator or null
 */
export function renderWorktree(cwd?: string): string | null {
  const name = getWorktreeName(cwd);
  if (!name) return null;
  return `${dim('wt:')}${yellow(name)}`;
}
