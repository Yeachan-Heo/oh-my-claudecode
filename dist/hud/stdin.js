/**
 * OMC HUD - Stdin Parser
 *
 * Parse stdin JSON from Claude Code statusline interface.
 * Based on claude-hud reference implementation.
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { dirname } from 'path';
import { getWorktreeRoot, listSessionIds, resolveSessionStatePaths, } from '../lib/worktree-paths.js';
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
const HUD_STDIN_CACHE_STATE_NAME = 'hud-stdin-cache';
const HUD_STDIN_CACHE_FILE_NAME = 'hud-stdin-cache.json';
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
 * Resolve the stdin cache paths.
 *
 * Walks the session-id env vars in priority order, and for each candidate
 * tries to resolve a session-scoped path via the canonical
 * `resolveSessionStatePaths` helper. A candidate
 * that fails validation (path traversal, disallowed chars, overlong) is
 * skipped so the next candidate still gets a chance — a non-empty-but-
 * invalid primary does not silently bypass a valid secondary.
 *
 * When env vars are absent, falls back to stdin.session_id if available,
 * then finally to the legacy flat path. This prevents concurrent sessions
 * without env vars from clobbering the same flat cache file.
 *
 * The file name remains `hud-stdin-cache.json` so that the existing
 * session-end cleanup pattern (`/^hud-stdin-cache\.json$/`) still matches
 * and no migration is required for existing environments.
 */
function getStdinCachePaths(stdin, root = getWorktreeRoot() || process.cwd()) {
    for (const envVar of SESSION_ID_ENV_VARS) {
        const candidate = normalizeCandidate(process.env[envVar]);
        if (!candidate)
            continue;
        try {
            return resolveSessionStatePaths(HUD_STDIN_CACHE_STATE_NAME, candidate, root, {
                fileName: HUD_STDIN_CACHE_FILE_NAME,
            });
        }
        catch {
            // Invalid session id — try the next candidate.
        }
    }
    // Fallback to stdin.session_id when env vars are absent, preventing
    // concurrent sessions without env context from writing to the same flat path.
    const stdinSessionId = stdin ? normalizeCandidate(stdin.session_id) : null;
    if (stdinSessionId) {
        try {
            return resolveSessionStatePaths(HUD_STDIN_CACHE_STATE_NAME, stdinSessionId, root, {
                fileName: HUD_STDIN_CACHE_FILE_NAME,
            });
        }
        catch {
            // Invalid session id in stdin — fall through to legacy flat path.
        }
    }
    return resolveSessionStatePaths(HUD_STDIN_CACHE_STATE_NAME, undefined, root, {
        fileName: HUD_STDIN_CACHE_FILE_NAME,
    });
}
/**
 * Persist the last successful stdin read to disk.
 * Used by --watch mode to recover data when stdin is a TTY.
 *
 * Uses stdin.session_id as a fallback session identifier when env vars are
 * absent, so concurrent sessions without env context do not overwrite each
 * other's cache. Unchanged payloads refresh mtime because env-less readers use
 * recency to identify the most recently active session.
 */
export function writeStdinCache(stdin) {
    try {
        const cachePath = getStdinCachePaths(stdin).effectiveWrite;
        const cacheDir = dirname(cachePath);
        if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir, { recursive: true });
        }
        const newContent = JSON.stringify(stdin);
        if (existsSync(cachePath)) {
            try {
                const existingContent = readFileSync(cachePath, 'utf-8');
                if (existingContent === newContent) {
                    // Keep the activity signal current without rewriting identical JSON.
                    const now = new Date();
                    try {
                        utimesSync(cachePath, now, now);
                        return;
                    }
                    catch {
                        // Fall through to a content write if the timestamp cannot be refreshed.
                    }
                }
            }
            catch {
                // If we can't read the existing file, fall through and write anyway.
            }
        }
        writeFileSync(cachePath, newContent);
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
 * prefer the most recently updated valid `state/sessions/{id}/hud-stdin-cache.json`
 * and then fall back to the legacy flat path so the watch pane does not stay
 * stuck on an empty/starting view.
 *
 * Returns null if no cache exists or it is unreadable.
 */
export function readStdinCache() {
    const root = getWorktreeRoot() || process.cwd();
    const paths = getStdinCachePaths(undefined, root);
    const tryRead = (p) => {
        try {
            if (!existsSync(p))
                return null;
            return parseCachedStdin(readFileSync(p, 'utf-8'));
        }
        catch {
            return null;
        }
    };
    if (paths.sessionScoped) {
        return tryRead(paths.sessionScoped);
    }
    // Env-less reader: compare the legacy and session-scoped caches by mtime and
    // return the newest valid entry. This lets a current session cache outrank a
    // stale legacy snapshot without allowing an older session cache to hide a
    // newer flat cache written by a statusline process without session context.
    return readMostRecentCache(root, paths.legacy);
}
/** Parse only object-shaped cache entries; malformed values are not cache hits. */
function parseCachedStdin(raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return null;
    return parsed;
}
/**
 * Scan the legacy and session-scoped cache paths and return the contents of
 * the most recently modified valid one. Only used when no session id is
 * available in the environment (e.g. a tmux-hosted `omc hud --watch` reader
 * that did not inherit `CLAUDE_SESSION_ID`). Malformed newest entries are
 * skipped so they do not hide an older valid cache.
 *
 * Uses the same canonical session-path resolver as the writer so this
 * fallback honors `OMC_STATE_DIR` and centralized-state configuration.
 */
