import { runFactcheck } from '../hooks/factcheck/index.js';
import { checkSentinelHealth } from '../hooks/factcheck/sentinel.js';
import { loadGuardsConfig } from '../hooks/factcheck/config.js';
function mapFactcheckToBlockers(result) {
    if (result.verdict === 'PASS') {
        return [];
    }
    if (result.mismatches.length === 0) {
        return [`[factcheck] verdict ${result.verdict}`];
    }
    return result.mismatches.map(mismatch => `[factcheck] ${mismatch.severity} ${mismatch.check}: ${mismatch.detail}`);
}
/**
 * Coerce a value expected to be an array into an actual array.
 * - If already an array, return as-is.
 * - If nullish, return empty array.
 * - Otherwise wrap in a single-element array.
 */
function coerceArray(value) {
    if (Array.isArray(value))
        return value;
    if (value == null)
        return [];
    if (typeof value === 'object' && !Array.isArray(value))
        return [];
    return [value];
}
/**
 * Validate and coerce a claims object so downstream factcheck code
 * never throws on unexpected shapes (e.g. `{ files_modified: {} }`).
 */
function sanitizeClaims(raw) {
    const out = { ...raw };
    const arrayFields = [
        'files_modified', 'files_created', 'files_deleted',
        'artifacts_expected', 'commands_executed', 'models_used',
    ];
    for (const field of arrayFields) {
        if (field in out) {
            out[field] = coerceArray(out[field]);
        }
    }
    return out;
}
export function checkSentinelReadiness(options = {}) {
    const { logPath, workspace, claims, enabled = loadGuardsConfig(workspace).sentinel.enabled, } = options;
    if (!enabled) {
        return {
            ready: true,
            blockers: [],
            skipped: true,
        };
    }
    const blockers = [];
    let ranCheck = false;
    if (logPath) {
        ranCheck = true;
        const health = checkSentinelHealth(logPath, workspace);
        blockers.push(...health.blockers);
    }
    if (claims) {
        ranCheck = true;
        try {
            const sanitized = sanitizeClaims(claims);
            const factcheck = runFactcheck(sanitized, { workspace });
            blockers.push(...mapFactcheckToBlockers(factcheck));
        }
        catch (err) {
            blockers.push(`[factcheck] execution error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // Fail-closed: if the gate is enabled but no checks ran, do not pass.
    if (!ranCheck) {
        return {
            ready: false,
            blockers: ['[sentinel] gate enabled but no logPath or claims provided — cannot verify readiness'],
            skipped: true,
        };
    }
    const dedupedBlockers = [...new Set(blockers)];
    return {
        ready: dedupedBlockers.length === 0,
        blockers: dedupedBlockers,
        skipped: false,
    };
}
export async function waitForSentinelReadiness(options = {}) {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000);
    const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 250);
    const startedAt = Date.now();
    let attempts = 1;
    let latest = checkSentinelReadiness(options);
    if (latest.ready) {
        return {
            ...latest,
            timedOut: false,
            elapsedMs: Date.now() - startedAt,
            attempts,
        };
    }
    const deadline = startedAt + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        attempts += 1;
        latest = checkSentinelReadiness(options);
        if (latest.ready) {
            return {
                ...latest,
                timedOut: false,
                elapsedMs: Date.now() - startedAt,
                attempts,
            };
        }
    }
    const timeoutBlocker = `[sentinel] readiness check timed out after ${timeoutMs}ms`;
    const blockers = latest.blockers.includes(timeoutBlocker)
        ? latest.blockers
        : [...latest.blockers, timeoutBlocker];
    return {
        ...latest,
        blockers,
        timedOut: true,
        elapsedMs: Date.now() - startedAt,
        attempts,
    };
}
//# sourceMappingURL=sentinel-gate.js.map