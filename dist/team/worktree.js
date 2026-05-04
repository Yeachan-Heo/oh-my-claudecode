import { execFile as execFileCb, execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { assertCurrentTaskBranchAvailable, upsertCurrentTaskBaseline, } from './current-task-baseline.js';
const execFilePromise = promisify(execFileCb);
const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;
export function isGitRepository(cwd) {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf-8',
        windowsHide: true,
    });
    return result.status === 0;
}
function sanitizePathToken(value) {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return normalized || 'default';
}
function readGit(repoRoot, args) {
    try {
        return execFileSync('git', args, {
            cwd: repoRoot,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }).trim();
    }
    catch (error) {
        const err = error;
        const stderr = typeof err.stderr === 'string'
            ? err.stderr.trim()
            : err.stderr instanceof Buffer
                ? err.stderr.toString('utf-8').trim()
                : '';
        throw new Error(stderr || `git ${args.join(' ')} failed`);
    }
}
function validateBranchName(repoRoot, branchName) {
    const result = spawnSync('git', ['check-ref-format', '--branch', branchName], {
        cwd: repoRoot,
        encoding: 'utf-8',
        windowsHide: true,
    });
    if (result.status === 0)
        return;
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `invalid_worktree_branch:${branchName}`);
}
function branchExists(repoRoot, branchName) {
    const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: repoRoot,
        encoding: 'utf-8',
    });
    return result.status === 0;
}
export function isWorktreeDirty(worktreePath) {
    const result = spawnSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        throw new Error(stderr || `worktree_status_failed:${worktreePath}`);
    }
    return (result.stdout || '').trim() !== '';
}
export function readWorkspaceStatusLines(cwd) {
    const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd,
        encoding: 'utf-8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        throw new Error(stderr || `workspace_status_failed:${cwd}`);
    }
    return (result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);
}
export function assertCleanLeaderWorkspaceForWorkerWorktrees(cwd) {
    const lines = readWorkspaceStatusLines(cwd);
    if (lines.length === 0)
        return;
    const preview = lines.slice(0, 8).join(' | ');
    throw new Error(`leader_workspace_dirty_for_worktrees:${resolve(cwd)}:${preview}:commit_or_stash_before_omx_team`);
}
function listWorktrees(repoRoot) {
    const raw = readGit(repoRoot, ['worktree', 'list', '--porcelain']);
    if (!raw)
        return [];
    const entries = [];
    const chunks = raw
        .split(/\n\n+/)
        .map((chunk) => chunk.trim())
        .filter(Boolean);
    for (const chunk of chunks) {
        const lines = chunk
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const worktreeLine = lines.find((line) => line.startsWith('worktree '));
        const headLine = lines.find((line) => line.startsWith('HEAD '));
        const branchLine = lines.find((line) => line.startsWith('branch '));
        if (!worktreeLine || !headLine)
            continue;
        entries.push({
            path: resolve(worktreeLine.slice('worktree '.length)),
            head: headLine.slice('HEAD '.length).trim(),
            branchRef: branchLine ? branchLine.slice('branch '.length).trim() : null,
            detached: lines.includes('detached') || !branchLine,
        });
    }
    return entries;
}
function pruneStaleWorktreePath(repoRoot, worktreePath) {
    const result = spawnSync('git', ['worktree', 'prune'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        windowsHide: true,
    });
    if (result.status === 0)
        return;
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `worktree_prune_failed:${worktreePath}`);
}
function resolveBranchName(input) {
    if (!input.mode.enabled || input.mode.detached)
        return null;
    if (input.scope === 'launch') {
        return input.mode.name;
    }
    if (input.scope === 'autoresearch') {
        const runTag = sanitizePathToken(input.worktreeTag || 'run');
        return `autoresearch/${sanitizePathToken(input.mode.name)}/${runTag}`;
    }
    const workerName = (input.workerName || '').trim();
    if (!workerName) {
        throw new Error('team_worktree_worker_name_required');
    }
    return `${input.mode.name}/${workerName}`;
}
function resolveWorktreePath(input, repoRoot) {
    const parent = dirname(repoRoot);
    const bucket = `${basename(repoRoot)}.omx-worktrees`;
    if (input.scope === 'launch') {
        if (!input.mode.enabled || input.mode.detached) {
            return join(parent, bucket, 'launch-detached');
        }
        return join(parent, bucket, `launch-${sanitizePathToken(input.mode.name)}`);
    }
    if (input.scope === 'autoresearch') {
        if (!input.mode.enabled || input.mode.detached) {
            throw new Error('autoresearch_worktree_requires_named_mode');
        }
        const runTag = sanitizePathToken(input.worktreeTag || 'run');
        return join(repoRoot, '.omx', 'worktrees', `autoresearch-${sanitizePathToken(input.mode.name)}-${runTag}`);
    }
    const teamName = sanitizePathToken(input.teamName || 'team');
    const workerName = sanitizePathToken(input.workerName || 'worker');
    return join(repoRoot, '.omx', 'team', teamName, 'worktrees', workerName);
}
function findWorktreeByPath(entries, worktreePath) {
    const resolved = resolve(worktreePath);
    return entries.find((entry) => resolve(entry.path) === resolved) || null;
}
function hasBranchInUse(entries, branchName, worktreePath) {
    const expectedRef = `refs/heads/${branchName}`;
    const resolvedPath = resolve(worktreePath);
    return entries.some((entry) => entry.branchRef === expectedRef && resolve(entry.path) !== resolvedPath);
}
function resolveGitCommonDir(cwd) {
    const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
        cwd,
        encoding: 'utf-8',
        windowsHide: true,
    });
    if (result.status !== 0)
        return null;
    const value = (result.stdout || '').trim();
    if (!value)
        return null;
    return resolve(cwd, value);
}
function readWorktreeEntryFromPath(repoRoot, worktreePath) {
    if (!existsSync(worktreePath))
        return null;
    const repoCommonDir = resolveGitCommonDir(repoRoot);
    const worktreeCommonDir = resolveGitCommonDir(worktreePath);
    if (!repoCommonDir || !worktreeCommonDir || repoCommonDir !== worktreeCommonDir) {
        return null;
    }
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        windowsHide: true,
    });
    if (headResult.status !== 0)
        return null;
    const head = (headResult.stdout || '').trim();
    if (!head)
        return null;
    const branchResult = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        windowsHide: true,
    });
    const branchRef = branchResult.status === 0 ? (branchResult.stdout || '').trim() : null;
    return {
        path: resolve(worktreePath),
        head,
        branchRef: branchRef || null,
        detached: !branchRef,
    };
}
export function parseWorktreeMode(args) {
    let mode = { enabled: false };
    const remaining = [];
    for (let i = 0; i < args.length; i++) {
        const rawArg = args[i];
        const arg = String(rawArg || '');
        if (arg === '--worktree' || arg === '-w') {
            // Peek at the next argument: if it looks like a git branch name (not a
            // flag and not a team worker spec like "3:debugger"), consume it as the
            // branch name. Colons are not valid in git branch names, so we use that
            // to distinguish branch names from other positional args.
            const next = args[i + 1];
            if (typeof next === 'string' && next.length > 0 && !next.startsWith('-') && !next.includes(':')) {
                mode = { enabled: true, detached: false, name: next };
                i += 1;
            }
            else {
                mode = { enabled: true, detached: true, name: null };
            }
            continue;
        }
        if (arg.startsWith('--worktree=')) {
            const value = arg.slice('--worktree='.length).trim();
            mode = value
                ? { enabled: true, detached: false, name: value }
                : { enabled: true, detached: true, name: null };
            continue;
        }
        if (arg.startsWith('-w=')) {
            const value = arg.slice('-w='.length).trim();
            mode = value
                ? { enabled: true, detached: false, name: value }
                : { enabled: true, detached: true, name: null };
            continue;
        }
        if (arg.startsWith('-w') && arg.length > 2) {
            const value = arg.slice(2).trim();
            mode = value
                ? { enabled: true, detached: false, name: value }
                : { enabled: true, detached: true, name: null };
            continue;
        }
        remaining.push(rawArg);
    }
    return { mode, remainingArgs: remaining };
}
export function planWorktreeTarget(input) {
    if (!input.mode.enabled)
        return { enabled: false };
    const repoRoot = readGit(input.cwd, ['rev-parse', '--show-toplevel']);
    const baseRef = readGit(repoRoot, ['rev-parse', 'HEAD']);
    const branchName = resolveBranchName(input);
    if (branchName) {
        validateBranchName(repoRoot, branchName);
    }
    return {
        enabled: true,
        scope: input.scope,
        repoRoot,
        worktreePath: resolveWorktreePath(input, repoRoot),
        detached: input.mode.detached,
        baseRef,
        branchName,
    };
}
export function ensureWorktree(plan, options = {}) {
    if (!plan.enabled)
        return { enabled: false };
    let allWorktrees = listWorktrees(plan.repoRoot);
    const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
    if (staleAtPath && !existsSync(staleAtPath.path)) {
        pruneStaleWorktreePath(plan.repoRoot, staleAtPath.path);
        allWorktrees = listWorktrees(plan.repoRoot);
    }
    const existingAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath)
        ?? readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
    const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;
    if (existingAtPath) {
        if (plan.detached) {
            if (!existingAtPath.detached || existingAtPath.head !== plan.baseRef) {
                throw new Error(`worktree_target_mismatch:${plan.worktreePath}`);
            }
        }
        else if (existingAtPath.branchRef !== expectedBranchRef) {
            throw new Error(`worktree_target_mismatch:${plan.worktreePath}`);
        }
        const dirty = isWorktreeDirty(plan.worktreePath);
        if (dirty && !options.allowDirtyReuse) {
            throw new Error(`worktree_dirty:${plan.worktreePath}`);
        }
        const reused = {
            enabled: true,
            repoRoot: plan.repoRoot,
            worktreePath: resolve(plan.worktreePath),
            detached: plan.detached,
            branchName: plan.branchName,
            created: false,
            reused: true,
            createdBranch: false,
            ...(dirty ? { dirty: true } : {}),
        };
        if (plan.branchName) {
            upsertCurrentTaskBaseline(plan.repoRoot, {
                branch_name: plan.branchName,
                worktree_path: reused.worktreePath,
                base_ref: plan.baseRef,
                status: 'active',
            });
        }
        return reused;
    }
    if (existsSync(plan.worktreePath)) {
        throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
    }
    if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
        throw new Error(`branch_in_use:${plan.branchName}`);
    }
    if (plan.branchName) {
        assertCurrentTaskBranchAvailable(plan.repoRoot, plan.branchName, plan.worktreePath);
    }
    mkdirSync(dirname(plan.worktreePath), { recursive: true });
    const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;
    const addArgs = ['worktree', 'add'];
    if (plan.detached) {
        addArgs.push('--detach', plan.worktreePath, plan.baseRef);
    }
    else if (branchAlreadyExisted) {
        addArgs.push(plan.worktreePath, plan.branchName);
    }
    else {
        addArgs.push('-b', plan.branchName, plan.worktreePath, plan.baseRef);
    }
    const result = spawnSync('git', addArgs, {
        cwd: plan.repoRoot,
        encoding: 'utf-8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) {
            throw new Error(`branch_in_use:${plan.branchName}`);
        }
        throw new Error(stderr || `worktree_add_failed:${addArgs.join(' ')}`);
    }
    const ensured = {
        enabled: true,
        repoRoot: plan.repoRoot,
        worktreePath: resolve(plan.worktreePath),
        detached: plan.detached,
        branchName: plan.branchName,
        created: true,
        reused: false,
        createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
    };
    if (plan.branchName) {
        upsertCurrentTaskBaseline(plan.repoRoot, {
            branch_name: plan.branchName,
            worktree_path: ensured.worktreePath,
            base_ref: plan.baseRef,
            status: 'active',
        });
    }
    return ensured;
}
export async function rollbackProvisionedWorktrees(results, options = {}) {
    const created = results
        .filter((result) => result.enabled === true && result.created)
        .reverse();
    const errors = [];
    for (const result of created) {
        try {
            await execFilePromise('git', ['worktree', 'remove', '--force', result.worktreePath], {
                cwd: result.repoRoot,
                encoding: 'utf-8',
            });
        }
        catch (err) {
            const stderr = (err.stderr ?? '').trim();
            const exitCode = err.code;
            errors.push(`remove:${result.worktreePath}:${stderr || `exit_${exitCode}`}`);
            continue;
        }
        if (options.skipBranchDeletion)
            continue;
        if (!result.createdBranch || !result.branchName)
            continue;
        const entriesAfterRemove = listWorktrees(result.repoRoot);
        const stillCheckedOut = hasBranchInUse(entriesAfterRemove, result.branchName, result.worktreePath);
        if (stillCheckedOut)
            continue;
        try {
            await execFilePromise('git', ['branch', '-D', result.branchName], {
                cwd: result.repoRoot,
                encoding: 'utf-8',
            });
        }
        catch (err) {
            if (branchExists(result.repoRoot, result.branchName)) {
                const stderr = (err.stderr ?? '').trim();
                const exitCode = err.code;
                errors.push(`delete_branch:${result.branchName}:${stderr || `exit_${exitCode}`}`);
            }
        }
    }
    if (errors.length > 0) {
        throw new Error(`worktree_rollback_failed:${errors.join(' | ')}`);
    }
}
export async function removeWorktreeForce(repoRoot, worktreePath) {
    await execFilePromise('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoRoot,
        encoding: 'utf-8',
    });
}
//# sourceMappingURL=worktree.js.map