/**
 * OMC HUD - Multi-Repo Element
 *
 * Renders a multi-repo workspace indicator when the cwd is a parent
 * directory holding multiple sibling git repos (e.g. `bidchex-repos/`
 * containing `bidchex-backend/`, `bidchex-frontend/`, …).
 *
 * Two modes:
 *  - Marker present (`.omc-workspace` at cwd): show
 *      mr:<parent> | repos:N | sessions:M
 *  - Marker missing: show a one-line suggestion to create it.
 *
 * When the cwd IS itself a git repo (single-repo case) this element
 * returns null and the normal repo/branch/status elements take over.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { cyan, dim, green, yellow } from '../colors.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
/**
 * Liveness window for the session counter. A session dir whose
 * mtime (or any file inside) is within this window counts as active.
 *
 * 5 minutes balances responsiveness (a closed Claude Code drops off
 * quickly) with tolerance for short user idleness between tool calls.
 * Claude Code fires hooks on every tool invocation and writes hud
 * state on every render, so any active session keeps the dir mtime
 * fresh well inside this window.
 *
 * PID-based liveness is intentionally NOT used: installed hooks run
 * through scripts/run.cjs, whose short-lived process exits as soon
 * as the hook returns — see scripts/session-start.mjs:104.
 */
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
/**
 * Claude Code session IDs are UUIDs. Anchor on this to filter out
 * unrelated subdirectories without depending on any specific marker
 * file (different hooks may or may not have run yet for a given
 * session — e.g. session-started.json is missing if the session-start
 * hook crashed or the user is on an older install).
 */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL_MS = 30_000;
const multiRepoCache = new Map();
/** For tests. */
export function resetMultiRepoCache() {
    multiRepoCache.clear();
}
function isGitRepo(dir) {
    try {
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: dir,
            encoding: 'utf-8',
            timeout: 1000,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return true;
    }
    catch {
        return false;
    }
}
function looksLikeRepo(entryPath) {
    // .git can be a directory (normal clone) or a file (worktree / submodule).
    return existsSync(join(entryPath, '.git'));
}
/**
 * Count session directories under `<cwd>/.omc/state/sessions/`.
 *
 * A session is "active" when both:
 *  1. The directory name matches a Claude Code session UUID — filters
 *     out unrelated subdirectories without depending on any specific
 *     marker file.
 *  2. The dir mtime — or any file inside, as a fallback for FS that
 *     don't bubble child mtime — is within ACTIVITY_WINDOW_MS.
 *
 * This relies on Claude Code firing hooks on every tool call (and
 * writing hud state on every render), which keeps mtime fresh while
 * the user is interacting with the session.
 */
function countActiveSessions(cwd) {
    // cwd here is verified to be the workspace anchor (marker present),
    // so getOmcRoot resolves to <cwd>/.omc. Route through the canonical
    // helper so OMC_STATE_DIR and OMC_DISABLE_MULTIREPO are honored.
    const sessionsDir = join(getOmcRoot(cwd), 'state', 'sessions');
    if (!existsSync(sessionsDir))
        return 0;
    const now = Date.now();
    let active = 0;
    try {
        const entries = readdirSync(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (!SESSION_ID_PATTERN.test(entry.name))
                continue;
            const dirPath = join(sessionsDir, entry.name);
            let fresh = false;
            try {
                if (now - statSync(dirPath).mtimeMs < ACTIVITY_WINDOW_MS) {
                    fresh = true;
                }
                else {
                    // Fallback: parent mtime may not reflect child writes on
                    // some filesystems. Scan immediate children.
                    for (const f of readdirSync(dirPath)) {
                        try {
                            if (now - statSync(join(dirPath, f)).mtimeMs < ACTIVITY_WINDOW_MS) {
                                fresh = true;
                                break;
                            }
                        }
                        catch { /* skip */ }
                    }
                }
            }
            catch { /* skip */ }
            if (fresh)
                active++;
        }
    }
    catch {
        return 0;
    }
    return active;
}
/**
 * Detect multi-repo workspace state for the given cwd.
 *
 * Returns null when:
 *  - cwd is itself a git repo (single-repo case — let the normal git
 *    elements handle it)
 *  - cwd has fewer than 2 git-repo children (not actually multi-repo)
 *
 * Returns a populated MultiRepoInfo otherwise.
 */
export function detectMultiRepo(cwd) {
    const key = cwd ? resolve(cwd) : process.cwd();
    const cached = multiRepoCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
    }
    let result = null;
    try {
        // If cwd is inside a git repo, skip — that's the single-repo path.
        if (isGitRepo(key)) {
            multiRepoCache.set(key, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
            return null;
        }
        // Scan one level for sub-repos.
        let subrepoCount = 0;
        try {
            const entries = readdirSync(key, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                if (entry.name.startsWith('.'))
                    continue;
                if (looksLikeRepo(join(key, entry.name)))
                    subrepoCount++;
            }
        }
        catch {
            // unreadable cwd — nothing to report
        }
        if (subrepoCount < 2) {
            multiRepoCache.set(key, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
            return null;
        }
        const hasMarker = existsSync(join(key, '.omc-workspace'));
        const activeSessions = hasMarker ? countActiveSessions(key) : 0;
        result = {
            isMultiRepo: true,
            hasMarker,
            parentName: basename(key),
            subrepoCount,
            activeSessions,
        };
    }
    catch {
        result = null;
    }
    multiRepoCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
}
/**
 * Render the multi-repo chip. Returns null when not in a multi-repo
 * parent (the caller should fall through to renderGitRepo/Branch/Status).
 *
 * Examples:
 *   mr:bidchex-repos repos:11 sessions:2
 *   multi-repo detected — create .omc-workspace to enable shared state
 */
export function renderMultiRepo(cwd) {
    const info = detectMultiRepo(cwd);
    if (!info || !info.isMultiRepo)
        return null;
    if (!info.hasMarker) {
        return (yellow('⚠ multi-repo detected') +
            dim(' — run: ') +
            cyan(`echo {} > "${info.parentName}/.omc-workspace"`) +
            dim(' to enable shared state'));
    }
    // ~ prefix signals "best-effort": liveness is inferred from mtime
    // within a 5-min window, not from a process check. An idle session
    // (no tool calls for >5 min) will drop off; a freshly closed one
    // will linger until the window expires.
    const sessionsPart = info.activeSessions > 0
        ? ` ${dim('sessions:~')}${green(String(info.activeSessions))}`
        : ` ${dim('sessions:~')}${dim('0')}`;
    return (`${dim('mr:')}${cyan(info.parentName)}` +
        ` ${dim('repos:')}${cyan(String(info.subrepoCount))}` +
        sessionsPart);
}
//# sourceMappingURL=multi-repo.js.map