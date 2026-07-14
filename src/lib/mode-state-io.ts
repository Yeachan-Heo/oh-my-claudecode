/**
 * Mode State I/O Layer
 *
 * Canonical read/write/clear operations for mode state files.
 * Centralises path resolution, ghost-legacy cleanup, directory creation,
 * and file permissions so that individual mode modules don't duplicate this logic.
 */

import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  getGitTopLevel,
  getOmcRoot,
  resolveStatePath,
  resolveSessionStatePath,
  ensureSessionStateDir,
  ensureOmcDir,
  listSessionIds,
} from './worktree-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

type MutationLockOwner = { version: 1; pid: number; processStart: string; createdAt: string; nonce: string };
type MutationLock = { fd: number; path: string; owner: MutationLockOwner };
function flockPath(): string | null { return process.env.NODE_ENV === 'test' && process.env.OMC_TEST_FLOCK_AVAILABLE === '0' ? null : existsSync('/usr/bin/flock') ? '/usr/bin/flock' : existsSync('/bin/flock') ? '/bin/flock' : null; }
const LOCK_REMOVAL_SCRIPT = String.raw`
const fs = require('fs');
const [operation, lockPath, expectedRaw] = process.argv.slice(1);
const keys = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];
function readOwner() {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index]) || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processStart !== 'string' || !/^\d+$/.test(value.processStart) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
    return value;
  } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); return null; }
}
const owner = readOwner();
if (!owner) process.exit(3);
if (operation === 'release') {
  let expected;
  try { expected = JSON.parse(expectedRaw); } catch { process.exit(3); }
  if (owner.pid !== expected.pid || owner.processStart !== expected.processStart || owner.nonce !== expected.nonce) process.exit(4);
  try { fs.unlinkSync(lockPath); process.exit(0); } catch { process.exit(3); }
}
if (process.platform !== 'linux') process.exit(3);
let currentStart;
try {
  const stat = fs.readFileSync('/proc/' + owner.pid + '/stat', 'utf8');
  const end = stat.lastIndexOf(')');
  const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
  currentStart = fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
} catch (error) { currentStart = error && error.code === 'ENOENT' ? 'absent' : null; }
if (currentStart === null) process.exit(3);
if (currentStart !== 'absent' && currentStart === owner.processStart) process.exit(2);
try { fs.unlinkSync(lockPath); process.exit(0); } catch { process.exit(3); }
`;

function processStartIdentity(pid: number): string | 'absent' | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'linux') return pid === process.pid ? String(Math.max(1, Math.floor(Date.now() - process.uptime() * 1000))) : null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null;
  }
}

function readLockOwner(path: string): MutationLockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as MutationLockOwner;
    const keys = Object.keys(owner).sort();
    return keys.length === 5 && keys.every((key, index) => key === ['createdAt', 'nonce', 'pid', 'processStart', 'version'][index])
      && owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && typeof owner.processStart === 'string' && /^\d+$/.test(owner.processStart)
      && typeof owner.createdAt === 'string' && Number.isFinite(Date.parse(owner.createdAt))
      && typeof owner.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(owner.nonce)
      ? owner : null;
  } catch { return null; }
}

function ownerDisposition(owner: MutationLockOwner): 'retry' | 'live' | 'unverifiable' {
  if (process.platform === 'linux') {
    const current = processStartIdentity(owner.pid);
    if (current === 'absent') return 'retry';
    return current === null ? 'unverifiable' : current === owner.processStart ? 'live' : 'retry';
  }
  try {
    process.kill(owner.pid, 0);
    return 'live';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'retry' : 'unverifiable';
  }
}

function sameOwner(left: MutationLockOwner | null, right?: MutationLockOwner): boolean {
  return !!left && left.pid === right?.pid && left.processStart === right?.processStart && left.nonce === right?.nonce;
}

