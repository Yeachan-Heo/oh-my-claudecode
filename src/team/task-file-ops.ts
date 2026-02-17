// src/team/task-file-ops.ts

/**
 * Task File Operations for MCP Team Bridge
 *
 * Dual-path: delegates to cli-agent-mail protocol when the team has a
 * protocol layout (state_version marker), otherwise falls back to legacy
 * direct file I/O. Failure sidecars are always OMC-specific file I/O.
 *
 * Phase 3b-2: Migrated protocol path.
 * Phase 5: Added legacy fallback for backward compatibility.
 */

import { readFileSync, readdirSync, existsSync, openSync, closeSync, unlinkSync, writeSync, statSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import {
  readTask as protocolReadTask,
  listTasks as protocolListTasks,
  updateTask as protocolUpdateTask,
} from 'cli-agent-mail';
import {
  claimTask as protocolClaimTask,
  computeTaskReadiness,
} from 'cli-agent-mail';
import type { TaskFile, TaskFileUpdate, TaskFailureSidecar } from './types.js';
import { fromProtocolTask, resolveStateRoot } from './protocol-adapter.js';
import { atomicWriteJson, validateResolvedPath, ensureDirWithMode } from './fs-utils.js';
import { getClaudeConfigDir } from '../utils/paths.js';
import { sanitizeName } from './tmux-session.js';

// ─── State root + protocol detection ────────────────────────────────────────

function getStateRoot(): string {
  const cwd = process.env['OMC_WORKING_DIR'] || process.cwd();
  return resolveStateRoot(cwd);
}

/**
 * Check if a team has the protocol layout.
 * Looks for the team directory under {stateRoot}/team/{teamName}/.
 */
function hasProtocolLayout(teamName: string): boolean {
  try {
    const stateRoot = getStateRoot();
    const manifestFile = join(stateRoot, 'team', teamName, 'manifest.json');
    return existsSync(manifestFile);
  } catch {
    return false;
  }
}

// ─── Legacy lock interface (deprecated, kept for API compatibility) ─────────

/** Handle returned by acquireTaskLock; pass to releaseTaskLock. */
export interface LockHandle {
  fd: number;
  path: string;
}

/** Default age (ms) after which a lock file is considered stale. */
const DEFAULT_STALE_LOCK_MS = 30_000;

/**
 * Check if a process with the given PID is alive.
 */
function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EPERM') return true;
    return false;
  }
}

/**
 * Try to acquire an exclusive lock file for a task (legacy path only).
 */
export function acquireTaskLock(
  teamName: string,
  taskId: string,
  opts?: { staleLockMs?: number; workerName?: string },
): LockHandle | null {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const dir = legacyTasksDir(teamName);
  ensureDirWithMode(dir);
  const lockPath = join(dir, `${sanitizeTaskId(taskId)}.lock`);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      const payload = JSON.stringify({
        pid: process.pid,
        workerName: opts?.workerName ?? '',
        timestamp: Date.now(),
      });
      writeSync(fd, payload, null, 'utf-8');
      return { fd, path: lockPath };
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
        if (attempt === 0 && isLockStale(lockPath, staleLockMs)) {
          try { unlinkSync(lockPath); } catch { /* another worker reaped it */ }
          continue;
        }
        return null;
      }
      throw err;
    }
  }
  return null;
}

/**
 * Release a previously acquired task lock.
 */
export function releaseTaskLock(handle: LockHandle): void {
  try { closeSync(handle.fd); } catch { /* already closed */ }
  try { unlinkSync(handle.path); } catch { /* already removed */ }
}

/**
 * Execute a function while holding an exclusive task lock.
 */
export async function withTaskLock<T>(
  teamName: string,
  taskId: string,
  fn: () => T | Promise<T>,
  opts?: { staleLockMs?: number; workerName?: string },
): Promise<T | null> {
  if (hasProtocolLayout(teamName)) {
    // Protocol handles locking internally
    return await fn();
  }
  const handle = acquireTaskLock(teamName, taskId, opts);
  if (!handle) return null;
  try {
    return await fn();
  } finally {
    releaseTaskLock(handle);
  }
}

function isLockStale(lockPath: string, staleLockMs: number): boolean {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < staleLockMs) return false;
    try {
      const raw = readFileSync(lockPath, 'utf-8');
      const payload = JSON.parse(raw) as { pid?: number };
      if (payload.pid && isPidAlive(payload.pid)) return false;
    } catch { /* malformed — treat as stale if old enough */ }
    return true;
  } catch {
    return false;
  }
}

