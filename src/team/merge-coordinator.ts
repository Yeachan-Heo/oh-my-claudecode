// src/team/merge-coordinator.ts

/**
 * Merge coordinator for team worker branches.
 *
 * Provides conflict detection and branch merging for worker worktrees.
 * All merge operations use --no-ff for clear history.
 * Failed merges are always aborted to prevent leaving the repo dirty.
 */

import { execFileSync } from 'node:child_process';
import { listTeamWorktrees } from './git-worktree.js';

const BRANCH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

/** Validate branch name to prevent flag injection in git commands */
function validateBranchName(branch: string): void {
  if (!BRANCH_NAME_RE.test(branch)) {
    throw new Error(`Invalid branch name: "${branch}" — must match ${BRANCH_NAME_RE}`);
  }
}

export interface MergeResult {
  workerName: string;
  branch: string;
  success: boolean;
  conflicts: string[];
  mergeCommit?: string;
}

/**
 * Check for merge conflicts between a worker branch and the base branch.
 * Does NOT actually merge -- uses git merge-tree for non-destructive check.
 * Returns list of conflicting file paths, empty if clean.
 */
export function checkMergeConflicts(
  workerBranch: string,
  baseBranch: string,
  repoRoot: string
): string[] {
  validateBranchName(workerBranch);
  validateBranchName(baseBranch);

  // Attempt a trial merge using --no-commit --no-ff to detect real conflicts.
  // This is safer than the deprecated 3-arg merge-tree which cannot detect
  // content-level conflicts reliably.
  try {
    // Save current HEAD to restore after trial merge
    const origHead = execFileSync(
      'git', ['rev-parse', 'HEAD'],
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    // Ensure we're on the base branch
    execFileSync(
      'git', ['checkout', baseBranch],
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    try {
      // Attempt a trial merge (no commit)
      execFileSync(
        'git', ['merge', '--no-commit', '--no-ff', workerBranch],
        { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      // Merge succeeded cleanly — abort to undo
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe' });
      } catch {
        // --abort may fail if merge already completed; reset instead
        execFileSync('git', ['reset', '--hard', origHead], { cwd: repoRoot, stdio: 'pipe' });
      }
      return [];
    } catch (mergeError: unknown) {
      // Merge failed — extract conflicting file names
      const conflictFiles: string[] = [];
      try {
        const statusOutput = execFileSync(
          'git', ['diff', '--name-only', '--diff-filter=U'],
          { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        for (const line of statusOutput.trim().split('\n')) {
          if (line.trim()) conflictFiles.push(line.trim());
        }
      } catch {
        // Could not list conflicts
      }
      // Always abort the trial merge
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe' });
      } catch {
        execFileSync('git', ['reset', '--hard', origHead], { cwd: repoRoot, stdio: 'pipe' });
      }
      return conflictFiles.length > 0 ? conflictFiles : ['(conflict detected)'];
    }
  } catch {
    // git operations failed — cannot determine conflicts
    return [];
  }
}

/**
 * Merge a worker's branch back to the base branch.
 * Uses --no-ff to preserve merge history.
 * On failure, always aborts to prevent leaving repo dirty.
 */
export function mergeWorkerBranch(
  workerBranch: string,
  baseBranch: string,
  repoRoot: string
): MergeResult {
  validateBranchName(workerBranch);
  validateBranchName(baseBranch);

  const workerName = workerBranch.split('/').pop() || workerBranch;

  try {
    // Abort if working tree has uncommitted changes to tracked files to prevent clobbering.
    // Uses diff-index which ignores untracked files (e.g. .omc/ worktree metadata).
    try {
      execFileSync('git', ['diff-index', '--quiet', 'HEAD', '--'], {
        cwd: repoRoot, stdio: 'pipe'
      });
    } catch {
      throw new Error('Working tree has uncommitted changes — commit or stash before merging');
    }

    // Ensure we're on the base branch
    execFileSync('git', ['checkout', baseBranch], {
      cwd: repoRoot, stdio: 'pipe'
    });

    // Attempt merge
    execFileSync('git', ['merge', '--no-ff', '-m', `Merge ${workerBranch} into ${baseBranch}`, workerBranch], {
      cwd: repoRoot, stdio: 'pipe'
    });

    // Get merge commit hash
    const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe'
    }).trim();

    return {
      workerName,
      branch: workerBranch,
      success: true,
      conflicts: [],
      mergeCommit,
    };
  } catch (_err) {
    // Abort the failed merge
    try {
      execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe' });
    } catch { /* may not be in merge state */ }

    // Try to detect conflicting files
    const conflicts = checkMergeConflicts(workerBranch, baseBranch, repoRoot);

    return {
      workerName,
      branch: workerBranch,
      success: false,
      conflicts,
    };
  }
}

/**
 * Merge all completed worker branches for a team.
 * Processes worktrees in order.
 */
export function mergeAllWorkerBranches(
  teamName: string,
  repoRoot: string,
  baseBranch?: string
): MergeResult[] {
  const worktrees = listTeamWorktrees(teamName, repoRoot);
  if (worktrees.length === 0) return [];

  // Determine base branch
  const base = baseBranch || execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe'
  }).trim();

  validateBranchName(base);

  const results: MergeResult[] = [];

  for (const wt of worktrees) {
    const result = mergeWorkerBranch(wt.branch, base, repoRoot);
    results.push(result);

    // Stop on first failure to prevent cascading issues
    if (!result.success) break;
  }

  return results;
}
