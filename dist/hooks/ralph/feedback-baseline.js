/**
 * Feedback baseline engine (spec #45): the single executor of ralph's
 * feedback diff judgment.
 *
 * A ralph run records, per feedback command, a set of normalized failure
 * SIGNATURE LINES from the current tree at startup; every later gate judges by
 * diffing the current run's signatures against that baseline. New signatures
 * are real signal; baseline-only signatures are environment noise (a dirty
 * toolchain or platform-specific suite) and must not consume iterations.
 *
 * Pure logic here; the CLI command owns execution, IO, and exit codes. The
 * skill text owns when to gate and what a signature means for the current
 * story — this module never decides that.
 */
import * as fs from 'fs';
import { dirname, join } from 'path';
export const FEEDBACK_BASELINE_FILENAME = 'feedback-baseline.json';
/** Sibling directory that keeps replaced baselines recoverable. */
export const FEEDBACK_BASELINE_HISTORY_DIRNAME = 'feedback-baseline.history';
/** Bounded history: older re-records are pruned so the state directory cannot grow without limit. */
export const MAX_FEEDBACK_BASELINE_HISTORY = 20;
/** Per-command signature cap: a pathological runaway output must not become a giant baseline. */
export const MAX_SIGNATURES_PER_COMMAND = 200;
/** Cross-process baseline write lock: how long to wait between acquisition attempts. */
const BASELINE_LOCK_RETRY_MS = 10;
/** A lock file older than this is treated as abandoned by a crashed writer. */
const BASELINE_LOCK_STALE_MS = 30_000;
/** Upper bound on waiting for the write lock; past it the write fails closed. */
const BASELINE_LOCK_TIMEOUT_MS = 10_000;
/** ANSI escape sequences, stripped before fingerprinting. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
/** Volatile substrings normalized away: durations, timestamps, tmp paths, hex ids. */
const VOLATILE_PATTERNS = [
    // Pytest's wall-clock parenthesized duration, e.g. "... in 194.32s (0:03:14)".
    // Anchored to the "in <duration>" suffix so clock-shaped assertion values
    // (e.g. assert '(12:15)' == '(12:16)') keep their failure signal.
    /(?<=\bin \d+(?:\.\d+)?s\s)\(\d+:\d{2}(?::\d{2})?(?:\.\d+)?\)/g,
    /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds)\b/gi,
    /\bduration_ms\s*:?\s*\d+(?:\.\d+)?\b/gi,
    /\bduration\s*:?\s*\d+(?:\.\d+)?\b/gi,
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
    /[A-Za-z]:\\[^\s:]*\\[^\s]*(?:omc|omc-)[^\s\\\/]+/g,
    /\/tmp\/[\w.-]+/g,
    // The process id in Node's warning prefix, "(node:12345) [DEP0040] DeprecationWarning: ...", differs on every run.
    // Only an id followed by an optional [code] and a "Name:" is replaced, so "(node:42) ready" in an assertion keeps its signal.
    /(?<=\(node:)\d+(?=\) (?:\[[^\]]+\] )?\w+:)/g,
    /\b[0-9a-f]{8,}\b/gi,
];
/**
 * Reduce one command's combined output to its failure signature set:
 * ANSI stripped, volatile fragments normalized, boilerplate dropped,
 * deduplicated, capped, and sorted for a stable diff. Lines that look like
 * progress rather than failure ("Running tests...", spinner frames) are
 * dropped. Pass/test count summary lines (e.g., '# pass N', '# tests N') are
 * excluded but failure count lines (e.g., '# fail N') are kept — a changed
 * fail count is signal that something moved. Individual passing test results
 * ("ok N ...") are excluded to prevent false positives when tests are added;
 * failing results ("not ok ...") are kept.
 */
