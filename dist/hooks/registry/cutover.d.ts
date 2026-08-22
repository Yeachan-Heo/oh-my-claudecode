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
import type { HookEvent } from './types.js';
export declare const DISPATCH_TELEMETRY_MAX_RECORDS = 500;
export declare const DISPATCH_TELEMETRY_MAX_BYTES: number;
/** Privacy-preserving cutover telemetry record (plan §9). */
export interface DispatchTelemetryRecord {
    schemaVersion: 1;
    event: HookEvent | string;
    hookType?: string;
    hookId?: string;
    riskClass?: string;
    failMode?: string;
    appliedDecision: 'advisory' | 'hard' | 'none' | 'fail-open' | 'fail-closed';
    durationMs: number;
    verdict?: string;
    rollback?: boolean;
    recordedAt: string;
}
/**
 * Return true when a hook output carries an explicit protocol-level deny.
 *
 * Claude Code's hook protocol keeps `continue: true` for several hard
 * decisions (for example, PreToolUse's `permissionDecision: "deny"`), so
 * callers must inspect the decision fields instead of treating `continue` as
 * the complete verdict.
 */
export declare function hasHookProtocolDeny(output: unknown): boolean;
/** Global dispatcher cutover enabled. Aggressively on by default; `off` rolls back to legacy. */
export declare function isDispatcherEnabled(): boolean;
/** Per-family cutover enabled (global + rollback). */
export declare function isFamilyCutoverEnabled(event: HookEvent | string): boolean;
/** Whether ordinary injection/procedure enforcement for `event` should be demoted to advisory. */
export declare function shouldLoosenOrdinaryEnforcement(event: HookEvent | string): boolean;
export declare function telemetryPath(worktreeRoot?: string): string;
/** Bounded append; never throws, never blocks hooks. */
export declare function recordDispatchTelemetry(record: DispatchTelemetryRecord, worktreeRoot?: string): void;
export declare function readDispatchTelemetryTail(limit?: number, worktreeRoot?: string): DispatchTelemetryRecord[];
export declare function clearDispatchTelemetryForTests(worktreeRoot?: string): void;
/** Map bridge HookType to its HookEvent family for cutover gating. */
export declare function hookEventForType(hookType: string): HookEvent | null;
//# sourceMappingURL=cutover.d.ts.map