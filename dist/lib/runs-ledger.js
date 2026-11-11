/**
 * Run ledger (P2 Part A, contract: docs/design/P2-RUN-LEDGER-AND-INTAKE-PLAN.md).
 *
 * Append-only JSONL at `<omcRoot>/state/runs/ledger.jsonl` recording the
 * lifecycle edges of watched unattended modes. Mode state files are wiped by
 * cancel BEFORE the Stop event fires, so a durable trace that survives cancel
 * is the prerequisite for any closeout reconciliation: without this ledger,
 * "did the run write its closeout?" is unanswerable after the fact.
 *
 * Evidence by contract: append failures are swallowed. The ledger is
 * promotion/audit evidence — a broken ledger must never break the state
 * write or clear it observes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
/** The unattended modes whose lifecycle edges are recorded. */
export const WATCHED_RUN_MODES = ['ralph', 'autopilot', 'team', 'ultragoal'];
const LEDGER_TAIL_LINES = 1000;
export function isWatchedRunMode(modeName) {
    return WATCHED_RUN_MODES.includes(modeName);
}
function ledgerPath(omcRoot) {
    return join(omcRoot, 'state', 'runs', 'ledger.jsonl');
}
/**
 * Find the latest unmatched 'start' edge for a run+sessionId in the bounded
 * main ledger file. Returns undefined when no usable start edge is found.
 */
function findLatestStartEdge(omcRoot, mode, sessionId) {
    try {
        const path = ledgerPath(omcRoot);
        if (!existsSync(path))
            return undefined;
        const lines = readFileSync(path, 'utf8').split('\n');
        let unmatchedEnds = 0;
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            if (lines[i].trim().length === 0)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(lines[i]);
            }
            catch {
                continue;
            }
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
                continue;
            const entry = parsed;
            if (entry.run !== mode || entry.sessionId !== sessionId)
                continue;
            if (entry.event === 'end') {
                unmatchedEnds += 1;
                continue;
            }
            if (entry.event !== 'start')
                continue;
            if (unmatchedEnds > 0) {
                unmatchedEnds -= 1;
                continue;
            }
            return typeof entry.ts === 'string' && Number.isFinite(Date.parse(entry.ts)) ? entry.ts : undefined;
        }
    }
    catch {
        // Unable to read the bounded main ledger; fall back to started_at.
    }
    return undefined;
}
/** True when the mode's notepad gained a write after the run started. */
export function closeoutWrittenFor(omcRoot, mode, startedAt) {
    if (!startedAt || !Number.isFinite(Date.parse(startedAt)))
        return false;
    const started = Date.parse(startedAt);
    for (const name of ['problems.md', 'issues.md']) {
        const notepad = join(omcRoot, 'notepads', mode, name);
        try {
            if (existsSync(notepad) && statSync(notepad).mtimeMs > started)
                return true;
        }
        catch {
            // unreadable notepad cannot prove a closeout
        }
    }
    return false;
}
/**
 * Append one lifecycle edge. sessionId is included when the state file is
 * session-scoped so the reconciler can attribute the entry.
 */
export function appendRunLedger(omcRoot, entry) {
    try {
        const dir = join(omcRoot, 'state', 'runs');
        mkdirSync(dir, { recursive: true });
        const path = ledgerPath(omcRoot);
        rotateIfNeeded(path);
        appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    }
    catch {
        // evidence by contract
    }
}
function rotateIfNeeded(path) {
    try {
        const stat = statSync(path);
        if (!stat.isFile())
            return;
        const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
        if (lines.length < LEDGER_TAIL_LINES)
            return;
        // Append all lines to .1 for archival, then clear main for fresh appends.
        // This keeps the total ledger bounded: .1 has rotated batches, main has recent entries.
        appendFileSync(`${path}.1`, `${lines.join('\n')}\n`, 'utf8');
        writeFileSync(path, '', 'utf8');
    }
    catch {
        // rotation is best-effort; appends tolerate a missing or locked file
    }
}
/**
 * Observe a successful state write: append a `start` edge when a watched
 * mode's state becomes active. Idempotent per process — repeated writes of
 * an already-active state do not duplicate the start edge.
 */