export function signatureLines(output) {
    const seen = new Set();
    for (const raw of output.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
        let line = raw.trim();
        if (!line)
            continue;
        for (const pattern of VOLATILE_PATTERNS)
            line = line.replace(pattern, '<v>');
        line = line.replace(/\s+/g, ' ').trim();
        if (!line || line.length > 500)
            continue;
        // Pure progress chatter and test format headers carry no failure signal.
        if (/^(running|collecting|compiling|building|passing|tap\s+version|✓|√|%|\s*at\s)/i.test(line) && !/fail|error|✗|×/i.test(line))
            continue;
        // Drop all-pass pytest progress lines (dots plus skipped/xfail/xpass markers with an optional "[ NN%]" suffix); their width and percentages shift with the test count. A line containing F/E is a failure marker and must survive, because quiet runs can emit only that line.
        if (/^[.sxX]+(?:\s*\[\s*\d+%\]\s*)?$/.test(line))
            continue;
        // Exclude pytest all-pass summaries ("N passed in <v>", optionally with warnings/skipped/...
        // and a trailing duration already normalized to one or more "<v>" tokens); a summary that
        // reports failures/errors does not match and is kept below.
        if (/^\d+ passed(?:, \d+ (?:warnings?|skipped|xfailed|xpassed|deselected))* in <v>(?: <v>)*(?: \([^)]*\))?$/.test(line))
            continue;
        // Drop vitest's summary clock ("Start at  00:09:56"): the wall-clock start time differs on every run and
        // carries no failure signal. Whole-line match, so a clock inside an assertion message is kept.
        if (/^Start at \d{2}:\d{2}:\d{2}$/.test(line))
            continue;
        // Exclude pass/test/fail/skipped/cancelled/todo summary counters when 0 or for non-failure types.
        // These vary as tests are added; only keep failure counter when fail > 0.
        if (/^#\s*(?:pass|tests?|skipped|cancelled|todo)\s+\d+\s*$/.test(line))
            continue;
        if (/^#\s*fail\s+0\s*$/.test(line))
            continue;
        // Exclude comments that are just markers or durations (# <v>, # <v> <v>, etc).
        if (/^#\s*<v>\s*(<v>\s*)*$/.test(line))
            continue;
        // Exclude TAP plan lines (e.g., "1..2") which vary as tests are added.
        if (/^\d+\.\.\d+\s*$/.test(line))
            continue;
        // Exclude individual passing test results (ok N) which vary as tests are added; keep failures (not ok).
        if (/^ok\s+\d+\s+/i.test(line) && !line.includes('not ok'))
            continue;
        seen.add(line);
        if (seen.size >= MAX_SIGNATURES_PER_COMMAND)
            break;
    }
    return [...seen].sort();
}
/**
 * Pure diff: a signature is new when it is absent from the baseline. A command
 * that used to run and now cannot execute is itself a regression. With no
 * baseline at all, everything present is reported as new — the caller decides
 * what that means (baseline creation reports instead of failing).
 */
export function diffAgainstBaseline(baseline, current) {
    if (!baseline) {
        return {
            newSignatures: Object.entries(current).flatMap(([command, entry]) => entry.signatures.map((signature) => `${command}: ${signature}`)),
            resolvedSignatures: [],
        };
    }
    const newSignatures = [];
    const resolvedSignatures = [];
    // Iterate the union so a command dropped from the current set still reports
    // its baseline signatures as resolved/removed instead of vanishing silently.
    for (const command of new Set([...Object.keys(baseline.commands), ...Object.keys(current)])) {
        const entry = current[command];
        const before = baseline.commands[command];
        if (!entry) {
            if (before)
                resolvedSignatures.push(...before.signatures.map((signature) => `${command}: ${signature}`));
            continue;
        }
        if (!before) {
            newSignatures.push(...entry.signatures.map((signature) => `${command}: ${signature}`));
            continue;
        }
        if (entry.timedOut && !before.timedOut) {
            // The command never finished, so there is no output to compare. Report
            // the timeout itself instead of fingerprinting a partial run.
            newSignatures.push(`${command}: <command timed out>`);
            continue;
        }
        if (entry.unrunnable && !before.unrunnable) {
            newSignatures.push(`${command}: <command became unrunnable>`);
            continue;
        }
        const beforeSet = new Set(before.signatures);
        const afterSet = new Set(entry.signatures);
        for (const signature of afterSet)
            if (!beforeSet.has(signature))
                newSignatures.push(`${command}: ${signature}`);
        for (const signature of beforeSet)
            if (!afterSet.has(signature))
                resolvedSignatures.push(`${command}: ${signature}`);
    }
    return { newSignatures, resolvedSignatures };
}
export function baselinePath(stateRoot, sessionId) {
    return join(stateRoot, 'state', 'sessions', sessionId, FEEDBACK_BASELINE_FILENAME);
}
export function readBaseline(path) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object')
            return null;
        const doc = parsed;
        if (doc.version !== 1 || !doc.commands || typeof doc.commands !== 'object')
            return null;
        return { version: 1, recordedAt: typeof doc.recordedAt === 'string' ? doc.recordedAt : '', commands: doc.commands };
    }
    catch {
        return null;
    }
}
/**
 * Copy the live baseline into its sibling history directory before it is
 * replaced, returning the history path (or null when there is nothing to
 * archive or the copy failed). The file name uses the replaced document's own
 * `recordedAt` (sanitized for cross-platform paths) plus a counter, so history
 * sorts chronologically.
 */
