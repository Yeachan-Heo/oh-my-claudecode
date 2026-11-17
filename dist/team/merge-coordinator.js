// src/team/merge-coordinator.ts
/**
 * Merge coordinator for team worker branches.
 *
 * Provides conflict detection and branch merging for worker worktrees.
 * All merge operations use --no-ff for clear history.
 * Failed merges are always aborted to prevent leaving the repo dirty.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { listTeamWorktrees } from './git-worktree.js';
const BRANCH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;
/**
 * Validate branch name to prevent flag injection in git commands.
 * Exported so other modules (e.g. merge-orchestrator) can guard branch names
 * before passing them to `git fetch/reset/rebase/rev-parse`.
 */
export function validateBranchName(branch) {
    if (!BRANCH_NAME_RE.test(branch)) {
        throw new Error(`Invalid branch name: "${branch}" — must match ${BRANCH_NAME_RE}`);
    }
}
/**
 * Harness overlay files that OMC writes into every worker worktree
 * (AGENTS.md and the .claude/ settings overlay). They are infrastructure,
 * not task output, and differ per worker — so the auto-merge / auto-rebase
 * fan-out collides on them (`UU AGENTS.md`) even when the actual task files
 * are disjoint. See issue #3224.
 */
export const HARNESS_MERGE_PATHS = ['AGENTS.md', '.claude/**'];
/**
 * Configure a trivial `merge=ours` driver for harness overlay files so the
 * team auto-merge / auto-rebase never conflicts on infrastructure (#3224).
 *
 * Registers the built-in-style `ours` driver (`true` keeps the current
 * version and exits 0) and writes `<path> merge=ours` lines into the repo's
 * shared `info/attributes`. Both apply across every linked worktree because
 * worktrees share the common git dir, so a single call from a team merge
 * entry point covers the merger worktree and all worker worktrees.
 *
 * Idempotent: re-registers the driver (a no-op set) and only appends
 * attribute lines that are not already present.
 */
export function configureHarnessMergeAttributes(repoRoot) {
    // Register the trivial "ours" merge driver. `true` always succeeds and
    // leaves the current (HEAD-side) content in place.
    execFileSync('git', ['config', 'merge.ours.driver', 'true'], {
        cwd: repoRoot,
        stdio: 'pipe',
        windowsHide: true,
    });
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        windowsHide: true,
    }).trim();
    const resolvedCommonDir = isAbsolute(commonDir) ? commonDir : join(repoRoot, commonDir);
    const infoDir = join(resolvedCommonDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const attrPath = join(infoDir, 'attributes');
    let existing = '';
    try {
        existing = readFileSync(attrPath, 'utf-8');
    }
    catch {
        // No attributes file yet — start fresh.
    }
    const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
    const missing = HARNESS_MERGE_PATHS.map((p) => `${p} merge=ours`).filter((line) => !existingLines.has(line));
    if (missing.length === 0)
        return;
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(attrPath, `${prefix}${missing.join('\n')}\n`, 'utf-8');
}
/**
 * Check for merge conflicts between a worker branch and the base branch.
 * Does NOT actually merge — uses `git merge-tree --write-tree` (Git 2.38+)
 * for non-destructive three-way merge simulation.
 * Falls back to file-overlap heuristic on older Git versions.
 * Returns list of conflicting file paths, empty if clean.
 */
export function checkMergeConflicts(workerBranch, baseBranch, repoRoot) {
    validateBranchName(workerBranch);
    validateBranchName(baseBranch);
    // Try git merge-tree --write-tree (Git 2.38+) for accurate conflict detection
    try {
        execFileSync('git', ['merge-tree', '--write-tree', baseBranch, workerBranch], { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        // Exit code 0 means no conflicts
        return [];
    }
    catch (err) {
        const error = err;
        if (error.status === 1 && typeof error.stdout === 'string') {
            // Exit code 1 means conflicts — parse conflicting file paths from output
            const lines = error.stdout.split('\n');
            const conflicts = [];
            for (const line of lines) {
                const match = line.match(/^CONFLICT\s.*?:\s+.*?\s+in\s+(.+)$/);
                if (match) {
                    conflicts.push(match[1].trim());
                }
            }
            return conflicts.length > 0 ? conflicts : ['(merge-tree reported conflicts)'];
        }
        // If merge-tree --write-tree is not supported, fall back to overlap heuristic
    }
    // Fallback: file-overlap heuristic for Git < 2.38
    const mergeBase = execFileSync('git', ['merge-base', baseBranch, workerBranch], { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
    const baseDiff = execFileSync('git', ['diff', '--name-only', mergeBase, baseBranch], { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
    const workerDiff = execFileSync('git', ['diff', '--name-only', mergeBase, workerBranch], { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim();
    if (!baseDiff || !workerDiff) {
        return [];
    }
    const baseFiles = new Set(baseDiff.split('\n').filter(f => f));
    const workerFiles = workerDiff.split('\n').filter(f => f);
    return workerFiles.filter(f => baseFiles.has(f));
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
                cwd: repoRoot, stdio: 'pipe', windowsHide: true
            });
        }
        catch {
            throw new Error('Working tree has uncommitted changes — commit or stash before merging');
        }
        // Ensure we're on the base branch
        execFileSync('git', ['checkout', baseBranch], {
            cwd: repoRoot, stdio: 'pipe', windowsHide: true
        });
        // Attempt merge
        execFileSync('git', ['merge', '--no-ff', '-m', `Merge ${workerBranch} into ${baseBranch}`, workerBranch], {
            cwd: repoRoot, stdio: 'pipe', windowsHide: true
        });
        // Get merge commit hash
        const mergeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe', windowsHide: true
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
            execFileSync('git', ['merge', '--abort'], { cwd: repoRoot, stdio: 'pipe', windowsHide: true });
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
        cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe', windowsHide: true
    }).trim();
    validateBranchName(base);
    // Keep harness overlay files (AGENTS.md, .claude/**) from blocking the merge
    // fan-out on infrastructure that has nothing to do with the task (#3224).
    configureHarnessMergeAttributes(repoRoot);
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