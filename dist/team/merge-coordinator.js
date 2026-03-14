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
function validateBranchName(branch) {
    if (!BRANCH_NAME_RE.test(branch)) {
        throw new Error(`Invalid branch name: "${branch}" — must match ${BRANCH_NAME_RE}`);
    }
}
/**
 * Check for merge conflicts between a worker branch and the base branch.
 * Does NOT actually merge -- uses git merge-tree for non-destructive check.
 * Returns list of conflicting file paths, empty if clean.
 */
export function checkMergeConflicts(workerBranch, baseBranch, repoRoot) {
    validateBranchName(workerBranch);
    validateBranchName(baseBranch);
    // Use git merge-tree to detect actual content conflicts (not just overlapping files)
    try {
        const mergeBase = execFileSync('git', ['merge-base', baseBranch, workerBranch], { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const result = execFileSync('git', ['merge-tree', mergeBase, baseBranch, workerBranch], { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        // Parse merge-tree output: conflicts are indicated by lines starting with "<<"
        const conflictFiles = [];
        const lines = result.split('\n');
        for (const line of lines) {
            // merge-tree outputs conflict markers; look for "+<< " or changed/added entries with mode conflicts
            const match = line.match(/^<<.*$/);
            if (match) {
                // Extract filename from surrounding context — look for "our" / "their" file lines
                continue;
            }
            // Conflict sections contain lines like: "  our    100644 <hash> <path>"
            // A simpler approach: if merge-tree output contains "<<<<<<", there are conflicts
        }
        // If merge-tree output contains conflict markers, extract file paths
        // The 3-way merge-tree outputs the merged content with conflict markers inline
        if (result.includes('<<<<<<<')) {
            // Extract file paths from the merge-tree "changed in both" sections
            const fileMatches = result.match(/^@@.*@@\s*(.+)$/gm);
            if (fileMatches) {
                for (const m of fileMatches) {
                    const path = m.replace(/^@@.*@@\s*/, '').trim();
                    if (path)
                        conflictFiles.push(path);
                }
            }
            // If we detected conflict markers but couldn't parse filenames, report generic conflict
            if (conflictFiles.length === 0) {
                return ['<unable to determine specific files>'];
            }
            return conflictFiles;
        }
        return []; // No conflict markers = clean merge
    }
    catch {
        // If merge-tree fails, fall back to the actual merge check via mergeWorkerBranch
        return [];
    }
}
/**
 * Merge a worker's branch back to the base branch.
 * Uses --no-ff to preserve merge history.
 * On failure, always aborts to prevent leaving repo dirty.
 */
export function mergeWorkerBranch(workerBranch, baseBranch, repoRoot) {
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
        }
        catch {
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
    }
    catch (_err) {
        // Abort the failed merge
        try {
            execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe' });
        }
        catch { /* may not be in merge state */ }
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
export function mergeAllWorkerBranches(teamName, repoRoot, baseBranch) {
    const worktrees = listTeamWorktrees(teamName, repoRoot);
    if (worktrees.length === 0)
        return [];
    // Determine base branch
    const base = baseBranch || execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe'
    }).trim();
    validateBranchName(base);
    const results = [];
    for (const wt of worktrees) {
        const result = mergeWorkerBranch(wt.branch, base, repoRoot);
        results.push(result);
        // Stop on first failure to prevent cascading issues
        if (!result.success)
            break;
    }
    return results;
}
//# sourceMappingURL=merge-coordinator.js.map