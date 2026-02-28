/**
 * Mode State I/O Layer
 *
 * Canonical read/write/clear operations for mode state files.
 * Centralises path resolution, ghost-legacy cleanup, directory creation,
 * and file permissions so that individual mode modules don't duplicate this logic.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import {
  resolveStatePath,
  resolveSessionStatePath,
  ensureSessionStateDir,
  ensureOmcDir,
} from './worktree-paths.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the state file path for a given mode.
 * When sessionId is provided, returns the session-scoped path.
 * Otherwise returns the legacy (global) path.
 */
function resolveFile(mode: string, directory?: string, sessionId?: string): string {
  const baseDir = directory || process.cwd();
  if (sessionId) {
    return resolveSessionStatePath(mode, sessionId, baseDir);
  }
  return resolveStatePath(mode, baseDir);
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
    const baseDir = directory || process.cwd();
    if (sessionId) {
      ensureSessionStateDir(sessionId, baseDir);
    } else {
      ensureOmcDir('state', baseDir);
    }
    const filePath = resolveFile(mode, directory, sessionId);
    const envelope = { ...state, _meta: { written_at: new Date().toISOString(), mode } };
    writeFileSync(filePath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    return true;
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
): boolean {
  let success = true;
  const filePath = resolveFile(mode, directory, sessionId);

  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch {
      success = false;
    }
  }

  // Ghost-legacy cleanup: if sessionId provided, also check legacy path
  if (sessionId) {
    const legacyPath = resolveFile(mode, directory); // no sessionId = legacy
    if (existsSync(legacyPath)) {
      try {
        const content = readFileSync(legacyPath, 'utf-8');
        const legacyState = JSON.parse(content);
        // Only remove if it belongs to this session or is unowned
        if (!legacyState.session_id || legacyState.session_id === sessionId) {
          unlinkSync(legacyPath);
        }
      } catch {
        // Can't read/parse — leave it alone
      }
    }
  }

  return success;
}