export function archiveBaseline(path, now = new Date()) {
    try {
        if (!fs.existsSync(path))
            return null;
        const dir = join(dirname(path), FEEDBACK_BASELINE_HISTORY_DIRNAME);
        fs.mkdirSync(dir, { recursive: true });
        const stamp = (readBaseline(path)?.recordedAt || now.toISOString()).replace(/[^0-9A-Za-z.-]+/g, '-');
        // Continue past the highest counter for this stamp. Reusing a hole left by
        // pruning would let a newer archive land on an older-looking name, breaking
        // both chronological sorting and newest-first retention.
        let counter = 1;
        try {
            for (const name of fs.readdirSync(dir)) {
                if (!name.startsWith(`${stamp}-`))
                    continue;
                const match = /-(\d+)\.json$/.exec(name);
                if (match)
                    counter = Math.max(counter, Number(match[1]) + 1);
            }
        }
        catch {
            // The directory was just created; start from the first slot.
        }
        let target = join(dir, `${stamp}-${counter}.json`);
        // Reserve the target atomically: COPYFILE_EXCL prevents overwriting an
        // existing file (critical when concurrent writers create the same timestamp).
        // Retry with an incremented counter on collision.
        while (true) {
            try {
                fs.copyFileSync(path, target, fs.constants.COPYFILE_EXCL);
                break;
            }
            catch (err) {
                const isEEXIST = err?.code === 'EEXIST';
                if (isEEXIST) {
                    counter += 1;
                    target = join(dir, `${stamp}-${counter}.json`);
                    continue;
                }
                throw err;
            }
        }
        // No pruning here: the archive must not be evicted until the replacement
        // that depends on it has actually landed. recordBaseline prunes after a
        // successful live write; pruning first would evict history when that write
        // fails and the caller retries.
        return target;
    }
    catch {
        return null;
    }
}
function pruneBaselineHistory(dir, keepPath) {
    let entries;
    try {
        entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && join(dir, name) !== keepPath).sort(compareHistoryNames);
    }
    catch {
        return;
    }
    // Reserve one slot for `keepPath`, so the total never exceeds the cap.
    const budget = Math.max(0, MAX_FEEDBACK_BASELINE_HISTORY - 1);
    for (const name of entries.slice(0, Math.max(0, entries.length - budget))) {
        try {
            fs.rmSync(join(dir, name), { force: true });
        }
        catch {
            // A file we cannot prune must not block the re-record.
        }
    }
}
/**
 * Chronological history order: the recordedAt stem first, then numeric suffix.
 * A plain string sort would place `...-10.json` before `...-2.json`, so pruning
 * a run of same-timestamp collisions would delete the wrong (newer) archives.
 */
function compareHistoryNames(left, right) {
    const leftMatch = /^(.*)-(\d+)\.json$/.exec(left);
    const rightMatch = /^(.*)-(\d+)\.json$/.exec(right);
    if (!leftMatch || !rightMatch)
        return left < right ? -1 : left > right ? 1 : 0;
    if (leftMatch[1] !== rightMatch[1])
        return leftMatch[1] < rightMatch[1] ? -1 : 1;
    return Number(leftMatch[2]) - Number(rightMatch[2]);
}
/** Synchronous sleep: this module is synchronous, so a blocking wait is the only option. */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Take the sibling `.lock` for a baseline transaction, returning the open fd
 * (kept open until release) or null on timeout/failure. `openSync(..., 'wx')`
 * is an atomic exclusive create, so exactly one writer wins each round.
 * A lock older than BASELINE_LOCK_STALE_MS is assumed abandoned by a crashed
 * writer and removed, otherwise one crash would wedge the baseline forever.
 */
