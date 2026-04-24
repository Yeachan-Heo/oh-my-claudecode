// src/team/git-worktree.ts
/**
 * Git worktree manager for team worker isolation.
 *
 * Native team worktrees live at:
 *   {repoRoot}/.omc/team/{team}/worktrees/{worker}
 * Branch naming (branch mode): omc-team/{teamName}/{workerName}
 *
 * The public create/remove helpers are kept for legacy callers, but the
 * implementation is conservative: compatible clean worktrees are reused,
 * dirty team worktrees are preserved, and cleanup never force-removes dirty
 * worker changes.
 */
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';
import { withFileLockSync } from '../lib/file-lock.js';
/** Get canonical native team worktree path for a worker. */
export function getWorktreePath(repoRoot, teamName, workerName) {
    return join(repoRoot, '.omc', 'team', sanitizeName(teamName), 'worktrees', sanitizeName(workerName));
}
/** Get branch name for a worker. */
export function getBranchName(teamName, workerName) {
    return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}
function git(repoRoot, args, cwd = repoRoot) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}
function isInsideGitRepo(repoRoot) {
    try {
        git(repoRoot, ['rev-parse', '--show-toplevel']);
        return true;
    }
    catch {
        return false;
    }
}
function assertCleanLeaderWorktree(repoRoot) {
    const status = git(repoRoot, ['status', '--porcelain'])
        .split('\n')
        .filter(line => line.trim() !== '' && !/^\?\? \.omc(?:\/|$)/.test(line))
        .join('\n')
        .trim();
    if (status.length > 0) {
        const error = new Error('leader_worktree_dirty: commit, stash, or clean changes before enabling team worktree mode');
        error.code = 'leader_worktree_dirty';
        throw error;
    }
}
function getRegisteredWorktreeBranch(repoRoot, wtPath) {
    try {
        const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
        const resolvedWtPath = resolve(wtPath);
        let currentMatches = false;
        for (const line of output.split('\n')) {
            if (line.startsWith('worktree ')) {
                currentMatches = resolve(line.slice('worktree '.length).trim()) === resolvedWtPath;
                continue;
            }
            if (!currentMatches)
                continue;
            if (line.startsWith('branch '))
                return line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
            if (line === 'detached')
                return 'HEAD';
        }
    }
    catch {
        // Best-effort check only.
    }
    return undefined;
}
function isRegisteredWorktreePath(repoRoot, wtPath) {
    try {
        const output = git(repoRoot, ['worktree', 'list', '--porcelain']);
        const resolvedWtPath = resolve(wtPath);
        return output.split('\n').some(line => (line.startsWith('worktree ') && resolve(line.slice('worktree '.length).trim()) === resolvedWtPath));
    }
    catch {
        return false;
    }
}
function isDetached(wtPath) {
    try {
        const branch = execFileSync('git', ['branch', '--show-current'], { cwd: wtPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
        return branch.length === 0;
    }
    catch {
        return false;
    }
}
function isWorktreeDirty(wtPath) {
    return isWorktreeDirtyExcept(wtPath).dirty;
}
function normalizeStatusPath(rawPath) {
    const trimmed = rawPath.trim();
    if (trimmed.startsWith('\"') && trimmed.endsWith('\"')) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}
function statusEntryPath(line) {
    const payload = line.slice(3);
    const renameSeparator = ' -> ';
    const renameIndex = payload.indexOf(renameSeparator);
    return normalizeStatusPath(renameIndex >= 0 ? payload.slice(renameIndex + renameSeparator.length) : payload);
}
function isWorktreeDirtyExcept(wtPath, ignoredRootPaths = []) {
    try {
        const ignored = new Set(ignoredRootPaths);
        const entries = execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf-8', stdio: 'pipe' })
            .split('\n')
            .filter(line => line.trim().length > 0);
        const relevantEntries = entries.filter(line => !ignored.has(statusEntryPath(line)));
        return { dirty: relevantEntries.length > 0, entries: relevantEntries };
    }
    catch {
        return { dirty: true, entries: ['git_status_failed'] };
    }
}
/** Get worktree metadata path. */
function getMetadataPath(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'worktrees.json');
}
function getLegacyMetadataPath(repoRoot, teamName) {
    return join(repoRoot, '.omc', 'state', 'team-bridge', sanitizeName(teamName), 'worktrees.json');
}
function getWorkerStateDir(repoRoot, teamName, workerName) {
    return join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'workers', sanitizeName(workerName));
}
function getRootAgentsBackupPath(repoRoot, teamName, workerName) {
    return join(getWorkerStateDir(repoRoot, teamName, workerName), 'worktree-root-agents.json');
}
function readRootAgentsBackup(repoRoot, teamName, workerName) {
    const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
    if (!existsSync(backupPath))
        return null;
    try {
        return JSON.parse(readFileSync(backupPath, 'utf-8'));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[omc] warning: worktree root AGENTS backup parse error: ${msg}\n`);
        const error = new Error(`worktree_root_agents_backup_unreadable:${backupPath}:${msg}`);
        error.code = 'worktree_root_agents_backup_unreadable';
        throw error;
    }
}
/**
 * Install the generated worker overlay into the root of a native worker worktree.
 * Existing root AGENTS.md content is backed up under leader-owned state so cleanup
 * can safely restore it. Reinstalling preserves the first original backup instead
 * of treating an older managed overlay as user content.
 */
export function installWorktreeRootAgents(teamName, workerName, repoRoot, worktreePath, overlayContent) {
    validateResolvedPath(worktreePath, repoRoot);
    const agentsPath = join(worktreePath, 'AGENTS.md');
    validateResolvedPath(agentsPath, repoRoot);
    const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
    validateResolvedPath(backupPath, repoRoot);
    ensureDirWithMode(getWorkerStateDir(repoRoot, teamName, workerName));
    const previous = readRootAgentsBackup(repoRoot, teamName, workerName);
    const currentContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : undefined;
    if (previous && currentContent !== undefined && currentContent !== previous.installedContent) {
        const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${agentsPath}`);
        error.code = 'agents_dirty';
        throw error;
    }
    const backup = previous
        ? { ...previous, worktreePath, installedContent: overlayContent, installedAt: new Date().toISOString() }
        : {
            worktreePath,
            hadOriginal: currentContent !== undefined,
            ...(currentContent !== undefined ? { originalContent: currentContent } : {}),
            installedContent: overlayContent,
            installedAt: new Date().toISOString(),
        };
    atomicWriteJson(backupPath, backup);
    writeFileSync(agentsPath, overlayContent, 'utf-8');
}
/**
 * Restore or remove a managed worktree-root AGENTS.md when it is still unchanged.
 * If a worker edited AGENTS.md, leave it and report agents_dirty so cleanup can
 * preserve the worktree instead of overwriting user changes.
 */
