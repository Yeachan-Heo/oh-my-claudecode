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
const EXEC_OPTIONS: ExecSyncOptions = {
  stdio: 'ignore',
  timeout: 3000, // 3 second timeout to prevent hanging
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate repository format (owner/repo)
 */
function validateRepo(repo: string): boolean {
  return /^[a-zA-Z0-9-]+\/[a-zA-Z0-9-_\.]+$/.test(repo);
}

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
  if (!validateRepo(repo)) {
    if (process.env.DEBUG) {
      console.error('[GitHub Star] Invalid repository format:', repo);
    }
    return false;
  }

  try {
    execFn(`gh api user/starred/${repo}`, EXEC_OPTIONS);
    return true;
  } catch (error) {
    // 404 means not starred, other errors should be treated as not starred
    if (process.env.DEBUG && error instanceof Error) {
      console.error('[GitHub Star] Check star status failed:', error.message);
    }
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
  if (!validateRepo(repo)) {
    if (process.env.DEBUG) {
      console.error('[GitHub Star] Invalid repository format:', repo);
    }
    return false;
  }

  try {
    execFn(`gh api --method PUT user/starred/${repo}`, EXEC_OPTIONS);
    return true;
  } catch (error) {
    if (process.env.DEBUG && error instanceof Error) {
      console.error('[GitHub Star] Star repository failed:', error.message);
    }
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
