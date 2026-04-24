/**
 * OMC HUD - Stdin Parser
 *
 * Parse stdin JSON from Claude Code statusline interface.
 * Based on claude-hud reference implementation.
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getSessionStateDir, getWorktreeRoot, listSessionIds, resolveOmcPath, } from '../lib/worktree-paths.js';
const TRANSIENT_CONTEXT_PERCENT_TOLERANCE = 3;
// ============================================================================
// Stdin Cache (for --watch mode)
// ============================================================================
/**
 * Session-id environment variables consulted in priority order.
 * Claude Code populates `CLAUDE_SESSION_ID` first; `CLAUDECODE_SESSION_ID`
 * is a legacy / compatibility alias for the same value.
 */
const SESSION_ID_ENV_VARS = ['CLAUDE_SESSION_ID', 'CLAUDECODE_SESSION_ID'];
/**
 * Normalize an env value to a session-id candidate.
 * Empty / whitespace-only strings are treated as "not set" so a defined
 * but blank slot does not block the fallback to the next candidate.
 */
function normalizeCandidate(value) {
    if (!value)
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
/**
 * Resolve the stdin cache path.
 *
 * Walks the session-id env vars in priority order, and for each candidate
 * tries to resolve a session-scoped path via the shared validated helper
 * `getSessionStateDir` (which calls `validateSessionId`). A candidate
 * that fails validation (path traversal, disallowed chars, overlong) is
 * skipped so the next candidate still gets a chance — a non-empty-but-
 * invalid primary does not silently bypass a valid secondary. Only when
 * no candidate yields a valid session path do we fall back to the legacy
 * flat path.
 *
 * The file name remains `hud-stdin-cache.json` so that the existing
 * session-end cleanup pattern (`/^hud-stdin-cache\.json$/`) still matches
 * and no migration is required for existing environments.
 */
function getStdinCachePath() {
    const root = getWorktreeRoot() || process.cwd();
    for (const envVar of SESSION_ID_ENV_VARS) {
        const candidate = normalizeCandidate(process.env[envVar]);
        if (!candidate)
            continue;
        try {
            return join(getSessionStateDir(candidate, root), 'hud-stdin-cache.json');
        }
        catch {
            // Invalid session id — try the next candidate.
        }
    }
    // Legacy flat path must also resolve through the shared OMC-root helper so
    // `OMC_STATE_DIR`-backed deployments land on the same directory as writers.
    return resolveOmcPath('state/hud-stdin-cache.json', root);
}
/**
 * Persist the last successful stdin read to disk.
 * Used by --watch mode to recover data when stdin is a TTY.
 */
export function writeStdinCache(stdin) {
    try {
        const cachePath = getStdinCachePath();
        const cacheDir = dirname(cachePath);
        if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir, { recursive: true });
        }
        writeFileSync(cachePath, JSON.stringify(stdin));
    }
    catch {
        // Best-effort; ignore failures
    }
}
/**
 * Read the last cached stdin JSON.
 *
 * When a session id is available in the environment, the session-scoped
 * path is authoritative. Otherwise — e.g. `omc hud --watch` running as a
 * detached CLI/tmux process that never inherited the parent's session
 * env — we still need a way to surface the active session's cache; we
 * fall back first to the legacy flat path, and then to the most recently
 * updated `state/sessions/{id}/hud-stdin-cache.json` so the watch pane
 * does not stay stuck on an empty/starting view.
 *
 * Returns null if no cache exists or it is unreadable.
 */
export function readStdinCache() {
    const root = getWorktreeRoot() || process.cwd();
    const scopedPath = getStdinCachePath();
    const tryRead = (p) => {
        try {
            if (!existsSync(p))
                return null;
            return JSON.parse(readFileSync(p, 'utf-8'));
        }
        catch {
            return null;
        }
    };
    const scoped = tryRead(scopedPath);
    if (scoped)
        return scoped;
    // If the scoped path already *is* the legacy flat path (no session id
    // was available), there's no further lookup to try.
    const legacyPath = resolveOmcPath('state/hud-stdin-cache.json', root);
    if (scopedPath !== legacyPath) {
        return null;
    }
    // Env-less reader: pick the most recent session-scoped cache as a
    // best-effort surface of "the active session's HUD".
    return readMostRecentSessionCache(root);
}
/**
 * Scan `state/sessions/{id}/hud-stdin-cache.json` and return the contents
 * of the most recently modified one. Only used as a fallback when no
 * session id is available in the environment (e.g. a tmux-hosted
 * `omc hud --watch` reader that did not inherit `CLAUDE_SESSION_ID`).
 *
 * Uses the same OMC-root helpers as the writers (`listSessionIds` /
 * `getSessionStateDir`) so this fallback honors `OMC_STATE_DIR` and any
 * other centralized-state configuration.
 */