export function restoreWorktreeRootAgents(teamName, workerName, repoRoot, worktreePath) {
    const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
    validateResolvedPath(backupPath, repoRoot);
    const backup = readRootAgentsBackup(repoRoot, teamName, workerName);
    if (!backup)
        return { restored: false, reason: 'no_backup' };
    const resolvedWorktreePath = worktreePath ?? backup.worktreePath;
    validateResolvedPath(resolvedWorktreePath, repoRoot);
    if (!existsSync(resolvedWorktreePath)) {
        try {
            unlinkSync(backupPath);
        }
        catch { /* backup already gone */ }
        return { restored: false, reason: 'worktree_missing' };
    }
    const agentsPath = join(resolvedWorktreePath, 'AGENTS.md');
    validateResolvedPath(agentsPath, repoRoot);
    const currentContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : undefined;
    const isPartialInstallOriginal = backup.hadOriginal && currentContent === (backup.originalContent ?? '');
    if (currentContent !== undefined && currentContent !== backup.installedContent && !isPartialInstallOriginal) {
        return { restored: false, reason: 'agents_dirty' };
    }
    if (backup.hadOriginal) {
        writeFileSync(agentsPath, backup.originalContent ?? '', 'utf-8');
    }
    else if (existsSync(agentsPath)) {
        unlinkSync(agentsPath);
    }
    try {
        unlinkSync(backupPath);
    }
    catch { /* backup already gone */ }
    return { restored: true };
}
/** Read worktree metadata, including legacy metadata for cleanup compatibility. */
function readMetadataResult(repoRoot, teamName) {
    const paths = [getMetadataPath(repoRoot, teamName), getLegacyMetadataPath(repoRoot, teamName)];
    const byWorker = new Map();
    const issues = [];
    for (const metaPath of paths) {
        if (!existsSync(metaPath))
            continue;
        try {
            const entries = JSON.parse(readFileSync(metaPath, 'utf-8'));
            for (const entry of entries)
                byWorker.set(entry.workerName, entry);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            issues.push({ path: metaPath, message });
            process.stderr.write(`[omc] warning: worktrees.json parse error at ${metaPath}: ${message}
`);
        }
    }
    return { entries: [...byWorker.values()], issues };
}
function readMetadata(repoRoot, teamName) {
    return readMetadataResult(repoRoot, teamName).entries;
}
function listRootAgentsBackupIssues(repoRoot, teamName, entries) {
    const workersDir = join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName), 'workers');
    if (!existsSync(workersDir))
        return [];
    const knownWorkers = new Set(entries.map((entry) => sanitizeName(entry.workerName)));
    const issues = [];
    for (const workerName of readdirSync(workersDir)) {
        const backupPath = join(workersDir, workerName, 'worktree-root-agents.json');
        if (!existsSync(backupPath))
            continue;
        try {
            JSON.parse(readFileSync(backupPath, 'utf-8'));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            issues.push({ path: backupPath, message: `worktree_root_agents_backup_unreadable:${workerName}:${message}` });
            continue;
        }
        if (!knownWorkers.has(sanitizeName(workerName))) {
            issues.push({
                path: backupPath,
                message: `orphaned_worktree_root_agents_backup:${workerName}`,
            });
        }
    }
    return issues;
}
/** Write native worktree metadata. */
function writeMetadata(repoRoot, teamName, entries) {
    const metaPath = getMetadataPath(repoRoot, teamName);
    validateResolvedPath(metaPath, repoRoot);
    ensureDirWithMode(join(repoRoot, '.omc', 'state', 'team', sanitizeName(teamName)));
    atomicWriteJson(metaPath, entries);
}
function recordMetadata(repoRoot, teamName, info) {
    const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
    withFileLockSync(metaLockPath, () => {
        const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== info.workerName);
        writeMetadata(repoRoot, teamName, [...existing, info]);
    });
}
function forgetMetadataUnlocked(repoRoot, teamName, workerName) {
    const existing = readMetadata(repoRoot, teamName).filter(entry => entry.workerName !== workerName);
    writeMetadata(repoRoot, teamName, existing);
}
function forgetMetadata(repoRoot, teamName, workerName) {
    const metaLockPath = getMetadataPath(repoRoot, teamName) + '.lock';
    withFileLockSync(metaLockPath, () => {
        forgetMetadataUnlocked(repoRoot, teamName, workerName);
    });
}
function assertCompatibleExistingWorktree(repoRoot, wtPath, expectedBranch, mode) {
    const registeredBranch = getRegisteredWorktreeBranch(repoRoot, wtPath);
    if (!registeredBranch) {
        const error = new Error(`worktree_path_mismatch: existing path is not a registered git worktree: ${wtPath}`);
        error.code = 'worktree_path_mismatch';
        throw error;
    }
    if (isWorktreeDirty(wtPath)) {
        const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
        error.code = 'worktree_dirty';
        throw error;
    }
    if (mode === 'named' && registeredBranch !== expectedBranch) {
        const error = new Error(`worktree_mismatch: expected branch ${expectedBranch} at ${wtPath}, found ${registeredBranch}`);
        error.code = 'worktree_mismatch';
        throw error;
    }
    if (mode === 'detached' && registeredBranch !== 'HEAD') {
        const error = new Error(`worktree_mismatch: expected detached worktree at ${wtPath}, found ${registeredBranch}`);
        error.code = 'worktree_mismatch';
        throw error;
    }
}
export function normalizeTeamWorktreeMode(value) {
    if (typeof value !== 'string')
        return 'disabled';
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled', 'detached'].includes(normalized))
        return 'detached';
    if (['branch', 'named', 'named-branch'].includes(normalized))
        return 'named';
    return 'disabled';
}
/**
 * Ensure a worker worktree exists according to the selected opt-in mode.
 * Disabled mode is a no-op. Existing clean compatible worktrees are reused;
 * dirty or mismatched existing worktrees throw without deleting files.
 */