function readMostRecentCache(root, legacyPath) {
    let sessionIds;
    try {
        sessionIds = listSessionIds(root);
    }
    catch {
        return null;
    }
    const candidates = [];
    try {
        const st = statSync(legacyPath);
        if (st.isFile())
            candidates.push({ path: legacyPath, mtimeMs: st.mtimeMs });
    }
    catch {
        // The legacy cache is optional.
    }
    for (const sid of sessionIds) {
        let candidate;
        try {
            candidate = resolveSessionStatePaths(HUD_STDIN_CACHE_STATE_NAME, sid, root, {
                fileName: HUD_STDIN_CACHE_FILE_NAME,
            }).sessionScoped;
        }
        catch {
            continue;
        }
        try {
            const st = statSync(candidate);
            if (!st.isFile())
                continue;
            candidates.push({ path: candidate, mtimeMs: st.mtimeMs });
        }
        catch {
            // Skip unreadable entries
        }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    for (const candidate of candidates) {
        try {
            const parsed = parseCachedStdin(readFileSync(candidate.path, 'utf-8'));
            if (parsed)
                return parsed;
        }
        catch {
            // A corrupt newest cache must not hide an older valid session cache.
        }
    }
    return null;
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
        (usage?.cache_creation_input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0));
}
function getTotalInputTokens(stdin) {
    return stdin.context_window?.total_input_tokens ?? 0;
}
function getRoundedNativeContextPercent(stdin) {
    const nativePercent = stdin?.context_window?.used_percentage;
    if (typeof nativePercent !== 'number' || Number.isNaN(nativePercent)) {
        return null;
    }
    return Math.min(100, Math.max(0, Math.round(nativePercent)));
}
function getPositiveNativeContextPercent(stdin) {
    const nativePercent = stdin?.context_window?.used_percentage;
    if (typeof nativePercent !== 'number' || Number.isNaN(nativePercent) || nativePercent <= 0) {
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
function getPositiveManualContextPercent(stdin) {
    const manualPercent = getManualContextPercent(stdin);
    return manualPercent !== null && manualPercent > 0 ? manualPercent : null;
}
function getTotalInputContextPercent(stdin) {
    const size = stdin.context_window?.context_window_size;
    if (!size || size <= 0) {
        return null;
    }
    const totalInputTokens = getTotalInputTokens(stdin);
    if (totalInputTokens <= 0) {
        return null;
    }
    return Math.min(100, Math.round((totalInputTokens / size) * 100));
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
    if (getPositiveNativeContextPercent(stdin) !== null) {
        return stdin;
    }
    if (!previousStdin || !isSameContextStream(stdin, previousStdin)) {
        return stdin;
    }
    const previousNativePercent = getRoundedNativeContextPercent(previousStdin);
    if (previousNativePercent === null) {
        return stdin;
    }
    const fallbackPercent = getPositiveManualContextPercent(stdin) ?? getTotalInputContextPercent(stdin);
    if (fallbackPercent === null && getRoundedNativeContextPercent(stdin) === 0) {
        return stdin;
    }
    if (fallbackPercent !== null
        && Math.abs(fallbackPercent - previousNativePercent) > TRANSIENT_CONTEXT_PERCENT_TOLERANCE) {
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
 * Prefers a positive native percentage from Claude Code statusline stdin,
 * then positive current_usage tokens, then positive total_input_tokens for
 * Anthropic-compatible providers that report zeroed native usage.
 */
export function getContextPercent(stdin) {
    return (getPositiveNativeContextPercent(stdin)
        ?? getPositiveManualContextPercent(stdin)
        ?? getTotalInputContextPercent(stdin)
        ?? 0);
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
    const result = {};
    if (fiveHour != null) {
        result.fiveHourPercent = clampPercent(fiveHour);
        result.fiveHourResetsAt = parseResetDate(stdin.rate_limits?.five_hour?.resets_at);
    }
    if (sevenDay != null) {
        result.weeklyPercent = clampPercent(sevenDay);
        result.weeklyResetsAt = parseResetDate(stdin.rate_limits?.seven_day?.resets_at);
    }
    return result;
}
/**
 * Get model display name from stdin.
 * Prefer the official display name field, then fall back to the raw model id.
 * Returns null when Claude Code does not provide model metadata so the HUD
 * omits the model instead of guessing or showing a fake placeholder.
 */
export function getModelId(stdin) {
    const modelId = stdin.model?.id?.trim();
    return modelId || null;
}
export function getEffortLevel(stdin) {
    return stdin.effort?.level?.trim() || null;
}
export function getModelName(stdin) {
    const displayName = stdin.model?.display_name?.trim();
    return displayName || getModelId(stdin);
}
//# sourceMappingURL=stdin.js.map