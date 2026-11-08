import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync, } from "fs";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { atomicWriteJsonSync } from "../lib/atomic-write.js";
import { isProcessAlive } from "../platform/index.js";
const STATE_DIR = [".omc", "state"];
const STATE_FILE = "openclaw-event-dedupe.json";
const LOCK_FILE = "openclaw-event-dedupe.lock";
const START_WINDOW_MS = 10_000;
const PROMPT_WINDOW_MS = 4_000;
const STOP_WINDOW_MS = 12_000;
const STATE_TTL_MS = 6 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10_000;
/**
 * How long after a terminal-state event (stop/session-end) to suppress
 * late lifecycle events for the same {projectPath}::{tmuxSession} scope.
 *
 * Chosen to be long enough to absorb hook-ordering races (sub-process startup
 * delays, detach/re-attach timing) while being short enough not to swallow
 * genuinely new sessions that start shortly after a cleanup.
 */
export const TERMINAL_STATE_SUPPRESSION_WINDOW_MS = 60_000;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) {
    try {
        Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
    }
    catch {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            // spin fallback for runtimes that reject Atomics.wait on main thread
        }
    }
}
function getStateDir(projectPath) {
    return join(projectPath, ...STATE_DIR);
}
function getStatePath(projectPath) {
    return join(getStateDir(projectPath), STATE_FILE);
}
function getLockPath(projectPath) {
    return join(getStateDir(projectPath), LOCK_FILE);
}
function ensureStateDir(projectPath) {
    mkdirSync(getStateDir(projectPath), { recursive: true, mode: 0o700 });
}
function readState(projectPath) {
    const statePath = getStatePath(projectPath);
    if (!existsSync(statePath)) {
        return { updatedAt: new Date(0).toISOString(), records: {} };
    }
    try {
        const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
        return {
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
            records: parsed.records && typeof parsed.records === "object" ? parsed.records : {},
        };
    }
    catch {
        return { updatedAt: new Date(0).toISOString(), records: {} };
    }
}
function writeState(projectPath, state) {
    ensureStateDir(projectPath);
    atomicWriteJsonSync(getStatePath(projectPath), state);
}
function readLockSnapshot(projectPath) {
    try {
        const raw = readFileSync(getLockPath(projectPath), "utf-8");
        const trimmed = raw.trim();
        if (!trimmed) {
            return { raw, pid: null, token: null };
        }
        try {
            const parsed = JSON.parse(trimmed);
            return {
                raw,
                pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : null,
                token: typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null,
            };
        }
        catch {
            return { raw, pid: null, token: null };
        }
    }
    catch {
        return null;
    }
}
function removeLockIfUnchanged(projectPath, snapshot) {
    try {
        const currentRaw = readFileSync(getLockPath(projectPath), "utf-8");
        if (currentRaw !== snapshot.raw) {
            return false;
        }
    }
    catch {
        return false;
    }
    try {
        unlinkSync(getLockPath(projectPath));
        return true;
    }
    catch {
        return false;
    }
}
function acquireLock(projectPath) {
    ensureStateDir(projectPath);
    const started = Date.now();
    while (Date.now() - started < LOCK_TIMEOUT_MS) {
        try {
            const token = randomUUID();
            const fd = openSync(getLockPath(projectPath), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
            writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }), null, "utf-8");
            return { fd, token };
        }
        catch (error) {
            const err = error;
            if (err.code !== "EEXIST") {
                throw error;
            }
            try {
                const ageMs = Date.now() - statSync(getLockPath(projectPath)).mtimeMs;
                if (ageMs > LOCK_STALE_MS) {
                    const snapshot = readLockSnapshot(projectPath);
                    if (snapshot) {
                        if (snapshot.pid !== null && isProcessAlive(snapshot.pid)) {
                            sleepMs(LOCK_RETRY_MS);
                            continue;
                        }
                        if (removeLockIfUnchanged(projectPath, snapshot)) {
                            continue;
                        }
                    }
                }
            }
            catch {
                // best effort stale lock cleanup
            }
            sleepMs(LOCK_RETRY_MS);
        }
    }
    return null;
}
function releaseLock(projectPath, lock) {
    try {
        closeSync(lock.fd);
    }
    catch {
        // ignore close failure
    }
    const snapshot = readLockSnapshot(projectPath);
    if (!snapshot || snapshot.token !== lock.token) {
        return;
    }
    removeLockIfUnchanged(projectPath, snapshot);
}
function withProjectLock(projectPath, callback) {
    const lock = acquireLock(projectPath);
    if (!lock) {
        return callback();
    }
    try {
        return callback();
    }
    finally {
        releaseLock(projectPath, lock);
    }
}
function normalizePrompt(prompt) {
    return prompt.replace(/\s+/g, " ").trim().slice(0, 400);
}
function promptHash(prompt) {
    return createHash("sha1").update(prompt).digest("hex").slice(0, 12);
}
function buildDescriptor(event, signal, context, tmuxSession, projectPath) {
    const scope = `${projectPath}::${tmuxSession}`;
    switch (event) {
        case "session-start":
            return {
                key: `session.started::${scope}`,
                windowMs: START_WINDOW_MS,
            };
        case "keyword-detector": {
            const prompt = typeof context.prompt === "string" ? normalizePrompt(context.prompt) : "";
            if (!prompt) {
                return null;
            }
            return {
                key: `session.prompt-submitted::${scope}::${promptHash(prompt)}`,
                windowMs: PROMPT_WINDOW_MS,
            };
        }
        case "stop":
            return {
                key: `session.stopped::${scope}`,
                windowMs: STOP_WINDOW_MS,
            };
        case "session-end":
            return {
                key: `session.finished::${scope}`,
                windowMs: STOP_WINDOW_MS,
            };
        default:
            return null;
    }
}
function pruneState(state, nowMs) {
    const cutoff = nowMs - STATE_TTL_MS;
    for (const [key, record] of Object.entries(state.records)) {
        const lastSeenMs = Date.parse(record.lastSeenAt);
        if (!Number.isFinite(lastSeenMs) || lastSeenMs < cutoff) {
            delete state.records[key];
        }
    }
}
/**
 * Terminal-state record keys that suppress late lifecycle noise.
 *
 * session.stopped  = a `stop` (idle) event fired for this scope
 * session.finished = a `session-end` event fired for this scope
 */