function acquireReclaimGuard(path: string): MutationLock | null {
  const guardPath = `${path}.reclaim.guard`;
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const owner: MutationLockOwner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    const tempPath = `${guardPath}.${process.pid}.${owner.nonce}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, 'wx', 0o600); writeSync(fd, JSON.stringify(owner)); fsyncSync(fd);
      linkSync(tempPath, guardPath); unlinkSync(tempPath);
      return { fd, path: guardPath, owner };
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* best-effort reclaim guard descriptor cleanup */ }
      try { unlinkSync(tempPath); } catch { /* best-effort unpublished reclaim guard cleanup */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const existing = readLockOwner(guardPath);
      if (!existing || ownerDisposition(existing) !== 'retry') return null;
      try { unlinkSync(guardPath); } catch { /* another reclaimer may have won */ }
    }
  }
  return null;
}

function releaseOwnedLockWithoutFlock(path: string, owner?: MutationLockOwner): 'retry' | 'replaced' | 'unverifiable' {
  const current = readLockOwner(path);
  if (!current) return 'unverifiable';
  if (!sameOwner(current, owner)) return 'replaced';
  try { unlinkSync(path); return 'retry'; } catch { return 'unverifiable'; }
}

function guardedLockRemoval(path: string, operation: 'reclaim' | 'release', owner?: MutationLockOwner): 'retry' | 'live' | 'replaced' | 'unverifiable' {
  const flock = flockPath();
  if (flock) {
    const result = spawnSync(flock, ['-x', `${path}.reclaim.guard`, process.execPath, '-e', LOCK_REMOVAL_SCRIPT, operation, path, owner ? JSON.stringify(owner) : ''], { stdio: 'ignore', timeout: 2000 });
    if (result.status === 0) return 'retry';
    if (result.status === 2) return 'live';
    if (result.status === 4) return 'replaced';
    return 'unverifiable';
  }
  const guard = acquireReclaimGuard(path);
  if (!guard) return 'unverifiable';
  try {
    const current = readLockOwner(path);
    if (!current) return 'unverifiable';
    if (operation === 'release') return releaseOwnedLockWithoutFlock(path, owner);
    const disposition = ownerDisposition(current);
    if (disposition !== 'retry') return disposition;
    try { unlinkSync(path); return 'retry'; } catch { return 'unverifiable'; }
  } finally {
    try { closeSync(guard.fd); } catch { /* owner metadata still authenticates guard release */ }
    releaseOwnedLockWithoutFlock(guard.path, guard.owner);
  }
}

function acquireMutationLock(filePath: string): MutationLock | null {
  mkdirSync(dirname(filePath), { recursive: true });
  const path = `${filePath}.mutation.lock`;
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') {
    console.error(`[omc-lock] state_mutation_lock_owner_unverifiable: ${path}`);
    return null;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const owner: MutationLockOwner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    const tempPath = `${path}.${process.pid}.${owner.nonce}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeSync(fd, JSON.stringify(owner));
      fsyncSync(fd);
      linkSync(tempPath, path);
      unlinkSync(tempPath);
      return { fd, path, owner };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ } }
      try { unlinkSync(tempPath); } catch { /* best-effort unpublished temp cleanup */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const disposition = guardedLockRemoval(path, 'reclaim');
      if (disposition === 'unverifiable') {
        console.error(`[omc-lock] state_mutation_lock_unverifiable: ${path}`);
        return null;
      }
      if (disposition === 'live') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return null;
}

function releaseMutationLock(lock: MutationLock | null): void {
  if (!lock) return;
  try { closeSync(lock.fd); } catch { /* lock metadata ownership still guards release */ }
  guardedLockRemoval(lock.path, 'release', lock.owner);
}

export function writeStateFileLocked(filePath: string, state: Record<string, unknown>): boolean {
  const lock = acquireMutationLock(filePath);
  if (!lock) return false;
  try {
    atomicWriteJsonSync(filePath, state);
    return true;
  } catch {
    return false;
  } finally {
    releaseMutationLock(lock);
  }
}

export function clearStateFileLocked(filePath: string): boolean {
  const lock = acquireMutationLock(filePath);
  if (!lock) return false;
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
    return true;
  } catch {
    return false;
  } finally {
    releaseMutationLock(lock);
  }
}

export type ConditionalClearResult = 'cleared' | 'skipped' | 'failed';