export function ensureWorkerWorktree(teamName, workerName, repoRoot, options = {}) {
    const mode = options.mode ?? 'disabled';
    if (mode === 'disabled')
        return null;
    if (!isInsideGitRepo(repoRoot)) {
        throw new Error(`not_a_git_repository: ${repoRoot}`);
    }
    if (options.requireCleanLeader !== false) {
        assertCleanLeaderWorktree(repoRoot);
    }
    const wtPath = getWorktreePath(repoRoot, teamName, workerName);
    const branch = mode === 'named' ? getBranchName(teamName, workerName) : 'HEAD';
    validateResolvedPath(wtPath, repoRoot);
    try {
        execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
    }
    catch { /* ignore */ }
    if (existsSync(wtPath)) {
        assertCompatibleExistingWorktree(repoRoot, wtPath, branch, mode);
        const info = {
            path: wtPath,
            branch,
            workerName,
            teamName,
            createdAt: new Date().toISOString(),
            repoRoot,
            mode,
            detached: isDetached(wtPath),
            created: false,
            reused: true,
        };
        recordMetadata(repoRoot, teamName, info);
        return info;
    }
    const wtDir = join(repoRoot, '.omc', 'team', sanitizeName(teamName), 'worktrees');
    ensureDirWithMode(wtDir);
    const args = mode === 'named'
        ? ['worktree', 'add', '-b', branch, wtPath, options.baseRef ?? 'HEAD']
        : ['worktree', 'add', '--detach', wtPath, options.baseRef ?? 'HEAD'];
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    const info = {
        path: wtPath,
        branch,
        workerName,
        teamName,
        createdAt: new Date().toISOString(),
        repoRoot,
        mode,
        detached: mode === 'detached',
        created: true,
        reused: false,
    };
    recordMetadata(repoRoot, teamName, info);
    return info;
}
/** Legacy creation helper: create or reuse a named-branch worker worktree. */
export function createWorkerWorktree(teamName, workerName, repoRoot, baseBranch) {
    const info = ensureWorkerWorktree(teamName, workerName, repoRoot, {
        mode: 'named',
        baseRef: baseBranch,
        requireCleanLeader: false,
    });
    if (!info)
        throw new Error('worktree creation unexpectedly disabled');
    return info;
}
/**
 * Dry-run validation for worker worktree removal. This does not restore/remove
 * managed root AGENTS.md and does not delete backup state.
 */