function acquireBaselineLock(lockPath) {
    const deadline = Date.now() + BASELINE_LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            return fs.openSync(lockPath, 'wx');
        }
        catch (err) {
            if (err?.code !== 'EEXIST')
                return null;
        }
        try {
            const age = Date.now() - fs.statSync(lockPath).mtimeMs;
            if (age > BASELINE_LOCK_STALE_MS) {
                fs.rmSync(lockPath, { force: true });
                continue;
            }
        }
        catch {
            // The lock vanished between open and stat; retry the atomic create.
            continue;
        }
        if (Date.now() >= deadline)
            return null;
        sleepSync(BASELINE_LOCK_RETRY_MS);
    }
}
/** Release the lock on every path, so a failed transaction cannot leak the file. */
function releaseBaselineLock(fd, lockPath) {
    try {
        fs.closeSync(fd);
    }
    catch {
        // Already closed; the path removal below is what actually releases the lock.
    }
    try {
        fs.rmSync(lockPath, { force: true });
    }
    catch {
        // A stale lock is broken by age on the next acquisition.
    }
}
/**
 * Write a baseline, archiving any existing document first. The archive must
 * succeed before the live file is replaced: losing history silently is the bug
 * this guards against, so an unarchivable previous baseline fails the write.
 *
 * The whole read/archive/write transaction runs under a sibling `.lock` file.
 * `COPYFILE_EXCL` only makes archive NAMES unique; without serialization two
 * writers could archive the same original and the second could overwrite the
 * first replacement without archiving it. A writer that cannot take the lock
 * fails closed rather than proceeding unlocked.
 *
 * A failed live write leaves the archive in place: when `writeFileSync` fails
 * partway (ENOSPC/EFBIG) that archive is the only intact recovery copy.
 */
export function recordBaseline(path, commands, now = new Date()) {
    // The lock lives beside the baseline, so its parent must exist first.
    try {
        fs.mkdirSync(dirname(path), { recursive: true });
    }
    catch {
        return { written: false, added: 0, removed: 0 };
    }
    const lockPath = `${path}.lock`;
    const lockFd = acquireBaselineLock(lockPath);
    if (lockFd === null)
        return { written: false, added: 0, removed: 0 };
    try {
        const previous = readBaseline(path);
        const previousPath = archiveBaseline(path, now);
        if (previousPath === null && fs.existsSync(path))
            return { written: false, added: 0, removed: 0 };
        try {
            fs.writeFileSync(path, `${JSON.stringify({ version: 1, recordedAt: now.toISOString(), commands }, null, 2)}\n`, 'utf8');
        }
        catch {
            // Deliberately keep the archive: a partial live write makes it the only
            // intact copy of the document the caller was replacing.
            return { written: false, added: 0, removed: 0 };
        }
        // Prune only now that the live replacement succeeded, so a failed write and
        // its retry never evict history for a replacement that never landed.
        if (previousPath)
            pruneBaselineHistory(dirname(previousPath), previousPath);
        // Audit the document replacement from the raw signature sets, independent of
        // the gate judgment in diffAgainstBaseline: that function collapses a newly
        // unrunnable command into one synthetic marker, which would misreport the
        // stored signatures the replacement actually removed.
        let added = 0;
        let removed = 0;
        const becameUnrunnable = [];
        if (previous && previousPath) {
            for (const command of new Set([...Object.keys(previous.commands), ...Object.keys(commands)])) {
                const before = previous.commands[command];
                const after = commands[command];
                const beforeSet = new Set(before?.signatures ?? []);
                const afterSet = new Set(after?.signatures ?? []);
                for (const signature of afterSet)
                    if (!beforeSet.has(signature))
                        added += 1;
                for (const signature of beforeSet)
                    if (!afterSet.has(signature))
                        removed += 1;
                // Only mark as becameUnrunnable if the command existed in the previous baseline.
                // A newly added unrunnable command was never runnable, so it doesn't "become" unrunnable.
                if (before && after?.unrunnable && !before?.unrunnable)
                    becameUnrunnable.push(command);
            }
        }
        return {
            written: true,
            ...(previousPath ? { previousPath } : {}),
            added,
            removed,
            ...(becameUnrunnable.length > 0 ? { becameUnrunnable } : {}),
        };
    }
    finally {
        releaseBaselineLock(lockFd, lockPath);
    }
}
/** Backward-compatible wrapper: the boolean says only whether the write succeeded. */
export function writeBaseline(path, commands, now = new Date()) {
    return recordBaseline(path, commands, now).written;
}
//# sourceMappingURL=feedback-baseline.js.map