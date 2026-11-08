/**
 * Hook dispatcher cutover — #3698 / #3708.
 *
 * Active event-family cutover on top of the shadow registry (#3707).
 * Contract: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md §6.3 / §8 step 6.
 *
 * - Advisory by default, hard only for the approved risk classes
 *   (destructive-mutation, security-boundary, secrets-privacy,
 *   corruption-integrity, release-authority). Unknown failures default
 *   advisory during migration.
 * - Per-family cutover with global + per-event rollback flags.
 * - Bounded, privacy-preserving dispatch telemetry (ids/durations/verdicts only).
 * - Ordinary injection / procedure enforcement (prompt prerequisites,
 *   orchestrator strict delegation) collapses to advisory when the
 *   corresponding family is cut over; hard permission/release/security
 *   semantics are preserved.
 *
 * Rollback:
 * - `OMC_HOOK_DISPATCHER=off|0|false|disabled` — global cutover off, legacy only.
 * - `OMC_HOOK_ROLLBACK=<Event,...>` or `OMC_HOOK_DISPATCHER_ROLLBACK=<Event,...>` — per-family rollback.
 *   Family names are HookEvent values (UserPromptSubmit, SessionStart, PreToolUse,
 *   PermissionRequest, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop,
 *   PreCompact, Stop, SessionEnd) or `*`. Comparison is case-insensitive.
 * - `OMC_HOOK_CUTOVER` is accepted as an alias for `OMC_HOOK_DISPATCHER`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getOmcRoot, resolveToWorktreeRoot } from '../../lib/worktree-paths.js';
export const DISPATCH_TELEMETRY_MAX_RECORDS = 500;
export const DISPATCH_TELEMETRY_MAX_BYTES = 256 * 1024;
/**
 * Return true when a hook output carries an explicit protocol-level deny.
 *
 * Claude Code's hook protocol keeps `continue: true` for several hard
 * decisions (for example, PreToolUse's `permissionDecision: "deny"`), so
 * callers must inspect the decision fields instead of treating `continue` as
 * the complete verdict.
 */
export function hasHookProtocolDeny(output) {
    if (!output || typeof output !== 'object')
        return false;
    const root = output;
    const isDeny = (value) => typeof value === 'string' && value.trim().toLowerCase() === 'deny';
    const isDecisionDeny = (value) => {
        if (isDeny(value))
            return true;
        return value !== null
            && typeof value === 'object'
            && isDeny(value.behavior);
    };
    if (isDeny(root.permissionDecision) || isDeny(root.permission_decision)) {
        return true;
    }
    const hookSpecificOutput = root.hookSpecificOutput;
    if (!hookSpecificOutput || typeof hookSpecificOutput !== 'object') {
        return isDecisionDeny(root.decision);
    }
    const specific = hookSpecificOutput;
    if (isDeny(specific.permissionDecision) || isDeny(specific.permission_decision)) {
        return true;
    }
    const decision = specific.decision ?? root.decision;
    return isDecisionDeny(decision);
}
function cutoverFlagRaw() {
    const v = process.env.OMC_HOOK_DISPATCHER ?? process.env.OMC_HOOK_CUTOVER;
    return v;
}
/** Global dispatcher cutover enabled. Aggressively on by default; `off` rolls back to legacy. */
export function isDispatcherEnabled() {
    const raw = cutoverFlagRaw();
    if (raw === undefined)
        return true;
    const v = raw.trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'disabled');
}
function rollbackSet() {
    const raw = process.env.OMC_HOOK_ROLLBACK ?? process.env.OMC_HOOK_DISPATCHER_ROLLBACK ?? '';
    const out = new Set();
    for (const tok of raw.split(',')) {
        const n = tok.trim().toLowerCase();
        if (n)
            out.add(n);
    }
    return out;
}
/** Per-family cutover enabled (global + rollback). */
export function isFamilyCutoverEnabled(event) {
    if (!isDispatcherEnabled())
        return false;
    const rb = rollbackSet();
    if (rb.has('*'))
        return false;
    const lower = event.toLowerCase();
    if (rb.has(lower))
        return false;
    return true;
}
/** Whether ordinary injection/procedure enforcement for `event` should be demoted to advisory. */
export function shouldLoosenOrdinaryEnforcement(event) {
    return isFamilyCutoverEnabled(event);
}
export function telemetryPath(worktreeRoot) {
    const root = getOmcRoot(worktreeRoot ?? resolveToWorktreeRoot());
    return join(root, 'state', 'hook-dispatch-telemetry.jsonl');
}
/** Bounded append; never throws, never blocks hooks. */
export function recordDispatchTelemetry(record, worktreeRoot) {
    try {
        const p = telemetryPath(worktreeRoot);
        mkdirSync(dirname(p), { recursive: true });
        appendFileSync(p, JSON.stringify(record) + '\n');
        // Opportunistic bounding: trim only when file likely over budget.
        // Cheap check: file size via read; bound enforcement is best-effort.
        try {
            const raw = readFileSync(p, 'utf-8');
            if (raw.length > DISPATCH_TELEMETRY_MAX_BYTES) {
                const lines = raw.split('\n').filter(l => l.trim().length > 0);
                let kept = lines.slice(-DISPATCH_TELEMETRY_MAX_RECORDS);
                while (kept.length > 0 && kept.join('\n').length + 1 > DISPATCH_TELEMETRY_MAX_BYTES) {
                    kept = kept.slice(1);
                }
                writeFileSync(p, kept.length > 0 ? kept.join('\n') + '\n' : '');
            }
            else {
                const lines = raw.split('\n').filter(l => l.trim().length > 0);
                if (lines.length > DISPATCH_TELEMETRY_MAX_RECORDS) {
                    writeFileSync(p, lines.slice(-DISPATCH_TELEMETRY_MAX_RECORDS).join('\n') + '\n');
                }
            }
        }
        catch {
            // ignore bounding errors
        }
    }
    catch {
        // telemetry never affects hook behavior
    }
}
export function readDispatchTelemetryTail(limit = 100, worktreeRoot) {
    try {
        const p = telemetryPath(worktreeRoot);
        if (!existsSync(p))
            return [];
        const lines = readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0).slice(-limit);
        return lines.map(l => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        }).filter(Boolean);
    }
    catch {
        return [];
    }
}
export function clearDispatchTelemetryForTests(worktreeRoot) {
    try {
        const p = telemetryPath(worktreeRoot);
        if (existsSync(p))
            writeFileSync(p, '');
    }
    catch { /* ignore */ }
}
/** Map bridge HookType to its HookEvent family for cutover gating. */
export function hookEventForType(hookType) {
    switch (hookType) {
        case 'keyword-detector': return 'UserPromptSubmit';
        case 'session-start':
        case 'setup-init':
        case 'setup-maintenance': return 'SessionStart';
        case 'pre-tool-use': return 'PreToolUse';
        case 'permission-request': return 'PermissionRequest';
        case 'post-tool-use': return 'PostToolUse';
        case 'subagent-start': return 'SubagentStart';
        case 'subagent-stop': return 'SubagentStop';
        case 'pre-compact': return 'PreCompact';
        case 'stop-continuation':
        case 'persistent-mode':
        case 'ralph':
        case 'code-simplifier': return 'Stop';
        case 'session-end': return 'SessionEnd';
        case 'autopilot': return null;
        default: return null;
    }
}
//# sourceMappingURL=cutover.js.map