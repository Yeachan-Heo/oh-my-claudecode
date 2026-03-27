/**
 * OMC HUD - Git Elements
 *
 * Renders git repository name and branch information.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dim, cyan } from '../colors.js';
const CACHE_TTL_MS = 30_000;
const repoCache = new Map();
const branchCache = new Map();
/**
 * Clear all git caches. Call in tests beforeEach to ensure a clean slate.
 */
export function resetGitCache() {
    repoCache.clear();
    branchCache.clear();
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
export function getGitRepoName(cwd) {
    const key = cwd ? resolve(cwd) : process.cwd();
    const cached = repoCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
    }
    let result = null;
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
        }
        else {
            // Extract repo name from URL
            // Handles: https://github.com/user/repo.git, git@github.com:user/repo.git
            const match = url.match(/\/([^/]+?)(?:\.git)?$/) || url.match(/:([^/]+?)(?:\.git)?$/);
            result = match ? match[1].replace(/\.git$/, '') : null;
        }
    }
    catch {
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
export function getGitBranch(cwd) {
    const key = cwd ? resolve(cwd) : process.cwd();
    const cached = branchCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
    }
    let result = null;
    try {
        const branch = execSync('git branch --show-current', {
            cwd,
            encoding: 'utf-8',
            timeout: 1000,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
        }).trim();
        result = branch || null;
    }
    catch {
        result = null;
    }
    branchCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
}
/**
 * Render git repository name element.
 *
 * @param cwd - Working directory
 * @returns Formatted repo name or null
 */
export function renderGitRepo(cwd) {
    const repo = getGitRepoName(cwd);
    if (!repo)
        return null;
    return `${dim('repo:')}${cyan(repo)}`;
}
/**
 * Render git branch element.
 *
 * @param cwd - Working directory
 * @returns Formatted branch name or null
 */
export function renderGitBranch(cwd) {
    const branch = getGitBranch(cwd);
    if (!branch)
        return null;
    return `${dim('branch:')}${cyan(branch)}`;
}
//# sourceMappingURL=git.js.map