/**
 * GitHub Star Module
 *
 * Handles auto-starring of the oh-my-claudecode repository during setup.
 */

import { execSync, ExecSyncOptions } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface StarResult {
  starred: boolean;
  message: string;
  action?: 'already_starred' | 'newly_starred' | 'skipped' | 'failed';
}

export type ExecFunction = typeof execSync;

export interface GitHubStarOptions {
  repo?: string;
  silent?: boolean;
  execFn?: ExecFunction;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_REPO = 'Yeachan-Heo/oh-my-claudecode';
const EXEC_OPTIONS: ExecSyncOptions = { stdio: 'ignore' };

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if gh CLI is available
 */
export function isGhCliAvailable(execFn: ExecFunction = execSync): boolean {
  try {
    execFn('gh --version', EXEC_OPTIONS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if repository is already starred
 */
export function isRepoStarred(
  repo: string,
  execFn: ExecFunction = execSync
): boolean {
  try {
    execFn(`gh api user/starred/${repo}`, EXEC_OPTIONS);
    return true;
  } catch (error) {
    // 404 means not starred, other errors should be treated as not starred
    return false;
  }
}

/**
 * Star the repository
 */
export function starRepository(
  repo: string,
  execFn: ExecFunction = execSync
): boolean {
  try {
    execFn(`gh api --method PUT user/starred/${repo}`, EXEC_OPTIONS);
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Auto-star oh-my-claudecode repository if not already starred
 *
 * @param options - Configuration options
 * @returns Star result with status and message
 */
export function autoStarRepository(
  options: GitHubStarOptions = {}
): StarResult {
  const {
    repo = DEFAULT_REPO,
    silent = false,
    execFn = execSync,
  } = options;

  // Check if gh CLI is available
  if (!isGhCliAvailable(execFn)) {
    return {
      starred: false,
      message: silent ? '' : 'gh CLI not available',
      action: 'skipped',
    };
  }

  // Check if already starred
  if (isRepoStarred(repo, execFn)) {
    return {
      starred: true,
      message: silent ? '' : 'Already starred',
      action: 'already_starred',
    };
  }

  // Star the repository
  const success = starRepository(repo, execFn);
  if (success) {
    return {
      starred: true,
      message: '⭐ Starred oh-my-claudecode repository! Thank you for your support!',
      action: 'newly_starred',
    };
  } else {
    return {
      starred: false,
      message: silent ? '' : 'Failed to star repository',
      action: 'failed',
    };
  }
}