const TERMINAL_KEYS = ["session.stopped", "session.finished"];
/**
 * Returns true when `event` is a late lifecycle event that has been rendered
 * obsolete by a prior terminal-state record in `state`.
 *
 * Guards:
 *   - session-start arriving after session.stopped or session.finished → suppress
 *   - stop arriving after session.finished → suppress
 *
 * The check window is TERMINAL_STATE_SUPPRESSION_WINDOW_MS.  Obsolete events
 * must NOT update dedupe state so the terminal record stays alive for further
 * suppression checks within the same window.
 */
export function isObsoleteAfterTerminalState(event, state, tmuxSession, projectPath, nowMs) {
    if (event !== "session-start" && event !== "stop") {
        return false;
    }
    const scope = `${projectPath}::${tmuxSession}`;
    // stop is only suppressed by session.finished (the harder terminal state);
    // a prior stop alone does not suppress another stop.
    const keysToCheck = event === "session-start" ? TERMINAL_KEYS : ["session.finished"];
    return keysToCheck.some((prefix) => {
        const record = state.records[`${prefix}::${scope}`];
        if (!record)
            return false;
        const lastSeenMs = Date.parse(record.lastSeenAt);
        return (Number.isFinite(lastSeenMs) &&
            nowMs - lastSeenMs < TERMINAL_STATE_SUPPRESSION_WINDOW_MS);
    });
}
export function shouldCollapseOpenClawBurst(event, signal, context, tmuxSession) {
    const projectPath = context.projectPath;
    if (!projectPath || !tmuxSession) {
        return false;
    }
    const descriptor = buildDescriptor(event, signal, context, tmuxSession, projectPath);
    if (!descriptor) {
        return false;
    }
    return withProjectLock(projectPath, () => {
        const state = readState(projectPath);
        const nowMs = Date.now();
        pruneState(state, nowMs);
        // Freshness/terminal-state suppression: drop late lifecycle events that
        // arrive after the session has already reached a terminal state.
        // Do NOT update dedupe state here so the terminal record stays alive for
        // further suppression checks within the window.
        if (isObsoleteAfterTerminalState(event, state, tmuxSession, projectPath, nowMs)) {
            return true;
        }
        const nowIso = new Date(nowMs).toISOString();
        const existing = state.records[descriptor.key];
        const lastSeenMs = existing ? Date.parse(existing.lastSeenAt) : Number.NaN;
        const shouldCollapse = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < descriptor.windowMs;
        state.records[descriptor.key] = {
            event,
            routeKey: signal.routeKey,
            tmuxSession,
            lastSeenAt: nowIso,
            count: (existing?.count ?? 0) + 1,
        };
        state.updatedAt = nowIso;
        writeState(projectPath, state);
        return shouldCollapse;
    });
}
//# sourceMappingURL=dedupe.js.map