function readMostRecentSessionCache(root) {
    let sessionIds;
    try {
        sessionIds = listSessionIds(root);
    }
    catch {
        return null;
    }
    let bestPath = null;
    let bestMtime = -Infinity;
    for (const sid of sessionIds) {
        let candidate;
        try {
            candidate = join(getSessionStateDir(sid, root), 'hud-stdin-cache.json');
        }
        catch {
            continue;
        }
        try {
            const st = statSync(candidate);
            if (!st.isFile())
                continue;
            if (st.mtimeMs > bestMtime) {
                bestMtime = st.mtimeMs;
                bestPath = candidate;
            }
        }
        catch {
            // Skip unreadable entries
        }
    }
    if (!bestPath)
        return null;
    try {
        return JSON.parse(readFileSync(bestPath, 'utf-8'));
    }
    catch {
        return null;
    }
}
// ============================================================================
// Stdin Reader
// ============================================================================
/**
 * Read and parse stdin JSON from Claude Code.
 * Returns null if stdin is not available or invalid.
 */
export async function readStdin() {
    // Skip if running in TTY mode (interactive terminal)
    if (process.stdin.isTTY) {
        return null;
    }
    const chunks = [];
    try {
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const raw = chunks.join('');
        if (!raw.trim()) {
            return null;
        }
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function getCurrentUsage(stdin) {
    return stdin.context_window?.current_usage;
}
function clampPercent(value) {
    if (value == null || !isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(100, value));
}
function parseResetDate(value) {
    if (value == null) {
        return null;
    }
    const numericValue = typeof value === 'number'
        ? value
        : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
    if (Number.isFinite(numericValue)) {
        const millis = Math.abs(numericValue) < 1e12 ? numericValue * 1000 : numericValue;
        const date = new Date(millis);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value === 'string') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
}
/**
 * Get total tokens from stdin context_window.current_usage
 */
function getTotalTokens(stdin) {
    const usage = getCurrentUsage(stdin);
    return ((usage?.input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0));
}
function getRoundedNativeContextPercent(stdin) {
    const nativePercent = stdin?.context_window?.used_percentage;
    if (typeof nativePercent !== 'number' || Number.isNaN(nativePercent)) {
        return null;
    }
    return Math.min(100, Math.max(0, Math.round(nativePercent)));
}
function getManualContextPercent(stdin) {
    const size = stdin.context_window?.context_window_size;
    if (!size || size <= 0) {
        return null;
    }
    const totalTokens = getTotalTokens(stdin);
    return Math.min(100, Math.round((totalTokens / size) * 100));
}
function isSameContextStream(current, previous) {
    return current.cwd === previous.cwd
        && current.transcript_path === previous.transcript_path
        && current.context_window?.context_window_size === previous.context_window?.context_window_size;
}
/**
 * Preserve the last native context percentage across transient snapshots where Claude Code
 * omits `used_percentage`, but only when the fallback calculation is close enough to suggest
 * the same underlying value rather than a real context jump.
 */
export function stabilizeContextPercent(stdin, previousStdin) {
    if (getRoundedNativeContextPercent(stdin) !== null) {
        return stdin;
    }
    if (!previousStdin || !isSameContextStream(stdin, previousStdin)) {
        return stdin;
    }
    const previousNativePercent = getRoundedNativeContextPercent(previousStdin);
    if (previousNativePercent === null) {
        return stdin;
    }
    const manualPercent = getManualContextPercent(stdin);
    if (manualPercent !== null
        && Math.abs(manualPercent - previousNativePercent) > TRANSIENT_CONTEXT_PERCENT_TOLERANCE) {
        return stdin;
    }
    return {
        ...stdin,
        context_window: {
            ...stdin.context_window,
            used_percentage: previousStdin.context_window?.used_percentage ?? previousNativePercent,
        },
    };
}
/**
 * Get context window usage percentage.
 * Prefers native percentage from Claude Code statusline stdin, falls back to manual calculation.
 */
export function getContextPercent(stdin) {
    const nativePercent = getRoundedNativeContextPercent(stdin);
    if (nativePercent !== null) {
        return nativePercent;
    }
    return getManualContextPercent(stdin) ?? 0;
}
/**
 * Convert Claude Code stdin rate_limits into the existing HUD RateLimits shape.
 */
export function getRateLimitsFromStdin(stdin) {
    const fiveHour = stdin.rate_limits?.five_hour?.used_percentage;
    const sevenDay = stdin.rate_limits?.seven_day?.used_percentage;
    if (fiveHour == null && sevenDay == null) {
        return null;
    }
    return {
        fiveHourPercent: clampPercent(fiveHour),
        weeklyPercent: sevenDay == null ? undefined : clampPercent(sevenDay),
        fiveHourResetsAt: parseResetDate(stdin.rate_limits?.five_hour?.resets_at),
        weeklyResetsAt: parseResetDate(stdin.rate_limits?.seven_day?.resets_at),
    };
}
/**
 * Get model display name from stdin.
 * Prefer the official display name field, then fall back to the raw model id.
 */
export function getModelName(stdin) {
    return stdin.model?.display_name ?? stdin.model?.id ?? 'Unknown';
}
//# sourceMappingURL=stdin.js.map