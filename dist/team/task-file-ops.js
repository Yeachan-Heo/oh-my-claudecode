// src/team/task-file-ops.ts
/**
 * Task File Operations for MCP Team Bridge
 *
 * Read/write/scan task JSON files with atomic writes (temp + rename).
 *
 * Canonical task storage path:
 *   {cwd}/.omc/state/team/{teamName}/tasks/{id}.json
 *
 * Legacy path (read-only fallback during migration):
 *   ~/.claude/tasks/{teamName}/{id}.json
 *
 * New writes always go to the canonical path. Reads check the canonical
 * path first; if the file is absent there, the legacy path is tried so
 * that teams created by older versions continue to work transparently.
 */
import { readFileSync, readdirSync, existsSync, openSync, closeSync, unlinkSync, writeSync, statSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import { sanitizeName } from './tmux-session.js';
import { atomicWriteJson, validateResolvedPath, ensureDirWithMode } from './fs-utils.js';
import { getTaskStoragePath, getLegacyTaskStoragePath } from './state-paths.js';
/** Default age (ms) after which a lock file is considered stale. */
const DEFAULT_STALE_LOCK_MS = 30_000;
const FAILURE_LOCK_RETRY_ATTEMPTS = 40;
const FAILURE_LOCK_RETRY_DELAY_MS = 5;
/**
 * Check if a process with the given PID is alive.
 * Returns false for PIDs <= 0 or if kill(pid, 0) throws ESRCH.
 */
function isPidAlive(pid) {
    if (pid <= 0 || !Number.isFinite(pid))
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        // EPERM means the process exists but we don't have permission — still alive
        if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM')
            return true;
        return false;
    }
}
/**
 * Try to acquire an exclusive lock file for a task.
 *
 * Uses O_CREAT|O_EXCL|O_WRONLY which atomically creates the file only if
 * it doesn't already exist — the kernel guarantees no two openers succeed.
 *
 * If the lock file already exists, checks for staleness (age > staleLockMs
 * AND owner PID is dead) and reaps if stale, retrying once.
 *
 * Returns a LockHandle on success, or null if the lock is held by another live worker.
 */