export function clearStateFileLockedIf(
  filePath: string,
  predicate: (current: Record<string, unknown>) => boolean,
): ConditionalClearResult {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64) {
    try {
      const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
      atomicWriteJsonSync(filePath, replacement);
    } finally {
      delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH;
      delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64;
    }
  }
  const lock = acquireMutationLock(filePath);
  if (!lock) return 'failed';
  try {
    if (!existsSync(filePath)) return 'skipped';
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      return 'failed';
    }
    if (!predicate(current)) return 'skipped';
    unlinkSync(filePath);
    return 'cleared';
  } catch {
    return 'failed';
  } finally {
    releaseMutationLock(lock);
  }
}

export type ConditionalWriteResult = 'written' | 'skipped' | 'failed';

export function writeStateFileLockedIf(
  filePath: string,
  predicate: (current: Record<string, unknown>) => boolean,
  transform: (current: Record<string, unknown>) => Record<string, unknown>,
): ConditionalWriteResult {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64) {
    try {
      const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
      atomicWriteJsonSync(filePath, replacement);
    } finally {
      delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH;
      delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64;
    }
  }
  if (!existsSync(filePath)) return 'skipped';
  const lock = acquireMutationLock(filePath);
  if (!lock) return 'failed';
  try {
    if (!existsSync(filePath)) return 'skipped';
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      return 'failed';
    }
    if (!predicate(current)) return 'skipped';
    atomicWriteJsonSync(filePath, transform(current));
    return 'written';
  } catch {
    return 'failed';
  } finally {
    releaseMutationLock(lock);
  }
}

export function getStateSessionOwner(state: Record<string, unknown> | null | undefined): string | undefined {
  if (!state || typeof state !== 'object') {
    return undefined;
  }

  const meta = state._meta;
  if (meta && typeof meta === 'object') {
    const metaSessionId = (meta as Record<string, unknown>).sessionId;
    if (typeof metaSessionId === 'string' && metaSessionId) {
      return metaSessionId;
    }
  }

  const topLevelSessionId = state.session_id;
  return typeof topLevelSessionId === 'string' && topLevelSessionId
    ? topLevelSessionId
    : undefined;
}

export function canClearStateForSession(
  state: Record<string, unknown> | null | undefined,
  sessionId: string,
): boolean {
  const ownerSessionId = getStateSessionOwner(state);
  return !ownerSessionId || ownerSessionId === sessionId;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveStateRoot(directory?: string): string {
  const baseDir = directory || process.cwd();
  return getGitTopLevel(baseDir) || baseDir;
}

/**
 * Resolve the state file path for a given mode.
 * When sessionId is provided, returns the session-scoped path.
 * Otherwise returns the legacy (global) path.
 */
function resolveFile(mode: string, directory?: string, sessionId?: string): string {
  const baseDir = resolveStateRoot(directory);
  if (sessionId) {
    return resolveSessionStatePath(mode, sessionId, baseDir);
  }
  return resolveStatePath(mode, baseDir);
}

function getLegacyStateCandidates(mode: string, directory?: string): string[] {
  const baseDir = resolveStateRoot(directory);
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;

  return [
    resolveStatePath(mode, baseDir),
    join(getOmcRoot(baseDir), `${normalizedName}.json`),
  ];
}

function getRuntimeArtifactCandidates(mode: string, directory?: string, sessionId?: string): string[] {
  const baseDir = resolveStateRoot(directory);
  const stateRoot = join(getOmcRoot(baseDir), 'state');
  const artifactNames = [
    `${mode}-stop-breaker.json`,
    `${mode}-last-steer-at`,
    `${mode}-continue-steer.lock`,
  ];
  const candidateDirs = new Set<string>([stateRoot]);

  if (sessionId) {
    candidateDirs.add(join(stateRoot, 'sessions', sessionId));
  } else {
    for (const sid of listSessionIds(baseDir)) {
      candidateDirs.add(join(stateRoot, 'sessions', sid));
    }
  }

  return [...candidateDirs].flatMap((dir) => artifactNames.map((name) => join(dir, name)));
}


/**
 * Find session-scoped state files that belong to the requested session.
 *
 * Normally the state file lives under `.omc/state/sessions/{sessionId}/`.
 * When a file is stranded under a different session directory (for example
 * after session continuation or manual recovery), this scans all session
 * directories and returns any file whose embedded owner still matches the
 * requested session.
 */
export interface StateFileDiscovery {
  path: string;
  snapshot: string;
  state: Record<string, unknown>;
  ownerSessionId?: string;
  workflowRunId?: string;
  completedSessionId?: string;
  completionEvidencePath?: string;
}

function discoverStateFile(path: string, extra: Partial<StateFileDiscovery> = {}): StateFileDiscovery | null {
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return {
      path,
      snapshot: JSON.stringify(state),
      state,
      ownerSessionId: getStateSessionOwner(state),
      workflowRunId: typeof state.workflowRunId === 'string' ? state.workflowRunId : undefined,
      ...extra,
    };
  } catch {
    return null;
  }
}

