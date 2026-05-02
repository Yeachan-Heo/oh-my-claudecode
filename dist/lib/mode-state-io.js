/**
 * Mode State I/O Layer
 *
 * Canonical read/write/clear operations for mode state files.
 * Centralises path resolution, ghost-legacy cleanup, directory creation,
 * and file permissions so that individual mode modules don't duplicate this logic.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getOmcRoot, resolveStatePath, resolveSessionStatePath, ensureSessionStateDir, ensureOmcDir, listSessionIds, getWorktreeRoot, } from './worktree-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
export function getStateSessionOwner(state) {
    if (!state || typeof state !== 'object') {
        return undefined;
    }
    const meta = state._meta;
    if (meta && typeof meta === 'object') {
        const metaSessionId = meta.sessionId;
        if (typeof metaSessionId === 'string' && metaSessionId) {
            return metaSessionId;
        }
    }
    const topLevelSessionId = state.session_id;
    return typeof topLevelSessionId === 'string' && topLevelSessionId
        ? topLevelSessionId
        : undefined;
}
export function canClearStateForSession(state, sessionId) {
    const ownerSessionId = getStateSessionOwner(state);
    return !ownerSessionId || ownerSessionId === sessionId;
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function resolveStateRoot(directory) {
    const baseDir = directory || process.cwd();
    return getWorktreeRoot(baseDir) || baseDir;
}
/**
 * Resolve the state file path for a given mode.
 * When sessionId is provided, returns the session-scoped path.
 * Otherwise returns the legacy (global) path.
 */
function resolveFile(mode, directory, sessionId) {
    const baseDir = resolveStateRoot(directory);
    if (sessionId) {
        return resolveSessionStatePath(mode, sessionId, baseDir);
    }
    return resolveStatePath(mode, baseDir);
}
function getLegacyStateCandidates(mode, directory) {
    const baseDir = resolveStateRoot(directory);
    const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
    return [
        resolveStatePath(mode, baseDir),
        join(getOmcRoot(baseDir), `${normalizedName}.json`),
    ];
}
function getRuntimeArtifactCandidates(mode, directory, sessionId) {
    const baseDir = resolveStateRoot(directory);
    const stateRoot = join(getOmcRoot(baseDir), 'state');
    const artifactNames = [
        `${mode}-stop-breaker.json`,
        `${mode}-last-steer-at`,
        `${mode}-continue-steer.lock`,
    ];
    const candidateDirs = new Set([stateRoot]);
    if (sessionId) {
        candidateDirs.add(join(stateRoot, 'sessions', sessionId));
    }
    else {
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
export function findSessionOwnedStateFiles(mode, sessionId, directory) {
    const matches = new Set();
    const baseDir = resolveStateRoot(directory);
    const expectedPath = resolveSessionStatePath(mode, sessionId, baseDir);
    if (existsSync(expectedPath)) {
        matches.add(expectedPath);
    }
    for (const sid of listSessionIds(baseDir)) {
        const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
        if (!existsSync(candidatePath)) {
            continue;
        }
        try {
            const raw = JSON.parse(readFileSync(candidatePath, 'utf-8'));
            if (getStateSessionOwner(raw) === sessionId) {
                matches.add(candidatePath);
            }
        }
        catch {
            // Ignore unreadable files and keep scanning.
        }
    }
    return [...matches];
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
export function writeModeState(mode, state, directory, sessionId) {
    try {
        const baseDir = resolveStateRoot(directory);
        if (sessionId) {
            ensureSessionStateDir(sessionId, baseDir);
        }
        else {
            ensureOmcDir('state', baseDir);
        }
        const filePath = resolveFile(mode, directory, sessionId);
        const envelope = {
            ...state,
            _meta: { written_at: new Date().toISOString(), mode, ...(sessionId ? { sessionId } : {}) },
        };
        atomicWriteJsonSync(filePath, envelope);
        return true;
    }
    catch {
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
export function readModeState(mode, directory, sessionId) {
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
            return rest;
        }
        return parsed;
    }
    catch {
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
export function clearModeStateFile(mode, directory, sessionId) {
    let success = true;
    const baseDir = resolveStateRoot(directory);
    const unlinkIfPresent = (filePath) => {
        if (!existsSync(filePath)) {
            return;
        }
        try {
            unlinkSync(filePath);
        }
        catch {
            success = false;
        }
    };
    if (sessionId) {
        unlinkIfPresent(resolveFile(mode, directory, sessionId));
        for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir, sessionId)) {
            unlinkIfPresent(artifactPath);
        }
    }
    else {
        for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) {
            unlinkIfPresent(legacyPath);
        }
        for (const sid of listSessionIds(baseDir)) {
            unlinkIfPresent(resolveSessionStatePath(mode, sid, baseDir));
        }
        for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir)) {
            unlinkIfPresent(artifactPath);
        }
    }
    // Ghost-legacy cleanup: if sessionId provided, also check legacy path
    if (sessionId) {
        for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) {
            if (!existsSync(legacyPath)) {
                continue;
            }
            try {
                const content = readFileSync(legacyPath, 'utf-8');
                const legacyState = JSON.parse(content);
                // Only remove if it belongs to this session or is unowned
                if (canClearStateForSession(legacyState, sessionId)) {
                    unlinkSync(legacyPath);
                }
            }
            catch {
                // Can't read/parse — leave it alone
            }
        }
    }
    return success;
}
//# sourceMappingURL=mode-state-io.js.map