export function acquireTaskLock(teamName, taskId, opts) {
    const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    const dir = canonicalTasksDir(teamName, opts?.cwd);
    ensureDirWithMode(dir);
    const lockPath = join(dir, `${sanitizeTaskId(taskId)}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
            // Write payload so stale-detection can read PID + timestamp
            const payload = JSON.stringify({
                pid: process.pid,
                workerName: opts?.workerName ?? '',
                timestamp: Date.now(),
            });
            writeSync(fd, payload, null, 'utf-8');
            return { fd, path: lockPath };
        }
        catch (err) {
            if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
                // Lock file exists — check if stale
                if (attempt === 0 && isLockStale(lockPath, staleLockMs)) {
                    try {
                        unlinkSync(lockPath);
                    }
                    catch { /* another worker reaped it */ }
                    continue; // retry once
                }
                return null; // held by a live worker
            }
            throw err; // unexpected error — bubble up
        }
    }
    return null;
}
/**
 * Release a previously acquired task lock.
 * Closes the file descriptor and removes the lock file.
 */
export function releaseTaskLock(handle) {
    try {
        closeSync(handle.fd);
    }
    catch { /* already closed */ }
    try {
        unlinkSync(handle.path);
    }
    catch { /* already removed */ }
}
async function sleepAsync(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function acquireTaskLockWithRetry(teamName, taskId, opts) {
    const attempts = opts?.attempts ?? FAILURE_LOCK_RETRY_ATTEMPTS;
    const delayMs = opts?.delayMs ?? FAILURE_LOCK_RETRY_DELAY_MS;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const handle = acquireTaskLock(teamName, taskId, opts);
        if (handle)
            return handle;
        if (attempt < attempts - 1)
            await sleepAsync(delayMs);
    }
    throw new Error(`Failed to acquire lock for ${taskId} after ${attempts} attempts`);
}
/**
 * Execute a function while holding an exclusive task lock.
 * Returns the function's result, or null if the lock could not be acquired.
 */
export async function withTaskLock(teamName, taskId, fn, opts) {
    const handle = acquireTaskLock(teamName, taskId, opts);
    if (!handle)
        return null;
    try {
        return await fn();
    }
    finally {
        releaseTaskLock(handle);
    }
}
/**
 * Check if an existing lock file is stale.
 * A lock is stale if it's older than staleLockMs AND the owning PID is dead.
 */
function isLockStale(lockPath, staleLockMs) {
    try {
        const stat = statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < staleLockMs)
            return false;
        // Try to read PID from the lock payload
        try {
            const raw = readFileSync(lockPath, 'utf-8');
            const payload = JSON.parse(raw);
            if (payload.pid && isPidAlive(payload.pid))
                return false;
        }
        catch {
            // Malformed or unreadable — treat as stale if old enough
        }
        return true;
    }
    catch {
        // Lock file disappeared between check and stat — not stale, just gone
        return false;
    }
}
// ─── End lock helpers ──────────────────────────────────────────────────────
/** Validate task ID to prevent path traversal */
function sanitizeTaskId(taskId) {
    if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
        throw new Error(`Invalid task ID: "${taskId}" contains unsafe characters`);
    }
    return taskId;
}
// ─── Path helpers ──────────────────────────────────────────────────────────
/**
 * Returns the canonical tasks directory for a team.
 * All new writes go here: {cwd}/.omc/state/team/{teamName}/tasks/
 */
function canonicalTasksDir(teamName, cwd) {
    const root = cwd ?? process.cwd();
    const dir = getTaskStoragePath(root, sanitizeName(teamName));
    validateResolvedPath(dir, join(root, '.omc', 'state', 'team'));
    return dir;
}
/**
 * Returns the legacy tasks directory for a team.
 * Used only for read-fallback: ~/.claude/tasks/{teamName}/
 */
function legacyTasksDir(teamName) {
    const claudeConfigDir = getClaudeConfigDir();
    const dir = getLegacyTaskStoragePath(claudeConfigDir, sanitizeName(teamName));
    validateResolvedPath(dir, join(claudeConfigDir, 'tasks'));
    return dir;
}
/**
 * Resolve the path to a task file for READ operations.
 *
 * Compatibility shim: checks canonical path first; if absent, falls back
 * to the legacy path so that data written by older versions is still readable.
 * New writes never use the legacy path.
 */
function resolveTaskPathForRead(teamName, taskId, cwd) {
    const canonical = join(canonicalTasksDir(teamName, cwd), `${sanitizeTaskId(taskId)}.json`);
    if (existsSync(canonical))
        return canonical;
    const legacy = join(legacyTasksDir(teamName), `${sanitizeTaskId(taskId)}.json`);
    if (existsSync(legacy))
        return legacy;
    // Neither exists — return canonical so callers get a predictable missing-file path
    return canonical;
}
/**
 * Resolve the path to a task file for WRITE operations.
 * Always returns the canonical path regardless of whether legacy data exists.
 */
function resolveTaskPathForWrite(teamName, taskId, cwd) {
    return join(canonicalTasksDir(teamName, cwd), `${sanitizeTaskId(taskId)}.json`);
}
function failureSidecarPath(teamName, taskId, cwd) {
    return join(canonicalTasksDir(teamName, cwd), `${sanitizeTaskId(taskId)}.failure.json`);
}
// ─── Public API ────────────────────────────────────────────────────────────
/** Read a single task file. Returns null if not found or malformed. */
export function readTask(teamName, taskId, opts) {
    const filePath = resolveTaskPathForRead(teamName, taskId, opts?.cwd);
    if (!existsSync(filePath))
        return null;
    try {
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Atomic update: reads full task JSON, patches specified fields, writes back.
 * Preserves unknown fields to avoid data loss.
 *
 * When useLock is true (default), wraps the read-modify-write in an O_EXCL
 * lock to prevent lost updates from concurrent writers. Falls back to
 * unlocked write if the lock cannot be acquired within a single attempt
 * (backward-compatible degradation with a console warning).
 *
 * Always writes to the canonical path. If the task only exists in the legacy
 * path, it is migrated to canonical on the first update.
 */
export function updateTask(teamName, taskId, updates, opts) {
    const useLock = opts?.useLock ?? true;
    const doUpdate = () => {
        // Read from wherever the file currently lives (canonical or legacy)
        const readPath = resolveTaskPathForRead(teamName, taskId, opts?.cwd);
        let task;
        try {
            const raw = readFileSync(readPath, 'utf-8');
            task = JSON.parse(raw);
        }
        catch {
            throw new Error(`Task file not found or malformed: ${taskId}`);
        }
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
                task[key] = value;
            }
        }
        // Always write to canonical path (migrates legacy data on first update)
        const writePath = resolveTaskPathForWrite(teamName, taskId, opts?.cwd);
        atomicWriteJson(writePath, task);
    };
    if (!useLock) {
        doUpdate();
        return;
    }
    const handle = acquireTaskLock(teamName, taskId, { cwd: opts?.cwd });
    if (!handle) {
        // Fallback: another worker holds the lock — proceed without lock + warn
        // This maintains backward compatibility while logging the degradation
        if (typeof process !== 'undefined' && process.stderr) {
            process.stderr.write(`[task-file-ops] WARN: could not acquire lock for task ${taskId}, updating without lock\n`);
        }
        doUpdate();
        return;
    }
    try {
        doUpdate();
    }
    finally {
        releaseTaskLock(handle);
    }
}
/**
 * Find next executable task for this worker.
 * Returns first task where:
 *   - owner === workerName
 *   - status === 'pending'
 *   - all blockedBy tasks have status 'completed'
 * Sorted by ID ascending.
 *
 * Uses O_EXCL lock files for atomic claiming — no sleep/jitter needed.
 * The kernel guarantees only one worker can create the lock file.
 */
export async function findNextTask(teamName, workerName, opts) {
    const dir = canonicalTasksDir(teamName, opts?.cwd);
    if (!existsSync(dir))
        return null;
    const taskIds = listTaskIds(teamName, opts);
    for (const id of taskIds) {
        // Quick pre-check without lock (avoid lock overhead for obvious skips)
        const task = readTask(teamName, id, opts);
        if (!task)
            continue;
        if (task.status !== 'pending')
            continue;
        if (task.owner !== workerName)
            continue;
        if (!areBlockersResolved(teamName, task.blockedBy, opts))
            continue;
        // Attempt atomic lock
        const handle = acquireTaskLock(teamName, id, { workerName, cwd: opts?.cwd });
        if (!handle)
            continue; // another worker holds the lock — skip
        try {
            // Re-read under lock to verify state hasn't changed
            const freshTask = readTask(teamName, id, opts);
            if (!freshTask ||
                freshTask.status !== 'pending' ||
                freshTask.owner !== workerName ||
                !areBlockersResolved(teamName, freshTask.blockedBy, opts)) {
                continue; // state changed between pre-check and lock acquisition
            }
            // Claim the task atomically — always write to canonical path
            const filePath = resolveTaskPathForWrite(teamName, id, opts?.cwd);
            let taskData;
            try {
                // Read from wherever the task currently lives
                const readPath = resolveTaskPathForRead(teamName, id, opts?.cwd);
                const raw = readFileSync(readPath, 'utf-8');
                taskData = JSON.parse(raw);
            }
            catch {
                continue;
            }
            taskData.claimedBy = workerName;
            taskData.claimedAt = Date.now();
            taskData.claimPid = process.pid;
            taskData.status = 'in_progress';
            atomicWriteJson(filePath, taskData);
            return { ...freshTask, claimedBy: workerName, claimedAt: taskData.claimedAt, claimPid: process.pid, status: 'in_progress' };
        }
        finally {
            releaseTaskLock(handle);
        }
    }
    return null;
}
/** Check if all blocker task IDs have status 'completed' */
export function areBlockersResolved(teamName, blockedBy, opts) {
    if (!blockedBy || blockedBy.length === 0)
        return true;
    for (const blockerId of blockedBy) {
        const blocker = readTask(teamName, blockerId, opts);
        if (!blocker || blocker.status !== 'completed')
            return false;
    }
    return true;
}
/**
 * Write failure sidecar for a task.
 * If sidecar already exists, increments retryCount.
 * Returns the persisted sidecar payload.
 */
export function writeTaskFailure(teamName, taskId, error, opts) {
    const filePath = failureSidecarPath(teamName, taskId, opts?.cwd);
    const existing = readTaskFailure(teamName, taskId, opts);
    const sidecar = {
        taskId,
        lastError: error,
        retryCount: existing ? existing.retryCount + 1 : 1,
        lastFailedAt: new Date().toISOString(),
    };
    atomicWriteJson(filePath, sidecar);
    return sidecar;
}
/** Read failure sidecar if it exists */
export function readTaskFailure(teamName, taskId, opts) {
    const filePath = failureSidecarPath(teamName, taskId, opts?.cwd);
    if (!existsSync(filePath))
        return null;
    try {
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/** Default maximum retries before a task is permanently failed */
export const DEFAULT_MAX_TASK_RETRIES = 5;
/** Check if a task has exhausted its retry budget */
export function isTaskRetryExhausted(teamName, taskId, maxRetries = DEFAULT_MAX_TASK_RETRIES, opts) {
    const failure = readTaskFailure(teamName, taskId, opts);
    if (!failure)
        return false;
    return failure.retryCount >= maxRetries;
}
/** List all task IDs in a team directory, sorted ascending */
export function listTaskIds(teamName, opts) {
    const scanDir = (dir) => {
        if (!existsSync(dir))
            return [];
        try {
            return readdirSync(dir)
                .filter(f => f.endsWith('.json') && !f.includes('.tmp.') && !f.includes('.failure.') && !f.endsWith('.lock'))
                .map(f => f.replace('.json', ''));
        }
        catch {
            return [];
        }
    };
    // Check canonical path first, fall back to legacy if empty
    let ids = scanDir(canonicalTasksDir(teamName, opts?.cwd));
    if (ids.length === 0) {
        ids = scanDir(legacyTasksDir(teamName));
    }
    return ids.sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        if (!isNaN(numA) && !isNaN(numB))
            return numA - numB;
        return a.localeCompare(b);
    });
}
//# sourceMappingURL=task-file-ops.js.map