// ─── Legacy path helpers ────────────────────────────────────────────────────

function sanitizeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid task ID: "${taskId}" contains unsafe characters`);
  }
  return taskId;
}

function legacyTasksDir(teamName: string): string {
  const result = join(getClaudeConfigDir(), 'tasks', sanitizeName(teamName));
  validateResolvedPath(result, join(getClaudeConfigDir(), 'tasks'));
  return result;
}

function legacyTaskPath(teamName: string, taskId: string): string {
  return join(legacyTasksDir(teamName), `${sanitizeTaskId(taskId)}.json`);
}

// ─── Legacy file I/O functions ──────────────────────────────────────────────

function legacyReadTask(teamName: string, taskId: string): TaskFile | null {
  const filePath = legacyTaskPath(teamName, taskId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TaskFile;
  } catch {
    return null;
  }
}

function legacyUpdateTask(teamName: string, taskId: string, updates: TaskFileUpdate): void {
  const filePath = legacyTaskPath(teamName, taskId);
  let task: Record<string, unknown>;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    task = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Task file not found or malformed: ${taskId}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      task[key] = value;
    }
  }
  atomicWriteJson(filePath, task);
}

function legacyListTaskIds(teamName: string): string[] {
  const dir = legacyTasksDir(teamName);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.includes('.tmp.') && !f.includes('.failure.'))
      .map(f => f.replace('.json', ''))
      .sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
      });
  } catch {
    return [];
  }
}

// ─── Dual-path task operations ──────────────────────────────────────────────

/** Read a single task file. Returns null if not found or malformed. */
export function readTask(teamName: string, taskId: string): TaskFile | null {
  if (hasProtocolLayout(teamName)) {
    try {
      const stateRoot = getStateRoot();
      const protocolTask = protocolReadTask(stateRoot, teamName, taskId);
      if (!protocolTask) return null;
      return fromProtocolTask(protocolTask);
    } catch {
      return null;
    }
  }
  return legacyReadTask(teamName, taskId);
}

/**
 * Update a task: reads, patches, writes back.
 * Uses protocol when available, legacy file I/O otherwise.
 */
export function updateTask(
  teamName: string,
  taskId: string,
  updates: TaskFileUpdate,
  opts?: { useLock?: boolean },
): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    const protocolUpdates: Record<string, unknown> = {};
    if (updates.status !== undefined) protocolUpdates['status'] = updates.status;
    if (updates.owner !== undefined) protocolUpdates['owner'] = updates.owner;

    const currentTask = protocolReadTask(stateRoot, teamName, taskId);
    if (!currentTask) {
      throw new Error(`Task file not found or malformed: ${taskId}`);
    }

    const mergedMeta: Record<string, unknown> = { ...(currentTask.metadata ?? {}) };
    if (updates.metadata !== undefined) Object.assign(mergedMeta, updates.metadata);
    if (updates.claimedBy !== undefined) mergedMeta['claimedBy'] = updates.claimedBy;
    if (updates.claimedAt !== undefined) mergedMeta['claimedAt'] = updates.claimedAt;
    if (updates.claimPid !== undefined) mergedMeta['claimPid'] = updates.claimPid;
    protocolUpdates['metadata'] = mergedMeta;

    protocolUpdateTask(stateRoot, teamName, taskId, protocolUpdates);
    return;
  }

  // Legacy path with optional locking
  const useLock = opts?.useLock ?? true;
  if (!useLock) {
    legacyUpdateTask(teamName, taskId, updates);
    return;
  }

  const handle = acquireTaskLock(teamName, taskId);
  if (!handle) {
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(`[task-file-ops] WARN: could not acquire lock for task ${taskId}, updating without lock\n`);
    }
    legacyUpdateTask(teamName, taskId, updates);
    return;
  }

  try {
    legacyUpdateTask(teamName, taskId, updates);
  } finally {
    releaseTaskLock(handle);
  }
}

/**
 * Find next executable task for this worker.
 * Protocol path uses claimTask; legacy path uses O_EXCL locks.
 */
export async function findNextTask(teamName: string, workerName: string): Promise<TaskFile | null> {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    const allTasks = protocolListTasks(stateRoot, teamName);
    allTasks.sort((a, b) => {
      const numA = parseInt(a.id, 10);
      const numB = parseInt(b.id, 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.id.localeCompare(b.id);
    });

    for (const task of allTasks) {
      if (task.status !== 'pending') continue;
      if (task.owner !== workerName) continue;
      const readiness = computeTaskReadiness(stateRoot, teamName, task);
      if (!readiness.ready) continue;
      const result = protocolClaimTask(stateRoot, teamName, task.id, workerName);
      if (!result.ok) continue;
      return fromProtocolTask(result.task);
    }
    return null;
  }

  // Legacy path
  const dir = legacyTasksDir(teamName);
  if (!existsSync(dir)) return null;

  const taskIds = legacyListTaskIds(teamName);
  for (const id of taskIds) {
    const task = legacyReadTask(teamName, id);
    if (!task) continue;
    if (task.status !== 'pending') continue;
    if (task.owner !== workerName) continue;
    if (!areBlockersResolved(teamName, task.blockedBy)) continue;

    const handle = acquireTaskLock(teamName, id, { workerName });
    if (!handle) continue;

    try {
      const freshTask = legacyReadTask(teamName, id);
      if (
        !freshTask ||
        freshTask.status !== 'pending' ||
        freshTask.owner !== workerName ||
        !areBlockersResolved(teamName, freshTask.blockedBy)
      ) {
        continue;
      }

      const filePath = legacyTaskPath(teamName, id);
      let taskData: Record<string, unknown>;
      try {
        const raw = readFileSync(filePath, 'utf-8');
        taskData = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }

      taskData.claimedBy = workerName;
      taskData.claimedAt = Date.now();
      taskData.claimPid = process.pid;
      taskData.status = 'in_progress';
      atomicWriteJson(filePath, taskData);

      return { ...freshTask, claimedBy: workerName, claimedAt: taskData.claimedAt as number, claimPid: process.pid, status: 'in_progress' };
    } finally {
      releaseTaskLock(handle);
    }
  }

  return null;
}

/** Check if all blocker task IDs have status 'completed' */
export function areBlockersResolved(teamName: string, blockedBy: string[]): boolean {
  if (!blockedBy || blockedBy.length === 0) return true;
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    for (const blockerId of blockedBy) {
      const blocker = protocolReadTask(stateRoot, teamName, blockerId);
      if (!blocker || blocker.status !== 'completed') return false;
    }
    return true;
  }
  for (const blockerId of blockedBy) {
    const blocker = legacyReadTask(teamName, blockerId);
    if (!blocker || blocker.status !== 'completed') return false;
  }
  return true;
}

/** List all task IDs in a team, sorted ascending */
export function listTaskIds(teamName: string): string[] {
  if (hasProtocolLayout(teamName)) {
    try {
      const stateRoot = getStateRoot();
      const tasks = protocolListTasks(stateRoot, teamName);
      return tasks
        .map(t => t.id)
        .sort((a, b) => {
          const numA = parseInt(a, 10);
          const numB = parseInt(b, 10);
          if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
          return a.localeCompare(b);
        });
    } catch {
      return [];
    }
  }
  return legacyListTaskIds(teamName);
}

// ─── Failure sidecars (OMC-specific, not in protocol) ───────────────────────

function failureSidecarDir(teamName: string): string {
  return join(getClaudeConfigDir(), 'tasks', sanitizeName(teamName));
}

function failureSidecarPath(teamName: string, taskId: string): string {
  return join(failureSidecarDir(teamName), `${sanitizeTaskId(taskId)}.failure.json`);
}

/**
 * Write failure sidecar for a task.
 * If sidecar already exists, increments retryCount.
 */
export function writeTaskFailure(teamName: string, taskId: string, error: string): void {
  const filePath = failureSidecarPath(teamName, taskId);
  const existing = readTaskFailure(teamName, taskId);
  const sidecar: TaskFailureSidecar = {
    taskId,
    lastError: error,
    retryCount: existing ? existing.retryCount + 1 : 1,
    lastFailedAt: new Date().toISOString(),
  };
  atomicWriteJson(filePath, sidecar);
}

/** Read failure sidecar if it exists */
export function readTaskFailure(teamName: string, taskId: string): TaskFailureSidecar | null {
  const filePath = failureSidecarPath(teamName, taskId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TaskFailureSidecar;
  } catch {
    return null;
  }
}

/** Default maximum retries before a task is permanently failed */
export const DEFAULT_MAX_TASK_RETRIES = 5;

/** Check if a task has exhausted its retry budget */
export function isTaskRetryExhausted(
  teamName: string,
  taskId: string,
  maxRetries: number = DEFAULT_MAX_TASK_RETRIES
): boolean {
  const failure = readTaskFailure(teamName, taskId);
  if (!failure) return false;
  return failure.retryCount >= maxRetries;
}
