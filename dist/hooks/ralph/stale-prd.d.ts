/**
 * Ralph PRD Stale-State Detection & Reconciliation (#3669)
 *
 * A Ralph PRD can diverge from reality with no detection: work lands outside the
 * loop (campaign branches + PRs + coordinator merges) while prd.json still
 * records `passes: false`, and abnormal exits (crash, force-kill, cancel before
 * Step 8, session end without `/oh-my-claudecode:cancel`) leave the divergence
 * invisible. Anyone resuming the session then reads an authoritative-looking but
 * false record and either redoes landed work or spends effort disproving it.
 *
 * This module detects that stale state and — only when configured observable
 * evidence exists — reconciles it. It never infers completion by itself.
 *
 * ============================================================================
 * Ralph completion / session-end hook map
 * ============================================================================
 *
 * - Step 5 (mark `passes: true`): the ralph agent edits prd.json directly.
 *   There is no code path that re-derives `passes` from observable state —
 *   that gap is the root cause of #3669.
 * - Step 6 (all stories pass): `src/hooks/persistent-mode/index.ts` evaluates
 *   `getPrdCompletionStatus()`; `allComplete` gates final verification.
 * - Step 7 (reviewer verification): `src/hooks/ralph/verifier.ts`
 *   `startVerification()` + architect/critic approval; approval clears the
 *   verification state.
 * - Step 8 (`/oh-my-claudecode:cancel`): `createRalphLoopHook().cancelLoop()`
 *   clears ralph state (`clearRalphState`) plus linked ultrawork state. Step 8
 *   is the ONLY clean exit; every other end leaves ralph state active and/or
 *   the PRD unfinished.
 * - Session end: `src/hooks/session-end/index.ts` `processSessionEnd()` →
 *   `runForegroundSessionEndCleanup()` → `cleanupModeStates()` removes active
 *   ralph mode state. The session-scoped PRD
 *   (`.omc/state/sessions/{id}/prd.json`) is NOT removed and survives into the
 *   next session — which is how a stale PRD gets resumed as if the work were
 *   outstanding. `processSessionEnd` therefore surfaces the warning *before*
 *   mode-state cleanup.
 *
 * ============================================================================
 * Design contract
 * ============================================================================
 *
 * - Detection NEVER infers completion from PR/merge/branch status alone. Git
 *   state is a *stale signal* (stale pointers) only.
 * - Reconciliation marks a story `passes: true` ONLY when configured observable
 *   evidence (content checks: `fileExists` / `fileContains` / `gitGrep`) all
 *   pass. Stories without configured checks are never auto-marked.
 * - Reconciled stories get `architectVerified: false` and must still pass the
 *   Step 7 reviewer verification before final completion. Reconciliation
 *   repairs Step 5; it never bypasses Steps 6–8.
 * - Every reconciliation decision is appended to an audit log
 *   (`prd-reconciliation.jsonl`) and summarized in the story notes, preserving
 *   the audit trail the PRD exists for.
 * - All checks are bounded: git invocations carry a timeout and run with
 *   `windowsHide` (per repo convention), and file checks are confined to the
 *   repository root.
 */
/** Audit log file name, stored next to the PRD in the session state dir. */
export declare const PRD_RECONCILIATION_AUDIT_FILENAME = "prd-reconciliation.jsonl";
/** Default age after which an unfinished PRD counts as stale (2h, matching the repo stale-state convention). */
export declare const DEFAULT_STALE_PRD_AFTER_MS: number;
/**
 * A single observable-evidence check. Checks are content-based on purpose:
 * branch/PR merge status is a detection signal only, never completion evidence.
 */
export interface ObservableCheck {
    /** Check kind. `fileExists`/`fileContains` inspect the working tree; `gitGrep` inspects content at a ref. */
    type: 'fileExists' | 'fileContains' | 'gitGrep';
    /** Repository-relative path for `fileExists` / `fileContains`. */
    path?: string;
    /** Git ref for `gitGrep` (default: `HEAD`). */
    ref?: string;
    /** Substring pattern for `fileContains` / `gitGrep`. */
    pattern?: string;
    /** Optional human-readable description of the evidence being checked. */
    description?: string;
}
/**
 * Per-PRD reconciliation configuration. Lives under `prd.reconciliation` so it
 * travels with the PRD and stays session-scoped alongside the stories.
 */