export function observeModeStateWrite(omcRoot, filePath, state) {
    try {
        const mode = modeFromStatePath(filePath);
        if (!mode || !isWatchedRunMode(mode))
            return;
        if (state?.active !== true)
            return;
        const key = filePath;
        if (activeLoggedPaths.get(key))
            return;
        activeLoggedPaths.set(key, true);
        appendRunLedger(omcRoot, {
            ts: new Date().toISOString(),
            run: mode,
            sessionId: sessionIdFromStatePath(filePath),
            event: 'start',
            outcome: 'running',
        });
    }
    catch {
        // evidence by contract
    }
}
/**
 * Observe a conditional state write: append a `start` edge when a watched
 * mode goes from inactive (or absent) to active. The transition is the
 * idempotency guard, so this does not consult the per-process map, which a
 * clear in another process leaves stale.
 */
export function observeModeStateActivation(omcRoot, filePath, previous, next) {
    try {
        if (previous?.active === true || next?.active !== true)
            return;
        const mode = modeFromStatePath(filePath);
        if (!mode || !isWatchedRunMode(mode))
            return;
        activeLoggedPaths.set(filePath, true);
        appendRunLedger(omcRoot, {
            ts: new Date().toISOString(),
            run: mode,
            sessionId: sessionIdFromStatePath(filePath),
            event: 'start',
            outcome: 'running',
        });
    }
    catch {
        // evidence by contract
    }
}
/**
 * Observe a successful state clear: append an `end` edge when a watched
 * mode's previously-active state is removed, carrying the outcome and the
 * closeout flag computed against the run's notepad.
 */
export function observeModeStateClear(omcRoot, filePath, previousState) {
    try {
        const mode = modeFromStatePath(filePath);
        if (!mode || !isWatchedRunMode(mode))
            return;
        if (!previousState || previousState.active !== true)
            return;
        if (previousState.active === true)
            activeLoggedPaths.delete(filePath);
        // Use the later of the stored start time and the latest unmatched ledger
        // start edge. A resumed mode can retain a stale started_at value.
        const staleStartedAt = typeof previousState.started_at === 'string' ? previousState.started_at : undefined;
        const sessionId = sessionIdFromStatePath(filePath);
        const latestStartEdge = findLatestStartEdge(omcRoot, mode, sessionId);
        const staleStartedAtMs = staleStartedAt ? Date.parse(staleStartedAt) : Number.NaN;
        const latestStartEdgeMs = latestStartEdge ? Date.parse(latestStartEdge) : Number.NaN;
        const closeoutBoundary = Number.isFinite(latestStartEdgeMs) &&
            (!Number.isFinite(staleStartedAtMs) || latestStartEdgeMs > staleStartedAtMs)
            ? latestStartEdge
            : staleStartedAt;
        appendRunLedger(omcRoot, {
            ts: new Date().toISOString(),
            run: mode,
            sessionId,
            event: 'end',
            outcome: typeof previousState.current_phase === 'string' && /complete|done/i.test(previousState.current_phase)
                ? 'completed'
                : 'cancelled',
            closeoutWritten: closeoutWrittenFor(omcRoot, mode, closeoutBoundary),
        });
    }
    catch {
        // evidence by contract
    }
}
function modeFromStatePath(filePath) {
    const match = filePath.replaceAll('\\', '/').match(/\/([a-z][a-z0-9-]+)-state\.json$/);
    return match?.[1] ?? null;
}
function sessionIdFromStatePath(filePath) {
    const match = filePath.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)(?:\/|$)/);
    return match?.[1];
}
const activeLoggedPaths = new Map();
//# sourceMappingURL=runs-ledger.js.map