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
import { join } from 'path';
export const FEEDBACK_BASELINE_FILENAME = 'feedback-baseline.json';
/** Per-command signature cap: a pathological runaway output must not become a giant baseline. */
export const MAX_SIGNATURES_PER_COMMAND = 200;
/** ANSI escape sequences, stripped before fingerprinting. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
/** Volatile substrings normalized away: durations, timestamps, tmp paths, hex ids. */
const VOLATILE_PATTERNS = [
    /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds)\b/gi,
    /\bduration_ms\s*:?\s*\d+(?:\.\d+)?\b/gi,
    /\bduration\s*:?\s*\d+(?:\.\d+)?\b/gi,
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
    /[A-Za-z]:\\[^\s:]*\\[^\s]*(?:omc|omc-)[^\s\\\/]+/g,
    /\/tmp\/[\w.-]+/g,
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
    for (const [command, entry] of Object.entries(current)) {
        const before = baseline.commands[command];
        if (!before) {
            newSignatures.push(...entry.signatures.map((signature) => `${command}: ${signature}`));
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
export function writeBaseline(path, commands, now = new Date()) {
    try {
        fs.mkdirSync(join(path, '..'), { recursive: true });
        fs.writeFileSync(path, `${JSON.stringify({ version: 1, recordedAt: now.toISOString(), commands }, null, 2)}\n`, 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=feedback-baseline.js.map