export function findSessionOwnedStateCandidates(
  mode: string,
  sessionId: string,
  directory?: string,
): StateFileDiscovery[] {
  const matches = new Map<string, StateFileDiscovery>();
  const baseDir = resolveStateRoot(directory);
  const expectedPath = resolveSessionStatePath(mode, sessionId, baseDir);
  const expected = discoverStateFile(expectedPath);
  if (expected) matches.set(expectedPath, expected);

  for (const sid of listSessionIds(baseDir)) {
    const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
    const candidate = discoverStateFile(candidatePath);
    if (candidate?.ownerSessionId === sessionId) matches.set(candidatePath, candidate);
  }
  return [...matches.values()];
}

export function findSessionOwnedStateFiles(mode: string, sessionId: string, directory?: string): string[] {
  return findSessionOwnedStateCandidates(mode, sessionId, directory).map((candidate) => candidate.path);
}

/**
 * Find active session-scoped state files that are safe to treat as orphaned.
 *
 * A fresh `/cancel` invocation may run in a new Claude session id while the
 * state files that keep the Stop hook alive still live under the completed
 * session's directory.  We intentionally require durable completion evidence
 * (`.omc/sessions/{sessionId}.json`) before returning a sibling session's file
 * so active parallel sessions are not cleared just because their ids differ
 * from the caller's fresh cancel session.
 */
export function findCompletedSessionStateCandidates(
  mode: string,
  directory?: string,
  requesterSessionId?: string,
): StateFileDiscovery[] {
  const matches: StateFileDiscovery[] = [];
  const baseDir = resolveStateRoot(directory);

  for (const sid of listSessionIds(baseDir)) {
    if (requesterSessionId && sid === requesterSessionId) continue;
    const completionEvidencePath = join(getOmcRoot(baseDir), 'sessions', `${sid}.json`);
    if (!existsSync(completionEvidencePath)) continue;
    const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
    const candidate = discoverStateFile(candidatePath, { completedSessionId: sid, completionEvidencePath });
    if (candidate?.state.active === true) matches.push(candidate);
  }
  return matches;
}