export function checkWorkerWorktreeRemovalSafety(teamName, workerName, repoRoot, worktreePath) {
    const wtPath = worktreePath ?? getWorktreePath(repoRoot, teamName, workerName);
    const backup = readRootAgentsBackup(repoRoot, teamName, workerName);
    if (!existsSync(wtPath))
        return;
    let ignoreRootAgents = false;
    if (backup) {
        const agentsPath = join(wtPath, 'AGENTS.md');
        validateResolvedPath(agentsPath, repoRoot);
        const currentContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : undefined;
        const isPartialInstallOriginal = backup.hadOriginal && currentContent === (backup.originalContent ?? '');
        if (currentContent !== undefined && currentContent !== backup.installedContent && !isPartialInstallOriginal) {
            const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${agentsPath}`);
            error.code = 'agents_dirty';
            throw error;
        }
        ignoreRootAgents = true;
    }
    const dirtyCheck = isWorktreeDirtyExcept(wtPath, ignoreRootAgents ? ['AGENTS.md'] : []);
    if (dirtyCheck.dirty) {
        const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
        error.code = 'worktree_dirty';
        throw error;
    }
}
/**
 * Prepare a worker worktree for later removal without deleting the worktree.
 *
 * This is transactional with respect to managed root AGENTS.md overlays: it first
 * validates the overlay is restorable and that no non-overlay files are dirty.
 * Only after that dry-run succeeds does it restore/remove AGENTS.md and delete
 * the backup. If any other dirty file exists, the worker pane/config can remain
 * intact with the managed overlay and backup still available for a later retry.
 */
export function prepareWorkerWorktreeForRemoval(teamName, workerName, repoRoot, worktreePath) {
    const wtPath = worktreePath ?? getWorktreePath(repoRoot, teamName, workerName);
    checkWorkerWorktreeRemovalSafety(teamName, workerName, repoRoot, wtPath);
    const agentsRestore = restoreWorktreeRootAgents(teamName, workerName, repoRoot, wtPath);
    if (agentsRestore.reason === 'agents_dirty') {
        const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${join(wtPath, 'AGENTS.md')}`);
        error.code = 'agents_dirty';
        throw error;
    }
}
/** Remove a worker's worktree and branch, preserving dirty worktrees. */
export function removeWorkerWorktree(teamName, workerName, repoRoot) {
    const wtPath = getWorktreePath(repoRoot, teamName, workerName);
    const branch = getBranchName(teamName, workerName);
    const metaLockPath = `${getMetadataPath(repoRoot, teamName)}.lock`;
    withFileLockSync(metaLockPath, () => {
        prepareWorkerWorktreeForRemoval(teamName, workerName, repoRoot, wtPath);
        const wasRegisteredWorktree = isRegisteredWorktreePath(repoRoot, wtPath);
        try {
            execFileSync('git', ['worktree', 'remove', wtPath], { cwd: repoRoot, stdio: 'pipe' });
        }
        catch (err) {
            if (wasRegisteredWorktree) {
                const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
                const error = new Error(`worktree_remove_failed: preserving metadata for registered worker worktree at ${wtPath}${detail}`);
                error.code = 'worktree_remove_failed';
                throw error;
            }
            // Unregistered/absent stale paths are best-effort cleanup only.
        }
        try {
            execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'pipe' });
        }
        catch { /* ignore */ }
        try {
            execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'pipe' });
        }
        catch { /* branch may not exist */ }
        // If a stale plain directory remains and it is not a registered worktree, remove it.
        if (existsSync(wtPath) && !isRegisteredWorktreePath(repoRoot, wtPath)) {
            rmSync(wtPath, { recursive: true, force: true });
        }
        forgetMetadataUnlocked(repoRoot, teamName, workerName);
    });
}
/** List all worktrees for a team. */
export function listTeamWorktrees(teamName, repoRoot) {
    return readMetadata(repoRoot, teamName);
}
export function inspectTeamWorktreeCleanupSafety(teamName, repoRoot) {
    const metadata = readMetadataResult(repoRoot, teamName);
    const entries = metadata.entries;
    const backupIssues = listRootAgentsBackupIssues(repoRoot, teamName, entries);
    return {
        hasEvidence: entries.length > 0 || metadata.issues.length > 0 || backupIssues.length > 0,
        entries,
        blockers: [
            ...metadata.issues.map((issue, index) => ({
                workerName: `metadata-${index + 1}`,
                path: issue.path,
                reason: `worktree_metadata_unreadable:${issue.message}`,
            })),
            ...backupIssues.map((issue, index) => ({
                workerName: `agents-backup-${index + 1}`,
                path: issue.path,
                reason: issue.message,
            })),
        ],
    };
}
/** Remove all clean worktrees for a team, preserving dirty worktrees. */
export function cleanupTeamWorktrees(teamName, repoRoot) {
    const safety = inspectTeamWorktreeCleanupSafety(teamName, repoRoot);
    const entries = safety.entries;
    const removed = [];
    const preserved = [...safety.blockers];
    if (preserved.length > 0) {
        return { removed, preserved };
    }
    for (const entry of entries) {
        try {
            removeWorkerWorktree(teamName, entry.workerName, repoRoot);
            removed.push(entry.workerName);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            preserved.push({ workerName: entry.workerName, path: entry.path, reason });
            process.stderr.write(`[omc] warning: preserved worktree ${entry.path}: ${reason}\n`);
        }
    }
    return { removed, preserved };
}
//# sourceMappingURL=git-worktree.js.map