export interface PrdReconciliationConfig {
    /** Per-story observable-evidence checks. A story reconciles only when ALL of its checks pass. */
    observableChecks?: Record<string, ObservableCheck[]>;
    /** Age (ms) after which an unfinished PRD counts as stale even without an abnormal-exit signal. */
    staleAfterMs?: number;
    /** Auto-reconcile stories whose checks all pass (default true when checks exist). */
    autoReconcile?: boolean;
}
/** Signals that a PRD may have diverged from observable reality. */
export interface StalePrdDetection {
    /** True when the PRD has unfinished stories AND at least one stale signal applies. */
    stale: boolean;
    /** Human-readable reasons for the stale verdict. */
    reasons: string[];
    /** True when the session's ralph loop state is still active (Step 8 cancel never ran). */
    abnormalExit: boolean;
    /** Story IDs never marked passes:true — the divergence-relevant set (#3669). Stories awaiting Step 7 review (passes:true) are normal pipeline, not stale. */
    unfinished: string[];
    /** Total story count. */
    total: number;
    /** Completed story count. */
    completed: number;
    /** Milliseconds since the PRD file was last written. */
    ageMs: number;
    /** ISO timestamp of the last PRD write, when known. */
    lastTouchedAt: string | null;
    /** Stale-pointer signals, e.g. the PRD's branchName no longer exists or was merged. */
    stalePointers: string[];
    /** Absolute path of the PRD file that was inspected. */
    prdPath: string;
}
/** One audited reconciliation decision. */
export interface ReconciliationAuditEntry {
    timestamp: string;
    sessionId?: string;
    storyId: string;
    decision: 'reconciled' | 'skipped';
    previousPasses: boolean;
    newPasses: boolean;
    checks: {
        check: ObservableCheck;
        passed: boolean;
        detail?: string;
    }[];
    evidence: string;
    reason?: string;
}
/** Outcome of a bounded reconciliation pass. */
export interface ReconcileStalePrdResult {
    detection: StalePrdDetection;
    /** Story IDs marked `passes: true` from passing observable evidence. */
    reconciled: string[];
    /** Story IDs left unfinished, with the reason. */
    skipped: {
        storyId: string;
        reason: string;
    }[];
    /** Absolute path of the audit log (null when nothing was audited). */
    auditPath: string | null;
    /** Remaining stale warning, or null when no unfinished story is left to warn about. */
    warning: string | null;
}
export interface ObservableCheckResult {
    passed: boolean;
    detail: string;
}
/**
 * Run a single observable check. All checks are bounded and fail closed.
 */
export declare function runObservableCheck(check: ObservableCheck, directory: string): ObservableCheckResult;
/**
 * Detect whether the active PRD has diverged from observable reality.
 *
 * Returns null when no PRD exists. A returned detection always carries the full
 * picture even when `stale` is false (callers use `unfinished` to decide whether
 * an exit-time warning is warranted).
 *
 * `includeAbnormalExit` (default true) treats a still-active ralph loop state
 * as an abnormal-exit signal. The live-loop continuation path passes false —
 * while the loop is legitimately running, an active state is the normal case,
 * so only age and stale-pointer signals count there.
 */
export declare function detectStalePrd(directory: string, sessionId?: string, options?: {
    includeAbnormalExit?: boolean;
}): StalePrdDetection | null;
/**
 * Format an explicit stale-unfinished-PRD warning. Surfaces the divergence at
 * the moment it is cheapest to fix: abnormal/non-Step 8 exit and Ralph startup.
 */
export declare function formatStalePrdWarning(detection: StalePrdDetection): string;
/**
 * Bounded stale-state reconciliation.
 *
 * A story is marked `passes: true` ONLY when the PRD carries configured
 * observable evidence for it and every configured check passes. Stories without
 * configured evidence, or with failing checks, are left untouched. Every
 * decision is audited. Never infers completion from PR/merge status.
 */
export declare function reconcileStalePrd(directory: string, sessionId?: string): ReconcileStalePrdResult | null;
/**
 * Session-end integration: returns the stale-unfinished-PRD warning for the
 * ending session, or null when there is nothing to warn about. Must be called
 * BEFORE mode-state cleanup removes the ralph state file (the abnormal-exit
 * signal). Never throws; session end must never be blocked by this check.
 */
export declare function getSessionEndStalePrdWarning(directory: string, sessionId: string): string | null;
/**
 * Ralph startup/resume integration: detect a stale PRD, reconcile it when
 * configured observable evidence exists, and surface the remaining warning.
 * Never throws; ralph startup must not be blocked by this check.
 */
export declare function reconcileStalePrdForStartup(directory: string, sessionId?: string): {
    warning: string | null;
};
//# sourceMappingURL=stale-prd.d.ts.map