export function findCompletedSessionStateFiles(mode: string, directory?: string, requesterSessionId?: string): string[] {
  return findCompletedSessionStateCandidates(mode, directory, requesterSessionId).map((candidate) => candidate.path);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write mode state to disk.
 *
 * - Ensures parent directories exist.
 * - Writes with mode 0o600 (owner-only) for security.
 * - Adds `_meta` envelope with write timestamp.
 *
 * @returns true on success, false on failure
 */
export function writeModeState(
  mode: string,
  state: Record<string, unknown>,
  directory?: string,
  sessionId?: string,
): boolean {
  try {
    const baseDir = resolveStateRoot(directory);
    if (sessionId) {
      ensureSessionStateDir(sessionId, baseDir);
    } else {
      ensureOmcDir('state', baseDir);
    }
    const filePath = resolveFile(mode, directory, sessionId);
    // owner_pid is written at the top level (not only inside _meta) so external
    // hook scripts can perform process-liveness checks without parsing _meta.
    // Existing state shapes carry session_id at top level; owner_pid follows
    // the same convention. Readers that don't know the field ignore it.
    const ownerPid = typeof process.pid === 'number' ? process.pid : undefined;
    const envelope = {
      ...state,
      ...(ownerPid !== undefined && (state.owner_pid === undefined) ? { owner_pid: ownerPid } : {}),
      _meta: {
        written_at: new Date().toISOString(),
        mode,
        ...(sessionId ? { sessionId } : {}),
        ...(ownerPid !== undefined ? { ownerPid } : {}),
      },
    };
    return writeStateFileLocked(filePath, envelope);
  } catch {
    return false;
  }
}

/**
 * Read mode state from disk.
 *
 * When sessionId is provided, ONLY reads the session-scoped file (no legacy fallback)
 * to prevent cross-session state leakage.
 *
 * Strips the `_meta` envelope so callers get the original state shape.
 * Handles files written before _meta was introduced (no-op strip).
 *
 * @returns The parsed state (without _meta) or null if not found / unreadable.
 */
export function readModeState<T = Record<string, unknown>>(
  mode: string,
  directory?: string,
  sessionId?: string,
): T | null {
  const filePath = resolveFile(mode, directory, sessionId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    // Strip _meta envelope if present
    if (parsed && typeof parsed === 'object' && '_meta' in parsed) {
      const { _meta: _, ...rest } = parsed;
      return rest as T;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Clear (delete) a mode state file from disk.
 *
 * When sessionId is provided:
 * 1. Deletes the session-scoped file.
 * 2. Ghost-legacy cleanup: also removes the legacy file if it belongs to
 *    this session or has no session_id (orphaned).
 *
 * @returns true on success (or file already absent), false on failure.
 */
export function clearModeStateFile(
  mode: string,
  directory?: string,
  sessionId?: string,
  expectedState?: Record<string, unknown>,
): boolean {
  let success = true;
  const baseDir = resolveStateRoot(directory);
  const unlinkIfPresent = (filePath: string): void => {
    if (!clearStateFileLocked(filePath)) success = false;
  };

  if (sessionId) {
    const directPath = resolveFile(mode, directory, sessionId);
    if (expectedState) {
      const expectedSnapshot = JSON.stringify(Object.fromEntries(Object.entries(expectedState).filter(([key]) => key !== '_meta')));
      const result = clearStateFileLockedIf(
        directPath,
        (current) => JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_meta'))) === expectedSnapshot,
      );
      if (result === 'failed' || (result === 'skipped' && existsSync(directPath))) success = false;
    } else {
      unlinkIfPresent(directPath);
    }
    for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir, sessionId)) {
      unlinkIfPresent(artifactPath);
    }
  } else if (expectedState) {
    const directPath = resolveFile(mode, directory);
    const expectedSnapshot = JSON.stringify(Object.fromEntries(Object.entries(expectedState).filter(([key]) => key !== '_meta')));
    const result = clearStateFileLockedIf(
      directPath,
      (current) => JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_meta'))) === expectedSnapshot,
    );
    if (result === 'failed' || (result === 'skipped' && existsSync(directPath))) success = false;
    for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir)) unlinkIfPresent(artifactPath);
  } else {
    for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) unlinkIfPresent(legacyPath);
    for (const sid of listSessionIds(baseDir)) unlinkIfPresent(resolveSessionStatePath(mode, sid, baseDir));
    for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir)) unlinkIfPresent(artifactPath);
  }

  // Ghost-legacy cleanup: if sessionId provided, also check legacy path
  if (sessionId) {
    for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) {
      if (!existsSync(legacyPath)) {
        continue;
      }

      try {
        const observed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Record<string, unknown>;
        if (!canClearStateForSession(observed, sessionId)) continue;
        const observedSnapshot = JSON.stringify(observed);
        const result = clearStateFileLockedIf(
          legacyPath,
          (current) => canClearStateForSession(current, sessionId) && JSON.stringify(current) === observedSnapshot,
        );
        if (result === 'failed') success = false;
      } catch {
        // Can't read/parse — leave it alone.
      }
    }
  }

  return success;
}
