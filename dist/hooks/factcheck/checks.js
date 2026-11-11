/**
 * Factcheck Guard - Individual Check Functions
 *
 * Each function validates a specific aspect of the claims payload and
 * returns a list of mismatches. Ported from factcheck.py.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import { REQUIRED_FIELDS, REQUIRED_GATES } from './types.js';
// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------
/**
 * Check for missing required top-level fields.
 */
export function checkMissingFields(claims) {
    const missing = [];
    for (const field of REQUIRED_FIELDS) {
        if (!(field in claims)) {
            missing.push(field);
        }
    }
    return missing.sort();
}
/**
 * Check for missing required gates.
 */
export function checkMissingGates(claims) {
    const gates = (claims.gates ?? {});
    const missing = [];
    for (const gate of REQUIRED_GATES) {
        if (!(gate in gates)) {
            missing.push(gate);
        }
    }
    return missing.sort();
}
// ---------------------------------------------------------------------------
// Gate checks
// ---------------------------------------------------------------------------
/**
 * Get required gates that are false.
 */
export function getFalseGates(claims) {
    const gates = (claims.gates ?? {});
    const falseGates = [];
    for (const gate of REQUIRED_GATES) {
        if (gate in gates && !gates[gate]) {
            falseGates.push(gate);
        }
    }
    return falseGates.sort();
}
/**
 * Count source files (modified + created).
 */
export function sourceFileCount(claims) {
    const modified = claims.files_modified ?? [];
    const created = claims.files_created ?? [];
    return modified.length + created.length;
}
// ---------------------------------------------------------------------------
// Path checks
// ---------------------------------------------------------------------------
/**
 * Check file paths for forbidden prefixes/substrings and existence.
 */
export function checkPaths(claims, policy) {
    const out = [];
    const allPaths = [
        ...(claims.files_modified ?? []),
        ...(claims.files_created ?? []),
        ...(claims.artifacts_expected ?? []),
    ];
    const deleted = new Set(claims.files_deleted ?? []);
    for (const pathStr of allPaths) {
        if (deleted.has(pathStr))
            continue;
        let prefixBlocked = false;
        for (const prefix of policy.forbidden_path_prefixes) {
            if (pathStr.startsWith(prefix)) {
                out.push({ check: 'H', severity: 'FAIL', detail: `Forbidden path prefix: ${pathStr}` });
                prefixBlocked = true;
                break;
            }
        }
        if (!prefixBlocked) {
            for (const fragment of policy.forbidden_path_substrings) {
                if (pathStr.includes(fragment)) {
                    out.push({ check: 'H', severity: 'FAIL', detail: `Forbidden path fragment: ${pathStr}` });
                    break;
                }
            }
        }
        if (!existsSync(pathStr)) {
            out.push({ check: 'C', severity: 'FAIL', detail: `File not found: ${pathStr}` });
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Command checks
// ---------------------------------------------------------------------------
/**
 * Check executed commands for forbidden mutating operations.
 */
export function checkCommands(claims, policy) {
    const out = [];
    const commands = (claims.commands_executed ?? []).map(String);
    for (const cmd of commands) {
        const hitPrefix = policy.forbidden_path_prefixes.some(forbidden => cmd.includes(forbidden));
        if (!hitPrefix)
            continue;
        const stripped = cmd.trim().replace(/^\(/, '');
        const isReadOnly = policy.readonly_command_prefixes.some(prefix => stripped.startsWith(prefix));
        if (!isReadOnly) {
            out.push({ check: 'H', severity: 'FAIL', detail: `Forbidden mutating command: ${cmd}` });
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// CWD parity check
// ---------------------------------------------------------------------------
/**
 * Check that claims.cwd matches the runtime working directory.
 */
export function checkCwdParity(claimsCwd, runtimeCwd, mode, policy) {
    const enforceCwd = policy.warn_on_cwd_mismatch && (mode !== 'quick' || policy.enforce_cwd_parity_in_quick);
    if (!enforceCwd || !claimsCwd)
        return null;
    const claimsCwdCanonical = resolve(claimsCwd);
    const runtimeCwdCanonical = resolve(runtimeCwd);
    if (claimsCwdCanonical !== runtimeCwdCanonical) {
        const severity = mode === 'strict' ? 'FAIL' : 'WARN';
        return {
            check: 'argv_parity',
            severity,
            detail: `claims.cwd=${claimsCwdCanonical} runtime.cwd=${runtimeCwdCanonical}`,
        };
    }
    return null;
}
//# sourceMappingURL=checks.js.map